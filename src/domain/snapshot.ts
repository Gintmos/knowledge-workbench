import {
  INDEX_VERSION,
  SUMMARY_ALGO,
  type IndexSnapshot,
  type NoteRecord,
} from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => item);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toNoteRecord(path: string, raw: unknown): NoteRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw["mtime"] !== "number" || typeof raw["size"] !== "number") return null;
  return {
    path,
    mtime: raw["mtime"],
    size: raw["size"],
    title: typeof raw["title"] === "string" ? raw["title"] : path,
    tags: asStringArray(raw["tags"]),
    links: asStringArray(raw["links"]),
    summary: typeof raw["summary"] === "string" ? raw["summary"] : "",
    due: nullableString(raw["due"]),
    status: nullableString(raw["status"]),
    updated: nullableString(raw["updated"]),
    review: nullableString(raw["review"]),
    // P3 新增字段：旧快照缺失时补默认，不因此判为损坏。
    reviewStage: Math.max(0, Math.floor(nullableNumber(raw["reviewStage"]) ?? 0)),
    interval: nullableNumber(raw["interval"]),
    ease: nullableNumber(raw["ease"]),
  };
}

/**
 * 读取磁盘上的 index.json。它是可从 vault 重建的派生数据：
 * 版本不符、结构损坏时返回 null，服务会按「首次索引」重建，不会抛异常打断插件加载。
 */
export function normalizeSnapshot(raw: unknown): IndexSnapshot | null {
  if (!isRecord(raw)) return null;
  if (raw["version"] !== INDEX_VERSION) return null;
  if (!isRecord(raw["notes"])) return null;
  const notes: Record<string, NoteRecord> = {};
  for (const [path, value] of Object.entries(raw["notes"])) {
    const record = toNoteRecord(path, value);
    if (record) notes[path] = record;
  }
  return {
    version: INDEX_VERSION,
    algo: typeof raw["algo"] === "number" ? raw["algo"] : SUMMARY_ALGO,
    generatedAt:
      typeof raw["generatedAt"] === "number" ? raw["generatedAt"] : Date.now(),
    notes,
  };
}

export function serializeSnapshot(snapshot: IndexSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function buildSnapshot(
  notes: Record<string, NoteRecord>,
  algo = SUMMARY_ALGO,
  generatedAt = Date.now(),
): IndexSnapshot {
  return {
    version: INDEX_VERSION,
    algo,
    generatedAt,
    notes,
  };
}
