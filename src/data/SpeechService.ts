/**
 * 听笔记服务：SP 状态机 / 句群分块 / token 隔离 / 断点续读 / seekCommit()。
 *
 * - 系统语音 + 规则式韵律为离线兜底；
 * - Edge 神经语音（桌面）/ 自定义 TTS 网关（双端）统一经 preferredEngine 路由器
 *   单路径接入，连续失败经短退避 + 有限重试后回退系统语音，保证朗读连续；
 * - 系统语音不可用（典型为 Android WebView）→ 中文提示 + 复制 / 导出朗读稿，
 *   交给系统「随选朗读」发声。
 * 服务层只使用宿主 window 定时器（单测注入桩），不直接发网络请求、
 * 不使用 Node/Electron API。原 Piper 本地语音与旧的云端兼容死路径均已移除。
 */
import type { SpeechChunk } from "../speech/chunks";
import { mdToSpeechChunks } from "../speech/chunks";
import { pickChineseVoice } from "../speech/engine";
import {
  clampRate,
  detectSilence,
  initialMachine,
  KEEP_ALIVE_MS,
  resumeIndex,
  SILENCE_TIMEOUT_MS,
  speechTransition,
  toReadProgress,
} from "../speech/machine";
import type {
  SpeechEngine,
  SpeechMachine,
  SpeechProgressStore,
  SpeechSnapshot,
  SpeechVoice,
} from "../speech/types";

const UNSUPPORTED_TEXT =
  "当前设备不支持朗读：请复制 / 保存朗读稿，交给系统「随选朗读」发声。";
const MOBILE_TEXT =
  "移动端系统语音可能不可用；若无声请使用朗读稿替代路径交给系统朗读。";
const NO_VOICES_TEXT =
  "当前设备不支持朗读：系统未提供可用音色（Android WebView 常见）。请复制 / 保存朗读稿交给系统朗读。";
/** 首选引擎连续失败重试上限：超过后才回退系统语音，避免停顿后偶发抖动误切换。 */
const PREFERRED_RETRY_LIMIT = 2;
/**
 * P2-1：连续失败的短退避基数。第 n 次失败等待 n * BASE ms（300 / 600 ms），
 * 避免 401 / 403 这类确定性错误在几百毫秒内连打 3 次请求打爆服务商配额。
 */
const PREFERRED_RETRY_BACKOFF_MS = 300;

export interface SpeechServiceOptions {
  /** 本地 / 系统语音引擎（可注入内存实现以便单测）。 */
  engine: SpeechEngine | null;
  /** 首选引擎（路由器：Edge / 自定义网关）；失败时回退 engine。 */
  preferredEngine?: SpeechEngine | null;
  mobile: boolean;
  progress: SpeechProgressStore;
  rate?: number;
  preferChineseVoice?: boolean;
  manualVoiceName?: string;
  prosody?: boolean;
  /** 块间停顿上限；0 关闭（单测默认 0 保持同步断言）。 */
  maxPauseMs?: number;
  now?: () => number;
  keepAliveMs?: number;
  silenceMs?: number;
  /**
   * P2-1：重试调度器。生产默认走宿主 window.setTimeout；
   * 单测注入同步实现，保证断言确定性与退避时序可核对。
   */
  scheduleRetry?: (run: () => void, delayMs: number) => void;
}

export class SpeechService {
  private readonly local: SpeechEngine | null;
  private readonly preferred: SpeechEngine | null;
  private readonly mobile: boolean;
  private readonly progress: SpeechProgressStore;
  private readonly now: () => number;
  private readonly keepAliveMs: number;
  private readonly silenceMs: number;
  /** P2-1：可注入的重试调度器，生产用 window.setTimeout，单测用同步实现。 */
  private readonly scheduleRetry: (run: () => void, delayMs: number) => void;
  private readonly listeners = new Set<(state: SpeechSnapshot) => void>();

  private machine: SpeechMachine = initialMachine();
  private chunks: SpeechChunk[] = [];
  private path: string | null = null;
  private title = "";
  private rate: number;
  private preferChineseVoice: boolean;
  private manualVoiceName: string;
  private prosody: boolean;
  private maxPauseMs: number;
  private message = "";
  private started = false;
  private preferredFailed = false;
  private pendingGap = false;
  /**
   * 暂停态拖动进度条后置位：音频已被 cancelEngines() 销毁，恢复时不能
   * 直接调 engine.resume()（无音频可续），必须重新 speakCurrent() 合成当前块。
   * 这是「暂停→拖动→继续无反应」的根因修复。
   */
  private pendingResumeFromSeek = false;
  /** 同一引擎连续失败次数：超过阈值后才回退系统语音，避免偶发抖动误切换。 */
  private engineFailures = 0;
  /** P2-1：在途重试凭据，clearTimers 时递增，延迟回调据此自判作废。 */
  private retryTicket = 0;
  /**
   * P1-1 / P1-2：最近一次首选引擎失败的可读诊断（Edge 403、网关 401 等）。
   * 只在内存中保存，不写 data.json / index.json / .ics / 导出文件，也不含密钥。
   */
  private lastPreferredError = "";
  // P2-6：宿主 window 定时器返回 number（DOM 语义）；单测桩指向 globalThis 时
  // 运行期返回 Timeout 对象，但 clearTimeout/clearInterval 同样接受，行为一致。
  private keepAliveTimer: number | null = null;
  private silenceTimer: number | null = null;
  private gapTimer: number | null = null;
  private disposed = false;

  constructor(options: SpeechServiceOptions) {
    this.local = options.engine;
    this.preferred = options.preferredEngine ?? null;
    this.mobile = options.mobile;
    this.progress = options.progress;
    this.rate = clampRate(options.rate ?? 1);
    this.preferChineseVoice = options.preferChineseVoice ?? true;
    this.manualVoiceName = options.manualVoiceName ?? "";
    this.prosody = options.prosody ?? true;
    this.maxPauseMs = options.maxPauseMs ?? 0;
    this.now = options.now ?? Date.now;
    this.keepAliveMs = options.keepAliveMs ?? KEEP_ALIVE_MS;
    this.silenceMs = options.silenceMs ?? SILENCE_TIMEOUT_MS;
    // P2-1：生产默认走宿主 window 定时器的短退避；单测注入同步实现保证确定性。
    this.scheduleRetry =
      options.scheduleRetry ??
      ((run, delayMs) => {
        window.setTimeout(run, delayMs);
      });
    if (!this.supported) this.message = UNSUPPORTED_TEXT;
    // P2-4：删除旧的云端兼容分支后，移动端只有真正落到系统语音时才提示，
    // Edge / 网关等首选引擎在手机端可用，不应再显示「系统语音可能不可用」。
    else if (this.mobile && this.activeEngine() === this.local) {
      this.message = MOBILE_TEXT;
    }
  }

  get supported(): boolean {
    return (
      this.preferred?.supported() === true ||
      this.local?.supported() === true
    );
  }

  /** 首选引擎优先；失败或未就绪时回退系统语音（P2-4 后仅此单路径）。 */
  private activeEngine(): SpeechEngine | null {
    if (this.preferred && !this.preferredFailed && this.preferred.supported()) {
      return this.preferred;
    }
    return this.local?.supported() === true ? this.local : null;
  }

  private engineLabel(): string {
    const engine = this.activeEngine();
    if (!engine) return "不可用";
    return engine.label ?? "系统语音";
  }

  /** 音色异步就绪（voiceschanged）或设置变化后刷新界面状态。 */
  onVoicesChanged(): void {
    if (this.disposed) return;
    this.emit();
  }

  /** 首选引擎配置 / 模型变化后清除失败标记，允许再次使用。 */
  refreshPreferred(): void {
    if (this.disposed) return;
    this.preferredFailed = false;
    this.engineFailures = 0; // 用户改了配置，退避计数也要重新起算
    this.lastPreferredError = ""; // 旧诊断不再代表当前状态
    this.emit();
  }

  /**
   * 等待首选引擎异步就绪后再朗读。联网引擎 supported() 同步即可判定，
   * 保留此钩子供将来有异步准备的引擎使用，正常情况下立即返回。
   */
  async ensureReady(): Promise<void> {
    if (this.disposed || !this.preferred || this.preferred.supported()) return;
    try {
      await this.preferred.prepare?.();
    } catch {
      // 探测失败交给 play() 按不支持处理，并保留 diagnostic 供设置页展示。
    }
    this.emit();
  }

  getSnapshot(): SpeechSnapshot {
    const saved = this.path ? this.progress.get(this.path) : null;
    const resumable =
      saved !== null &&
      saved.total === this.machine.total &&
      this.machine.total > 0 &&
      saved.idx > 0 &&
      saved.idx < saved.total;
    return {
      state: this.machine.state,
      path: this.path,
      title: this.title,
      idx: this.machine.idx,
      total: this.machine.total,
      rate: this.rate,
      supported: this.supported,
      message: this.message,
      resumable,
      preview:
        this.machine.state === "playing" && this.chunks[this.machine.idx]
          ? this.chunks[this.machine.idx].text
          : "",
      engineLabel: this.engineLabel(),
      engineDiagnostic:
        this.preferred && !this.preferred.supported()
          ? this.preferred.diagnostic?.() || undefined
          : undefined,
      engineLastError: this.lastPreferredError || undefined,
    };
  }

  /** Android 无系统音色时给朗读稿替代路径用。 */
  getPlainText(): string {
    return this.chunks.map((chunk) => chunk.text).join("\n");
  }

  listVoices(): SpeechVoice[] {
    return this.local?.getVoices() ?? [];
  }

  subscribe(listener: (state: SpeechSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  /** 绑定一篇笔记：清洗 + 句群分块，并读取断点；不会自动发声。 */
  prepare(path: string, title: string, markdown: string): void {
    if (this.disposed) return;
    if (this.path && this.path !== path && this.isActive()) {
      this.stopInternal(true, "已切换到其他笔记，朗读已停止并保存断点。");
    }
    this.chunks = mdToSpeechChunks(markdown);
    const total = this.chunks.length;
    const from = resumeIndex(this.progress.get(path), total);
    this.path = path;
    this.title = title;
    this.machine = {
      state: "idle",
      token: this.machine.token + 1,
      idx: from,
      total,
    };
    this.clearTimers();
    // P2-2：Piper 已彻底移除，不存在「本地模型加载中」的引擎分支。
    this.message = !this.supported
      ? UNSUPPORTED_TEXT
      : total === 0
        ? "这篇笔记没有可朗读的文字。"
        : from > 0
          ? `已恢复上次朗读进度：第 ${from + 1}/${total} 段，点「朗读」继续。`
          : this.mobile && this.activeEngine() === this.local
            ? MOBILE_TEXT
            : "";
    this.emit();
  }

  play(fromIdx?: number): void {
    if (this.disposed) return;
    if (!this.supported) {
      this.message = UNSUPPORTED_TEXT;
      this.emit();
      return;
    }
    if (!this.chunks.length) {
      this.message = "这篇笔记没有可朗读的文字。";
      this.emit();
      return;
    }
    if (this.machine.state === "paused" && fromIdx === undefined) {
      this.resume();
      return;
    }
    this.cancelEngines();
    this.clearTimers();
    const from =
      fromIdx ??
      (this.machine.idx >= this.machine.total ? 0 : this.machine.idx);
    this.machine = speechTransition(this.machine, {
      type: "start",
      total: this.machine.total,
      from,
    });
    this.message = "";
    this.saveProgress();
    this.startKeepAlive();
    this.speakCurrent();
    this.emit();
  }

  pause(): void {
    if (this.disposed || this.machine.state !== "playing") return;
    if (this.gapTimer !== null) {
      this.clearGapTimer();
      this.pendingGap = true;
    }
    this.pendingResumeFromSeek = false;
    this.machine = speechTransition(this.machine, { type: "pause" });
    this.activeEngine()?.pause();
    this.saveProgress();
    this.message = "已暂停，断点已保存。";
    this.emit();
  }

  resume(): void {
    if (this.disposed || this.machine.state !== "paused") return;
    this.machine = speechTransition(this.machine, { type: "resume" });
    // 暂停期间拖动过进度条：原音频已被取消，只能重新合成当前块。
    // 如果照旧调 engine.resume()，Edge/网关的 <audio> 已销毁、系统语音已 cancel，
    // 结果是状态变成 playing 却没有声音，必须再「停止→断点续读」才能播。
    if (this.pendingGap || this.pendingResumeFromSeek) {
      this.pendingGap = false;
      this.pendingResumeFromSeek = false;
      this.startKeepAlive();
      this.speakCurrent();
    } else {
      this.activeEngine()?.resume();
    }
    this.message = "";
    this.emit();
  }

  toggle(): void {
    if (this.machine.state === "playing") this.pause();
    else this.play();
  }

  stop(save = true): void {
    if (this.disposed) return;
    this.stopInternal(save, save ? "已停止朗读，断点已保存。" : "");
  }

  /** 拖动进度条提交：v15 的 seekCommit()。 */
  seek(idx: number): void {
    if (this.disposed || !this.chunks.length) return;
    const wasPlaying = this.machine.state === "playing";
    const wasPaused = this.machine.state === "paused";
    this.cancelEngines();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "seek", idx });
    this.message = `已跳到第 ${this.machine.idx + 1}/${this.machine.total} 段。`;
    this.saveProgress();
    if (wasPlaying) {
      // 播放中拖动：立即从新位置重新合成。
      this.startKeepAlive();
      this.speakCurrent();
    } else if (wasPaused) {
      // 暂停中拖动：保持暂停，仅记录「恢复时要重新合成」，由 resume() 消费。
      // 这样点「继续朗读」即可直接播放，无需先停止再从断点续读。
      this.pendingResumeFromSeek = true;
    }
    this.emit();
  }

  setRate(rate: number): void {
    if (this.disposed) return;
    this.rate = clampRate(rate);
    if (this.machine.state === "playing") this.restartCurrentChunk();
    this.emit();
  }

  setPreferChineseVoice(value: boolean): void {
    if (this.disposed) return;
    this.preferChineseVoice = value;
    if (this.machine.state === "playing") this.restartCurrentChunk();
    this.emit();
  }

  setManualVoiceName(name: string): void {
    if (this.disposed) return;
    this.manualVoiceName = name;
    if (this.machine.state === "playing") this.restartCurrentChunk();
    this.emit();
  }

  setProsody(value: boolean): void {
    if (this.disposed) return;
    this.prosody = value;
    this.emit();
  }

  setMaxPauseMs(ms: number): void {
    if (this.disposed) return;
    this.maxPauseMs = Math.max(0, Math.floor(ms));
    this.emit();
  }

  /** 语速 / 音色变更需要重说当前块；先递增 token 隔离旧 utterance 的回调。 */
  private restartCurrentChunk(): void {
    this.cancelEngines();
    this.clearSilenceTimer();
    this.clearGapTimer();
    this.pendingGap = false;
    this.machine = speechTransition(this.machine, {
      type: "seek",
      idx: this.machine.idx,
    });
    this.speakCurrent();
  }

  /** 宿主 file-open：切换笔记时停止并保存断点。 */
  onActiveFileChanged(path: string): void {
    if (
      this.disposed ||
      !this.path ||
      path === this.path ||
      !this.isActive()
    ) {
      return;
    }
    this.stopInternal(true, "已切换到其他笔记，朗读已停止并保存断点。");
  }

  /** onunload：cancel 语音、清除所有定时器与监听，最后保存断点。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelEngines();
    this.clearTimers();
    if (
      this.path &&
      this.machine.total > 0 &&
      this.machine.idx < this.machine.total
    ) {
      this.progress.set(this.path, toReadProgress(this.machine, this.now()));
    }
    this.listeners.clear();
  }

  private isActive(): boolean {
    return this.machine.state === "playing" || this.machine.state === "paused";
  }

  private cancelEngines(): void {
    this.preferred?.cancel();
    this.local?.cancel();
  }

  private stopInternal(save: boolean, message: string): void {
    this.cancelEngines();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "stop" });
    if (save && this.path && this.machine.total > 0) this.saveProgress();
    this.message = message;
    this.emit();
  }

  private speakCurrent(): void {
    const engine = this.activeEngine();
    if (this.disposed || !engine || this.machine.state !== "playing") return;
    const chunk = this.chunks[this.machine.idx];
    if (!chunk) {
      this.finish();
      return;
    }
    const token = this.machine.token;
    this.started = false;
    const voice = pickChineseVoice(
      engine.getVoices(),
      this.preferChineseVoice,
      this.manualVoiceName,
    );
    engine.speak(
      chunk.text,
      {
        rate: this.rate,
        lang: voice?.lang ?? (this.preferChineseVoice ? "zh-CN" : ""),
        voice,
        rateScale: this.prosody ? chunk.rateScale : 1,
        pitch: this.prosody ? chunk.pitch : 1,
      },
      {
        onStart: () => {
          if (token === this.machine.token && !this.disposed) {
            this.started = true;
            // 引擎成功出声，清零连续失败计数：偶发抖动不该累积成永久降级。
            this.engineFailures = 0;
            // P1-1 / P1-2：只有首选引擎真正出声才清除诊断。回退到系统语音成功时
            // 必须保留失败原因，否则设置页「朗读能力」只能看到「已回退」却不知为何。
            if (engine === this.preferred) {
              this.lastPreferredError = "";
            }
          }
        },
        onEnd: () => {
          if (
            this.disposed ||
            token !== this.machine.token ||
            this.machine.state !== "playing"
          ) {
            return;
          }
          this.handleEnd();
        },
        onError: (error) => {
          if (
            this.disposed ||
            token !== this.machine.token ||
            error === "interrupted" ||
            error === "canceled"
          ) {
            return;
          }
          // 首选联网 / 神经引擎失败：先做「短退避 + 有限重试」，避免一次网络抖动
          // 就切走音色，也避免 401/403 这类确定性错误在瞬间连打 3 次请求。
          const isPreferred = engine === this.preferred;
          if (isPreferred) this.lastPreferredError = error;
          if (isPreferred && this.local?.supported() === true) {
            this.engineFailures += 1;
            if (this.engineFailures <= PREFERRED_RETRY_LIMIT) {
              this.clearSilenceTimer();
              this.clearGapTimer();
              // P2-1：第 1 次等 300 ms、第 2 次等 600 ms；ticket 让停止 / 切笔记 /
              // seek 之后到期的延迟回调自动作废，不会在无效会话里重说。
              const delayMs = PREFERRED_RETRY_BACKOFF_MS * this.engineFailures;
              const ticket = ++this.retryTicket;
              this.scheduleRetry(() => {
                if (
                  this.disposed ||
                  ticket !== this.retryTicket ||
                  token !== this.machine.token ||
                  this.machine.state !== "playing"
                ) {
                  return;
                }
                this.speakCurrent();
              }, delayMs);
              return;
            }
            // 连续失败达到阈值 → 判定引擎不可用，回退系统语音。
            this.preferredFailed = true;
            this.engineFailures = 0;
            this.preferred?.cancel();
            this.message = "神经语音暂时不可用，已自动回退到系统语音（规则式韵律）。";
            this.emit();
            this.speakCurrent();
            return;
          }
          this.fail(`朗读出错：${error}`);
        },
      },
    );
    this.startSilenceWatch(token);
    this.prefetchNext();
  }

  /**
   * 后台预合成下一块：Edge / 网关引擎有网络握手成本（约 2 秒），
   * 在当前块播放期间提前合成，切到下一段时命中缓存即可秒开。
   * P2-2：预取前快照会话 token 与笔记路径（会话 id），把 isStale 守卫交给引擎；
   * 异步合成完成后若切笔记 / 停止 / 回退引擎，结果直接丢弃、不占 60 条缓存名额。
   */
  private prefetchNext(): void {
    const engine = this.activeEngine();
    if (this.disposed || !engine?.prefetch) return;
    const next = this.chunks[this.machine.idx + 1];
    if (!next) return;
    const sessionToken = this.machine.token;
    const sessionPath = this.path;
    const sessionEngine = engine;
    const isStale = (): boolean =>
      this.disposed ||
      this.machine.token !== sessionToken ||
      this.path !== sessionPath ||
      this.activeEngine() !== sessionEngine ||
      this.machine.state !== "playing";
    const voice = pickChineseVoice(
      engine.getVoices(),
      this.preferChineseVoice,
      this.manualVoiceName,
    );
    engine.prefetch(
      next.text,
      {
        rate: this.rate,
        lang: voice?.lang ?? (this.preferChineseVoice ? "zh-CN" : ""),
        voice,
        rateScale: this.prosody ? next.rateScale : 1,
        pitch: this.prosody ? next.pitch : 1,
      },
      isStale,
    );
  }

  private handleEnd(): void {
    this.clearSilenceTimer();
    const next = speechTransition(this.machine, { type: "next" });
    if (next !== this.machine) {
      const previous = this.chunks[this.machine.idx];
      const gap = this.prosody
        ? Math.min(this.maxPauseMs, previous?.pauseMs ?? 0)
        : 0;
      this.machine = next;
      this.saveProgress();
      this.emit();
      if (gap > 0) {
        const token = this.machine.token;
        this.gapTimer = window.setTimeout(() => {
          this.gapTimer = null;
          if (
            this.disposed ||
            this.machine.token !== token ||
            this.machine.state !== "playing"
          ) {
            return;
          }
          this.speakCurrent();
        }, gap);
      } else {
        this.speakCurrent();
      }
      return;
    }
    this.finish();
  }

  private finish(): void {
    this.cancelEngines();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "finish" });
    if (this.path) this.progress.set(this.path, null);
    this.message = "朗读完成，断点已清除。";
    this.emit();
  }

  private fail(message: string): void {
    this.cancelEngines();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "error" });
    this.saveProgress();
    this.message = message;
    this.emit();
  }

  private degrade(): void {
    this.cancelEngines();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "error" });
    this.saveProgress();
    this.message = this.mobile ? NO_VOICES_TEXT : UNSUPPORTED_TEXT;
    this.emit();
  }

  private startKeepAlive(): void {
    // 云端 <audio> 不需要 Chromium 的 pause/resume 保活，避免中途卡顿。
    if (
      this.disposed ||
      this.keepAliveTimer ||
      this.keepAliveMs <= 0 ||
      this.activeEngine()?.needsKeepAlive === false
    ) {
      return;
    }
    this.keepAliveTimer = window.setInterval(() => {
      const engine = this.activeEngine();
      if (
        this.disposed ||
        this.machine.state !== "playing" ||
        !engine ||
        engine.needsKeepAlive === false
      ) {
        return;
      }
      if (engine.isSpeaking() && !engine.isPaused()) {
        engine.pause();
        engine.resume();
      }
    }, this.keepAliveMs);
  }

  private startSilenceWatch(token: number): void {
    this.clearSilenceTimer();
    if (this.silenceMs <= 0) return;
    this.silenceTimer = window.setTimeout(() => {
      this.silenceTimer = null;
      if (
        this.disposed ||
        token !== this.machine.token ||
        this.machine.state !== "playing"
      ) {
        return;
      }
      const engine = this.activeEngine();
      // 联网神经引擎 needsKeepAlive=false：合成阶段 isSpeaking() 尚为
      // false（网络请求中），若照旧做静音检测会被误判为「设备不支持」而中断。
      if (engine?.needsKeepAlive === false) return;
      if (
        detectSilence({
          elapsedMs: this.silenceMs,
          started: this.started,
          speaking: engine?.isSpeaking() ?? false,
          thresholdMs: this.silenceMs,
        })
      ) {
        this.degrade();
      }
    }, this.silenceMs);
  }

  private saveProgress(): void {
    if (!this.path || this.machine.total <= 0) return;
    if (this.machine.idx >= this.machine.total) return;
    this.progress.set(this.path, toReadProgress(this.machine, this.now()));
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private clearGapTimer(): void {
    if (this.gapTimer !== null) {
      window.clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearSilenceTimer();
    this.clearGapTimer();
    this.pendingGap = false;
    // P2-1：让所有在途延迟重试立即作废（停止 / 切笔记 / seek / dispose 都会走到这里）。
    this.retryTicket += 1;
    if (this.keepAliveTimer !== null) {
      window.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
