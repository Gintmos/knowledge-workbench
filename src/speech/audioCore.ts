/**
 * 联网语音引擎共享核心（P2-3 / P2-2）。
 *
 * Edge 神经语音与自定义 TTS 网关只有「怎么把一段文本变成音频 data URI」不同，
 * 其余完全一致：LRU 缓存（抵消约 2 秒合成延迟）、<audio> 播放与 token 隔离、
 * 后台预取、暂停/继续/取消。以前两份各自实现，容易出现行为漂移；这里收敛为
 * 单一工厂，两个引擎只提供 synthesize / cacheKey / describeError 三个差异点。
 *
 * 设计约束：
 * - 零 Node 依赖、零网络请求（网络只发生在各自注入的 synthesize 里），
 *   手机端经 cloud.ts 加载本模块也安全；
 * - 不触碰 vault / 索引 / 控制台，音频只以 data URI 交给 <audio>；
 * - P2-2：预取携带 isStale() 守卫，异步合成完成后校验会话 token 与笔记路径，
 *   期间切换笔记 / 停止 / 更换引擎都会让结果失效，不占 60 条缓存名额；
 * - in-flight 合并：speak 与 prefetch 命中同一段时只合成一次，避免 401 场景
 *   同一个请求连打两遍（与 P2-1 的退避动机一致）。
 */
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechVoice,
} from "./types";

/** <audio> 的最小抽象：默认用宿主 Audio，单测可注入内存实现。 */
export interface AudioLike {
  onplaying: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  readonly paused: boolean;
  readonly ended: boolean;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
}

/** 会话是否已失效：true 表示预取结果必须丢弃、不得写入缓存。 */
export type StaleGuard = () => boolean;

export interface AudioEngineCoreConfig {
  label: string;
  supported: () => boolean;
  getVoices: () => SpeechVoice[];
  /** 不可用时的原因（设置页「朗读能力」展示）。 */
  diagnostic?: () => string;
  /** 缓存键必须覆盖所有影响音频的参数：音色 / 语速 / 模型 / 文本。 */
  cacheKey: (text: string, options: SpeakOptions) => string;
  /** 合成音频 data URI；唯一允许联网的地方，由各引擎自行实现。 */
  synthesize: (text: string, options: SpeakOptions) => Promise<string>;
  /** 错误 → 可展示的中文诊断；网关侧必须脱敏，不得回显密钥。 */
  describeError: (error: unknown) => string;
  /** 缓存条数上限，默认 60。 */
  cacheLimit?: number;
  /** 单测注入：替换 new Audio(uri)。 */
  createAudio?: (uri: string) => AudioLike;
}

/** 有上限的 LRU 缓存：命中会把条目移到队尾，超出上限淘汰最早条目。 */
export function createAudioCache<T>(limit: number) {
  const map = new Map<string, T>();
  return {
    get(key: string): T | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value); // 命中即刷新热度
      }
      return value;
    },
    has(key: string): boolean {
      return map.has(key);
    },
    set(key: string, value: T): void {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    get size(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
  };
}

/**
 * 构造一个联网语音引擎。返回值满足 SpeechEngine 接口，可直接交给
 * SpeechRouter / SpeechService，无需再各自维护 audio / token / cache 状态。
 */
export function createAudioEngineCore(
  config: AudioEngineCoreConfig,
): SpeechEngine {
  const cache = createAudioCache<string>(config.cacheLimit ?? 60);
  /** 同一 key 只保留一个进行中的「网络合成」，speak / prefetch 共享结果。 */
  const inFlight = new Map<string, Promise<string>>();
  // HTMLAudioElement 的事件处理器是 (this, ev) => any，与 AudioLike 的
  // 无参签名在 TS 结构化比较下不兼容；这里只在默认工厂做一次类型收口，
  // 运行时仍是原生 <audio>，行为不变。单测走 config.createAudio 注入。
  const makeAudio: (uri: string) => AudioLike =
    config.createAudio ?? ((uri) => new Audio(uri) as unknown as AudioLike);

  let audio: AudioLike | null = null;
  let token = 0;

  const stopAudio = (): void => {
    if (!audio) return;
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio = null;
  };

  /**
   * 共享同一次网络合成（speak 与 prefetch 可能同时要同一段文本）。
   * 注意：这里只去重网络请求，不写缓存——缓存写入必须由调用方按自己的
   * 失效守卫决定，否则 prefetch 的失效会连带把正在播放的音频缓存清掉。
   */
  const synthesizeOnce = (
    key: string,
    text: string,
    options: SpeakOptions,
  ): Promise<string> => {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const job = config.synthesize(text, options);
    inFlight.set(key, job);
    const cleanup = (): void => {
      // 只清理自己，避免后续重试被旧条目吞掉；两个分支都吞掉异常。
      if (inFlight.get(key) === job) inFlight.delete(key);
    };
    void job.then(cleanup, cleanup);
    return job;
  };

  /**
   * 取音频 data URI：命中缓存直接返回；否则合成并写缓存。
   * isStale 非空时为「预取」调用（P2-2）：合成完成后若会话已失效，丢弃结果、
   * 不写缓存，也不报错（prefetch 会吞掉异常）；播放调用不带守卫，始终缓存。
   */
  const resolveAudio = (
    text: string,
    options: SpeakOptions,
    isStale?: StaleGuard,
  ): Promise<string> => {
    const key = config.cacheKey(text, options);
    const cached = cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    return synthesizeOnce(key, text, options).then((uri) => {
      if (isStale?.()) throw new Error("stale-prefetch");
      cache.set(key, uri);
      return uri;
    });
  };

  return {
    label: config.label,
    needsKeepAlive: false,
    supported: config.supported,
    diagnostic: config.diagnostic,
    getVoices: config.getVoices,
    hasVoices: () => true,
    speak: (text: string, options: SpeakOptions, handlers: SpeakHandlers) => {
      const current = ++token;
      stopAudio();
      if (!text.trim()) {
        handlers.onEnd();
        return;
      }
      void resolveAudio(text, options)
        .then((uri) => {
          if (current !== token) return;
          const element = makeAudio(uri);
          audio = element;
          element.onplaying = () => {
            if (current === token) handlers.onStart();
          };
          element.onended = () => {
            if (current !== token) return;
            stopAudio();
            handlers.onEnd();
          };
          element.onerror = () => {
            if (current !== token) return;
            stopAudio();
            handlers.onError("audio-playback-failed");
          };
          void element.play().catch((error: unknown) => {
            if (current !== token) return;
            handlers.onError(config.describeError(error));
          });
        })
        .catch((error: unknown) => {
          if (current !== token) return;
          handlers.onError(config.describeError(error));
        });
    },
    prefetch: (text: string, options: SpeakOptions, isStale?: StaleGuard) => {
      if (!text.trim()) return;
      if (cache.has(config.cacheKey(text, options))) return;
      void resolveAudio(text, options, isStale).catch(() => undefined);
    },
    cancel: () => {
      token += 1;
      stopAudio();
    },
    pause: () => audio?.pause(),
    resume: () => {
      if (audio) void audio.play().catch(() => undefined);
    },
    isSpeaking: () => Boolean(audio && !audio.paused && !audio.ended),
    isPaused: () => Boolean(audio && audio.paused && !audio.ended),
  };
}
