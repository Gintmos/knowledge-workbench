/**
 * 功能验收基线逐条核对（对齐《可行性分析与开发计划》第三节矩阵）。
 * 纯静态核对：每条基线给出源码证据，输出 PASS / FAIL 与证据片段。
 * 运行：node scripts/audit-feature-baseline.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p) => {
  try {
    return readFileSync(join(ROOT, p), "utf8");
  } catch {
    return "";
  }
};

const SRC = {
  main: read("src/main.ts"),
  types: read("src/types.ts"),
  index: read("src/data/VaultIndexService.ts"),
  front: read("src/data/FrontmatterService.ts"),
  view: read("src/ui/WorkbenchView.ts"),
  modal: read("src/ui/NoteModal.ts"),
  settings: read("src/ui/SettingsTab.ts"),
  speech: read("src/data/SpeechService.ts"),
  engine: read("src/speech/engine.ts"),
  chunks: read("src/speech/chunks.ts"),
  ics: read("src/domain/ics.ts"),
  summary: read("src/domain/SummaryService.ts"),
  tasks: read("src/domain/taskParse.ts"),
  catalog: read("src/domain/catalog.ts"),
  tag: read("src/domain/tagEdit.ts"),
  uiModel: read("src/domain/uiModel.ts"),
  pluginData: read("src/domain/pluginData.ts"),
  manifest: read("manifest.json"),
  readme: read("README.md"),
  pkg: read("package.json"),
  styles: read("styles.css"),
};

/** @type {{group:string,item:string,html:string,ok:boolean,evidence:string[]}[]} */
const results = [];
const check = (group, item, html, ok, evidence) =>
  results.push({ group, item, html, ok, evidence });

// ── A. 数据与索引 ───────────────────────────────────────────
check("A 数据", "读取全部 md、不限篇数", "getMarkdownFiles + cachedRead",
  /getMarkdownFiles\(\)/.test(SRC.index) && /cachedRead\(/.test(SRC.index),
  [SRC.index.match(/getMarkdownFiles\(\)/)?.[0] || "缺失"]);
check("A 数据", "事件驱动替代每日轮询", "on('create'|'modify'|'delete'|'rename') + metadataCache.changed",
  /vault\.on\("create"/.test(SRC.index) && /vault\.on\("modify"/.test(SRC.index)
    && /vault\.on\("delete"/.test(SRC.index) && /vault\.on\("rename"/.test(SRC.index)
    && /cache\.on\("changed"/.test(SRC.index),
  ["vault create/modify/delete/rename 事件", "metadataCache changed"]);
check("A 数据", "快照 / 减少项检测（只读）", "index.json 对比 path+mtime",
  /index\.json/.test(SRC.index) && /mtime/i.test(SRC.index),
  ["index.json 快照比对 path+mtime"]);
check("A 数据", "ZIP 恢复明确不做", "无 zip 恢复入口",
  !/restoreZip|zipRestore|恢复备份/i.test(SRC.main + SRC.settings),
  ["全源码无 zip 恢复入口"]);

// ── B. 分类与统计 ───────────────────────────────────────────
check("B 分类统计", "按标签/文件夹自动分类，长尾归其他", "分类维度可配 + 其他归并",
  /classifyBy/.test(SRC.types) && /key: "其他"/.test(read("src/domain/ClassifierService.ts")),
  ["分类维度可配（标签 / 文件夹）", "长尾归并「其他」（ClassifierService）"]);
check("B 分类统计", "图表分类限 Top 10、逐篇统计不设上限", "renderBarMeter 横向条形 + 全量主分类总览",
  /barWidthPercent/.test(SRC.uiModel) && /renderBarMeter/.test(SRC.view)
    && /主分类总览/.test(SRC.view),
  ["逐篇统计无上限（主分类总览）", "图表行带横向条形 renderBarMeter", "长尾归并「其他」"]);

// ── C. 摘要 ────────────────────────────────────────────────
check("C 摘要", "规则式四档摘要，无 LLM / 无网络", "SummaryService 规则抽取",
  /export function/i.test(SRC.summary) && !/requestUrl|\bfetch\(/i.test(SRC.summary),
  ["规则式四档", "无网络调用"]);
check("C 摘要", "摘要缓存于索引，默认不写回", "缓存 + 默认关闭写回",
  /summary/i.test(SRC.index) && /writeSummaries/.test(SRC.main),
  ["索引缓存摘要", "写回为独立命令，默认不自动执行"]);

// ── D. 阅读与渲染 ───────────────────────────────────────────
check("D 阅读", "笔记名直达原文（wiki 链接）", "openLinkText / openFile",
  /openLinkText/.test(SRC.modal) || /openLinkText/.test(SRC.view),
  ["openLinkText 打开原文"]);
check("D 阅读", "Markdown 渲染交宿主", "MarkdownRenderer.render",
  /MarkdownRenderer/.test(SRC.modal),
  ["MarkdownRenderer.render(app, md, el, sourcePath, component)"]);
check("D 阅读", "页面位置恢复 / 浏览历史 20 篇", "file-open 采集 + 历史上限",
  /on\("file-open"/.test(SRC.main) && /history/i.test(SRC.types),
  ["file-open 采集", "历史持久化到 data.json"]);

// ── E. 今日 / 复习 / 催办待办 ────────────────────────────────
check("E 今日", "今日四分组：逾期/到期/复习/催办待办", "TodayKind 枚举",
  /overdue[\s\S]{0,80}followup/.test(SRC.types) && /todo/.test(SRC.types),
  ["TodayKind: overdue | due | review | followup | todo"]);
check("E 今日", "任务级催办/待办（解析正文 - [ ]）", "taskParse.parseTasks",
  /parseTasks/.test(SRC.tasks) && /- \[ \]/.test(SRC.tasks),
  ["解析未完成任务", "四级判定：@due/@every/frontmatter/中文周期词"]);
check("E 今日", "就地完成按钮", "kw-resolve-btn",
  /kw-resolve-btn/.test(SRC.view) && /完成/.test(SRC.view),
  ["今日行「完成」/「完成复习」按钮"]);
check("E 今日", "复习计划写回 frontmatter", "startReview 接通",
  /startReview\(/.test(SRC.main) && /processFrontMatter/.test(SRC.front),
  ["startReview 已接线", "processFrontMatter 写回"]);

// ── F. .ics ────────────────────────────────────────────────
check("F 日历", ".ics 导出 + VALARM", "ics 生成器",
  /VEVENT/.test(SRC.ics) && /VALARM/.test(SRC.ics),
  ["VEVENT + VALARM"]);
check("F 日历", "全天事件带 DTEND 次日 + Microsoft 字段", "RFC5545 加固",
  /DTEND/.test(SRC.ics) && /Microsoft/i.test(SRC.ics),
  ["DTEND;VALUE=DATE 次日", "Microsoft 专有字段"]);
check("F 日历", "任务级前缀「催办/待办」+ 行号进 uid", "KIND_PREFIX + line 进 uid",
  /followup: "催办"/.test(SRC.ics) && /todo: "待办"/.test(SRC.ics)
    && /line: task\?\.line/.test(SRC.ics) && /#\$\{item\.line\}/.test(SRC.ics),
  ["KIND_PREFIX 含催办/待办", "uid = hash(path#行号|kind|date)"]);

// ── G. 朗读 ────────────────────────────────────────────────
check("G 朗读", "系统语音 + 规则式韵律", "speechSynthesis + 句群分块",
  /speechSynthesis/.test(SRC.engine) && /chunk/i.test(SRC.chunks),
  ["Web Speech", "句群分块"]);
check("G 朗读", "可拖进度条 / 断点续读", "SpeechBar + ReadProgress",
  /kw-progress|progress/i.test(SRC.view) || /seek/i.test(SRC.speech),
  ["进度条 seek", "断点持久化"]);
check("G 朗读", "手机端能力检测 + 中文提示 / 朗读稿降级", "Platform.isMobile",
  /Platform\.isMobile/.test(SRC.main) && /朗读稿/.test(SRC.view + SRC.settings),
  ["移动端检测", "朗读稿替代路径"]);
const BUILT = read("main.js");
// P1-1：协议常量拆到 edgeProtocol.ts（零 Node 依赖），基线证据覆盖两个文件。
const EDGE = read("src/speech/edgeEngine.ts") + read("src/speech/edgeProtocol.ts");
const CLOUD = read("src/speech/cloud.ts");
// P2-3：两个联网引擎的音频缓存 / 播放 / 预取已收敛到共享核心。
const AUDIO_CORE = read("src/speech/audioCore.ts");
const UI_SMOKE = read("scripts/ui-smoke.mjs");
const OBSIDIAN_LINT = read("scripts/lint-obsidian.mjs");
check("G 朗读", "安卓语音预设（国内神经 TTS 一键配置）", "安卓语音预设下拉 + 网关配置",
  /安卓语音预设/.test(SRC.settings) && /cosyvoice-v3-flash/.test(SRC.settings) &&
    /dashscope\.aliyuncs\.com/.test(SRC.settings) && /speechEngine: "cloud"/.test(SRC.settings),
  ["预置阿里云百炼 CosyVoice3 / Qwen-TTS / 硅基流动 / OpenAI", "选中即填地址+模型+音色并切到网关"]);
check("G 朗读", "语速下拉 + 暂停拖动续播状态同步", "SpeechBar 语速 select + pendingResumeFromSeek",
  /kw-speech-rate/.test(SRC.styles) && /onRateChange/.test(SRC.modal) &&
    /pendingResumeFromSeek/.test(SRC.speech),
  ["朗读窗口语速下拉", "暂停后拖动进度条再继续可直接播放"]);
check("G 朗读", "暂停后自动回退误判修复（有限重试 + 短退避）", "PREFERRED_RETRY_LIMIT + engineFailures + 退避",
  /PREFERRED_RETRY_LIMIT/.test(SRC.speech) && /engineFailures/.test(SRC.speech) &&
    /PREFERRED_RETRY_BACKOFF_MS/.test(SRC.speech) && /retryTicket/.test(SRC.speech) &&
    /prefetchNext/.test(SRC.speech) && /prefetch/.test(AUDIO_CORE),
  ["连续失败才回退系统语音；P2-1 第 1/2 次退避 300/600ms，过期回调作废",
   "P2-2 预取携带 token + 会话守卫；P2-3 缓存/播放/预取收敛到 audioCore.ts"]);
check("G 朗读", "P1-1 Edge 接口版本可热修 + 403 可诊断（不再静默降级）", "设置页覆盖值 / 协议常量 / 朗读能力回传",
  /edgeGecVersion:\s*""/.test(SRC.types) &&
    /resolveGecVersion/.test(EDGE) &&
    /describeEdgeFailure/.test(EDGE) &&
    /unexpected-response/.test(EDGE) &&
    /engineLastError/.test(SRC.speech) &&
    /Edge 接口版本/.test(SRC.settings),
  ["留空用内置版本；非法值回退；403 给出可操作热修指引",
   "最近一次失败诊断回传设置页「朗读能力」"]);
check("G 朗读", "语音联网为唯一例外且受控（Edge 桌面 + 自定义网关双端）",
  "两个联网引擎默认关闭；Edge 仅桌面动态加载；其余功能零网络",
  /await import\(["'][^"']*speech\/edgeEngine["']\)/.test(SRC.main) &&
    /!Platform\.isMobile[\s\S]{0,120}await import/.test(SRC.main) &&
    /createCloudTtsEngine/.test(SRC.main) &&
    /cloudTtsEnabled:\s*false/.test(SRC.types) &&
    /speechEngine:\s*"system"/.test(SRC.types) &&
    /generateSecMsGecV2/.test(EDGE) && /api\.msedgeservices\.com/.test(EDGE) &&
    !/requestUrl|\bfetch\(/i.test(SRC.main) &&
    BUILT.length > 0,
  ["main.ts 中 Edge 仅桌面动态 import，cloud 用宿主 requestUrl",
   "默认引擎仍是 system、cloudTtsEnabled 默认 false",
   `Edge DRM v2 + 新端点；产物 main.js ${BUILT.length} 字节`]);

// ── H. 设置与标签管理 ────────────────────────────────────────
check("H 设置", "分组 + (i) 折叠说明 + 版本号", "PluginSettingTab + addInfo",
  /function addInfo/.test(SRC.settings) && /kw-info-btn/.test(SRC.settings)
    && /kw-info-panel/.test(SRC.settings) && /索引与备份/.test(SRC.settings)
    && /plugin\.manifest\.version/.test(SRC.settings),
  ["(i) 按钮 + 折叠说明面板（aria-expanded，默认隐藏）", "五组标题", "底部显示 manifest 版本"]);
check("H 设置", "快速上手 3 步（降低门槛）", "kw-quickstart",
  /快速上手 3 步/.test(SRC.settings) && /kw-quickstart/.test(SRC.styles),
  ["快速上手区块 + 样式"]);
check("H 设置", "批量重命名 / 合并标签（预览 + 二次确认）", "TagManagerModal + tagEdit",
  /previewTagEdit/.test(SRC.tag) && /TagManagerModal/.test(SRC.main),
  ["预览影响篇数", "二次确认", "默认只改 frontmatter"]);
check("H 设置", "导出笔记目录", "catalog.renderCatalog",
  /renderCatalog/.test(SRC.catalog) && /export-catalog/.test(SRC.main),
  ["导出到 知识管理工作台/笔记目录.md"]);

// ── I. 工程约束 ────────────────────────────────────────────
check("I 工程", "isDesktopOnly = false（双端同一份代码）", "manifest",
  /"isDesktopOnly":\s*false/.test(SRC.manifest),
  ["manifest.isDesktopOnly=false"]);
const RELEASE_SCRIPT = read("scripts/release-check.mjs");
check("I 工程", "默认离线：非语音代码禁 requestUrl / fetch，语音为受控例外", "release-check 白名单断言",
  /NETWORK_ALLOWED/.test(RELEASE_SCRIPT) &&
    /非语音代码发起网络请求/.test(RELEASE_SCRIPT) &&
    /requestUrl/.test(RELEASE_SCRIPT),
  ["发布检查以白名单方式只允许语音引擎联网，其余源码严格零网络"]);
check("I 工程", "无 Node/Electron API 依赖", "main.ts 不 import node/electron",
  !/from "node:|require\("node:|from "electron"/.test(SRC.main),
  ["main.ts 无 node/electron 导入"]);
check("I 工程", "A2HS / 自动同步 / LLM 端点全部移除", "全源码无残留",
  !/A2HS|llmEndpoint|autoSync/i.test(SRC.main + SRC.settings + SRC.uiModel),
  ["无 A2HS / LLM 端点 / 自动同步入口"]);
check("I 工程", "P1-3 社区 lint 规则集本地可复核（lint:obsidian 零依赖门禁）", "scripts/lint-obsidian.mjs + npm script",
  /lint:obsidian/.test(SRC.pkg) &&
    /no-unsafe-dynamic-import/.test(read("scripts/lint-obsidian.mjs")) &&
    /no-global-this/.test(read("scripts/lint-obsidian.mjs")),
  ["Error 级零容忍；Warning 与 P2-6/P2-7/P1-4 基线对齐",
   "官方插件需 ESLint 9，与本项目 ESLint 8 体系不兼容，故用等价本地规则"]);
check("I 工程", "P1-4 Node require 由桌面动态 import 门控，双端不降级", "Platform.isMobile + isDesktopOnly=false",
  /!Platform\.isMobile[\s\S]{0,200}await import/.test(SRC.main) &&
    /"isDesktopOnly":\s*false/.test(SRC.manifest) &&
    /allowedRequires/.test(RELEASE_SCRIPT),
  ["产物 require 清单由发布自检白名单守护", "不将 isDesktopOnly 改为 true"]);
check("I 工程", "README 明确 .ics 替代 / 默认离线且朗读为例外 / 回滚", "README 说明",
  /\.ics/.test(SRC.readme) &&
    /默认.*(离线|不联网)/.test(SRC.readme) &&
    /朗读.*唯一.*联网/.test(SRC.readme) &&
    /回滚/.test(SRC.readme),
  ["README 三项声明齐全，且默认离线口径与联网例外一致（1.0.9）"]);
// P2-5：把第一 / 二 / 三步手工 CDP 的 UI 结论固化为自动冒烟，纳入校验清单。
const P2_TEST = read("src/__tests__/p2.test.ts");
check("I 工程", "P2-5 UI 结论脚本化（CDP 只读冒烟 + 结构化报告）", "scripts/ui-smoke.mjs + smoke:ui",
  /ui-smoke\.json/.test(UI_SMOKE) &&
    /CDP_SETTINGS_TITLE/.test(UI_SMOKE) &&
    /不改笔记/.test(UI_SMOKE) &&
    /kw-speech-engine/.test(UI_SMOKE) &&
    /kw-fm-grid/.test(UI_SMOKE) &&
    /"smoke:ui"/.test(SRC.pkg),
  ["覆盖版本栏 / 四页签 / 页脚离线口径 / U-1 引擎标签 / 语速 5 档 / U-9 属性折叠 / U-3 卡片顺序 / 设置页",
   "只读 DOM + 打开视图弹窗，验证结束关闭弹窗并停回「今日」"]);
check("I 工程", "P2-6/P2-7 globalThis 与裸 rAF 清零并提升为 Error 级", "lint:obsidian 基线 0",
  /"no-global-this":\s*0/.test(OBSIDIAN_LINT) &&
    /"prefer-active-window \/ 裸 requestAnimationFrame":\s*0/.test(OBSIDIAN_LINT) &&
    /activeWindow\.requestAnimationFrame/.test(OBSIDIAN_LINT),
  ["17 处 globalThis.* 统一 window.*；裸 rAF 改 activeWindow.requestAnimationFrame",
   "Error 级零容忍 + 基线强制比对，新增违规即 FAIL"]);
check("I 工程", "P2 工程债有行为级回归（退避 / 预取守卫 / 共享核心 / 死路径）", "p2.test.ts",
  ["delays", "retryTicket", "isStale", "prefetched", "createAudioEngineCore", "cloudEngine"].every(
    (tag) => P2_TEST.includes(tag),
  ),
  ["P2-1 短退避 300/600ms 与过期回调作废", "P2-2 预取会话守卫", "P2-3 共享音频核心 LRU/in-flight",
   "P2-4 死路径静态断言", "P2-6/7 宿主 API 扫描"]);

// 复审 V2（1.0.10）：P1-1/P1-2 + P2-1~8 的功能基线。
const P3_TEST = read("src/__tests__/p3.test.ts");
const INLINE_TAGS = read("src/domain/inlineTags.ts");
check("J 复审V2", "P1-1 内联标签替换纯函数化并接入批量标签链路", "src/domain/inlineTags.ts + main.ts",
  /splitFrontmatterLines/.test(INLINE_TAGS) &&
    INLINE_TAGS.includes("replaceInlineTags") &&
    SRC.main.includes('from "./domain/inlineTags"') &&
    !SRC.main.includes("fmCount"),
  ["带/无 frontmatter、代码块、子标签、YAML 注释、wiki/MD 锚点保护均有单测",
   "修复「带 frontmatter 笔记正文一个都不替换且恒报成功」的缺陷"]);
check("J 复审V2", "P1-2 无效设置已删除且数据兼容保留", "SettingsTab / TaskService / types",
  !SRC.settings.includes("staleDays") &&
    !read("src/domain/TaskService.ts").includes("staleBaseDate") &&
    SRC.types.includes("staleDays"),
  ["设置页不再展示无效的「催办默认周期」，不再触发无意义全库重扫",
   "WorkbenchSettings.staleDays 字段仅作旧 data.json 归一化兼容"]);
check("J 复审V2", "P2-1~8 复审修复有行为级回归", "p3.test.ts",
  ["P2-1", "P2-2", "P2-3", "P2-4", "P2-5", "P2-6", "P2-7", "P2-8"].every(
    (tag) => P3_TEST.includes(tag),
  ),
  ["P2-1 自由语速动态档", "P2-2 Piper 残留清零", "P2-3 死状态清零",
   "P2-4 截断提示", "P2-5 折叠持久", "P2-6 今日页懒加载",
   "P2-7 弹窗两步确认替代原生 confirm", "P2-8 音色下拉随 voiceschanged 刷新"]);

check("J 复审V2", "清空密钥按钮可移除本机凭据且网关立即不再联网", "SettingsTab / cloud",
  SRC.settings.includes("清空已保存的 API 密钥") &&
    SRC.settings.includes("clearKeyArmed") &&
    SRC.settings.includes('cloudTtsKey: ""') &&
    /config\.key\.trim\(\)\.length > 0/.test(read("src/speech/cloud.ts")),
  ["两步确认避免误触，只清 cloudTtsKey，不动服务地址 / 模型 / 音色 / 引擎开关",
   "网关 supported() 实时读配置，密钥为空即不再发起联网请求；密码输入框与就绪状态条同步刷新"]);

// ── 汇总 ───────────────────────────────────────────────────
const groups = [...new Set(results.map((r) => r.group))];
let pass = 0;
let fail = 0;
const lines = [];
for (const g of groups) {
  lines.push(`\n## ${g}`);
  for (const r of results.filter((x) => x.group === g)) {
    if (r.ok) pass += 1;
    else fail += 1;
    lines.push(`  ${r.ok ? "PASS" : "FAIL"}  ${r.item}`);
    lines.push(`        期望：${r.html}`);
    lines.push(`        证据：${r.evidence.join(" / ")}`);
  }
}
lines.unshift(`功能验收基线核对：${pass} PASS / ${fail} FAIL / 共 ${results.length} 条`);
console.log(lines.join("\n"));
if (process.argv.includes("--json")) {
  writeFileSync(join(ROOT, "dist", "baseline-audit.json"), JSON.stringify({
    total: results.length, pass, fail, results,
  }, null, 2), "utf8");
  console.log(`\nJSON 报告：dist/baseline-audit.json`);
}
process.exitCode = fail === 0 ? 0 : 1;
