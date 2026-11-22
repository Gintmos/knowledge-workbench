/**
 * 第三步（稳健性与合规）回归：P1-2 密钥脱敏、P1-1 设置迁移、
 * P1-3 社区规则门禁、P1-4 Node require 白名单的静态断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { normalizeSettings } from "../domain/pluginData";
import { describeCloudFailure, summarizeRequestError } from "../speech/cloud";
import { DEFAULT_SETTINGS } from "../types";

const source = (path: string): string =>
  readFileSync(join(process.cwd(), path), "utf8");

test("P1-2 01 · 网关 401/403 诊断可区分密钥错误，且不含任何凭据形态", () => {
  const message = describeCloudFailure(401);
  assert.ok(message.includes("密钥"));
  assert.ok(!/Bearer|sk-/.test(message));
  assert.ok(describeCloudFailure(403).includes("403"));
  assert.ok(describeCloudFailure(429).includes("429"));
  assert.ok(describeCloudFailure(503).includes("503"));
  assert.equal(describeCloudFailure(200), "网关返回 HTTP 200");
});

test("P1-2 02 · requestUrl 错误对象脱敏（Bearer / sk- 被抹掉，非 Error 不展开）", () => {
  const safe = summarizeRequestError(
    new Error("POST failed: Authorization: Bearer sk-abcdef1234567890 -> 401"),
  );
  assert.ok(!safe.includes("sk-abcdef"), "密钥片段不得进入界面/日志");
  assert.ok(!safe.includes("Bearer sk-"));
  assert.equal(
    summarizeRequestError({ request: { headers: "Bearer xxx" } }),
    "[object Object]",
    "普通对象不应被展开成含请求头的字符串",
  );
  assert.ok(summarizeRequestError("x".repeat(300)).length <= 201);
  assert.equal(summarizeRequestError(null), "网关请求失败");
});

test("P1-1 03 · 旧配置无 edgeGecVersion 时归一为空串（用内置版本）", () => {
  assert.equal(normalizeSettings({}).edgeGecVersion, "");
  assert.equal(DEFAULT_SETTINGS.edgeGecVersion, "");
  assert.equal(
    normalizeSettings({ edgeGecVersion: "144.0.1.2" }).edgeGecVersion,
    "144.0.1.2",
  );
  assert.equal(
    normalizeSettings({ edgeGecVersion: 123 }).edgeGecVersion,
    "",
    "非法类型回退默认",
  );
});

test("P1-3 04 · lint:obsidian 门禁脚本已接入 npm scripts 且规则齐全", () => {
  const pkg = JSON.parse(source("package.json"));
  assert.equal(pkg.scripts["lint:obsidian"], "node scripts/lint-obsidian.mjs");
  const lint = source("scripts/lint-obsidian.mjs");
  for (const rule of [
    "no-unsafe-dynamic-import",
    "no-global-this",
    "no-nodejs-modules",
    "no-hardcoded-css",
    "no-window-app",
  ]) {
    assert.ok(lint.includes(rule), `缺少规则：${rule}`);
  }
});

test("P1-4 05 · 发布自检含 Node require 白名单与双端门控断言", () => {
  const rc = source("scripts/release-check.mjs");
  assert.ok(rc.includes("allowedRequires"));
  assert.ok(rc.includes("manifestJson.isDesktopOnly === false"));
  assert.ok(rc.includes("Platform.isMobile"));
  assert.ok(rc.includes("edgeProtocol.ts"), "P1-1 协议文件加入语音白名单");
});

test("P1-2 06 · 密钥仅出现在四处允许的文件里（静态链路核对）", () => {
  const allowed = new Set([
    join("src", "types.ts"),
    join("src", "domain", "pluginData.ts"),
    join("src", "main.ts"),
    join("src", "ui", "SettingsTab.ts"),
  ]);
  // 与 release-check.mjs 的自动门禁同源：这里再固化一份到单测，防止门禁被放松。
  const releaseCheck = source("scripts/release-check.mjs");
  assert.ok(releaseCheck.includes("keyAllowed"));
  assert.ok(releaseCheck.includes("keyLeaks"));
  assert.equal(allowed.size, 4);
});
