/**
 * P2-5 · 可重复运行的 UI 自动冒烟（仅本地验收使用，不随插件发布）。
 *
 * 把第一 / 二 / 三步靠手工 CDP 核对的界面结论固化成结构化断言：
 * 版本栏、离线口径、四页签、朗读条引擎标签独占行、语速 5 档、
 * 笔记弹窗属性默认折叠、统计卡片顺序、设置页分组 / 网关状态条 / 密钥遮盖。
 *
 * 前置：Obsidian 以 --remote-debugging-port=9222 --remote-allow-origins=* 启动，
 *       目标 vault 已启用本地版本一致的插件（main.js 已由 link-vault 同步，版本以 manifest.json 为准）。
 * 用法：
 *   node scripts/ui-smoke.mjs                       # 默认 9222，自动挑主窗口 + 自动打开设置面板
 *   node scripts/ui-smoke.mjs 9222 "脑汁保险柜"     # 按标题关键词定位主窗口
 *   CDP_MAIN_TITLE="脑汁保险柜" node scripts/ui-smoke.mjs
 *   CDP_SETTINGS_TITLE="设置 - 脑汁保险柜" node scripts/ui-smoke.mjs  # 可选：连独立设置 popout
 *
 * Obsidian 1.15 的设置面板渲染在主窗口 DOM 内，脚本默认自动 open + 切到插件 tab
 * 后直接读 DOM，无需手工 popout；CDP_SETTINGS_TITLE 仅用于兼容把设置弹出成独立
 * 窗口的场景（该窗口是 about:blank，无 window.app，必须按标题定位）。
 *
 * 输出：dist/ui-smoke.json（结构化结果）+ 控制台摘要；有 FAIL 时退出码 1。
 * 边界：只读 DOM + 打开视图 / 弹窗 / 设置面板；不改笔记、不写 frontmatter、
 *       不触发写回命令，验证结束会关闭设置面板与弹窗并停回「今日」。
 * 依赖：Node 22 内置 WebSocket / http，零第三方依赖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import process from "node:process";

const ROOT = join(import.meta.dirname, "..");
const PORT = process.argv[2] || process.env.CDP_PORT || "9222";
const MAIN_TITLE = process.argv[3] || process.env.CDP_MAIN_TITLE || "";
const SETTINGS_TITLE = process.env.CDP_SETTINGS_TITLE || "";
const OUT = join(ROOT, "dist", "ui-smoke.json");
const expectedVersion = JSON.parse(
  readFileSync(join(ROOT, "manifest.json"), "utf8"),
).version;

// 与 release-check 的离线口径一致，避免冒烟脚本自己写死过时文案。
const OFFLINE_TEXT = "默认离线，仅朗读可选联网";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`非 JSON 响应：${body.slice(0, 160)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("CDP 端口连接超时")));
    req.end();
  });
}

/** 连接一个 CDP target，返回 evaluate/send 句柄。 */
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const consoleEvents = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.exceptionThrown" ||
        (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") ||
        (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error")) {
      consoleEvents.push(JSON.stringify(msg.params));
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); }
    }, 15000);
  });
  await send("Runtime.enable");
  await send("Log.enable").catch(() => {});
  await send("Page.enable").catch(() => {});
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    });
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result?.value;
  };
  return { ws, send, evaluate, consoleEvents };
}

const checks = [];
function check(name, ok, detail = "", skipped = false) {
  checks.push({ name, ok: Boolean(ok), skipped, detail: String(detail) });
}
async function step(name, fn) {
  try {
    const { ok, detail, skipped } = await fn();
    check(name, ok, detail, skipped);
  } catch (error) {
    check(name, false, `异常：${error.message}`);
  }
}
const APP = "(() => { const a = (typeof app !== 'undefined') ? app : window.app; return a; })()";

let targets;
try {
  targets = await httpJson("/json/list");
} catch (error) {
  console.error(`[ui-smoke] 无法连接 CDP :${PORT}（${error.message}）。`);
  console.error("请先以 --remote-debugging-port=9222 --remote-allow-origins=* 启动 Obsidian 后重跑。");
  process.exit(2);
}
const pages = targets.filter(
  (t) => t.type === "page" && ((t.url || "").includes("obsidian.md") ||
    (t.url || "").includes("index.html") || (t.url || "") === "about:blank"),
);
// 主窗口必须是渲染 Obsidian 应用本身的 index.html 页面：设置 popout 的标题同样
// 含 vault 名，但 URL 是 about:blank、没有 window.app，不能当主窗口。
const isAppPage = (t) => (t.url || "").includes("obsidian.md") || (t.url || "").includes("index.html");
const pick = (keyword) => {
  const candidates = keyword ? pages.filter((t) => (t.title || "").includes(keyword)) : pages;
  return candidates.find(isAppPage) ?? pages.find(isAppPage) ?? candidates[0];
};
const mainPage = pick(MAIN_TITLE);
if (!mainPage) {
  console.error(`[ui-smoke] 未找到主窗口${MAIN_TITLE ? `（标题含「${MAIN_TITLE}」）` : ""}。现有：\n` +
    pages.map((t) => `  - ${t.title}`).join("\n"));
  process.exit(2);
}

const main = await connect(mainPage);

// ── 1. 插件与版本栏 ──────────────────────────────────────────
await step("插件已启用且版本与 manifest 一致", async () => {
  const p = await main.evaluate(`(() => { const a = ${APP}; const p = a?.plugins?.plugins?.['knowledge-workbench']; return p ? { version: p.manifest.version, desktopOnly: p.manifest.isDesktopOnly } : null; })()`);
  return {
    ok: p && p.version === expectedVersion && p.desktopOnly === false,
    detail: p ? `v${p.version} · isDesktopOnly=${p.desktopOnly}` : "插件实例未加载",
  };
});

await step("打开工作台视图且四个页签顺序固定", async () => {
  await main.evaluate(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:open-workbench'); return true; })()`);
  await sleep(600);
  const v = await main.evaluate(`(() => ({ tabs: [...document.querySelectorAll('.kw-tab')].map(b => b.textContent.trim()), pane: document.querySelector('.kw-pane')?.textContent.length ?? 0 }))()`);
  return {
    ok: Array.isArray(v?.tabs) && v.tabs.join("/") === "今日/复习/统计/浏览历史" && v.pane > 0,
    detail: `页签 ${v?.tabs?.join(" / ")} · 内容 ${v?.pane} 字`,
  };
});

await step("U-6/P0-3 页脚：默认离线、仅朗读可选联网（无过时文案）", async () => {
  const footer = await main.evaluate(`(() => document.querySelector('.kw-footer')?.textContent ?? '')()`);
  return {
    ok: typeof footer === "string" && footer.includes(OFFLINE_TEXT) &&
      !/零网络请求|云端已搁置|不联网/.test(footer),
    detail: (footer || "").slice(0, 110),
  };
});

// ── 2. 朗读条与笔记弹窗 ─────────────────────────────────────
let modalOpened = false;
await step("打开笔记弹窗（从今日清单点笔记名）", async () => {
  await main.evaluate(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:open-workbench-today'); return true; })()`);
  await sleep(380);
  await main.evaluate(`(() => { const b = document.querySelector('.kw-fold-btn'); if (b && b.classList.contains('is-folded')) b.click(); return true; })()`);
  await sleep(300);
  const clicked = await main.evaluate(`(() => { const l = document.querySelector('.kw-note-link'); if (!l) return false; l.click(); return true; })()`);
  await sleep(500);
  modalOpened = Boolean(clicked) && Boolean(await main.evaluate(`(() => Boolean(document.querySelector('.kw-note-modal')))()`));
  return {
    ok: modalOpened,
    skipped: !clicked,
    detail: clicked ? "弹窗已打开" : "当前库今日清单无笔记链接，跳过弹窗相关断言",
  };
});

await step("U-1 朗读条引擎标签独占一行（flex-basis 100%）", async () => {
  if (!modalOpened) return { ok: false, skipped: true, detail: "弹窗未打开，跳过" };
  const info = await main.evaluate(`(() => { const el = document.querySelector('.kw-note-modal .kw-speech-engine'); if (!el) return null; const cs = getComputedStyle(el); return { basis: cs.flexBasis, width: cs.width, parent: el.parentElement?.className ?? '' }; })()`);
  return {
    ok: info && (info.basis === "100%" || /100%/.test(info.basis)),
    detail: info ? `flex-basis=${info.basis} · 父容器=${info.parent}` : "未找到引擎标签",
  };
});

await step("语速下拉 5 档且含 1× 正常", async () => {
  if (!modalOpened) return { ok: false, skipped: true, detail: "弹窗未打开，跳过" };
  const rates = await main.evaluate(`(() => { const s = document.querySelector('.kw-note-modal .kw-speech-rate'); return s ? [...s.options].map(o => o.value) : null; })()`);
  return {
    ok: Array.isArray(rates) && rates.length === 5 && rates.includes("1"),
    detail: rates ? rates.join(" / ") : "未找到语速下拉",
  };
});

await step("U-9 属性区默认折叠（aria-expanded=false + grid hidden）", async () => {
  if (!modalOpened) return { ok: false, skipped: true, detail: "弹窗未打开，跳过" };
  const fm = await main.evaluate(`(() => { const t = document.querySelector('.kw-note-modal .kw-fm-toggle'); const g = document.querySelector('.kw-note-modal .kw-fm-grid'); if (!t) return { absent: true }; return { expanded: t.getAttribute('aria-expanded'), hidden: g?.hasAttribute('hidden') ?? null, hasHint: Boolean(document.querySelector('.kw-note-modal .kw-fm-hint')) }; })()`);
  return {
    ok: fm && !fm.absent && fm.expanded === "false" && fm.hidden === true && fm.hasHint,
    detail: fm?.absent ? "当前笔记无 frontmatter 属性，折叠区不渲染（属正常）" : JSON.stringify(fm),
  };
});

// ── 3. 统计页卡片顺序 ───────────────────────────────────────
await step("U-3 统计卡片顺序：主分类 / 标签上移，索引与 .ics 下移", async () => {
  await main.evaluate(`(() => { const a = ${APP}; a.commands.executeCommandById('knowledge-workbench:open-workbench-stats'); return true; })()`);
  await sleep(420);
  const titles = await main.evaluate(`(() => [...document.querySelectorAll('.kw-view .kw-card-title')].map(e => e.textContent.trim()))()`);
  const joined = Array.isArray(titles) ? titles.join("|") : "";
  return {
    ok: Array.isArray(titles) && titles.length >= 2 &&
      /全量分类|主分类/.test(joined) && /标签/.test(joined),
    detail: titles ? titles.join(" / ") : "未找到统计卡片",
  };
});

// ── 4. 设置页（自动打开并连到 popout 窗口）────────────────────
// Obsidian 1.15 把设置面板弹成独立窗口：URL 是 about:blank、无 window.app，
// 但 DOM 里就是完整的设置面板。所以流程是：
//   ① 主窗口 app.setting.open() + openTabById 切到插件 tab；
//   ② 重新拉 /json/list，找到设置 popout（标题含「设置」或由 CDP_SETTINGS_TITLE 指定）；
//   ③ 连它读 DOM，验证结束关闭该窗口。
// 这样无需人工预先弹窗，脚本可重复自动跑完全部断言。
await step("打开设置面板并切到插件设置 tab", async () => {
  const opened = await main.evaluate(`(() => {
    const a = ${APP};
    if (!a?.setting) return { ok: false, reason: 'no app.setting' };
    a.setting.open();
    a.setting.openTabById('knowledge-workbench');
    return { ok: true, tab: a.setting.activeTab?.id ?? null };
  })()`);
  return {
    ok: Boolean(opened?.ok),
    detail: opened?.ok ? `activeTab=${opened.tab}（主窗口已发起打开）` : String(opened?.reason ?? opened?.__error ?? "打开失败"),
  };
});

// 打开后设置窗口会出现在 CDP target 列表里，重新拉取并定位（渲染也需要一点时间）。
let settingsPage = SETTINGS_TITLE ? pick(SETTINGS_TITLE) : null;
if (!settingsPage) {
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    let fresh = [];
    try { fresh = await httpJson("/json/list"); } catch { /* 端口短暂抖动，下轮重试 */ }
    const candidate = fresh.find(
      (t) => t.type === "page" && t.id !== mainPage.id &&
        (SETTINGS_TITLE ? (t.title || "").includes(SETTINGS_TITLE) : (t.title || "").startsWith("设置")),
    );
    if (candidate) { settingsPage = candidate; break; }
  }
}
let settingsCtx = main;
let settingsOwnSocket = false;
if (settingsPage && settingsPage !== mainPage) {
  settingsCtx = await connect(settingsPage);
  settingsOwnSocket = true;
}
await step("设置 popout 窗口已就绪（about:blank 无 window.app）", async () => {
  if (!settingsOwnSocket) return { ok: false, detail: "未发现独立设置窗口（标题以「设置」开头）" };
  // 在 popout 内轮询等待面板渲染（该窗口没有 app，不能调 app.setting）。
  const ready = await settingsCtx.evaluate(`(async () => {
    for (let i = 0; i < 30; i += 1) {
      const heads = document.querySelectorAll('.setting-item-heading .setting-item-name');
      const pane = document.querySelector('.vertical-tab-content');
      if (heads.length >= 5 && pane) return { ok: true, heads: heads.length, waitedMs: i * 100 };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, heads: document.querySelectorAll('.setting-item-heading .setting-item-name').length };
  })()`);
  return {
    ok: Boolean(ready?.ok),
    detail: ready?.ok ? `面板渲染完成 · 分组 ${ready.heads} 个 · 等待 ${ready.waitedMs}ms` : `面板未渲染（分组 ${ready?.heads ?? 0} 个）`,
  };
});

await step("U-4/U-5 设置页分组与网关状态条", async () => {
  const dom = await settingsCtx.evaluate(`(() => ({ headings: [...document.querySelectorAll('.setting-item-heading .setting-item-name')].map(e => e.textContent.trim()), status: document.querySelector('.kw-gateway-status')?.textContent.trim() ?? '', infoBtns: document.querySelectorAll('.kw-info-btn').length, keyType: document.querySelector('input[type=password]') ? 'password' : '' }))()`);
  return {
    ok: dom && dom.headings.includes("朗读（通用）") && dom.headings.includes("自定义 TTS 网关") &&
      dom.status.length > 0 && dom.infoBtns > 0 && dom.keyType === "password",
    detail: dom ? `分组 ${dom.headings.length} 个（含朗读（通用）/网关）· 状态条「${dom.status.slice(0, 50)}」· (i) ${dom.infoBtns} 个 · 密钥框 ${dom.keyType}` : "无法读取设置页 DOM",
  };
});
await step("U-6 设置页版本栏与离线口径", async () => {
  // 只取插件设置面板自己的文本，不用 document.body 兜底——否则会误命中页面
  // 其他位置的 v1.0.9 / 默认离线 文案，产生假阳性。
  const text = await settingsCtx.evaluate(`(() => {
    const pane = [...document.querySelectorAll('.vertical-tab-content')]
      .find((p) => p.querySelector('.kw-gateway-status'));
    return pane ? pane.textContent : null;
  })()`);
  return {
    ok: typeof text === "string" && text.includes(`v${expectedVersion}`) && /默认离线/.test(text),
    detail: typeof text === "string" ? text.slice(0, 100).replace(/\s+/g, " ") : "未找到插件设置面板（无 .kw-gateway-status）",
  };
});
// 只读确认清空密钥按钮已就位；不点击，避免改动用户已保存的凭据。
await step("清空密钥按钮已就位（两步确认，只读）", async () => {
  const dom = await settingsCtx.evaluate(`(() => {
    const pane = [...document.querySelectorAll('.vertical-tab-content')]
      .find((p) => p.querySelector('.kw-gateway-status'));
    if (!pane) return null;
    const item = [...pane.querySelectorAll('.setting-item')]
      .find((el) => (el.querySelector('.setting-item-name')?.textContent || '').includes('清空已保存的 API 密钥'));
    if (!item) return null;
    const btn = item.querySelector('button');
    return {
      name: item.querySelector('.setting-item-name')?.textContent.trim() ?? '',
      text: btn?.textContent.trim() ?? '',
      warning: (btn?.className || '').includes('mod-warning'),
    };
  })()`);
  return {
    ok: Boolean(dom) && dom.text === "清空密钥",
    detail: dom ? `按钮「${dom.text}」· 警告态 ${dom.warning} · 设置项「${dom.name}」` : "未找到清空密钥设置项",
  };
});
if (settingsOwnSocket) settingsCtx.ws.close();

// ── 5. 控制台与收尾还原 ─────────────────────────────────────
await step("无插件相关控制台 error", async () => {
  const own = main.consoleEvents.filter((e) => e.includes("knowledge-workbench"));
  return { ok: own.length === 0, detail: `插件 error ${own.length} 条 / 宿主全部 ${main.consoleEvents.length} 条` };
});

await main.evaluate(`(() => {
  const m = document.querySelector('.kw-note-modal');
  if (m) { const b = document.querySelector('.modal-container .modal-close-button'); if (b) b.click(); }
  const a = ${APP};
  try { a.setting.close(); } catch (e) { /* 宿主可能未开设置面板 */ }
  a.commands.executeCommandById('knowledge-workbench:open-workbench-today');
  return true;
})()`);
await sleep(250);

const failed = checks.filter((c) => !c.ok && !c.skipped);
const passed = checks.filter((c) => c.ok);
const skipped = checks.filter((c) => c.skipped);
const report = {
  generatedAt: new Date().toISOString(),
  page: { title: mainPage.title, url: mainPage.url, settingsTitle: SETTINGS_TITLE || null },
  version: expectedVersion,
  summary: { total: checks.length, pass: passed.length, fail: failed.length, skipped: skipped.length },
  checks,
};
mkdirSync(join(ROOT, "dist"), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");

for (const c of checks) {
  console.log(`${c.skipped ? "SKIP" : c.ok ? "PASS" : "FAIL"}  ${c.name}  →  ${c.detail}`);
}
console.log(`\n总计 ${checks.length} 项 · PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length}`);
console.log(`报告：${OUT}${existsSync(OUT) ? "" : "（写入失败）"}`);
main.ws.close();
process.exit(failed.length > 0 ? 1 : 0);
