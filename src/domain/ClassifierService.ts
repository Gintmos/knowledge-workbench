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
 * 全量主分类切片（不归并「其他」），供统计卡片的可滚动柱状图与下钻清单使用。
 */
export function allCategorySlices(
  notes: NoteRecord[],
  mode: ClassifyBy,
): ChartSlice[] {
  return [...groupByCategory(notes, mode).entries()]
    .map(([key, paths]) => ({ key, count: paths.length, paths }))
    .sort((a, b) => b.count - a.count || cmp(a.key, b.key));
}

/** 每个标签（含层级）对应的笔记路径；列表显示名统一加 # 前缀。 */
export function tagSlices(notes: NoteRecord[]): ChartSlice[] {
  const groups = new Map<string, string[]>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const paths = groups.get(tag) ?? [];
      paths.push(note.path);
      groups.set(tag, paths);
    }
  }
  return [...groups.entries()]
    .map(([key, paths]) => ({ key, count: paths.length, paths }))
    .sort((a, b) => b.count - a.count || cmp(a.key, b.key));
}

/** 首层文件夹对应的笔记路径。 */
export function folderSlices(notes: NoteRecord[]): ChartSlice[] {
  const groups = new Map<string, string[]>();
  for (const note of notes) {
    const key = folderOf(note.path);
    const paths = groups.get(key) ?? [];
    paths.push(note.path);
    groups.set(key, paths);
  }
  return [...groups.entries()]
    .map(([key, paths]) => ({ key, count: paths.length, paths }))
    .sort((a, b) => b.count - a.count || cmp(a.key, b.key));
}

/** 「标签 / 文件夹」卡片：与列表行显示名完全一致的可点击切片。 */
export function detailSlices(notes: NoteRecord[]): ChartSlice[] {
  return [
    ...tagSlices(notes).map((slice) => ({ ...slice, key: `#${slice.key}` })),
    ...folderSlices(notes).map((slice) => ({
      ...slice,
      key: `目录 · ${slice.key}`,
    })),
  ];
}

/**
 * 旧版有限柱状图：最多 limit 根柱子，长尾统一归入「其他」。
 * 保留给需要压缩视图的调用方与历史基线单测；统计页已改用全量切片。
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
