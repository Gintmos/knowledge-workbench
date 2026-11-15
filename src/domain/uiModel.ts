import {
  CHART_MAX_BARS,
  CHART_MIN_SLOT,
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
  today: "今日要处理",
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
  return `今日要处理 · ${day}`;
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

export interface ChartOptions {
  width?: number;
  height?: number;
  /** 全量模式下每根柱子的最小槽宽；总宽超过容器时由 CSS 横向滚动。 */
  minSlot?: number;
  /** 防御上限，避免极端库生成超大 SVG。 */
  maxBars?: number;
  padX?: number;
  padTop?: number;
  padBottom?: number;
  gap?: number;
  /** 单个中文字符的估算宽度，用于保证相邻标签不重叠。 */
  charWidth?: number;
}

export interface BarGeometry {
  key: string;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  label: string;
  labelY: number;
  valueY: number;
}

export interface ChartGeometry {
  width: number;
  height: number;
  plotBottom: number;
  max: number;
  slot: number;
  bars: BarGeometry[];
  totalSlices: number;
  truncated: boolean;
}

/** 标签按可用槽宽截断，末尾用省略号，绝不与相邻柱子标签重叠。 */
export function truncateLabel(key: string, maxChars: number): string {
  const chars = [...key];
  if (chars.length <= maxChars) return key;
  if (maxChars <= 1) return chars[0] ?? "";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

/**
 * 全量柱状图的几何计算（纯函数，不接触 DOM）。
 * 所有分类都出柱；宽度按 minSlot × 类别数扩展，由外层容器横向滚动查看。
 * 文字不重叠的保证：每个标签的估算宽度 ≤ slot - gap，且标签中心间距 = slot。
 */
export function chartGeometry(
  slices: ChartSlice[],
  options: ChartOptions = {},
): ChartGeometry {
  const height = Math.max(100, options.height ?? 190);
  const padX = options.padX ?? 12;
  const padTop = options.padTop ?? 26;
  const padBottom = options.padBottom ?? 42;
  const gap = options.gap ?? 8;
  const charWidth = options.charWidth ?? 9;
  const minSlot = Math.max(24, options.minSlot ?? CHART_MIN_SLOT);
  const maxBars = Math.max(1, options.maxBars ?? CHART_MAX_BARS);

  const limited = slices.slice(0, maxBars);
  const count = Math.max(1, limited.length);
  const width = Math.max(
    120,
    options.width ?? 320,
    limited.length * minSlot + padX * 2,
  );
  const plotBottom = height - padBottom;
  const plotHeight = Math.max(1, plotBottom - padTop);
  const plotWidth = Math.max(1, width - padX * 2);
  const slot = plotWidth / count;
  const max = Math.max(1, ...limited.map((slice) => slice.count));
  const barWidth = Math.max(4, Math.min(28, slot - gap));
  const maxChars = Math.max(2, Math.floor((slot - gap) / charWidth));

  const bars = limited.map((slice, index) => {
    const barHeight = Math.max(2, (slice.count / max) * plotHeight);
    const x = padX + index * slot + (slot - barWidth) / 2;
    const y = plotBottom - barHeight;
    return {
      key: slice.key,
      count: slice.count,
      x,
      y,
      width: barWidth,
      height: barHeight,
      centerX: x + barWidth / 2,
      label: truncateLabel(slice.key, maxChars),
      labelY: Math.min(height - 4, plotBottom + 15),
      valueY: Math.max(padTop - 6, y - 5),
    };
  });

  return {
    width,
    height,
    plotBottom,
    max,
    slot,
    bars,
    totalSlices: slices.length,
    truncated: slices.length > limited.length,
  };
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
