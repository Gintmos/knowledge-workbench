import type { ReadProgress } from "../types";

/** v14 的 SP 状态机：idle / playing / paused / stopped。 */
export type SpeechState = "idle" | "playing" | "paused" | "stopped";

export interface SpeechMachine {
  state: SpeechState;
  /** 每次开始 / 停止 / 跳转都递增，用于隔离上一轮 utterance 的异步 onend。 */
  token: number;
  /** 当前块索引（0 基）。 */
  idx: number;
  total: number;
}

export type SpeechEvent =
  | { type: "start"; total: number; from?: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "next" }
  | { type: "finish" }
  | { type: "error" }
  | { type: "seek"; idx: number };

export interface SpeechVoice {
  name: string;
  lang: string;
}

export interface SpeakOptions {
  rate: number;
  lang: string;
  voice: SpeechVoice | null;
}

export interface SpeakHandlers {
  onStart: () => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

/**
 * 宿主语音引擎的最小抽象：测试注入内存实现，生产用 Web Speech。
 * 服务层不直接触碰 window，便于在 Node 里跑全链路单测。
 */
export interface SpeechEngine {
  supported(): boolean;
  getVoices(): SpeechVoice[];
  speak(text: string, options: SpeakOptions, handlers: SpeakHandlers): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  isSpeaking(): boolean;
  isPaused(): boolean;
}

/** 断点读写，生产环境由 StoreService 适配到 PluginData.read[path]。 */
export interface SpeechProgressStore {
  get(path: string): ReadProgress | null;
  set(path: string, progress: ReadProgress | null): void;
}

export interface SpeechSnapshot {
  state: SpeechState;
  path: string | null;
  title: string;
  idx: number;
  total: number;
  rate: number;
  supported: boolean;
  /** 能力不可用 / 静音超时 / 错误时的中文提示。 */
  message: string;
  /** 有可恢复的断点（total 与当前分块数一致）。 */
  resumable: boolean;
  /** 当前块文本预览，便于界面显示「正在朗读」。 */
  preview: string;
}
