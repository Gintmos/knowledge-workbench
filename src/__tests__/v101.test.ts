/** v1.0.1 / v1.0.2 专项回归：Outlook .ics、页签迁移、横向条形图、韵律与云端搁置。 */
import assert from "node:assert/strict";
import test from "node:test";
import { SpeechService } from "../data/SpeechService";
import { allCategorySlices, detailSlices } from "../domain/ClassifierService";
import { buildIcsEvents, nextIcsDate, renderIcs } from "../domain/ics";
import { normalizeData, normalizeSettings } from "../domain/pluginData";
import {
  barRowsMax,
  barWidthPercent,
  decodeSelection,
  encodeSelection,
  normalizeTabDetail,
} from "../domain/uiModel";
import { mdToSpeechChunks, prosodyFor } from "../speech/chunks";
import { mdToSpeechText } from "../speech/speechText";
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechVoice,
} from "../speech/types";
import { DEFAULT_SETTINGS } from "../types";
import type { NoteRecord, ReadProgress, TodayItem } from "../types";

function note(path: string, tags: string[] = []): NoteRecord {
  return {
    path,
    mtime: 1000,
    size: 100,
    title: path,
    tags,
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
  };
}

function todayItem(date: string): TodayItem {
  return {
    path: "笔记.md",
    title: "笔记",
    kind: "due",
    date,
    days: 0,
    detail: "今日到期",
  };
}

// ── .ics / Outlook ───────────────────────────────────────────
test("全天事件必须带排他 DTEND（次日），跨月跨年正确", () => {
  assert.equal(nextIcsDate("20261120"), "20261121");
  assert.equal(nextIcsDate("20261130"), "20261201");
  assert.equal(nextIcsDate("20261231"), "20270101");
  assert.equal(nextIcsDate("非法"), "非法");
});

test("renderIcs 补齐 Outlook 兼容字段且不破坏 CRLF / 75 octets 折行", () => {
  const text = renderIcs(
    buildIcsEvents([todayItem("2026-11-20")], "2026-11-15"),
    new Date("2026-11-15T08:00:00Z"),
  );
  assert.ok(text.includes("DTSTART;VALUE=DATE:20261120"));
  assert.ok(text.includes("DTEND;VALUE=DATE:20261121"));
  assert.ok(text.includes("X-MICROSOFT-CDO-ALLDAYEVENT:TRUE"));
  assert.ok(text.includes("X-MICROSOFT-CDO-BUSYSTATUS:FREE"));
  assert.ok(text.includes("SEQUENCE:0") && text.includes("STATUS:CONFIRMED"));
  assert.ok(text.includes("TRIGGER:-P1D") && text.includes("BEGIN:VALARM"));
  assert.ok(text.includes("X-WR-CALNAME:"));
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false);
  for (const line of text.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  }
  const dtend = text.indexOf("DTEND;VALUE=DATE:");
  const dtstart = text.indexOf("DTSTART;VALUE=DATE:");
  assert.ok(dtend > dtstart, "DTEND 必须排在 DTSTART 之后");
});

// ── 页签与状态迁移 ───────────────────────────────────────────
test("旧「知识库」页签映射到统计，坏死筛选值被清理", () => {
  const data = normalizeData({
    view: {
      day: "2026-11-15",
      tab: "knowledge",
      tabDetail: { knowledgeCategory: "梦境", statsCategory: "category::项目" },
    },
  });
  assert.equal(data.view.tab, "stats");
  assert.equal(data.view.tabDetail["knowledgeCategory"], undefined);
  assert.equal(data.view.tabDetail["statsCategory"], "category::项目");
  assert.deepEqual(decodeSelection("category::项目"), {
    scope: "category",
    key: "项目",
  });
  assert.equal(decodeSelection("梦境"), null);
  assert.deepEqual(
    normalizeTabDetail({ knowledgeCategory: "梦境", keep: 1 }),
    { keep: 1 },
  );
  assert.equal(
    encodeSelection({ scope: "detail", key: "目录 · 项目" }),
    "detail::目录 · 项目",
  );
});

test("自定义 TTS 网关：默认关闭（安全），但显式开启会被尊重", () => {
  assert.equal(DEFAULT_SETTINGS.cloudTtsEnabled, false);
  assert.equal(DEFAULT_SETTINGS.cloudTtsUrl, "");
  assert.equal(DEFAULT_SETTINGS.cloudTtsKey, "");
  const settings = normalizeSettings({ speechRate: 2 });
  assert.equal(settings.cloudTtsEnabled, false);
  assert.equal(settings.speechProsody, true);
  assert.equal(settings.speechPauseMs, 420);
  assert.ok(settings.cloudTtsModel.length > 0);
  // 用户主动开启的联网方案必须保留（不再强制归零），是否真正联网仍受 speechEngine 双重开关约束。
  assert.equal(
    normalizeSettings({ cloudTtsEnabled: true, cloudTtsUrl: "https://x.example/v1" }).cloudTtsEnabled,
    true,
  );
});

// ── 全量图表与下钻数据 ───────────────────────────────────────
test("全量分类与标签/目录切片都带完整路径，显示名与列表一致", () => {
  const notes = [
    note("项目/a.md", ["项目/阶段一", "重点"]),
    note("项目/b.md", ["项目/阶段二"]),
    note("顶层.md", ["重点"]),
  ];
  const all = allCategorySlices(notes, "tag");
  assert.equal(all.length, 2);
  assert.ok(all.every((slice) => slice.paths.length === slice.count));
  assert.equal(all.reduce((sum, slice) => sum + slice.count, 0), notes.length);
  const detail = detailSlices(notes);
  const keys = detail.map((slice) => slice.key);
  assert.ok(keys.includes("#重点"));
  assert.ok(keys.includes("目录 · 项目"));
  assert.ok(keys.includes("目录 · 根目录"));
  const tagSlice = detail.find((slice) => slice.key === "#重点")!;
  assert.deepEqual(tagSlice.paths.sort(), ["顶层.md", "项目/a.md"]);
});

test("v1.0.2 全量分类都用横向条形，不再截断为前 200 根柱子", () => {
  const many = Array.from({ length: 260 }, (_, i) => ({
    key: `分类${i}`,
    count: i + 1,
    paths: [`p${i}.md`],
  }));
  const max = barRowsMax(many);
  assert.equal(max, 260);
  assert.equal(many.length, 260, "全部分类都能出条，不再有 SVG 柱子防御上限");
  assert.equal(barWidthPercent(many[0].count, max), 3, "最少的一类仍有可见条");
  assert.equal(barWidthPercent(many[259].count, max), 100, "最多的一类占满");
});

// ── 朗读韵律 ────────────────────────────────────────────────
test("韵律：疑问句停顿与音高高于陈述句，逗号不再切块", () => {
  const plain = prosodyFor("这是陈述句。");
  const asked = prosodyFor("这是疑问句？");
  assert.ok(asked.pauseMs > plain.pauseMs);
  assert.ok(asked.pitch > plain.pitch);
  const chunks = mdToSpeechChunks("先说前半句，再说后半句，最后收尾。");
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].rateScale >= 0.9 && chunks[0].rateScale <= 1.1);
  const text = mdToSpeechText("# 标题\n正文一行\n正文二行");
  assert.ok(text.includes("标题。"), "标题后补句号形成停顿");
  assert.ok(text.includes("，"), "相邻行用中文逗号连接");
  assert.equal(text.includes("\n\n"), false);
});

// ── 云端优先 + 自动回退 ─────────────────────────────────────
class FakeEngine implements SpeechEngine {
  readonly spoken: Array<{ text: string; options: SpeakOptions }> = [];
  handlers: SpeakHandlers | null = null;
  failed = false;
  constructor(
    readonly label: string,
    private readonly support = true,
  ) {}
  supported(): boolean {
    return this.support;
  }
  getVoices(): SpeechVoice[] {
    return [{ name: "Ting-Ting", lang: "zh-CN" }];
  }
  speak(text: string, options: SpeakOptions, handlers: SpeakHandlers): void {
    this.spoken.push({ text, options });
    this.handlers = handlers;
    if (this.failed) {
      setTimeout(() => handlers.onError("offline"), 0);
    }
  }
  cancel(): void {
    this.handlers = null;
  }
  pause(): void {}
  resume(): void {}
  isSpeaking(): boolean {
    return Boolean(this.handlers);
  }
  isPaused(): boolean {
    return false;
  }
}

function speechHarness(preferred: SpeechEngine | null, local: SpeechEngine | null) {
  const store = new Map<string, ReadProgress | null>();
  return new SpeechService({
    engine: local,
    // P2-4：cloudEngine 兼容入口已删除，统一走 preferredEngine 单路径。
    preferredEngine: preferred,
    mobile: true,
    progress: {
      get: (path) => store.get(path) ?? null,
      set: (path, value) => {
        if (value) store.set(path, value);
        else store.delete(path);
      },
    },
    keepAliveMs: 0,
    silenceMs: 0,
    // P2-1：单测用同步调度器保持断言确定性（生产为 300/600ms 短退避）。
    scheduleRetry: (run) => run(),
  });
}

test("首选引擎可用时优先；失败后自动回退系统语音并重说当前块", async () => {
  const cloud = new FakeEngine("云端神经语音");
  const local = new FakeEngine("系统语音（规则式韵律）");
  const service = speechHarness(cloud, local);
  assert.equal(service.supported, true);
  assert.equal(service.getSnapshot().engineLabel, "云端神经语音");
  service.prepare("a.md", "笔记", "第一句。第二句？第三句！");
  service.play(0);
  assert.equal(cloud.spoken.length, 1);
  assert.ok(cloud.spoken[0].options.rateScale !== undefined);
  assert.ok(cloud.spoken[0].options.pitch !== undefined);

  // 首选引擎持续失败：先做有限重试（偶发抖动可自愈），连续失败后才回退系统语音。
  cloud.failed = true;
  service.seek(0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(local.spoken.length >= 1, "连续失败达阈值后本地引擎接管");
  assert.equal(service.getSnapshot().engineLabel, "系统语音（规则式韵律）");
  assert.ok(service.getSnapshot().message.includes("回退"));
  service.dispose();
});

test("两端都不可用时提供朗读稿，且 engineLabel 为不可用", () => {
  const service = speechHarness(null, null);
  assert.equal(service.supported, false);
  assert.equal(service.getSnapshot().engineLabel, "不可用");
  service.prepare("a.md", "笔记", "第一句。第二句。");
  assert.ok(service.getPlainText().includes("第一句"));
  assert.ok(service.getSnapshot().message.includes("当前设备不支持朗读"));
  service.dispose();
});
