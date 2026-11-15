import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
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
