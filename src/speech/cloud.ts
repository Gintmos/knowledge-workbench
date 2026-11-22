/**
 * 自定义 TTS 网关引擎（OpenAI /v1/audio/speech 兼容）——用户可选的双端联网方案。
 *
 * 这是本插件唯二放开的联网能力之一（另一个是 Edge 神经语音）：
 * 用户可填入国内可用的 OpenAI 兼容语音服务（如阿里云百炼 CosyVoice 网关），
 * 桌面与 Android 都能用（requestUrl 由 Obsidian 提供，规避 CORS）。默认关闭。
 *
 * 设计约束：
 * - 默认关闭。只有在设置中 speechEngine=cloud 且显式开启、并填写地址与密钥时才联网；
 * - 只发送「当前这一块朗读文本」到用户自己配置的地址，不上传 vault、索引或笔记路径；
 * - 使用宿主提供的 requestUrl（桌面 / 手机端都可用，规避 CORS），不用 fetch / Node API；
 * - P2-3：音频播放 / data URI 缓存 / 后台 prefetch / token 隔离统一由
 *   createAudioEngineCore 提供，本文件只负责「发请求拿音频」与错误诊断。
 *
 * 兼容 OpenAI /v1/audio/speech 及同类网关：model、input、voice、response_format、
 * speed、instructions 均为可选字段，用户可在设置里改模型与音色。
 */
import { requestUrl } from "obsidian";
import { createAudioEngineCore } from "./audioCore";
import type { SpeakOptions, SpeechEngine } from "./types";

export interface CloudTtsConfig {
  enabled: boolean;
  url: string;
  key: string;
  model: string;
  voice: string;
  style: string;
}

/**
 * P1-2：把网关 HTTP 失败翻译成可诊断文案，且绝不回显密钥 / 请求对象。
 * 设置页「朗读能力」会展示这条诊断，用户能立刻区分「密钥错」与「服务挂了」。
 */
export function describeCloudFailure(status: number): string {
  if (status === 401 || status === 403) {
    return "网关返回 401/403：API 密钥无效或权限不足，请在设置页核对密钥、服务地址与模型名（密钥不会写入日志或 vault 文件）。";
  }
  if (status === 429) {
    return "网关返回 429：请求频率超限，请稍后重试或检查服务商配额。";
  }
  if (status >= 500) {
    return `网关返回 ${status}：服务暂不可用，请稍后重试或更换服务商。`;
  }
  return `网关返回 HTTP ${status}`;
}

/**
 * P1-2：requestUrl 抛出的错误对象可能携带 url / headers，不能直接 String(error)
 * 塞进界面或日志。只取 message，并抹掉可能回显的 Bearer 凭据与常见密钥形态。
 */
export function summarizeRequestError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : String(error ?? "网关请求失败");
  const safe = raw
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/(?:sk-|api[_-]?key)[\w-]{8,}/gi, "***");
  return safe.length > 200 ? `${safe.slice(0, 200)}…` : safe;
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

/** 缓存键：所有会改变音频结果的设置 + 最终语速 + 文本。 */
function cacheKey(text: string, config: CloudTtsConfig, speed: number): string {
  return `${config.model}|${config.voice}|${config.style}|${speed.toFixed(2)}|${text}`;
}

function effectiveSpeed(options: SpeakOptions): number {
  return options.rate * (options.rateScale ?? 1);
}

export function createCloudTtsEngine(
  getConfig: () => CloudTtsConfig,
): SpeechEngine {
  const supported = (): boolean => {
    const config = getConfig();
    return (
      config.enabled &&
      config.url.trim().length > 0 &&
      config.key.trim().length > 0
    );
  };

  /** 唯一联网点：把一段文本 POST 到用户配置的网关，返回 data URI。 */
  const synthesize = async (
    text: string,
    options: SpeakOptions,
  ): Promise<string> => {
    const config = getConfig();
    const speed = effectiveSpeed(options);
    const payload: Record<string, unknown> = {
      model: config.model,
      input: text,
      voice: config.voice,
      response_format: "mp3",
      speed,
    };
    if (config.style.trim()) payload["instructions"] = config.style;
    const response = await requestUrl({
      url: config.url.trim(),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key.trim()}`,
      },
      body: JSON.stringify(payload),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(describeCloudFailure(response.status));
    }
    const bytes = new Uint8Array(response.arrayBuffer);
    if (!bytes.length) throw new Error("empty audio");
    return `data:audio/mpeg;base64,${toBase64(bytes)}`;
  };

  return createAudioEngineCore({
    label: "云端神经语音",
    supported,
    getVoices: () => [],
    cacheKey: (text, options) =>
      cacheKey(text, getConfig(), effectiveSpeed(options)),
    synthesize,
    // 网关错误必须脱敏后才交给界面 / 状态机，绝不回显请求对象或密钥。
    describeError: summarizeRequestError,
  });
}
