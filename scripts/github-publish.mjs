/**
 * 合并发布 1.0.7（1.0.6 + 1.0.7 全部改动）到 GitHub（仅维护者使用，不随插件发布）。
 * 通过 GitHub REST API 完成：blobs -> tree -> commit -> 更新 main -> tag -> release -> 4 资产。
 * PAT 仅从 git 凭据管理器读取，保存在内存中，不写命令行、不写文件、不进仓库。
 * 代理完全依赖环境变量（HTTPS_PROXY），不硬编码端口。
 * 全程幂等：tag / release / 资产已存在则跳过，失败可安全重跑。
 *
 * 用法：node scripts/github-publish.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const OWNER = "Gintmos";
const REPO = "knowledge-workbench";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const TMP_HEADER = path.join(ROOT, ".tmp-publish-header");
const TMP_BODY = path.join(ROOT, ".tmp-publish-body");

function fail(msg) {
  console.error(`[publish] FAILED: ${msg}`);
  process.exit(1);
}

// 1) 从 git 凭据管理器读取 PAT（仅内存）。
let token = "";
try {
  const cred = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  for (const line of cred.split(/\r?\n/)) {
    if (line.startsWith("password=")) token = line.slice("password=".length);
  }
} catch (error) {
  fail(`读取 git 凭据失败：${error.message}`);
}
if (!token) fail("git 凭据中没有 password（PAT）");
console.log("[publish] 凭据已读取（仅内存）");

function writeHeader(extra = []) {
  const lines = [
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/vnd.github+json"',
    'header = "X-GitHub-Api-Version: 2022-11-28"',
    ...extra,
  ];
  writeFileSync(TMP_HEADER, lines.join("\n") + "\n", "utf8");
}

/** 统一 API 调用：header 与 body 都走临时文件，避免 stdin 冲突。 */
function api(method, urlPath, bodyObj, { base = API, timeout = 90, soft = false } = {}) {
  writeHeader();
  const args = [
    "-sS", "--ssl-no-revoke", "--max-time", String(timeout),
    "-X", method, "--config", TMP_HEADER, `${base}${urlPath}`,
  ];
  if (bodyObj !== undefined) {
    writeFileSync(TMP_BODY, JSON.stringify(bodyObj), "utf8");
    args.push("--data-binary", "@" + TMP_BODY);
  }
  let result;
  try {
    result = execFileSync("curl", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error.stderr?.toString?.() || error.message;
    fail(`curl 失败：${method} ${urlPath} -> ${detail.slice(0, 500)}`);
  } finally {
    try { unlinkSync(TMP_HEADER); } catch { /* ignore */ }
    try { unlinkSync(TMP_BODY); } catch { /* ignore */ }
  }
  if (!result.trim()) fail(`空响应：${method} ${urlPath}`);
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    fail(`API 返回非 JSON：${method} ${urlPath} -> ${result.slice(0, 300)}`);
  }
  if (!soft && parsed && parsed.message && !parsed.sha && !parsed.id) {
    fail(`API 错误：${method} ${urlPath} -> ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const VERSION = manifest.version;
console.log(`[publish] 目标版本 ${VERSION}`);

// 当前 main 的 HEAD 与其 tree（base_tree）。
const ref = api("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
const baseSha = ref.object.sha;
const baseCommit = api("GET", `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
const baseTree = baseCommit.tree.sha;
console.log(`[publish] base commit ${baseSha.slice(0, 10)}`);

// 幂等短路：若远端 main 的 manifest.json 已是目标版本，提交阶段已完成，复用该 commit。
let remoteManifest = "";
try {
  const mf = api("GET", `/repos/${OWNER}/${REPO}/contents/manifest.json?ref=main`, undefined, { soft: true });
  if (mf && mf.content) remoteManifest = Buffer.from(mf.content, "base64").toString("utf8");
} catch { /* ignore */ }
const remoteVersion = (remoteManifest.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || "";

let commitSha = baseSha;
if (remoteVersion === VERSION) {
  console.log(`[publish] 远端 main 已是 ${VERSION}，跳过 blob/tree/commit，复用 ${baseSha.slice(0, 10)}`);
} else {
  // 收集待提交文件：跟踪改动 + 未跟踪（非忽略），排除本地维护脚本与临时文件。
  const EXCLUDE = new Set(["scripts/github-publish.mjs", "scripts/verify-piper-local.mjs"]);
  const changedRaw = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" }).trim();
  const untrackedRaw = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    encoding: "utf8",
  }).trim();
  const files = [...new Set([changedRaw, untrackedRaw].flatMap((s) => (s ? s.split(/\r?\n/) : [])))]
    .filter((f) => f && !f.startsWith(".tmp-publish") && !EXCLUDE.has(f));
  if (!files.length) fail("没有待提交的文件");
  console.log(`[publish] 变更文件 ${files.length} 个`);

  // 逐文件上传 blob（base64）。
  const treeEntries = [];
  for (const file of files) {
    const buf = readFileSync(path.join(ROOT, file));
    const blob = api("POST", `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: buf.toString("base64"), encoding: "base64",
    });
    if (!blob.sha) fail(`blob 上传失败：${file}`);
    treeEntries.push({ path: file, mode: "100644", type: "blob", sha: blob.sha });
    console.log(`  blob ${file} ${blob.sha.slice(0, 10)}`);
  }

  const tree = api("POST", `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: baseTree, tree: treeEntries,
  });
  console.log(`[publish] tree ${tree.sha.slice(0, 10)}`);

  const message = "feat: merge 1.0.6 + 1.0.7 (task followups, local Piper TTS, tag manager, catalog export)";
  const commit = api("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
    message, tree: tree.sha, parents: [baseSha],
  });
  commitSha = commit.sha;
  console.log(`[publish] commit ${commit.sha.slice(0, 10)}`);

  api("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: false });
  console.log("[publish] main 已更新");
}

// tag（已存在则跳过）。用统一的 api() 判断。
const tagRefCheck = api("GET", `/repos/${OWNER}/${REPO}/git/ref/tags/${VERSION}`, undefined, { soft: true });
const tagExists = !!(tagRefCheck && tagRefCheck.object);
if (tagExists) {
  console.log(`[publish] tag ${VERSION} 已存在，跳过`);
} else {
  api("POST", `/repos/${OWNER}/${REPO}/git/refs`, {
    ref: `refs/tags/${VERSION}`, sha: commitSha,
  });
  console.log(`[publish] tag ${VERSION} 已创建`);
}

// release（已存在则复用）。
let release = api("GET", `/repos/${OWNER}/${REPO}/releases/tags/${VERSION}`, undefined, { soft: true });
if (release && release.id) {
  console.log(`[publish] Release ${VERSION} 已存在，复用`);
} else {
  release = api("POST", `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: VERSION,
    name: VERSION,
    body:
      `知识管理工作台 Obsidian 插件 ${VERSION}\n\n` +
      `本版本合并 1.0.6 + 1.0.7 全部改动：\n` +
      `- 任务级「催办 / 待办」替代笔记级「过时」，.ics 任务级文案与 uid 加固；\n` +
      `- 统计页调试指标折叠、标签批量重命名 / 合并、导出笔记目录；\n` +
      `- 接通复习 / 到期命令与今日就地完成；\n` +
      `- 新增 Piper 本地语音引擎（WASM 离线合成，桌面 / 手机共用，失败回退系统语音）。\n\n` +
      `安装：下载 knowledge-workbench-${VERSION}.zip，解压三个文件放入 ` +
      `<vault>/.obsidian/plugins/knowledge-workbench/。`,
    draft: false,
    prerelease: false,
  });
  console.log(`[publish] Release ${VERSION} 已创建`);
}

// 上传 4 个资产（已存在同名则跳过）。
const existing = api("GET", `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`);
const existingNames = new Set(Array.isArray(existing) ? existing.map((a) => a.name) : []);
const ASSETS = ["main.js", "manifest.json", "styles.css", `dist/knowledge-workbench-${VERSION}.zip`];
for (const asset of ASSETS) {
  const abs = path.join(ROOT, asset);
  const name = path.basename(asset);
  const size = statSync(abs).size;
  if (existingNames.has(name)) {
    console.log(`  asset ${name} 已存在，跳过`);
    continue;
  }
  writeHeader(['header = "Content-Type: application/octet-stream"']);
  let result;
  try {
    result = execFileSync(
      "curl", ["-sS", "--ssl-no-revoke", "--max-time", "180", "-X", "POST",
        "--data-binary", "@" + abs, "--config", TMP_HEADER,
        `${UPLOADS}/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    const detail = error.stderr?.toString?.() || error.message;
    fail(`资产 ${name} 上传失败：${detail.slice(0, 400)}`);
  } finally {
    try { unlinkSync(TMP_HEADER); } catch { /* ignore */ }
  }
  const parsed = JSON.parse(result);
  if (!parsed.id) fail(`资产 ${name} 上传返回异常：${result.slice(0, 200)}`);
  console.log(`  asset ${name} ${size} bytes 上传成功`);
}

console.log(`[publish] DONE: ${VERSION} 已发布`);
console.log(`[publish] Release: https://github.com/${OWNER}/${REPO}/releases/tag/${VERSION}`);
