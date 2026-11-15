import esbuild from "esbuild";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// 仅在测试中把宿主的 obsidian 模块换成内存实现，插件产物不受影响。
const mockObsidian = {
  name: "mock-obsidian-for-tests",
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({
      path: resolve("src/__tests__/obsidian-mock.ts"),
    }));
  },
};

const outDir = ".tmp-tests";
const testDir = "src/__tests__";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const sources = readdirSync(testDir).filter((file) => file.endsWith(".test.ts"));
if (sources.length === 0) {
  console.error("[knowledge-workbench] no *.test.ts found");
  process.exit(1);
}

try {
  await esbuild.build({
    entryPoints: sources.map((file) => join(testDir, file)),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outdir: outDir,
    external: ["node:*"],
    plugins: [mockObsidian],
    logLevel: "warning",
  });

  const outputs = sources.map((file) => join(outDir, file.replace(/\.ts$/, ".js")));
  const result = spawnSync(process.execPath, ["--test", ...outputs], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
