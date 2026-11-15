# 知识管理工作台（Obsidian 插件）

把「在线知识管理工作台」的能力搬进 Obsidian 原生插件：**按标签/文件夹分类知识、追踪待办与过时提醒、安排复习、在库内打开并朗读笔记**。

**纯本地、零后端、零网络请求、零运行时依赖。** 插件不会联网、不会上传笔记、没有遥测，也不会在后台常驻。数据全部存在你的 vault 里，跨设备同步由你既有的同步方案负责。

> 最低支持 Obsidian `1.5.0`（`processFrontMatter` 自 1.4.4 起提供）。`isDesktopOnly: false`，桌面与手机端均可安装。

## 安装

三种方式任选其一：

1. **手动复制到 vault**（推荐先这样试用）
   把 `main.js`、`manifest.json`、`styles.css` 放进 `<vault>/.obsidian/plugins/knowledge-workbench/`，重启 Obsidian，在「设置 → 第三方插件」中启用。也可使用仓库脚本：`node scripts/link-vault.mjs "<vault 绝对路径>"`。
2. **BRAT 灰度**：在 BRAT 中添加 `https://github.com/Gintmos/knowledge-workbench`，可自动跟随 Release 更新，适合小范围试用。
3. **GitHub Release**：从 [Releases 页面](https://github.com/Gintmos/knowledge-workbench/releases) 下载 `knowledge-workbench-1.0.0.zip`，解压后三个文件直接放入上述插件目录。Release 的 tag 必须与 `manifest.json` 的 `version` 一致。

安装后可通过左侧 ribbon 的「打开知识管理工作台」、命令面板「打开知识管理工作台」或四个页签命令进入。

## 功能

| 页签 | 内容 |
| --- | --- |
| 今日要处理 | 逾期 / 今日到期 / 复习到期 / 过时提醒，按组折叠；顶部显示 `.ics` 状态 |
| 知识库 | 分类明细、笔记摘要、打开原文（统一 Markdown 弹窗）、浏览历史 |
| 复习 | 到期复习清单与复习排期（1 / 3 / 7 / 15 / 30 天） |
| 统计 | 逐篇计数、Top 10 内联 SVG 柱状图（点柱筛选明细）、索引状态 |

**命令**：打开工作台、四个页签直达、重建索引、写入快照、重建 `.ics`、复制 `.ics`、应用复习排期、写入摘要、朗读当前笔记、播放/暂停朗读、停止朗读并保存断点。

**笔记字段**（写在 frontmatter，可选）：`tags`、`due`、`status`、`updated`、`review`、`review-stage`、`interval`、`ease`、`description` / `summary` / `abstract`。插件默认**不改动你的笔记**；写回 `review` / `kw-summary` 需要「设置开关 + 主动执行命令」双重确认。

**规则式摘要**（无 LLM）：frontmatter 摘要 → 正文首个有效段落 → 文件名 + 一级标题 → 文件名，截断 120 字，缓存在 `index.json`，仅在文件变动或算法升级时重算。

## 数据存放在哪里

| 文件 | 用途 |
| --- | --- |
| 笔记 frontmatter | 业务真相源（标签、待办、复习日期等） |
| `知识管理工作台/index.json` | 可重建的派生索引快照，损坏会自动重建；差异只做只读提示，**插件不会删除任何笔记** |
| `知识管理工作台/提醒.ics` | 待办与复习的全日日历事件，含提前 1 天提醒 |
| Obsidian 插件 `data.json` | 页签位置、浏览历史、朗读断点、设置项（由 `loadData/saveData` 管理） |

这些文件都在 vault 内，随你既有的同步方案跨端；**不导入也不依赖旧云端数据**。

## 已知限制（请务必阅读）

- **关闭 Obsidian 后不会推送提醒**：插件没有后台常驻能力。请把 `知识管理工作台/提醒.ics` 导入或订阅到系统日历（含 `VALARM` 提前 1 天提醒），由系统日历负责触发；插件启动时也只弹一次应用内今日汇总。
- **手机端朗读可能不可用**：朗读依赖系统的 Web Speech API。部分手机缺少中文音色或会静音，插件会自动检测并降级为「当前设备不支持朗读，可在桌面端使用」提示，不会留下无响应的按钮。桌面端体验最完整。
- **不提供** ZIP 快照恢复、每日轮询同步、A2HS 添加到主屏幕、LLM 摘要、旧云端数据导入。
- 复习排期采用固定间隔，不是 SM-2；`interval` / `ease` 字段为将来扩展预留。

## 设置

设置页分「索引与备份 / .ics 提醒 / 朗读」等分组，每项右侧的 **(i)** 可展开说明。可配置分类维度（标签或文件夹）、过时阈值（默认 90 天）、复习间隔、索引快照路径、`.ics` 路径、朗读语速、中文音色优先、自动续读，以及三个默认关闭的写回开关。

## 隐私

源码与构建产物中**没有** `fetch` / `XMLHttpRequest` / `requestUrl` / Node 或 Electron API / `localStorage` / `indexedDB` 调用，也没有任何外部 URL。所有 Markdown 渲染走 Obsidian 宿主 `MarkdownRenderer`，不拼接 HTML 字符串。

## 开发

```bash
npm install
npm run build          # esbuild 打包 + tsc --noEmit，产出 main.js
npm test               # Node 内置 node:test + 内存宿主，99 项
npm run lint           # ESLint
npm run release:check  # 发布前静态合规自检，输出 dist/release-check.json
npm run benchmark      # 9999 篇全链路压测，输出 dist/benchmark-report.json
npm run package        # 构建并产出 dist/knowledge-workbench-<version>.zip
npm run link-vault     # 复制到工作区内隔离的 test-vault
```

目录：`src/domain/` 纯函数（可单测）、`src/data/` 宿主服务、`src/speech/` 朗读纯函数与引擎、`src/ui/` 视图与设置、`src/__tests__/` 回归测试、`scripts/` 构建与发布脚本。

## 回滚

在「设置 → 第三方插件」中禁用或删除插件即可。笔记 frontmatter 与 vault 内数据文件都不会被删除；`index.json` 是可重建的派生数据，删除后下次启动会自动重新索引。在线版工作台与本插件彼此独立，互不影响。

## 许可证

MIT，见 [LICENSE](LICENSE)。版权人 Gintmos；源码仓库与 Release：<https://github.com/Gintmos/knowledge-workbench>。
