import {
  firstH1,
  pickFallbackSummary,
  pickFrontmatterSummary,
  pickTitle,
  truncateSummary,
  type FileCacheLike,
} from "./noteRecord";
import { firstMeaningfulParagraph } from "./speechText";
import { SUMMARY_ALGO } from "../types";

export interface SummaryInput {
  cache: FileCacheLike | null;
  body: string;
  basename: string;
}

/**
 * 规则式摘要（无 LLM / 无网络 / 无密钥）。优先级：
 * 1) frontmatter description / summary / abstract / kw-summary
 * 2) 正文首个有效段落（与 P5 朗读共用清洗规则）
 * 3) 文件名 + 首个一级标题
 * 4) 文件名兜底
 */
export function summarize(input: SummaryInput): string {
  const fm = input.cache?.frontmatter ?? null;
  const explicit = pickFrontmatterSummary(fm);
  if (explicit) return explicit;

  const paragraph = firstMeaningfulParagraph(input.body);
  if (paragraph) return truncateSummary(paragraph);

  return pickFallbackSummary(
    input.basename,
    pickTitle(fm, input.cache, input.basename),
    firstH1(input.cache),
  );
}

export interface SummaryCacheEntry {
  mtime: number;
  algo: number;
  summary: string;
}

/** 仅 mtime 或算法版本变化才重算；否则复用 index.json 里的摘要，不读正文。 */
export function shouldRecompute(
  before: SummaryCacheEntry | null,
  mtime: number,
  algo = SUMMARY_ALGO,
): boolean {
  if (!before || !before.summary) return true;
  return before.mtime !== mtime || before.algo !== algo;
}
