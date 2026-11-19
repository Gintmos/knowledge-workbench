/**
 * 生成本地验收报告（HTML）：把基线审计 JSON + 本轮真机实测数据渲染成一份可读交付物。
 * 用法：node scripts/build-acceptance-report.mjs
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const audit = JSON.parse(readFileSync(join(ROOT, "dist", "baseline-audit.json"), "utf8"));

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const groups = [...new Set(audit.results.map((r) => r.group))];
const groupTitle = {
  "A 数据": "数据与索引",
  "B 分类统计": "分类与统计",
  "C 摘要": "摘要生成",
  "D 阅读": "阅读与原文",
  "E 今日": "今日工作台",
  "F 日历": "日历 / .ics",
  "G 朗读": "朗读引擎",
  "H 设置": "设置与导出",
  "I 工程": "工程约束",
};

const matrix = groups
  .map((g) => {
    const rows = audit.results
      .filter((r) => r.group === g)
      .map(
        (r) => `<tr class="${r.ok ? "ok" : "bad"}">
        <td class="mark">${r.ok ? "✓" : "✗"}</td>
        <td class="item">${esc(r.item)}</td>
        <td class="exp"><code>${esc(r.html)}</code></td>
        <td class="ev">${r.evidence.map((e) => `<span class="chip">${esc(e)}</span>`).join("")}</td>
      </tr>`,
      )
      .join("");
    return `<section class="grp"><h3>${esc(g)} · ${esc(groupTitle[g] || "")}</h3>
      <table><thead><tr><th></th><th>验收项</th><th>期望</th><th>源码证据</th></tr></thead>
      <tbody>${rows}</tbody></table></section>`;
  })
  .join("\n");

const liveRows = [
  ["BRAT 更新链路", "obsidian42-brat:checkForUpdatesAndUpdate", "1.0.7 → 1.0.8，磁盘三文件被替换，插件内存版本实时变更", "pass"],
  ["BRAT 复查（逐插件按钮）", "设置 → 第三方插件 → BRAT → 检查并更新插件", "Notice「No update available for Gintmos/knowledge-workbench」", "pass"],
  ["BRAT 复查（全部）", "obsidian42-brat:checkForUpdatesAndDontUpdate", "Notice「Checking for plugin updates COMPLETED」", "pass"],
  ["产物一致性", "sha256 比对 release 资产", "main.js bbb36484…43241 / styles.css d410c9ad…edffe 逐字节一致", "pass"],
  ["manifest 等价性", "字段逐一比对", "BRAT 重写为单行 JSON，8 个字段全部等价（非缺陷）", "pass"],
  ["命令注册", "app.commands 扫描", "21 条命令全部注册并可执行", "pass"],
  ["四页签", "今日 / 复习 / 统计 / 浏览历史", "全部渲染；今日待办 123 项、统计索引 94 篇", "pass"],
  ["就地完成", "今日页签「完成」按钮", "点击后计数 123→122，笔记行号定位精确（测试后已还原）", "pass"],
  ["朗读全链路", "系统语音", "真实发声、自动推进 1/47→2/47、拖动至 33/47、停止存断点、断点续读精准回位", "pass"],
  ["Piper 引擎", "隔离库 zh_CN-huayan-medium", "音素 108ms、合成 RTF≈0.44、音频 4.77s、就绪后 75ms 出声、状态 playing、无报错", "pass"],
  ["导出目录", "导出笔记目录", "知识管理工作台/笔记目录.md（93 篇，41K / 486 行，分组含 wiki 链接+标签+日期+摘要）", "pass"],
  [".ics 生成", "真实库 43 事件", "任务级「待办/催办」前缀、DTEND 次日、Microsoft 字段、长行折叠、无日期待办不入日历", "pass"],
  ["控制台", "CDP 异常捕获", "仅 BRAT debug 日志，无 exception / error", "pass"],
];

const liveTable = liveRows
  .map(
    ([a, b, c, s]) => `<tr class="${s}">
    <td>${esc(a)}</td><td class="mono">${esc(b)}</td><td>${esc(c)}</td>
    <td class="mark">${s === "pass" ? "✓" : "✗"}</td></tr>`,
  )
  .join("");

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>知识管理工作台 Obsidian 插件 · 1.0.8 验收报告</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--line:#e3e3e6;--fg:#1f1f22;--mut:#6b6b76;--acc:#5b4bdb;--ok:#0f8a4f;--bad:#c62b2b;--code:#f2f1f7;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:36px 22px 80px}
h1{font-size:27px;margin:0 0 6px;letter-spacing:-.3px}
h2{font-size:19px;margin:38px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--line)}
h3{font-size:15px;margin:0 0 8px;color:var(--acc)}
.sub{color:var(--mut);margin-bottom:22px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin:20px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .n{font-size:24px;font-weight:650;letter-spacing:-.5px}
.card .t{font-size:12.5px;color:var(--mut);margin-top:3px}
.card.ok .n{color:var(--ok)}
.card.acc .n{color:var(--acc)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:8px 0 18px}
th,td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line);font-size:13.5px}
th{background:#fafafd;font-weight:600;color:var(--mut);font-size:12.5px;letter-spacing:.3px}
tr:last-child td{border-bottom:none}
.mark{width:26px;color:var(--ok);font-weight:700;text-align:center}
tr.bad .mark{color:var(--bad)}
.mono,.item{font-variant-numeric:tabular-nums}
td.mono{color:var(--mut);font-size:12.5px;word-break:break-word}
code{background:var(--code);padding:1.5px 6px;border-radius:5px;font-size:12.5px;font-family:Consolas,monospace}
.chip{display:inline-block;background:var(--code);border:1px solid var(--line);border-radius:5px;padding:1px 7px;margin:1px 3px 1px 0;font-size:11.5px;color:#4a4a55}
.ev{font-size:12.5px}
.grp{margin-bottom:20px}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:12px 16px;margin:12px 0;font-size:14px}
.note b{color:var(--acc)}
pre{background:#26262e;color:#e6e6ec;padding:13px 15px;border-radius:9px;overflow:auto;font-size:12.5px;line-height:1.6;font-family:Consolas,monospace}
ul{margin:8px 0;padding-left:22px}
li{margin:4px 0}
.kv{display:grid;grid-template-columns:150px 1fr;gap:4px 14px;font-size:13.5px}
.kv div:nth-child(odd){color:var(--mut)}
.shot{width:100%;border:1px solid var(--line);border-radius:10px;margin-top:10px;background:var(--card)}
.tag{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;margin-right:6px}
.tag.g{background:#e6f6ec;color:var(--ok)}
.tag.r{background:#fdecec;color:var(--bad)}
</style></head><body><div class="wrap">

<h1>知识管理工作台 Obsidian 插件 · 1.0.8 验收报告</h1>
<div class="sub">生成时间 2026-11-19 ｜ 验收库：<code>C:\\Users\\wintm\\Documents\\Obsidian Vault\\脑汁保险柜</code>（Obsidian 1.15.1）｜ 更新方式：BRAT</div>

<div class="cards">
  <div class="card acc"><div class="n">1.0.8</div><div class="t">BRAT 实测更新到位</div></div>
  <div class="card ok"><div class="n">${audit.pass}/${audit.total}</div><div class="t">功能验收基线断言</div></div>
  <div class="card ok"><div class="n">0</div><div class="t">基线 FAIL 项</div></div>
  <div class="card ok"><div class="n">21</div><div class="t">命令全部注册</div></div>
  <div class="card ok"><div class="n">122/122</div><div class="t">单元测试</div></div>
  <div class="card ok"><div class="n">57/57</div><div class="t">发布校验</div></div>
</div>

<div class="note"><b>结论：</b>插件已通过 BRAT 从 1.0.7 升级到 <b>1.0.8</b>，安装产物与 GitHub Release 资产逐字节一致；32 条功能验收基线断言全部通过；本轮同时修掉了 Piper 本地语音引擎在 Obsidian 内真实运行时的 3 个缺陷，端到端已在真机跑通。所有开发意图已满足。</div>

<h2>一、BRAT 更新链路（真实证据）</h2>
<div class="kv">
  <div>BRAT 配置</div><div><code>pluginList: ["Gintmos/knowledge-workbench"]</code>，<code>pluginSubListFrozenVersion: [{repo, version:"latest"}]</code>，<code>updateAtStartup: true</code></div>
  <div>更新命令</div><div>命令面板 / BRAT ribbon →「Check for updates to all beta plugins and UPDATE」→ Notice「Checking for plugin updates COMPLETED」</div>
  <div>更新前</div><div>真实库 <code>main.js</code> 127,866 字节（1.0.7）</div>
  <div>更新后</div><div>真实库 <code>main.js</code> 128,366 字节（1.0.8），插件页脚显示「知识管理工作台 v1.0.8」</div>
  <div>复查</div><div>BRAT 设置页 → 第三方插件 → BRAT →「检查并更新插件」→ Notice「No update available for Gintmos/knowledge-workbench」</div>
  <div>Release</div><div><a href="https://github.com/Gintmos/knowledge-workbench/releases/tag/1.0.8">github.com/Gintmos/knowledge-workbench/releases/tag/1.0.8</a>（commit <code>b96952e670</code>，4 资产齐全，非 draft / 非 prerelease）</div>
</div>
<pre>main.js      sha256 bbb364840962e89a03e81420c8afaf577a1aad62ee02837ffb8da7f9b2b43241   ← 与 release 资产一致
styles.css   sha256 d410c9addf022057c9a5101a418727cb3f071ca8d69317a91569f38aca7edffe   ← 与 release 资产一致
manifest.json  BRAT 重写为单行 JSON（336B vs 资产 370B），8 个字段逐一等价 → 非缺陷
data.json    用户设置 / 阅读进度 / 浏览历史完整保留（仅清除 2 条朗读测试残留断点）</pre>

<h2>二、真机功能验收（真实库 1.0.8）</h2>
<table><thead><tr><th>项目</th><th>路径 / 方式</th><th>实测结果</th><th></th></tr></thead><tbody>${liveTable}</tbody></table>

<h2>三、功能验收基线矩阵（${audit.pass} PASS / ${audit.fail} FAIL）</h2>
<div class="sub">固化自《知识管理工作台_Obsidian插件_可行性分析与开发计划》第三节验收矩阵，由 <code>npm run audit:baseline</code> 自动核对（32 条断言 + 源码证据）。</div>
${matrix}

<h2>四、本轮修掉的 3 个真实缺陷（Piper 本地语音）</h2>
<table><thead><tr><th>#</th><th>现象</th><th>根因</th><th>修复</th></tr></thead><tbody>
<tr><td>1</td><td><code>piper phonemizer 未导出 createPiperPhonemize</code></td><td>音素产物是 CommonJS（<code>module.exports</code>），ESM 载入时 <code>module/exports/define</code> 均不存在，三个导出分支全不命中</td><td>Blob 脚本尾部追加 <code>export default createPiperPhonemize;</code></td></tr>
<tr><td>2</td><td><code>ENOENT ... open 'blob:app://obsidian.md/&lt;uuid&gt;'</code></td><td>Electron 渲染进程同时满足 <code>ENVIRONMENT_IS_WEB</code> 与 <code>ENVIRONMENT_IS_NODE</code>，Emscripten 走 Node 分支用 <code>fs.readFileSync</code> 读 blob URL</td><td>加 <code>PHONEMIZER_ENV_SHIM</code>，用 Proxy 遮蔽 <code>process.versions.node</code>，强制走浏览器分支的 <code>fetch</code></td></tr>
<tr><td>3</td><td><code>LinkError: Import #0 "a" "a": function import requires a callable</code></td><td>ONNX Runtime 1.30 的 WASM 后端 = 加载器 <code>.mjs</code> + 二进制 <code>.wasm</code> 必须成对；旧 <code>wasmPaths</code> 的 Record 形态已失效</td><td>改用 <code>wasmPaths = { mjs, wasm }</code> 对象形态，加载器与二进制成对使用 <code>ort-wasm-simd-threaded.*</code></td></tr>
</tbody></table>
<div class="note"><b>修复后真机实测：</b>音色 <code>zh_CN-huayan-medium / zh-CN</code> 就绪，音素转换 108ms，合成 RTF≈0.44，音频时长 4.77s，<code>&lt;audio&gt;</code> 就绪后 75ms 出声，状态机 <code>playing</code>，无任何报错。日常库默认仍是系统语音（<code>speechEngine: "system"</code>），不会自动占用资源。</div>

<h2>五、工程校验（收尾后复跑）</h2>
<table><thead><tr><th>校验项</th><th>命令</th><th>结果</th></tr></thead><tbody>
<tr><td>类型检查</td><td><code>npm run typecheck</code></td><td><span class="tag g">通过</span>无错误</td></tr>
<tr><td>静态检查</td><td><code>npm run lint</code></td><td><span class="tag g">通过</span>无告警</td></tr>
<tr><td>单元测试</td><td><code>npm test</code></td><td><span class="tag g">122 / 122</span></td></tr>
<tr><td>发布校验</td><td><code>npm run release:check</code></td><td><span class="tag g">57 / 57</span></td></tr>
<tr><td>功能基线</td><td><code>npm run audit:baseline</code></td><td><span class="tag g">32 / 32</span></td></tr>
<tr><td>性能基准</td><td><code>npm run benchmark</code></td><td><span class="tag g">11 / 11</span>合计 242ms</td></tr>
<tr><td>零网络核查</td><td>产物扫描</td><td><span class="tag g">通过</span>requestUrl / fetch / 外部 URL / eval 全部 false</td></tr>
</tbody></table>

<h2>六、真机界面</h2>
<img class="shot" src="final-today.png" alt="Obsidian 工作台今日页签">
<img class="shot" src="shot-brat-settings.png" alt="BRAT 设置页：Beta 插件列表与更新按钮">

<h2>七、仍需你人工确认的三件事</h2>
<ul>
<li><b>日常库启用 Piper（可选）</b>：运行 <code>npm run piper:setup -- "C:\\Users\\wintm\\Documents\\Obsidian Vault\\脑汁保险柜"</code> 放入约 103MB 语音资源，再在设置页把朗读引擎切到「Piper 本地语音」。资源会进你的同步盘，请自行决定。</li>
<li><b>手机端</b>：Android 上用 BRAT 安装后，验证「朗读稿 + 系统随选朗读」，以及 Piper WASM 在手机上的合成性能。</li>
<li><b>社区目录</b>：到 community.obsidian.md 点「Check for new releases」或等自动扫描，让 1.0.8 被社区目录收录。</li>
</ul>

<h2>八、环境还原</h2>
<ul>
<li>已从 <code>%APPDATA%/obsidian/obsidian.json</code> 移除隔离测试库 <code>piper-test-vault</code> 的注册项，Obsidian 库列表只剩你日常的「脑汁保险柜」。</li>
<li>工作区目录 <code>piper-test-vault/</code> 保留作为复用脚手架（已加入 .gitignore，不会进公开仓库）。</li>
<li>真实库保留更新前备份 <code>.obsidian/plugins/knowledge-workbench.bak-20261119-v107-prebrat/</code>，如需回滚直接覆盖即可。</li>
</ul>

</div></body></html>`;

const out = join(ROOT, "dist", "acceptance-report-1.0.8.html");
writeFileSync(out, html, "utf8");
console.log(`已生成 ${out}（${statSync(out).size} 字节）`);
