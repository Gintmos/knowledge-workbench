/**
 * 微软 Edge「大声朗读」神经语音引擎（2026 DRM v2 / CS64-SHA256）——桌面端专用。
 *
 * 为什么是联网：项目原有本地方案（系统语音 / Kokoro / Matcha / sherpa-onnx WASM 等）
 * 在「自然度 + Obsidian 双端兼容」上均不达标；Edge 神经语音免费、无需密钥、国内可直连，
 * 是本插件放开的联网能力之一。除本引擎与可选的自定义 TTS 网关外，其余功能保持零网络。
 *
 * 为什么仅桌面：2026 年 Edge 端点要求自定义 Host / Origin / User-Agent 头，
 * 浏览器原生 WebSocket 不允许设置这些头（会被 403）。Electron 桌面端可用打包的 Node `ws`
 * 设置；Android WebView 只有原生 WebSocket，无法设置 → 手机端请用「自定义 TTS 网关」或朗读稿。
 *
 * 设计约束：
 * - 默认关闭，只有设置里显式选择 Edge 才初始化、才联网；
 * - 只发送「当前这一块朗读文本 + 音色」，不上传 vault / 索引 / 笔记路径；
 * - 合成结果以 data URI 交给 <audio> 播放，失败由 SpeechService 回退系统语音；
 * - WebSocket 客户端通过 esbuild alias 强制走 Node codepath（见 esbuild.config.mjs）。
 */
import { createHash, randomBytes } from "crypto";
import WebSocket from "ws";
import {
  EDGE_ENDPOINT,
  EDGE_HOST,
  EDGE_ORIGIN,
  EDGE_OUTPUT_FORMAT,
  EDGE_SYNTH_TIMEOUT_MS,
  EDGE_TRUSTED_CLIENT_TOKEN,
  EDGE_WINDOWS_FILE_TIME_EPOCH,
  buildEdgeUserAgent,
  describeEdgeFailure,
  resolveGecVersion,
} from "./edgeProtocol";
import { createAudioEngineCore } from "./audioCore";
import type { SpeakOptions, SpeechEngine, SpeechVoice } from "./types";

// P1-1：DRM v2 版本号、端点、Host/Origin/UA、音色格式等协议常量已集中到
// edgeProtocol.ts（零 Node 依赖，设置页可安全引用）。版本号支持设置页覆盖，
// 微软升级接口后用户可自行热修，不必等插件发版；非法输入一律回退内置版本。

/** 供设置页展示的中文音色（ShortName 直接作为 voice id）。 */
export const EDGE_VOICES: SpeechVoice[] = [
  { name: "zh-CN-XiaoxiaoNeural", lang: "zh-CN" }, // 晓晓·温柔女声（默认）
  { name: "zh-CN-XiaoyiNeural", lang: "zh-CN" }, // 晓伊·活泼女声
  { name: "zh-CN-YunxiNeural", lang: "zh-CN" }, // 云希·阳光男声
  { name: "zh-CN-YunjianNeural", lang: "zh-CN" }, // 云健·浑厚男声
  { name: "zh-CN-YunyangNeural", lang: "zh-CN" }, // 云扬·专业男声
  { name: "zh-CN-liaoning-XiaobeiNeural", lang: "zh-CN" }, // 东北话·小北
  { name: "zh-CN-shaanxi-XiaoniNeural", lang: "zh-CN" }, // 陕西话·小妮
];

/** PREFIX：微软版权固定串，DRM v2 的 sha256 要先塞这段再拼数据。 */
const PREFIX = Buffer.from(
  [
    "Q29weXJpZ2h0IChDKSBNaWNyb3NvZnQg",
    "Q29ycG9yYXRpb24uIEFsbCByaWdodHMgcmVzZXJ2ZWQu",
  ].join(""),
  "base64",
);

/** cs64Digest 的 14 组系数（DRM v2 核心，纯 32 位整数位运算）。 */
const COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];

const mul = Math.imul;
const rol16 = (x: number): number => ((x << 16) | (x >>> 16)) >>> 0;

/** DRM v2 的 CS64 摘要：把 sha256 结果搅成 8 字节短哈希。 */
function cs64Digest(data: Buffer, shaDigest: Buffer): Buffer {
  const keyA = (shaDigest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (shaDigest.readUInt32LE(4) | 1) >>> 0;
  const factors: [number, number] = [
    mul(keyA, 0x82893933) >>> 0,
    mul(keyB, 0x82893933) >>> 0,
  ];
  const terms: number[] = COEFFICIENTS.map(
    ([coefficient], i) => mul(coefficient, factors[i % 2]) >>> 0,
  );
  const offsets: number[] = COEFFICIENTS.map(([, offset]) => offset);
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / 8) * 8);
  padded.set(data, 1);
  for (let i = 0; i < padded.length / 4; i++) {
    const word = padded.readUInt32LE(i * 4);
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(
      rol16(word),
      i % 2 === 0 ? 0xef0569fb : 0xc31713db,
    );
    if (i === 0) {
      term = (term + mul(0xf2f90b1a, factors[0])) >>> 0;
      offset = (offset + 0x0b1a0000) >>> 0;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  }
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = mul(t, 0x76f50f34);
    swapAcc += (mul(rol16(q), 0xc3efea97) + q) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = mul(t, 0x1881ce3c);
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;
    state = (mul(state, keyA) + x) >>> 0;
    for (const k of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) {
      state = mul(rol16(state), k) >>> 0;
    }
    acc += state;
    t = (mul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xa27416f5) >>> 0;
    t = mul(rol16(t), 0xd38396ff) >>> 0;
    state =
      mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  const result = Buffer.allocUnsafe(8);
  result.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  result.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return result;
}

/** 生成 DRM v2 的 Sec-MS-GEC token。 */
export function generateSecMsGecV2(unixSeconds = Date.now() / 1000): string {
  if (!Number.isFinite(unixSeconds)) throw new TypeError("invalid time");
  const epochSeconds =
    BigInt(Math.floor(unixSeconds)) + EDGE_WINDOWS_FILE_TIME_EPOCH;
  const rounded = epochSeconds - (epochSeconds % 300n);
  const ticks = rounded * 10000000n;
  const data = Buffer.from(`${ticks}${EDGE_TRUSTED_CLIENT_TOKEN}`, "ascii");
  const sha = createHash("sha256")
    .update(new Uint8Array(PREFIX))
    .update(new Uint8Array(data))
    .digest();
  const cs64 = cs64Digest(data, sha);
  return `${cs64.toString("hex").toUpperCase()}-${sha.toString("hex").toUpperCase()}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      default: return "&apos;";
    }
  });
}

function toBase64(bytes: Buffer): string {
  return bytes.toString("base64");
}

export interface EdgeEngineConfig {
  isEnabled: () => boolean;
  getVoiceId: () => string;
  getRate: () => number;
  /** P1-1：用户在设置页填写的 Sec-MS-GEC-Version 覆盖值；留空用内置版本。 */
  getGecVersion?: () => string;
}

/**
 * 合成一块文本为 MP3 Buffer（单次连接，输出到 turn.end）。
 * gecVersion 由 resolveGecVersion() 校验过，只含数字与点，拼进 URL 是安全的。
 */
async function synthesize(
  text: string,
  voice: string,
  rate: number,
  gecVersion: string,
): Promise<Buffer> {
  const url =
    `${EDGE_ENDPOINT}?Ocp-Apim-Subscription-Key=${EDGE_TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${generateSecMsGecV2()}` +
    `&Sec-MS-GEC-Version=${gecVersion}`;
  const wsOptions: WebSocket.ClientOptions = {
    host: EDGE_HOST,
    origin: EDGE_ORIGIN,
    headers: {
      "User-Agent": buildEdgeUserAgent(gecVersion),
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
  };
  const ws = new WebSocket(url, wsOptions);

  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, audio?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(audio ?? Buffer.alloc(0));
    };
    const timer = setTimeout(
      () => finish(new Error("Edge TTS 合成超时")),
      EDGE_SYNTH_TIMEOUT_MS,
    );
    ws.on("open", () => {
      const config =
        "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: "false",
                  wordBoundaryEnabled: "false",
                },
                outputFormat: EDGE_OUTPUT_FORMAT,
              },
            },
          },
        });
      // rate 是 0.5~2.5 倍率，映射到 SSML 的 +/- 百分比。
      const pct = Math.round((rate - 1) * 100);
      const rateAttr = pct === 0 ? "default" : `${pct > 0 ? "+" : ""}${pct}%`;
      const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
        `xml:lang="zh-CN"><voice name="${voice}">` +
        `<prosody rate="${rateAttr}">${escapeXml(text)}</prosody>` +
        `</voice></speak>`;
      const request =
        `X-RequestId:${randomBytes(16).toString("hex")}\r\n` +
        `Content-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(config);
      ws.send(request);
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (data.length < 2) return;
        const offset = data.readUInt16BE(0) + 2;
        const audio = data.subarray(offset);
        if (audio.length > 0) chunks.push(Buffer.from(audio));
        return;
      }
      if (data.toString().includes("Path:turn.end")) {
        finish(undefined, Buffer.concat(chunks));
      }
    });
    // P1-1：HTTP 403 / 401 是「接口版本过期」的典型信号。ws 在非 101 响应时
    // 触发 unexpected-response（未监听则只给 error 文本），两处都翻译成可操作诊断，
    // 让设置页「朗读能力」能显示原因，而不是静默回退系统语音。
    ws.on("unexpected-response", (_request, response) => {
      response.resume(); // 消费响应体，避免 socket 悬挂
      finish(new Error(describeEdgeFailure(response.statusCode ?? 0)));
    });
    ws.on("error", (error: Error) =>
      finish(new Error(describeEdgeFailure(error.message))),
    );
    ws.on("close", (code: number) => {
      if (!settled) {
        finish(new Error(describeEdgeFailure(`Edge TTS 连接关闭（code ${code}）`)));
      }
    });
  });
}

/** 缓存键：音色 + 最终语速 + 文本，与网关口径一致。 */
function edgeCacheKey(text: string, voice: string, rate: number): string {
  return `${voice}|${rate.toFixed(2)}|${text}`;
}

function effectiveRate(options: SpeakOptions): number {
  return options.rate * (options.rateScale ?? 1);
}

/**
 * 构造 Edge 神经语音引擎。仅桌面可用（需 Node ws 设置自定义头）。
 * P2-3：音频缓存 / <audio> 播放 / 后台 prefetch / token 隔离已收敛到
 * createAudioEngineCore，本文件只保留「建立 WebSocket 合成 MP3」这一个联网点。
 */
export function createEdgeEngine(config: EdgeEngineConfig): SpeechEngine {
  /** P1-1：每次合成前重新读取设置，用户改版本号后立即生效（无需重启插件）。 */
  const gecVersion = (): string =>
    resolveGecVersion(config.getGecVersion?.() ?? "");
  const currentVoice = (): string =>
    config.getVoiceId() || EDGE_VOICES[0].name;

  /** 唯一联网点：合成一块 MP3 并以 data URI 返回，由共享核心负责缓存与播放。 */
  const synthesizeUri = async (
    text: string,
    options: SpeakOptions,
  ): Promise<string> => {
    const buffer = await synthesize(
      text,
      currentVoice(),
      effectiveRate(options),
      gecVersion(),
    );
    if (!buffer.length) throw new Error("Edge TTS 返回空音频");
    return `data:audio/mpeg;base64,${toBase64(buffer)}`;
  };

  return createAudioEngineCore({
    label: "Edge 神经语音（在线·免费）",
    supported: () => config.isEnabled(),
    diagnostic: () =>
      "当前环境无法使用 Edge 神经语音，请改用系统语音、自定义 TTS 网关或朗读稿；若是接口 403，请在设置页「Edge 接口版本」填入最新 Chromium 版本号。",
    getVoices: () => EDGE_VOICES,
    cacheKey: (text, options) =>
      edgeCacheKey(text, currentVoice(), effectiveRate(options)),
    synthesize: synthesizeUri,
    // Edge 合成错误已在协议层翻译为中文诊断；播放异常由浏览器抛 Error，取 message 即可。
    describeError: (error) =>
      error instanceof Error ? error.message : String(error),
  });
}
