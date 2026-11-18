import type { NoteRecord } from "../types";

/** 标签归一化：去前导 #、统一小写用于匹配比较。 */
export function tagKey(tag: string): string {
  return tag.trim().replace(/^#+/, "").toLowerCase();
}

export interface TagEditPreview {
  /** 命中的笔记路径（去重、按路径排序）。 */
  paths: string[];
  /** 源标签涉及的标签键。 */
  matchedTags: string[];
  /** 合并后目标标签覆盖的笔记数（含目标标签原有笔记）。 */
  targetTotal: number;
}

/**
 * 预览一次「重命名 / 合并」会影响的笔记范围。
 * @param notes 全部笔记记录
 * @param sources 源标签（可多个，用于合并）
 * @param target 目标标签
 * @param includeChildren 是否同时处理 源/子标签
 */
export function previewTagEdit(
  notes: NoteRecord[],
  sources: string[],
  target: string,
  includeChildren: boolean,
): TagEditPreview {
  const sourceKeys = new Set(sources.map(tagKey).filter(Boolean));
  const targetKey = tagKey(target);
  const hit = new Set<string>();
  const matched = new Set<string>();
  for (const note of notes) {
    let noteHit = false;
    for (const tag of note.tags) {
      const key = tagKey(tag);
      const matchedSource =
        sourceKeys.has(key) ||
        (includeChildren && [...sourceKeys].some((s) => key.startsWith(`${s}/`)));
      if (matchedSource) {
        matched.add(key);
        noteHit = true;
      }
    }
    if (noteHit) hit.add(note.path);
  }
  const targetTotal = notes.filter((note) =>
    note.tags.some((tag) => tagKey(tag) === targetKey) ||
    hit.has(note.path),
  ).length;
  return {
    paths: [...hit].sort(),
    matchedTags: [...matched].sort(),
    targetTotal,
  };
}

/** 统计所有标签键及篇数，供弹窗源标签下拉使用。 */
export function listTagKeys(notes: NoteRecord[]): Array<{ key: string; count: number }> {
  const map = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const key = tagKey(tag);
      if (key) map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}
