import assert from "node:assert/strict";
import test from "node:test";
import { cleanMarkdownLine } from "../domain/speechText";
import { mdToSpeechText } from "../speech/speechText";
import {
  chunksCoverText,
  mdToSpeechChunks,
  SPEECH_CHUNK_LIMIT,
  splitSpeechChunks,
} from "../speech/chunks";
import { pickChineseVoice } from "../speech/engine";
import {
  clampIndex,
  clampRate,
  detectSilence,
  initialMachine,
  ratioForIndex,
  ratioFromPointer,
  resumeIndex,
  seekFromRatio,
  speechTransition,
  toReadProgress,
} from "../speech/machine";

const REAL_NOTE = `---
title: 测试笔记
tags: [项目/重点]
---

# 第一章 🚀 概览

这是正文第一段，包含 [[另一篇笔记#章节|别名]] 和 #项目/重点 标签。

| 列一 | 列二 |
| :--- | ---: |
| 数值甲 | 数值乙 |

\`\`\`js
const noise = "代码块不应朗读";
\`\`\`

- 列表项一
- 列表项二

> 引用内容
`;

test("朗读文本：v14 三类噪音全部为 0 且不丢字", () => {
  const text = mdToSpeechText(REAL_NOTE);
  const noises = [
    ":---",
    "---:",
    "|",
    "[[",
    "#章节",
    "#项目/重点",
    "🚀",
    "```",
    "const noise",
    "代码块不应朗读",
    "title: 测试笔记",
    "<",
    ">",
  ];
  for (const noise of noises) {
    assert.equal(text.includes(noise), false, `朗读噪音残留：${noise}`);
  }
  const kept = [
    "第一章",
    "概览",
    "这是正文第一段",
    "包含",
    "别名",
    "标签",
    "数值甲",
    "数值乙",
    "列表项一",
    "列表项二",
    "引用内容",
  ];
  for (const word of kept) {
    assert.ok(text.includes(word), `正文文字被误删：${word}`);
  }
  assert.equal(text.includes("\n\n"), false, "段落之间只用一个换行分隔，不出现空朗读段");
});

test("清洗规则共用：P3 摘要仍跳过表格行，P5 朗读保留表格文字", () => {
  const row = "| 数值甲 | 数值乙 |";
  assert.equal(cleanMarkdownLine(row), "");
  const spoken = cleanMarkdownLine(row, { keepTableRows: true });
  assert.ok(spoken.includes("数值甲"));
  assert.ok(spoken.includes("数值乙"));
  assert.equal(cleanMarkdownLine("| :--- | ---: |", { keepTableRows: true }), "");
});

test("分块：标点优先、不超过上限、拼接后不丢字不重复", () => {
  assert.deepEqual(splitSpeechChunks(""), []);
  assert.deepEqual(splitSpeechChunks("   \n  "), []);
  const short = splitSpeechChunks("这是第一句。这是第二句！", 160);
  assert.equal(short.length, 1);
  assert.equal(short[0].text, "这是第一句。 这是第二句！");
  assert.equal(short[0].start, 0);

  const long = "中文朗读内容".repeat(90) + "。";
  const chunks = splitSpeechChunks(long, 60);
  assert.ok(chunks.length >= 8, `应切成多块，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 60, "单块不能超过 maxLen");
  }
  assert.ok(chunksCoverText(long, chunks), "拼接后应与原文一致（去空白）");
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[chunks.length - 1].end, long.length);
});

test("分块：孤立句首标点不丢字，md → 分块覆盖全文", () => {
  assert.ok(chunksCoverText("，你好。", splitSpeechChunks("，你好。")));
  const text = mdToSpeechText(REAL_NOTE);
  const chunks = mdToSpeechChunks(REAL_NOTE);
  assert.ok(chunks.length >= 1);
  assert.ok(chunksCoverText(text, chunks));
  assert.equal(mdToSpeechChunks("").length, 0);
  assert.equal(SPEECH_CHUNK_LIMIT, 160);
});

test("SP 状态机：合法迁移、非法迁移不改变状态、token 隔离", () => {
  let machine = initialMachine();
  assert.deepEqual(machine, { state: "idle", token: 0, idx: 0, total: 0 });

  machine = speechTransition(machine, { type: "start", total: 5, from: 2 });
  assert.equal(machine.state, "playing");
  assert.equal(machine.idx, 2);
  assert.equal(machine.token, 1);

  const paused = speechTransition(machine, { type: "pause" });
  assert.equal(paused.state, "paused");
  assert.equal(speechTransition(paused, { type: "pause" }), paused, "非法迁移应返回原对象");
  assert.equal(speechTransition(paused, { type: "resume" }).state, "playing");

  const seeked = speechTransition(machine, { type: "seek", idx: 99 });
  assert.equal(seeked.idx, 4, "seek 越界应 clamp 到 total-1");
  assert.equal(seeked.token, machine.token + 1);
  assert.equal(speechTransition(seeked, { type: "next" }), seeked, "最后一块不能再 next");

  const stopped = speechTransition(machine, { type: "stop" });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.token, machine.token + 1);
  assert.equal(speechTransition(stopped, { type: "finish" }).state, "idle");
  assert.equal(speechTransition(stopped, { type: "finish" }).idx, 5);
  assert.equal(speechTransition(stopped, { type: "error" }).state, "idle");
  assert.equal(speechTransition(machine, { type: "start", total: 0 }).state, "idle");
});

test("断点：分块数一致才可续读，进度写回结构正确", () => {
  assert.equal(resumeIndex(null, 10), 0);
  assert.equal(resumeIndex({ idx: 4, total: 10, at: 1 }, 10), 4);
  assert.equal(resumeIndex({ idx: 4, total: 9, at: 1 }, 10), 0, "笔记编辑后从头开始");
  assert.equal(resumeIndex({ idx: 99, total: 10, at: 1 }, 10), 9);
  const machine = speechTransition(initialMachine(), { type: "start", total: 10, from: 3 });
  assert.deepEqual(toReadProgress(machine, 123), { idx: 3, total: 10, at: 123 });
});

test("进度条：比例换算与拖动边界", () => {
  assert.equal(ratioForIndex(0, 0), 0);
  assert.equal(ratioForIndex(0, 4), 0.25);
  assert.equal(ratioForIndex(3, 4), 1);
  assert.equal(seekFromRatio(0, 10), 0);
  assert.equal(seekFromRatio(1, 10), 9);
  assert.equal(seekFromRatio(0.5, 10), 5);
  assert.equal(seekFromRatio(-3, 10), 0);
  assert.equal(seekFromRatio(Number.NaN, 10), 0);
  assert.equal(seekFromRatio(0.5, 0), 0);
  assert.equal(ratioFromPointer(150, 100, 200), 0.25);
  assert.equal(ratioFromPointer(0, 100, 200), 0);
  assert.equal(ratioFromPointer(500, 100, 200), 1);
  assert.equal(ratioFromPointer(150, 100, 0), 0);
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(clampIndex(9, 3), 2);
});

test("语速、中文音色与静音检测", () => {
  assert.equal(clampRate(0.1), 0.5);
  assert.equal(clampRate(9), 3);
  assert.equal(clampRate(1.4), 1.4);
  assert.equal(clampRate(Number.NaN), 1);
  const voices = [
    { name: "Alex", lang: "en-US" },
    { name: "Ting-Ting", lang: "zh-CN" },
    { name: "Sinji", lang: "zh-HK" },
  ];
  assert.equal(pickChineseVoice(voices, true)?.name, "Ting-Ting");
  assert.equal(pickChineseVoice(voices, false), null);
  assert.equal(
    pickChineseVoice([{ name: "Alex", lang: "en-US" }], true),
    null,
    "没有中文音色时回退系统默认",
  );
  assert.equal(
    detectSilence({ elapsedMs: 4000, started: false, speaking: false, thresholdMs: 4000 }),
    true,
  );
  assert.equal(
    detectSilence({ elapsedMs: 4000, started: true, speaking: false, thresholdMs: 4000 }),
    false,
  );
  assert.equal(
    detectSilence({ elapsedMs: 100, started: false, speaking: false, thresholdMs: 4000 }),
    false,
  );
});
