/**
 * P5 分块队列（纯函数）：v14 的 splitSpeechChunks() 近原样移植。
 * Chromium 的 speechSynthesis 对超长 utterance 会静默停止，因此按标点优先切块，
 * 每块不超过 maxLen 个字符；块与块之间由 SP 状态机串行播放。
 */
import { mdToSpeechText } from "./speechText";

export const SPEECH_CHUNK_LIMIT = 160;

export interface SpeechChunk {
  text: string;
  /** 在清洗后文本中的字符偏移，仅用于进度与测试校验。 */
  start: number;
  end: number;
}

interface Piece {
  text: string;
  start: number;
  end: number;
}

// 句读符号优先作为切分点；换行与空白不进入朗读文本。
const BREAK = /[。！？!?；;：:，,、…]/;

function toPieces(text: string): Piece[] {
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
    if (BREAK.test(char)) {
      // 句首孤立标点也要保留，否则 chunksCoverText() 会判定「丢字」。
      if (start < 0) {
        start = i;
        buffer = char;
      } else {
        buffer += char;
      }
      flush(i + 1);
      continue;
    }
    if (start < 0) {
      if (/\s/.test(char)) continue;
      start = i;
      buffer = char;
    } else {
      buffer += char;
    }
  }
  if (start >= 0) flush(text.length);
  return pieces;
}

function hardSplit(piece: Piece, maxLen: number): SpeechChunk[] {
  const result: SpeechChunk[] = [];
  for (let offset = 0; offset < piece.text.length; offset += maxLen) {
    result.push({
      text: piece.text.slice(offset, offset + maxLen),
      start: piece.start + offset,
      end: Math.min(piece.end, piece.start + offset + maxLen),
    });
  }
  return result;
}

/**
 * 把纯文本切成 <= maxLen 的块。
 * 保证：去掉所有空白后，拼接结果与原文本完全一致（不丢字、不重复）。
 */
export function splitSpeechChunks(
  text: string,
  maxLen: number = SPEECH_CHUNK_LIMIT,
): SpeechChunk[] {
  const limit = Math.max(1, Math.floor(maxLen));
  const chunks: SpeechChunk[] = [];
  let current: SpeechChunk | null = null;

  const pushCurrent = (): void => {
    if (current) {
      chunks.push(current);
      current = null;
    }
  };

  for (const piece of toPieces(text)) {
    if (piece.text.length > limit) {
      pushCurrent();
      chunks.push(...hardSplit(piece, limit));
      continue;
    }
    if (current && current.text.length + 1 + piece.text.length <= limit) {
      current = {
        text: `${current.text} ${piece.text}`,
        start: current.start,
        end: piece.end,
      };
    } else {
      pushCurrent();
      current = { text: piece.text, start: piece.start, end: piece.end };
    }
  }
  pushCurrent();
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
