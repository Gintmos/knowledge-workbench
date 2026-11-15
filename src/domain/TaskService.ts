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
  review: 2,
  stale: 3,
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
    items.push({
      path: note.path,
      title: note.title,
      kind: "review",
      date: review,
      days,
      detail: days > 0 ? `复习已到期 ${days} 天（${review}）` : `复习到期（${review}）`,
    });
  }
  return items;
}

/** updated 优先，缺省回退到 file.stat.mtime 对应的本地日期。 */
export function staleBaseDate(note: NoteRecord): string {
  return normalizeDate(note.updated) ?? dateFromTimestamp(note.mtime);
}

export function collectStale(
  notes: NoteRecord[],
  today: string,
  staleDays: number,
): TodayItem[] {
  const items: TodayItem[] = [];
  for (const note of notes) {
    const base = staleBaseDate(note);
    const days = daysBetween(base, today);
    if (days <= staleDays) continue;
    items.push({
      path: note.path,
      title: note.title,
      kind: "stale",
      date: base,
      days,
      detail: `距上次更新 ${days} 天（阈值 ${staleDays} 天）`,
    });
  }
  return items;
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
  settings: WorkbenchSettings,
): TodaySummary {
  const dueAll = collectDue(notes, today);
  const overdue = sortItems(dueAll.filter((item) => item.kind === "overdue"));
  const due = sortItems(dueAll.filter((item) => item.kind === "due"));
  const stale = sortItems(collectStale(notes, today, settings.staleDays));
  const review = sortItems(collectReview(notes, today));
  const items = sortItems([...overdue, ...due, ...review, ...stale]);
  return { day: today, items, overdue, due, stale, review, total: items.length };
}
