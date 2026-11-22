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
// 语音是本插件唯一放开的联网能力：Edge 引擎用 Node crypto + WebSocket，
// 自定义网关用宿主 requestUrl，设置页展示服务地址占位符。
// 仅在下列白名单文件里允许「网络/Node crypto/外部 URL」，其余源码仍严格零网络。
const NETWORK_ALLOWED = new Set([
  join(SRC, "speech", "edgeEngine.ts"),
  // P1-1：协议常量抽到零 Node 依赖的独立文件，仍属语音白名单。
  join(SRC, "speech", "edgeProtocol.ts"),
  join(SRC, "speech", "cloud.ts"),
  join(SRC, "ui", "SettingsTab.ts"),
]);
const isNetworkAllowed = (file) => NETWORK_ALLOWED.has(file);
const mainJs = read(join(ROOT, "main.js"));
const css = read(join(ROOT, "styles.css"));
const settings = read(join(SRC, "ui", "SettingsTab.ts"));
const mainTs = read(join(SRC, "main.ts"));

// ── 1. 移动端与运行时禁项（定稿 P6-1）────────────────────────
const nonNetworkFiles = sourceFiles.filter((file) => !isNetworkAllowed(file));
const forbidden = [
  ["innerHTML / outerHTML / insertAdjacentHTML", /\.innerHTML|\.outerHTML|\.insertAdjacentHTML/, sourceFiles],
  // 下列三项禁止出现在「非语音」源码；语音白名单文件不受限。
  ["Node / Electron 模块导入与 require()（语音引擎除外）", /\brequire\s*\(|from\s+["'](?:node:)?(?:fs|path|os|electron|child_process|crypto)["']/, nonNetworkFiles],
  ["非语音代码发起网络请求 fetch / XMLHttpRequest / WebSocket / sendBeacon", /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon/, nonNetworkFiles],
  ["浏览器持久化 API showDirectoryPicker / IndexedDB / localStorage", /showDirectoryPicker|indexedDB|localStorage|sessionStorage/, sourceFiles],
  ["动态代码 eval / new Function", /\beval\s*\(|new\s+Function\s*\(/, sourceFiles],
  ["非语音代码硬编码外部 URL", /https?:\/\//, nonNetworkFiles],
  ["正则后行断言（iOS 16.4 以下不支持）", /\(\?<=|\(\?<!/, sourceFiles],
  ["detachLeaves（onunload 不应 detach leaves）", /detachLeavesOfType|detachLeaves/, sourceFiles],
  ["非 error 级控制台日志", /console\.(log|debug|info|warn)\s*\(/, sourceFiles],
];
for (const [name, pattern, files] of forbidden) {
  const hits = findInSources(files, pattern);
  check("移动端与运行时", name, hits.length === 0, hits.join(" | "));
}
// 语音联网约束：只有 edgeEngine / cloud 两个语音引擎能联网，且默认都关闭。
const cloudFile = join(SRC, "speech", "cloud.ts");
const edgeFile = join(SRC, "speech", "edgeEngine.ts");
const requestUrlHits = findInSources(
  sourceFiles.filter((file) => file !== cloudFile),
  /requestUrl\s*\(/,
);
check("移动端与运行时", "requestUrl 仅存在于自定义 TTS 网关适配层", requestUrlHits.length === 0, requestUrlHits.join(" | "));
const typesTs = read(join(SRC, "types.ts"));
check(
  "移动端与运行时",
  "两个联网引擎默认都不启用（cloud 关闭且地址/密钥留空，edge 非默认）",
  /cloudTtsEnabled:\s*false/.test(typesTs) &&
    /cloudTtsUrl:\s*""/.test(typesTs) &&
    /cloudTtsKey:\s*""/.test(typesTs) &&
    /speechEngine:\s*"system"/.test(typesTs),
  "DEFAULT_SETTINGS",
);
check("移动端与运行时", "自定义网关适配层使用宿主 requestUrl（双端可用）", /requestUrl\s*\(/.test(read(cloudFile)), cloudFile);
check(
  "移动端与运行时",
  "main.ts 已接入两个语音引擎且 Edge 仅桌面启用",
  /from\s+["'][^"']*speech\/cloud["']/.test(mainTs) &&
    /createCloudTtsEngine/.test(mainTs) &&
    /await import\(["'][^"']*speech\/edgeEngine["']\)/.test(mainTs) &&
    /!Platform\.isMobile[\s\S]{0,120}await import/.test(mainTs),
  "语音为唯一联网入口（Edge 仅桌面动态加载）",
);
// P1-1：协议常量已拆到 edgeProtocol.ts，断言同时覆盖两个文件。
const edgeProtocolFile = join(SRC, "speech", "edgeProtocol.ts");
const edgeSource = read(edgeFile) + read(edgeProtocolFile);
check(
  "移动端与运行时",
  "Edge 引擎使用 DRM v2 与新端点（非已失效的 v1）",
  /generateSecMsGecV2/.test(edgeSource) &&
    /api\.msedgeservices\.com/.test(edgeSource) &&
    /Sec-MS-GEC-Version=\$\{gecVersion\}/.test(read(edgeFile)),
  "edgeEngine.ts + edgeProtocol.ts",
);
check(
  "稳健性",
  "P1-1 Edge 接口版本可由设置页热修（默认留空用内置值）",
  /edgeGecVersion:\s*""/.test(typesTs) &&
    /resolveGecVersion/.test(read(edgeProtocolFile)) &&
    /getGecVersion\?/.test(read(edgeFile)) &&
    /getGecVersion:/.test(mainTs) &&
    /Edge 接口版本/.test(settings),
  "types / edgeProtocol / edgeEngine / main / SettingsTab",
);
check(
  "稳健性",
  "P1-1 设置页只引零 Node 依赖的协议模块（不把 ws 带进移动端）",
  /from ["'][^"']*speech\/edgeProtocol["']/.test(settings) &&
    !/from ["'][^"']*speech\/edgeEngine["']/.test(settings),
  "SettingsTab.ts import",
);
check(
  "稳健性",
  "P1-1 403 有可操作诊断并可回传朗读能力",
  /describeEdgeFailure/.test(edgeSource) &&
    /403/.test(read(edgeProtocolFile)) &&
    /unexpected-response/.test(read(edgeFile)) &&
    /engineLastError/.test(read(join(SRC, "data", "SpeechService.ts"))) &&
    /最近失败/.test(settings),
  "edgeProtocol / edgeEngine / SpeechService / SettingsTab",
);
check(
  "移动端与运行时",
  "产物含语音联网能力（Edge 端点 + 宿主 requestUrl）",
  /api\.msedgeservices\.com/.test(mainJs) && /\brequestUrl\b/.test(mainJs),
  "仅语音路径使用",
);
check(
  "移动端与运行时",
  "用户显式开启的网关配置会被保留（不再强制归零）",
  !/cloudTtsEnabled:\s*false/.test(read(join(SRC, "domain", "pluginData.ts"))),
  "normalizeSettings",
);

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

// ── 2b. v1.0.2 界面形态 ─────────────────────────────────────
const workbenchView = read(join(SRC, "ui", "WorkbenchView.ts"));
const historyView = read(join(SRC, "ui", "HistoryView.ts"));
const chartTs = read(join(SRC, "ui", "Chart.ts"));
const uiModelTs = read(join(SRC, "domain", "uiModel.ts"));
check(
  "界面形态",
  "今日页签与卡片标题统一为「今日」",
  /today:\s*"今日"/.test(uiModelTs) && /`今日 · \$\{day\}`/.test(uiModelTs),
  "TAB_LABELS / todayCardTitle",
);
check(
  "界面形态",
  "今日 / 复习 / 浏览历史清单不再有「打开原文」按钮",
  !workbenchView.includes('text: "打开原文"') && !historyView.includes('text: "打开原文"'),
  "笔记名本身即入口",
);
check(
  "界面形态",
  "统计页只有列表内横向条形图，无上方纵向 SVG 柱状图",
  workbenchView.includes("renderBarMeter(") &&
    !workbenchView.includes("renderChart(") &&
    !workbenchView.includes("kw-chart-scroll") &&
    chartTs.includes("kw-count-bar-fill") &&
    css.includes(".kw-count-bar-fill") &&
    !css.includes(".kw-chart-bar"),
  "两张已有卡片的下半部分",
);
check(
  "界面形态",
  "设置页暴露自定义 TTS 网关配置（地址/密钥/模型/音色/开关）",
  /API 密钥/.test(settings) &&
    /服务地址/.test(settings) &&
    /启用自定义网关/.test(settings) &&
    /Edge 音色/.test(settings),
  "朗读分组",
);
check(
  "界面形态",
  "安卓语音预设下拉预置国内神经 TTS（一键配置）",
  /安卓语音预设/.test(settings) &&
    /cosyvoice-v3-flash/.test(settings) &&
    /dashscope\.aliyuncs\.com/.test(settings) &&
    /qwen-tts/.test(settings),
  "朗读分组：阿里云百炼 CosyVoice3 / Qwen-TTS",
);
check(
  "界面形态",
  "朗读窗口语速下拉与样式（暂停拖动续播同步）",
  /kw-speech-rate/.test(read(join(SRC, "ui", "SpeechBar.ts"))) &&
    /\.kw-speech-rate/.test(css) &&
    /onRateChange/.test(read(join(SRC, "ui", "NoteModal.ts"))) &&
    /pendingResumeFromSeek/.test(read(join(SRC, "data", "SpeechService.ts"))),
  "SpeechBar 语速 select + SpeechService 暂停态 seek 标记",
);
check(
  "界面形态",
  "Piper 已彻底移除（无引擎 / 脚本 / 设置项 / 类型残留）",
  !existsSync(join(SRC, "speech", "piperEngine.ts")) &&
    !/"piper"/.test(typesTs) &&
    !/piperModelDir|piperVoiceId/.test(typesTs) &&
    !/createPiperEngine/.test(mainTs) &&
    !/piper:setup/.test(read(join(ROOT, "package.json"))),
  "源码 / 依赖 / 设置项均无 Piper 残留",
);

// ── 3. 构建产物纯净度 ─────────────────────────────────────────
check("产物", "main.js 存在且非空", mainJs.length > 1000, `${mainJs.length} 字节`);
for (const [name, pattern] of [
  ["产物无 innerHTML", /\.innerHTML|\.outerHTML|\.insertAdjacentHTML/],
  ["产物无 eval", /\beval\s*\(/],
]) {
  check("产物", name, !pattern.test(mainJs));
}
// 语音联网例外：产物含 Edge 端点、SSML 命名空间与网关占位地址；Node 内置模块
// require 由 ws 懒加载工厂持有，且 edgeEngine 仅桌面动态加载，手机端不触发。
const externalUrls = [...mainJs.matchAll(/https?:\/\/[^\s"'()]+/g)].map((m) => m[0]);
const allowedUrlPrefixes = [
  "http://www.w3.org/2001/10/synthesis", // SSML XML 命名空间（不是网络请求）
  "https://api.msedgeservices.com", // Edge 神经语音端点
  "https://dashscope.aliyuncs.com", // 设置页网关预设：阿里云百炼 CosyVoice3 / Qwen-TTS
  "https://api.siliconflow.cn", // 设置页网关预设：硅基流动 CosyVoice2
  "https://api.openai.com", // 设置页网关预设：OpenAI 官方
];
check(
  "产物",
  "产物外部 URL 仅限语音相关（Edge 端点 / SSML 命名空间 / 网关示例）",
  externalUrls.every((url) => allowedUrlPrefixes.some((p) => url.startsWith(p))),
  [...new Set(externalUrls)].join(" | "),
);
check(
  "产物",
  "Node 内置 require 由 Edge 引擎延迟使用（obsidian 仍为唯一顶层宿主依赖）",
  /require\(["']obsidian["']\)/.test(mainJs) &&
    /require\(["']crypto["']\)/.test(mainJs) &&
    /await import|Promise\.resolve\(\)\.then/.test(mainJs),
  "edgeEngine 桌面动态加载",
);
check("产物", "obsidian 保持外置（require('obsidian')）", /require\(["']obsidian["']\)/.test(mainJs));
check("产物", "styles.css 零硬编码颜色", !/#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(/.test(css));

// ── P1-2：密钥落盘链路（第三步）────────────────────────────
// 结论口径：密钥明文只存在于用户本机的 data.json（设置读写），不上报到服务端以外、
// 不写进 index.json / .ics / 导出目录 / 日志 / 打包产物。这里是自动门禁，防止回归。
const keyHolders = sourceFiles.filter((file) => read(file).includes("cloudTtsKey"));
const keyAllowed = new Set([
  join(SRC, "types.ts"),
  join(SRC, "domain", "pluginData.ts"),
  join(SRC, "main.ts"),
  join(SRC, "ui", "SettingsTab.ts"),
]);
check(
  "隐私",
  "API 密钥只在设置定义 / 归一化 / 引擎注入 / 设置页四处出现",
  keyHolders.length === keyAllowed.size && keyHolders.every((f) => keyAllowed.has(f)),
  keyHolders.map((f) => relative(ROOT, f)).join(" | "),
);
const derivedNames = [
  "VaultIndexService", "IcsService", "WorkbenchService", "FrontmatterService",
  "WorkbenchView", "HistoryView", "NoteModal", "SpeechBar", "TagModal",
];
const keyLeaks = sourceFiles.filter(
  (file) =>
    derivedNames.some((name) => file.endsWith(`${name}.ts`)) &&
    /cloudTtsKey|Authorization|Bearer/.test(read(file)),
);
check(
  "隐私",
  "密钥不写入索引 / .ics / 导出 / 弹窗等 vault 派生路径",
  keyLeaks.length === 0,
  keyLeaks.map((f) => relative(ROOT, f)).join(" | "),
);
const logLeaks = findInSources(
  sourceFiles,
  /console\.(error|warn|log|debug|info)\s*\([^)]*(cloudTtsKey|Authorization|Bearer)/,
);
check("隐私", "控制台日志不回显密钥 / 请求头", logLeaks.length === 0, logLeaks.join(" | "));
const cloudSource = read(cloudFile);
check(
  "隐私",
  "网关错误文案脱敏（不回显密钥 / 请求对象）",
  /summarizeRequestError/.test(cloudSource) &&
    /describeCloudFailure/.test(cloudSource) &&
    // 只允许经 summarizeRequestError 把错误交给界面；脱敏函数内部用 String 不在此列。
    !/handlers\.onError\(\s*(?:String\(error\)|error\.message|error)\s*\)/.test(cloudSource),
  "cloud.ts",
);
check(
  "隐私",
  "设置页密钥框 password 遮盖 + 同步盘风险常驻提示",
  /["']type["']\s*,\s*["']password["']/.test(settings) && /同步盘/.test(settings),
  "SettingsTab.ts",
);

// ── P1-4：Node 内置模块合规（第三步）────────────────────────
// ws 是桌面 Edge 引擎设置自定义 Host/Origin/UA 头所需，产物会带出一组 Node 内置
// require；清单保持 isDesktopOnly:false，靠 Platform.isMobile 动态 import 门控。
const requireTargets = [
  ...new Set(
    [...mainJs.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]),
  ),
];
const allowedRequires = new Set([
  "obsidian", "crypto", "buffer", "events", "http", "https", "net",
  "stream", "tls", "url", "zlib", "bufferutil", "utf-8-validate",
]);
check(
  "合规",
  "产物 Node require 仅来自 ws 依赖清单（无 fs / child_process / electron）",
  requireTargets.length > 0 &&
    requireTargets.every((name) => allowedRequires.has(name)) &&
    !["fs", "child_process", "electron", "os", "path"].some((name) =>
      requireTargets.includes(name),
    ),
  requireTargets.join(" / "),
);
const manifestJson = JSON.parse(read(join(ROOT, "manifest.json")));
check(
  "合规",
  "Edge Node 模块由 Platform.isMobile 门控，isDesktopOnly 保持 false",
  manifestJson.isDesktopOnly === false &&
    /!Platform\.isMobile[\s\S]{0,200}await import\(["'][^"']*edgeEngine["']\)/.test(mainTs),
  `isDesktopOnly=${manifestJson.isDesktopOnly} / 桌面动态 import`,
);

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
// 官方 Manifest 文档 https://docs.obsidian.md/Reference/Manifest#name：
// name 仅用 Basic Latin 字符，标点只允许 - + ()，禁止 emoji / 特殊字符 / 非拉丁文字。
check("清单", "插件名仅用 Basic Latin 且标点限 - + ()（官方命名规范）", /^[A-Za-z][A-Za-z0-9 +\-()]*$/.test(manifest.name ?? ""), String(manifest.name));
check("清单", "插件名不以 Plugin 结尾 / Obsi 开头 / dian 结尾", !/plugin$/i.test(manifest.name ?? "") && !/^obs?i/i.test(manifest.name ?? "") && !/dian$/i.test(manifest.name ?? ""), String(manifest.name));
check("清单", "描述以英文标点结尾且不含 Obsidian / 不超 250 字符", /[.!?)\]]$/.test(manifest.description ?? "") && !/obsidian/i.test(manifest.description ?? "") && (manifest.description ?? "").length <= 250, String(manifest.description).slice(-40));
// P0-2 防回归：描述不得再宣称绝对「零网络请求」，必须写明默认离线 + 仅可选神经朗读联网，
// 与实际 Edge / 自定义网关行为一致（社区审核合规 + 用户隐私预期）。
check(
  "清单",
  "manifest / package 描述与实际联网行为一致（默认离线、仅朗读可选联网）",
  [manifest.description, pkg.description].every(
    (text) =>
      /offline by default/i.test(String(text)) &&
      /(speech|read.aloud|voice)/i.test(String(text)) &&
      /network/i.test(String(text)) &&
      !/zero network|no network/i.test(String(text)),
  ),
  String(manifest.description).slice(0, 60),
);
const minParts = String(manifest.minAppVersion ?? "0.0.0").split(".").map(Number);
// workspace.revealLeaf 的 Promise 重载自 1.7.2 起提供，声明更低版本会被社区审核判
// obsidianmd/no-unsupported-api Error（1.0.4 审核失败的真实原因）。
check("清单", "minAppVersion ≥ 1.7.2（revealLeaf 签名要求）", minParts[0] > 1 || (minParts[0] === 1 && minParts[1] >= 7), String(manifest.minAppVersion));
check(
  "清单",
  "运行时依赖仅 ws（Edge 语音在桌面设置自定义请求头所需）",
  JSON.stringify(Object.keys(pkg.dependencies ?? {})) === JSON.stringify(["ws"]),
  JSON.stringify(pkg.dependencies ?? {}),
);

// ── 5. 发布材料齐备（定稿 P6-6）───────────────────────────────
for (const file of ["main.js", "manifest.json", "styles.css", "versions.json", "README.md", "LICENSE", "CHANGELOG.md"]) {
  const path = join(ROOT, file);
  check("发布材料", `${file} 存在`, existsSync(path) && statSync(path).size > 0);
}
const readme = read(join(ROOT, "README.md"));
check("发布材料", "README 写明关 App 后不推送 / 用 .ics", /\.ics/.test(readme) && /(不推送|不再提醒|系统日历)/.test(readme));
check("发布材料", "README 写明手机端朗读可能不可用", /手机|移动端/.test(readme) && /朗读/.test(readme));
check(
  "发布材料",
  "README 声明默认离线且朗读为唯一联网例外",
  /默认.*(离线|不联网)/.test(readme) && /朗读.*唯一.*联网/.test(readme),
);
check(
  "发布材料",
  "README 说明语音联网例外与默认离线",
  /零网络|不联网|离线/.test(readme) &&
    /Edge/.test(readme) &&
    /网关|TTS/.test(readme) &&
    /联网/.test(readme),
);

// ── 5b. 第四步工程债清理：校验工具链与防回归门禁 ─────────────
// P2-5 把第一 / 二 / 三步靠手工 CDP 核对的 UI 结论固化为可重复运行的断言；
// 发布门禁只负责确认「工具齐备 + 已接入清单 + 覆盖面」，不重复跑行为单测。
const uiSmoke = read(join(ROOT, "scripts", "ui-smoke.mjs"));
const obsLint = read(join(ROOT, "scripts", "lint-obsidian.mjs"));
const p2Test = read(join(SRC, "__tests__", "p2.test.ts"));
const pkgText = read(join(ROOT, "package.json"));
check(
  "工程债",
  "P2-5 UI 自动冒烟脚本齐备并接入 npm 清单",
  existsSync(join(ROOT, "scripts", "ui-smoke.mjs")) &&
    /"smoke:ui"\s*:\s*"node scripts\/ui-smoke\.mjs"/.test(pkgText) &&
    /ui-smoke\.json/.test(uiSmoke) &&
    /CDP_SETTINGS_TITLE/.test(uiSmoke) &&
    /不改笔记/.test(uiSmoke),
  "scripts/ui-smoke.mjs + package.json smoke:ui（只读 DOM）",
);
check(
  "工程债",
  "P2-5 冒烟覆盖 UI 结论（引擎标签 / 语速 / 属性折叠 / 网关状态 / 页脚 / 页签）",
  ["kw-speech-engine", "kw-speech-rate", "kw-fm-grid", "kw-gateway-status", "kw-footer", "kw-tab"].every(
    (sel) => uiSmoke.includes(sel),
  ),
  "六类选择器断言",
);
check(
  "工程债",
  "P2-6/P2-7 社区 lint 基线归零且提升为 Error 级",
  /"no-global-this":\s*0/.test(obsLint) &&
    /"prefer-active-window \/ 裸 requestAnimationFrame":\s*0/.test(obsLint) &&
    /scan\(sourceFiles, "no-global-this/.test(obsLint) &&
    /scan\(sourceFiles, "prefer-active-window/.test(obsLint),
  "scripts/lint-obsidian.mjs",
);
check(
  "工程债",
  "P2 行为回归单测齐备（短退避 / 预取隔离 / 共享核心 / 死路径 / 宿主 API）",
  existsSync(join(SRC, "__tests__", "p2.test.ts")) &&
    ["P2-1", "P2-2", "P2-3", "P2-4", "P2-6/7"].every((tag) => p2Test.includes(tag)),
  "src/__tests__/p2.test.ts",
);

// ── 5c. 复审 V2（1.0.10）修复：防回归门禁 ──────────────────
// 复审报告（全量复审报告_20261121_V2.md）P0=0 / P1=2 / P2=8 的修复守护；
// 行为断言在 p3.test.ts，这里只锁「实现存在 + 接入点正确 + 死代码不回流」。
const p3Test = read(join(SRC, "__tests__", "p3.test.ts"));
const inlineTags = read(join(SRC, "domain", "inlineTags.ts"));
const mainSrc = read(join(SRC, "main.ts"));
const speechBarSrc = read(join(SRC, "ui", "SpeechBar.ts"));
const speechServiceSrc = read(join(SRC, "data", "SpeechService.ts"));
const workbenchViewSrc = read(join(SRC, "ui", "WorkbenchView.ts"));
const tagModalSrc = read(join(SRC, "ui", "TagManagerModal.ts"));
const settingsTabSrc = read(join(SRC, "ui", "SettingsTab.ts"));
const taskServiceSrc = read(join(SRC, "domain", "TaskService.ts"));
const uiModelSrc = read(join(SRC, "domain", "uiModel.ts"));
check(
  "复审V2",
  "P1-1 内联标签替换纯函数化（frontmatter 定界 + 链接锚点保护）",
  existsSync(join(SRC, "domain", "inlineTags.ts")) &&
    /splitFrontmatterLines/.test(inlineTags) &&
    mainSrc.includes('from "./domain/inlineTags"') &&
    !mainSrc.includes("fmCount"),
  "src/domain/inlineTags.ts + src/main.ts",
);
check(
  "复审V2",
  "P1-2 无效设置已删除（staleDays 无消费者、staleBaseDate 清零）",
  !settingsTabSrc.includes("staleDays") && !taskServiceSrc.includes("staleBaseDate"),
  "SettingsTab.ts / TaskService.ts",
);
check(
  "复审V2",
  "P2-1 SpeechBar 自由语速动态档（设置页任意 0.5–3 值不空白）",
  speechBarSrc.includes("syncRateOptions") && /当前 /.test(speechBarSrc),
  "src/ui/SpeechBar.ts",
);
check(
  "复审V2",
  "P2-2/P2-3 Piper 残留与死状态清零",
  !speechServiceSrc.includes("正在加载") &&
    !workbenchViewSrc.includes("lastModal") &&
    !uiModelSrc.includes("filterPaths"),
  "SpeechService / WorkbenchView / uiModel",
);
check(
  "复审V2",
  "P2-4/5/6 截断提示 + 折叠状态持久 + 今日页分组懒加载",
  /已显示前 30 个/.test(workbenchViewSrc) &&
    workbenchViewSrc.includes("runtimeInfoOpen") &&
    workbenchViewSrc.includes("renderTodayGroup"),
  "src/ui/WorkbenchView.ts",
);
check(
  "复审V2",
  "P2-7/P2-8 弹窗两步确认 + 音色下拉动态刷新",
  !tagModalSrc.includes("window.confirm") &&
    tagModalSrc.includes("armed") &&
    settingsTabSrc.includes("refreshVoiceOptions"),
  "TagManagerModal.ts / SettingsTab.ts",
);
check(
  "复审V2",
  "P1/P2 行为回归单测齐备（p3.test.ts 覆盖全部修复项）",
  existsSync(join(SRC, "__tests__", "p3.test.ts")) &&
    ["P1-1", "P1-2", "P2-1", "P2-2", "P2-3", "P2-4", "P2-5", "P2-6", "P2-7", "P2-8"].every(
      (tag) => p3Test.includes(tag),
    ),
  "src/__tests__/p3.test.ts",
);

check(
  "复审V2",
  "清空密钥按钮（两步确认 + 只清密钥 + 即时刷新状态）",
  settingsTabSrc.includes("清空已保存的 API 密钥") &&
    settingsTabSrc.includes("clearKeyArmed") &&
    settingsTabSrc.includes('cloudTtsKey: ""') &&
    settingsTabSrc.includes('cloudKeyInput?.setValue("")') &&
    /config\.key\.trim\(\)\.length > 0/.test(read(join(SRC, "speech", "cloud.ts"))),
  "src/ui/SettingsTab.ts + src/speech/cloud.ts",
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
