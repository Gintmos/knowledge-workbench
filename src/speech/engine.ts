/**
 * Web Speech 适配层：唯一允许触碰 window 的文件。
 * 服务层只依赖 SpeechEngine 接口，因此 Node 单测可用内存引擎跑全链路。
 */
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechVoice,
} from "./types";

/** 中文音色优先：zh-CN > 其它 zh-* > 系统默认。 */
export function pickChineseVoice(
  voices: SpeechVoice[],
  prefer: boolean,
): SpeechVoice | null {
  if (!prefer || !voices.length) return null;
  const score = (voice: SpeechVoice): number => {
    const lang = voice.lang.toLowerCase();
    if (lang.startsWith("zh-cn")) return 3;
    if (lang.startsWith("zh")) return 2;
    return 0;
  };
  let best: SpeechVoice | null = null;
  for (const voice of voices) {
    if (!best || score(voice) > score(best)) best = voice;
  }
  return best && score(best) > 0 ? best : null;
}

/** 能力检测：不可用时返回 null，服务层给出中文降级提示而不是空白按钮。 */
export function createDomSpeechEngine(): SpeechEngine | null {
  if (
    typeof window === "undefined" ||
    !window.speechSynthesis ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return null;
  }
  const synth = window.speechSynthesis;
  return {
    supported: () => true,
    getVoices: () =>
      synth.getVoices().map((voice) => ({
        name: voice.name,
        lang: voice.lang,
      })),
    speak: (text: string, options: SpeakOptions, handlers: SpeakHandlers) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = options.rate;
      utterance.lang = options.lang;
      if (options.voice) {
        const match = synth
          .getVoices()
          .find((voice) => voice.name === options.voice?.name);
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
