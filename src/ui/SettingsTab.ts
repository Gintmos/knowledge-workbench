import { App, PluginSettingTab, Setting } from "obsidian";
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

    // 官方规范：设置页顶部不放插件名 /「常规」「设置」这类顶层标题；
    // 常规项直接置顶、不加 heading，后续分组才用 setHeading() 且标题不含「设置」。
    containerEl.createDiv({
      cls: "kw-settings-intro",
      text: "纯本地 vault 数据：零后端、零网络请求，桌面与手机端行为一致；云端神经朗读已搁置，插件不向任何服务发送笔记或朗读文本。点击每项右侧的 (i) 查看说明。",
    });

    // 操作结果反馈放在说明区之外，便于区分「配置说明」与「执行结果」。
    const feedback = containerEl.createDiv({ cls: "kw-settings-feedback" });
    feedback.setText("操作结果会显示在这里。");

    // ── 常规（置顶，不加标题）────────────────────────────────
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
      .setName("过时提醒阈值（天）")
      .addText((text) =>
        text
          .setPlaceholder("90")
          .setValue(String(settings.staleDays))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            plugin.store.updateSettings({
              staleDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : settings.staleDays,
            });
            plugin.workbench.recompute();
          }),
      );
    addInfo(
      stale,
      "笔记 frontmatter 的 updated 字段距今天数超过阈值时列入「过时提醒」；updated 缺失时回退到文件最后修改时间。设为 0 表示只要不是今天更新就提醒。",
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
      "把待办、复习与过时项写入 vault 内的 .ics，含提前 1 天的 VALARM。插件不能常驻后台，最终提醒由系统日历触发；关闭 Obsidian 后不会推送，启动时应用内会有汇总提示。",
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

    // v1.0.2：没有可用的自有神经语音服务，云端朗读暂时搁置。
    // 运行时不再接线、设置页不再提供无法使用的地址/密钥输入框。
    const shelved = new Setting(containerEl).setName("真人级语气（已搁置）");
    shelved.setDesc(
      "真人级神经网络语音需要你自有的 TTS 服务地址与密钥。当前没有可用服务，云端朗读已从运行时移除，插件不发起任何网络请求。",
    );
    addInfo(
      shelved,
      "当前朗读只走系统语音 + 规则式韵律（方案 A）：句群分块、句末停顿、动态语速与音高、Natural / Neural 音色优选。Android WebView 通常没有系统语音，请用原文窗口的「复制朗读稿」「保存朗读稿到库内」，再交给系统「随选朗读 / 选择即朗读」发声。底层适配层保留在源码中，日后有服务时可重新接线，不影响当前版本。",
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
      "方案 A：句群分块（不再每个逗号都断）、句末停顿、动态语速与音高、Natural / Neural 音色优选。系统级参数合成能明显改善断句与节奏，但达不到神经网络 TTS 的真人语气；后者已搁置，需要自有服务才能启用。",
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
          ? "系统语音配合规则式韵律（方案 A）。"
          : "Android WebView 通常没有系统语音，请使用朗读稿替代路径交给系统朗读。"),
    );
    addInfo(
      speechState,
      "朗读在笔记原文窗口顶部控制：朗读 / 暂停 / 停止 / 可拖动进度条，关闭窗口自动保存断点。设备无语音时窗口会提供「复制朗读稿」「保存朗读稿到库内」，可交给系统「随选朗读」。插件卸载或禁用时会 cancel 语音并清除全部定时器。",
    );

    containerEl.createDiv({
      cls: "kw-ver",
      text: `知识管理工作台 v${plugin.manifest.version} · 零网络请求 · 云端神经朗读已搁置`,
    });
  }
}
