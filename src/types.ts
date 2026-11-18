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
/** 旧版「Top 10 + 其他」语义保留给有限图表；统计卡片使用全量列表 + 横向条形。 */
export const CHART_LIMIT = 10;
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
  /** 1.0.7：朗读引擎。system=系统语音；piper=库内 Piper WASM 本地模型。 */
  speechEngine: "system" | "piper";
  /** 1.0.7：Piper 模型与运行时文件所在库内目录。 */
  piperModelDir: string;
  /** 1.0.7：Piper 音色 ID；当前仅提供 zh_CN-huayan-medium。 */
  piperVoiceId: string;
  /** v1.0.6：是否根据任务描述中的中文周期词推断下次到期（默认开）。 */
  taskAutoInfer: boolean;
  /** v1.0.2 起云端神经 TTS 已搁置：仅保留字段兼容旧 data.json，运行时不接线。 */
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
  /** v1.0.6：从正文解析出的未完成任务；可由 vault 重建，不承担用户状态。 */
  tasks: TaskItem[];
}

/** 单条正文任务（催办 / 待办的数据源）。 */
export interface TaskItem {
  /** 任务正文（去掉 - [ ] 与周期标记后的可读文本）。 */
  text: string;
  /** 推算出的下次到期日 yyyy-mm-dd；无日期任务为 null（只显示待办、不进日历）。 */
  due: string | null;
  /** 循环周期天数；null 表示一次性任务。 */
  periodDays: number | null;
  /** 判定依据来源，便于界面核对。 */
  source: "due" | "every" | "frontmatter" | "period-word" | "none";
  /** 任务所在行号（从 0 起），用于就地勾选与 .ics 稳定 uid。 */
  line: number;
}

/** 写入 vault 内 index.json 的快照，可随用户既有同步方案跨端。 */
export interface IndexSnapshot {
  version: number;
  algo: number;
  generatedAt: number;
  /** v1.0.6：tasks 是基于哪一天解析的；跨天或 mtime 变化才重解析正文任务。 */
  taskDay?: string;
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

export type TodayKind =
  | "overdue"
  | "due"
  | "review"
  | "followup"
  | "todo";

export interface TodayItem {
  path: string;
  title: string;
  kind: TodayKind;
  /** 原始日期（due / review / 任务下次到期），统一 yyyy-mm-dd。 */
  date: string | null;
  /** 逾期天数。 */
  days: number;
  detail: string;
  /** v1.0.6：任务级条目附带的信息；笔记级条目为 undefined。 */
  task?: {
    text: string;
    line: number;
    periodDays: number | null;
    source: TaskItem["source"];
  };
}

export interface TodaySummary {
  day: string;
  items: TodayItem[];
  overdue: TodayItem[];
  due: TodayItem[];
  followup: TodayItem[];
  todo: TodayItem[];
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
  /** v1.0.6：原过时阈值 90 改为催办默认周期 30 天。 */
  staleDays: 30,
  reviewIntervals: [1, 3, 7, 15, 30],
  icsPath: "知识管理工作台/提醒.ics",
  indexPath: INDEX_PATH_DEFAULT,
  speechRate: 1,
  speechPreferChineseVoice: true,
  speechAutoResume: false,
  speechProsody: true,
  speechVoiceName: "",
  speechPauseMs: 420,
  speechEngine: "system",
  piperModelDir: "知识管理工作台/tts",
  piperVoiceId: "zh_CN-huayan-medium",
  taskAutoInfer: true,
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
