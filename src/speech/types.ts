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
  /** 用户设定的基准语速，不随韵律波动。 */
  rate: number;
  lang: string;
  voice: SpeechVoice | null;
  /** 句群韵律倍率，由引擎乘到 rate 上；缺省 1 保持旧行为。 */
  rateScale?: number;
  /** 句群音高，缺省 1。 */
  pitch?: number;
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
  /** 用于界面显示当前生效的引擎。 */
  label?: string;
  /** 是否需要 10s pause/resume 保活；云端 <audio> 引擎不需要。 */
  needsKeepAlive?: boolean;
  supported(): boolean;
  /** 可选：设置变化后主动准备模型。返回 Promise 便于界面等待后刷新检测状态。 */
  prepare?(): void | Promise<void>;
  /** 可选：不可用时的具体原因，设置页「朗读能力」直接展示，避免只显示「不可用」。 */
  diagnostic?(): string;
  getVoices(): SpeechVoice[];
  /** 宿主是否确实提供了可用音色（Android WebView 常为 false）。 */
  hasVoices?(): boolean;
  speak(text: string, options: SpeakOptions, handlers: SpeakHandlers): void;
  /**
   * 可选：后台预合成下一段，命中缓存后播放可省去网络握手延迟。
   * P2-2：isStale 由 SpeechService 传入，快照会话 token 与笔记路径；
   * 合成完成后守卫返回 true 表示会话已失效，引擎必须丢弃结果、不写缓存。
   */
  prefetch?(text: string, options: SpeakOptions, isStale?: () => boolean): void;
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
  /** 当前生效的引擎：Edge 神经语音 / 自定义网关 / 系统语音 / 不可用。 */
  engineLabel: string;
  /** 首选引擎未就绪时的诊断（如缺少模型文件），仅在启用该引擎时填充。 */
  engineDiagnostic?: string;
  /**
   * P1-1 / P1-2：最近一次首选引擎失败的可读诊断（如 Edge 403、网关 401）。
   * 由设置页「朗读能力」展示，避免用户只看到「已回退系统语音」却不知原因。
   */
  engineLastError?: string;
}
