/**
 * Obsidian 社区审核规则的本地复核（零依赖，P1-3）。
 *
 * 为什么不用官方 eslint-plugin-obsidianmd：官方 0.6.0 要求 eslint >= 9.19 +
 * typescript-eslint >= 8.35，而本仓库是 eslint 8.57 + @typescript-eslint 7
 * 的 .eslintrc.json 体系；强行升级会让现有 `npm run lint` 配置整体失效，
 * 超出「稳健性与合规」这轮的风险边界。本脚本把社区明确关注的规则前置到本地：
 *
 * - Error 级（零容忍）：innerHTML / 动态 import 非字面量 / window.app /
 *   getSettingDefinitions / localStorage / eval / detachLeaves / 后行断言 /
 *   非 error 控制台日志 / 非语音代码联网 / CSS 硬编码颜色 / 裸 globalThis /
 *   裸 requestAnimationFrame / 非语音代码引 Node 模块。任一命中 → 退出码 1。
 * - Warning 级（已知历史，不阻塞）：display:contents（项目既有决定保留）、
 *   产物 Node require（P1-4，ws 门控）。数量仍做基线比对，新增违规会 FAIL。
 *
 * 第四步（P2-6 / P2-7）后：17 处 globalThis.* 已统一改 window.*，
 * 唯一的 rAF 已改 activeWindow.requestAnimationFrame，两项基线同步下调到 0。
 * rAF 只统计「裸调用」——activeWindow.requestAnimationFrame 是官方推荐写法，
 * 不算违规；若有人改回裸调用，计数立刻变 1 触发漂移 FAIL。
 *
 * 运行：npm run lint:obsidian
 * 规则口径对齐《发布前全面审查报告_20261121.md》第三节 / 第七节复核更新。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const walk = (dir, filter = () => true) => {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
};

/** 语音相关文件是本插件唯一允许联网 / Node 模块的范围（与 release-check 白名单一致）。 */
const speechFiles = new Set([
  join(SRC, "speech", "edgeEngine.ts"),
  join(SRC, "speech", "edgeProtocol.ts"),
  join(SRC, "speech", "cloud.ts"),
  join(SRC, "ui", "SettingsTab.ts"),
]);

const sourceFiles = walk(SRC, (p) => p.endsWith(".ts") && !p.includes("__tests__"));
const nonSpeech = sourceFiles.filter((f) => !speechFiles.has(f));
const css = read(join(ROOT, "styles.css"));
const mainJs = read(join(ROOT, "main.js"));
const manifest = read(join(ROOT, "manifest.json"));

const errors = [];
const warnings = [];

/** 在文件集合中按行扫描，返回 "相对路径:行号: 内容" 列表。 */
function scan(files, label, pattern) {
  const hits = [];
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 110)}`);
      }
    });
  }
  if (hits.length) errors.push({ rule: label, hits });
  return hits;
}

/** 统计全局命中次数（不按行去重，globalThis 一行一般一处）。 */
function count(files, pattern) {
  let total = 0;
  const samples = [];
  for (const file of files) {
    const matches = [...read(file).matchAll(new RegExp(pattern.source, pattern.flags + "g"))];
    total += matches.length;
    if (matches.length) samples.push(`${relative(ROOT, file)} ×${matches.length}`);
  }
  return { total, samples };
}

// ── Error 级：社区零容忍项 ───────────────────────────────────
scan(sourceFiles, "no-sample-code / innerHTML 家族", /\.innerHTML|\.outerHTML|\.insertAdjacentHTML/);
scan(sourceFiles, "no-unsafe-dynamic-import（参数必须静态字面量）", /\bimport\s*\(\s*(?!["'])/);
scan(sourceFiles, "no-window-app / no-global-app", /window\.app|(?:^|[^\w.])app\.(vault|workspace|metadataCache|fileManager)\b/);
scan(sourceFiles, "no-getSettingDefinitions", /getSettingDefinitions\s*\(/);
scan(sourceFiles, "no-localStorage / sessionStorage / indexedDB", /localStorage|sessionStorage|indexedDB/);
scan(sourceFiles, "no-eval / new Function", /\beval\s*\(|new\s+Function\s*\(/);
scan(sourceFiles, "no-detachLeaves", /detachLeavesOfType|detachLeaves/);
scan(sourceFiles, "no-regex-lookbehind（iOS 16.4 以下不支持）", /\(\?<=|\(\?<!/);
scan(sourceFiles, "no-non-error-console", /console\.(log|debug|info|warn)\s*\(/);
scan(nonSpeech, "no-network-in-non-speech（语音为唯一例外）", /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon|\brequestUrl\s*\(/);
scan(nonSpeech, "no-nodejs-modules-in-non-speech", /\brequire\s*\(|from\s+["'](?:node:)?(?:fs|path|os|electron|child_process|crypto|net|tls|http|https)["']/);
scan(nonSpeech, "no-hardcoded-external-url-in-non-speech", /https?:\/\//);

if (/#[\da-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(/.test(css)) {
  errors.push({
    rule: "no-hardcoded-css",
    hits: ["styles.css: 存在硬编码颜色（应使用 Obsidian 主题变量）"],
  });
}
// P2-6 / P2-7：globalThis 与裸 rAF 提升为 Error 级零容忍（第四步已清零）。
// 裸 rAF 判据：前面不是 . 或标识符字符，避免把 activeWindow.requestAnimationFrame
// 这种官方推荐写法误判为违规。
scan(sourceFiles, "no-global-this（P2-6，统一 window.*）", /\bglobalThis\./);
scan(sourceFiles, "prefer-active-window（P2-7，禁止裸 requestAnimationFrame）", /(^|[^.\w])requestAnimationFrame\s*\(/);
const viewSource = read(join(SRC, "ui", "WorkbenchView.ts"));
if (!/activeWindow\.requestAnimationFrame\s*\(/.test(viewSource)) {
  errors.push({
    rule: "P2-7 回归：视图必须用 activeWindow.requestAnimationFrame",
    hits: ["src/ui/WorkbenchView.ts: 缺少 activeWindow.requestAnimationFrame"],
  });
}

// display:contents 是项目既有决定保留的写法（.kw-fm-row 让属性行参与父级 grid），
// 按《发布前全面审查报告》与长期笔记的「不阻塞」决策列为已知 Warning，不算 Error。
// 注：审查报告复核更新里写「CSS 无 display:contents」与现状不符，已在第三步验收报告勘误。
const displayContentsHits = [...css.matchAll(/display\s*:\s*contents/g)].length;

// 动态 import 参数白名单：产物里不应出现运行期拼接的 import(
if (/\bimport\s*\(/.test(mainJs) && !/import\s*\(\s*["']/.test(mainJs)) {
  errors.push({
    rule: "no-unsafe-dynamic-import（产物）",
    hits: ["main.js: 存在非字面量动态 import("],
  });
}

// ── Warning 级：已知历史项，与基线比对 ───────────────────────
// P2-6 / P2-7 已清零：基线保留为 0 作为防回归闸门（脚本会强制比对），
// 任何新增的 globalThis.* 或裸 rAF 都会立刻让数量漂移并 FAIL。
const BASELINE = {
  "no-global-this": 0,
  "prefer-active-window / 裸 requestAnimationFrame": 0,
  "display:contents（CSS，已知不阻塞）": 1, // .kw-fm-row，项目既有决策保留
};
const globalThisHits = count(sourceFiles, /\bglobalThis\./);
const rafHits = count(sourceFiles, /(^|[^.\w])requestAnimationFrame\s*\(/);
const warningCounts = {
  "no-global-this": globalThisHits.total,
  "prefer-active-window / 裸 requestAnimationFrame": rafHits.total,
  "display:contents（CSS，已知不阻塞）": displayContentsHits,
};

for (const [rule, expected] of Object.entries(BASELINE)) {
  const actual = warningCounts[rule];
  const ok = actual === expected;
  warnings.push({
    rule,
    ok,
    detail: `基线 ${expected} 处 / 实际 ${actual} 处${
      ok ? "（与审查报告一致，非阻塞）" : "（数量变化：修复后请同步下调 BASELINE，或排查新增违规）"
    }`,
  });
  if (!ok) errors.push({ rule: `${rule} 基线漂移`, hits: [`实际 ${actual} / 基线 ${expected}`] });
}

// P1-4：产物 Node require 只应来自 ws 依赖清单，且桌面动态门控、双端不降级。
const requireTargets = [
  ...new Set([...mainJs.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])),
];
const allowedRequires = new Set([
  "obsidian", "crypto", "buffer", "events", "http", "https", "net",
  "stream", "tls", "url", "zlib", "bufferutil", "utf-8-validate",
]);
const unknownRequires = requireTargets.filter((name) => !allowedRequires.has(name));
warnings.push({
  rule: "no-nodejs-modules（产物 require，P1-4 已知）",
  ok: unknownRequires.length === 0,
  detail:
    `目标 ${requireTargets.length} 类：${requireTargets.join(" / ")}；` +
    `由 Platform.isMobile 门控的桌面 Edge 引擎持有，isDesktopOnly=false 保持不变。`,
});
if (unknownRequires.length) {
  errors.push({ rule: "no-nodejs-modules（新增未知 require）", hits: unknownRequires });
}
if (!/!Platform\.isMobile/.test(read(join(SRC, "main.ts"))) || !/"isDesktopOnly":\s*false/.test(manifest)) {
  errors.push({
    rule: "P1-4 双端门控缺失",
    hits: ["main.ts Platform.isMobile 门控或 manifest.isDesktopOnly=false 被改动"],
  });
}

// ── 输出 ────────────────────────────────────────────────────
const lines = [
  "Obsidian 社区规则本地复核（lint:obsidian）",
  `扫描：${sourceFiles.length} 个源码文件 / styles.css / main.js / manifest.json`,
  "",
  "Error 级（零容忍）：",
];
if (!errors.length) lines.push("  PASS  0 项命中");
for (const item of errors) {
  lines.push(`  FAIL  [${item.rule}]`);
  for (const hit of item.hits) lines.push(`        ${hit}`);
}
lines.push("", "Warning 级（已知历史基线，非阻塞）：");
for (const item of warnings) {
  lines.push(`  ${item.ok ? "KNOWN" : "FAIL "}  [${item.rule}] ${item.detail}`);
}
lines.push(
  "",
  `结论：${errors.length} Error / ${warnings.length} Warning 组 · ${
    errors.length === 0 ? "PASS（可进入上传前复核）" : "FAIL（请修复后重跑）"
  }`,
  "说明：官方 eslint-plugin-obsidianmd 需 ESLint 9 + typescript-eslint 8，与本项目 ESLint 8 体系不兼容；",
  "      如需官方结果，可在临时目录独立安装后一次性复核，不改动本仓库依赖。",
);
console.log(lines.join("\n"));
process.exitCode = errors.length === 0 ? 0 : 1;
