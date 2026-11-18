import type { TaskItem } from "../types";
import { addDays, daysBetween, normalizeDate } from "./TaskService";

/**
 * 纯函数层：从笔记正文解析未完成的任务，推算下次到期日。
 * 不 import obsidian，输入最小结构，便于 node 单测。
 *
 * 三级优先级（命中即停）：
 *   1) 行内标记 @due(YYYY-MM-DD)：一次性任务，到期即催办；
 *   2) 行内标记 @every(7d|weekly|每月…)：循环任务，从锚点按周期推进到 <= 今天的最近周期点；
 *   3) 中文周期词（每天/每周/每月/每季度/每年）：按周期推断，锚点取 frontmatter follow-up 或笔记 updated/created；
 *   4) 无任何日期：due=null，只显示为待办、不进日历。
 */

/** 中文周期词 → 天数（保守：每月按 30 天、每季度按 90 天、每年按 365 天）。 */
const PERIOD_WORDS: Array<[RegExp, number]> = [
  [/每天|每日|daily/i, 1],
  [/每周|每星期|weekly/i, 7],
  [/每月|monthly/i, 30],
  [/每季度|每季|quarterly/i, 90],
  [/每年|年度|yearly|annually/i, 365],
];

/** 英文周期别名。 */
const PERIOD_ALIAS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
  annually: 365,
};

const TASK_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;

function toNumber(text: string): number | null {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** 解析 @every(...) 内容为天数；支持 Nd / Nw / Nm / Ny 与英文、中文别名。 */
function parseEvery(content: string): number | null {
  const text = content.trim();
  const unit = text.match(/^(\d+)\s*([dwmNy年周月天日])$/i);
  if (unit) {
    const n = toNumber(unit[1]);
    if (n === null) return null;
    const u = unit[2].toLowerCase();
    if (u === "d" || u === "天" || u === "日") return n;
    if (u === "w" || u === "周") return n * 7;
    if (u === "m" || u === "月") return n * 30;
    if (u === "y" || u === "年") return n * 365;
  }
  const nOnly = text.match(/^(\d+)d?$/i);
  if (nOnly) return toNumber(nOnly[1]);
  if (PERIOD_ALIAS[text.toLowerCase()]) return PERIOD_ALIAS[text.toLowerCase()];
  for (const [re, days] of PERIOD_WORDS) {
    if (re.test(text)) return days;
  }
  return null;
}

/** 从文本里去掉周期/日期标记，得到干净的可读任务描述。 */
function cleanText(text: string): string {
  return text
    .replace(/@due\s*[（(][^)）]*[)）]/gi, "")
    .replace(/@every\s*[（(][^)）]*[)）]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 把锚点按周期推进到 <= today 的最近周期点（一次性任务直接返回锚点）。 */
function advance(anchor: string, periodDays: number | null, today: string): string {
  if (periodDays === null) return anchor;
  if (anchor > today) return anchor;
  const elapsed = daysBetween(anchor, today);
  if (elapsed < periodDays) return anchor;
  const steps = Math.floor(elapsed / periodDays);
  return addDays(anchor, steps * periodDays);
}

export interface ParseTasksOptions {
  /** 笔记正文。 */
  body: string;
  /** frontmatter（可含 follow-up / follow-up-every 与 created / updated）。 */
  frontmatter: Record<string, unknown> | null;
  /** 今天 yyyy-mm-dd。 */
  today: string;
  /** 是否根据中文周期词自动推断（对应设置项，默认 true）。 */
  autoInfer: boolean;
}

function fmText(
  fm: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!fm) return null;
  for (const key of keys) {
    const value = fm[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * 解析正文里所有未完成的 `- [ ]` 任务。已完成（`- [x]`）不进入清单。
 * 返回按出现顺序排列、带下次到期日与判定来源的任务列表。
 */
export function parseTasks(options: ParseTasksOptions): TaskItem[] {
  const { body, frontmatter, today, autoInfer } = options;
  const tasks: TaskItem[] = [];

  // frontmatter 兜底周期（整篇任务共享一个锚点与周期）。
  const fmFollow = normalizeDate(fmText(frontmatter, ["follow-up", "followup", "kw-follow-up"]));
  const fmEveryText = fmText(frontmatter, ["follow-up-every", "followup-every", "kw-follow-up-every"]);
  const fmEvery = fmEveryText ? parseEvery(fmEveryText) : null;
  const noteAnchor =
    normalizeDate(fmText(frontmatter, ["created", "date"])) ??
    normalizeDate(fmText(frontmatter, ["updated"])) ??
    today;

  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = TASK_LINE.exec(lines[index]);
    if (!match || match[1].toLowerCase() === "x") continue;
    const raw = match[2] ?? "";
    const text = cleanText(raw);
    if (!text) continue;

    let due: string | null = null;
    let periodDays: number | null = null;
    let source: TaskItem["source"] = "none";

    const dueMark = raw.match(/@due\s*[（(]([^)）]*)[)）]/i);
    const everyMark = raw.match(/@every\s*[（(]([^)）]*)[)）]/i);

    if (dueMark) {
      due = normalizeDate(dueMark[1]);
      source = "due";
    } else if (everyMark) {
      periodDays = parseEvery(everyMark[1]);
      if (periodDays !== null) {
        due = advance(noteAnchor, periodDays, today);
        source = "every";
      }
    } else if (fmFollow) {
      periodDays = fmEvery;
      due = advance(fmFollow, periodDays, today);
      source = "frontmatter";
    } else if (autoInfer) {
      for (const [re, days] of PERIOD_WORDS) {
        if (re.test(text)) {
          periodDays = days;
          due = advance(noteAnchor, days, today);
          source = "period-word";
          break;
        }
      }
    }

    tasks.push({ text, due, periodDays, source, line: index });
  }
  return tasks;
}
