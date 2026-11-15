import {
  DATA_VERSION,
  DEFAULT_SETTINGS,
  HISTORY_LIMIT,
  defaultData,
  type HistoryEntry,
  type PluginData,
  type ReadProgress,
  type WorkbenchSettings,
  type WorkbenchTab,
} from "../types";

const TABS: WorkbenchTab[] = ["today", "knowledge", "review", "stats"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export function normalizeSettings(raw: unknown): WorkbenchSettings {
  const source = isRecord(raw) ? raw : {};
  const staleDays = Math.max(1, Math.floor(finiteNumber(source["staleDays"], DEFAULT_SETTINGS.staleDays)));
  const intervals = Array.isArray(source["reviewIntervals"])
    ? source["reviewIntervals"].filter(
        (item): item is number => typeof item === "number" && item > 0,
      )
    : [];
  const speechRate = Math.min(3, Math.max(0.5, finiteNumber(source["speechRate"], DEFAULT_SETTINGS.speechRate)));
  return {
    staleDays,
    reviewIntervals: intervals.length ? intervals : [...DEFAULT_SETTINGS.reviewIntervals],
    icsPath: nonEmptyString(source["icsPath"], DEFAULT_SETTINGS.icsPath),
    indexPath: nonEmptyString(source["indexPath"], DEFAULT_SETTINGS.indexPath),
    speechRate,
    speechPreferChineseVoice:
      typeof source["speechPreferChineseVoice"] === "boolean"
        ? source["speechPreferChineseVoice"]
        : DEFAULT_SETTINGS.speechPreferChineseVoice,
    speechAutoResume:
      typeof source["speechAutoResume"] === "boolean"
        ? source["speechAutoResume"]
        : DEFAULT_SETTINGS.speechAutoResume,
    writeSummaryToFrontmatter:
      typeof source["writeSummaryToFrontmatter"] === "boolean"
        ? source["writeSummaryToFrontmatter"]
        : DEFAULT_SETTINGS.writeSummaryToFrontmatter,
    classifyBy: source["classifyBy"] === "folder" ? "folder" : "tag",
    writeReviewToFrontmatter:
      typeof source["writeReviewToFrontmatter"] === "boolean"
        ? source["writeReviewToFrontmatter"]
        : DEFAULT_SETTINGS.writeReviewToFrontmatter,
    icsEnabled:
      typeof source["icsEnabled"] === "boolean"
        ? source["icsEnabled"]
        : DEFAULT_SETTINGS.icsEnabled,
  };
}

function normalizeRead(raw: unknown): Record<string, ReadProgress> {
  if (!isRecord(raw)) return {};
  const result: Record<string, ReadProgress> = {};
  for (const [path, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    result[path] = {
      idx: Math.max(0, Math.floor(finiteNumber(value["idx"], 0))),
      total: Math.max(0, Math.floor(finiteNumber(value["total"], 0))),
      at: finiteNumber(value["at"], Date.now()),
    };
  }
  return result;
}

function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: HistoryEntry[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value["path"] !== "string") continue;
    const path = value["path"];
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push({
      path,
      title: typeof value["title"] === "string" ? value["title"] : path,
      at: finiteNumber(value["at"], 0),
    });
  }
  // 先按时间排序再裁剪，避免旧数据顺序错乱时丢掉最新的 20 篇。
  return result.sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
}

/** 合并 loadData() 结果：兼容缺字段、脏值、旧结构，始终返回可用的 PluginData。 */
export function normalizeData(raw: unknown): PluginData {
  const base = defaultData();
  if (!isRecord(raw)) return base;
  const view = isRecord(raw["view"]) ? raw["view"] : {};
  const note = isRecord(view["note"]) ? view["note"] : null;
  const tab = view["tab"];
  return {
    version: DATA_VERSION,
    view: {
      day:
        typeof view["day"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(view["day"])
          ? view["day"]
          : base.view.day,
      tab: TABS.includes(tab as WorkbenchTab) ? (tab as WorkbenchTab) : base.view.tab,
      scrollY: Math.max(0, finiteNumber(view["scrollY"], 0)),
      lastModal: typeof view["lastModal"] === "string" ? view["lastModal"] : null,
      note:
        note && typeof note["path"] === "string"
          ? {
              path: note["path"],
              title: typeof note["title"] === "string" ? note["title"] : note["path"],
            }
          : null,
      tabDetail: isRecord(view["tabDetail"]) ? view["tabDetail"] : {},
      mdView: typeof view["mdView"] === "boolean" ? view["mdView"] : false,
    },
    read: normalizeRead(raw["read"]),
    history: normalizeHistory(raw["history"]),
    todayFolded:
      typeof raw["todayFolded"] === "boolean" ? raw["todayFolded"] : false,
    settings: normalizeSettings(raw["settings"]),
  };
}

/** 最新在前、按 path 去重、保留 20 篇上限。 */
export function pushHistory(
  history: HistoryEntry[],
  entry: HistoryEntry,
  limit = HISTORY_LIMIT,
): HistoryEntry[] {
  const merged = [entry, ...history.filter((item) => item.path !== entry.path)];
  const deduped = merged
    .sort((a, b) => b.at - a.at)
    .filter((item, index, list) => list.findIndex((x) => x.path === item.path) === index);
  return deduped.slice(0, Math.max(1, limit));
}

/** 重命名时迁移所有以 path 为 key 的状态，避免朗读断点与浏览历史失效。 */
export function migratePaths(
  data: PluginData,
  oldPath: string,
  newPath: string,
  newTitle?: string,
): PluginData {
  if (!oldPath || !newPath || oldPath === newPath) return data;
  const read = { ...data.read };
  if (Object.prototype.hasOwnProperty.call(read, oldPath)) {
    read[newPath] = read[oldPath];
    delete read[oldPath];
  }
  const history = data.history.map((item) =>
    item.path === oldPath
      ? { ...item, path: newPath, title: newTitle ?? item.title }
      : item,
  );
  const view = { ...data.view };
  if (view.note?.path === oldPath) {
    view.note = { path: newPath, title: newTitle ?? view.note.title };
  }
  if (view.lastModal === oldPath) view.lastModal = newPath;
  return { ...data, read, history, view };
}
