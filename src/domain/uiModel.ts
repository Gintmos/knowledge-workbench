import {
  HISTORY_LIMIT,
  type ChartSlice,
  type HistoryEntry,
  type TodayItem,
  type TodayKind,
  type ViewState,
  type WorkbenchTab,
} from "../types";

/** 四个正式页签：知识库已取消，浏览历史独立成最右页签。 */
export const TAB_ORDER: WorkbenchTab[] = ["today", "review", "stats", "history"];

export const TAB_LABELS: Record<WorkbenchTab, string> = {
  today: "今日",
  review: "复习",
  stats: "统计",
  history: "浏览历史",
};

export const KIND_LABEL: Record<TodayKind, string> = {
  overdue: "逾期",
  due: "今日到期",
  review: "复习到期",
  stale: "过时提醒",
};

export function isTab(value: unknown): value is WorkbenchTab {
  return typeof value === "string" && (TAB_ORDER as string[]).includes(value);
}

/**
 * 今日卡片标题：折叠前后完全一致，且不附带「（X 项待处理）」之类的计数备注。
 * 计数只在展开后的分组里显示。
 */
export function todayCardTitle(day: string): string {
  return `今日 · ${day}`;
}

/** 按类型分组，用于展开后的分组清单；items 已由 TaskService 排好序。 */
export function groupToday(items: TodayItem[]): Array<[TodayKind, TodayItem[]]> {
  const order: TodayKind[] = ["overdue", "due", "review", "stale"];
  const groups = new Map<TodayKind, TodayItem[]>();
  for (const item of items) {
    const list = groups.get(item.kind) ?? [];
    list.push(item);
    groups.set(item.kind, list);
  }
  return order
    .filter((kind) => (groups.get(kind)?.length ?? 0) > 0)
    .map((kind) => [kind, groups.get(kind) ?? []]);
}

/** 浏览历史：最新在前、同一路径只留最近一条、最多 limit 条。 */
export function sortHistory(
  entries: HistoryEntry[],
  limit = HISTORY_LIMIT,
): HistoryEntry[] {
  const seen = new Set<string>();
  const result: HistoryEntry[] = [];
  const sorted = [...entries].sort(
    (a, b) => b.at - a.at || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  for (const entry of sorted) {
    if (!entry.path || seen.has(entry.path)) continue;
    seen.add(entry.path);
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}

/** 当天恢复页签、滚动位置与分类筛选；跨天重置，避免把昨天的上下文带进今天。 */
export function restoreViewState(view: ViewState, today: string): ViewState {
  if (view.day === today) {
    return {
      ...view,
      tab: isTab(view.tab) ? view.tab : "today",
      scrollY: Number.isFinite(view.scrollY) ? Math.max(0, view.scrollY) : 0,
      tabDetail: normalizeTabDetail(view.tabDetail ?? {}),
    };
  }
  return {
    ...view,
    day: today,
    tab: "today",
    scrollY: 0,
    lastModal: null,
    note: null,
    tabDetail: {},
  };
}

/** 升级时清除旧「知识库」页签遗留的筛选值，避免坏死状态被恢复。 */
export function normalizeTabDetail(
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...detail };
  delete next["knowledgeCategory"];
  return next;
}

const CATEGORY_KEY = "statsCategory";
export type ChartScope = "category" | "detail";

export interface ChartSelection {
  scope: ChartScope;
  key: string;
}

/** 两张卡片的选中项共用一个持久化字段，用 scope 前缀区分。 */
export function encodeSelection(selection: ChartSelection): string {
  return `${selection.scope}::${selection.key}`;
}

export function decodeSelection(value: string | null): ChartSelection | null {
  if (!value) return null;
  const at = value.indexOf("::");
  if (at < 0) return null;
  const scope = value.slice(0, at);
  const key = value.slice(at + 2);
  if ((scope !== "category" && scope !== "detail") || !key) return null;
  return { scope, key };
}

export function readCategory(detail: Record<string, unknown>): string | null {
  const value = detail[CATEGORY_KEY];
  return typeof value === "string" && value ? value : null;
}

export function writeCategory(
  detail: Record<string, unknown>,
  key: string | null,
): Record<string, unknown> {
  const next = { ...detail };
  if (key) next[CATEGORY_KEY] = key;
  else delete next[CATEGORY_KEY];
  return next;
}

/** 按分类筛选笔记路径；空筛选返回 null 表示「不过滤」。 */
export function filterPaths(
  slices: ChartSlice[],
  key: string | null,
): Set<string> | null {
  if (!key) return null;
  const slice = slices.find((item) => item.key === key);
  return new Set(slice?.paths ?? []);
}

/**
 * 列表内横向条形图：宽度与该卡片内最大值成比例（纯函数，便于单测）。
 * v1.0.2 起统计卡片不再绘制上方纵向 SVG 柱状图，全部分类都在下半部分列表出条。
 * 非零计数至少给 3% 的可见宽度；非法值返回 0，不产生 NaN 样式。
 */
export function barWidthPercent(count: number, max: number): number {
  if (
    !Number.isFinite(count) ||
    count <= 0 ||
    !Number.isFinite(max) ||
    max <= 0
  ) {
    return 0;
  }
  const ratio = Math.min(1, count / max);
  return Math.max(3, Math.round(ratio * 1000) / 10);
}

/** 一组计数的基准最大值；空组返回 1，避免除零。 */
export function barRowsMax(counts: Array<{ count: number }>): number {
  return Math.max(1, ...counts.map((item) => item.count));
}

// ── P6：明细列表懒渲染 ────────────────────────────────────────
/** 首屏最多渲染的笔记行数；9999 篇库不会一次性创建数万个 DOM 节点。 */
export const DETAIL_PAGE_SIZE = 60;

export interface LazyPage<T> {
  visible: T[];
  loaded: number;
  total: number;
  hasMore: boolean;
}

/** 计算当前应展示的切片，纯函数便于单测。 */
export function lazyPage<T>(
  items: T[],
  loaded: number,
  pageSize: number = DETAIL_PAGE_SIZE,
): LazyPage<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const requested = Math.floor(loaded);
  // loaded 为 0 时按首屏一页计算，便于调用方直接取 lazyPage(items, 0)。
  const clamped = Math.min(items.length, Math.max(0, requested > 0 ? requested : size));
  return {
    visible: items.slice(0, clamped),
    loaded: clamped,
    total: items.length,
    hasMore: clamped < items.length,
  };
}

/** 追加下一页后的已加载条数；不会超过总数。 */
export function nextLoaded(
  loaded: number,
  total: number,
  pageSize: number = DETAIL_PAGE_SIZE,
): number {
  const size = Math.max(1, Math.floor(pageSize));
  return Math.min(Math.max(0, total), Math.max(0, Math.floor(loaded)) + size);
}

/** 明细区滚动到底部附近时触发追加；内容不足一屏时也应视为可追加。 */
export function shouldLoadMore(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 160,
): boolean {
  return (
    scrollHeight <= clientHeight + 1 ||
    scrollTop + clientHeight >= scrollHeight - Math.max(0, threshold)
  );
}
