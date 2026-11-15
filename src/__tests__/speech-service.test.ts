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
import type { ReadProgress } from "../types";

const LONG_MD = "中文朗读内容".repeat(90) + "。";

class MockSpeechEngine implements SpeechEngine {
  readonly voices: SpeechVoice[] = [
    { name: "Alex", lang: "en-US" },
    { name: "Ting-Ting", lang: "zh-CN" },
  ];
  readonly spoken: Array<{ text: string; options: SpeakOptions }> = [];
  cancelled = 0;
  pauseCount = 0;
  resumeCount = 0;
  speaking = false;
  paused = false;
  /** 模拟手机 WebView：接口存在但永远不发声、不触发 onstart。 */
  silent = false;
  private handlers: SpeakHandlers | null = null;

  supported(): boolean {
    return true;
  }
  getVoices(): SpeechVoice[] {
    return this.voices;
  }
  speak(text: string, options: SpeakOptions, handlers: SpeakHandlers): void {
    this.spoken.push({ text, options });
    this.handlers = handlers;
    if (!this.silent) {
      this.speaking = true;
      handlers.onStart();
    }
  }
  cancel(): void {
    this.cancelled += 1;
    this.speaking = false;
    this.paused = false;
    this.handlers = null;
  }
  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
  }
  resume(): void {
    this.resumeCount += 1;
    this.paused = false;
  }
  isSpeaking(): boolean {
    return this.speaking;
  }
  isPaused(): boolean {
    return this.paused;
  }

  /** 触发当前 utterance 正常结束。 */
  finishCurrent(): void {
    this.speaking = false;
    const handlers = this.handlers;
    this.handlers = null;
    handlers?.onEnd();
  }
  errorCurrent(message: string): void {
    this.speaking = false;
    const handlers = this.handlers;
    this.handlers = null;
    handlers?.onError(message);
  }
  /** 捕获旧 utterance 的 onend，用于验证 token 隔离。 */
  captureEnd(): () => void {
    const handlers = this.handlers;
    return () => handlers?.onEnd();
  }
}

interface Harness {
  service: SpeechService;
  engine: MockSpeechEngine;
  store: Map<string, ReadProgress | null>;
}

function harness(options: Partial<SpeechServiceOptions> = {}): Harness {
  const store = new Map<string, ReadProgress | null>();
  const progress: SpeechProgressStore = {
    get: (path) => store.get(path) ?? null,
    set: (path, value) => {
      if (value) store.set(path, value);
      else store.delete(path);
    },
  };
  const engine = new MockSpeechEngine();
  const service = new SpeechService({
    engine,
    mobile: false,
    progress,
    now: () => 1000,
    keepAliveMs: 0,
    silenceMs: 0,
    ...options,
  });
  return { service, engine, store };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("全链路：播放 → 自动下一块 → 暂停 → 继续 → 停止保存断点", () => {
  const { service, engine, store } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  assert.ok(service.getSnapshot().total >= 3);
  assert.equal(service.getSnapshot().resumable, false);

  service.play(0);
  assert.equal(service.getSnapshot().state, "playing");
  assert.equal(engine.spoken.length, 1);
  assert.equal(store.get("a.md")?.idx, 0);

  engine.finishCurrent();
  assert.equal(engine.spoken.length, 2);
  assert.equal(service.getSnapshot().idx, 1);

  service.pause();
  assert.equal(service.getSnapshot().state, "paused");
  assert.ok(engine.pauseCount >= 1);
  assert.equal(store.get("a.md")?.idx, 1);

  service.resume();
  assert.equal(service.getSnapshot().state, "playing");
  assert.ok(engine.resumeCount >= 1);

  service.stop(true);
  assert.equal(service.getSnapshot().state, "stopped");
  assert.ok(service.getSnapshot().message.includes("断点"));
  assert.equal(store.get("a.md")?.idx, 1);
});

test("断点续读：分块数一致才恢复，笔记被编辑后从头开始", () => {
  const { service, engine, store } = harness();
  const chunks = mdToSpeechChunks(LONG_MD);
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  engine.finishCurrent();
  service.stop(true);
  assert.equal(store.get("a.md")?.idx, 1);

  service.prepare("a.md", "笔记 A", LONG_MD);
  assert.equal(service.getSnapshot().resumable, true);
  assert.equal(service.getSnapshot().idx, 1);
  service.play();
  assert.equal(service.getSnapshot().idx, 1);
  assert.equal(engine.spoken[engine.spoken.length - 1].text, chunks[1].text);

  service.stop(true);
  service.prepare("a.md", "笔记 A", "很短的笔记。");
  assert.equal(service.getSnapshot().resumable, false);
  assert.equal(service.getSnapshot().idx, 0);
});

test("读到最后一块：清除断点、回到 idle", () => {
  const { service, engine, store } = harness();
  service.prepare("a.md", "笔记 A", "只有一句。");
  assert.equal(service.getSnapshot().total, 1);
  service.play(0);
  engine.finishCurrent();
  assert.equal(store.get("a.md"), undefined);
  assert.equal(service.getSnapshot().state, "idle");
  assert.equal(service.getSnapshot().idx, 1);
  assert.ok(service.getSnapshot().message.includes("朗读完成"));
});

test("拖动进度 seek：跳转后重说当前块并写回断点", () => {
  const { service, engine, store } = harness();
  const chunks = mdToSpeechChunks(LONG_MD);
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  const before = engine.spoken.length;
  service.seek(3);
  assert.equal(service.getSnapshot().idx, 3);
  assert.equal(engine.spoken.length, before + 1);
  assert.equal(engine.spoken[engine.spoken.length - 1].text, chunks[3].text);
  assert.equal(store.get("a.md")?.idx, 3);
});

test("token 隔离：旧 utterance 的 onend 不会推进新状态", () => {
  const { service, engine } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  const staleEnd = engine.captureEnd();
  service.seek(2);
  assert.equal(service.getSnapshot().idx, 2);
  staleEnd();
  assert.equal(service.getSnapshot().idx, 2);
  assert.equal(service.getSnapshot().state, "playing");
});

test("中文音色优先、语速与音色变更立即生效、错误有中文提示", () => {
  const { service, engine } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  assert.equal(engine.spoken[0].options.voice?.lang, "zh-CN");
  assert.equal(engine.spoken[0].options.lang, "zh-CN");

  service.setRate(2.5);
  assert.equal(service.getSnapshot().rate, 2.5);
  assert.equal(engine.spoken[engine.spoken.length - 1].options.rate, 2.5);
  service.setPreferChineseVoice(false);
  assert.equal(engine.spoken[engine.spoken.length - 1].options.voice, null);

  engine.errorCurrent("synthesis-failed");
  assert.equal(service.getSnapshot().state, "idle");
  assert.ok(service.getSnapshot().message.includes("朗读出错"));
});

test("切换笔记时停止并保存断点", () => {
  const { service, store } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  service.onActiveFileChanged("b.md");
  assert.equal(service.getSnapshot().state, "stopped");
  assert.ok(service.getSnapshot().message.includes("切换"));
  assert.ok(store.get("a.md"));
});

test("能力不可用：中文降级提示、按钮数据齐全、不崩溃", () => {
  const store = new Map<string, ReadProgress | null>();
  const progress: SpeechProgressStore = {
    get: (path) => store.get(path) ?? null,
    set: (path, value) => {
      if (value) store.set(path, value);
      else store.delete(path);
    },
  };
  const service = new SpeechService({
    engine: null,
    mobile: true,
    progress,
    keepAliveMs: 0,
    silenceMs: 0,
  });
  assert.equal(service.supported, false);
  assert.ok(service.getSnapshot().message.includes("当前设备不支持朗读"));
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  assert.equal(service.getSnapshot().state, "idle");
  assert.ok(service.getSnapshot().total > 0);
  assert.ok(service.getSnapshot().message.includes("当前设备不支持朗读"));
  service.dispose();
});

test("静音超时：手机端无声自动降级，不留下正在播放状态", async () => {
  const { service, engine } = harness({ silenceMs: 5 });
  engine.silent = true;
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  await delay(30);
  assert.ok(service.getSnapshot().message.includes("当前设备不支持朗读"));
  assert.equal(service.getSnapshot().state, "idle");
  service.dispose();
});

test("保活定时器：长时间播放会周期性 pause/resume", async () => {
  const { service, engine } = harness({ keepAliveMs: 5 });
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  assert.equal(engine.isSpeaking(), true);
  await delay(30);
  assert.ok(engine.pauseCount > 0, "应触发保活 pause");
  assert.ok(engine.resumeCount > 0, "应触发保活 resume");
  service.dispose();
});

test("dispose：cancel 语音、保存断点、之后不再发声", () => {
  const { service, engine, store } = harness();
  service.prepare("a.md", "笔记 A", LONG_MD);
  service.play(0);
  const before = engine.spoken.length;
  service.dispose();
  assert.ok(engine.cancelled >= 1);
  assert.equal(store.get("a.md")?.idx, 0);
  service.play(0);
  assert.equal(engine.spoken.length, before);
});
