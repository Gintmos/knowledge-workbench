import type { IcsEvent, TodayItem, TodayKind } from "../types";
import { normalizeDate } from "./TaskService";

const KIND_PREFIX: Record<TodayKind, string> = {
  overdue: "逾期待办",
  due: "今日待办",
  review: "复习",
  followup: "催办",
  todo: "待办",
};

/** FNV-1a 32 位哈希，按 UTF-16 双字节混合以避免中文路径碰撞；无 crypto / Node 依赖。 */
export function hashKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    hash = Math.imul(hash ^ ((unit >>> 8) & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (unit & 0xff), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function eventUid(item: {
  path: string;
  kind: TodayKind;
  date: string;
  /** 任务级条目的行号，纳入哈希避免同篇多条任务互相覆盖。 */
  line?: number;
}): string {
  const line = item.line === undefined ? "" : `#${item.line}`;
  return `kw-${hashKey(`${item.path}${line}|${item.kind}|${item.date}`)}@local`;
}

export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export function utf8Length(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code <= 0xffff) return 3;
  return 4;
}

/** RFC 5545 折行：每行 ≤75 octets，续行以一个空格开头，且不切断多字节字符。 */
export function foldIcsLine(line: string, limit = 75): string[] {
  if (!line) return [""];
  const result: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = utf8Length(ch);
    if (bytes + size > limit && current) {
      result.push(current);
      current = ` ${ch}`;
      bytes = 1 + size;
    } else {
      current += ch;
      bytes += size;
    }
  }
  if (current) result.push(current);
  return result;
}

export function utcStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}Z`
  );
}

export function toIcsDate(date: string): string {
  return (normalizeDate(date) ?? "").replace(/-/g, "");
}

/**
 * 全天事件的 DTEND 必须是「次日」且为排他结束值。
 * Outlook / Microsoft Graph 对缺失 DTEND 或 DURATION 的 VEVENT 会直接拒绝解析。
 */
export function nextIcsDate(date: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  if (!match) return date;
  const day = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  day.setUTCDate(day.getUTCDate() + 1);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}`;
}

/**
 * 逾期项把 DTSTART 设为今天（否则系统日历不会再提醒），
 * 原定日期与逾期天数保留在 DESCRIPTION 中；其余用原始日期。
 */
export function buildIcsEvents(items: TodayItem[], today: string): IcsEvent[] {
  const events = new Map<string, IcsEvent>();
  for (const item of items) {
    // 无日期的待办不进日历：系统日历无法为无到期日的任务定位。
    if (!item.date) continue;
    const source = item.date >= today ? item.date : today;
    const date = toIcsDate(source);
    if (!date) continue;
    const { path, kind, task } = item;
    const uid = eventUid({ path, kind, date, line: task?.line });
    if (events.has(uid)) continue;
    const label = task?.text || item.title || path;
    const summary = `${KIND_PREFIX[kind]} · ${label}`;
    const original =
      item.date !== source ? ` · 原定 ${item.date}` : "";
    const owner = task ? ` · 所属笔记：${item.title}` : "";
    const description = `vault 内路径：${path}${original}${owner}${
      item.detail ? ` · ${item.detail}` : ""
    }`;
    events.set(uid, { uid, date, summary, description, path, kind });
  }
  return [...events.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.uid < b.uid ? -1 : 1,
  );
}

export function renderIcs(events: IcsEvent[], generatedAt = new Date()): string {
  const stamp = utcStamp(generatedAt);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//knowledge-workbench//zh-CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:知识管理工作台提醒",
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      "SEQUENCE:0",
      "STATUS:CONFIRMED",
      `DTSTART;VALUE=DATE:${event.date}`,
      `DTEND;VALUE=DATE:${nextIcsDate(event.date)}`,
      "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE",
      "X-MICROSOFT-CDO-BUSYSTATUS:FREE",
      `SUMMARY:${escapeIcsText(event.summary)}`,
      `DESCRIPTION:${escapeIcsText(event.description)}`,
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "TRIGGER:-P1D",
      "ACTION:DISPLAY",
      "DESCRIPTION:明日待处理",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.flatMap((line) => foldIcsLine(line)).join("\r\n")}\r\n`;
}
