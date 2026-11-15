/**
 * 生成 Outlook 导入对照样本（P6 遗留项）。
 * 三个最小单事件文件用于逐一定位解析失败原因，另附新版多事件示例。
 * 全部使用与生产代码相同的折行 / 转义 / CRLF 逻辑，零外部依赖。
 */
import esbuild from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const TMP = ".tmp-ics";
const OUT = join(ROOT, "dist", "ics-samples");
const ENTRY = join(TMP, "entry.ts");

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(
  ENTRY,
  `export * from "../src/domain/ics";\n`,
  "utf8",
);

await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: join(TMP, "entry.js"),
  external: ["node:*"],
  logLevel: "warning",
});

const require = createRequire(import.meta.url);
const ics = require(join(ROOT, TMP, "entry.js"));
const stamp = ics.utcStamp(new Date("2026-11-15T08:00:00Z"));
const event = {
  uid: "kw-sample-20261120@local",
  date: "20261120",
  summary: "今日待办 · 示例笔记",
  description: "vault 内路径：示例笔记.md · 今日到期",
  path: "示例笔记.md",
  kind: "due",
};

const calendarHead = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//knowledge-workbench//zh-CN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
const fullHead = [...calendarHead, "X-WR-CALNAME:知识管理工作台提醒"];

function serialize(lines) {
  return `${lines.flatMap((line) => ics.foldIcsLine(line)).join("\r\n")}\r\n`;
}

function legacyLines(withDtend, hardened) {
  const lines = [...(hardened ? fullHead : calendarHead), "BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${stamp}`];
  if (hardened) lines.push("SEQUENCE:0", "STATUS:CONFIRMED");
  lines.push(`DTSTART;VALUE=DATE:${event.date}`);
  if (withDtend || hardened) lines.push(`DTEND;VALUE=DATE:${ics.nextIcsDate(event.date)}`);
  if (hardened) lines.push("X-MICROSOFT-CDO-ALLDAYEVENT:TRUE", "X-MICROSOFT-CDO-BUSYSTATUS:FREE");
  lines.push(
    `SUMMARY:${ics.escapeIcsText(event.summary)}`,
    `DESCRIPTION:${ics.escapeIcsText(event.description)}`,
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    "DESCRIPTION:明日待处理",
    "END:VALARM",
    "END:VEVENT",
  );
  lines.push("END:VCALENDAR");
  return lines;
}

mkdirSync(OUT, { recursive: true });
const files = [
  ["A-原版-单事件.ics", serialize(legacyLines(false, false))],
  ["B-仅加DTEND-单事件.ics", serialize(legacyLines(true, false))],
  ["C-全量加固-单事件.ics", serialize(legacyLines(true, true))],
];
// 生产路径校验：renderIcs 的输出应与「全量加固」完全一致（同一事件、同一时间戳）。
const production = ics.renderIcs([event], new Date("2026-11-15T08:00:00Z"));
if (production !== files[2][1]) {
  console.error("[ics-samples] 警告：生产 renderIcs 与全量加固样本不一致，请检查字段顺序。");
}
const many = [
  event,
  { ...event, uid: "kw-sample-20261121@local", date: "20261121", summary: "复习 · 第二篇" },
  { ...event, uid: "kw-sample-20261231@local", date: "20261231", summary: "知识更新 · 跨年" },
];
files.push([
  "D-新版多事件示例.ics",
  ics.renderIcs(many, new Date("2026-11-15T08:00:00Z")),
]);

for (const [name, text] of files) {
  writeFileSync(join(OUT, name), text, "utf8");
  const lines = text.split("\r\n");
  const max = Math.max(...lines.map((line) => Buffer.byteLength(line, "utf8")));
  console.log(`[ics-samples] ${name}  ${Buffer.byteLength(text, "utf8")} bytes · 最长行 ${max} octets · VEVENT ${(text.match(/BEGIN:VEVENT/g) || []).length}`);
}

writeFileSync(
  join(OUT, "对照说明.md"),
  [
    "# Outlook .ics 导入对照样本",
    "",
    "按顺序把 A / B / C 逐个拖入 Outlook（建议先用「文件 → 打开和导出 → 导入/导出 → 从另一程序或文件导入」选择 iCalendar）：",
    "",
    "| 文件 | 差异 | 预期 |",
    "| --- | --- | --- |",
    "| A-原版-单事件.ics | 1.0.0 原格式，全天事件没有 DTEND | 若报错，说明 DTEND 是根因 |",
    "| B-仅加 DTEND-单事件.ics | 只补 `DTEND;VALUE=DATE:20261121`（次日，排他结束） | 应能导入；若仍报错，说明还需 Microsoft 兼容字段 |",
    "| C-全量加固-单事件.ics | 1.0.1 完整格式：DTEND + SEQUENCE/STATUS + X-MICROSOFT-CDO-* + X-WR-CALNAME | 应能导入并显示提前 1 天提醒 |",
    "| D-新版多事件示例.ics | 3 个事件的完整格式（含跨年） | 用于确认多事件与日期边界 |",
    "",
    "全部文件均为 UTF-8 无 BOM、CRLF 换行、每行 ≤ 75 octets，续行以一个空格开头且不切断中文多字节字符。",
    "插件 1.0.1 重建 `知识管理工作台/提醒.ics` 后，直接拖 vault 内该文件即可，无需再用样本。",
    "",
  ].join("\n"),
  "utf8",
);
rmSync(TMP, { recursive: true, force: true });
console.log(`[ics-samples] 输出目录：${OUT}`);
