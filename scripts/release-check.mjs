/**
 * P6 发布前静态合规自检（可重复运行，零外部依赖）。
 *
 * 覆盖定稿文档 P6 第 1 / 4 / 5 / 6 条中可以用静态分析判定的项：
 * 移动端 API、官方插件规范、产物纯净度、清单一致性、发布材料齐备。
 * 真机双端冒烟与系统日历导入不属于本脚本职责，见《双端实机验收手册》。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
const results = [];

function check(group, name, ok, detail = "") {
  results.push({ group, name, ok: Boolean(ok), detail });
}

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function walk(dir, filter = () => true) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** 在源码文件中查找禁用模式，返回 "相对路径:行号: 内容" 列表。 */
function findInSources(files, pattern) {
  const hits = [];
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  return hits;
}

const sourceFiles = walk(SRC, (p) => p.endsWith(".ts") && !p.includes("__tests__"));
const testFiles = walk(SRC, (p) => p.endsWith(".ts") && p.includes("__tests__"));
const mainJs = read(join(ROOT, "main.js"));
const css = read(join(ROOT, "styles.css"));
const settings = read(join(SRC, "ui", "SettingsTab.ts"));
const mainTs = read(join(SRC, "main.ts"));

// ── 1. 移动端与运行时禁项（定稿 P6-1）────────────────────────
const forbidden = [
  ["innerHTML / outerHTML / insertAdjacentHTML", /\.innerHTML|\.outerHTML|\.insertAdjacentHTML/],
  ["Node / Electron 模块导入与 require()", /\brequire\s*\(|from\s+["'](?:node:)?(?:fs|path|os|electron|child_process|crypto)["']/],
  ["网络请求 fetch / XMLHttpRequest / WebSocket / sendBeacon", /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon/],
  ["浏览器持久化 API showDirectoryPicker / IndexedDB / localStorage", /showDirectoryPicker|indexedDB|localStorage|sessionStorage/],
  ["动态代码 eval / new Function", /\beval\s*\(|new\s+Function\s*\(/],
  ["硬编码外部 URL（零网络请求约束）", /https?:\/\//],
  ["正则后行断言（iOS 16.4 以下不支持）", /\(\?<=|\(\?<!/],
  ["detachLeaves（onunload 不应 detach leaves）", /detachLeavesOfType|detachLeaves/],
  ["非 error 级控制台日志", /console\.(log|debug|info|warn)\s*\(/],
];
for (const [name, pattern] of forbidden) {
  const hits = findInSources(sourceFiles, pattern);
  check("移动端与运行时", name, hits.length === 0, hits.join(" | "));
}
// 可选云端神经 TTS 是唯一允许联网的路径：必须集中在 speech/cloud.ts，且默认关闭。
const cloudFile = join(SRC, "speech", "cloud.ts");
const requestUrlHits = findInSources(
  sourceFiles.filter((file) => file !== cloudFile),
  /requestUrl\s*\(/,
);
check("移动端与运行时", "requestUrl 仅存在于云端朗读适配层", requestUrlHits.length === 0, requestUrlHits.join(" | "));
const typesTs = read(join(SRC, "types.ts"));
check(
  "移动端与运行时",
  "云端朗读默认关闭且地址/密钥留空",
  /cloudTtsEnabled:\s*false/.test(typesTs) && /cloudTtsUrl:\s*""/.test(typesTs) && /cloudTtsKey:\s*""/.test(typesTs),
  "DEFAULT_SETTINGS",
);
check("移动端与运行时", "云端适配层存在且使用宿主 requestUrl", /requestUrl\s*\(/.test(read(cloudFile)), cloudFile);

// 全局 app：先剔除 this.app / xxx.app，再找裸 app.vault 等。
const globalAppHits = [];
for (const file of sourceFiles) {
  read(file)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const stripped = line.replace(/this\.app/g, "").replace(/\b\w+\.app/g, "");
      if (/\bapp\.(vault|workspace|metadataCache|fileManager)\b/.test(stripped) || /window\.app|globalThis\.app/.test(line)) {
        globalAppHits.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
}
check("官方规范", "不使用全局 app / window.app", globalAppHits.length === 0, globalAppHits.join(" | "));

// ── 2. 官方插件规范（定稿 P6-4）───────────────────────────────
check("官方规范", "宿主事件使用 registerEvent()", /registerEvent\s*\(/.test(mainTs));
check("官方规范", "索引服务把 Plugin 作为事件 owner 传入", /owner:\s*this/.test(mainTs));
check("官方规范", "命令不设默认热键 hotkeys", !/hotkeys\s*:/.test(mainTs));
check("官方规范", "设置页使用 setHeading() 分组", /\.setHeading\(\)/.test(settings));
check(
  "官方规范",
  "设置页无顶层「常规 / 设置 / 插件名」标题",
  !/setName\(["'](?:常规|设置|知识管理工作台)["']\)\s*\.setHeading\(\)/.test(settings),
);
const headingNames = [...settings.matchAll(/setName\(["']([^"']+)["']\)\s*\.setHeading\(\)/g)].map((m) => m[1]);
check("官方规范", "分组标题不含「设置」二字", headingNames.every((n) => !n.includes("设置")), headingNames.join(" / "));
check("官方规范", "资源在 onunload 中统一清理", /onunload\s*\(/.test(mainTs) && /dispose\(\)/.test(mainTs));

// ── 3. 构建产物纯净度 ─────────────────────────────────────────
check("产物", "main.js 存在且非空", mainJs.length > 1000, `${mainJs.length} 字节`);
for (const [name, pattern] of [
  ["产物无 Node/Electron require", /require\(["'](?:node:|fs|path|os|electron)/],
  ["产物无 innerHTML", /\.innerHTML|\.outerHTML|\.insertAdjacentHTML/],
  ["产物无外部 URL", /https?:\/\//],
  ["产物无 eval", /\beval\s*\(/],
]) {
  check("产物", name, !pattern.test(mainJs));
}
check("产物", "obsidian 保持外置（require('obsidian')）", /require\(["']obsidian["']\)/.test(mainJs));
check("产物", "styles.css 零硬编码颜色", !/#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(/.test(css));

// ── 4. 清单与版本一致性（定稿 P6-5）───────────────────────────
let manifest = {};
let versions = {};
let pkg = {};
try {
  manifest = JSON.parse(read(join(ROOT, "manifest.json")));
  versions = JSON.parse(read(join(ROOT, "versions.json")));
  pkg = JSON.parse(read(join(ROOT, "package.json")));
} catch (error) {
  check("清单", "JSON 可解析", false, String(error));
}
const semver = /^\d+\.\d+\.\d+$/;
check("清单", "manifest 字段齐备", ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"].every((k) => k in manifest));
check("清单", "version 符合 semver x.y.z", semver.test(manifest.version ?? ""), String(manifest.version));
check("清单", "versions.json 含当前版本且映射 minAppVersion", versions[manifest.version] === manifest.minAppVersion, JSON.stringify(versions));
check("清单", "package.json version 与 manifest 一致", pkg.version === manifest.version, `${pkg.version} / ${manifest.version}`);
check("清单", "插件 id 与 package name 一致", pkg.name === manifest.id, `${pkg.name} / ${manifest.id}`);
check("清单", "isDesktopOnly 为 false（双端）", manifest.isDesktopOnly === false, String(manifest.isDesktopOnly));
check("清单", "插件名不含 Obsidian 字样（官方提交规范）", !/obsidian/i.test(manifest.name ?? ""), String(manifest.name));
const minParts = String(manifest.minAppVersion ?? "0.0.0").split(".").map(Number);
check("清单", "minAppVersion ≥ 1.4.4（processFrontMatter 引入版）", minParts[0] > 1 || (minParts[0] === 1 && (minParts[1] > 4 || (minParts[1] === 4 && minParts[2] >= 4))), String(manifest.minAppVersion));
check("清单", "无运行时 dependencies（零外部依赖）", !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies ?? {}));

// ── 5. 发布材料齐备（定稿 P6-6）───────────────────────────────
for (const file of ["main.js", "manifest.json", "styles.css", "versions.json", "README.md", "LICENSE", "CHANGELOG.md"]) {
  const path = join(ROOT, file);
  check("发布材料", `${file} 存在`, existsSync(path) && statSync(path).size > 0);
}
const readme = read(join(ROOT, "README.md"));
check("发布材料", "README 写明关 App 后不推送 / 用 .ics", /\.ics/.test(readme) && /(不推送|不再提醒|系统日历)/.test(readme));
check("发布材料", "README 写明手机端朗读可能不可用", /手机|移动端/.test(readme) && /朗读/.test(readme));
check("发布材料", "README 声明默认零网络请求 / 隐私", /零网络|无网络|不联网/.test(readme));
check(
  "发布材料",
  "README 披露可选云端朗读与数据发送范围",
  /云端/.test(readme) && /(仅发送|只发送|不发送)/.test(readme),
);

// ── 6. 输出 ───────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
let group = "";
for (const r of results) {
  if (r.group !== group) {
    group = r.group;
    console.log(`\n[${group}]`);
  }
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  → ${r.detail}` : ""}`);
}
mkdirSync(DIST, { recursive: true });
writeFileSync(
  join(DIST, "release-check.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2),
  "utf8",
);
console.log(`\n总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
console.log(`报告：${join(DIST, "release-check.json")}`);
console.log(`源码文件 ${sourceFiles.length} 个，测试文件 ${testFiles.length} 个`);
if (failed.length) process.exitCode = 1;
