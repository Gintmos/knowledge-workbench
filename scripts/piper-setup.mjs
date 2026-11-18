/**
 * 一次性准备 Piper 本地朗读资源（1.0.7）。
 *
 * 用法：
 *   npm run piper:setup -- "C:\Users\wintm\Documents\Obsidian Vault\脑汁保险柜"
 *
 * 只写库内默认目录 知识管理工作台/tts，不修改插件程序文件、不写 data.json。
 * 下载源默认走 hf-mirror.com；可用 PIPER_MIRROR 环境变量覆盖。
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import process from "node:process";

const vault = process.argv[2];
if (!vault) {
  console.error("请传入 vault 绝对路径：npm run piper:setup -- <vault 路径>");
  process.exit(1);
}
if (!existsSync(vault)) {
  console.error(`vault 路径不存在：${vault}`);
  process.exit(1);
}

const target = join(vault, "知识管理工作台", "tts");
mkdirSync(target, { recursive: true });
const force = process.argv.includes("--force");
const mirror = process.env.PIPER_MIRROR ?? "https://hf-mirror.com";
const voice = "zh_CN-huayan-medium";
const base = `${mirror}/diffusionstudio/piper-voices/resolve/main/zh/zh_CN/huayan/medium`;
const downloads = [
  [`${base}/${voice}.onnx`, `${voice}.onnx`],
  [`${base}/${voice}.onnx.json`, `${voice}.onnx.json`],
];

const nodeModules = join(process.cwd(), "node_modules");
const piperBuild = join(nodeModules, "@diffusionstudio", "piper-wasm", "build");
const ortDist = join(nodeModules, "onnxruntime-web", "dist");
const copies = [
  [join(piperBuild, "piper_phonemize.js"), "piper_phonemize.js"],
  [join(piperBuild, "piper_phonemize.wasm"), "piper_phonemize.wasm"],
  [join(piperBuild, "piper_phonemize.data"), "piper_phonemize.data"],
  [join(ortDist, "ort.wasm.min.mjs"), "ort.wasm.min.mjs"],
];
for (const name of [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.wasm",
]) {
  const source = join(ortDist, name);
  if (existsSync(source)) copies.push([source, name]);
}

const shouldSkip = (name) => existsSync(join(target, name)) && !force;

async function download(url, name) {
  if (shouldSkip(name)) {
    console.log(`跳过已存在：${name}`);
    return;
  }
  console.log(`下载 ${name} ...`);
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "knowledge-workbench-piper-setup" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(join(target, name)));
}

for (const [url, name] of downloads) await download(url, name);
for (const [source, name] of copies) {
  if (!existsSync(source)) {
    console.warn(`缺少本地文件，已跳过：${source}`);
    continue;
  }
  if (shouldSkip(name)) {
    console.log(`跳过已存在：${name}`);
    continue;
  }
  copyFileSync(source, join(target, name));
  console.log(`复制 ${name}`);
}

const files = downloads.map(([, name]) => name).concat(copies.map(([, name]) => name));
let total = 0;
for (const name of new Set(files)) {
  const file = join(target, name);
  if (existsSync(file)) total += statSync(file).size;
}
console.log(`\n完成：${target}`);
console.log(`共 ${new Set(files).size} 个文件，约 ${(total / 1024 / 1024).toFixed(1)} MB。`);
console.log("现在到插件设置页选择「Piper 本地语音」，或点「重新检测」。");
