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
      text: "纯本地 vault 数据：零后端、零网络请求，桌面与手机端行为一致。点击每项右侧的 (i) 查看说明。",
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
      "主分类按标签的第一段或笔记所在的第一层文件夹。逐篇统计始终不设上限；只有柱状图取 Top 10，长尾归入「其他」。",
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
      "用系统自带的语音合成朗读笔记，语速范围 0.5–3，默认 1。改动会立即作用于正在朗读的当前分块，并随插件数据持久化。",
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
      speechSnapshot.supported
        ? "当前设备支持系统语音合成。手机端若无声音会自动降级并给出中文提示。"
        : "当前设备不支持朗读，可在桌面端使用；原文窗口会隐藏朗读按钮并给出提示。",
    );
    addInfo(
      speechState,
      "朗读在笔记原文窗口顶部控制：朗读 / 暂停 / 停止 / 可拖动进度条，关闭窗口自动保存断点。插件卸载或禁用时会 cancel 语音并清除全部定时器。手机端朗读可能不可用。",
    );

    containerEl.createDiv({
      cls: "kw-ver",
      text: `知识管理工作台 v${plugin.manifest.version} · 纯本地 vault 数据`,
    });
  }
}
