export const PLUGIN_ID = "knowledge-workbench";
export const VIEW_TYPE_WORKBENCH = "knowledge-workbench-view";

/** PluginData 结构版本；结构升级时递增，normalizeData 负责兼容旧数据。 */
export const DATA_VERSION = 1;
/** index.json 结构版本。P3 新增可选字段，保持 1 以免旧快照被判为损坏。 */
export const INDEX_VERSION = 1;
/**
 * 摘要算法版本：1 = P2（frontmatter + 文件名/H1 兜底）；
 * 2 = P3（插入正文首个有效段落解析）。索引按 algo 变化触发重算。
 */
export const SUMMARY_ALGO = 2;
export const HISTORY_LIMIT = 20;
/** 旧版「Top 10 + 其他」语义保留给有限图表；新版统计卡片使用全量柱状图。 */
export const CHART_LIMIT = 10;
/** 全量柱状图每根柱子的最小槽宽（px），超出容器宽度时横向滚动。 */
export const CHART_MIN_SLOT = 62;
/** 防御上限：极端库只画前 200 根柱子，列表仍是全量。 */
export const CHART_MAX_BARS = 200;
export const SUMMARY_LIMIT = 120;
export const INDEX_PATH_DEFAULT = "知识管理工作台/index.json";

export type WorkbenchTab = "today" | "review" | "stats" | "history";
export type ClassifyBy = "tag" | "folder";

export interface ReadProgress {
  idx: number;
  total: number;
  at: number;
}

export interface HistoryEntry {
  path: string;
  title: string;
  at: number;
}

export interface ViewState {
  day: string;
  tab: WorkbenchTab;
  scrollY: number;
  lastModal: string | null;
  note: { path: string; title: string } | null;
  tabDetail: Record<string, unknown>;
  mdView: boolean;
}

export interface WorkbenchSettings {
  staleDays: number;
  reviewIntervals: number[];
  icsPath: string;
  indexPath: string;
  speechRate: number;
  /** P5 新增：中文音色优先、打开笔记弹窗时自动从断点续读（默认关闭，避免意外发声）。 */
  speechPreferChineseVoice: boolean;
  speechAutoResume: boolean;
  /** 规则式韵律（句群分块 / 停顿 / 动态 rate-pitch），离线与回退路径使用。 */
  speechProsody: boolean;
  /** 手动指定系统音色名；空串表示自动优选中文 / Natural 音色。 */
  speechVoiceName: string;
  /** 块间停顿上限（毫秒）；0 表示关闭，生产默认 420。 */
  speechPauseMs: number;
  /** 可选云端神经 TTS：默认全部关闭，需用户显式开启并填写自有的服务地址与密钥。 */
  cloudTtsEnabled: boolean;
  cloudTtsUrl: string;
  cloudTtsKey: string;
  cloudTtsModel: string;
  cloudTtsVoice: string;
  cloudTtsStyle: string;
  writeSummaryToFrontmatter: boolean;
  /** P3 新增：分类维度、复习日期写回开关、.ics 总开关。 */
  classifyBy: ClassifyBy;
  writeReviewToFrontmatter: boolean;
  icsEnabled: boolean;
}

export interface PluginData {
  version: number;
  view: ViewState;
  read: Record<string, ReadProgress>;
  history: HistoryEntry[];
  todayFolded: boolean;
  settings: WorkbenchSettings;
}

/** 单篇笔记的派生索引记录；全部字段可由 vault 重建，不承担用户状态。 */
export interface NoteRecord {
  path: string;
  mtime: number;
  size: number;
  title: string;
  tags: string[];
  links: string[];
  summary: string;
  due: string | null;
  status: string | null;
  updated: string | null;
  review: string | null;
  /** P3 复习排期：stage 决定下一次间隔；interval / ease 预留给 SM-2。 */
  reviewStage: number;
  interval: number | null;
  ease: number | null;
}

/** 写入 vault 内 index.json 的快照，可随用户既有同步方案跨端。 */
export interface IndexSnapshot {
  version: number;
  algo: number;
  generatedAt: number;
  notes: Record<string, NoteRecord>;
}

/** 相对上次磁盘快照的只读差异，不做任何恢复动作。 */
export interface IndexDiff {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: number;
  initial: boolean;
}

export type IndexPhase = "idle" | "scanning" | "ready" | "error";

export interface IndexStatus {
  phase: IndexPhase;
  total: number;
  indexed: number;
  durationMs: number;
  yields: number;
  cacheMisses: number;
  diff: IndexDiff | null;
  error: string | null;
  indexPath: string;
  lastWriteAt: number | null;
}

export type TodayKind = "overdue" | "due" | "stale" | "review";

export interface TodayItem {
  path: string;
  title: string;
  kind: TodayKind;
  /** 原始日期（due / review / updated），统一 yyyy-mm-dd。 */
  date: string | null;
  /** 逾期天数或过时天数。 */
  days: number;
  detail: string;
}

export interface TodaySummary {
  day: string;
  items: TodayItem[];
  overdue: TodayItem[];
  due: TodayItem[];
  stale: TodayItem[];
  review: TodayItem[];
  total: number;
}

export interface CategoryCount {
  key: string;
  count: number;
}

/** 柱状图切片：保留可点击的笔记路径；全量图表不再归并「其他」。 */
export interface ChartSlice {
  key: string;
  count: number;
  paths: string[];
}

export interface IcsEvent {
  uid: string;
  date: string;
  summary: string;
  description: string;
  path: string;
  kind: TodayKind;
}

export interface IcsState {
  enabled: boolean;
  mobile: boolean;
  events: number;
  path: string;
  lastWriteAt: number | null;
  error: string | null;
}

export interface DomainSnapshot {
  generatedAt: number;
  noteCount: number;
  today: TodaySummary;
  /** 全量分类计数，逐篇统计不设上限（v9 语义）。 */
  categories: CategoryCount[];
  /** 全量主分类柱状图切片（所有类别，横向滚动查看）。 */
  chart: ChartSlice[];
  /** 「标签 / 文件夹」卡片的柱状图切片，key 为列表中的显示名。 */
  detailChart: ChartSlice[];
  tagCounts: CategoryCount[];
  folderCounts: CategoryCount[];
  ics: IcsState;
}

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  staleDays: 90,
  reviewIntervals: [1, 3, 7, 15, 30],
  icsPath: "知识管理工作台/提醒.ics",
  indexPath: INDEX_PATH_DEFAULT,
  speechRate: 1,
  speechPreferChineseVoice: true,
  speechAutoResume: false,
  speechProsody: true,
  speechVoiceName: "",
  speechPauseMs: 420,
  cloudTtsEnabled: false,
  cloudTtsUrl: "",
  cloudTtsKey: "",
  cloudTtsModel: "gpt-4o-mini-tts",
  cloudTtsVoice: "alloy",
  cloudTtsStyle: "用自然、平和的普通话朗读，按语义断句，疑问句尾音上扬，长句适当停顿，不要机械地逐字念。",
  writeSummaryToFrontmatter: false,
  classifyBy: "tag",
  writeReviewToFrontmatter: false,
  icsEnabled: true,
};

export function defaultData(): PluginData {
  return {
    version: DATA_VERSION,
    view: {
      day: new Date().toISOString().slice(0, 10),
      tab: "today",
      scrollY: 0,
      lastModal: null,
      note: null,
      tabDetail: {},
      mdView: false,
    },
    read: {},
    history: [],
    todayFolded: false,
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function emptyStatus(indexPath: string): IndexStatus {
  return {
    phase: "idle",
    total: 0,
    indexed: 0,
    durationMs: 0,
    yields: 0,
    cacheMisses: 0,
    diff: null,
    error: null,
    indexPath,
    lastWriteAt: null,
  };
}
