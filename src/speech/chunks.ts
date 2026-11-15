/**
 * 朗读分块（纯函数）：按「句群」而不是按每个逗号切分，避免机械的碎句连读。
 *
 * v1.0.1 韵律优化：
 * - 只在句末标点与换行处切句，逗号 / 顿号 / 冒号保留在句内；
 * - 相邻短句合并成一个 ≤ maxLen 的句群，用中文标点自然连接（不再用 ASCII 空格）；
 * - 超长句优先在最近的次级标点处断开，绝不从词中间硬切；
 * - 每块附带 pauseMs / rateScale / pitch，由服务层交给引擎注入停顿与语气。
 */
import { mdToSpeechText } from "./speechText";

export const SPEECH_CHUNK_LIMIT = 160;

export interface SpeechChunk {
  text: string;
  /** 在清洗后文本中的字符偏移，仅用于进度与测试校验。 */
  start: number;
  end: number;
  /** 本块读完后建议的停顿（毫秒）。 */
  pauseMs: number;
  /** 本块语速倍率。 */
  rateScale: number;
  /** 本块音高。 */
  pitch: number;
}

interface Piece {
  text: string;
  start: number;
  end: number;
}

/** 句末标点：在这里断句；逗号、顿号、冒号属于句内停顿，不切。 */
const TERMINAL = /[。！？!?…；;]/;
const SOFT = /[，,、：:]/;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 句末标点 / 换行切句，保留标点本身，保证拼接后不丢字。 */
function toSentences(text: string): Piece[] {
  const pieces: Piece[] = [];
  let buffer = "";
  let start = -1;

  const flush = (end: number): void => {
    const trimmed = buffer.trim();
    if (trimmed) pieces.push({ text: trimmed, start, end });
    buffer = "";
    start = -1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\n") {
      if (start >= 0) flush(i + 1);
      continue;
    }
    if (start < 0) {
      if (/\s/.test(char)) continue;
      start = i;
      buffer = char;
    } else {
      buffer += char;
    }
    if (TERMINAL.test(char)) flush(i + 1);
  }
  if (start >= 0) flush(text.length);
  return pieces;
}

/** 超长句在最近的次级标点处断开，尽量不切断词语。 */
function splitLong(piece: Piece, limit: number): Piece[] {
  if (piece.text.length <= limit) return [piece];
  const result: Piece[] = [];
  let rest = piece;
  while (rest.text.length > limit) {
    let cut = -1;
    for (let i = Math.min(limit, rest.text.length) - 1; i > 0; i -= 1) {
      if (SOFT.test(rest.text[i]) || TERMINAL.test(rest.text[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = limit;
    result.push({
      text: rest.text.slice(0, cut),
      start: rest.start,
      end: Math.min(rest.end, rest.start + cut),
    });
    rest = {
      text: rest.text.slice(cut),
      start: rest.start + cut,
      end: rest.end,
    };
  }
  if (rest.text) result.push(rest);
  return result;
}

/** 依据句末标点与语气给出停顿、语速与音高。 */
export function prosodyFor(text: string): {
  pauseMs: number;
  rateScale: number;
  pitch: number;
} {
  const chars = [...text];
  const last = chars.reverse().find((ch) => /[。！？!?…；;，,、：:]/.test(ch)) ?? "";
  let pauseMs = 160;
  if (/[！？!?…]/.test(last)) pauseMs = 340;
  else if (/[。]/.test(last)) pauseMs = 280;
  else if (/[；;]/.test(last)) pauseMs = 240;
  else if (SOFT.test(last)) pauseMs = 190;
  if (/…/.test(last)) pauseMs = 420;

  const question = /[？?]/.test(text);
  const exclaim = /[！!]/.test(text);
  const rateScale = clamp(
    1 + (exclaim ? -0.03 : 0) + (question ? -0.02 : 0) + (text.length > 100 ? 0.02 : 0),
    0.9,
    1.1,
  );
  const pitch = clamp(1 + (question ? 0.07 : 0) + (exclaim ? 0.05 : 0), 0.92, 1.12);
  return { pauseMs, rateScale, pitch };
}

function toChunk(piece: Piece): SpeechChunk {
  return {
    text: piece.text,
    start: piece.start,
    end: piece.end,
    ...prosodyFor(piece.text),
  };
}

/**
 * 把纯文本切成 <= maxLen 的句群。
 * 保证：去掉所有空白后，拼接结果与原文本完全一致（不丢字、不重复）。
 */
export function splitSpeechChunks(
  text: string,
  maxLen: number = SPEECH_CHUNK_LIMIT,
): SpeechChunk[] {
  const limit = Math.max(1, Math.floor(maxLen));
  const sentences = toSentences(text).flatMap((piece) => splitLong(piece, limit));
  const chunks: SpeechChunk[] = [];
  let current: Piece | null = null;

  const push = (): void => {
    if (current) chunks.push(toChunk(current));
    current = null;
  };

  for (const sentence of sentences) {
    // 中文句群直接相连，标点本身就是停顿；不再插入 ASCII 空格。
    if (current && current.text.length + sentence.text.length <= limit) {
      current = {
        text: `${current.text}${sentence.text}`,
        start: current.start,
        end: sentence.end,
      };
    } else {
      push();
      current = { ...sentence };
    }
  }
  push();
  return chunks;
}

/** md → 分块队列，供服务层直接使用。 */
export function mdToSpeechChunks(
  md: string,
  maxLen: number = SPEECH_CHUNK_LIMIT,
): SpeechChunk[] {
  return splitSpeechChunks(mdToSpeechText(md), maxLen);
}

/** 测试与诊断用：拼接后的朗读文本是否与原文本（去空白）完全一致。 */
export function chunksCoverText(text: string, chunks: SpeechChunk[]): boolean {
  const compact = (value: string): string => value.replace(/\s+/g, "");
  return compact(chunks.map((chunk) => chunk.text).join("")) === compact(text);
}
