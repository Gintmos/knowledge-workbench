/**
 * Web Speech 适配层：唯一允许触碰 window 的文件。
 * 服务层只依赖 SpeechEngine 接口，因此 Node 单测可用内存引擎跑全链路。
 * v1.0.1：Natural/Neural 音色优选、手动音色、动态 pitch、voiceschanged 探测。
 */
import { clampRate } from "./machine";
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechVoice,
} from "./types";

/** 中文 + 高质量音色打分：zh-CN > 其它 zh-* > 系统默认；Natural/Neural 额外加权。 */
function voiceScore(voice: SpeechVoice): number {
  const lang = voice.lang.toLowerCase();
  let score = lang.startsWith("zh-cn") ? 30 : lang.startsWith("zh") ? 20 : 0;
  const name = voice.name.toLowerCase();
  if (/natural|neural|online|premium|enhanced/.test(name)) score += 12;
  if (/xiaoxiao|yunxi|huihui|ting-?ting|mandarin|普通话/.test(name)) score += 4;
  return score;
}

/** 中文音色优先；手动指定时精确匹配音色名。 */
export function pickChineseVoice(
  voices: SpeechVoice[],
  prefer: boolean,
  manualName?: string,
): SpeechVoice | null {
  if (!voices.length) return null;
  if (manualName) {
    const manual = voices.find((voice) => voice.name === manualName);
    if (manual) return manual;
  }
  if (!prefer) return null;
  let best: SpeechVoice | null = null;
  for (const voice of voices) {
    if (!best || voiceScore(voice) > voiceScore(best)) best = voice;
  }
  return best && voiceScore(best) > 0 ? best : null;
}

/** 能力检测：不可用时返回 null，服务层给出中文降级提示而不是空白按钮。 */
export function createDomSpeechEngine(
  onVoicesChanged?: () => void,
): SpeechEngine | null {
  if (
    typeof window === "undefined" ||
    !window.speechSynthesis ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return null;
  }
  const synth = window.speechSynthesis;
  const voices = (): SpeechSynthesisVoice[] => {
    try {
      return synth.getVoices() ?? [];
    } catch {
      return [];
    }
  };
  // 系统音色常异步加载；Android WebView 可能始终为空，等待事件后再判定。
  if (onVoicesChanged) synth.onvoiceschanged = () => onVoicesChanged();

  return {
    label: "系统语音（规则式韵律）",
    needsKeepAlive: true,
    supported: () => true,
    getVoices: () =>
      voices().map((voice) => ({ name: voice.name, lang: voice.lang })),
    hasVoices: () => voices().length > 0,
    speak: (text: string, options: SpeakOptions, handlers: SpeakHandlers) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = clampRate(options.rate * (options.rateScale ?? 1));
      utterance.pitch = options.pitch ?? 1;
      utterance.lang = options.lang;
      if (options.voice) {
        const match = voices().find(
          (voice) => voice.name === options.voice?.name,
        );
        if (match) utterance.voice = match;
      }
      utterance.onstart = () => handlers.onStart();
      utterance.onend = () => handlers.onEnd();
      utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
        handlers.onError(event.error || "unknown");
      };
      synth.speak(utterance);
    },
    cancel: () => synth.cancel(),
    pause: () => synth.pause(),
    resume: () => synth.resume(),
    isSpeaking: () => synth.speaking,
    isPaused: () => synth.paused,
  };
}
