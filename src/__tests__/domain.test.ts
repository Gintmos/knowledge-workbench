import assert from "node:assert/strict";
import test from "node:test";
import {
  chartSlices,
  countByCategory,
  folderCounts,
  folderOf,
  primaryCategory,
  tagCounts,
  topLevelTag,
} from "../domain/ClassifierService";
import {
  buildIcsEvents,
  escapeIcsText,
  eventUid,
  foldIcsLine,
  hashKey,
  renderIcs,
  toIcsDate,
  utf8Length,
  utcStamp,
} from "../domain/ics";
import {
  cleanMarkdownLine,
  firstMeaningfulParagraph,
  mdToPlainText,
  stripFrontmatter,
  toParagraphs,
} from "../domain/speechText";
import { shouldRecompute, summarize } from "../domain/SummaryService";
import { normalizeSettings } from "../domain/pluginData";
import {
  addDays,
  buildToday,
  collectDue,
  collectReview,
  collectStale,
  dateFromTimestamp,
  daysBetween,
  isDone,
  normalizeDate,
  staleBaseDate,
} from "../domain/TaskService";
import {
  nextInterval,
  nextReviewDate,
  planReview,
  startReview,
} from "../domain/ReviewService";
import {
  DEFAULT_SETTINGS,
  SUMMARY_ALGO,
  type NoteRecord,
  type TodayItem,
} from "../types";

const TODAY = "2026-11-15";

function note(path: string, patch: Partial<NoteRecord> = {}): NoteRecord {
  return {
    path,
    mtime: new Date(2026, 10, 1).getTime(),
    size: 100,
    title: path,
    tags: [],
    links: [],
    summary: path,
    due: null,
    status: null,
    updated: null,
    review: null,
    ...patch,
    reviewStage: patch.reviewStage ?? 0,
    interval: patch.interval ?? null,
    ease: patch.ease ?? null,
  };
}

// ── Markdown 清洗 ─────────────────────────────────────────────
test("清洗：frontmatter、表格分隔行、表格数据行、代码块围栏均被跳过", () => {
  assert.equal(stripFrontmatter("---\ntags: [x]\n---\n正文"), "正文");
  assert.equal(stripFrontmatter("正文\n---\n不是 frontmatter"), "正文\n---\n不是 frontmatter");
  assert.equal(cleanMarkdownLine("| :--- | --- |"), "");
  assert.equal(cleanMarkdownLine("| 数据 | 数据 |"), "");
  assert.equal(cleanMarkdownLine("```ts"), "");
  assert.equal(cleanMarkdownLine("---"), "");
});

test("清洗：emoji、Obsidian 标题锚点、#tag、wiki 别名、链接与行内代码", () => {
  const cleaned = cleanMarkdownLine(
    "> 🎯 目标：[[笔记#章节|别名]] 与 #项目/子 标签，参见 [链接](https://example.com) 和 `代码`",
  );
  assert.ok(cleaned.includes("别名"));
  assert.ok(cleaned.includes("链接"));
  assert.ok(cleaned.includes("代码"));
  assert.ok(!cleaned.includes("🎯"), "emoji 应被去除");
  assert.ok(!cleaned.includes("笔记#章节"), "标题锚点应被去除");
  assert.ok(!cleaned.includes("#项目"), "标签应被去除");
  assert.ok(!cleaned.includes("http"), "裸链接应被去除");
  assert.ok(!cleaned.startsWith(">"), "引用符应被去除");
});

test("清洗：段落切分与首个有效段落（跳过标题与太短的前导段）", () => {
  const md = [
    "---",
    "tags: [项目]",
    "---",
    "# 标题 🎯",
    "",
    "| 列 | 列 |",
    "| :--- | --- |",
    "| 数据 | 数据 |",
    "",
    "```js",
    "console.log('noise')",
    "```",
    "",
    "注：",
    "",
    "这是一段真正有效的正文，包含足够多的文字用于生成规则式摘要。",
    "下一段补充内容。",
  ].join("\n");
  const paragraphs = toParagraphs(md);
  assert.ok(paragraphs.length >= 2);
  assert.ok(!paragraphs.some((item) => item.includes(":---")));
  assert.ok(!paragraphs.some((item) => item.includes("console.log")));
  assert.match(firstMeaningfulParagraph(md), /真正有效的正文/);

  const plain = mdToPlainText(md);
  assert.ok(!plain.includes("🎯"));
  assert.ok(!plain.includes(":---"));
  assert.ok(!plain.includes("console.log"));
});

// ── 规则式摘要 ────────────────────────────────────────────────
test("摘要：frontmatter 优先于正文，且截断到 120 字", () => {
  const cache = { frontmatter: { description: "  用户手写的  摘要  " } };
  assert.equal(summarize({ cache, body: "正文段落", basename: "示例" }), "用户手写的 摘要");
  const long = summarize({ cache: { frontmatter: { summary: "字".repeat(200) } }, body: "", basename: "x" });
  assert.equal(long.length, 121);
  assert.ok(long.endsWith("…"));
});

test("摘要：正文首段无噪音，空正文按「文件名 + 一级标题」兜底", () => {
  const body = [
    "# 标题",
    "| :--- | --- |",
    "> 引用：[[笔记#章节|别名]] 与 #项目/子 标签，参见 `代码`。",
    "",
    "这是第二段正文内容。",
  ].join("\n");
  const summary = summarize({ cache: null, body, basename: "示例" });
  assert.ok(summary.includes("别名"));
  assert.ok(!summary.includes(":---"));
  assert.ok(!summary.includes("🎯"));
  assert.ok(!summary.includes("#项目"));

  const fallback = summarize({
    cache: { headings: [{ heading: "导读", level: 1 }] },
    body: "",
    basename: "示例",
  });
  assert.equal(fallback, "示例 · 导读");
  assert.equal(summarize({ cache: null, body: "", basename: "兜底" }), "兜底");
});

test("摘要缓存：仅 mtime 或算法版本变化才重算", () => {
  const cached = { mtime: 100, algo: SUMMARY_ALGO, summary: "已缓存摘要" };
  assert.equal(shouldRecompute(cached, 100), false);
  assert.equal(shouldRecompute(cached, 101), true);
  assert.equal(shouldRecompute(cached, 100, SUMMARY_ALGO + 1), true);
  assert.equal(shouldRecompute(null, 100), true);
  assert.equal(shouldRecompute({ ...cached, summary: "" }, 100), true);
});

// ── 分类与 Top 10（v9 语义，93 条基线）──────────────────────
test("分类：93 条样本逐篇统计不设上限，图表最多 10 根柱子", () => {
  const notes = Array.from({ length: 93 }, (_, index) =>
    note(`notes/n${index}.md`, { tags: [`分类${index % 12}/子${index}`] }),
  );
  const counts = countByCategory(notes, "tag");
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  assert.equal(total, 93, "逐篇统计总和必须等于笔记总数");
  assert.ok(counts.length > 10, "类别数不应被图表上限裁剪");

  const chart = chartSlices(notes, "tag");
  assert.ok(chart.length <= 10);
  assert.equal(chart.reduce((sum, item) => sum + item.count, 0), 93);
  assert.equal(chart[chart.length - 1].key, "其他");
  assert.equal(
    chart.reduce((sum, item) => sum + item.paths.length, 0),
    93,
  );
  assert.equal(tagCounts(notes).length, 93, "标签明细不设上限");
  assert.equal(folderCounts(notes).reduce((sum, item) => sum + item.count, 0), 93);
});

test("分类：标签顶层段、文件夹维度与未分类兜底", () => {
  assert.equal(topLevelTag("项目/子任务"), "项目");
  assert.equal(folderOf("领域/子目录/a.md"), "领域");
  assert.equal(folderOf("a.md"), "根目录");
  assert.equal(primaryCategory(note("a.md", { tags: ["项目/子"] }), "tag"), "项目");
  assert.equal(primaryCategory(note("领域/a.md"), "folder"), "领域");
  assert.equal(primaryCategory(note("a.md"), "tag"), "未分类");
});

// ── 日期与今日待办 ────────────────────────────────────────────
test("日期：多格式归一化、跨月跨年与本地时间戳", () => {
  assert.equal(normalizeDate("2026-11-15"), "2026-11-15");
  assert.equal(normalizeDate("2026/1/5"), "2026-01-05");
  assert.equal(normalizeDate("2026.11.15T08:30:00"), "2026-11-15");
  assert.equal(normalizeDate("2026-13-01"), null);
  assert.equal(normalizeDate("不是日期"), null);
  assert.equal(daysBetween("2026-11-10", "2026-11-15"), 5);
  assert.equal(daysBetween("2025-12-30", "2026-01-02"), 3);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(dateFromTimestamp(new Date(2026, 0, 1, 12).getTime()), "2026-01-01");
});

test("今日：逾期 / 今日到期 / 已完成排除 / 未来不列入", () => {
  const notes = [
    note("overdue.md", { due: "2026-11-10", status: "todo" }),
    note("due.md", { due: "2026-11-15" }),
    note("done.md", { due: "2026-11-01", status: "done" }),
    note("cn-done.md", { due: "2026-11-01", status: "已完成" }),
    note("future.md", { due: "2026-12-01" }),
  ];
  const due = collectDue(notes, TODAY);
  assert.equal(due.length, 2);
  assert.equal(due.find((item) => item.path === "overdue.md")?.kind, "overdue");
  assert.equal(due.find((item) => item.path === "overdue.md")?.days, 5);
  assert.equal(due.find((item) => item.path === "due.md")?.kind, "due");
  assert.equal(isDone("DONE"), true);
  assert.equal(isDone("doing"), false);
  assert.equal(isDone(null), false);
});

test("今日：过时提醒以 updated 优先、阈值边界、复习到期与分组排序", () => {
  const notes = [
    note("stale.md", { updated: "2026-01-01" }),
    note("fresh.md", { updated: "2026-11-01" }),
    note("by-mtime.md", { mtime: new Date(2026, 0, 1).getTime() }),
    note("review.md", { review: "2026-11-14" }),
    note("future-review.md", { review: "2026-12-01" }),
    note("task.md", { due: "2026-11-09" }),
  ];
  const stale = collectStale(notes, TODAY, DEFAULT_SETTINGS.staleDays);
  assert.ok(stale.some((item) => item.path === "stale.md"));
  assert.ok(stale.some((item) => item.path === "by-mtime.md"));
  assert.ok(!stale.some((item) => item.path === "fresh.md"));
  assert.equal(staleBaseDate(notes[2]), "2026-01-01");
  assert.equal(daysBetween("2026-08-17", TODAY), DEFAULT_SETTINGS.staleDays);
  assert.equal(collectStale([note("edge.md", { updated: "2026-08-17" })], TODAY, 90).length, 0);

  assert.equal(collectReview(notes, TODAY).length, 1);
  const today = buildToday(notes, TODAY, DEFAULT_SETTINGS);
  assert.equal(today.day, TODAY);
  assert.equal(today.overdue.length, 1);
  assert.equal(today.review.length, 1);
  assert.equal(today.total, today.items.length);
  assert.equal(today.items[0].kind, "overdue", "逾期排在最前");
});

// ── 复习排期 ──────────────────────────────────────────────────
test("复习：1/3/7/15/30 固定间隔、stage 到顶、到期排期与首次排期", () => {
  const intervals = DEFAULT_SETTINGS.reviewIntervals;
  assert.deepEqual(intervals.map((_, index) => nextInterval(intervals, index)), [1, 3, 7, 15, 30]);
  assert.equal(nextInterval(intervals, 99), 30);
  assert.equal(nextReviewDate(TODAY, intervals, 0), "2026-11-16");
  assert.equal(nextReviewDate(TODAY, intervals, 4), "2026-12-15");

  const notes = [
    note("due.md", { review: "2026-11-14", reviewStage: 1 }),
    note("future.md", { review: "2026-12-01" }),
    note("none.md"),
  ];
  const plan = planReview(notes, TODAY, intervals);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, "due.md");
  assert.equal(plan[0].nextStage, 2);
  assert.equal(plan[0].interval, 7);
  assert.equal(plan[0].nextDate, "2026-11-22");

  const first = startReview(notes[2], TODAY, intervals);
  assert.equal(first.nextStage, 0);
  assert.equal(first.nextDate, "2026-11-16");
});

// ── .ics ─────────────────────────────────────────────────────
function byteLength(text: string): number {
  return [...text].reduce((sum, ch) => sum + utf8Length(ch), 0);
}

test(".ics：转义、按 UTF-8 字节折行且可无损还原", () => {
  assert.equal(escapeIcsText("甲,乙;丙\\丁\n戊"), "甲\\,乙\\;丙\\\\丁\\n戊");
  const line = `SUMMARY:${"中文内容".repeat(30)}`;
  const folded = foldIcsLine(line);
  assert.ok(folded.length > 1);
  assert.ok(folded.every((part) => byteLength(part) <= 75));
  assert.ok(folded.slice(1).every((part) => part.startsWith(" ")));
  assert.equal(folded.map((part, index) => (index ? part.slice(1) : part)).join(""), line);
  assert.equal(foldIcsLine("BEGIN:VCALENDAR").length, 1);
});

test(".ics：UID 稳定、逾期项落到今天、去重与日期格式", () => {
  assert.equal(hashKey("a.md"), hashKey("a.md"));
  assert.notEqual(hashKey("a.md"), hashKey("b.md"));
  const item: TodayItem = {
    path: "a.md",
    title: "笔记",
    kind: "overdue",
    date: "2026-11-10",
    days: 5,
    detail: "逾期 5 天",
  };
  const events = buildIcsEvents([item, { ...item }, { ...item, kind: "review" }], TODAY);
  assert.equal(events.length, 2, "相同 path+kind+date 应去重");
  const overdue = events.find((event) => event.kind === "overdue");
  assert.ok(overdue);
  assert.equal(overdue.date, "20261115", "逾期项应改为今日，避免系统日历不再提醒");
  assert.ok(overdue.description.includes("2026-11-10"));
  assert.equal(eventUid({ path: "a.md", kind: "overdue", date: "20261115" }), overdue.uid);
  assert.equal(toIcsDate("2026-11-15"), "20261115");
  assert.equal(utcStamp(new Date("2026-11-15T07:05:09Z")), "20261115T070509Z");
});

test(".ics：VCALENDAR / VEVENT / VALARM 结构、CRLF 与转义写入", () => {
  const items: TodayItem[] = [
    {
      path: "a.md",
      title: "甲,乙;丙",
      kind: "due",
      date: "2026-11-15",
      days: 0,
      detail: "今日到期",
    },
  ];
  const text = renderIcs(buildIcsEvents(items, TODAY), new Date("2026-11-15T07:05:00Z"));
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.ok(text.includes("DTSTAMP:20261115T070500Z"));
  assert.ok(text.includes("DTSTART;VALUE=DATE:20261115"));
  assert.ok(text.includes("SUMMARY:今日待办 · 甲\\,乙\\;丙"));
  assert.ok(text.includes("TRANSP:TRANSPARENT"));
  assert.ok(text.includes("BEGIN:VALARM"));
  assert.ok(text.includes("TRIGGER:-P1D"));
  assert.ok(text.includes("DESCRIPTION:明日待处理"));
  assert.ok(!text.replace(/\r\n/g, "").includes("\n"), "不应出现裸 LF");
});

// ── 设置新增字段 ──────────────────────────────────────────────
test("设置：P3 新增字段默认值与旧数据兼容", () => {
  const settings = normalizeSettings({});
  assert.equal(settings.classifyBy, "tag");
  assert.equal(settings.writeReviewToFrontmatter, false);
  assert.equal(settings.icsEnabled, true);
  assert.equal(settings.writeSummaryToFrontmatter, false);
  assert.equal(normalizeSettings({ classifyBy: "folder", icsEnabled: false }).classifyBy, "folder");
  assert.equal(normalizeSettings({ classifyBy: "非法值" }).classifyBy, "tag");
});
