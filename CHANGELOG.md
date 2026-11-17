# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。版本号与 `manifest.json` / `versions.json` 保持一致，GitHub Release 的 tag 必须等于版本号。

## 1.0.5 — 2026-11-17

社区目录 Release 自动审核修复，无功能与数据格式变更（vault 内数据、命令、插件 id 均与 1.0.4 相同）。

### 变更

- **`minAppVersion` 由 1.5.0 提升为 1.7.2**：1.0.4 的社区审核在 SOURCE CODE 分组报唯一 Error `Uses Obsidian APIs newer than the declared minAppVersion`（规则 `obsidianmd/no-unsupported-api`，定位 `src/main.ts:236`、`src/main.ts:242`）。`workspace.revealLeaf()` 的 `Promise<void>` 重载自 Obsidian 1.7.2 起提供（`@since 1.7.2`），而清单声明 1.5.0，版本不一致被判错。提升声明后消除该 Error。
- **`revealLeaf` 两处调用加 `await`**：同时消除 `Promises must be awaited` 警告，并保证在右侧栏打开视图后再聚焦。
- **README 英文化**：标题改为与 manifest 一致的 `Knowledge Workbench`，补充英文简介、功能与隐私说明，消除「README does not appear to contain English text」与「README title does not match the manifest name」两条 Warning。
- 发布自检与单元测试的 `minAppVersion` 门槛由 1.4.4 改为 1.7.2，防止回归。

### 未采纳的审核项

- Warning：`builtin-modules`、`globalThis`、`Vault#configDir`、`getSettingDefinitions()`、`requestAnimationFrame()`、CSS `display:contents` 等，均为建议级，不影响发布，本版不改。
- Recommendation：缺少 artifact attestation、Release 附带 zip、Vault 枚举与剪贴板访问说明，均不阻塞。

## 1.0.4 — 2026-11-16

社区目录命名修复，无功能与数据格式变更（vault 内数据、命令、id 均与 1.0.3 相同）。

### 变更

- **manifest `name` 改为 `Knowledge Workbench`**：1.0.3 的 `Knowledge Workbench · 知识管理工作台` 仍被目录自动审核以 `This name is not allowed in the directory` 拒绝。查 [Manifest 官方文档](https://docs.obsidian.md/Reference/Manifest#name) 确认真实规则：`name` 应使用 Basic Latin 字符，**除连字符 `-`、加号 `+`、括号 `()` 外不允许任何标点**，且不得含 emoji 或特殊字符。1.0.3 的名称同时含中文与中间点 `·`（U+00B7），两条均违规。新名称仅含 Basic Latin 字母与空格，不含 Obsidian / Plugin 变体，且在目录中唯一。
- 单元测试与静态合规自检的命名断言改为按上述官方规则校验 Basic Latin 与允许标点，替换 1.0.3 中「全大写误判」的错误假设。

## 1.0.3 — 2026-11-15

社区目录提交适配，无功能与数据格式变更（vault 内数据、命令、id 均与 1.0.2 相同）。

### 变更

- **manifest `name` 改为「Knowledge Workbench · 知识管理工作台」**（该名称随后被 1.0.4 取代：仍含中文与中间点，不符合 Basic Latin 规则）。当时的判断误以为拒绝原因是「纯中文被判全大写」，实际官方规则见 1.0.4 说明。
- **manifest `description` 改为英文并以句点结尾**：官方要求描述以英文标点 `.` 结尾、不含 Obsidian 字样、≤250 字符；原中文描述以「。」结尾会被判不合规。
- 单元测试与静态合规自检新增上述命名 / 描述断言，防止回归。

## 1.0.2 — 2026-11-15

按实机反馈做的三项收口。**云端神经朗读暂时搁置**，插件从「默认零网络请求」进一步收紧为「运行时严格零网络请求」。

### 变更

- **今日页**：页签标签与卡片标题由「今日要处理」统一改为「今日」；今日 / 复习 / 浏览历史清单移除笔记名后重复的「打开原文」按钮（笔记名本身就是入口，原文窗口内有「在 Obsidian 中打开」）。启动 Notice 文案同步更新。
- **统计页**：移除「全量分类」「标签 / 文件夹」两张已有卡片上半部分的纵向 SVG 柱状图（含横向滚动容器与「全部出柱」说明），也不新增卡片或改动 layout；改为在**下半部分列表每行**加一条横向条形图，宽度按该卡片内最大篇数成比例，全部分类都出条、可滚动查看。点名称或条形仍在同一卡片内展开笔记清单，清单笔记名直达 vault 原文，「预览」打开带朗读的弹窗。条形支持鼠标点击与 Enter / 空格键。
- **真人级语气（云端神经 TTS）搁置**：使用者没有自有语音服务地址与密钥，也没有不依赖密钥的可用替代方案。`main.ts` 不再导入 `src/speech/cloud.ts`，产物 `main.js` 不含 `requestUrl`；设置页移除 6 项无法使用的云端配置，改为一条「真人级语气（已搁置）」说明；`normalizeSettings` 把旧 `data.json` 里残留的开启状态强制归零。朗读继续走系统语音 + 规则式韵律（方案 A），Android 用「复制 / 保存朗读稿 + 系统随选朗读」。底层适配层保留在源码，日后可重新接线。

### 修复与回归

- 删除旧的 `chartGeometry` / `truncateLabel` 与 SVG 柱状图渲染路径（含 1.0.1 的 200 柱防御上限与横向滚动），换成纯函数 `barWidthPercent` / `barRowsMax` + `renderBarMeter`，不再有超宽 SVG 或类名空格异常的风险。
- 单元测试、静态合规自检与桌面 CDP 真机验收脚本同步改写：断言「今日」标题、无「打开原文」按钮、无 `svg.kw-chart`、两张卡片都有横向条、点击条形展开清单、云端引擎未接线。

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
