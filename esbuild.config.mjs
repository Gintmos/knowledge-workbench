import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Edge 神经语音需要设置自定义 Host/Origin/UA 头，浏览器原生 WebSocket 做不到，
  // 因此强制 ws 走 Node codepath（Electron 桌面端内置 Node，可 require 到 http/net/tls）。
  alias: { ws: resolve(here, "node_modules/ws/index.js") },
  external: [
    "obsidian",
    "electron",
    "codemirror",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2020",
  platform: "browser",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
};

const ctx = await esbuild.context(options);

if (watch) {
  await ctx.watch();
  console.log("[knowledge-workbench] watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log(`[knowledge-workbench] built main.js (${production ? "production" : "development"})`);
}
