/** P1-1：Edge DRM v2 版本热修与 403 诊断的纯函数回归。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  EDGE_DEFAULT_CHROMIUM_VERSION,
  EDGE_DEFAULT_GEC_VERSION,
  buildEdgeUserAgent,
  describeEdgeFailure,
  isValidGecVersionInput,
  resolveGecVersion,
} from "../speech/edgeProtocol";

test("P1-1 01 · 空值 / 非法值一律回退内置 DRM v2 版本（杜绝查询参数注入）", () => {
  assert.equal(resolveGecVersion(""), EDGE_DEFAULT_GEC_VERSION);
  assert.equal(resolveGecVersion("   "), EDGE_DEFAULT_GEC_VERSION);
  assert.equal(resolveGecVersion("../../evil?x=1"), EDGE_DEFAULT_GEC_VERSION);
  assert.equal(resolveGecVersion("2-143.0"), EDGE_DEFAULT_GEC_VERSION);
  assert.equal(isValidGecVersionInput("bad value"), false);
  assert.equal(EDGE_DEFAULT_GEC_VERSION, `2-${EDGE_DEFAULT_CHROMIUM_VERSION}`);
});

test("P1-1 02 · 裸版本号与 2- 前缀等价，留空合法", () => {
  const bare = "144.0.1234.56";
  assert.equal(resolveGecVersion(bare), `2-${bare}`);
  assert.equal(resolveGecVersion(`2-${bare}`), `2-${bare}`);
  assert.equal(resolveGecVersion(`  ${bare}  `), `2-${bare}`);
  assert.equal(isValidGecVersionInput(bare), true);
  assert.equal(isValidGecVersionInput(`2-${bare}`), true);
  assert.equal(isValidGecVersionInput(""), true);
});

test("P1-1 03 · 403 给出可操作热修指引，401 单独提示，普通错误原样保留", () => {
  const forbidden = describeEdgeFailure(403);
  assert.ok(forbidden.includes("403"));
  assert.ok(forbidden.includes("Edge 接口版本"));
  assert.ok(forbidden.includes("Chromium"));
  assert.ok(
    describeEdgeFailure("Unexpected server response: 403").includes("403"),
    "ws 的 error 文本也要能识别出 403",
  );
  assert.ok(describeEdgeFailure(401).includes("401"));
  assert.equal(describeEdgeFailure("合成超时"), "合成超时");
  assert.equal(describeEdgeFailure("x".repeat(300)).length <= 201, true);
});

test("P1-1 04 · UA 主版本跟随实际使用的版本号（跨大版本热修保持一致）", () => {
  const ua = buildEdgeUserAgent("2-144.0.1234.56");
  assert.ok(ua.includes("Chrome/144.0.0.0"));
  assert.ok(ua.includes("Edg/144.0.0.0"));
  assert.ok(
    buildEdgeUserAgent(EDGE_DEFAULT_GEC_VERSION).includes(
      `Chrome/${EDGE_DEFAULT_CHROMIUM_VERSION.split(".")[0]}.0.0.0`,
    ),
  );
});

test("P1-1 04b · 默认值与重构前的协议常量逐字一致（真机朗读零回归）", () => {
  assert.equal(EDGE_DEFAULT_CHROMIUM_VERSION, "143.0.3650.75");
  assert.equal(EDGE_DEFAULT_GEC_VERSION, "2-143.0.3650.75");
  assert.equal(
    buildEdgeUserAgent(EDGE_DEFAULT_GEC_VERSION),
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  );
});

test("P1-1 05 · 协议模块零 Node 依赖（手机端设置页可安全引用）", () => {
  const src = readFileSync(
    join(process.cwd(), "src", "speech", "edgeProtocol.ts"),
    "utf8",
  );
  assert.equal(
    /from\s+["'](?:node:)?(?:crypto|ws|fs|net|tls|http|https)["']|\brequire\s*\(/.test(src),
    false,
  );
  assert.ok(src.includes("wss://api.msedgeservices.com"));
});
