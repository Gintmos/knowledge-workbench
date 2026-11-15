import type { IndexDiff, IndexSnapshot, NoteRecord } from "../types";

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((tag, index) => tag === right[index]);
}

/** 判断单篇是否变化：按文档约定以 path + mtime + size + tags 为准，不比较摘要文本。 */
function isModified(before: NoteRecord, after: NoteRecord): boolean {
  return (
    before.mtime !== after.mtime ||
    before.size !== after.size ||
    !sameTags(before.tags, after.tags)
  );
}

/**
 * 相对上次磁盘快照计算「新增 / 减少 / 修改」三类只读差异。
 * previous 为 null（首次索引、快照损坏或版本升级）时标记 initial，UI 不把它当作真实新增来提示。
 */
export function computeDiff(
  previous: IndexSnapshot | null,
  current: IndexSnapshot,
): IndexDiff {
  const currentPaths = Object.keys(current.notes).sort();
  if (!previous) {
    return {
      added: currentPaths,
      removed: [],
      modified: [],
      unchanged: 0,
      initial: true,
    };
  }

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;

  for (const path of currentPaths) {
    const before = previous.notes[path];
    const after = current.notes[path];
    if (!before) {
      added.push(path);
    } else if (isModified(before, after)) {
      modified.push(path);
    } else {
      unchanged += 1;
    }
  }
  for (const path of Object.keys(previous.notes).sort()) {
    if (!current.notes[path]) removed.push(path);
  }

  return { added, removed, modified, unchanged, initial: false };
}

export function isEmptyDiff(diff: IndexDiff | null): boolean {
  if (!diff || diff.initial) return true;
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.modified.length === 0
  );
}

export function describeDiff(diff: IndexDiff | null): string {
  if (!diff || diff.initial) return "";
  if (isEmptyDiff(diff)) return "与上次快照一致，无变化";
  const parts: string[] = [];
  if (diff.added.length) parts.push(`新增 ${diff.added.length}`);
  if (diff.modified.length) parts.push(`修改 ${diff.modified.length}`);
  if (diff.removed.length) parts.push(`减少 ${diff.removed.length}`);
  return parts.join(" · ");
}
