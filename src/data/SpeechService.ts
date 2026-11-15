/**
 * 听笔记服务：SP 状态机 / 句群分块 / token 隔离 / 断点续读 / seekCommit()。
 *
 * v1.0.1 双引擎：
 * - 云端神经 TTS（用户显式开启、填好地址与密钥）→ 真人级语气；
 * - 云端不可用 / 离线 / 失败 → 自动回退系统语音 + 规则式韵律（方案 A）；
 * - 两端都不可用（典型为 Android WebView）→ 中文提示 + 复制 / 导出朗读稿。
 * 服务层不触碰 window、不直接发网络请求、不使用 Node/Electron API。
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
  "当前设备不支持朗读：可开启云端神经语音（设置 → 朗读），或复制 / 保存朗读稿交给系统「随选朗读」。";
const MOBILE_TEXT =
  "移动端系统语音可能不可用；若无声请开启云端神经语音，或使用系统朗读。";
const NO_VOICES_TEXT =
  "当前设备不支持朗读：系统未提供可用音色（Android WebView 常见）。请开启云端神经语音，或复制 / 保存朗读稿交给系统朗读。";

export interface SpeechServiceOptions {
  /** 本地 / 系统语音引擎（可注入内存实现以便单测）。 */
  engine: SpeechEngine | null;
  /** 可选云端神经语音引擎；未配置时 supported() 为 false。 */
  cloudEngine?: SpeechEngine | null;
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
}

export class SpeechService {
  private readonly local: SpeechEngine | null;
  private readonly cloud: SpeechEngine | null;
  private readonly mobile: boolean;
  private readonly progress: SpeechProgressStore;
  private readonly now: () => number;
  private readonly keepAliveMs: number;
  private readonly silenceMs: number;
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
  private cloudFailed = false;
  private pendingGap = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: SpeechServiceOptions) {
    this.local = options.engine;
    this.cloud = options.cloudEngine ?? null;
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
    if (!this.supported) this.message = UNSUPPORTED_TEXT;
    else if (this.mobile && this.activeEngine() !== this.cloud) {
      this.message = MOBILE_TEXT;
    }
  }

  get supported(): boolean {
    return this.cloud?.supported() === true || this.local?.supported() === true;
  }

  /** 云端优先；云端失败或离线时退回本地系统语音（方案 A）。 */
  private activeEngine(): SpeechEngine | null {
    if (this.cloud && !this.cloudFailed && this.cloud.supported()) {
      return this.cloud;
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

  /** 云端配置变化后清除失败标记，允许再次尝试云端。 */
  refreshCloud(): void {
    if (this.disposed) return;
    this.cloudFailed = false;
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
    this.message = !this.supported
      ? UNSUPPORTED_TEXT
      : total === 0
        ? "这篇笔记没有可朗读的文字。"
        : from > 0
          ? `已恢复上次朗读进度：第 ${from + 1}/${total} 段，点「朗读」继续。`
          : this.mobile && this.activeEngine() !== this.cloud
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
    this.machine = speechTransition(this.machine, { type: "pause" });
    this.activeEngine()?.pause();
    this.saveProgress();
    this.message = "已暂停，断点已保存。";
    this.emit();
  }

  resume(): void {
    if (this.disposed || this.machine.state !== "paused") return;
    this.machine = speechTransition(this.machine, { type: "resume" });
    if (this.pendingGap) {
      this.pendingGap = false;
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
    this.cancelEngines();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "seek", idx });
    this.message = `已跳到第 ${this.machine.idx + 1}/${this.machine.total} 段。`;
    this.saveProgress();
    if (wasPlaying) {
      this.startKeepAlive();
      this.speakCurrent();
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
    this.cloud?.cancel();
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
          if (token === this.machine.token && !this.disposed) this.started = true;
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
          // 云端失败（离线 / 密钥失效 / 额度）→ 自动回退方案 A。
          if (
            engine === this.cloud &&
            this.local?.supported() === true &&
            !this.cloudFailed
          ) {
            this.cloudFailed = true;
            this.cloud?.cancel();
            this.message = "云端朗读不可用，已自动回退到系统语音（规则式韵律）。";
            this.emit();
            this.speakCurrent();
            return;
          }
          this.fail(`朗读出错：${error}`);
        },
      },
    );
    this.startSilenceWatch(token);
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
        this.gapTimer = globalThis.setTimeout(() => {
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
    this.keepAliveTimer = globalThis.setInterval(() => {
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
    this.silenceTimer = globalThis.setTimeout(() => {
      this.silenceTimer = null;
      if (
        this.disposed ||
        token !== this.machine.token ||
        this.machine.state !== "playing"
      ) {
        return;
      }
      const engine = this.activeEngine();
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
      globalThis.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private clearGapTimer(): void {
    if (this.gapTimer !== null) {
      globalThis.clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearSilenceTimer();
    this.clearGapTimer();
    this.pendingGap = false;
    if (this.keepAliveTimer !== null) {
      globalThis.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
