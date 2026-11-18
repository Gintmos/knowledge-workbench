import { SUMMARY_LIMIT, type NoteRecord, type TaskItem } from "../types";

/**
 * 纯函数层：不 import obsidian，输入用最小结构描述，
 * 既能接 Obsidian 的 CachedMetadata / TFile，也能在 Node 单测里直接构造。
 */
export interface FileMetaLike {
  path: string;
  basename: string;
  mtime: number;
  size: number;
}

export interface FileCacheLike {
  tags?: Array<{ tag: string }>;
  frontmatter?: Record<string, unknown> | null;
  headings?: Array<{ heading: string; level: number }>;
  links?: Array<{ link: string }>;
}

const SUMMARY_KEYS = ["description", "summary", "abstract", "kw-summary"];

export function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function truncateSummary(text: string, limit = SUMMARY_LIMIT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").replace(/#/g, "/").replace(/\s+/g, "-");
}

function splitTagValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => splitTagValue(item));
  const text = asText(value);
  if (!text) return [];
  return text.split(/[,\s]+/).filter(Boolean);
}

/** Obsidian 会把 frontmatter tags 与内联 #tag 一并放进 cache.tags；此处再兜底合并一次并去重。 */
export function collectTags(cache: FileCacheLike | null): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    result.push(tag);
  };
  const fm = cache?.frontmatter ?? null;
  if (fm) {
    splitTagValue(fm["tags"]).forEach(push);
  }
  (cache?.tags ?? []).forEach((entry) => push(entry.tag));
  return result;
}

export function firstH1(cache: FileCacheLike | null): string {
  const heading = (cache?.headings ?? []).find(
    (item) => item.level === 1 && asText(item.heading),
  );
  return heading ? asText(heading.heading) : "";
}

export function pickTitle(
  fm: Record<string, unknown> | null,
  cache: FileCacheLike | null,
  basename: string,
): string {
  const explicit = fm ? asText(fm["title"]) : "";
  if (explicit) return truncateSummary(explicit, 160);
  return firstH1(cache) || basename;
}

/** 规则式摘要第 1 优先级：frontmatter 中用户已写好的摘要字段。 */
export function pickFrontmatterSummary(fm: Record<string, unknown> | null): string {
  if (!fm) return "";
  for (const key of SUMMARY_KEYS) {
    const text = asText(fm[key]);
    if (text) return truncateSummary(text);
  }
  return "";
}

/** 规则式摘要第 3 / 4 优先级：文件名 + 首个一级标题，最后兜底文件名。第 2 级正文解析留给 P3。 */
export function pickFallbackSummary(basename: string, title: string, h1: string): string {
  const parts = [basename];
  const secondary = h1 || (title !== basename ? title : "");
  if (secondary && secondary !== basename) parts.push(secondary);
  return truncateSummary(parts.join(" · "));
}

function dateField(fm: Record<string, unknown> | null, key: string): string | null {
  const text = fm ? asText(fm[key]) : "";
  return text || null;
}

function numberField(fm: Record<string, unknown> | null, key: string): number | null {
  const value = fm ? fm[key] : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function collectLinks(cache: FileCacheLike | null): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of cache?.links ?? []) {
    const link = asText(item.link);
    if (!link || seen.has(link)) continue;
    seen.add(link);
    result.push(link);
  }
  return result;
}

/**
 * P2 保留默认摘要（frontmatter + 文件名/H1）；P3 由 VaultIndexService 通过
 * summaryOverride 注入「正文首段」规则式摘要，避免 noteRecord 与 SummaryService 循环依赖。
 */
export function buildNoteRecord(
  file: FileMetaLike,
  cache: FileCacheLike | null,
  summaryOverride?: string,
  tasks: TaskItem[] = [],
): NoteRecord {
  const fm = cache?.frontmatter ?? null;
  const title = pickTitle(fm, cache, file.basename);
  const h1 = firstH1(cache);
  const summary =
    summaryOverride ||
    pickFrontmatterSummary(fm) ||
    pickFallbackSummary(file.basename, title, h1);
  return {
    path: file.path,
    mtime: file.mtime,
    size: file.size,
    title,
    tags: collectTags(cache),
    links: collectLinks(cache),
    summary,
    due: dateField(fm, "due"),
    status: dateField(fm, "status")?.toLowerCase() ?? null,
    updated: dateField(fm, "updated"),
    review: dateField(fm, "review"),
    reviewStage: Math.max(0, Math.floor(numberField(fm, "review-stage") ?? 0)),
    interval: numberField(fm, "interval"),
    ease: numberField(fm, "ease"),
    tasks,
  };
}
