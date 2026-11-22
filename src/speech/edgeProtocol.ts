/**
 * Edge「大声朗读」协议常量与失败诊断（零运行时依赖，桌面 / 手机端都能安全 import）。
 *
 * P1-1：把会随微软 Edge 升级而变化的版本号集中到本文件，并允许用户在设置页覆盖，
 * 避免「接口一升级就 403、静默回退系统语音」的定时失效。
 *
 * 为什么单独拆文件：设置页需要展示内置版本号与校验用户输入，但设置页在手机端也会加载；
 * 真正需要 Node crypto / ws 的 synthesize() 只在 edgeEngine.ts 里，由桌面端动态 import。
 * 本文件不 import 任何 Node 模块，因此不会把 ws 带进移动端加载路径。
 *
 * 协议来源：node-edge-tts v1.2.12（DRM v2 / CS64-SHA256）。
 * 注意：edge-tts-universal 1.4.0 用的是旧 v1 协议，2026 年新端点会返回 403，勿回退。
 * 最近核对：2026-11-21（真实 Obsidian 桌面端合成 MP3 成功）。
 *
 * 升级步骤（微软再次改接口时）：
 * 1. 把 EDGE_DEFAULT_CHROMIUM_VERSION 改成新版 Edge 的完整版本号（edge://version 可查）；
 * 2. 跑 npm run test / release:check；真机验证 Edge 朗读出声；
 * 3. 用户侧无需等发版：设置页「Edge 接口版本」可直接填新版本号热修。
 */

/** 插件内置的 Chromium 完整版本号；微软升级后可在此一处更新。 */
export const EDGE_DEFAULT_CHROMIUM_VERSION = "143.0.3650.75";

/** Sec-MS-GEC-Version 的完整取值（DRM v2 要求前缀 2-）。 */
export const EDGE_DEFAULT_GEC_VERSION = `2-${EDGE_DEFAULT_CHROMIUM_VERSION}`;

export const EDGE_ENDPOINT =
  "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1";
export const EDGE_HOST = "speech.platform.bing.com";
export const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
export const EDGE_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
export const EDGE_SYNTH_TIMEOUT_MS = 30000;
export const EDGE_WINDOWS_FILE_TIME_EPOCH = 11644473600n;

/** 合法版本号：143.0.3650.75 或 2-143.0.3650.75，其它一律回退内置值。 */
const GEC_VERSION_PATTERN = /^(?:2-)?\d+\.\d+\.\d+\.\d+$/;

/** 供设置页即时校验输入框，避免把非法字符串发给微软接口。 */
export function isValidGecVersionInput(input: string): boolean {
  const value = (input ?? "").trim();
  return !value || GEC_VERSION_PATTERN.test(value);
}

/**
 * 规范化版本号：空 / 非法 → 内置版本；裸版本号自动补 2- 前缀。
 * 只放行数字与点，杜绝查询参数注入。
 */
export function resolveGecVersion(input: string): string {
  const value = (input ?? "").trim();
  if (!value || !GEC_VERSION_PATTERN.test(value)) return EDGE_DEFAULT_GEC_VERSION;
  return value.startsWith("2-") ? value : `2-${value}`;
}

/** UA 里的 Chrome / Edge 主版本跟随实际使用的版本号，跨大版本热修时保持一致。 */
export function buildEdgeUserAgent(gecVersion: string): string {
  const chromium = gecVersion.replace(/^2-/, "");
  const major = chromium.split(".")[0] || EDGE_DEFAULT_CHROMIUM_VERSION.split(".")[0];
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`
  );
}

/** 403 的用户可读诊断：给出可操作的热修路径，而不是静默降级。 */
export const EDGE_403_HINT =
  "微软可能已升级 Edge 接口版本（Sec-MS-GEC-Version）。请在「设置 → 朗读 → Edge 接口版本」填入最新 Chromium 完整版本号（新版 Edge 的 edge://version 可查），或改用「自定义 TTS 网关」/ 系统语音。";

/**
 * 把底层失败翻译成可诊断文案。
 * - 403 / Unexpected server response: 403 / 鉴权类关闭码 → 明确提示接口版本过期；
 * - 401 → 提示 token 失效；
 * - 其它 → 原样保留，截断防止界面被超长错误撑开。
 */
export function describeEdgeFailure(statusOrMessage: number | string): string {
  const raw =
    typeof statusOrMessage === "number"
      ? String(statusOrMessage)
      : String(statusOrMessage ?? "");
  if (/\b403\b/.test(raw)) return `Edge 接口返回 403（鉴权失败）：${EDGE_403_HINT}`;
  if (/\b401\b/.test(raw)) {
    return "Edge 接口返回 401（token 未授权）：接口凭证或版本号可能已变更，请更新插件或在「设置 → 朗读 → Edge 接口版本」填入最新 Chromium 版本。";
  }
  const text = raw.trim() || "Edge 神经语音合成失败";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
