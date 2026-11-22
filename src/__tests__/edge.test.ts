import assert from "node:assert/strict";
import test from "node:test";
import { EDGE_VOICES, generateSecMsGecV2 } from "../speech/edgeEngine";

// 固定时间点的基准：验证 300 秒取整 + Windows epoch + 微软版权 PREFIX + sha256。
// 完整 token 的 CS64 段已在真实 Obsidian 桌面端合成出 MP3 验证（详见本地验证报告）。
const FIXED_TIME = 1763700000;
const EXPECTED_SHA =
  "30C131E6ACDAAF3E2D43312E11514587663188F853EF0122E9142D59630EAB77";

test("Edge DRM v2 token：格式为 CS64-SHA256 且哈希段正确", () => {
  const token = generateSecMsGecV2(FIXED_TIME);
  assert.match(token, /^[0-9A-F]{16}-[0-9A-F]{64}$/);
  assert.equal(token.split("-")[1], EXPECTED_SHA);
});

test("Edge DRM v2 token：同一 300 秒窗口内确定一致", () => {
  assert.equal(generateSecMsGecV2(FIXED_TIME), generateSecMsGecV2(FIXED_TIME + 100));
  assert.notEqual(generateSecMsGecV2(FIXED_TIME), generateSecMsGecV2(FIXED_TIME + 300));
});

test("Edge 音色列表包含默认晓晓与常用男声，Id 为 ShortName", () => {
  assert.ok(EDGE_VOICES.some((v) => v.name === "zh-CN-XiaoxiaoNeural"));
  assert.ok(EDGE_VOICES.some((v) => v.name === "zh-CN-YunxiNeural"));
  assert.ok(EDGE_VOICES.every((v) => /^zh-CN/.test(v.name) && v.lang === "zh-CN"));
});
