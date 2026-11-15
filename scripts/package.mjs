/**
 * P6 打包发布（定稿 P6-5）：产出符合 Obsidian 社区插件 / BRAT 要求的 zip。
 * zip 内直接是 main.js / manifest.json / styles.css 三个文件（无顶层目录）。
 * 纯 Node 内置模块实现 ZIP store 格式，零外部依赖、跨平台、结果可复现。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, "package");
const FILES = ["main.js", "manifest.json", "styles.css"];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 固定时间戳让同一份产物可复现；ZIP 使用 DOS 日期时间。 */
function dosDateTime() {
  const date = new Date("2026-01-01T00:00:00Z");
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function buildZip(entries) {
  const { time, day } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store，不压缩
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

mkdirSync(STAGE, { recursive: true });
for (const file of FILES) {
  if (!existsSync(join(ROOT, file))) {
    console.error(`[package] 缺少 ${file}，请先运行 npm run build`);
    process.exit(1);
  }
  copyFileSync(join(ROOT, file), join(STAGE, file));
}

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const zipName = `knowledge-workbench-${manifest.version}.zip`;
const entries = FILES.map((file) => ({
  name: file,
  data: readFileSync(join(STAGE, file)),
}));
const zip = buildZip(entries);
const zipPath = join(DIST, zipName);
writeFileSync(zipPath, zip);

const assets = FILES.map((file) => ({
  file,
  bytes: readFileSync(join(STAGE, file)).length,
  sha256: createHash("sha256").update(readFileSync(join(STAGE, file))).digest("hex"),
}));
const releaseManifest = {
  pluginId: manifest.id,
  version: manifest.version,
  minAppVersion: manifest.minAppVersion,
  isDesktopOnly: manifest.isDesktopOnly,
  zip: zipName,
  zipBytes: zip.length,
  zipSha256: createHash("sha256").update(zip).digest("hex"),
  assets,
  note: "GitHub Release tag 必须与 version 一致；社区插件目录会读取仓库根的 manifest.json / versions.json。",
};
writeFileSync(join(DIST, "release-manifest.json"), JSON.stringify(releaseManifest, null, 2), "utf8");

console.log(`[package] ${zipName} (${zip.length} 字节)`);
for (const asset of assets) console.log(`  ${asset.file.padEnd(16)} ${String(asset.bytes).padStart(8)} 字节  ${asset.sha256.slice(0, 16)}…`);
console.log(`[package] 产物目录：${DIST}`);
console.log(`[package] 目录内容：${readdirSync(DIST).join(", ")}`);
