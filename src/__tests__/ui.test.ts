import assert from "node:assert/strict";
import test from "node:test";
import { chartSlices } from "../domain/ClassifierService";
import {
  TAB_LABELS,
  TAB_ORDER,
  chartGeometry,
  filterPaths,
  groupToday,
  isTab,
  decodeSelection,
  encodeSelection,
  normalizeTabDetail,
  readCategory,
  restoreViewState,
  sortHistory,
  todayCardTitle,
  truncateLabel,
  writeCategory,
} from "../domain/uiModel";
import { CHART_LIMIT, defaultData } from "../types";
import type {
  ChartSlice,
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

function slices(counts: number[]): ChartSlice[] {
  return counts.map((count, index) => ({
    key: `分类${index}`,
    count,
    paths: Array.from({ length: count }, (_, i) => `分类${index}/${i}.md`),
  }));
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
  assert.equal(title, "今日要处理 · 2026-11-15");
  assert.equal(title, todayCardTitle("2026-11-15"), "折叠前后应取同一个标题");
  assert.equal(title.includes("项待处理"), false);
  assert.equal(title.includes("（"), false);
});

test("今日清单按 逾期 → 今日到期 → 复习 → 过时 分组，空组不出现", () => {
  const items = [
    item("stale.md", "stale"),
    item("review.md", "review"),
    item("due.md", "due"),
    item("overdue.md", "overdue"),
    item("overdue2.md", "overdue"),
  ];
  const groups = groupToday(items);
  assert.deepEqual(
    groups.map(([kind]) => kind),
    ["overdue", "due", "review", "stale"],
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
    lastModal: "a.md",
    note: { path: "a.md", title: "a" },
    tabDetail: { statsCategory: "category::项目" },
  });
  const reset = restoreViewState(raw, "2026-11-15");
  assert.equal(reset.day, "2026-11-15");
  assert.equal(reset.tab, "today");
  assert.equal(reset.scrollY, 0);
  assert.equal(reset.lastModal, null);
  assert.equal(reset.note, null);
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

test("filterPaths 不筛选时返回 null，未知分类返回空集合", () => {
  const data = slices([2, 3]);
  assert.equal(filterPaths(data, null), null);
  assert.deepEqual([...filterPaths(data, "分类1")!], ["分类1/0.md", "分类1/1.md", "分类1/2.md"]);
  assert.equal(filterPaths(data, "不存在")!.size, 0);
});

test("标签按槽宽截断，末尾省略号且不超过可用字符数", () => {
  assert.equal(truncateLabel("项目", 4), "项目");
  assert.equal(truncateLabel("很长很长的分类名", 3), "很长…");
  assert.equal([...truncateLabel("很长很长的分类名", 3)].length, 3);
  assert.equal(truncateLabel("超长", 1), "超");
});

test("全量柱状图几何：所有分类都出柱、坐标有限、柱底对齐基线", () => {
  const geo = chartGeometry(slices([9, 7, 5, 4, 3, 2, 2, 1, 1, 1, 1, 1]));
  assert.equal(geo.bars.length, 12, "不再归并 Top 10 / 其他");
  assert.equal(geo.totalSlices, 12);
  assert.equal(geo.truncated, false);
  assert.ok(geo.width >= 12 * 62, "宽度按类别数扩展，由容器横向滚动");
  const plotBottom = geo.plotBottom;
  for (const bar of geo.bars) {
    assert.ok(Number.isFinite(bar.x) && Number.isFinite(bar.y));
    assert.ok(bar.width > 0 && bar.height > 0);
    assert.ok(Math.abs(bar.y + bar.height - plotBottom) < 1e-6);
  }
  const tallest = geo.bars.find((bar) => bar.key === "分类0")!;
  const smallest = geo.bars.find((bar) => bar.key === "分类1")!;
  assert.ok(tallest.height > smallest.height);
  assert.equal(tallest.count, 9);
});

test("柱状图标签不重叠：估算宽度 ≤ slot-gap，中心间距 = slot", () => {
  const options = { width: 320, charWidth: 9, gap: 8 };
  const geo = chartGeometry(slices([12, 9, 8, 6, 5, 4, 3, 2, 1, 1]), options);
  for (const bar of geo.bars) {
    const estimated = [...bar.label].length * (options.charWidth ?? 9);
    assert.ok(
      estimated <= geo.slot - options.gap + 1e-6,
      `${bar.label} 估算宽度 ${estimated} 超过槽宽 ${geo.slot - options.gap}`,
    );
    assert.equal(bar.label.includes("\n"), false);
  }
  for (let i = 1; i < geo.bars.length; i += 1) {
    const distance = geo.bars[i].centerX - geo.bars[i - 1].centerX;
    assert.ok(Math.abs(distance - geo.slot) < 1e-6);
    assert.ok(distance > 0);
  }
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
  const geo = chartGeometry(chart);
  assert.equal(geo.bars.length, CHART_LIMIT);
  assert.equal(
    geo.bars.reduce((total, bar) => total + bar.count, 0),
    notes.length,
  );
  assert.equal(geo.bars[geo.bars.length - 1].key, "其他");
});

test("空图表与单柱图表不产生非法坐标", () => {
  const empty = chartGeometry([]);
  assert.equal(empty.bars.length, 0);
  assert.ok(empty.slot > 0);
  const single = chartGeometry(slices([3]));
  assert.equal(single.bars.length, 1);
  assert.ok(single.bars[0].x >= 0);
  assert.ok(single.bars[0].height > 0);
});
