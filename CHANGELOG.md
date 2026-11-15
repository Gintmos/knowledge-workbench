# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。版本号与 `manifest.json` / `versions.json` 保持一致，GitHub Release 的 tag 必须等于版本号。

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
