# Knowledge Workbench

**Knowledge Workbench** is a local-first Obsidian plugin that turns your vault into a lightweight knowledge workbench: classify notes by tags or folders, track due and overdue tasks, schedule spaced reviews, and read notes aloud in place. No backend, no account, no telemetry — all data stays inside your vault.

> **默认离线、不联网，朗读是唯一允许联网的功能**：可选 Edge 神经语音（桌面、免费无密钥）或自定义 TTS 网关（双端、需你自己的 API 密钥）；其余功能零网络请求，关闭 Obsidian 后不推送提醒，请把 `.ics` 导入系统日历。

| 维度 | 说明 |
| --- | --- |
| 运行方式 | 本地优先、零后端、不后台常驻；跨设备同步由你既有的同步方案负责 |
| 双端支持 | `isDesktopOnly: false`，桌面与手机端共用同一份代码（最低 Obsidian `1.7.2`） |
| 数据真相源 | 笔记 frontmatter；`index.json` 只是可随时重建的派生快照 |
| 联网边界 | 仅朗读，且必须你主动选择联网引擎；请求只含当前段落文字与音色 |
| 朗读引擎 | 系统语音（默认离线） / Edge 神经语音（桌面免费） / 自定义 TTS 网关（双端） |

Key features: four tabs (Today / Review / Statistics / History), task-level follow-ups parsed from `- [ ]` items, rule-based four-tier summaries with no LLM, Ebbinghaus review scheduling, all-day `.ics` reminders with advance alarms, bulk tag rename/merge, markdown catalog export, resumable read-aloud, and inline horizontal bar charts for every category.

---

## 目录

[安装](#安装) · [五分钟上手](#五分钟上手) · [四个页签](#四个页签) · [任务与催办](#任务与催办) · [复习排期](#复习排期) · [统计与批量操作](#统计与批量操作) · [朗读](#朗读唯一联网能力) · [数据放在哪里](#数据放在哪里) · [设置一览](#设置一览) · [已知限制](#已知限制) · [隐私与安全](#隐私与安全) · [命令清单](#命令清单) · [开发与校验](#开发与校验) · [版本与发布](#版本与发布) · [回滚](#回滚) · [许可证](#许可证)

---

## 安装

三种方式任选其一：

1. **手动复制**（推荐先这样试用）
   把 `main.js`、`manifest.json`、`styles.css` 三个文件放进 `<vault>/.obsidian/plugins/knowledge-workbench/`，重启 Obsidian，在「设置 → 第三方插件」中启用。仓库也提供脚本：`node scripts/link-vault.mjs "<vault 绝对路径>"`。
2. **GitHub Release**：从 [Releases 页面](https://github.com/Gintmos/knowledge-workbench/releases) 下载 `knowledge-workbench-<version>.zip`，解压后把三个文件放入上述目录。**Release 的 tag 与 `manifest.json` 的 `version` 一致**（当前 `1.0.10`）。
3. **BRAT 灰度**：在 BRAT 中添加 `https://github.com/Gintmos/knowledge-workbench`，可跟随 Release 自动更新。

插件已在 Obsidian 社区插件目录上架，搜索 **Knowledge Workbench** 亦可直接安装。安装后通过左侧 ribbon 图标、命令面板「打开知识管理工作台」或四个页签命令进入。

## 五分钟上手

1. 给需要跟踪的笔记加 frontmatter 日期：`due: 2026-11-30`（到期）或 `review: 2026-11-30`（复习）。
2. 在正文任务行写 `- [ ] 交报告 @due(2026-11-30)` 或 `- [ ] 每周复盘 @every(7d)`，即进入「催办 / 待办」与日历。
3. 打开「今日」页签处理清单；到「统计」页点「重建 .ics」，把 `知识管理工作台/提醒.ics` 导入或订阅到系统日历，关掉 Obsidian 也能收到提醒。

不需要任何账号、密钥或外部服务；朗读保持默认的「系统语音」即可全程离线。

## 四个页签

| 页签 | 内容 |
| --- | --- |
| **今日** | 逾期 / 今日到期 / 催办 / 复习到期 / 待办，按组折叠、组内有「加载更多」；任务行可就地「完成」；顶部显示 `.ics` 状态 |
| **复习** | 到期复习清单与艾宾浩斯排期（默认 1 / 2 / 4 / 7 / 15 / 30 / 60 天）；点「完成复习」自动推进下一轮 |
| **统计** | 索引状态（调试指标收进默认折叠的「运行信息」）、`.ics` 状态、「主分类总览」与「标签 / 文件夹」卡片；卡片下半部分**每行一条横向条形图**，点名称或条形在同一卡片内展开该分类的笔记清单，笔记名直达 vault 原文。超过 30 项时显示截断提示 |
| **浏览历史** | 最近 20 篇，标题即入口，打开带朗读的原文窗口（窗口内可「在 Obsidian 中打开」） |

渲染全程有兜底：任何异常都会显示错误卡片与「重置视图」，不会留下空白页。旧数据里的坏死筛选值与过时页签会在加载时自动迁移清理。

## 任务与催办

催办 / 待办来自**正文未完成任务**，不依赖额外数据库：

```markdown
- [ ] 提交季度报告 @due(2026-11-30)
- [ ] 每周复盘 @every(7d)
- [ ] 整理书桌 @due(每周)
```

- `@due(日期)` 指定到期日；`@every(周期)` 或「每周 / 每月」等周期词形成重复催办，可在设置里关闭自动识别。
- 无日期的任务只显示为「待办」，不写进日历。
- `follow-up` / `follow-up-every` 写在 frontmatter，作为整篇任务级到期兜底。
- 批量写回 `review` / `kw-summary` 需要「设置开关 + 主动执行命令」双重确认；插件默认不改动你的笔记。

**笔记字段**（frontmatter，均可选）：`tags`、`due`、`status`、`updated`、`review`、`review-stage`、`interval`、`ease`、`description` / `summary` / `abstract`、`follow-up` / `follow-up-every`。`interval` / `ease` 为将来扩展预留。

**规则式摘要**（无 LLM、无网络）：frontmatter 摘要 → 正文首个有效段落 → 文件名 + 一级标题 → 文件名，四档回退、截断 120 字，缓存在 `index.json`，仅在文件变动或算法升级时重算。

## 复习排期

「开始复习」是唯一入队入口：写入 `review` / `review-stage`，按艾宾浩斯固定间隔排期；今日清单点「完成复习」自动写回下一轮；「停止复习」删除这两个字段使笔记退出序列。旧默认间隔（1/3/7/15/30）会自动迁移，自定义间隔保留。

> 复习采用固定间隔而非 SM-2，不做难度自适应。

## 统计与批量操作

- **主分类**：按标签第一段或笔记所在第一层文件夹聚合，逐篇统计不设上限，图表最多取 Top 10。
- **标签 / 文件夹卡**：列表内横向条形图按篇数比例绘制，明细区可滚动；点条目展开该分类的笔记清单。
- **管理标签**：批量重命名 / 合并标签，先预览影响篇数，再经弹窗内两步确认执行；可选「同时替换正文内联 `#标签`」（自动保护 frontmatter、代码块与链接锚点，子标签层级保留）。
- **导出笔记目录**：写出 `知识管理工作台/笔记目录.md`。

## 朗读（唯一联网能力）

朗读引擎在设置页选择，**只有你主动选了联网引擎才会联网**，默认「系统语音」完全离线。

| 引擎 | 联网 | 平台 | 密钥 | 说明 |
| --- | --- | --- | --- | --- |
| 系统语音（默认） | 否 | 桌面 + 手机 | 无 | Web Speech + 规则式韵律；零配置，但 Android WebView 常无系统音色 |
| Edge 神经语音 | 是 | **仅桌面** | **无需密钥** | 微软「大声朗读」神经语音，7 种普通话 / 方言音色，国内可直连；因需自定义请求头，手机端不可用 |
| 自定义 TTS 网关 | 是 | 桌面 + 手机 | 你自己的 API Key | 任意 OpenAI `/v1/audio/speech` 兼容服务，用宿主 `requestUrl` 规避 CORS |

**安卓怎么配**：设置页「安卓语音预设」下拉已预置国内可直连的服务商（阿里云百炼 CosyVoice3 / Qwen-TTS、硅基流动、OpenAI），选中即自动填好服务地址、模型与音色并切到自定义网关，**只需粘贴你自己的 API Key**。这是安卓端获得与桌面一致神经语音效果的唯一可行方案；也可手动填火山引擎 / 腾讯 / 百度等同类网关。完全不想联网时，原文窗口提供「复制朗读稿」「保存朗读稿到库内」，交给系统「随选朗读」即可。

**密钥与清空**：密钥只保存在本机插件配置 `data.json`，不写入笔记、索引或日志；若 vault 位于同步盘，`data.json` 会随之同步，建议使用服务商的子密钥或只读密钥。设置页「自定义 TTS 网关 → **清空已保存的 API 密钥**」提供一键清除：两步确认后只移除密钥，服务地址 / 模型 / 音色 / 引擎开关全部保持不变；网关会实时读取配置，**密钥清空后立即不再发起联网请求**。

**交互与稳定性**：朗读窗口有语速下拉（0.75×–2×，设置页也支持 0.5–3 自由值，立即生效并记住）；暂停后拖动进度条再点「继续朗读」可正确续播；已合成音频缓存并预取下一块，开始播放 / 拖动秒开；引擎偶发失败先有限重试，连续失败才回退系统语音。每次联网请求只发送当前段落文字与所选音色。

**关于免费密钥**：Edge 引擎无需任何密钥，是微软免费接口；自定义网关即使服务商提供免费额度，也需要你自己注册账号创建 API Key——插件不内置、也不会共享任何账号或令牌（内置密钥会泄露在公开仓库、被滥用盗刷、且无法轮换）。此前的 Piper / Kokoro / Matcha / sherpa-onnx 本地 WASM 方案因自然度或 Obsidian Electron 运行时兼容性问题已全部移除。

## 数据放在哪里

| 文件 | 用途 |
| --- | --- |
| 笔记 frontmatter | 业务真相源：标签、待办、复习日期等 |
| `知识管理工作台/index.json` | 可重建的派生索引快照，损坏会自动重建；差异只做只读提示，**插件不会删除任何笔记** |
| `知识管理工作台/提醒.ics` | 待办与复习的全日日历事件，含提前 1 天 `VALARM`、`DTEND;VALUE=DATE`（次日）与 Outlook / Microsoft 兼容字段 |
| `知识管理工作台/笔记目录.md` | 仅在点「导出笔记目录」时生成 |
| `知识管理工作台/朗读稿/*.md` | 仅在点「保存朗读稿到库内」时生成 |
| Obsidian 插件 `data.json` | 页签位置、浏览历史、朗读断点、设置项（含自填的网关地址与密钥，仅存本机） |

这些文件都在 vault 内，随你既有的同步方案跨端；**不导入也不依赖旧云端数据**。

## 设置一览

设置页分「索引与备份 / .ics 提醒 / 朗读 / 自定义 TTS 网关 / 朗读（通用）/ 导出 / 关于」等分组，每项右侧 **(i)** 可展开说明，常驻的「网关就绪状态条」会即时显示引擎 / 开关 / 地址密钥三态。

可配置：分类维度、复习间隔、自动识别周期词、索引与 `.ics` 路径、朗读引擎、Edge 音色与 Edge 接口版本（微软升级后可热修，403 诊断会显示在「朗读能力」）、**安卓语音预设**、自定义网关的地址 / 密钥 / 模型 / 音色 / 风格 / 启用开关、**清空密钥**、朗读语速、中文音色优先、系统音色、自然韵律与句间停顿、自动续读，以及三个默认关闭的写回开关。联网引擎默认都不启用。

## 已知限制（请务必阅读）

- **关闭 Obsidian 后不会推送提醒**：插件没有后台常驻能力。请把 `知识管理工作台/提醒.ics` 导入或订阅到系统日历（含 `VALARM` 提前 1 天提醒），由系统日历负责触发；插件启动时也只弹一次应用内今日汇总。若 Outlook 仍报解析错误，`dist/ics-samples/` 里有 A（原版）/ B（仅加 DTEND）/ C（全量加固）/ D（多事件）四个对照样本可逐个拖入定位。
- **Edge 神经语音仅桌面可用**：微软接口要求自定义 Host / Origin / User-Agent 请求头，Android WebView 无法设置；手机端朗读请用「自定义 TTS 网关」（设置页有安卓一键预设）或朗读稿。
- **自定义网关需你自己的密钥**：插件不内置任何账号、令牌或默认服务地址；预设只填服务商的公开地址 / 模型 / 音色，免费额度用完后按服务商规则计费。
- **联网仅限朗读**：插件绝不会在无人知晓时联网；只有把引擎切到 Edge 或自定义网关并主动朗读时才发起请求，且只发送当前段落文字与音色。
- **不提供** ZIP 快照恢复、每日轮询同步、A2HS 添加到主屏幕、LLM 摘要、旧云端数据导入。
- 复习排期采用固定间隔，不是 SM-2。

## 隐私与安全

- **默认不联网**：除朗读外所有功能都不联网。源码与产物在非语音路径不用 `fetch` / `XMLHttpRequest` / `localStorage` / `indexedDB`，也不含硬编码外部 URL。
- **朗读是唯一联网例外，且需主动开启**：Edge 引擎（桌面）用 Node `ws` 设置微软接口所需请求头，自定义网关用宿主 `requestUrl`；两者默认都关闭。
- **Node 模块只服务桌面朗读**：`ws` 会让打包产物带出一组 Node 内置模块 `require`（`crypto` / `net` / `tls` / `http` / `https` / `stream` / `url` / `zlib` / `events` / `buffer` 等）。`edgeEngine.ts` 由 `if (!Platform.isMobile)` 门控的静态字面量动态 `import()` 加载，手机端不会加载该模块；`isDesktopOnly` 保持 `false`。发布自检用白名单守护 `require` 清单，禁止出现 `fs` / `child_process` / `electron`。
- **密钥只在本机**：`cloudTtsKey` 仅存 `data.json`，不进 `index.json` / `.ics` / 导出目录 / 日志 / 产物；错误回显统一脱敏。需要移除时用设置页「清空密钥」，或手动删掉 `data.json` 中该字段。
- **请求内容最小化**：不发送笔记路径、文件名、frontmatter、索引或 vault 内容；没有遥测、没有账号体系。
- 所有 Markdown 渲染走 Obsidian 宿主 `MarkdownRenderer`，不拼接 HTML 字符串。

## 命令清单

打开工作台、四个页签直达、重建索引、写入快照、重建 `.ics`、复制 `.ics`、为当前笔记开始复习、停止当前笔记复习、批量重命名 / 合并标签、导出笔记目录、应用复习排期、写入摘要、朗读当前笔记、播放/暂停朗读、停止朗读并保存断点。笔记原文右上角「更多选项」菜单也提供「开始复习 / 停止复习」。

## 开发与校验

```bash
npm install
npm run build            # esbuild 打包 + tsc --noEmit，产出 main.js
npm run typecheck        # 仅类型检查
npm run lint             # ESLint
npm test                 # Node 内置 node:test 回归集
npm run release:check    # 发布前静态合规自检，输出 dist/release-check.json
npm run audit:baseline   # 功能验收基线核对
npm run lint:obsidian    # Obsidian 社区规则本地复核（零依赖，Error 零容忍）
npm run benchmark        # 9999 篇全链路压测，输出 dist/benchmark-report.json
npm run ics:samples      # 生成 Outlook 导入对照样本到 dist/ics-samples/
npm run package          # 构建并产出 dist/knowledge-workbench-<version>.zip
npm run link-vault       # 复制到工作区内隔离的 test-vault
npm run smoke:ui         # 真机 CDP 只读 UI 冒烟，输出 dist/ui-smoke.json
```

真机自动验收需先以调试端口启动 Obsidian（`Obsidian.exe --remote-debugging-port=9222 --remote-allow-origins=*`），然后运行 `npm run smoke:ui`（或更早的 `node scripts/live-smoke.mjs`）。脚本只读验证插件版本、四页签、页脚离线口径、笔记弹窗、朗读控件、统计卡片顺序、设置页分组 / 网关状态条 / 清空密钥按钮与控制台错误；不修改笔记 frontmatter 与用户设置。明暗主题切换、Edge / 网关真实发声、Outlook 导入与手机端仍需人工走查。

目录：`src/domain/` 纯函数（可单测）、`src/data/` 宿主服务、`src/speech/` 朗读纯函数与引擎、`src/ui/` 视图与设置、`src/__tests__/` 回归测试、`scripts/` 构建与发布脚本。

## 版本与发布

当前版本 **1.0.10**（`minAppVersion` 1.7.2）。版本号在 `manifest.json` / `package.json` / `package-lock.json` / `versions.json` / `CHANGELOG.md` 保持一致，GitHub Release 的 tag 等于版本号，Release 资产为 `main.js`、`manifest.json`、`styles.css` 与 `knowledge-workbench-<version>.zip`。社区插件目录中的 **Knowledge Workbench** 已上架，发版后由目录侧更新版本，无需重新提交。完整变更历史见 [CHANGELOG.md](CHANGELOG.md)。

## 回滚

在「设置 → 第三方插件」中禁用或删除插件即可。笔记 frontmatter 与 vault 内数据文件都不会被删除；`index.json` 是可重建的派生数据，删除后下次启动会自动重新索引。在线版工作台与本插件彼此独立，互不影响。

## 许可证

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 Gintmos。源码仓库与 Release：<https://github.com/Gintmos/knowledge-workbench>。
