import {
  CHART_LIMIT,
  type CategoryCount,
  type ChartSlice,
  type ClassifyBy,
  type NoteRecord,
} from "../types";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function topLevelTag(tag: string): string {
  return tag.split("/")[0] || tag;
}

export function folderOf(path: string): string {
  const parts = path.split("/").slice(0, -1);
  return parts[0] || "根目录";
}

/** 一篇笔记归入唯一主分类：标签优先，其次文件夹，最后「未分类」。 */
export function primaryCategory(note: NoteRecord, mode: ClassifyBy): string {
  if (mode === "folder") return folderOf(note.path);
  return note.tags.length ? topLevelTag(note.tags[0]) : "未分类";
}

export function groupByCategory(
  notes: NoteRecord[],
  mode: ClassifyBy,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const note of notes) {
    const key = primaryCategory(note, mode);
    const paths = groups.get(key) ?? [];
    paths.push(note.path);
    groups.set(key, paths);
  }
  return groups;
}

/** 逐篇统计，不设上限：所有类别计数之和恒等于笔记总数（v9 语义）。 */
export function countByCategory(
  notes: NoteRecord[],
  mode: ClassifyBy,
): CategoryCount[] {
  return [...groupByCategory(notes, mode).entries()]
    .map(([key, paths]) => ({ key, count: paths.length }))
    .sort((a, b) => b.count - a.count || cmp(a.key, b.key));
}

/** 所有标签的逐篇计数（明细用，同样不设上限）。 */
export function tagCounts(notes: NoteRecord[]): CategoryCount[] {
  const map = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || cmp(a.key, b.key));
}

export function folderCounts(notes: NoteRecord[]): CategoryCount[] {
  return countByCategory(notes, "folder");
}

/**
 * 仅用于柱状图：最多 limit 根柱子，长尾统一归入「其他」。
 * 不影响 countByCategory 的逐篇统计，也不裁剪知识条目。
 */
export function chartSlices(
  notes: NoteRecord[],
  mode: ClassifyBy,
  limit = CHART_LIMIT,
): ChartSlice[] {
  const groups = [...groupByCategory(notes, mode).entries()]
    .map(([key, paths]) => ({ key, count: paths.length, paths }))
    .sort((a, b) => b.count - a.count || cmp(a.key, b.key));
  if (groups.length <= limit) return groups;
  const head = groups.slice(0, Math.max(1, limit - 1));
  const rest = groups.slice(Math.max(1, limit - 1));
  const paths = rest.flatMap((group) => group.paths);
  return [
    ...head,
    { key: "其他", count: paths.length, paths },
  ];
}
