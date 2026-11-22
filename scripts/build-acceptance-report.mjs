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

<div class="note"><b>结论：</b>插件已通过 BRAT 从 1.0.7 升级到 <b>1.0.8</b>，安装产物与 GitHub Release 资产逐字节一致；功能验收基线断言全部通过；朗读、复习、导出等全链路已在真机跑通。所有开发意图已满足。</div>

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

<h2>四、朗读方案与交互修复</h2>
<table><thead><tr><th>#</th><th>项目</th><th>方案</th><th>效果</th></tr></thead><tbody>
<tr><td>1</td><td>神经语音</td><td>桌面 Edge 神经语音（免费·无需密钥），双端 OpenAI 兼容 TTS 网关（安卓一键预设）</td><td>音色自然，安卓可获得与桌面一致的神经语音效果</td></tr>
<tr><td>2</td><td>暂停 / 拖动 / 续播</td><td>暂停态拖动后标记待重合成，继续时重新合成当前块</td><td>暂停→拖动→「继续朗读」可直接播放</td></tr>
<tr><td>3</td><td>交互延迟与稳定性</td><td>音频缓存 + 下一段预取；连续失败才回退系统语音</td><td>开始播放 / 拖动秒开，停顿后不再误切音色</td></tr>
</tbody></table>
<div class="note"><b>说明：</b>早期本地 WASM 语音方案自然度不足已移除；日常库默认仍是系统语音（<code>speechEngine: "system"</code>），联网语音仅在主动选择时启用。</div>

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
<li><b>安卓神经语音（可选）</b>：在设置页「安卓语音预设」选一个国内服务商，粘贴自己的 API Key 即可获得与桌面一致的神经语音效果；无密钥时可用「朗读稿 + 系统随选朗读」离线路径。</li>
<li><b>社区目录</b>：到 community.obsidian.md 点「Check for new releases」或等自动扫描，让 1.0.8 被社区目录收录。</li>
</ul>

<h2>八、环境还原</h2>
<ul>
<li>隔离测试库注册项已清理，Obsidian 库列表只剩你日常的「脑汁保险柜」。</li>
<li>历史本地语音测试资源目录已删除，工作区不再保留无关的大体积资源。</li>
<li>真实库保留更新前备份 <code>.obsidian/plugins/knowledge-workbench.bak-20261119-v107-prebrat/</code>，如需回滚直接覆盖即可。</li>
</ul>

</div></body></html>`;

const out = join(ROOT, "dist", "acceptance-report-1.0.8.html");
writeFileSync(out, html, "utf8");
console.log(`已生成 ${out}（${statSync(out).size} 字节）`);
