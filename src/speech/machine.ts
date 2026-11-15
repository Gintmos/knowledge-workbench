/**
 * P5 朗读状态机、断点与进度（全部纯函数、可单测）。
 * token 隔离：旧 utterance 的 onend 到达时 token 已变，必须被丢弃。
 */
import type { ReadProgress } from "../types";
import type { SpeechEvent, SpeechMachine } from "./types";

export const SPEECH_RATE_MIN = 0.5;
export const SPEECH_RATE_MAX = 3;
export const SILENCE_TIMEOUT_MS = 4000;
export const KEEP_ALIVE_MS = 10000;

export function initialMachine(): SpeechMachine {
  return { state: "idle", token: 0, idx: 0, total: 0 };
}

export function clampIndex(idx: number, total: number): number {
  if (total <= 0) return 0;
  const safe = Number.isFinite(idx) ? Math.floor(idx) : 0;
  return Math.min(total - 1, Math.max(0, safe));
}

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate));
}

/**
 * 状态迁移。非法迁移返回原对象（引用不变），便于调用方判断「什么都没发生」，
 * 也避免旧状态被意外重置。
 */
export function speechTransition(
  machine: SpeechMachine,
  event: SpeechEvent,
): SpeechMachine {
  switch (event.type) {
    case "start": {
      const total = Math.max(0, Math.floor(event.total));
      return {
        state: total > 0 ? "playing" : "idle",
        token: machine.token + 1,
        idx: clampIndex(event.from ?? machine.idx, total),
        total,
      };
    }
    case "pause":
      return machine.state === "playing"
        ? { ...machine, state: "paused" }
        : machine;
    case "resume":
      return machine.state === "paused"
        ? { ...machine, state: "playing" }
        : machine;
    case "stop":
      return { ...machine, state: "stopped", token: machine.token + 1 };
    case "next":
      if (machine.state !== "playing" || machine.idx + 1 >= machine.total) {
        return machine;
      }
      return { ...machine, idx: machine.idx + 1 };
    case "finish":
      return { ...machine, state: "idle", idx: machine.total };
    case "error":
      return { ...machine, state: "idle", token: machine.token + 1 };
    case "seek":
      return {
        ...machine,
        token: machine.token + 1,
        idx: clampIndex(event.idx, machine.total),
      };
    default:
      return machine;
  }
}

/** 断点只有在本轮分块数完全一致时才可续读；笔记被编辑后从头开始。 */
export function resumeIndex(
  progress: ReadProgress | null,
  total: number,
): number {
  if (!progress || progress.total !== total || total <= 0) return 0;
  return clampIndex(progress.idx, total);
}

export function toReadProgress(
  machine: SpeechMachine,
  at: number,
): ReadProgress {
  return {
    idx: clampIndex(machine.idx, machine.total),
    total: machine.total,
    at,
  };
}

/** 进度条：slider 的 value 是块索引，视觉比例用 (idx + 1) / total。 */
export function ratioForIndex(idx: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (clampIndex(idx, total) + 1) / total));
}

/** v15 的 seekCommit()：把拖动比例换算成块索引，边界不越界。 */
export function seekFromRatio(ratio: number, total: number): number {
  if (total <= 0) return 0;
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return clampIndex(Math.round(safe * (total - 1)), total);
}

export function ratioFromPointer(
  clientX: number,
  left: number,
  width: number,
): number {
  if (width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

/**
 * 静音超时检测：开始播放后 thresholdMs 内既没有 onstart 也没有 speaking，
 * 判定为设备无可用语音（手机 WebView 常见），交给服务层降级提示。
 */
export function detectSilence(args: {
  elapsedMs: number;
  started: boolean;
  speaking: boolean;
  thresholdMs: number;
}): boolean {
  return (
    args.elapsedMs >= args.thresholdMs && !args.started && !args.speaking
  );
}
