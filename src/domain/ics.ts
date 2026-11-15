import type { IcsEvent, TodayItem, TodayKind } from "../types";
import { normalizeDate } from "./TaskService";

const KIND_PREFIX: Record<TodayKind, string> = {
  overdue: "逾期待办",
  due: "今日待办",
  review: "复习",
  stale: "知识更新",
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
}): string {
  return `kw-${hashKey(`${item.path}|${item.kind}|${item.date}`)}@local`;
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
 * 逾期项把 DTSTART 设为今天（否则系统日历不会再提醒），
 * 原定日期与逾期天数保留在 DESCRIPTION 中；其余用原始日期。
 */
export function buildIcsEvents(items: TodayItem[], today: string): IcsEvent[] {
  const events = new Map<string, IcsEvent>();
  for (const item of items) {
    const source = item.date && item.date >= today ? item.date : today;
    const date = toIcsDate(source);
    if (!date) continue;
    const { path, kind } = item;
    const uid = eventUid({ path, kind, date });
    if (events.has(uid)) continue;
    const summary = `${KIND_PREFIX[kind]} · ${item.title || path}`;
    const original =
      item.date && item.date !== source ? ` · 原定 ${item.date}` : "";
    const description = `vault 内路径：${path}${original}${
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
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${event.date}`,
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
