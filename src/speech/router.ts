/**
 * 朗读引擎路由器：按设置把 speak 委托给当前选中的引擎。
 *
 * 让 SpeechService 只持有一个 preferredEngine，即可在
 * Edge（联网·免费）/ 自定义 TTS 网关（联网）之间切换，
 * 并复用其既有的「失败自动回退系统语音」状态机。
 */
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechVoice,
} from "./types";

export interface SpeechRouterConfig {
  /** 返回当前选中的引擎；system 时返回 null，走系统语音兜底。 */
  current: () => SpeechEngine | null;
  /** 未启用本地模型时的诊断文案（设置页展示）。 */
  diagnostic?: () => string | undefined;
}

export function createSpeechRouter(config: SpeechRouterConfig): SpeechEngine {
  const delegate = (): SpeechEngine | null => config.current();
  return {
    get label() {
      return delegate()?.label ?? "";
    },
    get needsKeepAlive() {
      return delegate()?.needsKeepAlive;
    },
    supported: () => delegate()?.supported() === true,
    prepare: () => delegate()?.prepare?.(),
    diagnostic: () =>
      delegate()?.diagnostic?.() ?? config.diagnostic?.() ?? "",
    getVoices: (): SpeechVoice[] => delegate()?.getVoices() ?? [],
    hasVoices: () => delegate()?.hasVoices?.() ?? false,
    speak: (text: string, options: SpeakOptions, handlers: SpeakHandlers) => {
      const engine = delegate();
      if (!engine || !engine.supported()) {
        handlers.onError("engine-unavailable");
        return;
      }
      engine.speak(text, options, handlers);
    },
    prefetch: (text: string, options: SpeakOptions, isStale?: () => boolean) =>
      delegate()?.prefetch?.(text, options, isStale),
    cancel: () => delegate()?.cancel(),
    pause: () => delegate()?.pause(),
    resume: () => delegate()?.resume(),
    isSpeaking: () => delegate()?.isSpeaking() ?? false,
    isPaused: () => delegate()?.isPaused() ?? false,
  };
}
