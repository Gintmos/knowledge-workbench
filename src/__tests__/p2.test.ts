/**
 * 第四步（工程债清理）回归：P2-1 短退避、P2-2 预取 token 隔离、
 * P2-3 共享音频核心、P2-4 cloudEngine 死路径、P2-6/P2-7 宿主 API。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { SpeechService, type SpeechServiceOptions } from "../data/SpeechService";
import { mdToSpeechChunks } from "../speech/chunks";
import {
  createAudioCache,
  createAudioEngineCore,
  type AudioLike,
} from "../speech/audioCore";
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechProgressStore,
  SpeechVoice,
} from "../speech/types";
import type { ReadProgress } from "../types";

const source = (path: string): string =>
  readFileSync(join(process.cwd(), path), "utf8");
const LONG_MD = "中文朗读内容".repeat(90) + "。";

/** 可记录预取守卫、可配置失败次数的内存首选引擎。 */
class PreferredEngine implements SpeechEngine {
  label = "首选神经语音";
  needsKeepAlive = false;
  spoken: string[] = [];
  prefetched: Array<{ text: string; isStale?: () => boolean }> = [];
  failTimes = 0;
  private handlers: SpeakHandlers | null = null;

  supported(): boolean { return true; }
  getVoices(): SpeechVoice[] { return [{ name: "Neural", lang: "zh-CN" }]; }
  speak(text: string, _o: SpeakOptions, handlers: SpeakHandlers): void {
    this.spoken.push(text);
    this.handlers = handlers;
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      handlers.onError("audio-playback-failed");
      return;
    }
    handlers.onStart();
  }
  prefetch(text: string, _o: SpeakOptions, isStale?: () => boolean): void {
    this.prefetched.push({ text, isStale });
  }
  cancel(): void { this.handlers = null; }
  pause(): void {}
  resume(): void {}
  isSpeaking(): boolean { return Boolean(this.handlers); }
  isPaused(): boolean { return false; }
}

class LocalEngine implements SpeechEngine {
  label = "系统语音";
  needsKeepAlive = true;
  spoken: string[] = [];
  private handlers: SpeakHandlers | null = null;
  supported(): boolean { return true; }
  getVoices(): SpeechVoice[] { return []; }
  speak(text: string, _o: SpeakOptions, handlers: SpeakHandlers): void {
    this.spoken.push(text);
    this.handlers = handlers;
    handlers.onStart();
  }
  cancel(): void { this.handlers = null; }
  pause(): void {}
  resume(): void {}
  isSpeaking(): boolean { return Boolean(this.handlers); }
  isPaused(): boolean { return false; }
}

interface Harness {
  service: SpeechService;
  preferred: PreferredEngine;
  local: LocalEngine;
  /** 记录每次退避的延迟；runs 由测试手动驱动，保证时序可核对。 */
  delays: number[];
  runs: Array<() => void>;
}

function harness(overrides: Partial<SpeechServiceOptions> = {}): Harness {
  const store = new Map<string, ReadProgress | null>();
  const progress: SpeechProgressStore = {
    get: (p) => store.get(p) ?? null,
    set: (p, v) => { if (v) store.set(p, v); else store.delete(p); },
  };
  const preferred = new PreferredEngine();
  const local = new LocalEngine();
  const delays: number[] = [];
  const runs: Array<() => void> = [];
  const service = new SpeechService({
    engine: local,
    preferredEngine: preferred,
    mobile: false,
    progress,
    now: () => 1000,
    keepAliveMs: 0,
    silenceMs: 0,
    // 退避由测试手动推进，既能核对延迟数值，也能模拟「停止后回调才到期」。
    scheduleRetry: (run, delayMs) => { runs.push(run); delays.push(delayMs); },
    ...overrides,
  });
  return { service, preferred, local, delays, runs };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, 0); });

const opts: SpeakOptions = { rate: 1, lang: "zh-CN", voice: null };

// ── P2-1 短退避 ──────────────────────────────────────────────
test("P2-1 01 · 连续失败按 300 / 600ms 短退避，不再瞬间连打 3 次", () => {
  const { service, preferred, delays, runs } = harness();
  preferred.failTimes = 10;
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);

  // 首次失败只排入一次退避任务，尚未立即重说。
  assert.deepEqual(delays, [300]);
  assert.equal(preferred.spoken.length, 1);
  assert.equal(runs.length, 1);

  runs.shift()?.(); // 第 1 次退避到期
  assert.deepEqual(delays, [300, 600], "第 2 次退避应为 600ms");
  assert.equal(preferred.spoken.length, 2);

  const second = runs.shift();
  second?.(); // 第 2 次退避到期 → 达到阈值，回退系统语音
  assert.deepEqual(delays, [300, 600], "不再产生第 3 次退避");
  assert.ok(preferred.spoken.length >= 3);
  assert.ok(service.getSnapshot().message.includes("回退"));
  service.stop(false);
});

test("P2-1 02 · 停止 / 切笔记后到期的退避回调自动作废，不重说", () => {
  const { service, preferred, runs } = harness();
  preferred.failTimes = 10;
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  const pending = runs.shift();
  assert.ok(pending, "应存在一个在途重试");

  service.stop(false); // clearTimers() 递增 retryTicket
  const before = preferred.spoken.length;
  pending?.();
  assert.equal(preferred.spoken.length, before, "过期回调不得重新发声");
});

test("P2-1 03 · 改配置后退避计数归零，可立即重新尝试首选引擎", () => {
  const { service, preferred, delays, runs } = harness();
  preferred.failTimes = 10;
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  assert.deepEqual(delays, [300]);
  runs.length = 0;

  service.refreshPreferred(); // 用户改了密钥 / 版本号
  assert.equal(service.getSnapshot().engineLastError, undefined);
  preferred.failTimes = 0;
  service.play(0);
  assert.equal(delays.length, 1, "新一轮只产生一次退避排程记录");
  service.stop(false);
});

// ── P2-2 预取 token 隔离 ─────────────────────────────────────
test("P2-2 01 · 预取携带会话守卫，切笔记后守卫返回 true", () => {
  const { service, preferred } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  assert.ok(preferred.prefetched.length >= 1, "应预取下一块");
  const first = preferred.prefetched[0];
  assert.equal(first.text, mdToSpeechChunks(LONG_MD)[1].text);
  assert.ok(typeof first.isStale === "function", "必须传入失效守卫");
  assert.equal(first.isStale?.(), false, "同一会话内有效");

  service.prepare("b.md", "笔记 B", LONG_MD); // token 与 path 都变化
  assert.equal(first.isStale?.(), true, "切笔记后旧预取必须判为失效");
  service.stop(false);
});

test("P2-2 02 · 停止后守卫返回 true，预取结果不写入缓存", () => {
  const { service, preferred } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  const guard = preferred.prefetched[0]?.isStale;
  assert.equal(guard?.(), false);
  service.stop(false);
  assert.equal(guard?.(), true, "停止后旧预取必须判为失效");
});

// ── P2-3 共享音频核心 ────────────────────────────────────────
class FakeAudio implements AudioLike {
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  ended = false;
  play(): Promise<void> { return Promise.resolve(); }
  pause(): void { this.paused = true; }
  removeAttribute(): void {}
}

function coreHarness(synth: (text: string) => Promise<string>) {
  let synthesized = 0;
  const audio = new FakeAudio();
  const engine = createAudioEngineCore({
    label: "共享核心测试",
    supported: () => true,
    getVoices: () => [],
    cacheKey: (text) => text,
    synthesize: (text) => { synthesized += 1; return synth(text); },
    describeError: (e) => String(e),
    createAudio: () => audio,
  });
  return { engine, audio, get synthesized() { return synthesized; } };
}

test("P2-3 01 · 共享缓存命中后不再重复合成", async () => {
  const h = coreHarness(async (t) => `data:${t}`);
  let ended = 0;
  h.engine.speak("第一句", opts, {
    onStart: () => {}, onEnd: () => { ended += 1; }, onError: () => {},
  });
  await tick();
  h.audio.onplaying?.();
  h.audio.onended?.();
  assert.equal(ended, 1);

  h.engine.speak("第一句", opts, {
    onStart: () => {}, onEnd: () => { ended += 1; }, onError: () => {},
  });
  await tick();
  h.audio.onplaying?.();
  h.audio.onended?.();
  assert.equal(ended, 2);
  assert.equal(h.synthesized, 1, "第二次应命中缓存，不联网");
});

test("P2-3 02 · 预取失效时丢弃结果，不占用缓存名额", async () => {
  const h = coreHarness(async (t) => `data:${t}`);
  h.engine.prefetch?.("第一句", opts, () => true);
  await tick();
  assert.equal(h.synthesized, 1, "合成确实发生过");

  // 缓存未写入 → 正式播放必须重新合成。
  h.engine.speak("第一句", opts, {
    onStart: () => {}, onEnd: () => {}, onError: () => {},
  });
  await tick();
  assert.equal(h.synthesized, 2, "失效预取不能污染缓存");
});

test("P2-3 03 · 有效预取写入缓存，播放直接命中", async () => {
  const h = coreHarness(async (t) => `data:${t}`);
  h.engine.prefetch?.("第一句", opts, () => false);
  await tick();
  h.engine.speak("第一句", opts, {
    onStart: () => {}, onEnd: () => {}, onError: () => {},
  });
  await tick();
  assert.equal(h.synthesized, 1, "预取与播放共享同一次合成");
});

test("P2-3 04 · speak 与 prefetch 并发时共享一次网络合成", async () => {
  const pending: { resolve?: (v: string) => void } = {};
  const h = coreHarness(
    () => new Promise<string>((resolve) => { pending.resolve = resolve; }),
  );
  h.engine.prefetch?.("第一句", opts, () => false);
  h.engine.speak("第一句", opts, {
    onStart: () => {}, onEnd: () => {}, onError: () => {},
  });
  assert.equal(h.synthesized, 1, "并发去重，只发起一个请求");
  pending.resolve?.("data:ok");
  await tick();
  assert.equal(h.synthesized, 1);
});

test("P2-3 05 · 缓存上限生效且为 LRU（命中刷新热度）", () => {
  const cache = createAudioCache<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1, "命中 a");
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined, "最久未用的 b 应被淘汰");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("P2-3 06 · cancel 后旧的 onplaying 回调不再触发 onStart", async () => {
  const h = coreHarness(async (t) => `data:${t}`);
  let started = 0;
  h.engine.speak("第一句", opts, {
    onStart: () => { started += 1; }, onEnd: () => {}, onError: () => {},
  });
  await tick();
  const stale = h.audio.onplaying;
  h.engine.cancel();
  stale?.();
  assert.equal(started, 0, "token 隔离必须挡住过期回调");
});

// ── P2-4 死路径清除 ─────────────────────────────────────────
test("P2-4 01 · SpeechService 不再有 cloudEngine / cloudFailed / refreshCloud", () => {
  const speech = source(join("src", "data", "SpeechService.ts"));
  for (const dead of ["cloudEngine", "cloudFailed", "refreshCloud", "this.cloud"]) {
    assert.equal(speech.includes(dead), false, `死路径残留：${dead}`);
  }
  assert.ok(speech.includes("preferredEngine"), "首选引擎单路径仍在");
});

test("P2-4 02 · 两个联网引擎都复用共享核心，不再各自维护 audio/cache", () => {
  const edge = source(join("src", "speech", "edgeEngine.ts"));
  const cloud = source(join("src", "speech", "cloud.ts"));
  for (const file of [edge, cloud]) {
    assert.ok(file.includes("createAudioEngineCore"), "应复用共享核心");
    assert.equal(/new Audio\(/.test(file), false, "播放逻辑不应重复");
    assert.equal(/new Map<string, string>/.test(file), false, "缓存逻辑不应重复");
  }
  // 网关仍是唯一 requestUrl 使用点，且错误脱敏保留。
  assert.ok(cloud.includes("requestUrl("));
  assert.ok(cloud.includes("summarizeRequestError"));
});

// ── P2-6 / P2-7 宿主 API ────────────────────────────────────
test("P2-6/7 01 · 源码零 globalThis，rAF 走 activeWindow", () => {
  const files = [
    join("src", "data", "SpeechService.ts"),
    join("src", "data", "StoreService.ts"),
    join("src", "data", "VaultIndexService.ts"),
    join("src", "data", "IcsService.ts"),
    join("src", "domain", "batchScan.ts"),
    join("src", "ui", "WorkbenchView.ts"),
  ];
  for (const file of files) {
    assert.equal(/\bglobalThis\./.test(source(file)), false, `${file} 仍有 globalThis`);
  }
  const view = source(join("src", "ui", "WorkbenchView.ts"));
  assert.ok(view.includes("activeWindow.requestAnimationFrame"));
  assert.equal(/(?:^|[^.\w])requestAnimationFrame\s*\(/.test(view), false,
    "不得使用裸 requestAnimationFrame");
});
