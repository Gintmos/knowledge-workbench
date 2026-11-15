/**
 * 可选云端神经 TTS 引擎（真人级自然度路径）。
 *
 * 设计约束：
 * - 默认关闭。只有在设置中显式开启、且用户自行填写服务地址与密钥时才联网；
 * - 只发送「当前这一块朗读文本」到用户自己配置的地址，不上传 vault、索引或笔记路径；
 * - 使用宿主提供的 requestUrl（桌面 / 手机端都可用，规避 CORS），不用 fetch / Node API；
 * - 音频以 data URI 交给 <audio> 播放，零运行时依赖；失败时由 SpeechService 回退系统语音。
 *
 * 兼容 OpenAI /v1/audio/speech 及同类网关：model、input、voice、response_format、
 * speed、instructions 均为可选字段，用户可在设置里改模型与音色。
 */
import { requestUrl } from "obsidian";
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechVoice,
} from "./types";

export interface CloudTtsConfig {
  enabled: boolean;
  url: string;
  key: string;
  model: string;
  voice: string;
  style: string;
}

/** 分块转 base64，避免一次性展开超大字符串触发参数上限。 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 4096;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(
      ...Array.from(bytes.subarray(index, index + step)),
    );
  }
  return btoa(binary);
}

export function createCloudTtsEngine(
  getConfig: () => CloudTtsConfig,
): SpeechEngine {
  let audio: HTMLAudioElement | null = null;
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

  return {
    label: "云端神经语音",
    needsKeepAlive: false,
    supported: () => {
      const config = getConfig();
      return (
        config.enabled &&
        config.url.trim().length > 0 &&
        config.key.trim().length > 0
      );
    },
    getVoices: (): SpeechVoice[] => [],
    hasVoices: () => true,
    speak: (text: string, options: SpeakOptions, handlers: SpeakHandlers) => {
      const config = getConfig();
      const current = ++token;
      stopAudio();
      if (!text.trim()) {
        handlers.onEnd();
        return;
      }
      const payload: Record<string, unknown> = {
        model: config.model,
        input: text,
        voice: config.voice,
        response_format: "mp3",
        speed: options.rate,
      };
      if (config.style.trim()) payload["instructions"] = config.style;
      const request = {
        url: config.url.trim(),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.key.trim()}`,
        },
        body: JSON.stringify(payload),
      };
      void requestUrl(request)
        .then((response) => {
          if (current !== token) return;
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP ${response.status}`);
          }
          const bytes = new Uint8Array(response.arrayBuffer);
          if (!bytes.length) throw new Error("empty audio");
          const element = new Audio(`data:audio/mpeg;base64,${toBase64(bytes)}`);
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
            handlers.onError(error instanceof Error ? error.message : String(error));
          });
        })
        .catch((error: unknown) => {
          if (current !== token) return;
          handlers.onError(error instanceof Error ? error.message : String(error));
        });
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
