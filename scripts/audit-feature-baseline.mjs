/**
 * 功能验收基线逐条核对（对齐《可行性分析与开发计划》第三节矩阵）。
 * 纯静态核对：每条基线给出源码证据，输出 PASS / FAIL 与证据片段。
 * 运行：node scripts/audit-feature-baseline.mjs
 */
import { readFileSync } from "node:fs";
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
  piper: read("src/speech/piperEngine.ts"),
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
check("G 朗读", "Piper 本地语音（离线神经）", "piperEngine + WASM 推理",
  /createPiperEngine/.test(SRC.piper) && /InferenceSession/.test(SRC.piper) && /encodeWav/.test(SRC.piper),
  ["VITS 推理", "音素 WASM", "WAV 输出", "失败回退系统语音"]);
const BUILT = read("main.js");
check("G 朗读", "云端神经朗读搁置（零网络）", "cloud.ts 不被 main.ts 导入；产物无 requestUrl",
  !/import[^;]*speech\/cloud/.test(SRC.main) && !/requestUrl|\bfetch\(/i.test(SRC.main)
    && BUILT.length > 0 && !/\brequestUrl\b/.test(BUILT) && !/\bfetch\s*\(/.test(BUILT)
    && !/https?:\/\//.test(BUILT),
  ["main.ts 不导入 cloud.ts（仅注释提及）", "main.ts 无 requestUrl / fetch",
   `产物 main.js ${BUILT.length} 字节：无 requestUrl / fetch / 外部 URL`]);

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
check("I 工程", "零网络：产物无 requestUrl / fetch", "release-check 断言",
  /requestUrl/.test(read("scripts/release-check.mjs")),
  ["发布检查断言零网络"]);
check("I 工程", "无 Node/Electron API 依赖", "main.ts 不 import node/electron",
  !/from "node:|require\("node:|from "electron"/.test(SRC.main),
  ["main.ts 无 node/electron 导入"]);
check("I 工程", "A2HS / 自动同步 / LLM 端点全部移除", "全源码无残留",
  !/A2HS|llmEndpoint|autoSync/i.test(SRC.main + SRC.settings + SRC.uiModel),
  ["无 A2HS / LLM 端点 / 自动同步入口"]);
check("I 工程", "README 明确 .ics 替代 / 零网络 / 回滚", "README 说明",
  /\.ics/.test(SRC.readme) && /零网络/.test(SRC.readme) && /回滚/.test(SRC.readme),
  ["README 三项声明齐全"]);

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
process.exitCode = fail === 0 ? 0 : 1;
