/**
 * Obsidian CDP 驱动：连接运行中的 Obsidian 渲染进程，执行表达式并截图。
 *
 * 用法：
 *   node scripts/cdp.mjs eval "<js 表达式>"
 *   node scripts/cdp.mjs shot <输出png路径>
 *   node scripts/cdp.mjs click "<css 选择器>"      # 需要元素可见
 *   node scripts/cdp.mjs text "<css 选择器>"        # 读元素文本
 *
 * 依赖：Node 22 内置 WebSocket，无第三方依赖。
 */
import { writeFileSync } from "node:fs";
import { request } from "node:http";

const PORT = process.env.CDP_PORT || "9222";
const cmd = process.argv[2];
const arg = process.argv[3] ?? "";

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`响应不是 JSON: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const targets = await httpJson("/json/list");
const titleFilter = process.argv.find((a, i) => a === "--title" && process.argv[i + 1]);
const pages = targets.filter((t) => t.type === "page" && (t.url || "").includes("obsidian.md"));
const page = titleFilter
  ? pages.find((t) => (t.title || "").includes(titleFilter))
  : pages[0];
if (!page) {
  console.error(
    `未找到 Obsidian 渲染进程目标${titleFilter ? `（标题含 "${titleFilter}"）` : ""}。现有目标：\n` +
      pages.map((t) => `  - ${t.title}`).join("\n"),
  );
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const consoleEvents = [];

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
      .join(" ");
    consoleEvents.push(`[${msg.params.type}] ${text}`);
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    consoleEvents.push(
      `[exception] ${d.exception?.description || d.text} @${d.url || ""}:${d.lineNumber ?? "?"}`,
    );
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    consoleEvents.push(`[${e.level}] ${e.text} @${e.url || ""}`);
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, Number(process.env.CDP_TIMEOUT || 240000));
  });
}

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

await send("Runtime.enable");
await send("Log.enable").catch(() => {});

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return { value: r.result.value };
}

if (cmd === "eval") {
  const out = await evaluate(`(async () => { ${arg} })()`);
  console.log(JSON.stringify(out.value ?? out.error, null, 2));
  if (process.env.CDP_LOG) {
    console.log("--- 控制台/异常 ---");
    console.log(consoleEvents.slice(-40).join("\n") || "(无)");
  }
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(arg, Buffer.from(r.data, "base64"));
  console.log(`已保存 ${arg}`);
} else if (cmd === "click") {
  const out = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(arg)});
    if (!el) return { ok: false, reason: "未找到元素" };
    el.scrollIntoView({ block: "center" });
    el.click();
    return { ok: true, text: (el.textContent || "").trim().slice(0, 120) };
  })()`);
  console.log(JSON.stringify(out.value ?? out.error, null, 2));
} else if (cmd === "text") {
  const out = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(arg)});
    return el ? (el.textContent || "").trim() : null;
  })()`);
  console.log(out.value ?? out.error ?? "(未找到)");
} else if (cmd === "mouse") {
  // 真实鼠标事件：node scripts/cdp.mjs mouse <x> <y> [click|move|down|up]
  const [x, y, kind = "click"] = arg.split(/[,\s]+/).map(Number);
  const common = { x, y, button: "left", clickCount: 1, buttons: 1 };
  if (kind === "move") {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  } else if (kind === "down") {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  } else if (kind === "up") {
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
  } else {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
  }
  console.log(`已派发 ${kind} @ ${x},${y}`);
} else if (cmd === "type") {
  // 真实键盘输入：node scripts/cdp.mjs type "文本"
  for (const ch of arg) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", text: ch, unmodifiedText: ch });
  }
  console.log("已输入");
} else if (cmd === "key") {
  // 特殊键：node scripts/cdp.mjs key Enter|Tab|Escape
  const map = { Enter: 13, Tab: 9, Escape: 27 };
  const code = map[arg] || arg.charCodeAt(0);
  await send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: code, key: arg, code: arg });
  await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: code, key: arg, code: arg });
  console.log(`已按下 ${arg}`);
} else {
  console.error("未知命令。可用：eval / shot / click / text");
  process.exit(2);
}

ws.close();
process.exit(0);
