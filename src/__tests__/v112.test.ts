import assert from "node:assert/strict";
import test from "node:test";
import { SpeechService, type SpeechServiceOptions } from "../data/SpeechService";
import { mdToSpeechChunks } from "../speech/chunks";
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechProgressStore,
  SpeechVoice,
} from "../speech/types";
import { DEFAULT_SETTINGS, type ReadProgress } from "../types";
import { normalizeSettings } from "../domain/pluginData";
import { SPEED_OPTIONS_MIN, SPEED_OPTIONS_MAX } from "../ui/SpeechBar";

const LONG_MD = "中文朗读内容".repeat(90) + "。";

/** 内存首选引擎：可模拟异步合成、瞬时错误、prefetch 调用。 */
class PreferredEngine implements SpeechEngine {
  label = "首选神经语音";
  needsKeepAlive = false;
  spoken: Array<{ text: string; options: SpeakOptions }> = [];
  prefetched: string[] = [];
  cancelCount = 0;
  speaking = false;
  paused = false;
  /** 每次 speak 报错（用于测试有限重试）。 */
  failTimes = 0;
  private handlers: SpeakHandlers | null = null;

  supported(): boolean { return true; }
  getVoices(): SpeechVoice[] { return [{ name: "Neural", lang: "zh-CN" }]; }
  speak(text: string, options: SpeakOptions, handlers: SpeakHandlers): void {
    this.spoken.push({ text, options });
    this.handlers = handlers;
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      this.speaking = false;
      handlers.onError("audio-playback-failed");
      return;
    }
    this.speaking = true;
    this.paused = false;
    handlers.onStart();
  }
  prefetch(text: string, _options: SpeakOptions): void { this.prefetched.push(text); }
  cancel(): void {
    this.cancelCount += 1;
    this.speaking = false;
    this.paused = false;
    this.handlers = null;
  }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  isSpeaking(): boolean { return this.speaking; }
  isPaused(): boolean { return this.paused; }
  finishCurrent(): void {
    this.speaking = false;
    const h = this.handlers;
    this.handlers = null;
    h?.onEnd();
  }
}

class LocalEngine implements SpeechEngine {
  label = "系统语音";
  needsKeepAlive = true;
  spoken: string[] = [];
  speaking = false;
  paused = false;
  private handlers: SpeakHandlers | null = null;
  supported(): boolean { return true; }
  getVoices(): SpeechVoice[] { return []; }
  speak(text: string, _o: SpeakOptions, handlers: SpeakHandlers): void {
    this.spoken.push(text);
    this.handlers = handlers;
    this.speaking = true;
    handlers.onStart();
  }
  cancel(): void { this.speaking = false; this.handlers = null; }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  isSpeaking(): boolean { return this.speaking; }
  isPaused(): boolean { return this.paused; }
  finishCurrent(): void {
    this.speaking = false;
    const h = this.handlers; h?.onEnd();
  }
}

function harness(): {
  service: SpeechService;
  preferred: PreferredEngine;
  local: LocalEngine;
  store: Map<string, ReadProgress | null>;
} {
  const store = new Map<string, ReadProgress | null>();
  const progress: SpeechProgressStore = {
    get: (p) => store.get(p) ?? null,
    set: (p, v) => { if (v) store.set(p, v); else store.delete(p); },
  };
  const preferred = new PreferredEngine();
  const local = new LocalEngine();
  const options: SpeechServiceOptions = {
    engine: local,
    preferredEngine: preferred,
    mobile: false,
    progress,
    now: () => 1000,
    keepAliveMs: 0,
    silenceMs: 0,
    // P2-1：同步调度器让既有断言保持确定性；退避时序另有用例专门验证。
    scheduleRetry: (run) => run(),
  };
  return { service: new SpeechService(options), preferred, local, store };
}

test("事项2：暂停后拖动进度条，点继续朗读直接重新合成当前块（无需停止再从断点续读）", () => {
  const { service, preferred } = harness();
  const chunks = mdToSpeechChunks(LONG_MD);
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  assert.equal(service.getSnapshot().state, "playing");
  assert.equal(preferred.spoken.length, 1);

  service.pause();
  assert.equal(service.getSnapshot().state, "paused");

  // 暂停态拖动到第 3 段：不立即发声，仍处于暂停。
  service.seek(3);
  assert.equal(service.getSnapshot().state, "paused");
  assert.equal(service.getSnapshot().idx, 3);
  const countBeforeResume = preferred.spoken.length;

  // 继续朗读：应重新合成第 3 段，而不是对已销毁的音频调用 resume()。
  service.resume();
  assert.equal(service.getSnapshot().state, "playing");
  assert.equal(preferred.spoken.length, countBeforeResume + 1);
  assert.equal(preferred.spoken.at(-1)?.text, chunks[3].text);
});

test("事项2：播放中拖动仍立即重新合成，行为不变", () => {
  const { service, preferred } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  const before = preferred.spoken.length;
  service.seek(5);
  assert.equal(preferred.spoken.length, before + 1);
  assert.equal(service.getSnapshot().state, "playing");
});

test("事项3：偶发失败先重试不切系统语音；连续失败达阈值才回退", () => {
  const { service, preferred, local } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  // 先让引擎成功一次，确认走的是首选引擎。
  service.play(0);
  assert.equal(preferred.spoken.length, 1);
  service.stop(true);

  // 模拟 1 次瞬时失败：应重试首选引擎，不回退系统语音。
  preferred.failTimes = 1;
  service.play(0);
  assert.ok(preferred.spoken.length >= 3, "应触发重试重新合成");
  assert.equal(local.spoken.length, 0, "偶发失败不应切系统语音");
  assert.equal(service.getSnapshot().state, "playing");
  service.stop(true);

  // 连续多次失败：达到阈值后回退系统语音。
  preferred.failTimes = 10;
  service.play(0);
  assert.ok(local.spoken.length >= 1, "连续失败应回退系统语音");
});

test("事项3：speakCurrent 会预取下一块，命中缓存可消除延迟", () => {
  const { service, preferred } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  const chunks = mdToSpeechChunks(LONG_MD);
  service.play(0);
  assert.ok(preferred.prefetched.length >= 1, "应预合成下一块");
  assert.equal(preferred.prefetched[0], chunks[1].text);
});

test("事项4：Piper 字段已移除，旧的 piper 值平滑迁移到 system", () => {
  assert.equal("piperModelDir" in DEFAULT_SETTINGS, false);
  assert.equal("piperVoiceId" in DEFAULT_SETTINGS, false);
  const migrated = normalizeSettings({ speechEngine: "piper" });
  assert.equal(migrated.speechEngine, "system");
  const kept = normalizeSettings({ speechEngine: "edge" });
  assert.equal(kept.speechEngine, "edge");
});

test("事项5：朗读窗口语速档位覆盖常用区间且包含 1× 正常", () => {
  // 数值常量从 SpeechBar 暴露，确保设置页文本框与弹窗下拉口径一致。
  assert.ok(SPEED_OPTIONS_MIN <= 1 && SPEED_OPTIONS_MAX >= 2);
});

// P1-1 / P1-2：失败诊断要能穿透「自动回退系统语音」，让用户知道为什么降级；
// 首选引擎自己恢复出声、或用户改配置刷新后，诊断才清零。
test("P1-1/P1-2：失败诊断回传朗读能力快照，回退系统语音后仍可见", () => {
  const { service, preferred, local } = harness();
  preferred.failTimes = 3; // 连续失败，触发回退
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  assert.ok(local.spoken.length > 0, "连续失败后应回退到系统语音");
  assert.equal(service.getSnapshot().engineLastError, "audio-playback-failed");

  service.refreshPreferred(); // 用户改了配置 / 热修版本号
  assert.equal(service.getSnapshot().engineLastError, undefined);
});

test("P1-1/P1-2：首选引擎重试成功后诊断自动清零", () => {
  const { service, preferred } = harness();
  preferred.failTimes = 1; // 一次抖动，重试即成功
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  assert.ok(preferred.spoken.length >= 2, "应发生一次有限重试");
  assert.equal(service.getSnapshot().engineLastError, undefined);
});
