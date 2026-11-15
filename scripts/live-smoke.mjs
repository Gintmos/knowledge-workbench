/**
 * P6 桌面端真机自动验收（Chrome DevTools Protocol，仅开发/验收使用，不随插件发布）。
 *
 * 前置条件：
 *   1) Obsidian 以 --remote-debugging-port=9222 --remote-allow-origins=* 启动；
 *   2) 目标 vault 已启用 knowledge-workbench 插件。
 *
 * 用法：node scripts/live-smoke.mjs [port]
 * 输出：dist/live-smoke.json + 控制台摘要。
 *
 * 边界：只读检查 + 重建派生文件（index.json / 提醒.ics）+ 打开视图与弹窗；
 *       不修改任何笔记 frontmatter、不修改主题设置、不执行写回命令。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 9222);
const OUT = path.join(ROOT, "dist", "live-smoke.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
if (!page) {
  console.error("[live-smoke] 未找到 Obsidian 主窗口调试 target，请确认已带 --remote-debugging-port 启动");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push(msg);
  }
};

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(expression, awaitPromise = false) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  const payload = response.result ?? {};
  const detail = payload.exceptionDetails ?? response.exceptionDetails;
  if (detail) {
    return { __error: `${detail.text || ""} ${detail.exception?.description || ""}`.trim() };
  }
  return payload.result?.value;
}

const APP = "(() => { const a = (typeof app !== 'undefined') ? app : window.app; return a; })()";
const checks = [];
const notes = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
}
async function step(name, fn) {
  try {
    const { ok, detail } = await fn();
    check(name, ok, detail);
  } catch (error) {
    check(name, false, `异常：${error.message}`);
  }
}

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");

let basePath = "";
let host = null;
await step("宿主连接与 vault", async () => {
  host = await evalJS(`(() => { const a = ${APP}; if (!a) return null; return { vault: a.vault.getName(), basePath: a.vault.adapter.basePath, ua: navigator.userAgent }; })()`);
  basePath = host?.basePath ?? "";
  const version = host?.ua?.match(/obsidian\/([\d.]+)/)?.[1] ?? "未知";
  return { ok: Boolean(host?.vault), detail: host ? `${host.vault} · Obsidian ${version}` : "无法访问宿主 app" };
});

await step("插件已启用且清单一致", async () => {
  const p = await evalJS(`(() => { const a = ${APP}; const p = a?.plugins?.plugins?.['knowledge-workbench']; return p ? { version: p.manifest.version, author: p.manifest.author, authorUrl: p.manifest.authorUrl, desktopOnly: p.manifest.isDesktopOnly } : null; })()`);
  return {
    ok: Boolean(p) && p.version === "1.0.0" && p.desktopOnly === false && Boolean(p.author) && Boolean(p.authorUrl),
    detail: p ? `v${p.version} · ${p.author} · isDesktopOnly=${p.desktopOnly}` : "插件实例未加载",
  };
});

await step("命令注册完整", async () => {
  const cmds = await evalJS(`(() => { const a = ${APP}; return (a?.commands?.listCommands?.() ?? []).filter(c => c.id.startsWith('knowledge-workbench:')).map(c => c.id); })()`);
  notes.push({ commandIds: cmds });
  return { ok: Array.isArray(cmds) && cmds.length >= 12, detail: `${Array.isArray(cmds) ? cmds.length : 0} 条命令` };
});

let indexInfo = null;
await step("全量索引与 index.json 快照", async () => {
  const info = await evalJS(`(async () => { const a = ${APP}; const files = a.vault.getMarkdownFiles().length; const raw = await a.vault.adapter.read('知识管理工作台/index.json'); const j = JSON.parse(raw); return { files, version: j.version, algo: j.algo, count: Object.keys(j.notes || {}).length }; })()`, true);
  indexInfo = info;
  return {
    ok: info && !info.__error && info.count === info.files && info.version === 1 && info.algo === 2,
    detail: info?.__error ?? `vault ${info?.files} 篇 md / 快照 ${info?.count} 条 · version=${info?.version} algo=${info?.algo}`,
  };
});

let icsBefore = "";
await step("提醒.ics 结构与 CRLF", async () => {
  const raw = await evalJS(`(async () => { const a = ${APP}; return await a.vault.adapter.read('知识管理工作台/提醒.ics'); })()`, true);
  icsBefore = typeof raw === "string" ? raw : "";
  const eventsCount = (icsBefore.match(/BEGIN:VEVENT/g) ?? []).length;
  const alarms = (icsBefore.match(/BEGIN:VALARM/g) ?? []).length;
  const ok = icsBefore.startsWith("BEGIN:VCALENDAR") && icsBefore.includes("\r\n")
    && eventsCount > 0 && eventsCount === alarms && icsBefore.includes("TRIGGER:-P1D")
    && icsBefore.includes("DTSTART;VALUE=DATE");
  return { ok, detail: `VEVENT ${eventsCount} / VALARM ${alarms} · CRLF=${icsBefore.includes("\r\n")} · TRIGGER:-P1D=${icsBefore.includes("TRIGGER:-P1D")}` };
});

await step("打开工作台视图与四个页签", async () => {
  await evalJS(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:open-workbench'); return true; })()`, true);
  await sleep(700);
  const view = await evalJS(`(() => { const a = ${APP}; const leaves = a.workspace.getLeavesOfType('knowledge-workbench-view').length; const tabs = document.querySelectorAll('.kw-tab').length; const pane = document.querySelector('.kw-pane'); return { leaves, tabs, paneLen: pane ? pane.textContent.length : 0 }; })()`);
  return { ok: view?.leaves >= 1 && view?.tabs === 4 && view?.paneLen > 0, detail: `leaves=${view?.leaves} tabs=${view?.tabs} pane 文本 ${view?.paneLen} 字` };
});

const TABS = [
  ["today", "今日要处理"],
  ["knowledge", "知识库"],
  ["review", "复习"],
  ["stats", "统计"],
];
for (const [tab, label] of TABS) {
  await step(`页签切换 · ${label}`, async () => {
    await evalJS(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:open-workbench-${tab}'); return true; })()`, true);
    await sleep(320);
    const state = await evalJS(`(() => { const act = document.querySelector('.kw-tab.is-active'); const pane = document.querySelector('.kw-pane'); return { active: act ? act.textContent.trim() : '', len: pane ? pane.textContent.length : 0, text: pane ? pane.textContent.slice(0, 400) : '', svg: document.querySelectorAll('.kw-view svg.kw-chart').length, bars: document.querySelectorAll('.kw-chart-bar').length }; })()`);
    // 柱状图渲染在「知识库」页签；「统计」页签是文字统计，不含 SVG。
    const ok = state?.active === label && state?.len > 0
      && (tab !== "knowledge" || (state?.svg >= 1 && state?.bars > 0 && state?.bars <= 10))
      && (tab !== "stats" || /标签|文件夹|索引/.test(state?.text ?? ""));
    return { ok, detail: `高亮=${state?.active} 内容 ${state?.len} 字${tab === "knowledge" ? ` · SVG ${state?.svg} · 柱 ${state?.bars}` : ""}${tab === "stats" ? " · 文字统计齐备" : ""}` };
  });
}

await step("今日卡片折叠标题一致", async () => {
  await evalJS(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:open-workbench-today'); return true; })()`, true);
  await sleep(300);
  // 点击会触发整块重渲染，必须每次重新查询节点，不能复用旧引用。
  const fold = await evalJS(`(async () => {
    const snap = () => ({ folded: document.querySelector('.kw-fold-btn')?.classList.contains('is-folded'), rows: document.querySelectorAll('.kw-today-row').length, title: document.querySelector('.kw-today-title')?.textContent.trim() });
    const before = snap();
    if (!document.querySelector('.kw-fold-btn') || !before.title) return null;
    document.querySelector('.kw-fold-btn').click();
    await new Promise(r => setTimeout(r, 250));
    const middle = snap();
    document.querySelector('.kw-fold-btn')?.click();
    await new Promise(r => setTimeout(r, 250));
    const after = snap();
    return { before, middle, after };
  })()`, true);
  const ok = fold && fold.before.title === fold.middle.title && fold.before.title === fold.after.title
    && fold.middle.folded !== fold.before.folded && fold.after.folded === fold.before.folded
    && (fold.middle.rows === 0 || fold.before.rows === 0 || fold.middle.rows !== fold.before.rows)
    && !/\d+ 项待处理/.test(fold.before.title);
  return { ok, detail: fold ? `「${fold.before.title}」标题一致 · 折叠 ${fold.before.folded}→${fold.middle.folded}→${fold.after.folded} · 行数 ${fold.before.rows}→${fold.middle.rows}→${fold.after.rows}` : "未找到折叠按钮" };
});

await step("笔记弹窗 Markdown 渲染与关闭", async () => {
  // 今日清单可能被折叠，知识库明细始终有笔记链接。
  await evalJS(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:open-workbench-knowledge'); return true; })()`, true);
  await sleep(450);
  const clicked = await evalJS(`(() => { const link = document.querySelector('.kw-note-link'); if (!link) return false; link.click(); return true; })()`);
  if (!clicked) return { ok: false, detail: "未找到可点击的笔记链接" };
  await sleep(500);
  const modal = await evalJS(`(() => { const m = document.querySelector('.kw-note-modal'); if (!m) return null; return { markdown: Boolean(m.querySelector('.kw-modal-markdown')), frontmatter: Boolean(m.querySelector('.kw-modal-frontmatter')), len: m.innerText.length, title: m.innerText.slice(0, 30) }; })()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(250);
  const closed = await evalJS(`(() => { const m = document.querySelector('.kw-note-modal'); if (m) { const btn = document.querySelector('.modal-container .modal-close-button'); if (btn) btn.click(); } return !document.querySelector('.kw-note-modal'); })()`);
  return { ok: Boolean(modal?.markdown) && Boolean(modal?.frontmatter) && modal?.len > 20 && Boolean(closed), detail: modal ? `Markdown/属性区齐备 · ${modal.len} 字 · 关闭=${closed}` : "弹窗未出现" };
});

await step("派生文件重建与 UID 稳定", async () => {
  await evalJS(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:write-index-snapshot'); a.commands.executeCommandById('knowledge-workbench:rebuild-ics'); return true; })()`, true);
  await sleep(900);
  const after = await evalJS(`(async () => { const a = ${APP}; return await a.vault.adapter.read('知识管理工作台/提醒.ics'); })()`, true);
  const uids = (s) => [...s.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]).sort();
  const beforeIds = uids(icsBefore).join("|");
  const afterIds = uids(typeof after === "string" ? after : "").join("|");
  return { ok: Boolean(afterIds) && afterIds === beforeIds, detail: `重建前后 UID 集合一致（${uids(icsBefore).length} 个事件）` };
});

await step("主题变量与文字可读性", async () => {
  const theme = await evalJS(`(() => { const body = getComputedStyle(document.body); const view = document.querySelector('.kw-view'); if (!view) return null; const cs = getComputedStyle(view); return { bg: body.getPropertyValue('--background-primary').trim(), text: body.getPropertyValue('--text-normal').trim(), color: cs.color, bodyClass: document.body.className }; })()`);
  return { ok: theme && theme.bg && theme.text && theme.color !== "rgba(0, 0, 0, 0)", detail: theme ? `--background-primary=${theme.bg} · --text-normal=${theme.text} · ${theme.bodyClass}` : "视图未打开" };
});

await step("窄屏 375px 布局不溢出", async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  const narrow = await evalJS(`(() => { const v = document.querySelector('.kw-view'); const t = document.querySelector('.kw-tabs'); if (!v || !t) return null; return { viewport: window.innerWidth, viewWidth: v.getBoundingClientRect().width, tabsWidth: t.getBoundingClientRect().width, overflowX: getComputedStyle(t).overflowX }; })()`);
  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(200);
  return {
    ok: narrow && narrow.viewWidth <= narrow.viewport + 1 && narrow.tabsWidth <= narrow.viewport + 1 && ["auto", "scroll"].includes(narrow.overflowX),
    detail: narrow ? `viewport=${narrow.viewport} view=${Math.round(narrow.viewWidth)} tabs=${Math.round(narrow.tabsWidth)} overflow-x=${narrow.overflowX}` : "视图未打开",
  };
});

await step("朗读能力与中文音色", async () => {
  const speech = await evalJS(`(() => { const ok = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'; const voices = ok ? speechSynthesis.getVoices() : []; return { ok, total: voices.length, zh: voices.filter(v => v.lang.toLowerCase().startsWith('zh')).length }; })()`);
  return { ok: Boolean(speech?.ok), detail: speech ? `Web Speech 可用 · 音色 ${speech.total} 个（中文 ${speech.zh} 个）` : "无法检测" };
});

await step("状态栏索引提示", async () => {
  const status = await evalJS(`(() => { const el = document.querySelector('.status-bar'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
  return { ok: /索引/.test(status ?? ""), detail: (status ?? "").slice(0, 120) };
});

await step("插件无控制台错误", async () => {
  const errors = events.filter((e) => e.method === "Runtime.exceptionThrown"
    || (e.method === "Log.entryAdded" && e.params?.entry?.level === "error")
    || (e.method === "Runtime.consoleAPICalled" && e.params?.type === "error"));
  const pluginErrors = errors.filter((e) => JSON.stringify(e).includes("knowledge-workbench"));
  notes.push({ consoleErrors: errors.length, pluginConsoleErrors: pluginErrors.length, samples: errors.slice(0, 3).map((e) => e.params?.entry?.text ?? e.params?.exceptionDetails?.text ?? e.method) });
  return { ok: pluginErrors.length === 0, detail: `插件相关 error ${pluginErrors.length} 条（宿主全部 ${errors.length} 条）` };
});

await step("插件数据与 vault 文件齐备", async () => {
  if (!basePath) return { ok: false, detail: "未取得 vault 路径" };
  const files = [
    ".obsidian/plugins/knowledge-workbench/main.js",
    ".obsidian/plugins/knowledge-workbench/manifest.json",
    ".obsidian/plugins/knowledge-workbench/styles.css",
    ".obsidian/plugins/knowledge-workbench/data.json",
    "知识管理工作台/index.json",
    "知识管理工作台/提醒.ics",
  ];
  const missing = files.filter((f) => !fs.existsSync(path.join(basePath, f)));
  return { ok: missing.length === 0, detail: missing.length ? `缺少：${missing.join("、")}` : `${files.length} 个文件齐备` };
});

// 验收结束停回「今日要处理」并展开清单，方便人工继续看。
await evalJS(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:open-workbench-today'); return true; })()`, true);
await sleep(300);
await evalJS(`(() => { const btn = document.querySelector('.kw-fold-btn'); if (btn && btn.classList.contains('is-folded')) btn.click(); return true; })()`);

const pass = checks.filter((c) => c.ok).length;
const report = {
  generatedAt: new Date().toISOString(),
  host: host ? { vault: host.vault, userAgent: host.ua } : null,
  index: indexInfo && !indexInfo.__error ? indexInfo : null,
  summary: { total: checks.length, pass, fail: checks.length - pass },
  checks,
  notes,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  →  ${c.detail}`);
console.log(`\n总计 ${checks.length} 项，通过 ${pass}，失败 ${checks.length - pass}`);
console.log(`报告：${OUT}`);
ws.close();
process.exit(checks.length - pass > 0 ? 1 : 0);
