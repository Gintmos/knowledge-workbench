import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
const vault = arg ? path.resolve(arg) : path.join(root, "test-vault");
const target = path.join(vault, ".obsidian", "plugins", "knowledge-workbench");
const files = ["main.js", "manifest.json", "styles.css"];

const missing = files.filter((name) => !fs.existsSync(path.join(root, name)));
if (missing.length > 0) {
  console.error(`[link-vault] 缺少构建产物：${missing.join(", ")}，请先运行 npm run build`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
for (const name of files) {
  fs.copyFileSync(path.join(root, name), path.join(target, name));
}

console.log(`[link-vault] 已部署到 ${target}`);
console.log(`[link-vault] 产物：${files.join(", ")}`);
if (!arg) {
  console.log("[link-vault] 未指定 vault，使用工作区内的 test-vault（不触碰真实笔记库）。");
  console.log('[link-vault] 如需装到真实库：node scripts/link-vault.mjs "<vault 绝对路径>"');
}
