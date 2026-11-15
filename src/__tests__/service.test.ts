import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { VaultIndexService } from "../data/VaultIndexService";
import { addMockFile, createMockApp, type MockApp } from "./obsidian-mock";

const INDEX_PATH = "知识管理工作台/index.json";

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

function setup(): {
  app: MockApp;
  service: VaultIndexService;
  renames: Array<[string, string, string]>;
} {
  const app = createMockApp();
  const renames: Array<[string, string, string]> = [];
  const service = new VaultIndexService(app as unknown as App, {
    indexPath: INDEX_PATH,
    onRename: (oldPath, newPath, newTitle) => {
      renames.push([oldPath, newPath, newTitle]);
    },
  });
  return { app, service, renames };
}

/** 预置一份「上次会话」的 index.json，让 diff 不是首次索引。 */
function seedBaseline(
  app: MockApp,
  entries: Array<[string, number, string[]?]>,
): void {
  const notes: Record<string, unknown> = {};
  for (const [path, mtime, tags] of entries) {
    notes[path] = { path, mtime, size: 100, tags: tags ?? [] };
  }
  app.vault.store.set(
    INDEX_PATH,
    JSON.stringify({ version: 1, algo: 1, generatedAt: 1, notes }),
  );
}

test("VaultIndexService：全量索引 / 增量事件 / 快照写入 / 卸载清理", async () => {
  const { app, service, renames } = setup();
  addMockFile(app, "a.md", 1000, {
    tags: [{ tag: "#项目" }],
    frontmatter: { description: "A 摘要" },
  });
  addMockFile(app, "b.md", 2000, {});
  addMockFile(app, "c.md", 3000, {});
  addMockFile(app, "f.md", 3500, null); // 模拟 metadataCache 尚未解析完成
  seedBaseline(app, [
    ["a.md", 1000, ["项目"]],
    ["b.md", 2000],
    ["c.md", 3000],
    ["f.md", 3500],
  ]);

  let ready = false;
  const unsubscribe = service.subscribe((status) => {
    if (status.phase === "ready" || status.phase === "error") ready = true;
  });
  service.start();
  await waitFor(() => ready, "首次全量索引");

  const first = service.getStatus();
  assert.equal(first.phase, "ready");
  assert.equal(first.indexed, 4);
  assert.equal(first.error, null);
  assert.equal(first.diff?.initial, false);
  assert.ok(first.yields >= 1, "分批扫描应让出主线程");
  assert.equal(first.cacheMisses, 1, "metadataCache 缺失的文件应被标记");
  assert.equal(service.getNote("a.md")?.summary, "A 摘要");
  assert.deepEqual(service.getNote("a.md")?.tags, ["项目"]);

  // resolved 事件只补扫缓存缺失的文件，不做全量重扫。
  app.metadataCache.caches.set("f.md", { tags: [{ tag: "#补扫" }] });
  app.metadataCache.trigger("resolved");
  await waitFor(() => service.getStatus().cacheMisses === 0, "resolved 补扫");
  assert.deepEqual(service.getNote("f.md")?.tags, ["补扫"]);

  // 手动写入快照，验证 index.json 结构可被下一轮读取。
  service.writeNow();
  await waitFor(() => {
    const text = app.vault.store.get(INDEX_PATH) ?? "";
    return text.includes("A 摘要") && text.includes("补扫");
  }, "写入 index.json");
  const saved = JSON.parse(app.vault.store.get(INDEX_PATH) ?? "{}") as {
    version: number;
    notes: Record<string, unknown>;
  };
  assert.equal(saved.version, 1);
  assert.equal(Object.keys(saved.notes).length, 4);
  assert.ok(app.vault.dirs.has("知识管理工作台"), "应自动创建快照目录");

  // create
  const created = addMockFile(app, "d.md", 4000, { tags: [{ tag: "#新" }] });
  app.vault.trigger("create", created);
  await waitFor(() => service.getDiff()?.added.includes("d.md") === true, "新建 md");
  assert.equal(service.getStatus().indexed, 5);
  assert.deepEqual(service.getNote("d.md")?.tags, ["新"]);

  // modify（vault 与 metadataCache 两条事件都会命中，防抖合并为一次更新）
  const modified = app.vault.files.get("a.md");
  assert.ok(modified);
  modified.stat.mtime = 5000;
  app.metadataCache.caches.set("a.md", {
    tags: [{ tag: "#项目" }, { tag: "#重点" }],
  });
  app.vault.trigger("modify", modified);
  app.metadataCache.trigger("changed", modified, "", {});
  await waitFor(
    () =>
      service.getDiff()?.modified.includes("a.md") === true &&
      service.getNote("a.md")?.tags.includes("重点") === true,
    "编辑 md",
  );
  assert.deepEqual(service.getNote("a.md")?.tags, ["项目", "重点"]);

  // delete（索引只移除记录，绝不调用删除笔记的 API）
  const deleted = app.vault.files.get("c.md");
  assert.ok(deleted);
  app.vault.files.delete("c.md");
  app.vault.trigger("delete", deleted);
  await waitFor(
    () => service.getDiff()?.removed.includes("c.md") === true,
    "删除 md",
  );
  assert.equal(service.getNote("c.md"), null);

  // rename：changed 不触发，必须由 vault.on('rename') 单独迁移
  const beforeRename = app.vault.files.get("b.md");
  assert.ok(beforeRename);
  app.vault.files.delete("b.md");
  const renamed = addMockFile(app, "new.md", 2000, {});
  app.vault.trigger("rename", renamed, "b.md");
  await waitFor(
    () =>
      service.getNote("new.md") !== null &&
      service.getDiff()?.added.includes("new.md") === true,
    "重命名 md 增量刷新",
  );
  assert.equal(service.getNote("b.md"), null);
  assert.deepEqual(renames[0], ["b.md", "new.md", "new"]);
  assert.ok(service.getDiff()?.added.includes("new.md"));
  assert.ok(service.getDiff()?.removed.includes("b.md"));

  // dispose：事件引用全部注销，之后的变更不再进入索引
  assert.ok(app.vault.handlerCount() > 0);
  assert.ok(app.metadataCache.handlerCount() > 0);
  service.dispose();
  unsubscribe();
  assert.equal(app.vault.handlerCount(), 0);
  assert.equal(app.metadataCache.handlerCount(), 0);
  const late = addMockFile(app, "late.md", 9000, {});
  app.vault.trigger("create", late);
  assert.equal(service.getNote("late.md"), null);
});

test("VaultIndexService：快照损坏时自动按首次索引重建", async () => {
  const { app, service } = setup();
  addMockFile(app, "only.md", 1000, {});
  app.vault.store.set(INDEX_PATH, "{ 这不是合法 JSON");

  let done = false;
  const unsubscribe = service.subscribe((status) => {
    if (status.phase === "ready") done = true;
  });
  service.start();
  await waitFor(() => done, "损坏快照后的首次索引");
  assert.equal(service.getStatus().phase, "ready");
  assert.equal(service.getStatus().indexed, 1);
  assert.equal(service.getDiff()?.initial, true);
  unsubscribe();
  service.dispose();
});
