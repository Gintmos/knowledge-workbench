/**
 * 复审 V2（1.0.10）修复回归：
 * P1-1 内联标签替换（纯函数）、P1-2 staleDays 设置删除、
 * P2-1 语速动态档、P2-2/P2-3 死代码清理、P2-4/5/6 统计与今日页、
 * P2-7 弹窗两步确认。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  replaceInlineTags,
  splitFrontmatterLines,
} from "../domain/inlineTags";

const source = (path: string): string =>
  readFileSync(join(process.cwd(), path), "utf8");

// ── P1-1 · 内联标签替换 ────────────────────────────────────────

test("P1-1 01 · 带 frontmatter 的笔记正文标签正常替换（旧逻辑整体失效）", () => {
  const md = [
    "---",
    "tags:",
    "  - 行业研究",
    "note: 这行 #注释 不动",
    "---",
    "正文引用 #行业研究 与其他内容。",
    "第二段 #行业研究 再次出现。",
  ].join("\n");
  const next = replaceInlineTags(md, ["行业研究"], "行业观察", true);
  assert.ok(next.includes("#行业观察 与其他内容"), "第 1 处应被替换");
  assert.ok(next.includes("#行业观察 再次出现"), "第 2 处应被替换");
  assert.ok(!next.includes("#行业研究"), "正文不应残留旧标签");
  // frontmatter 区原样保留（含 YAML 行内 # 注释）。
  assert.ok(next.startsWith("---\ntags:\n  - 行业研究\nnote: 这行 #注释 不动\n---"), "frontmatter 逐字节保留");
});

test("P1-1 02 · 无 frontmatter 的笔记从第 1 行起即可替换（旧逻辑漏前 2 行）", () => {
  const md = ["第一行就有 #行业研究 标签。", "第二行 #行业研究 再来。", "第三行保持。"].join("\n");
  const next = replaceInlineTags(md, ["行业研究"], "行业观察", true);
  assert.equal(next, "第一行就有 #行业观察 标签。\n第二行 #行业观察 再来。\n第三行保持。");
});

test("P1-1 03 · 代码块内 #tag 不替换，代码块外的正常替换", () => {
  const md = [
    "---",
    "tags: []",
    "---",
    "正文 #行业研究 替换我。",
    "```js",
    "const x = '#行业研究'; // 代码块内不动",
    "```",
    "块后 #行业研究 也要替换。",
    "~~~",
    "const y = '#行业研究';",
    "~~~",
  ].join("\n");
  const next = replaceInlineTags(md, ["行业研究"], "行业观察", true);
  assert.ok(next.includes("const x = '#行业研究'"), "``` 代码块内不替换");
  assert.ok(next.includes("const y = '#行业研究'"), "~~~ 代码块内不替换");
  assert.ok(next.includes("正文 #行业观察 替换我"));
  assert.ok(next.includes("块后 #行业观察 也要替换"));
});

test("P1-1 04 · 子标签：includeChildren 保留层级后缀，关闭时子标签不动", () => {
  const md = "提到 #行业研究/汽车 和 #行业研究 本体。";
  const kept = replaceInlineTags(md, ["行业研究"], "行业观察", true);
  assert.ok(kept.includes("#行业观察/汽车"), "子标签后缀保留");
  assert.ok(kept.includes("#行业观察 本体"), "本体替换");
  const off = replaceInlineTags(md, ["行业研究"], "行业观察", false);
  assert.ok(off.includes("#行业研究/汽车"), "不含子标签时子标签不动");
  assert.ok(off.includes("#行业观察 本体"), "本体仍替换");
});

test("P1-1 05 · wiki 链接与 Markdown 链接里的 # 锚点不误伤", () => {
  const md = "看 [[笔记A#行业研究|别名]] 和 [说明](笔记B#行业研究) 以及 #行业研究 本体。";
  const next = replaceInlineTags(md, ["行业研究"], "行业观察", true);
  assert.ok(next.includes("[[笔记A#行业研究|别名]]"), "wiki 锚点保留");
  assert.ok(next.includes("[说明](笔记B#行业研究)"), "MD 链接锚点保留");
  assert.ok(next.includes("#行业观察 本体"), "正文裸标签替换");
});

test("P1-1 06 · 无命中时输出等价原文（frontmatter 逐字节保留，不产生多余变化）", () => {
  const md = "---\ntitle: x\n---\n正文 #无关 标签。";
  const next = replaceInlineTags(md, ["行业研究"], "行业观察", true);
  assert.equal(next, md);
});

test("P1-1 07 · 源标签带 # 前缀与大小写不敏感；未闭合 frontmatter 整体视为正文", () => {
  const md = "正文 #行业研究 标签。";
  assert.ok(replaceInlineTags(md, ["#行业研究"], "行业观察", true).includes("#行业观察"));
  const unclosed = "---\n没有闭合的伪 frontmatter #行业研究\n正文 #行业研究\n";
  const next = replaceInlineTags(unclosed, ["行业研究"], "行业观察", true);
  assert.ok(next.includes("#行业观察\n"), "未闭合时第 2 行也要替换");
  // splitFrontmatterLines：未闭合 → 整体正文。
  const split = splitFrontmatterLines(unclosed);
  assert.equal(split.frontmatter.length, 0);
});

// ── P1-2 / P2-1 / P2-2 / P2-3 · 静态回归 ───────────────────────

test("P1-2 01 · 设置页已删除无效的 staleDays 输入；types 保留字段仅作兼容", () => {
  const settingsTab = source("src/ui/SettingsTab.ts");
  assert.ok(!settingsTab.includes("催办默认周期"), "设置页不得再展示无效项");
  assert.ok(!settingsTab.includes("staleDays"), "设置页不得再读写 staleDays");
  const types = source("src/types.ts");
  assert.ok(types.includes("staleDays"), "类型层保留字段做旧 data.json 兼容");
  const taskService = source("src/domain/TaskService.ts");
  assert.ok(!taskService.includes("staleBaseDate"), "死代码 staleBaseDate 已删除");
});

test("P2-1 01 · SpeechBar 支持任意自由语速的动态档位", () => {
  const bar = source("src/ui/SpeechBar.ts");
  assert.ok(bar.includes("syncRateOptions"), "必须实现动态档位同步");
  assert.ok(/当前/.test(bar), "动态档需可读的「当前 N×」文案");
});

test("P2-2 01 · Piper 残留死分支与过时注释已清除", () => {
  const service = source("src/data/SpeechService.ts");
  assert.ok(!service.includes("正在加载"), "「本地语音模型加载中」分支已不存在");
  assert.ok(!service.includes("早期本地模型"), "ensureReady 注释不再提本地模型");
});

test("P2-3 01 · 死状态字段与死函数零残留", () => {
  const sources = [
    "src/types.ts",
    "src/domain/uiModel.ts",
    "src/domain/pluginData.ts",
    "src/ui/WorkbenchView.ts",
    "src/data/StoreService.ts",
  ]
    .map(source)
    .join("\n");
  for (const dead of ["mdView", "lastModal", "filterPaths"]) {
    assert.ok(!sources.includes(dead), `死代码 ${dead} 必须清零`);
  }
  // view.note 删除后不再有「note: {」结构写点。
  assert.ok(!sources.includes("note: {"), "ViewState.note 写点必须清零");
});

test("P2-4 01 · 统计页 top-30 截断有可见提示", () => {
  const view = source("src/ui/WorkbenchView.ts");
  assert.ok(/已显示前 30 个/.test(view), "标签/文件夹截断必须有提示文案");
});

test("P2-5 01 · 「运行信息」折叠状态在重渲染后保持", () => {
  const view = source("src/ui/WorkbenchView.ts");
  assert.ok(view.includes("runtimeInfoOpen"), "折叠状态需记入实例字段");
});

test("P2-6 01 · 今日页分组清单复用懒加载", () => {
  const view = source("src/ui/WorkbenchView.ts");
  assert.ok(view.includes("nextLoaded"), "今日页需复用 nextLoaded 懒加载");
  assert.ok(/加载更多/.test(view), "需提供加载更多按钮");
});

test("P2-7 01 · 批量标签弹窗用两步确认，不再用 window.confirm", () => {
  const modal = source("src/ui/TagManagerModal.ts");
  assert.ok(!modal.includes("window.confirm"), "原生 confirm 必须移除");
  assert.ok(modal.includes("armed"), "需实现两步确认状态");
});

test("P2-8 01 · 设置页系统音色下拉随 voiceschanged 刷新", () => {
  const settingsTab = source("src/ui/SettingsTab.ts");
  assert.ok(settingsTab.includes("refreshVoiceOptions"), "需实现音色下拉重建");
  assert.ok(settingsTab.includes("voicesUnsub"), "订阅需有清理守卫");
});

test("P1-1 08 · main.ts 已接入纯函数实现，旧计数逻辑清零", () => {
  const main = source("src/main.ts");
  assert.ok(main.includes('from "./domain/inlineTags"'), "必须委托纯函数模块");
  assert.ok(!main.includes("fmCount"), "旧 fmCount 计数逻辑必须清零");
});

// ── 1.0.10 发布前增量 · 清空 API 密钥 ──────────────────────────
test("清空密钥 01 · 设置页两步确认且只清 cloudTtsKey", () => {
  const tab = source("src/ui/SettingsTab.ts");
  assert.ok(tab.includes("清空已保存的 API 密钥"), "需提供清空密钥入口");
  assert.ok(tab.includes("clearKeyArmed"), "需两步确认状态，避免误触");
  assert.ok(tab.includes("再次点击确认清空"), "首次点击需转为确认文案");
  assert.ok(tab.includes('cloudTtsKey: ""'), "确认后必须真正清空密钥");
  assert.ok(tab.includes('cloudKeyInput?.setValue("")'), "需同步密码输入框");
  assert.ok(tab.includes("refreshGatewayStatus()"), "清空后需刷新网关就绪状态");
  assert.ok(tab.includes("resetClearKeyConfirm()"), "改动输入需复位待确认状态");
});

test("清空密钥 02 · 网关密钥为空时不再联网（supported 实时读配置）", () => {
  const cloud = source("src/speech/cloud.ts");
  assert.ok(
    /config\.key\.trim\(\)\.length > 0/.test(cloud),
    "supported() 必须校验密钥非空，清空后立即不再发起联网请求",
  );
  assert.ok(
    /const config = getConfig\(\)/.test(cloud),
    "synthesize 每次实时读取配置，不能缓存旧密钥",
  );
});
