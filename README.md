# Knowledge Workbench

**Knowledge Workbench** is a local-first Obsidian plugin that brings the capabilities of the online knowledge workbench into your vault: organise notes by tags and folders, track due and overdue tasks, schedule spaced reviews, and read notes in place. It is fully offline — **zero network requests, no backend, no telemetry, and no runtime dependencies**. No note content ever leaves your device, and all data is stored inside your vault.

Key features: four tabs (Today, Review, Statistics, History), task-level follow-ups and to-dos parsed from `- [ ]` items (`@due`/`@every` and Chinese period words), rule-based summaries with no LLM, all-day `.ics` reminders with advance alarms, in-place actions, bulk tag rename/merge, markdown catalog export, follow-the-slot reading with a fallback transcript for Android, and horizontal bar charts for every category. Nothing is downloaded or uploaded, and the plugin never runs in the background.

Privacy: the source and shipped `main.js` contain no `fetch`, `XMLHttpRequest`, `localStorage`, `indexedDB`, Node/Electron APIs, or hard-coded external URLs. All Markdown rendering goes through Obsidian's own `MarkdownRenderer`. There is no account system and no analytics.

> Requires Obsidian `1.7.2` or later (`workspace.revealLeaf` needs 1.7.2+). `isDesktopOnly: false` — works on both desktop and mobile.

---

把「在线知识管理工作台」的能力搬进 Obsidian 原生插件：**按标签/文件夹分类知识、追踪逾期/到期与任务级「催办 / 待办」、安排复习、在库内打开并朗读笔记**。

**纯本地、零后端、零网络请求、零运行时依赖。** 插件不会联网、不会上传笔记、没有遥测，也不会在后台常驻。数据全部存在你的 vault 里，跨设备同步由你既有的同步方案负责。**v1.0.2 起云端神经朗读已搁置**：没有自有 TTS 服务地址与密钥，也没有不依赖密钥的可用替代方案，因此该路径已从运行时移除，产物中不含任何联网入口。

> 最低支持 Obsidian `1.7.2`（`workspace.revealLeaf` 的 Promise 重载自 1.7.2 起提供）。`isDesktopOnly: false`，桌面与手机端均可安装。

## 安装

三种方式任选其一：

1. **手动复制到 vault**（推荐先这样试用）
   把 `main.js`、`manifest.json`、`styles.css` 放进 `<vault>/.obsidian/plugins/knowledge-workbench/`，重启 Obsidian，在「设置 → 第三方插件」中启用。也可使用仓库脚本：`node scripts/link-vault.mjs "<vault 绝对路径>"`。
2. **BRAT 灰度**：在 BRAT 中添加 `https://github.com/Gintmos/knowledge-workbench`，可自动跟随 Release 更新，适合小范围试用。
3. **GitHub Release**：从 [Releases 页面](https://github.com/Gintmos/knowledge-workbench/releases) 下载 `knowledge-workbench-1.0.7.zip`，解压后三个文件直接放入上述插件目录。Release 的 tag 必须与 `manifest.json` 的 `version` 一致。

安装后可通过左侧 ribbon 的「打开知识管理工作台」、命令面板「打开知识管理工作台」或四个页签命令进入。

## 功能

| 页签 | 内容 |
| --- | --- |
| 今日 | 逾期 / 今日到期 / 催办 / 复习到期 / 待办，按组折叠；任务行就地「完成」；顶部显示 `.ics` 状态。**催办 / 待办**来自正文未完成任务：`@due(日期)`、`@every(周期)` 或「每周」等周期词；无日期任务只显示为待办、不进日历 |
| 复习 | 到期复习清单与复习排期（1 / 3 / 7 / 15 / 30 天） |
| 统计 | 索引状态（调试指标收进「运行信息」折叠）、`.ics` 状态、「主分类总览」与「标签 / 文件夹」两张卡片；卡片下半部分的列表**每行一条横向条形图**（按篇数比例绘制，全部分类都出条，明细区可滚动），点名称或条形在同一卡片内展开该分类的笔记清单，清单里的笔记名**直达 vault 原文**。标签卡有「管理标签」入口做批量重命名 / 合并。卡片上方不再有纵向柱状图 |
| 浏览历史 | 最近 20 篇，标题即入口，打开带朗读的原文窗口（窗口内有「在 Obsidian 中打开」） |

**1.0.1 起取消「知识库」页签与全库明细**；浏览历史独立成最右页签。**1.0.2 起**页签与卡片标题统一为「今日」、各清单去掉重复的「打开原文」按钮、统计卡片改为列表内横向条形图、云端神经朗读搁置。**1.0.6 起**「过时提醒」改为任务级「催办 / 待办」，新增就地完成、批量改标签、导出目录与输入闭环命令。旧数据里的页签与坏死筛选值会在加载时自动迁移清理，旧 `cloudTtsEnabled` 开启状态一律强制归零，旧「过时阈值 90」自动迁移为「催办默认周期 30」。渲染全程有兜底，任何异常都会显示错误卡片与「重置视图」，不会再留下空白页。

**命令**：打开工作台、四个页签直达、重建索引、写入快照、重建 `.ics`、复制 `.ics`、为当前笔记开始复习、设为今天/明天到期、设为今天/明天复习、批量重命名 / 合并标签、导出笔记目录、应用复习排期、写入摘要、朗读当前笔记、播放/暂停朗读、停止朗读并保存断点。

**笔记字段**（写在 frontmatter，可选）：`tags`、`due`、`status`、`updated`、`review`、`review-stage`、`interval`、`ease`、`description` / `summary` / `abstract`，以及 1.0.6 的 `follow-up` / `follow-up-every`（整篇任务的到期兜底）。任务级催办/待办写在**正文**：`- [ ] 任务 @due(2026-11-30)` 或 `- [ ] 每周复盘 @every(7d)`，也可用「每周 / 每月」等周期词（可在设置关闭自动识别）。插件默认**不改动你的笔记**；批量写回 `review` / `kw-summary` 需要「设置开关 + 主动执行命令」双重确认，今日清单的单条「完成」与快捷设日期则点击即执行。

**规则式摘要**（无 LLM）：frontmatter 摘要 → 正文首个有效段落 → 文件名 + 一级标题 → 文件名，截断 120 字，缓存在 `index.json`，仅在文件变动或算法升级时重算。

## 朗读：系统语音 / Piper 本地语音 + 朗读稿替代路径

- **系统语音（默认，零配置）**：Web Speech + 规则式韵律。句群分块、句末停顿、动态语速与音高、Natural / Neural 中文音色优选、可手动指定音色。
- **Piper 本地语音（1.0.7）**：把 61MB 中文神经模型与 WASM 运行时放进库内，插件直接读取本地文件合成语音，**完全离线、无需密钥、桌面和手机都能用**。自然度中等偏清晰，不是真人级，但比多数系统语音自然；点朗读即可发声。模型未就绪时自动回退系统语音。
- **一次性准备**：在插件根目录运行 `npm run piper:setup -- "<你的 vault 绝对路径>"`，脚本会把模型、`.onnx.json`、Piper 音素 WASM 与 ONNX Runtime WASM 写入 `知识管理工作台/tts/`，然后到设置页选择「Piper 本地语音」。模型不打进插件包，不写 `data.json`。
- **Android**：Android WebView 常无 Web Speech；Piper 本地语音不依赖 Web Speech，可直接用。若不想准备模型，原文窗口仍提供「复制朗读稿」「保存朗读稿到库内」，交给系统「随选朗读」。
- 云端神经朗读已搁置：`src/speech/cloud.ts` 保留在源码中但**未接线**，`main.js` 里不含 `requestUrl`，运行时严格零网络请求。

## 数据存放在哪里

| 文件 | 用途 |
| --- | --- |
| 笔记 frontmatter | 业务真相源（标签、待办、复习日期等） |
| `知识管理工作台/index.json` | 可重建的派生索引快照，损坏会自动重建；差异只做只读提示，**插件不会删除任何笔记** |
| `知识管理工作台/提醒.ics` | 待办与复习的全日日历事件，含提前 1 天 `VALARM`；1.0.1 补齐 `DTEND;VALUE=DATE`（次日）与 Outlook / Microsoft 兼容字段 |
| `知识管理工作台/tts/*` | 1.0.7 可选：Piper 中文模型与 WASM 运行时，由 `piper:setup` 一次性写入 |
| `知识管理工作台/朗读稿/*.md` | 仅在用户点「保存朗读稿到库内」时生成，供系统朗读使用 |
| Obsidian 插件 `data.json` | 页签位置、浏览历史、朗读断点、设置项（仅存本机） |

这些文件都在 vault 内，随你既有的同步方案跨端；**不导入也不依赖旧云端数据**。

## 已知限制（请务必阅读）

- **关闭 Obsidian 后不会推送提醒**：插件没有后台常驻能力。请把 `知识管理工作台/提醒.ics` 导入或订阅到系统日历（含 `VALARM` 提前 1 天提醒），由系统日历负责触发；插件启动时也只弹一次应用内今日汇总。若 Outlook 仍报解析错误，`dist/ics-samples/` 里有 A（原版）/ B（仅加 DTEND）/ C（全量加固）/ D（多事件）四个对照样本可逐个拖入定位。
- **手机端系统语音可能不可用**：Android WebView 通常没有 Web Speech；建议准备 Piper 本地模型，或用朗读稿交给系统「随选朗读」。
- **Piper 自然度有限**：它是轻量神经语音，吐字清晰但还不是真人级；追求极致自然度需要更大的模型或云端服务，与轻量离线目标冲突。
- **真人级云端语气搁置**：插件不内置任何账号、令牌或默认服务地址，也不会在无人知晓的情况下向第三方发送笔记或朗读文本。
- **不提供** ZIP 快照恢复、每日轮询同步、A2HS 添加到主屏幕、LLM 摘要、旧云端数据导入。
- 复习排期采用固定间隔，不是 SM-2；`interval` / `ease` 字段为将来扩展预留。

## 设置

设置页分「索引与备份 / .ics 提醒 / 朗读」等分组，每项右侧的 **(i)** 可展开说明。可配置分类维度、过时阈值、复习间隔、索引与 `.ics` 路径、朗读引擎（系统 / Piper）、Piper 模型目录、朗读语速、中文音色优先、系统音色、自然韵律与句间停顿、自动续读、三个默认关闭的写回开关。云端地址 / 密钥输入框已移除。

## 隐私

- **没有任何联网行为**：源码与产物不用 `fetch` / `XMLHttpRequest` / Node 或 Electron API / `localStorage` / `indexedDB`，也没有硬编码外部 URL；v1.0.2 起 `main.js` 连宿主 `requestUrl` 都不再包含。
- 不发送笔记路径、文件名、frontmatter、索引、vault 内容、朗读文本或任何统计信息；没有遥测、没有账号体系。
- 所有 Markdown 渲染走 Obsidian 宿主 `MarkdownRenderer`，不拼接 HTML 字符串。

## 开发

```bash
npm install
npm run build          # esbuild 打包 + tsc --noEmit，产出 main.js
npm test               # Node 内置 node:test + 内存宿主回归集
npm run lint           # ESLint
npm run release:check  # 发布前静态合规自检，输出 dist/release-check.json
npm run benchmark      # 9999 篇全链路压测，输出 dist/benchmark-report.json
npm run ics:samples    # 生成 Outlook 导入对照样本到 dist/ics-samples/
npm run package        # 构建并产出 dist/knowledge-workbench-<version>.zip
npm run link-vault     # 复制到工作区内隔离的 test-vault
```

**桌面端真机自动验收**（需先以调试端口启动 Obsidian：`Obsidian.exe --remote-debugging-port=9222 --remote-allow-origins=*`）：

```bash
node scripts/live-smoke.mjs        # 通过 CDP 跑 20+ 项检查，输出 dist/live-smoke.json
```

脚本只读验证插件启用、索引与快照、`.ics`（含 DTEND 与 Outlook 字段）、四页签与「今日」标题、两张卡片的列表内横向条形图（且无 SVG 柱状图）、**点击条形 / 分类名不空白并展开笔记清单**、清单里没有重复的「打开原文」按钮、笔记名直达原文、笔记弹窗、主题变量、窄屏、朗读能力与云端朗读已搁置、控制台错误，并重建派生文件核对 UID 稳定；不修改笔记 frontmatter 与主题设置。明暗主题切换、真实发声、Outlook 导入与手机端仍需人工走查。

目录：`src/domain/` 纯函数（可单测）、`src/data/` 宿主服务、`src/speech/` 朗读纯函数与引擎、`src/ui/` 视图与设置、`src/__tests__/` 回归测试、`scripts/` 构建与发布脚本。

## 回滚

在「设置 → 第三方插件」中禁用或删除插件即可。笔记 frontmatter 与 vault 内数据文件都不会被删除；`index.json` 是可重建的派生数据，删除后下次启动会自动重新索引。在线版工作台与本插件彼此独立，互不影响。

## 许可证

MIT，见 [LICENSE](LICENSE)。版权人 Gintmos；源码仓库与 Release：<https://github.com/Gintmos/knowledge-workbench>。
