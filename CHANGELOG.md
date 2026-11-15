# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。版本号与 `manifest.json` / `versions.json` 保持一致，GitHub Release 的 tag 必须等于版本号。

## 1.0.1 — 2026-11-15

实机检查后的缺陷修复与体验优化。默认仍是零网络请求；云端神经朗读为**显式开启的可选功能**。

### 修复

- **致命缺陷**：`Chart.ts` 曾把 `"kw-chart-col is-active"` 当作单个类名传给宿主的 `createSvg`，命中 `classList.add` 的空格校验异常，导致点柱子后整页渲染中断、只剩标题，且筛选值持久化后页签重启仍卡死。改为事后 `classList.add("is-active")`。
- **渲染兜底**：`WorkbenchView.render()` 全程 try/catch，异常时显示错误卡片与「重置视图」按钮，杜绝空白页；旧 `data.json` 中的坏死筛选值在 `normalizeData` 阶段自动清除。
- **Outlook 导入**：全天事件补齐 `DTEND;VALUE=DATE:<次日>`，并加 `X-WR-CALNAME`、`SEQUENCE`、`STATUS`、`X-MICROSOFT-CDO-ALLDAYEVENT`、`X-MICROSOFT-CDO-BUSYSTATUS`；仍保持 CRLF、75 octets 折行与稳定 UID。`scripts/ics-samples.mjs` 生成 A/B/C/D 四个对照样本。
- **漏测补齐**：桌面 CDP 验收加入「真实点击 SVG 柱」「点击分类名」「笔记名直达原文」「渲染兜底」等检查。

### 变更

- 取消「知识库」页签与全库明细；浏览历史独立成最右页签。页签顺序：今日要处理 / 复习 / 统计 / 浏览历史。
- 统计页内容与 layout 不变，只在「全量分类」「标签 / 文件夹」两张**已有卡片**内各嵌一张全量柱状图（所有类别都出柱，横向滚动查看）；点柱子或分类名在该卡片内展开笔记清单，笔记名直达 vault 原文，「预览」打开带朗读的弹窗。
- 柱状图不再使用「Top 10 + 其他」语义；`chartSlices` 保留给旧有限图表调用方，统计页改用 `allCategorySlices` / `detailSlices`。

### 新增

- **朗读韵律（方案 A）**：句群分块（逗号 / 顿号不再切碎）、按标点注入句间停顿、动态 rate / pitch、Natural / Neural 音色优选、可手动指定系统音色、口语化 Markdown 清洗与标题停顿。
- **可选云端神经 TTS**：兼容 OpenAI `/v1/audio/speech` 及同类网关，`requestUrl` + data URI 播放，默认关闭、地址与密钥留空；离线 / 失败自动回退方案 A。仅发送当前朗读文本块，不发送笔记路径或索引。
- **Android 替代路径**：无 Web Speech 时提供「复制朗读稿」「保存朗读稿到库内」，交给系统「随选朗读」；语音能力提示改为准确描述宿主限制。

### 验证

- `npm test` 108/108（新增 9 项 1.0.1 专项回归）；`npm run release:check` 47/47；`npm run benchmark` 11/11；桌面 CDP 真机验收见 `dist/live-smoke.json`。

## 1.0.0 — 2026-11-15

首个可用版本，对应开发计划 P1–P6 的全部范围。零后端、零网络请求、零运行时依赖，桌面与手机双端（`isDesktopOnly: false`）。

### 新增

- **P1 工程脚手架**：TypeScript + esbuild，`manifest.json` / `versions.json` / `styles.css`，插件 id `knowledge-workbench`，`minAppVersion 1.5.0`。
- **P2 数据底座**：`VaultIndexService` 全量分批扫描（60 篇/批、并发 8、每批让出主线程）与 `create / modify / delete / rename / changed / deleted / resolved` 事件驱动增量；`index.json` 派生快照写入 vault、损坏自动重建、只读差异提示；`StoreService` 单一 `PluginData` 持久化与重命名迁移。
- **P3 领域逻辑**：规则式摘要（四档优先级、120 字截断、按 mtime 与算法版本缓存）、Markdown 噪音清洗、标签/文件夹分类与 Top 10 图表语义、待办与逾期、过时提醒（默认 90 天）、固定间隔复习排期、`.ics`（VCALENDAR / VEVENT / VALARM / `DTSTART;VALUE=DATE`、UTF-8 字节折行、CRLF、稳定 UID）。
- **P4 原生界面**：四页签 `ItemView`、内联 SVG 柱状图（点柱筛选、明细可滚动可拖动）、`NoteModal` 统一走 `MarkdownRenderer.render()` 并接管内部链接、`HistoryView` 最近 20 篇、设置页分组与 `(i)` 折叠说明、ribbon / 命令 / 状态栏 / 启动 Notice，样式全用主题变量并适配 520px 窄屏。
- **P5 听笔记**：分块队列（160 字上限、句读优先）、SP 四态机与 token 隔离、Web Speech 引擎适配与中文音色优先、断点续读、`role="slider"` 可拖进度条与键盘操作、静音超时降级与卸载清理。
- **P6 兼容与发布**：官方规范修正（设置页去掉顶层标题、宿主事件改由 `Component.registerEvent()` 登记、明细列表改为每页 60 条懒渲染）；发布前静态合规自检、9999 篇全链路压测、90+ 项回归测试集、发布材料与可分发 zip。

### 已知限制

- 关闭 Obsidian 后不推送提醒，改用 `.ics` 系统日历 + 启动时应用内汇总。
- 手机端朗读依赖系统 Web Speech API，可能不可用；插件会检测并降级提示。
- 不提供 ZIP 快照恢复、每日轮询同步、A2HS、LLM 摘要、旧云端数据导入。
- 真机双端冒烟、系统日历导入 `.ics`、真实库万篇压测需要在使用者设备上完成，见《双端实机验收手册》。

### 数据说明

业务数据写入笔记 frontmatter，`index.json` 与 `提醒.ics` 写入 vault 内「知识管理工作台」目录，插件状态由 `loadData/saveData` 管理。所有文件随用户既有同步方案跨端；禁用插件不会删除任何笔记。
