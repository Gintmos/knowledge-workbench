# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。版本号与 `manifest.json` / `versions.json` 保持一致，GitHub Release 的 tag 必须等于版本号。

## 1.0.10 — 2026-11-22

> 本版为发布前全面审查 + 修复后全量复审（`全量复审报告_20261121_V2.md`，P0=0 / P1=2 / P2=8）的收口版本，随本次发布上传 GitHub 并创建 Release。`manifest.json` / `package.json` / `package-lock.json` / `versions.json` 同步为 1.0.10，`minAppVersion` 仍为 1.7.2。数据格式向后兼容，旧 `data.json` 自动归一化。

### P1 修复（复审 V2 发现）

- **修复「同时替换正文内联 #标签」选项完全失效**：原实现按行数（前 2 行）而非 `---` 定界符识别 frontmatter，导致带 frontmatter 的笔记正文一个内联标签都不替换且界面恒报成功。重构为纯函数 `src/domain/inlineTags.ts`（与 `stripFrontmatter` 同一定界规则），并新增保护：代码块内 `#tag` 不替换、`[[笔记#锚点]]` 与 `[文字](url#锚点)` 内的 `#` 是链接锚点不替换、子标签层级后缀保留。该路径此前无单测，现补齐 8 项行为测试。
- **删除无效设置「催办默认周期」**：该设置无任何消费者（改值零效果且触发一次无意义全库重扫），已从设置页移除；`staleDays` 字段仅为旧 `data.json` 归一化兼容保留，`TaskService.staleBaseDate` 死代码删除。今日页 / 催办行为零变化。

### P2 修复（轻微缺陷与清理债）

- 朗读条语速下拉兼容设置页任意自由语速（0.5–3）：非 5 档值时动态插入「当前 N×」临时项，不再显示空白。
- 清理 Piper 时代残留死分支（「本地语音模型加载中」提示分支）与过时注释。
- 清理死状态与死函数：`ViewState.mdView / note / lastModal`、`uiModel.filterPaths` 及其全部写点。
- 统计页「标签 / 文件夹」卡超 30 个时显示截断提示（完整列表可在「管理标签」中查看）。
- 索引状态卡「运行信息」展开状态记入视图实例，索引刷新触发的重渲染不再把展开状态复位。
- 今日页分组清单复用 60 条/页懒加载（组内「加载更多」按钮），数百条待办的库不再一次性渲染。
- 批量标签弹窗用弹窗内两步确认替换浏览器原生 `confirm` 对话框（首次点击展示影响摘要并变按钮为「再次确认」，改动任意输入即复位），移动端不再依赖原生对话框。
- 设置页「系统音色」下拉订阅音色就绪事件，系统音色异步加载完成后自动刷新选项，无需重开设置页。

### 发布准备（1.0.10 定稿）

- **新增「清空已保存的 API 密钥」按钮**：设置页「自定义 TTS 网关」组内，两步确认后只移除本机 `cloudTtsKey`，同步密码输入框与网关就绪状态条；服务地址 / 模型 / 音色 / 引擎开关全部保持不变。网关 `supported()` 实时读取配置，密钥清空后立即不再发起联网请求。
- **完整重写 `README.md`**：按 1.0.10 正式发布口径重新组织（安装、五分钟上手、四页签、任务与复习、朗读三引擎与安卓配置、密钥与清空、数据存放、已知限制、隐私、开发校验、版本发布、回滚），移除开发过程残留与过时表述；保留发布自检锁定的「默认离线 / 朗读是唯一联网例外」等口径断言。
- 校验工具链同步：`p3.test.ts` +2 条行为/静态断言、`release-check.mjs` +1 条门禁、`audit-feature-baseline.mjs` +1 条基线、`ui-smoke.mjs` +1 项真机只读检查（清空密钥按钮已就位）。

## 1.0.9 — 2026-11-21（本地版本，未发布）

> 本版为本地修复版：只在本机修改、验证与验收，**未上传 GitHub、未打 tag、未创建 PR**。`manifest.json` / `package.json` / `package-lock.json` / `versions.json` 同步升到 1.0.9，`minAppVersion` 仍为 1.7.2。数据格式向后兼容，旧 `data.json` 自动归一化，无需迁移；1.0.8 及更早版本的记录保持原样。

### 朗读：按「易用」重做，联网成为唯一例外

- **方案复核**：本地方案全部不合格——Piper 自然度不足；Kokoro / Matcha / sherpa-onnx WASM 在 Obsidian Electron 中输出 NaN 或底层异常。改为让**朗读成为唯一允许联网的功能**，其余功能保持严格离线。
- **Edge 神经语音**（桌面，免费无密钥）：接入微软 Edge「大声朗读」神经语音，2026 DRM v2（CS64-SHA256）鉴权，7 种普通话 / 方言音色；接口要求自定义 Host/Origin/UA 请求头，故仅桌面可用，以静态字面量动态 import 加载，手机端绝不触碰该模块。
- **自定义 TTS 网关**（双端）：`src/speech/cloud.ts` 用宿主 `requestUrl` 调 OpenAI `/v1/audio/speech` 兼容服务，规避 CORS；需用户自填地址、密钥、模型、音色并打开开关。联网引擎默认都不启用，只在用户主动朗读时发送当前段落文字与音色，不上传 vault / 索引 / 笔记路径。
- **安卓语音预设**：设置页新增下拉，预置已核对可行的国内 OpenAI 兼容神经 TTS 配置（阿里云百炼 CosyVoice3 / Qwen-TTS、硅基流动、OpenAI），选中即自动填好服务地址 / 模型 / 音色并切到自定义网关，只需补自己的 API Key。安卓 WebView 无法设置 Edge 自定义请求头，这是手机端获得与桌面一致神经语音效果的唯一可行方案。
- **暂停 / 拖动 / 续播状态同步**：修复暂停后拖动进度条、再点「继续朗读」无反应的问题。新增 `pendingResumeFromSeek` 标记：暂停态拖动保持暂停，恢复时重新合成当前块。
- **交互延迟与稳定性**：Edge / 网关引擎增加已合成音频缓存（data URI，上限 60 条）与下一段预取；首选引擎失败改为有限重试（连续失败才回退系统语音），修复停顿后偶发抖动被误判切到系统语音的问题。
- **朗读窗口语速下拉**：弹窗朗读条新增语速下拉（0.75× / 1× / 1.25× / 1.5× / 2×），立即生效并持久化。
- **彻底移除 Piper**：删除 `src/speech/piperEngine.ts`、`piper-setup.mjs`、`verify-piper-local.mjs`、103MB 隔离测试库及全部设置项 / 类型 / 界面 / 校验脚本引用；旧的 `speechEngine: "piper"` 配置平滑迁移到系统语音。同时消除社区审核报错 `Unsafe call to import for argument 0`（原 Piper 运行时 blob URL 动态导入）。
- 运行时依赖仅新增 `ws`（Edge 引擎桌面设置请求头所需），esbuild 强制其走 Node codepath；产物动态 `import(` 命中 0。

### 复习与任务入口

- 删除原文窗口与命令面板的「今天到期 / 明天到期 / 今天复习 / 明天复习」快捷设日期入口；对应命令、回调与 `writeDateField()` 一并移除。`due` 字段仍由索引与正文任务解析照常读取。
- 「开始复习」是唯一的入队入口：写入 `review` / `review-stage`，按艾宾浩斯曲线默认 1/2/4/7/15/30/60 天排期；今日清单点「完成复习」自动推进下一轮。旧默认 1/3/7/15/30 自动迁移，自定义间隔保留。
- 「标记完成」改为「停止复习」：删除 frontmatter 的 `review` / `review-stage`，使笔记退出复习序列。命令面板与 Obsidian 原文右上角「更多选项」菜单都提供「开始复习 / 停止复习」。

### 用户界面（发布前审查第一步）

- 朗读条引擎标签独立成行，不再被挤出控件行；任务行 meta 只显摘要、完整路径移入悬浮提示，行改 flex 布局取消浮动。
- 统计页卡片按业务数据优先重排，主分类 / 标签分布上移，索引状态与 `.ics` 下移。
- 设置页新增「朗读（通用）」分组，网关组只留 6 项；网关就绪度状态条常驻显示引擎 / 开关 / 地址密钥三态并即时刷新。
- 四处过时文案统一为「默认离线，仅朗读可选联网」；返回类按钮改用次级样式；说明 (i) 按钮放大并把写回 / 密钥高风险提示提升为常驻说明；笔记弹窗属性区改为默认折叠。

### 发布元数据与文案

- 版本升 1.0.9；`manifest.json` 与 `package.json` 的 `description` 去掉绝对化的 "zero network requests" / "no network requests"，改为「默认离线、仅可选神经朗读联网」，消除与实际行为的矛盾；README 首段、安装说明、设置分组与隐私段落同步收口。发布自检与单测新增描述一致性断言防止回归。

### 稳健性与合规（发布前审查第三步，2026-11-21，本地未发布）

- **P1-1 Edge 接口版本可热修**：DRM v2 版本号、端点、Host/Origin/UA 等协议常量集中到零 Node 依赖的 `src/speech/edgeProtocol.ts`（设置页可安全引用，不把 `ws` 带进手机端）。设置页「朗读 → Edge 接口版本」支持用户填写最新 Chromium 完整版本号，微软升级接口后无需等插件发版；输入严格校验，非法值回退内置版本，UA 主版本同步跟随。
- **P1-1 403 不再静默降级**：`unexpected-response` / `error` 两条路径都把 403 / 401 翻译成可操作诊断，经 `SpeechService` 回传设置页「朗读能力」；回退系统语音后仍显示最近失败原因，改配置或首选引擎恢复出声才清除。新增纯函数单测与失败链路单测。
- **P1-2 密钥链路核对与错误脱敏**：确认 `cloudTtsKey` 明文只存在于用户本机 `data.json`，不写入 `index.json` / `.ics` / 导出目录 / 日志 / 弹窗 / 打包产物；网关 401/403/429/5xx 改为分类诊断，错误对象只取 message 并抹掉 Bearer 凭据，不回显请求头。发布自检新增 5 条隐私门禁（含同步盘风险常驻提示与 password 遮盖）。未新增「清空密钥」按钮（涉及新增交互，留待用户决策）。
- **P1-3 社区规则本地门禁**：新增零依赖 `scripts/lint-obsidian.mjs` 与 `npm run lint:obsidian`，把社区关注的 Error 级规则（动态 import 非字面量、innerHTML、window.app、localStorage、Node 模块、硬编码 CSS 等）前置到本地；Warning 与既有历史基线（17 处 `globalThis`、1 处 `requestAnimationFrame`、1 处 `display:contents`、ws 的 Node require）对齐，新增违规即失败。官方 `eslint-plugin-obsidianmd` 需 ESLint 9 + typescript-eslint 8，与本项目 ESLint 8 体系不兼容，故不升级现有 lint 体系。
- **P1-4 Node 模块据实说明**：产物 `require` 目标固定为 `ws` 依赖清单（13 类，含 `obsidian`），由 `Platform.isMobile` 门控的桌面 Edge 引擎持有；`isDesktopOnly` 保持 `false`，发布自检以白名单守护，禁止出现 `fs` / `child_process` / `electron`。不为消除告警牺牲双端一致。

## 1.0.8 — 2026-11-19

修复 1.0.7 的 Piper 本地语音引擎在 Obsidian 内无法完成合成的问题。数据格式不变，无需迁移。

### 修复

- **音素转换器按浏览器环境加载**：`piper_phonemize.js` 是 Emscripten 的通用产物，会按运行环境二选一。Obsidian 渲染进程同时满足 `ENVIRONMENT_IS_WEB` 与 `ENVIRONMENT_IS_NODE`（Electron 带 Node 集成），此前它走 Node 分支用 `fs.readFileSync` 读取插件给的 blob 地址，直接报 `ENOENT`。现在在模块作用域内遮蔽 `process`，强制走浏览器分支用 `fetch` 读取。
- **音素模块导出形态**：该产物只有 CommonJS 的 `module.exports`，以 ESM 载入时 `module` / `exports` / `define` 均不存在，三个分支都不命中，模块导出为空。现在在脚本尾部补 `export default`，把顶层 `createPiperPhonemize` 暴露为默认导出。
- **ONNX Runtime 1.30 的加载方式**：1.30 的 WASM 后端由「加载器 `.mjs` + 二进制 `.wasm」两部分组成，且 `wasmPaths` 改为 `{ mjs, wasm }` 对象形态（旧版的按文件映射已不再支持）。此前用旧形态 + 未成对的文件组合，会报 `Failed to resolve module specifier` 与 `LinkError: function import requires a callable`。现在加载器与二进制成对注入 blob 地址。
- 资源准备脚本 `npm run piper:setup` 相应补齐 `ort-wasm-simd-threaded.mjs`，并移除不再需要的 jsep 变体。

### 实测（Windows / Obsidian 1.15.1 桌面）

- Piper 引擎就绪，音色 `zh_CN-huayan-medium / zh-CN`；音素转换 108ms，合成实时率约 0.44（快于实时）。
- 合成产物为可播放的 WAV blob，`<audio>` 就绪后 75ms 出声，状态机、分块推进、进度条拖动、暂停/继续、停止存断点均正常。

## 1.0.7 — 2026-11-19

功能增强版（合并 1.0.6 + 1.0.7 全部改动发布）。数据格式向后兼容：设置新增 `speechEngine` / `piperModelDir` / `piperVoiceId`，旧 `data.json` 自动归一化到系统语音，不改变朗读断点。

### 新增与变更

- **Piper 本地语音引擎**：新增 `src/speech/piperEngine.ts`，从库内目录读取 Piper 中文模型（zh_CN-huayan-medium，约 61MB）、音素 WASM 与 ONNX Runtime WASM，浏览器内完成音素转换与 VITS 推理，输出 WAV 交给 `<audio>` 播放。运行期零网络、无需密钥，桌面与手机共用。
- **朗读引擎可切换**：设置页新增「朗读引擎」「Piper 模型目录」「重新检测」。Piper 未就绪或朗读出错时自动回退系统语音；系统语音仍为零配置默认项。
- **一次性资源准备脚本**：`npm run piper:setup -- <vault 路径>` 写入 `知识管理工作台/tts/`，模型不打进插件包；README 补充双端说明。
- 保持 1.0.6 的催办/待办、统计页、批量标签、导出目录等全部功能；`minAppVersion` 仍为 1.7.2。

## 1.0.6 — 2026-11-18

功能增强版（其改动已并入 1.0.7 一并发布）。数据格式向后兼容：frontmatter 新增可选 `follow-up`/`follow-up-every`，index.json 新增可选 `tasks`/`taskDay`，旧数据无需迁移。

### 新增与变更

- **「过时提醒」改为任务级「催办 / 待办」**：不再按笔记 updated 判定，改为解析正文未完成的 `- [ ]` 任务。支持 `@due(YYYY-MM-DD)`（一次性）、`@every(7d|weekly|每月…)`（循环）与中文周期词自动推断（可关闭）；循环任务按笔记日期推进到最近周期点。下次到期早于今天＝催办，否则＝待办；无日期任务只显示不进日历。逾期/到期/复习三类判定不变。
- **.ics 文案**：任务催办/待办分别显示「催办 · 任务」「待办 · 任务」；任务行号纳入 uid 避免同篇多任务覆盖；无日期待办不生成日程。笔记级逾期/今日到期文案保持原样。
- **输入闭环**：接通此前零调用的 `startReview()`（命令「为当前笔记开始复习」）；新增 due/review 设为今天/明天四条命令；今日清单每行就地「完成」按钮（逾期/到期写 status，复习推进排期，催办/待办勾选正文任务行）。
- **批量重命名 / 合并标签**：统计页标签卡「管理标签」入口与设置页入口；预览影响篇数、二次确认、分批写入；默认只改 frontmatter.tags，正文内联 #标签为默认关闭的高风险可选项。
- **导出笔记目录**：按主分类生成 Markdown 目录写入 `知识管理工作台/笔记目录.md`，含 wiki 链接、标签、日期与摘要。
- **统计页**：调试指标（本次耗时/主线程让出/待补元数据）收进默认折叠的「运行信息」；底部四个维护按钮移到设置页；「全量分类」改名「主分类总览（每篇只归一类）」并加口径说明；标签卡加管理入口。
- **设置页**：重排为「每天用 / 索引与备份 / .ics 提醒 / 朗读 / 导出 / 关于」并加「快速上手 3 步」；「过时阈值」改名「催办默认周期」（默认 90→30，旧值 90 自动迁移）；新增「自动识别任务周期词」开关；云端朗读说明移入「关于」（代码与字段未清理）。
- **低风险 warning 修复**：删除未使用的 `builtin-modules` 依赖；硬编码 `.obsidian/` 改用 `vault.configDir`；删除多余类型断言。
- **保持不变**：minAppVersion 1.7.2；云端 TTS 相关代码与字段原样保留；页签、卡片数量与横向条形算法不变；零网络、零运行时依赖。

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
