/**
 * v1.0.6 回归：任务级催办/待办判定、标签批量预览、目录导出与 .ics 新文案。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderCatalog } from "../domain/catalog";
import {
  buildIcsEvents,
  eventUid,
  renderIcs,
} from "../domain/ics";
import { normalizeSettings } from "../domain/pluginData";
import {
  listTagKeys,
  previewTagEdit,
  tagKey,
} from "../domain/tagEdit";
import { parseTasks } from "../domain/taskParse";
import { normalizeSnapshot, buildSnapshot } from "../domain/snapshot";
import { DEFAULT_SETTINGS, type NoteRecord } from "../types";

const TODAY = "2026-11-18";

function note(path: string, patch: Partial<NoteRecord> = {}): NoteRecord {
  return {
    path,
    mtime: Date.parse("2026-11-01T00:00:00Z"),
    size: 100,
    title: path.replace(/^.*\//, "").replace(/\.md$/, ""),
    tags: [],
    links: [],
    summary: "",
    due: null,
    status: null,
    updated: null,
    review: null,
    reviewStage: 0,
    interval: null,
    ease: null,
    tasks: [],
    ...patch,
  };
}

// ── 任务解析 ────────────────────────────────────────────────
test("taskParse：@due 一次性任务解析为指定日期", () => {
  const tasks = parseTasks({
    body: "- [ ] 交季度报告 @due(2026-11-10)\n- [x] 已完成 @due(2026-11-01)",
    frontmatter: null,
    today: TODAY,
    autoInfer: true,
  });
  assert.equal(tasks.length, 1, "已完成任务不进入清单");
  assert.equal(tasks[0].text, "交季度报告");
  assert.equal(tasks[0].due, "2026-11-10");
  assert.equal(tasks[0].periodDays, null);
  assert.equal(tasks[0].source, "due");
  assert.equal(tasks[0].line, 0);
});

test("taskParse：@every 循环任务按锚点推进到 <= 今天的最近周期点", () => {
  const tasks = parseTasks({
    body: "- [ ] 每周复盘 @every(7d)",
    frontmatter: { created: "2026-11-01" },
    today: TODAY,
    autoInfer: true,
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].periodDays, 7);
  assert.equal(tasks[0].source, "every");
  // 11-01 + 14 天 = 11-15（<= 11-18 的最近周期点）
  assert.equal(tasks[0].due, "2026-11-15");
});

test("taskParse：中文周期词自动推断，关闭后不再推断", () => {
  const body = "- [ ] 每月整理行业资料";
  const on = parseTasks({
    body,
    frontmatter: { created: "2026-10-05" },
    today: TODAY,
    autoInfer: true,
  });
  assert.equal(on[0].source, "period-word");
  assert.equal(on[0].periodDays, 30);
  const off = parseTasks({
    body,
    frontmatter: { created: "2026-10-05" },
    today: TODAY,
    autoInfer: false,
  });
  assert.equal(off[0].source, "none");
  assert.equal(off[0].due, null);
});

test("taskParse：frontmatter follow-up 兜底整篇任务", () => {
  const tasks = parseTasks({
    body: "- [ ] 跟进项目",
    frontmatter: { "follow-up": "2026-11-20", "follow-up-every": "weekly" },
    today: TODAY,
    autoInfer: false,
  });
  assert.equal(tasks[0].source, "frontmatter");
  assert.equal(tasks[0].due, "2026-11-20", "未来锚点不推进");
  assert.equal(tasks[0].periodDays, 7);
});

test("taskParse：叙述性年份不被误判为到期日", () => {
  const tasks = parseTasks({
    body: "- [ ] 研究 2026年半年报 的毛利率",
    frontmatter: null,
    today: TODAY,
    autoInfer: true,
  });
  assert.equal(tasks[0].due, null);
  assert.equal(tasks[0].source, "none");
});

// ── 催办/待办分类 ───────────────────────────────────────────
test("催办/待办：逾期任务=催办，未来与无日期=待办", async () => {
  const { buildToday } = await import("../domain/TaskService");
  const notes = [
    note("a.md", {
      tasks: [
        { text: "催办任务", due: "2026-11-10", periodDays: null, source: "due", line: 1 },
        { text: "未来任务", due: "2026-11-25", periodDays: null, source: "due", line: 2 },
        { text: "无日期", due: null, periodDays: null, source: "none", line: 3 },
      ],
    }),
  ];
  const today = buildToday(notes, TODAY, DEFAULT_SETTINGS);
  assert.equal(today.followup.length, 1);
  assert.equal(today.followup[0].task?.text, "催办任务");
  assert.equal(today.todo.length, 2);
});

// ── .ics 文案与稳定 uid ─────────────────────────────────────
test(".ics：催办/待办文案，任务行号纳入 uid，无日期不生成事件", () => {
  const events = buildIcsEvents(
    [
      {
        path: "a.md",
        title: "任务一",
        kind: "followup",
        date: "2026-11-01",
        days: 17,
        detail: "逾期 17 天",
        task: { text: "催办任务", line: 4, periodDays: null, source: "due" },
      },
      {
        path: "a.md",
        title: "任务二",
        kind: "todo",
        date: null,
        days: 0,
        detail: "未设日期",
        task: { text: "无日期任务", line: 8, periodDays: null, source: "none" },
      },
    ],
    TODAY,
  );
  assert.equal(events.length, 1, "无日期任务不进日历");
  assert.ok(events[0].summary.startsWith("催办 · 催办任务"));
  const uidWithLine = eventUid({ path: "a.md", kind: "followup", date: "20261101", line: 4 });
  const uidNoLine = eventUid({ path: "a.md", kind: "followup", date: "20261101", line: 9 });
  assert.notEqual(uidWithLine, uidNoLine, "不同行号任务 uid 不冲突");
  const text = renderIcs(events, new Date("2026-11-18T00:00:00Z"));
  assert.ok(text.includes("SUMMARY:催办 · 催办任务"));
});

// ── 标签批量 ────────────────────────────────────────────────
test("tagEdit：归一化、预览命中与合并后计数、子标签", () => {
  assert.equal(tagKey("#行业研究"), "行业研究");
  assert.equal(tagKey("  行业研究 "), "行业研究");
  const notes = [
    note("a.md", { tags: ["行业研究", "汽车"] }),
    note("b.md", { tags: ["行业研究/零部件", "汽车"] }),
    note("c.md", { tags: ["行业观察", "汽车"] }),
  ];
  const withoutChildren = previewTagEdit(notes, ["行业研究"], "行业观察", false);
  assert.deepEqual(withoutChildren.paths, ["a.md"]);
  const withChildren = previewTagEdit(notes, ["行业研究"], "行业观察", true);
  assert.deepEqual(withChildren.paths, ["a.md", "b.md"]);
  assert.equal(withChildren.targetTotal, 3, "合并后目标标签覆盖含原有 c.md");
  const keys = listTagKeys(notes);
  assert.ok(keys.find((k) => k.key === "汽车")?.count === 3);
});

// ── 目录导出 ────────────────────────────────────────────────
test("catalog：按主分类分组、含 wiki 链接与摘要", () => {
  const md = renderCatalog(
    [
      note("notes/a.md", { title: "A 笔记", tags: ["项目/甲"], summary: "摘要一" }),
      note("notes/b.md", { title: "B 笔记", tags: ["项目/乙"], summary: "摘要二" }),
    ],
    "tag",
    new Date("2026-11-18T00:00:00Z"),
  );
  assert.ok(md.startsWith("# 笔记目录"));
  assert.ok(md.includes("## 项目（2 篇）"));
  assert.ok(md.includes("[[notes/a\\|A 笔记]]"));
  assert.ok(md.includes("摘要一"));
});

// ── 设置迁移与快照兼容 ──────────────────────────────────────
test("设置：旧阈值 90 迁移到 30，自定义值保留，taskAutoInfer 默认开", () => {
  assert.equal(normalizeSettings({ staleDays: 90 }).staleDays, 30);
  assert.equal(normalizeSettings({ staleDays: 60 }).staleDays, 60);
  assert.equal(normalizeSettings({}).taskAutoInfer, true);
  assert.equal(normalizeSettings({ taskAutoInfer: false }).taskAutoInfer, false);
});

test("快照：taskDay 往返兼容，旧快照无 tasks 不判损坏", () => {
  const snap = buildSnapshot({ "a.md": note("a.md") }, 2, 1000, TODAY);
  assert.equal(snap.taskDay, TODAY);
  const round = normalizeSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.equal(round?.taskDay, TODAY);
  assert.deepEqual(round?.notes["a.md"].tasks, []);
  const legacy = normalizeSnapshot({
    version: 1,
    algo: 2,
    generatedAt: 1,
    notes: {
      "a.md": {
        path: "a.md", mtime: 1, size: 1, title: "a", tags: [], links: [],
        summary: "", due: null, status: null, updated: null, review: null,
      },
    },
  });
  assert.ok(legacy, "旧快照仍可读取");
  assert.deepEqual(legacy?.notes["a.md"].tasks, []);
});
