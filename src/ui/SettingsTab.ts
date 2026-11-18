import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type KnowledgeWorkbenchPlugin from "../main";

/** 功能名 + 控件 + (i) 折叠说明；说明默认隐藏，点 (i) 才展开。 */
function addInfo(setting: Setting, text: string): void {
  const button = setting.infoEl.createEl("button", {
    cls: "kw-info-btn",
    text: "i",
  });
  button.setAttr("type", "button");
  button.setAttr("aria-label", "查看该项说明");
  button.setAttr("aria-expanded", "false");
  const panel = setting.settingEl.createDiv({ cls: "kw-info-panel", text });
  panel.setAttr("hidden", "true");
  button.addEventListener("click", () => {
    const open = !panel.classList.contains("is-open");
    panel.classList.toggle("is-open", open);
    if (open) panel.removeAttribute("hidden");
    else panel.setAttr("hidden", "true");
    button.setAttr("aria-expanded", String(open));
  });
}

export class WorkbenchSettingTab extends PluginSettingTab {
  private readonly plugin: KnowledgeWorkbenchPlugin;

  constructor(app: App, plugin: KnowledgeWorkbenchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const plugin = this.plugin;
    const settings = plugin.store.settings;
    containerEl.empty();

    // v1.0.6：顶部改为简短定位 + 快速上手，减少「要素养才能用」的门槛。
    containerEl.createDiv({
      cls: "kw-settings-intro",
      text: "纯本地 vault 数据：零后端、零网络请求，桌面与手机端一致。点每项右侧的 (i) 看详细说明。",
    });
    const quick = containerEl.createDiv({ cls: "kw-quickstart" });
    quick.createDiv({ cls: "kw-quickstart-title", text: "快速上手 3 步" });
    const ol = quick.createEl("ol", { cls: "kw-quickstart-list" });
    ol.createEl("li", {
      text: "给需要跟踪的笔记加 frontmatter 日期：due（到期）或 review（复习）。",
    });
    ol.createEl("li", {
      text: "在正文任务行写 @due(2026-11-30) 或 @every(每周)，即进入「催办 / 待办」与日历。",
    });
    ol.createEl("li", {
      text: "在下方把 .ics 提醒导入手机 / 桌面系统日历，关掉 Obsidian 也能收到提醒。",
    });

    // 操作结果反馈放在说明区之外，便于区分「配置说明」与「执行结果」。
    const feedback = containerEl.createDiv({ cls: "kw-settings-feedback" });
    feedback.setText("操作结果会显示在这里。");

    // ── 每天用（置顶，不加标题）──────────────────────────────
    const classify = new Setting(containerEl)
      .setName("分类维度")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("tag", "标签")
          .addOption("folder", "文件夹")
          .setValue(settings.classifyBy)
          .onChange((value) => {
            plugin.store.updateSettings({
              classifyBy: value === "folder" ? "folder" : "tag",
            });
            plugin.workbench.recompute();
            feedback.setText("分类维度已更新。");
          }),
      );
    addInfo(
      classify,
      "主分类按标签的第一段或笔记所在的第一层文件夹。逐篇统计不设上限；统计页两个已有卡片的下半部分列表每行带横向条形图，按篇数比例绘制，点名称或条形可展开该分类的笔记清单。",
    );

    const stale = new Setting(containerEl)
      .setName("催办默认周期（天）")
      .setDesc("任务只写了「每周」等周期词、没有明确日期时，用笔记日期加这个周期估算下次到期。")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(settings.staleDays))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            plugin.store.updateSettings({
              staleDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : settings.staleDays,
            });
            plugin.index.invalidateTaskCache();
            plugin.workbench.recompute();
          }),
      );
    addInfo(
      stale,
      "v1.0.6：原「过时阈值」已改为催办周期。任务行写 @due(日期) 或 @every(周期) 时以此为准；仅识别中文周期词时，用笔记 created/updated 日期加此周期的整倍数估算下次到期。修改后需重建索引才对已缓存笔记生效。",
    );

    const autoInfer = new Setting(containerEl)
      .setName("自动识别任务周期词")
      .setDesc("把「每周复盘」这类带周期词的任务自动算入催办 / 待办。")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.taskAutoInfer)
          .onChange((value) => {
            plugin.store.updateSettings({ taskAutoInfer: value });
            plugin.index.invalidateTaskCache();
            feedback.setText(value ? "已开启周期词自动识别，正在重建索引。" : "已关闭周期词自动识别。");
          }),
      );
    addInfo(
      autoInfer,
      "识别正文任务里的「每天 / 每周 / 每月 / 每季度 / 每年」及 daily / weekly / monthly 等词，按周期推断下次到期。若你的任务里这些词只是叙述而非周期，可关闭以免误报；关闭后只有 @due / @every 标记的任务进入催办 / 待办。",
    );

    const intervals = new Setting(containerEl)
      .setName("复习间隔（天，逗号分隔）")
      .addText((text) =>
        text
          .setPlaceholder("1,3,7,15,30")
          .setValue(settings.reviewIntervals.join(","))
          .onChange((value) => {
            const parsed = value
              .split(/[,，\s]+/)
              .map((part) => Number.parseInt(part, 10))
              .filter((part) => Number.isFinite(part) && part > 0);
            plugin.store.updateSettings({
              reviewIntervals: parsed.length ? parsed : settings.reviewIntervals,
            });
            plugin.workbench.recompute();
          }),
      );
    addInfo(
      intervals,
      "固定间隔排期，默认 1/3/7/15/30 天。review-stage 到顶后保持最后一档；后续可升级为 SM-2 算法。这里只保存偏好，不会自动改动笔记。",
    );

    // ── 索引与备份 ──────────────────────────────────────────
    new Setting(containerEl).setName("索引与备份").setHeading();

    const snapshot = new Setting(containerEl).setName("索引快照");
    addInfo(
      snapshot,
      `vault 内路径：${settings.indexPath}。该文件只存可重建的派生数据（笔记摘要、标签、日期字段），随你既有的同步方案跨端；损坏或版本不符时自动重建。路径在插件启动时读取，修改需要重载插件。差异只做只读提示，不提供 ZIP 恢复，也不删除任何笔记。`,
    );

    const indexOps = new Setting(containerEl)
      .setName("重建索引 / 写入快照")
      .addButton((button) =>
        button.setButtonText("重建索引").onClick(() => {
          plugin.index.rescan();
          feedback.setText("已开始分批重建索引，不阻塞界面。");
        }),
      )
      .addButton((button) =>
        button.setButtonText("写入快照").onClick(() => {
          plugin.index.writeNow();
          feedback.setText("已触发 index.json 写入。");
        }),
      );
    addInfo(
      indexOps,
      "重建会分批重新扫描全部 Markdown 文件，每批让出主线程；写入快照会把当前索引落到 vault 内的 index.json。两者都不会修改笔记正文。",
    );

    const writeSummary = new Setting(containerEl)
      .setName("允许写回摘要")
      .addToggle((toggle) =>
        toggle.setValue(settings.writeSummaryToFrontmatter).onChange((value) => {
          plugin.store.updateSettings({ writeSummaryToFrontmatter: value });
          feedback.setText(
            value ? "已允许写回摘要，仍需手动执行命令。" : "已关闭摘要写回。",
          );
        }),
      );
    addInfo(
      writeSummary,
      "默认关闭。开启后仍需手动执行「把规则摘要写入笔记 frontmatter」命令，会修改笔记的 kw-summary 字段。规则式摘要本身不改动任何笔记。",
    );

    const writeReview = new Setting(containerEl)
      .setName("允许写回复习日期")
      .addToggle((toggle) =>
        toggle.setValue(settings.writeReviewToFrontmatter).onChange((value) => {
          plugin.store.updateSettings({ writeReviewToFrontmatter: value });
          feedback.setText(
            value ? "已允许写回复习日期，仍需手动执行命令。" : "已关闭复习日期写回。",
          );
        }),
      );
    addInfo(
      writeReview,
      "默认关闭。开启后仍需手动执行「应用复习排期到 frontmatter」命令，会修改到期笔记的 review / review-stage 字段。插件不会自动给全库笔记加提醒。",
    );

    const writeOps = new Setting(containerEl)
      .setName("执行写回操作")
      .addButton((button) =>
        button.setButtonText("应用复习排期").onClick(() => {
          void plugin.applyReviewPlan();
          feedback.setText("已触发复习排期写回，结果见右上角提示。");
        }),
      )
      .addButton((button) =>
        button.setButtonText("写入摘要").onClick(() => {
          void plugin.writeSummaries();
          feedback.setText("已触发摘要写回，结果见右上角提示。");
        }),
      );
    addInfo(
      writeOps,
      "这两个操作会改动用户笔记，请先确认已备份。若对应开关未开启，命令会拒绝执行并给出提示。",
    );

    const dataNote = new Setting(containerEl).setName("数据存放说明");
    addInfo(
      dataNote,
      "业务数据写进笔记 frontmatter（tags / due / status / updated / review）；页签位置、折叠状态、浏览历史与朗读断点存于插件数据。云端表、旧版本地目录句柄与每日轮询均不再使用。",
    );

    // ── .ics 提醒 ───────────────────────────────────────────
    new Setting(containerEl).setName(".ics 提醒").setHeading();

    const icsEnabled = new Setting(containerEl)
      .setName("启用 .ics 提醒文件")
      .addToggle((toggle) =>
        toggle.setValue(settings.icsEnabled).onChange((value) => {
          plugin.store.updateSettings({ icsEnabled: value });
          plugin.workbench.recompute();
          feedback.setText(value ? "已启用 .ics。" : "已关闭 .ics。");
        }),
      );
    addInfo(
      icsEnabled,
      "把逾期、到期、催办、复习与有日期的待办任务写入 vault 内的 .ics，含提前 1 天的 VALARM；无日期的待办不进日历。插件不能常驻后台，最终提醒由系统日历触发；关闭 Obsidian 后不会推送，启动时应用内会有汇总提示。",
    );

    const icsPath = new Setting(containerEl)
      .setName(".ics 路径")
      .addText((text) =>
        text.setValue(settings.icsPath).onChange((value) => {
          plugin.store.updateSettings({ icsPath: value || settings.icsPath });
          plugin.workbench.recompute();
        }),
      );
    addInfo(
      icsPath,
      "默认是「知识管理工作台/提醒.ics」。手机端请把该文件导入或订阅到系统日历；桌面端也可用命令把内容复制到剪贴板。",
    );

    const icsOps = new Setting(containerEl)
      .setName("重建 / 复制 .ics")
      .addButton((button) =>
        button.setButtonText("重建").onClick(() => {
          plugin.workbench.rebuildIcs();
          feedback.setText("已触发 .ics 重建。");
        }),
      )
      .addButton((button) =>
        button.setButtonText("复制").onClick(() => {
          void plugin.copyIcs();
          feedback.setText("已触发复制，结果见右上角提示。");
        }),
      );
    addInfo(
      icsOps,
      "重建会立即写入 vault；复制仅在桌面剪贴板可用时生效，不可用时请直接打开 vault 内的 .ics 文件。索引或设置变化后也会自动防抖重建。",
    );

    // ── 朗读 ────────────────────────────────────────────────
    new Setting(containerEl).setName("朗读").setHeading();

    const engine = new Setting(containerEl)
      .setName("朗读引擎")
      .addDropdown((dropdown) => {
        dropdown.addOption("system", "系统语音（零配置）");
        dropdown.addOption("piper", "Piper 本地语音（需先准备模型）");
        dropdown.setValue(settings.speechEngine).onChange((value) => {
          plugin.store.updateSettings({
            speechEngine: value === "piper" ? "piper" : "system",
          });
          plugin.refreshSpeechEngine();
          feedback.setText(
            value === "piper"
              ? "已选择 Piper 本地语音；模型未就绪时会自动回退系统语音。"
              : "已切换回系统语音。",
          );
        });
      });
    addInfo(
      engine,
      "系统语音零配置但音色普通；Piper 本地语音把 61MB 中文模型放在库内，完全离线、点即读，桌面和手机都能用。Piper 未就绪或朗读出错时自动回退系统语音。",
    );

    const modelDir = new Setting(containerEl)
      .setName("Piper 模型目录")
      .addText((text) =>
        text
          .setPlaceholder("知识管理工作台/tts")
          .setValue(settings.piperModelDir)
          .onChange((value) => {
            plugin.store.updateSettings({ piperModelDir: value.trim() || "知识管理工作台/tts" });
            plugin.refreshSpeechEngine();
          }),
      )
      .addButton((button) =>
        button.setButtonText("重新检测").onClick(() => {
          plugin.refreshSpeechEngine();
          new Notice("已重新检测本地语音；结果见下方「朗读能力」。");
        }),
      );
    addInfo(
      modelDir,
      "运行 `npm run piper:setup -- <vault 路径>` 一次，把中文模型、Piper 音素 WASM 与 ONNX Runtime WASM 放进该目录。之后插件只读本地文件，不联网。默认目录：知识管理工作台/tts。",
    );

    const rate = new Setting(containerEl)
      .setName("朗读语速")
      .addText((text) =>
        text
          .setPlaceholder("1")
          .setValue(String(settings.speechRate))
          .onChange((value) => {
            const parsed = Number.parseFloat(value);
            const next = Number.isFinite(parsed) && parsed > 0 ? parsed : settings.speechRate;
            plugin.store.updateSettings({ speechRate: next });
            plugin.speech.setRate(next);
          }),
      );
    addInfo(
      rate,
      "系统语音的基准语速，范围 0.5–3，默认 1。规则式韵律会在此基础上按句群做小幅浮动；改动会立即作用于当前分块。",
    );

    const voice = new Setting(containerEl)
      .setName("中文音色优先")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.speechPreferChineseVoice)
          .onChange((value) => {
            plugin.store.updateSettings({ speechPreferChineseVoice: value });
            plugin.speech.setPreferChineseVoice(value);
          }),
      );
    addInfo(
      voice,
      "优先使用系统里的 zh-CN / zh-* 音色；系统没有中文音色时回退默认音色。朗读前会按当前音色列表重新选择。",
    );

    const autoResume = new Setting(containerEl)
      .setName("打开笔记时自动续读")
      .addToggle((toggle) =>
        toggle.setValue(settings.speechAutoResume).onChange((value) => {
          plugin.store.updateSettings({ speechAutoResume: value });
          feedback.setText(
            value ? "已开启自动续读：有断点时打开原文窗口会自动继续。" : "已关闭自动续读。",
          );
        }),
      );
    addInfo(
      autoResume,
      "默认关闭，避免打开笔记时意外发声。开启后，若该笔记有未读完的断点，原文窗口会自动接着朗读；否则一律手动点「从断点续读」。断点按笔记路径保存，重命名时会自动迁移。",
    );

    const prosody = new Setting(containerEl)
      .setName("自然韵律优化")
      .addToggle((toggle) =>
        toggle.setValue(settings.speechProsody).onChange((value) => {
          plugin.store.updateSettings({ speechProsody: value });
          plugin.speech.setProsody(value);
          feedback.setText(value ? "已开启句群分块、停顿与动态语气。" : "已关闭韵律优化，恢复逐标点分块。");
        }),
      );
    addInfo(
      prosody,
      "句群分块（不再每个逗号都断）、句末停顿、动态语速与音高、Natural / Neural 音色优选。系统语音走参数合成；Piper 本地语音为神经网络合成，韵律由模型决定，规则式 pitch 不生效。云端神经朗读已搁置。",
    );

    const pause = new Setting(containerEl)
      .setName("句间停顿上限（毫秒）")
      .addText((text) =>
        text
          .setPlaceholder("420")
          .setValue(String(settings.speechPauseMs))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            const next = Number.isFinite(parsed) && parsed >= 0 ? Math.min(1200, parsed) : settings.speechPauseMs;
            plugin.store.updateSettings({ speechPauseMs: next });
            plugin.speech.setMaxPauseMs(next);
          }),
      );
    addInfo(pause, "每个句群读完后的停顿，按标点动态调整（句号 280ms、疑问 / 感叹 340ms、省略号 420ms），不超过此处上限。设为 0 关闭停顿。");

    const voicePick = new Setting(containerEl)
      .setName("系统音色")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "自动（中文 / Natural 优先）");
        for (const voice of plugin.speech.listVoices()) {
          dropdown.addOption(voice.name, `${voice.name} · ${voice.lang}`);
        }
        dropdown.setValue(settings.speechVoiceName).onChange((value) => {
          plugin.store.updateSettings({ speechVoiceName: value });
          plugin.speech.setManualVoiceName(value);
          feedback.setText(value ? `已固定使用音色：${value}` : "已恢复自动优选音色。");
        });
      });
    addInfo(voicePick, "系统音色列表由设备提供；Android WebView 通常为空。留空时自动挑选 zh-CN 且名字含 Natural / Neural 的高质量音色。");

    const speechState = new Setting(containerEl)
      .setName("朗读能力")
      .addButton((button) =>
        button.setButtonText("停止全部朗读").onClick(() => {
          plugin.speech.stop(true);
          feedback.setText("已停止朗读并保存断点。");
        }),
      );
    const speechSnapshot = plugin.speech.getSnapshot();
    speechState.setDesc(
      `当前引擎：${speechSnapshot.engineLabel}。` +
        (speechSnapshot.supported
          ? settings.speechEngine === "piper"
            ? "Piper 本地语音已就绪，朗读完全离线。"
            : "系统语音配合规则式韵律。"
          : settings.speechEngine === "piper"
            ? "Piper 模型尚未就绪或路径不对，请先运行模型准备脚本；期间仍可用系统语音。"
            : "Android WebView 通常没有系统语音，请使用朗读稿替代路径交给系统朗读。"),
    );
    addInfo(
      speechState,
      "朗读在笔记原文窗口顶部控制：朗读 / 暂停 / 停止 / 可拖动进度条，关闭窗口自动保存断点。设备无语音时窗口会提供「复制朗读稿」「保存朗读稿到库内」，可交给系统「随选朗读」。插件卸载或禁用时会 cancel 语音并清除全部定时器。",
    );

    // ── 导出 ────────────────────────────────────────────────
    new Setting(containerEl).setName("导出").setHeading();
    const exportCatalog = new Setting(containerEl)
      .setName("导出笔记目录")
      .setDesc("把所有已索引笔记按主分类生成一份 Markdown 目录，写入 vault。")
      .addButton((button) =>
        button.setButtonText("导出到 vault").onClick(() => {
          void plugin.exportCatalog();
          feedback.setText("已触发笔记目录导出，结果见右上角提示。");
        }),
      );
    addInfo(
      exportCatalog,
      "生成「知识管理工作台/笔记目录.md」：按标签或文件夹（跟随当前分类维度）分组，每条含标题（可点开原文）、标签、日期与摘要。这是可重建的派生文件，每次导出覆盖旧文件，不会改动任何笔记。",
    );

    const manageTags = new Setting(containerEl)
      .setName("批量管理标签")
      .setDesc("重命名或合并标签，一次改掉所有相关笔记。")
      .addButton((button) =>
        button.setButtonText("打开管理器").onClick(() => {
          plugin.openTagManager();
        }),
      );
    addInfo(
      manageTags,
      "选择源标签（可多选做合并）与目标名称，先预览影响篇数，二次确认后分批写入。默认只改 frontmatter.tags，不碰正文内联 #标签；层级标签可选是否一并处理。",
    );

    // ── 关于 ────────────────────────────────────────────────
    new Setting(containerEl).setName("关于").setHeading();
    const about = new Setting(containerEl).setName("数据与隐私");
    about.setDesc(
      "纯本地：零后端、零网络请求，笔记与提醒都留在你的 vault。v1.0.2 起云端神经朗读已搁置，插件不向任何服务发送笔记或朗读文本；朗读只走系统语音 + 规则式韵律。",
    );
    addInfo(
      about,
      "真人级神经网络语音需要自有 TTS 服务地址与密钥，当前没有可用服务，已从运行时移除。底层适配层保留在源码中，日后有服务可重新接线。Android WebView 通常无系统语音，请用原文窗口的「复制 / 保存朗读稿」交给系统「随选朗读」。",
    );

    containerEl.createDiv({
      cls: "kw-ver",
      text: `知识管理工作台 v${plugin.manifest.version} · 零网络请求`,
    });
  }
}
