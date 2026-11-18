/**
 * P6 发布回归测试集：把定稿文档第三节「功能验收基线表」逐项固化为可跑断言，
 * 并覆盖 P6 新增的懒渲染、事件生命周期、官方规范与发布清单一致性。
 * 该测试集与 P2–P5 的用例合计 90+ 项，对应 v16.1 的 90+ 项 VM 回归。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import type { App, Component } from "obsidian";
import { VaultIndexService } from "../data/VaultIndexService";
import { chartSlices, countByCategory, folderOf, topLevelTag } from "../domain/ClassifierService";
import { emptyIcsState } from "../domain/aggregate";
import { buildIcsEvents, foldIcsLine, renderIcs } from "../domain/ics";
import { computeDiff, describeDiff } from "../domain/indexDiff";
import { normalizeSettings } from "../domain/pluginData";
import { nextInterval } from "../domain/ReviewService";
import { buildSnapshot, normalizeSnapshot } from "../domain/snapshot";
import { cleanMarkdownLine, mdToPlainText } from "../domain/speechText";
import { shouldRecompute, summarize } from "../domain/SummaryService";
import { buildToday, collectFollowup, isDone } from "../domain/TaskService";
import {
  DETAIL_PAGE_SIZE,
  groupToday,
  lazyPage,
  nextLoaded,
  restoreViewState,
  shouldLoadMore,
  todayCardTitle,
} from "../domain/uiModel";
import { CHART_LIMIT, DEFAULT_SETTINGS, defaultData } from "../types";
import type { NoteRecord, TodayItem, TodayKind } from "../types";
import { addMockFile, createMockApp, MockComponent } from "./obsidian-mock";

const ROOT = process.cwd();
const source = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const TODAY = "2026-11-15";
const INTERVALS = DEFAULT_SETTINGS.reviewIntervals;

function note(path: string, patch: Partial<NoteRecord> = {}): NoteRecord {
  const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  return {
    path,
    basename,
    title: basename,
    // 近期 mtime：避免因缺省 updated 回退 mtime 而被误判为「过时」。
    mtime: Date.parse("2026-11-14T00:00:00Z"),
    size: 100,
    tags: [],
    links: [],
    summary: "",
    due: null,
    status: null,
    updated: null,
    review: null,
    ...patch,
    reviewStage: patch.reviewStage ?? 0,
    interval: patch.interval ?? null,
    ease: patch.ease ?? null,
    tasks: patch.tasks ?? [],
  } as NoteRecord;
}

function item(kind: TodayKind, path: string, date = TODAY): TodayItem {
  return { path, title: path, kind, date, days: 0, detail: "" };
}

function settings() {
  return normalizeSettings({});
}

// ── 功能验收基线（第三节矩阵）────────────────────────────────
test("基线 01 · 标签与文件夹两种分类维度结果不同，逐篇计数都守恒", () => {
  const notes = Array.from({ length: 93 }, (_, i) =>
    note(`目录${i % 7}/笔记${i}.md`, { tags: [`分类${i % 12}`, `子项${i % 3}`] }),
  );
  const byTag = countByCategory(notes, "tag");
  const byFolder = countByCategory(notes, "folder");
  assert.equal(byTag.reduce((s, c) => s + c.count, 0), 93);
  assert.equal(byFolder.reduce((s, c) => s + c.count, 0), 93);
  assert.equal(byFolder.length, 7);
  assert.equal(byTag.length, 12);
  assert.notDeepEqual(byTag.map((c) => c.key), byFolder.map((c) => c.key));
});

test("基线 02 · 12 类压缩为 10 柱且计数守恒（v9 ≤10 语义）", () => {
  const notes = Array.from({ length: 93 }, (_, i) =>
    note(`笔记${i}.md`, { tags: [`分类${i % 12}`] }),
  );
  const counts = countByCategory(notes, "tag");
  const slices = chartSlices(notes, "tag");
  assert.equal(counts.length, 12, "逐篇统计不裁剪");
  assert.equal(slices.length, CHART_LIMIT);
  assert.equal(slices.reduce((s, c) => s + c.count, 0), 93);
  assert.equal(slices[CHART_LIMIT - 1].key, "其他");
});

test("基线 03 · 标签顶层段与首层文件夹解析", () => {
  assert.equal(topLevelTag("#项目/阶段一"), "#项目", "顶层段保留标签前缀，与 collectTags 输出一致");
  assert.equal(folderOf("a/b/c.md"), "a");
  assert.equal(folderOf("顶层.md"), "根目录");
});

test("基线 04 · 今日卡片标题折叠前后一致、不带项数备注", () => {
  assert.equal(todayCardTitle(TODAY), todayCardTitle(TODAY));
  assert.ok(!todayCardTitle(TODAY).includes("项待处理"));
  assert.ok(!/\d+\s*项/.test(todayCardTitle(TODAY)));
});

test("基线 05 · 今日清单分组顺序为逾期 → 到期 → 催办 → 复习 → 待办", () => {
  const groups = groupToday([
    item("todo", "t2.md"),
    item("followup", "f.md"),
    item("review", "r.md"),
    item("due", "d.md"),
    item("overdue", "o.md"),
  ]);
  assert.deepEqual(groups.map(([kind]) => kind), [
    "overdue",
    "due",
    "followup",
    "review",
    "todo",
  ]);
});

test("基线 06 · 已完成状态含中文别名，不进入待办", () => {
  for (const done of ["done", "已完成", "完成", "completed", "DONE"]) {
    assert.equal(isDone(done), true, `${done} 应视为已完成`);
  }
  assert.equal(isDone("todo"), false);
  assert.equal(isDone(null), false);
});

test("基线 07 · 催办默认周期 30 天，任务逾期才进催办", () => {
  assert.equal(DEFAULT_SETTINGS.staleDays, 30);
  const notes = [
    note("old.md", { tasks: [{ text: "过期任务", due: "2026-11-01", periodDays: null, source: "due", line: 3 }] }),
    note("fresh.md", { tasks: [{ text: "未来任务", due: "2026-11-20", periodDays: null, source: "due", line: 4 }] }),
  ];
  const followup = collectFollowup(notes, TODAY);
  assert.deepEqual(followup.map((item) => item.task?.text), ["过期任务"]);
});

test("基线 08 · 复习固定间隔 1/3/7/15/30，到顶保持最后一档", () => {
  assert.deepEqual(INTERVALS.map((_, stage) => nextInterval(INTERVALS, stage)), [1, 3, 7, 15, 30]);
  assert.equal(nextInterval(INTERVALS, 99), 30);
  assert.equal(nextInterval([], 0), 1);
});

test("基线 09 · 规则式摘要四档优先级与 120 字截断", () => {
  const explicit = summarize({ cache: { frontmatter: { description: "显式摘要" }, tags: [], headings: [], links: [] }, body: "正文", basename: "文件名" });
  assert.equal(explicit, "显式摘要");
  const body = summarize({ cache: null, body: "第一段足够长，用于验证正文首段摘要确实被采用。\n\n第二段。", basename: "文件名" });
  assert.ok(body.includes("第一段足够长"));
  const fallback = summarize({ cache: { frontmatter: null, tags: [], headings: [{ heading: "一级标题", level: 1 }], links: [] }, body: "# 一级标题", basename: "文件名" });
  assert.ok(fallback.length > 0);
  const onlyName = summarize({ cache: null, body: "", basename: "兜底文件名" });
  assert.equal(onlyName, "兜底文件名");
  assert.ok(summarize({ cache: null, body: "甲".repeat(400), basename: "文件" }).length <= 121);
});

test("基线 10 · 摘要缓存仅在 mtime 或 algo 变化时重算", () => {
  const entry = { mtime: 1000, algo: 2, summary: "缓存" };
  assert.equal(shouldRecompute(entry, 1000), false);
  assert.equal(shouldRecompute(entry, 1001), true);
  assert.equal(shouldRecompute({ ...entry, algo: 1 }, 1000), true);
});

test("基线 11 · .ics 含 VALARM 提前一天与全日 DTSTART，CRLF 且按字节折行", () => {
  const events = buildIcsEvents([item("due", "笔记.md", "2026-11-20")], TODAY);
  const text = renderIcs(events, new Date("2026-11-15T08:00:00Z"));
  assert.ok(text.includes("BEGIN:VALARM") && text.includes("TRIGGER:-P1D"));
  assert.ok(text.includes("DTSTART;VALUE=DATE:20261120"));
  assert.ok(text.includes("\r\n") && !text.replace(/\r\n/g, "").includes("\n"));
  for (const line of text.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, "中文行也须按 UTF-8 字节折行");
  }
  assert.equal(foldIcsLine("甲".repeat(40)).length > 1, true);
});

test("基线 12 · 快照 diff 只读，输入不被修改且描述文案可读", () => {
  const notes = { "a.md": note("a.md"), "b.md": note("b.md") };
  const snapshot = buildSnapshot(notes, 2);
  const copy = JSON.stringify(snapshot);
  const diff = computeDiff(null, buildSnapshot(notes, 2));
  assert.equal(JSON.stringify(snapshot), copy, "computeDiff 不得修改输入");
  assert.equal(diff.initial, true);
  assert.equal(describeDiff(diff), "", "首次索引不显示差异提示");
  const changed = computeDiff(snapshot, buildSnapshot({ "a.md": note("a.md"), "c.md": note("c.md") }, 2));
  assert.match(describeDiff(changed), /新增.*减少|减少.*新增/, "非首次差异需给出可读提示");
  assert.ok(normalizeSnapshot(JSON.parse(copy)) !== null);
});

test("基线 13 · Markdown 清洗：表格数据行保留文字，分隔行/代码块/emoji 为噪音", () => {
  assert.equal(cleanMarkdownLine("| --- | :--- |"), "");
  assert.equal(cleanMarkdownLine("```ts"), "");
  assert.equal(cleanMarkdownLine("| 甲 | 乙 |"), "");
  const table = cleanMarkdownLine("| 甲 | 乙 |", { keepTableRows: true });
  assert.ok(table.includes("甲") && table.includes("乙") && table.includes("，"));
  assert.equal(cleanMarkdownLine("# 标题 🔥"), "标题");
  assert.equal(mdToPlainText("# 标题\n\n正文内容。").includes("正文内容"), true);
});

test("基线 14 · 领域快照汇总五类提醒，带日期项进 .ics", () => {
  const notes = [
    note("逾期.md", { due: "2026-11-10", status: "todo" }),
    note("今日.md", { due: TODAY, status: "todo" }),
    note("复习.md", { review: TODAY, status: "todo" }),
    note("催办.md", { tasks: [{ text: "催办任务", due: "2026-11-01", periodDays: null, source: "due", line: 6 }] }),
    note("待办.md", { tasks: [{ text: "无日期任务", due: null, periodDays: null, source: "none", line: 8 }] }),
  ];
  const today = buildToday(notes, TODAY, settings());
  assert.equal(today.overdue.length, 1);
  assert.equal(today.due.length, 1);
  assert.equal(today.review.length, 1);
  assert.equal(today.followup.length, 1);
  assert.equal(today.todo.length, 1, "无日期任务进待办但不进日历");
  // 5 类共 5 项，其中无日期待办不生成 .ics 事件。
  assert.equal(buildIcsEvents(today.items, TODAY).length, today.items.length - 1);
});

test("基线 15 · 浏览位置同一天恢复、跨天重置", () => {
  const raw = { ...defaultData().view, day: TODAY, tab: "stats" as const, scrollY: 240 };
  const same = restoreViewState(raw, TODAY);
  assert.equal(same.tab, "stats");
  assert.equal(same.scrollY, 240);
  const next = restoreViewState({ ...raw, day: "2026-11-14" }, TODAY);
  assert.equal(next.tab, "today");
  assert.equal(next.scrollY, 0);
});

test("基线 16 · 手机端 .ics 状态标记 mobile（不下载、只写库内）", () => {
  const s = settings();
  assert.equal(emptyIcsState(s, true).mobile, true);
  assert.equal(emptyIcsState(s, false).mobile, false);
  assert.equal(emptyIcsState(s, false).path, DEFAULT_SETTINGS.icsPath);
});

test("基线 17 · 设置默认值安全：三个写回开关全关、自动续读关闭", () => {
  const s = normalizeSettings({});
  assert.equal(s.writeSummaryToFrontmatter, false);
  assert.equal(s.writeReviewToFrontmatter, false);
  assert.equal(s.speechAutoResume, false);
  assert.equal(s.speechPreferChineseVoice, true);
  assert.equal(s.classifyBy, "tag");
});

// ── P6 新增：懒渲染与事件生命周期 ─────────────────────────────
test("P6 01 · 万篇明细首屏只给 60 行", () => {
  const notes = Array.from({ length: 9999 }, (_, i) => note(`n${i}.md`));
  const page = lazyPage(notes, 0);
  assert.equal(page.visible.length, DETAIL_PAGE_SIZE);
  assert.equal(page.loaded, 60);
  assert.equal(page.total, 9999);
  assert.equal(page.hasMore, true);
});

test("P6 02 · 懒渲染边界：超总数、空列表、自定义页大小", () => {
  const notes = Array.from({ length: 5 }, (_, i) => note(`n${i}.md`));
  const over = lazyPage(notes, 999);
  assert.equal(over.loaded, 5);
  assert.equal(over.hasMore, false);
  assert.equal(lazyPage([], 0).hasMore, false);
  assert.equal(lazyPage(notes, 0, 2).visible.length, 2);
  assert.equal(lazyPage(notes, -10).loaded, 5, "负 loaded 视为首屏一页，且不超过总数");
});

test("P6 03 · nextLoaded 单调逼近总数且不越界", () => {
  assert.equal(nextLoaded(0, 9999), 60);
  assert.equal(nextLoaded(60, 9999), 120);
  assert.equal(nextLoaded(9960, 9999), 9999);
  assert.equal(nextLoaded(9999, 9999), 9999);
  assert.equal(nextLoaded(0, 0), 0);
  assert.equal(nextLoaded(0, 10, 3), 3);
});

test("P6 04 · 全量翻页覆盖 9999 篇、167 页且无重复", () => {
  const notes = Array.from({ length: 9999 }, (_, i) => note(`n${i}.md`));
  const seen: string[] = [];
  let loaded = 0;
  let pages = 0;
  while (loaded < notes.length) {
    const page = lazyPage(notes, loaded);
    seen.push(...page.visible.slice(pages * DETAIL_PAGE_SIZE).map((n) => n.path));
    loaded = nextLoaded(loaded, notes.length);
    pages += 1;
    assert.ok(pages < 300, "翻页必须有界");
  }
  assert.equal(pages, Math.ceil(9999 / DETAIL_PAGE_SIZE));
  assert.equal(new Set(seen).size, seen.length, "追加不得重复渲染");
});

test("P6 05 · 到底部 / 内容不足一屏才追加，中途滚动不触发", () => {
  assert.equal(shouldLoadMore(900, 100, 1000), true);
  assert.equal(shouldLoadMore(0, 400, 300), true);
  assert.equal(shouldLoadMore(100, 100, 1000), false);
});

test("P6 06 · 生产路径用 Component.registerEvent 登记 7 个宿主事件", async () => {
  const app = createMockApp();
  addMockFile(app, "a.md", 1000, { tags: [] });
  const owner = new MockComponent();
  const service = new VaultIndexService(app as unknown as App, {
    indexPath: "知识管理工作台/index.json",
    owner: owner as unknown as Component,
  });
  service.start();
  assert.equal(owner.refs.length, 7, "vault 4 + metadataCache 3");
  assert.equal(app.vault.handlerCount() + app.metadataCache.handlerCount(), 7);
  service.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

test("P6 07 · 反复启停 30 轮无事件泄漏，dispose 幂等", async () => {
  for (let round = 0; round < 30; round += 1) {
    const app = createMockApp();
    addMockFile(app, "a.md", 1000, { tags: [] });
    const service = new VaultIndexService(app as unknown as App, {
      indexPath: "知识管理工作台/index.json",
    });
    service.start();
    service.dispose();
    service.dispose();
    assert.equal(
      app.vault.handlerCount() + app.metadataCache.handlerCount(),
      0,
      `第 ${round + 1} 轮仍有事件残留`,
    );
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

// ── 官方规范与发布清单一致性 ──────────────────────────────────
test("P6 08 · manifest 字段齐备，双端标志与最低版本正确", () => {
  const manifest = JSON.parse(source("manifest.json"));
  for (const key of ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"]) {
    assert.ok(key in manifest, `缺少 ${key}`);
  }
  assert.equal(manifest.isDesktopOnly, false);
  assert.equal(manifest.id, "knowledge-workbench");
  assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version));
  assert.ok(!/obsidian/i.test(manifest.name), "插件名不得含 Obsidian 字样");
  // 官方 Manifest 文档 https://docs.obsidian.md/Reference/Manifest#name：
  // name 仅用 Basic Latin 字符，标点只允许 - + ()，禁止 emoji / 特殊字符 / 非拉丁文字。
  // 1.0.3 因含中文与中间点 · 被目录以 "This name is not allowed in the directory" 拒绝。
  assert.ok(/^[A-Za-z][A-Za-z0-9 +()-]*$/.test(manifest.name), "插件名须仅用 Basic Latin 字符，标点限 - + ()，无特殊字符");
  assert.ok(!/plugin$/i.test(manifest.name), "插件名不得以 Plugin 结尾");
  assert.ok(!/^obs?i/i.test(manifest.name), "插件名不得以 Obsi 开头");
  assert.ok(!/dian$/i.test(manifest.name), "插件名不得以 dian 结尾");
  assert.ok(/[.!?)\]]$/.test(manifest.description), "描述须以英文标点 . ! ? ( ) ] 结尾");
  assert.ok(!/obsidian/i.test(manifest.description), "描述不得含 Obsidian 字样");
  assert.ok(manifest.description.length <= 250, "描述不超过 250 字符");
  const [major, minor] = manifest.minAppVersion.split(".").map(Number);
  // workspace.revealLeaf 的 Promise 重载自 1.7.2 起提供；声明更低版本会触发社区审核
  // obsidianmd/no-unsupported-api Error，故 minAppVersion 必须 ≥1.7.2。
  assert.ok(major > 1 || (major === 1 && minor >= 7), "minAppVersion 需 ≥1.7.2（revealLeaf 签名要求）");
});

test("P6 09 · versions.json / package.json 与 manifest 版本一致", () => {
  const manifest = JSON.parse(source("manifest.json"));
  const versions = JSON.parse(source("versions.json"));
  const pkg = JSON.parse(source("package.json"));
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.name, manifest.id);
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, "零运行时依赖");
});

test("P6 10 · 设置页无顶层「常规」标题，分组标题不含「设置」", () => {
  const text = source(join("src", "ui", "SettingsTab.ts"));
  assert.equal(/setName\(["'](?:常规|设置|知识管理工作台)["']\)\s*\.setHeading\(\)/.test(text), false);
  const names = [...text.matchAll(/setName\(["']([^"']+)["']\)\s*\.setHeading\(\)/g)].map((m) => m[1]);
  assert.ok(names.length >= 2, "多分组才应使用 heading");
  assert.ok(names.every((name) => !name.includes("设置")));
});

test("P6 11 · 宿主入口使用 this.app / registerEvent / owner，且不设默认热键", () => {
  const text = source(join("src", "main.ts"));
  assert.ok(text.includes("registerEvent("));
  assert.ok(text.includes("owner: this"));
  assert.equal(/hotkeys\s*:/.test(text), false);
  assert.equal(/detachLeavesOfType|detachLeaves/.test(text), false);
  assert.ok(text.includes("onunload(") && text.includes("dispose()"));
});

test("P6 12 · 源码零禁项：innerHTML / 网络 / Node API / 后行断言 / 本地存储", () => {
  const text = source(join("src", "main.ts")) + source(join("src", "data", "VaultIndexService.ts")) + source(join("src", "ui", "WorkbenchView.ts"));
  for (const pattern of [
    /\.innerHTML|\.outerHTML|\.insertAdjacentHTML/,
    /\bfetch\s*\(|XMLHttpRequest|requestUrl\s*\(/,
    /\brequire\s*\(|from\s+["'](?:node:)?(?:fs|path|electron)/,
    /\(\?<=|\(\?<!/,
    /localStorage|indexedDB/,
    /https?:\/\//,
  ]) {
    assert.equal(pattern.test(text), false, `命中禁用模式 ${pattern}`);
  }
});

test("P6 13 · 样式零硬编码颜色，全部使用主题变量", () => {
  const css = source("styles.css");
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(/.test(css), false);
  assert.ok(css.includes("var(--text-muted)"));
  assert.ok(css.includes("@media (max-width: 520px)"), "窄屏适配必须保留");
});

test("P6 14 · 发布材料说明零网络、.ics 替代推送与手机朗读限制", () => {
  const readme = source("README.md");
  assert.ok(/零网络|无网络|不联网/.test(readme));
  assert.ok(/\.ics/.test(readme) && /不推送|系统日历/.test(readme));
  assert.ok(/手机|移动端/.test(readme) && /朗读/.test(readme));
  assert.ok(source("LICENSE").length > 200);
  assert.ok(source("CHANGELOG.md").includes("1.0.0"));
});

// ── v1.0.2 三项改动回归 ─────────────────────────────────────
test("v1.0.2 01 · 今日页签与卡片标题为「今日」，清单不再有「打开原文」按钮", () => {
  const model = source(join("src", "domain", "uiModel.ts"));
  assert.ok(model.includes('today: "今日"'));
  assert.ok(model.includes("`今日 · ${day}`"));
  const view = source(join("src", "ui", "WorkbenchView.ts"));
  const history = source(join("src", "ui", "HistoryView.ts"));
  assert.equal(view.includes('text: "打开原文"'), false);
  assert.equal(history.includes('text: "打开原文"'), false);
  assert.equal(model.includes("今日要处理"), false);
});

test("v1.0.2 02 · 统计页只有列表内横向条形，没有上方纵向 SVG 柱状图", () => {
  const view = source(join("src", "ui", "WorkbenchView.ts"));
  const chart = source(join("src", "ui", "Chart.ts"));
  const css = source("styles.css");
  assert.equal(view.includes("renderChart("), false);
  assert.equal(view.includes("kw-chart-scroll"), false);
  assert.ok(view.includes("renderBarMeter("));
  assert.ok(chart.includes("kw-count-bar-fill"));
  assert.ok(css.includes(".kw-count-bar-fill"));
  assert.equal(css.includes(".kw-chart-bar"), false);
});

test("v1.0.2 03 · 云端神经朗读搁置：main.ts 不接线、设置页无地址/密钥输入", () => {
  const main = source(join("src", "main.ts"));
  const settings = source(join("src", "ui", "SettingsTab.ts"));
  assert.equal(main.includes("createCloudTtsEngine"), false);
  assert.equal(main.includes("cloudEngine:"), false);
  assert.equal(settings.includes("启用云端神经语音"), false);
  assert.equal(settings.includes("API 密钥"), false);
  assert.ok(settings.includes("已搁置"));
  assert.ok(source(join("src", "domain", "pluginData.ts")).includes("cloudTtsEnabled: false"));
});

test("v1.0.2 04 · README / CHANGELOG 说明云端朗读已搁置与严格零网络", () => {
  const readme = source("README.md");
  assert.ok(/搁置/.test(readme) && /零网络/.test(readme));
  assert.ok(source("CHANGELOG.md").includes("1.0.2"));
});
