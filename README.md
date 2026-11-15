# 知识管理工作台（Obsidian 插件）

把「在线知识管理工作台」的能力搬进 Obsidian 原生插件：**按标签/文件夹分类知识、追踪待办与过时提醒、安排复习、在库内打开并朗读笔记**。

**纯本地、零后端、默认零网络请求、零运行时依赖。** 插件默认不会联网、不会上传笔记、没有遥测，也不会在后台常驻。数据全部存在你的 vault 里，跨设备同步由你既有的同步方案负责。唯一例外是下面说明的「可选云端神经朗读」，默认关闭，需要你主动开启并填写自己的服务地址与密钥。

> 最低支持 Obsidian `1.5.0`（`processFrontMatter` 自 1.4.4 起提供）。`isDesktopOnly: false`，桌面与手机端均可安装。

## 安装

三种方式任选其一：

1. **手动复制到 vault**（推荐先这样试用）
   把 `main.js`、`manifest.json`、`styles.css` 放进 `<vault>/.obsidian/plugins/knowledge-workbench/`，重启 Obsidian，在「设置 → 第三方插件」中启用。也可使用仓库脚本：`node scripts/link-vault.mjs "<vault 绝对路径>"`。
2. **BRAT 灰度**：在 BRAT 中添加 `https://github.com/Gintmos/knowledge-workbench`，可自动跟随 Release 更新，适合小范围试用。
3. **GitHub Release**：从 [Releases 页面](https://github.com/Gintmos/knowledge-workbench/releases) 下载 `knowledge-workbench-1.0.1.zip`，解压后三个文件直接放入上述插件目录。Release 的 tag 必须与 `manifest.json` 的 `version` 一致。

安装后可通过左侧 ribbon 的「打开知识管理工作台」、命令面板「打开知识管理工作台」或四个页签命令进入。

## 功能

| 页签 | 内容 |
| --- | --- |
| 今日要处理 | 逾期 / 今日到期 / 复习到期 / 过时提醒，按组折叠；顶部显示 `.ics` 状态 |
| 复习 | 到期复习清单与复习排期（1 / 3 / 7 / 15 / 30 天） |
| 统计 | 索引状态、`.ics` 状态、「全量分类」与「标签 / 文件夹」两张已有卡片，各自内嵌**全量柱状图**（所有类别都出柱，横向滚动查看）；点柱子或分类名称在同一卡片内展开该分类的笔记清单，清单里的笔记名**直达 vault 原文**，另有「预览」打开带朗读的弹窗 |
| 浏览历史 | 最近 20 篇，标题打开弹窗，同行按钮直达原文 |

**1.0.1 起取消「知识库」页签与全库明细**；浏览历史独立成最右页签。旧数据里的页签与坏死筛选值会在加载时自动迁移清理。渲染全程有兜底，任何异常都会显示错误卡片与「重置视图」，不会再留下空白页。

**命令**：打开工作台、四个页签直达、重建索引、写入快照、重建 `.ics`、复制 `.ics`、应用复习排期、写入摘要、朗读当前笔记、播放/暂停朗读、停止朗读并保存断点。

**笔记字段**（写在 frontmatter，可选）：`tags`、`due`、`status`、`updated`、`review`、`review-stage`、`interval`、`ease`、`description` / `summary` / `abstract`。插件默认**不改动你的笔记**；写回 `review` / `kw-summary` 需要「设置开关 + 主动执行命令」双重确认。

**规则式摘要**（无 LLM）：frontmatter 摘要 → 正文首个有效段落 → 文件名 + 一级标题 → 文件名，截断 120 字，缓存在 `index.json`，仅在文件变动或算法升级时重算。

## 朗读：系统语音与可选云端神经语音

- **默认（方案 A）**：系统 Web Speech + 规则式韵律。句群分块（逗号不再切碎）、句末停顿、动态语速与音高、Natural / Neural 中文音色优选、可手动指定音色。能明显改善断句与节奏，但系统级参数合成达不到真人语气。
- **真人级语气（可选）**：在「设置 → 朗读」开启「启用云端神经语音」，填写兼容 OpenAI `/v1/audio/speech` 的服务地址（例如 `https://api.openai.com/v1/audio/speech` 或你自建 / 中转网关）、API 密钥、模型与音色；「风格指令」会作为 `instructions` 传给模型控制语气、断句与停顿。音频用宿主 `requestUrl` 获取后以 data URI 播放，零运行时依赖。**离线、密钥失效或服务报错时会自动回退方案 A**。
- **Android**：Obsidian 使用的 Android WebView 自 2015 年起未实现 Web Speech API，这不是插件 bug。除开启云端神经语音外，原文窗口还提供「复制朗读稿」「保存朗读稿到库内」，可交给系统「随选朗读 / 选择即朗读」发声；朗读稿写到 `知识管理工作台/朗读稿/`。

## 数据存放在哪里

| 文件 | 用途 |
| --- | --- |
| 笔记 frontmatter | 业务真相源（标签、待办、复习日期等） |
| `知识管理工作台/index.json` | 可重建的派生索引快照，损坏会自动重建；差异只做只读提示，**插件不会删除任何笔记** |
| `知识管理工作台/提醒.ics` | 待办与复习的全日日历事件，含提前 1 天 `VALARM`；1.0.1 补齐 `DTEND;VALUE=DATE`（次日）与 Outlook / Microsoft 兼容字段 |
| `知识管理工作台/朗读稿/*.md` | 仅在用户点「保存朗读稿到库内」时生成，供系统朗读使用 |
| Obsidian 插件 `data.json` | 页签位置、浏览历史、朗读断点、设置项（含云端朗读配置，仅存本机） |

这些文件都在 vault 内，随你既有的同步方案跨端；**不导入也不依赖旧云端数据**。

## 已知限制（请务必阅读）

- **关闭 Obsidian 后不会推送提醒**：插件没有后台常驻能力。请把 `知识管理工作台/提醒.ics` 导入或订阅到系统日历（含 `VALARM` 提前 1 天提醒），由系统日历负责触发；插件启动时也只弹一次应用内今日汇总。若 Outlook 仍报解析错误，`dist/ics-samples/` 里有 A（原版）/ B（仅加 DTEND）/ C（全量加固）/ D（多事件）四个对照样本可逐个拖入定位。
- **手机端朗读可能不可用**：Android WebView 通常没有系统语音，请开启云端神经语音或使用朗读稿替代路径；iOS 视系统音色而定。插件会检测并给出中文提示，不会留下无响应的按钮。
- **云端朗读需要你自己的服务与密钥**：插件不内置任何账号、令牌或默认服务地址，也不承诺第三方服务的可用性与费用。
- **不提供** ZIP 快照恢复、每日轮询同步、A2HS 添加到主屏幕、LLM 摘要、旧云端数据导入。
- 复习排期采用固定间隔，不是 SM-2；`interval` / `ease` 字段为将来扩展预留。

## 设置

设置页分「索引与备份 / .ics 提醒 / 朗读」等分组，每项右侧的 **(i)** 可展开说明。可配置分类维度、过时阈值、复习间隔、索引与 `.ics` 路径、朗读语速、中文音色优先、系统音色、自然韵律与句间停顿、自动续读、三个默认关闭的写回开关，以及默认关闭的云端神经语音（服务地址 / 密钥 / 模型 / 音色 / 风格指令）。

## 隐私

- 默认路径下**没有**任何联网行为：源码与产物不用 `fetch` / `XMLHttpRequest` / Node 或 Electron API / `localStorage` / `indexedDB`，也没有硬编码外部 URL。
- 开启云端朗读后，**仅发送当前这一块待朗读的纯文本**到你自填的服务地址（附带你填的密钥作 Bearer 鉴权）；**不发送**笔记路径、文件名、frontmatter、索引、vault 内容或任何统计信息。请求只走 Obsidian 宿主 `requestUrl`，集中在 `src/speech/cloud.ts`，不写日志、不落库。
- 所有 Markdown 渲染走 Obsidian 宿主 `MarkdownRenderer`，不拼接 HTML 字符串。

## 开发

```bash
npm install
npm run build          # esbuild 打包 + tsc --noEmit，产出 main.js
npm test               # Node 内置 node:test + 内存宿主，108 项
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

脚本只读验证插件启用、索引与快照、`.ics`（含 DTEND 与 Outlook 字段）、四页签、两张卡片的柱状图与横向滚动、**点击柱子 / 分类名不空白并展开笔记清单**、笔记名直达原文、笔记弹窗、主题变量、窄屏、朗读能力与云端默认关闭、控制台错误，并重建派生文件核对 UID 稳定；不修改笔记 frontmatter 与主题设置。明暗主题切换、真实发声、Outlook 导入与手机端仍需人工走查。

目录：`src/domain/` 纯函数（可单测）、`src/data/` 宿主服务、`src/speech/` 朗读纯函数与引擎、`src/ui/` 视图与设置、`src/__tests__/` 回归测试、`scripts/` 构建与发布脚本。

## 回滚

在「设置 → 第三方插件」中禁用或删除插件即可。笔记 frontmatter 与 vault 内数据文件都不会被删除；`index.json` 是可重建的派生数据，删除后下次启动会自动重新索引。在线版工作台与本插件彼此独立，互不影响。

## 许可证

MIT，见 [LICENSE](LICENSE)。版权人 Gintmos；源码仓库与 Release：<https://github.com/Gintmos/knowledge-workbench>。
