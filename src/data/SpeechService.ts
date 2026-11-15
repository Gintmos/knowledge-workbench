/**
 * P5 听笔记服务：v14 的 SP 状态机 / 分块队列 / token 隔离 / 保活定时器，
 * 加上 v15 的断点续读与 seekCommit()。只依赖注入的 SpeechEngine，
 * 不触碰 window、不发起网络请求、不使用 Node/Electron API。
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
} from "../speech/types";

const UNSUPPORTED_TEXT = "当前设备不支持朗读，可在桌面端使用";

export interface SpeechServiceOptions {
  engine: SpeechEngine | null;
  mobile: boolean;
  progress: SpeechProgressStore;
  rate?: number;
  preferChineseVoice?: boolean;
  now?: () => number;
  /** 可注入以便单测，生产走默认值。 */
  keepAliveMs?: number;
  silenceMs?: number;
}

export class SpeechService {
  private readonly engine: SpeechEngine | null;
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
  private message = "";
  private started = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: SpeechServiceOptions) {
    this.engine = options.engine;
    this.mobile = options.mobile;
    this.progress = options.progress;
    this.rate = clampRate(options.rate ?? 1);
    this.preferChineseVoice = options.preferChineseVoice ?? true;
    this.now = options.now ?? Date.now;
    this.keepAliveMs = options.keepAliveMs ?? KEEP_ALIVE_MS;
    this.silenceMs = options.silenceMs ?? SILENCE_TIMEOUT_MS;
    if (!this.engine?.supported()) this.message = UNSUPPORTED_TEXT;
    else if (this.mobile) {
      this.message = "手机端朗读可能不稳定，如无声音请在桌面端使用。";
    }
  }

  get supported(): boolean {
    return this.engine?.supported() === true;
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
    };
  }

  subscribe(listener: (state: SpeechSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  /** 绑定一篇笔记：清洗 + 分块，并读取断点；不会自动发声。 */
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
          : this.mobile
            ? "手机端朗读可能不稳定，如无声音请在桌面端使用。"
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
    this.engine?.cancel();
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
    this.machine = speechTransition(this.machine, { type: "pause" });
    this.engine?.pause();
    this.saveProgress();
    this.message = "已暂停，断点已保存。";
    this.emit();
  }

  resume(): void {
    if (this.disposed || this.machine.state !== "paused") return;
    this.machine = speechTransition(this.machine, { type: "resume" });
    this.engine?.resume();
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
    this.engine?.cancel();
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
    if (this.machine.state === "playing") {
      this.restartCurrentChunk();
    }
    this.emit();
  }

  setPreferChineseVoice(value: boolean): void {
    if (this.disposed) return;
    this.preferChineseVoice = value;
    if (this.machine.state === "playing") {
      this.restartCurrentChunk();
    }
    this.emit();
  }

  /** 语速 / 音色变更需要重说当前块；先递增 token 隔离旧 utterance 的回调。 */
  private restartCurrentChunk(): void {
    this.engine?.cancel();
    this.clearSilenceTimer();
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
    this.engine?.cancel();
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

  private stopInternal(save: boolean, message: string): void {
    this.engine?.cancel();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "stop" });
    if (save && this.path && this.machine.total > 0) {
      this.saveProgress();
    }
    this.message = message;
    this.emit();
  }

  private speakCurrent(): void {
    if (this.disposed || !this.engine || this.machine.state !== "playing") return;
    const chunk = this.chunks[this.machine.idx];
    if (!chunk) {
      this.finish();
      return;
    }
    const token = this.machine.token;
    this.started = false;
    const voice = pickChineseVoice(
      this.engine.getVoices(),
      this.preferChineseVoice,
    );
    this.engine.speak(
      chunk.text,
      {
        rate: this.rate,
        lang: voice?.lang ?? (this.preferChineseVoice ? "zh-CN" : ""),
        voice,
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
      this.machine = next;
      this.saveProgress();
      this.emit();
      this.speakCurrent();
      return;
    }
    this.finish();
  }

  private finish(): void {
    this.engine?.cancel();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "finish" });
    if (this.path) this.progress.set(this.path, null);
    this.message = "朗读完成，断点已清除。";
    this.emit();
  }

  private fail(message: string): void {
    this.engine?.cancel();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "error" });
    this.saveProgress();
    this.message = message;
    this.emit();
  }

  private degrade(): void {
    this.engine?.cancel();
    this.clearTimers();
    this.machine = speechTransition(this.machine, { type: "error" });
    this.saveProgress();
    this.message = this.mobile
      ? `${UNSUPPORTED_TEXT}（手机端无声或音色不可用）`
      : UNSUPPORTED_TEXT;
    this.emit();
  }

  private startKeepAlive(): void {
    if (this.disposed || this.keepAliveTimer || this.keepAliveMs <= 0) return;
    this.keepAliveTimer = globalThis.setInterval(() => {
      if (this.disposed || this.machine.state !== "playing" || !this.engine) return;
      // Chromium 长文本会在约 15 秒后静默停止，pause/resume 可保活。
      if (this.engine.isSpeaking() && !this.engine.isPaused()) {
        this.engine.pause();
        this.engine.resume();
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
        this.machine.state !== "playing" ||
        !this.engine
      ) {
        return;
      }
      if (
        detectSilence({
          elapsedMs: this.silenceMs,
          started: this.started,
          speaking: this.engine.isSpeaking(),
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

  private clearTimers(): void {
    this.clearSilenceTimer();
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
