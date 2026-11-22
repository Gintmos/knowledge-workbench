/**
 * P6 性能与稳定性压测（定稿 P6-2）。
 *
 * 用 9999 篇合成笔记跑通「构造记录 → 分批索引 → 快照往返 → 差异 →
 * 分类统计 → 领域聚合 → ICS → 朗读分块 → 列表分页」全链路，
 * 输出 dist/benchmark-report.json。纯函数基准，不含真实 metadataCache /
 * DOM 渲染开销；真库压测见《双端实机验收手册》。
 */
import esbuild from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const TMP = ".tmp-bench";
const DIST = "dist";
const TOTAL = 9999;
const TODAY = "2026-11-15";

const mockObsidian = {
  name: "mock-obsidian-for-bench",
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({
      path: resolve("src/__tests__/obsidian-mock.ts"),
    }));
  },
};

const entry = `import * as batchScan from "../src/domain/batchScan";
import * as noteRecord from "../src/domain/noteRecord";
import * as snapshot from "../src/domain/snapshot";
import * as indexDiff from "../src/domain/indexDiff";
import * as classifier from "../src/domain/ClassifierService";
import * as aggregate from "../src/domain/aggregate";
import * as tasks from "../src/domain/TaskService";
import * as ics from "../src/domain/ics";
import * as pluginData from "../src/domain/pluginData";
import * as uiModel from "../src/domain/uiModel";
import * as speechChunks from "../src/speech/chunks";
import * as speechText from "../src/speech/speechText";
import * as summary from "../src/domain/SummaryService";
export const modules = { batchScan, noteRecord, snapshot, indexDiff, classifier,
  aggregate, tasks, ics, pluginData, uiModel, speechChunks, speechText, summary };
`;

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(join(TMP, "entry.ts"), entry, "utf8");

try {
  await esbuild.build({
    entryPoints: [join(TMP, "entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: join(TMP, "entry.js"),
    external: ["node:*"],
    plugins: [mockObsidian],
    // P2-6：源码统一改用宿主 window.* 定时器/performance。benchmark 在纯 Node 里
    // 跑打包产物，没有 window，这里只给测试产物注入指向 globalThis 的宿主桩
    // （与 run-tests.mjs 一致）；插件产物 main.js 不含该桩、不引入任何运行时依赖。
    banner: {
      js: 'if (typeof globalThis.window === "undefined") { globalThis.window = globalThis; }',
    },
    logLevel: "warning",
  });

  const require = createRequire(import.meta.url);
  const m = require(resolve(TMP, "entry.js")).modules;
  const records = [];
  const measure = (name, fn, limitMs) => {
    const start = performance.now();
    const value = fn();
    const ms = Math.round((performance.now() - start) * 100) / 100;
    records.push({ name, ms, limitMs, ok: ms <= limitMs });
    return value;
  };
  const measureAsync = async (name, fn, limitMs) => {
    const start = performance.now();
    const value = await fn();
    const ms = Math.round((performance.now() - start) * 100) / 100;
    records.push({ name, ms, limitMs, ok: ms <= limitMs });
    return value;
  };

  if (globalThis.gc) globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;

  // ── 合成数据集：43 个文件夹、23 个顶层标签、部分带 due/review ──
  const files = Array.from({ length: TOTAL }, (_, i) => ({
    path: `notes/目录${i % 43}/第${i}篇笔记.md`,
    basename: `第${i}篇笔记`,
    mtime: 1700000000000 + i * 1000,
    size: 400 + (i % 900),
    cache: {
      tags: [{ tag: `#分类${i % 23}` }, { tag: `#子项${i % 7}` }],
      frontmatter:
        i % 5 === 0
          ? {
              due: i % 10 === 0 ? "2026-11-10" : TODAY,
              status: i % 20 === 0 ? "done" : "todo",
              updated: "2026-08-01",
              review: TODAY,
            }
          : {},
      headings: [{ heading: `标题 ${i}`, level: 1 }],
      links: [],
    },
  }));

  const notes = measure(
    `构造 ${TOTAL} 篇 NoteRecord（含 frontmatter 与标签）`,
    () => files.map((f) => m.noteRecord.buildNoteRecord(f, f.cache, `摘要：${f.basename}`)),
    3000,
  );

  const scan = await measureAsync(
    `分批索引 ${TOTAL} 篇（60/批 · 并发 8 · 每批让出）`,
    () =>
      m.batchScan.scanInBatches(files, (f) => m.noteRecord.buildNoteRecord(f, f.cache, `摘要：${f.basename}`), {
        batchSize: 60,
        concurrency: 8,
        yieldFn: async () => undefined,
      }),
    3000,
  );

  const noteMap = Object.fromEntries(notes.map((n) => [n.path, n]));
  const snap = m.snapshot.buildSnapshot(noteMap, 2);
  const roundTrip = measure(
    `快照序列化 → JSON 解析 → 归一化（${TOTAL} 篇）`,
    () => m.snapshot.normalizeSnapshot(JSON.parse(m.snapshot.serializeSnapshot(snap))),
    3000,
  );

  measure(`全量 computeDiff（基线为空 → ${TOTAL} 篇）`, () => m.indexDiff.computeDiff(null, snap), 2000);
  const changedMap = { ...noteMap };
  changedMap[files[0].path] = { ...notes[0], mtime: notes[0].mtime + 1 };
  measure(
    "1% 笔记变更后的增量 computeDiff",
    () => m.indexDiff.computeDiff(roundTrip, m.snapshot.buildSnapshot(changedMap, 2)),
    2000,
  );

  const settings = m.pluginData.normalizeSettings({});
  const icsState = m.aggregate.emptyIcsState(settings, false);
  measure(
    `分类统计 + 领域聚合（${TOTAL} 篇）`,
    () => m.aggregate.buildDomainSnapshot(notes, TODAY, settings, icsState),
    5000,
  );
  measure("Top 10 图表切片（逐篇计数不设上限）", () => {
    m.classifier.countByCategory(notes, "tag");
    return m.classifier.chartSlices(notes, "tag");
  }, 1000);

  const todayItems = measure("待办 / 逾期 / 催办 / 复习采集", () => m.tasks.buildToday(notes, TODAY, settings), 2000);
  measure("ICS 事件生成 + VCALENDAR 渲染", () => {
    const events = m.ics.buildIcsEvents(todayItems.items, TODAY);
    return m.ics.renderIcs(events, new Date("2026-11-15T08:00:00Z"));
  }, 3000);

  const longMd = Array.from({ length: 200 }, (_, i) => `第 ${i} 段：这是一段用于朗读压测的中文正文，包含 #标签、[[笔记别名]] 与 \`行内代码\`。`).join("\n\n");
  measure("朗读清洗 + 分块（约 1 万字）", () => {
    const text = m.speechText.mdToSpeechText(longMd);
    return m.speechChunks.mdToSpeechChunks(text);
  }, 2000);

  measure(`列表懒渲染全量翻页（${TOTAL} 篇 / 每页 60）`, () => {
    let loaded = 0;
    let pages = 0;
    while (loaded < notes.length) {
      m.uiModel.lazyPage(notes, loaded);
      loaded = m.uiModel.nextLoaded(loaded, notes.length);
      pages += 1;
    }
    return pages;
  }, 1000);

  if (globalThis.gc) globalThis.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMb = Math.round(((heapAfter - heapBefore) / 1024 / 1024) * 100) / 100;

  const failed = records.filter((r) => !r.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    sample: { notes: TOTAL, folders: 43, topLevelTags: 23, yields: scan.yields, scanItems: scan.items.length },
    totals: { measuredMs: Math.round(records.reduce((sum, r) => sum + r.ms, 0) * 100) / 100, cases: records.length, failed: failed.length },
    memory: { heapBeforeMb: Math.round(heapBefore / 1024 / 1024), heapAfterMb: Math.round(heapAfter / 1024 / 1024), heapDeltaMb, note: "Node 未开启 --expose-gc 时该值为参考量，不是精确峰值" },
    cases: records,
    caveats: [
      "纯函数基准，不包含真实 metadataCache 解析、cachedRead 磁盘 IO 与 DOM 渲染耗时。",
      "桌面 / 手机真机启用、真实库万篇压测、长时间运行定时器泄漏见《双端实机验收手册》与回归测试集。",
    ],
  };
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "benchmark-report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(`\n样本 ${TOTAL} 篇 · 分 ${scan.yields} 批让出主线程 · Node ${process.version}\n`);
  console.log("耗时(ms)  门槛(ms)  结果  项目");
  for (const r of records) {
    console.log(`${String(r.ms).padStart(8)}  ${String(r.limitMs).padStart(8)}  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  }
  console.log(`\n合计 ${report.totals.measuredMs}ms，${records.length} 项，失败 ${failed.length} 项`);
  console.log(`堆增量（参考）${heapDeltaMb} MB`);
  console.log(`报告：${join(DIST, "benchmark-report.json")}`);
  if (failed.length) process.exitCode = 1;
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
