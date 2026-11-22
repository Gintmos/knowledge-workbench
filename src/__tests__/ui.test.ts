import assert from "node:assert/strict";
import test from "node:test";
import { chartSlices } from "../domain/ClassifierService";
import {
  TAB_LABELS,
  TAB_ORDER,
  barRowsMax,
  barWidthPercent,
  groupToday,
  isTab,
  decodeSelection,
  encodeSelection,
  normalizeTabDetail,
  readCategory,
  restoreViewState,
  sortHistory,
  todayCardTitle,
  writeCategory,
} from "../domain/uiModel";
import { CHART_LIMIT, defaultData } from "../types";
import type {
  HistoryEntry,
  NoteRecord,
  TodayItem,
  TodayKind,
  ViewState,
} from "../types";

function note(path: string, patch: Partial<NoteRecord> = {}): NoteRecord {
  return {
    path,
    mtime: 1000,
    size: 100,
    title: path,
    tags: [],
    links: [],
    summary: "",
    due: null,
    status: null,
    updated: null,
    review: null,
    interval: null,
    ease: null,
    ...patch,
    reviewStage: patch.reviewStage ?? 0,
    tasks: patch.tasks ?? [],
  };
}

function item(path: string, kind: TodayKind, days = 1): TodayItem {
  return {
    path,
    title: path,
    kind,
    date: "2026-11-10",
    days,
    detail: "示例",
  };
}

function history(path: string, at: number): HistoryEntry {
  return { path, title: path, at };
}

function view(patch: Partial<ViewState> = {}): ViewState {
  return { ...defaultData().view, ...patch };
}

test("四个页签顺序固定：知识库已取消、浏览历史在最右", () => {
  assert.deepEqual(TAB_ORDER, ["today", "review", "stats", "history"]);
  for (const tab of TAB_ORDER) {
    assert.ok(TAB_LABELS[tab].length > 0);
  }
  assert.equal(isTab("history"), true);
  assert.equal(isTab("knowledge"), false);
  assert.equal(isTab("unknown"), false);
  assert.equal(isTab(42), false);
});

test("今日卡片标题折叠前后一致，且不带「项待处理」计数备注", () => {
  const title = todayCardTitle("2026-11-15");
  assert.equal(title, "今日 · 2026-11-15");
  assert.equal(title, todayCardTitle("2026-11-15"), "折叠前后应取同一个标题");
  assert.equal(title.includes("项待处理"), false);
  assert.equal(title.includes("（"), false);
});

test("今日清单按 逾期 → 今日到期 → 催办 → 复习 → 待办 分组，空组不出现", () => {
  const items = [
    item("todo.md", "todo"),
    item("followup.md", "followup"),
    item("review.md", "review"),
    item("due.md", "due"),
    item("overdue.md", "overdue"),
    item("overdue2.md", "overdue"),
  ];
  const groups = groupToday(items);
  assert.deepEqual(
    groups.map(([kind]) => kind),
    ["overdue", "due", "followup", "review", "todo"],
  );
  assert.equal(groups[0][1].length, 2);
  assert.equal(groups.every(([, list]) => list.length > 0), true);
  assert.deepEqual(groupToday([]), []);
});

test("浏览历史最新在前、同路径去重、最多 20 篇", () => {
  const entries = [
    history("a.md", 100),
    history("b.md", 300),
    history("a.md", 900),
    history("c.md", 200),
  ];
  const list = sortHistory(entries);
  assert.deepEqual(
    list.map((entry) => entry.path),
    ["a.md", "b.md", "c.md"],
  );
  assert.equal(list[0].at, 900, "同路径只保留最近一次打开的时间");
  assert.equal(new Set(list.map((entry) => entry.path)).size, 3);

  const many = Array.from({ length: 25 }, (_, i) =>
    history(`n${i}.md`, 1000 + i),
  );
  const limited = sortHistory(many);
  assert.equal(limited.length, 20);
  assert.equal(limited[0].path, "n24.md");
  assert.equal(new Set(limited.map((entry) => entry.path)).size, 20);
  assert.equal(sortHistory(many, 3).length, 3);
});

test("同一天恢复页签、滚动位置与分类筛选", () => {
  const raw = view({
    day: "2026-11-15",
    tab: "stats",
    scrollY: 240,
    tabDetail: { statsCategory: "category::项目", knowledgeCategory: "梦境" },
  });
  const restored = restoreViewState(raw, "2026-11-15");
  assert.equal(restored.tab, "stats");
  assert.equal(restored.scrollY, 240);
  assert.equal(readCategory(restored.tabDetail), "category::项目");
  assert.equal(
    restored.tabDetail["knowledgeCategory"],
    undefined,
    "旧知识库页签的坏死筛选值必须被清除",
  );
});

test("跨天重置视图，非法页签与负滚动位置有兜底", () => {
  const raw = view({
    day: "2026-11-14",
    tab: "bad-tab" as ViewState["tab"],
    scrollY: -50,
    tabDetail: { statsCategory: "category::项目" },
  });
  const reset = restoreViewState(raw, "2026-11-15");
  assert.equal(reset.day, "2026-11-15");
  assert.equal(reset.tab, "today");
  assert.equal(reset.scrollY, 0);
  assert.deepEqual(reset.tabDetail, {});

  const sameDay = restoreViewState(raw, "2026-11-14");
  assert.equal(sameDay.tab, "today", "非法页签回退到今日");
  assert.equal(sameDay.scrollY, 0, "负滚动位置归零");
});

test("分类筛选读写与清除", () => {
  const detail = writeCategory({}, "项目");
  assert.equal(readCategory(detail), "项目");
  const cleared = writeCategory(detail, null);
  assert.equal(readCategory(cleared), null);
  assert.deepEqual(cleared, {});
  assert.equal(readCategory({ statsCategory: 3 }), null);
  assert.deepEqual(encodeSelection({ scope: "detail", key: "#项目" }), "detail::#项目");
  assert.deepEqual(decodeSelection("detail::#项目"), {
    scope: "detail",
    key: "#项目",
  });
  assert.equal(decodeSelection("梦境"), null, "旧格式脏值不得恢复为选中项");
  assert.equal(decodeSelection(null), null);
  assert.deepEqual(normalizeTabDetail({ knowledgeCategory: "梦境", other: 1 }), { other: 1 });
});

test("v1.0.2：今日页签与卡片标题统一为「今日」", () => {
  assert.equal(TAB_LABELS.today, "今日");
  assert.equal(todayCardTitle("2026-11-15"), "今日 · 2026-11-15");
  assert.equal(TAB_LABELS.history, "浏览历史");
});

test("横向条形图宽度与卡片内最大值成比例，且始终可见、无 NaN", () => {
  assert.equal(barWidthPercent(20, 20), 100);
  assert.equal(barWidthPercent(10, 20), 50);
  assert.equal(barWidthPercent(6, 20), 30);
  assert.equal(barWidthPercent(1, 20), 5);
  assert.equal(barWidthPercent(1, 1000), 3, "极小比例也至少给 3% 可见宽度");
  assert.equal(barWidthPercent(50, 20), 100, "超过最大值时钳到 100%");
  assert.equal(barWidthPercent(0, 20), 0);
  assert.equal(barWidthPercent(-1, 20), 0);
  assert.equal(barWidthPercent(3, 0), 0);
  assert.equal(barWidthPercent(Number.NaN, 20), 0);
  assert.equal(Number.isFinite(barWidthPercent(3, 7)), true);
});

test("横向条形图基准最大值：空组为 1，多组可合并比较", () => {
  assert.equal(barRowsMax([]), 1);
  assert.equal(barRowsMax([{ count: 20 }, { count: 11 }, { count: 8 }]), 20);
  assert.equal(barRowsMax([{ count: 4 }, { count: 9 }, { count: 2 }]), 9);
});

test("旧版有限图表 chartSlices 仍压缩为 10 柱，计数总和守恒", () => {
  const notes: NoteRecord[] = [];
  for (let i = 0; i < 12; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      notes.push(note(`组${i}/${j}.md`, { tags: [`组${i}`] }));
    }
  }
  const chart = chartSlices(notes, "tag");
  assert.equal(chart.length, CHART_LIMIT);
  const sum = chart.reduce((total, slice) => total + slice.count, 0);
  assert.equal(sum, notes.length, "Top 10 不能丢掉逐篇计数");
  assert.equal(chart[chart.length - 1].key, "其他");
});
