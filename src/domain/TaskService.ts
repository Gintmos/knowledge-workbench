import type {
  NoteRecord,
  TodayItem,
  TodayKind,
  TodaySummary,
  WorkbenchSettings,
} from "../types";

const DONE_STATUS = new Set([
  "done",
  "completed",
  "complete",
  "finished",
  "closed",
  "cancelled",
  "canceled",
  "archived",
  "完成",
  "已完成",
  "已处理",
  "归档",
  "取消",
]);

const KIND_ORDER: Record<TodayKind, number> = {
  overdue: 0,
  due: 1,
  followup: 2,
  review: 3,
  todo: 4,
};

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function todayString(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function dateFromTimestamp(ms: number): string {
  return todayString(new Date(ms));
}

/** 兼容 yyyy-mm-dd / yyyy.mm.dd / yyyy/mm/dd 与 ISO datetime 的前 10 位。 */
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function utcOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  return new Date(utcOf(date) + days * 86_400_000).toISOString().slice(0, 10);
}

export function isDone(status: string | null): boolean {
  return status !== null && DONE_STATUS.has(status.trim().toLowerCase());
}

export function collectDue(notes: NoteRecord[], today: string): TodayItem[] {
  const items: TodayItem[] = [];
  for (const note of notes) {
    const due = normalizeDate(note.due);
    if (!due || due > today || isDone(note.status)) continue;
    const days = daysBetween(due, today);
    items.push({
      path: note.path,
      title: note.title,
      kind: days > 0 ? "overdue" : "due",
      date: due,
      days,
      detail: days > 0 ? `逾期 ${days} 天（原定 ${due}）` : "今日到期",
    });
  }
  return items;
}

export function collectReview(notes: NoteRecord[], today: string): TodayItem[] {
  const items: TodayItem[] = [];
  for (const note of notes) {
    const review = normalizeDate(note.review);
    if (!review || review > today) continue;
    const days = daysBetween(review, today);
    const round = Math.max(0, note.reviewStage ?? 0) + 1;
    const overdue = days > 0 ? `，已逾期 ${days} 天` : "";
    items.push({
      path: note.path,
      title: note.title,
      kind: "review",
      date: review,
      days,
      detail: `艾宾浩斯第 ${round} 轮 · 到期 ${review}${overdue}`,
    });
  }
  return items;
}

const SOURCE_LABEL: Record<string, string> = {
  due: "@due 指定",
  every: "@every 循环",
  frontmatter: "笔记字段",
  "period-word": "周期词推断",
  none: "未设日期",
};

/** 任务级收集：下次到期 < 今天 → 催办；到期 >= 今天或无日期 → 待办。 */
function collectTasks(
  notes: NoteRecord[],
  today: string,
): { followup: TodayItem[]; todo: TodayItem[] } {
  const followup: TodayItem[] = [];
  const todo: TodayItem[] = [];
  for (const note of notes) {
    for (const task of note.tasks ?? []) {
      const base: TodayItem = {
        path: note.path,
        title: task.text,
        kind: "todo",
        date: task.due,
        days: task.due ? daysBetween(task.due, today) : 0,
        detail: "",
        task: {
          text: task.text,
          line: task.line,
          periodDays: task.periodDays,
          source: task.source,
        },
      };
      if (task.due && task.due < today) {
        followup.push({
          ...base,
          kind: "followup",
          days: daysBetween(task.due, today),
          detail: `逾期 ${daysBetween(task.due, today)} 天（原定 ${task.due}） · ${note.title} · ${SOURCE_LABEL[task.source] ?? task.source}`,
        });
      } else if (task.due) {
        todo.push({
          ...base,
          kind: "todo",
          detail: `${task.due === today ? "今日" : `下次 ${task.due}`} · ${note.title} · ${SOURCE_LABEL[task.source] ?? task.source}`,
        });
      } else {
        todo.push({
          ...base,
          kind: "todo",
          date: null,
          days: 0,
          detail: `未设日期 · ${note.title} · 补全 @due(日期) 或 @every(周期) 可加入日历`,
        });
      }
    }
  }
  return { followup, todo };
}

export function collectFollowup(notes: NoteRecord[], today: string): TodayItem[] {
  return collectTasks(notes, today).followup;
}

export function collectTodo(notes: NoteRecord[], today: string): TodayItem[] {
  return collectTasks(notes, today).todo;
}

function sortItems(items: TodayItem[]): TodayItem[] {
  return items.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      b.days - a.days ||
      cmp(a.date ?? "", b.date ?? "") ||
      cmp(a.path, b.path),
  );
}

export function buildToday(
  notes: NoteRecord[],
  today: string,
  _settings: WorkbenchSettings,
): TodaySummary {
  const dueAll = collectDue(notes, today);
  const overdue = sortItems(dueAll.filter((item) => item.kind === "overdue"));
  const due = sortItems(dueAll.filter((item) => item.kind === "due"));
  const review = sortItems(collectReview(notes, today));
  const collected = collectTasks(notes, today);
  const followup = sortItems(collected.followup);
  const todo = sortItems(collected.todo);
  const items = sortItems([...overdue, ...due, ...followup, ...review, ...todo]);
  return {
    day: today,
    items,
    overdue,
    due,
    followup,
    todo,
    review,
    total: items.length,
  };
}
