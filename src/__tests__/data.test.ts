import assert from "node:assert/strict";
import test from "node:test";
import { scanInBatches } from "../domain/batchScan";
import { computeDiff, describeDiff, isEmptyDiff } from "../domain/indexDiff";
import { buildNoteRecord, truncateSummary } from "../domain/noteRecord";
import { migratePaths, normalizeData, normalizeSettings, pushHistory } from "../domain/pluginData";
import { buildSnapshot, normalizeSnapshot, serializeSnapshot } from "../domain/snapshot";
import { StoreService, type DataPersister } from "../data/StoreService";
import {
  DEFAULT_SETTINGS,
  HISTORY_LIMIT,
  INDEX_VERSION,
  SUMMARY_ALGO,
  type HistoryEntry,
  type NoteRecord,
  type PluginData,
} from "../types";

function makeRecord(path: string, patch: Partial<NoteRecord> = {}): NoteRecord {
  return {
    path,
    mtime: 1000,
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
    // Partial<NoteRecord> 会把必填字段变成可选，展开后显式兜底保证类型完整。
    reviewStage: patch.reviewStage ?? 0,
    interval: patch.interval ?? null,
    ease: patch.ease ?? null,
    tasks: patch.tasks ?? [],
  };
}

function makeSnapshot(records: NoteRecord[]): ReturnType<typeof buildSnapshot> {
  return buildSnapshot(
    Object.fromEntries(records.map((record) => [record.path, record])),
    SUMMARY_ALGO,
    1000,
  );
}

class MemoryPersister implements DataPersister {
  saves: PluginData[] = [];
  private readonly initial: unknown;

  constructor(initial: unknown = null) {
    this.initial = initial;
  }

  async load(): Promise<unknown> {
    return this.initial;
  }

  async save(data: PluginData): Promise<void> {
    this.saves.push({ ...data });
  }
}

test("buildNoteRecord：frontmatter / 内联标签合并去重，标题与摘要按优先级取值", () => {
  const record = buildNoteRecord(
    { path: "笔记/a.md", basename: "a", mtime: 123, size: 45 },
    {
      tags: [{ tag: "#项目/x" }, { tag: "#标签" }],
      frontmatter: {
        title: "自定义标题",
        description: "  这是一段  很长的摘要  ",
        due: "2026-11-20",
        status: "TODO",
        tags: ["项目/x", "另一个"],
      },
      headings: [{ heading: "一级标题", level: 1 }],
      links: [{ link: "b" }, { link: "b" }],
    },
  );
  assert.equal(record.title, "自定义标题");
  assert.deepEqual(record.tags, ["项目/x", "另一个", "标签"]);
  assert.equal(record.summary, "这是一段 很长的摘要");
  assert.equal(record.due, "2026-11-20");
  assert.equal(record.status, "todo");
  assert.deepEqual(record.links, ["b"]);
  assert.equal(record.mtime, 123);
  assert.equal(record.size, 45);
});

test("buildNoteRecord：无 frontmatter 时回退「文件名 + 一级标题」，再兜底文件名", () => {
  const withHeading = buildNoteRecord(
    { path: "b.md", basename: "b", mtime: 1, size: 1 },
    { headings: [{ heading: "导读", level: 1 }] },
  );
  assert.equal(withHeading.title, "导读");
  assert.equal(withHeading.summary, "b · 导读");

  const plain = buildNoteRecord(
    { path: "c.md", basename: "c", mtime: 1, size: 1 },
    null,
  );
  assert.equal(plain.title, "c");
  assert.equal(plain.summary, "c");
  assert.deepEqual(plain.tags, []);
});

test("truncateSummary：合并空白并在 120 字处补省略号", () => {
  assert.equal(truncateSummary("  甲   乙  "), "甲 乙");
  const long = truncateSummary("字".repeat(200));
  assert.equal(long.length, 121);
  assert.ok(long.endsWith("…"));
});

test("computeDiff：新增 / 减少 / 修改 / 未变化，且忽略摘要文本变化", () => {
  const previous = makeSnapshot([
    makeRecord("a.md", { mtime: 1, size: 10, tags: ["x", "y"] }),
    makeRecord("b.md"),
    makeRecord("c.md"),
  ]);
  const current = makeSnapshot([
    makeRecord("a.md", { mtime: 2, size: 10, tags: ["y", "x"] }),
    makeRecord("b.md", { summary: "算法升级后的摘要" }),
    makeRecord("d.md"),
  ]);
  const diff = computeDiff(previous, current);
  assert.deepEqual(diff.added, ["d.md"]);
  assert.deepEqual(diff.removed, ["c.md"]);
  assert.deepEqual(diff.modified, ["a.md"], "mtime 变化应计为修改");
  assert.equal(diff.unchanged, 1, "仅摘要文本变化不应计为修改");
  assert.equal(diff.initial, false);

  const tagOrderOnly = computeDiff(
    makeSnapshot([makeRecord("t.md", { tags: ["x", "y"] })]),
    makeSnapshot([makeRecord("t.md", { tags: ["y", "x"] })]),
  );
  assert.equal(tagOrderOnly.modified.length, 0, "仅 tags 顺序变化不应计为修改");

  const sizeChanged = computeDiff(
    previous,
    makeSnapshot([makeRecord("a.md", { mtime: 1, size: 11, tags: ["x", "y"] })]),
  );
  assert.deepEqual(sizeChanged.modified, ["a.md"]);
});

test("computeDiff：首次索引标记 initial，差异提示与空判断正确", () => {
  const current = makeSnapshot([makeRecord("a.md"), makeRecord("b.md")]);
  const first = computeDiff(null, current);
  assert.equal(first.initial, true);
  assert.deepEqual(first.added, ["a.md", "b.md"]);
  assert.equal(isEmptyDiff(first), true);
  assert.equal(describeDiff(first), "");

  const changed = computeDiff(
    makeSnapshot([makeRecord("a.md")]),
    makeSnapshot([makeRecord("a.md"), makeRecord("b.md")]),
  );
  assert.equal(isEmptyDiff(changed), false);
  assert.match(describeDiff(changed), /新增 1/);

  const same = computeDiff(current, current);
  assert.equal(isEmptyDiff(same), true);
  assert.equal(describeDiff(same), "与上次快照一致，无变化");
});

test("normalizeSnapshot：合法往返、坏条目跳过、版本不符返回 null", () => {
  const snapshot = makeSnapshot([makeRecord("a.md"), makeRecord("b.md")]);
  const restored = normalizeSnapshot(JSON.parse(serializeSnapshot(snapshot)) as unknown);
  assert.equal(restored?.version, INDEX_VERSION);
  assert.equal(Object.keys(restored?.notes ?? {}).length, 2);
  assert.equal(restored?.notes["a.md"].title, "a.md");

  const partial = normalizeSnapshot({
    version: INDEX_VERSION,
    algo: SUMMARY_ALGO,
    generatedAt: 1,
    notes: { "ok.md": makeRecord("ok.md"), "bad.md": { mtime: "oops" } },
  });
  assert.deepEqual(Object.keys(partial?.notes ?? {}), ["ok.md"]);
  assert.equal(normalizeSnapshot({ version: 999, notes: {} }), null);
  assert.equal(normalizeSnapshot(null), null);
});

test("normalizeData：合并默认值、修正脏值、裁剪历史到 20 篇", () => {
  const rawHistory = Array.from({ length: 25 }, (_, index) => ({
    path: `n${index}.md`,
    title: `n${index}`,
    at: index,
  }));
  const data = normalizeData({
    view: { tab: "bad", scrollY: -5 },
    history: rawHistory,
    read: { "a.md": { idx: 3, total: 9, at: 1 }, "bad.md": "oops" },
    settings: { staleDays: 0, reviewIntervals: [], speechRate: 99, indexPath: "" },
  });
  assert.equal(data.view.tab, "today");
  assert.equal(data.view.scrollY, 0);
  assert.deepEqual(data.view.tabDetail, {});
  assert.equal(data.history.length, HISTORY_LIMIT);
  assert.equal(data.history[0].path, "n24.md");
  assert.deepEqual(Object.keys(data.read), ["a.md"]);
  assert.equal(data.settings.staleDays, 1);
  assert.deepEqual(data.settings.reviewIntervals, DEFAULT_SETTINGS.reviewIntervals);
  assert.equal(data.settings.speechRate, 3);
  assert.equal(data.settings.indexPath, DEFAULT_SETTINGS.indexPath);
  assert.equal(normalizeData("garbage").version, 1);
});

test("normalizeSettings：旧默认复习间隔迁移到艾宾浩斯，自定义间隔保留", () => {
  assert.deepEqual(
    normalizeSettings({ reviewIntervals: [1, 3, 7, 15, 30] }).reviewIntervals,
    DEFAULT_SETTINGS.reviewIntervals,
  );
  assert.deepEqual(
    normalizeSettings({ reviewIntervals: [2, 5, 9] }).reviewIntervals,
    [2, 5, 9],
  );
});

test("pushHistory：最新在前、按 path 去重、保留 20 篇上限", () => {
  const history: HistoryEntry[] = [
    { path: "a.md", title: "A", at: 10 },
    { path: "b.md", title: "B", at: 9 },
  ];
  const next = pushHistory(history, { path: "a.md", title: "A2", at: 11 });
  assert.deepEqual(next.map((item) => item.path), ["a.md", "b.md"]);
  assert.equal(next[0].title, "A2");

  const many = Array.from({ length: 30 }, (_, index) => ({
    path: `p${index}.md`,
    title: `p${index}`,
    at: index,
  }));
  assert.equal(pushHistory(many, { path: "new.md", title: "新", at: 100 }).length, HISTORY_LIMIT);
});

test("migratePaths：重命名时迁移朗读断点与历史记录", () => {
  const data = normalizeData({
    read: { "旧.md": { idx: 4, total: 20, at: 3 } },
    history: [{ path: "旧.md", title: "旧", at: 1 }],
  });
  const next = migratePaths(data, "旧.md", "新.md", "新");
  assert.equal(next.read["旧.md"], undefined);
  assert.equal(next.read["新.md"].idx, 4);
  assert.equal(next.history[0].path, "新.md");
  assert.equal(next.history[0].title, "新");
  assert.equal(migratePaths(data, "", "x.md"), data);
});

test("scanInBatches：异步 worker 保持顺序，signal 可取消过期扫描", async () => {
  const ordered = await scanInBatches(
    [1, 2, 3, 4, 5],
    async (value) => {
      await Promise.resolve();
      return value * 3;
    },
    { batchSize: 2, concurrency: 2, yieldFn: async () => undefined },
  );
  assert.deepEqual(ordered.items, [3, 6, 9, 12, 15]);
  assert.equal(ordered.yields, 3);
  assert.equal(ordered.aborted, false);

  const signal = { aborted: false };
  const cancelled = await scanInBatches(
    Array.from({ length: 200 }, (_, index) => index),
    (value) => {
      if (value === 65) signal.aborted = true;
      return value;
    },
    { batchSize: 10, yieldFn: async () => undefined, signal },
  );
  assert.equal(cancelled.aborted, true);
  assert.ok(cancelled.items.length < 200);
});

test("性能门槛：9999 篇分批索引不阻塞且顺序稳定", async () => {
  const total = 9999;
  const items = Array.from({ length: total }, (_, index) => index);
  const result = await scanInBatches(items, (index) => index * 2, {
    batchSize: 60,
    concurrency: 8,
    yieldFn: async () => undefined,
  });
  assert.equal(result.items.length, total);
  assert.equal(result.items[0], 0);
  assert.equal(result.items[total - 1], (total - 1) * 2);
  assert.equal(result.yields, Math.ceil(total / 60));
  console.log(
    `[perf] 9999 篇分批索引 ${result.durationMs}ms，主线程让出 ${result.yields} 次`,
  );
  assert.ok(
    result.durationMs < 3000,
    `9999 篇纯索引耗时 ${result.durationMs}ms，超过 3000ms 门槛`,
  );
});

test("分批扫描真实让出主线程", async () => {
  const result = await scanInBatches(
    Array.from({ length: 240 }, (_, index) => index),
    (index) => index,
    { batchSize: 60 },
  );
  assert.equal(result.yields, 4);
  assert.equal(result.items.length, 240);
});

test("StoreService：合并多次修改为一次落盘，重命名迁移，卸载后停止写入", async () => {
  const persister = new MemoryPersister({
    history: [{ path: "旧记录.md", title: "旧记录", at: 1 }],
    settings: { indexPath: "自定义/index.json" },
  });
  const store = await StoreService.create(persister, { saveDelay: 1000 });
  assert.equal(store.settings.indexPath, "自定义/index.json");
  assert.equal(store.settings.staleDays, DEFAULT_SETTINGS.staleDays);
  assert.equal(store.history.length, 1);

  store.patchView({ tab: "stats" });
  store.setTodayFolded(true);
  store.setReadProgress("a.md", { idx: 2, total: 10, at: 5 });
  store.addHistory("a.md", "A");
  store.renamePath("a.md", "b.md", "B");
  assert.equal(store.getReadProgress("b.md")?.idx, 2);
  assert.equal(store.getReadProgress("a.md"), null);
  assert.equal(store.view.tab, "stats");
  assert.equal(store.snapshot.todayFolded, true);

  await store.flush();
  assert.equal(persister.saves.length, 1);
  assert.equal(persister.saves[0].read["b.md"].idx, 2);

  store.dispose();
  store.patchView({ tab: "today" });
  await store.flush();
  assert.equal(persister.saves.length, 1);
});

test("StoreService：防抖自动落盘，loadData 抛错时回退默认数据", async () => {
  const persister = new MemoryPersister();
  const store = await StoreService.create(persister, { saveDelay: 10 });
  store.setTodayFolded(true);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  assert.equal(persister.saves.length, 1);
  store.dispose();

  const broken: DataPersister = {
    async load(): Promise<unknown> {
      throw new Error("disk error");
    },
    async save(): Promise<void> {
      return;
    },
  };
  const recovered = await StoreService.create(broken);
  assert.equal(recovered.view.tab, "today");
  assert.equal(recovered.history.length, 0);
  recovered.dispose();
});
