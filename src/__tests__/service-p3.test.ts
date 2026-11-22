import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { FrontmatterService } from "../data/FrontmatterService";
import type { DataPersister } from "../data/StoreService";
import { StoreService } from "../data/StoreService";
import { VaultIndexService } from "../data/VaultIndexService";
import { WorkbenchService } from "../data/WorkbenchService";
import { addMockFile, createMockApp, type MockApp } from "./obsidian-mock";
import { SUMMARY_ALGO } from "../types";

const INDEX_PATH = "知识管理工作台/index.json";
const ICS_PATH = "知识管理工作台/提醒.ics";
const BODY = "这是正文首个有效段落，包含足够多的文字用于规则式摘要。";

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function startIndex(
  app: MockApp,
  indexPath = INDEX_PATH,
): Promise<{ index: VaultIndexService; unsubscribe: () => void }> {
  const index = new VaultIndexService(app as unknown as App, { indexPath });
  let ready = false;
  const unsubscribe = index.subscribe((status) => {
    if (status.phase === "ready" || status.phase === "error") ready = true;
  });
  index.start();
  await waitFor(() => ready, "索引就绪");
  assert.equal(index.getStatus().phase, "ready");
  return { index, unsubscribe };
}

test("摘要缓存：frontmatter 摘要不读正文；命中 index.json 后重启也不重读", async () => {
  const app = createMockApp();
  addMockFile(app, "fm.md", 1000, {
    frontmatter: { description: "用户手写摘要" },
  });
  addMockFile(app, "body.md", 2000, { tags: [{ tag: "#项目" }] });
  app.vault.bodies.set("body.md", BODY);

  const first = await startIndex(app);
  assert.equal(first.index.getNote("fm.md")?.summary, "用户手写摘要");
  assert.match(first.index.getNote("body.md")?.summary ?? "", /正文首个有效段落/);
  // v1.0.6：首次全量扫描每篇都要读正文解析任务（含 frontmatter 摘要的 fm.md）。
  assert.equal(app.vault.readCount, 2, "首次扫描两篇都要读正文解析任务");

  first.index.writeNow();
  await waitFor(
    () => (app.vault.store.get(INDEX_PATH) ?? "").includes("正文首个有效段落"),
    "写入 index.json",
  );
  const saved = JSON.parse(app.vault.store.get(INDEX_PATH) ?? "{}") as {
    algo: number;
    notes: Record<string, unknown>;
  };
  assert.equal(saved.algo, SUMMARY_ALGO);
  assert.equal(Object.keys(saved.notes).length, 2);
  first.unsubscribe();
  first.index.dispose();

  // 模拟插件重启：同一个 vault，新服务读取已有快照作为基准。
  const readsBeforeRestart = app.vault.readCount;
  const second = await startIndex(app);
  assert.equal(app.vault.readCount, readsBeforeRestart, "缓存命中不应再读正文");
  assert.match(second.index.getNote("body.md")?.summary ?? "", /正文首个有效段落/);

  // mtime 变化才重算。
  const bodyFile = app.vault.files.get("body.md");
  assert.ok(bodyFile);
  bodyFile.stat.mtime = 3000;
  app.metadataCache.trigger("changed", bodyFile, "", {});
  app.vault.trigger("modify", bodyFile);
  await waitFor(() => app.vault.readCount > readsBeforeRestart, "mtime 变化触发重算");
  assert.equal(second.index.getNote("body.md")?.mtime, 3000);
  second.unsubscribe();
  second.index.dispose();
});

test("摘要算法升级：旧 algo=1 快照触发全量正文重算", async () => {
  const app = createMockApp();
  addMockFile(app, "old.md", 1000, {});
  app.vault.bodies.set("old.md", BODY);
  app.vault.store.set(
    INDEX_PATH,
    JSON.stringify({
      version: 1,
      algo: 1,
      generatedAt: 1,
      notes: { "old.md": { path: "old.md", mtime: 1000, size: 100, summary: "旧版兜底摘要" } },
    }),
  );

  const { index, unsubscribe } = await startIndex(app);
  assert.equal(app.vault.readCount, 1, "algo 变化应强制读正文");
  assert.match(index.getNote("old.md")?.summary ?? "", /正文首个有效段落/);
  unsubscribe();
  index.dispose();
});

test("WorkbenchService：93 条基线聚合、Top 10 与 .ics 写入 vault", async () => {
  const app = createMockApp();
  const persister: DataPersister = {
    async load(): Promise<unknown> {
      return null;
    },
    async save(): Promise<void> {
      return;
    },
  };
  const store = await StoreService.create(persister, { saveDelay: 1000 });
  for (let index = 0; index < 93; index += 1) {
    addMockFile(app, `notes/n${index}.md`, 1000 + index, {
      tags: [{ tag: `#分类${index % 12}` }],
    });
  }
  // 3 类今日项：逾期、复习到期、任务催办
  app.metadataCache.caches.set("notes/n0.md", {
    tags: [{ tag: "#分类0" }],
    frontmatter: { due: "2026-11-10", status: "todo" },
  });
  app.metadataCache.caches.set("notes/n1.md", {
    tags: [{ tag: "#分类1" }],
    frontmatter: { review: "2026-11-14" },
  });
  app.metadataCache.caches.set("notes/n2.md", {
    tags: [{ tag: "#分类2" }],
    frontmatter: { updated: "2026-01-01" },
  });
  app.vault.bodies.set("notes/n2.md", "- [ ] 跟进季度目标 @due(2026-11-01)\n");

  const index = new VaultIndexService(app as unknown as App, { indexPath: INDEX_PATH });
  const workbench = new WorkbenchService(app as unknown as App, store, index, {
    mobile: false,
  });
  workbench.start();
  const unsubscribe = index.subscribe(() => undefined);
  index.start();
  await waitFor(() => workbench.getSnapshot().noteCount === 93, "领域聚合完成");

  const snapshot = workbench.getSnapshot();
  assert.equal(snapshot.noteCount, 93);
  assert.equal(
    snapshot.categories.reduce((sum, item) => sum + item.count, 0),
    93,
    "逐篇统计不设上限",
  );
  assert.ok(snapshot.categories.length > 10);
  assert.equal(
    snapshot.chart.length,
    snapshot.categories.length,
    "统计卡片使用全量柱状图，不归并其他",
  );
  assert.ok(snapshot.detailChart.length > 0, "标签 / 文件夹卡片也有可点击切片");
  assert.ok(snapshot.chart.every((slice) => slice.paths.length === slice.count));
  assert.ok(snapshot.today.total >= 3);
  assert.ok(snapshot.today.overdue.length >= 1);
  assert.ok(snapshot.today.review.length >= 1);
  assert.ok(snapshot.today.followup.length >= 1, "正文 @due 过期任务进入催办");
  assert.ok(Array.isArray(snapshot.today.todo));

  workbench.rebuildIcs();
  await waitFor(
    () => (app.vault.store.get(ICS_PATH) ?? "").includes("END:VCALENDAR"),
    "写入 .ics",
  );
  const calendar = app.vault.store.get(ICS_PATH) ?? "";
  assert.ok(calendar.includes("BEGIN:VEVENT"));
  assert.ok(calendar.includes("BEGIN:VALARM"));
  assert.ok(calendar.includes("TRIGGER:-P1D"));
  assert.ok(calendar.includes("DTSTART;VALUE=DATE:"));
  assert.ok(app.vault.dirs.has("知识管理工作台"));
  assert.ok(snapshot.ics.events >= 3);

  unsubscribe();
  workbench.dispose();
  index.dispose();
  store.dispose();
});

test("FrontmatterService：写回需显式调用，字段与次数可核对", async () => {
  const app = createMockApp();
  const mockFile = addMockFile(app, "a.md", 1000, {});
  const service = new FrontmatterService(app as unknown as App);
  const file = service.findFile("a.md");
  assert.equal(file, mockFile);
  assert.equal(service.findFile("不存在.md"), null);
  assert.equal(app.fileManager.writes.length, 0, "构造服务不应改动笔记");
  assert.ok(file);

  await service.writeReview(file, "2026-11-22", 2);
  await service.writeSummary(file, "一条规则摘要");
  await service.removeReview(file);
  const fm = app.fileManager.frontmatters.get("a.md") ?? {};
  assert.equal(fm["review"], undefined);
  assert.equal(fm["review-stage"], undefined);
  assert.equal(fm["kw-summary"], "一条规则摘要");
  assert.equal(app.fileManager.writes.length, 3);
});
