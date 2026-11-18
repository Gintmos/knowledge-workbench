import { Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { renderCatalog } from "./domain/catalog";
import { previewTagEdit } from "./domain/tagEdit";
import { startReview } from "./domain/ReviewService";
import { FrontmatterService } from "./data/FrontmatterService";
import { SpeechService } from "./data/SpeechService";
import { StoreService } from "./data/StoreService";
import { VaultIndexService } from "./data/VaultIndexService";
import { WorkbenchService } from "./data/WorkbenchService";
import { planReview } from "./domain/ReviewService";
import { addDays, todayString } from "./domain/TaskService";
import { TAB_LABELS, TAB_ORDER } from "./domain/uiModel";
import { createDomSpeechEngine } from "./speech/engine";
import { createPiperEngine } from "./speech/piperEngine";
import type { SpeechEngine } from "./speech/types";
import { NoteModal } from "./ui/NoteModal";
import { TagManagerModal } from "./ui/TagManagerModal";
import { WorkbenchView } from "./ui/WorkbenchView";
import { WorkbenchSettingTab } from "./ui/SettingsTab";
import type { PluginData, WorkbenchTab } from "./types";
import { VIEW_TYPE_WORKBENCH } from "./types";

export default class KnowledgeWorkbenchPlugin extends Plugin {
  store!: StoreService;
  index!: VaultIndexService;
  workbench!: WorkbenchService;
  frontmatter!: FrontmatterService;
  speech!: SpeechService;
  private piperEngine: SpeechEngine | null = null;
  private unsubscribeStatus?: () => void;
  private unsubscribeStartup?: () => void;
  private startupNoticeShown = false;

  get data(): PluginData {
    return this.store.snapshot;
  }

  async onload(): Promise<void> {
    this.store = await StoreService.create({
      load: () => this.loadData(),
      save: (data) => this.saveData(data),
    });

    this.index = new VaultIndexService(this.app, {
      indexPath: this.store.settings.indexPath,
      // 官方规范：宿主事件交给 Plugin 的 registerEvent() 统一登记与卸载。
      owner: this,
      onRename: (oldPath, newPath, newTitle) =>
        this.store.renamePath(oldPath, newPath, newTitle),
      taskAutoInfer: () => this.store.settings.taskAutoInfer,
    });
    this.frontmatter = new FrontmatterService(this.app);
    this.workbench = new WorkbenchService(this.app, this.store, this.index, {
      mobile: Platform.isMobile,
    });
    // v1.0.2：云端神经 TTS 暂时搁置（没有可用的自有服务地址），运行时不接线。
    // 朗读只走系统语音 + 规则式韵律（方案 A），Android 无语音时用朗读稿替代路径。
    // 适配层 src/speech/cloud.ts 保留在源码中但未导入，产物 main.js 不含任何联网入口。
    const domEngine = createDomSpeechEngine(() => this.speech?.onVoicesChanged());
    this.piperEngine = createPiperEngine({
      hostApp: this.app,
      getModelDir: () => this.store.settings.piperModelDir,
      getVoiceId: () => this.store.settings.piperVoiceId,
      isEnabled: () => this.store.settings.speechEngine === "piper",
      onReadyChange: () => this.speech?.onVoicesChanged(),
    });
    this.speech = new SpeechService({
      engine: domEngine,
      // 1.0.7：Piper 作为首选引擎；未启用 / 加载失败自动回退系统语音。
      preferredEngine: this.piperEngine,
      mobile: Platform.isMobile,
      rate: this.store.settings.speechRate,
      preferChineseVoice: this.store.settings.speechPreferChineseVoice,
      manualVoiceName: this.store.settings.speechVoiceName,
      prosody: this.store.settings.speechProsody,
      maxPauseMs: this.store.settings.speechPauseMs,
      progress: {
        get: (path) => this.store.getReadProgress(path),
        set: (path, value) => this.store.setReadProgress(path, value),
      },
    });

    this.registerView(
      VIEW_TYPE_WORKBENCH,
      (leaf: WorkspaceLeaf) => new WorkbenchView(leaf, this),
    );

    this.addRibbonIcon("book-open", "打开知识管理工作台", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-workbench",
      name: "打开知识管理工作台",
      callback: () => {
        void this.activateView();
      },
    });

    // 四个页签各有一个命令，视图已打开时直接切换。
    for (const tab of TAB_ORDER) {
      this.addCommand({
        id: `open-workbench-${tab}`,
        name: `打开工作台 · ${TAB_LABELS[tab]}`,
        callback: () => {
          void this.activateView(tab);
        },
      });
    }

    this.addCommand({
      id: "rebuild-index",
      name: "重建知识索引",
      callback: () => this.index.rescan(),
    });

    this.addCommand({
      id: "write-index-snapshot",
      name: "立即写入 index.json 快照",
      callback: () => this.index.writeNow(),
    });

    this.addCommand({
      id: "rebuild-ics",
      name: "重建 .ics 提醒文件",
      callback: () => this.workbench.rebuildIcs(),
    });

    this.addCommand({
      id: "copy-ics",
      name: "复制 .ics 内容到剪贴板",
      callback: () => {
        void this.copyIcs();
      },
    });

    this.addCommand({
      id: "apply-review-plan",
      name: "应用复习排期到 frontmatter（会修改笔记）",
      callback: () => {
        void this.applyReviewPlan();
      },
    });

    this.addCommand({
      id: "write-summaries",
      name: "把规则摘要写入笔记 frontmatter（会修改笔记）",
      callback: () => {
        void this.writeSummaries();
      },
    });

    this.addCommand({
      id: "read-current-note",
      name: "朗读当前笔记",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
          new Notice("请先打开一篇 Markdown 笔记，再执行朗读。");
          return;
        }
        new NoteModal(this.app, file, {
          speech: this.speech,
          autoPlay: true,
          onExport: (title, text) => void this.saveSpeechDraft(title, text),
        }).open();
      },
    });

    this.addCommand({
      id: "toggle-speech",
      name: "播放 / 暂停朗读",
      callback: () => {
        if (!this.speech.getSnapshot().path) {
          new Notice("请先在笔记原文窗口启动朗读。");
          return;
        }
        this.speech.toggle();
      },
    });

    this.addCommand({
      id: "stop-speech",
      name: "停止朗读并保存断点",
      callback: () => this.speech.stop(true),
    });

    // ── v1.0.6：输入闭环与批量操作 ──────────────────────────
    this.addCommand({
      id: "start-review-current",
      name: "为当前笔记开始复习",
      callback: () => void this.startReviewCurrent(),
    });
    this.addCommand({
      id: "set-due-today",
      name: "设为今天到期（当前笔记）",
      callback: () => void this.setCurrentDate("due", 0),
    });
    this.addCommand({
      id: "set-due-tomorrow",
      name: "设为明天到期（当前笔记）",
      callback: () => void this.setCurrentDate("due", 1),
    });
    this.addCommand({
      id: "set-review-today",
      name: "设为今天复习（当前笔记）",
      callback: () => void this.setCurrentDate("review", 0),
    });
    this.addCommand({
      id: "set-review-tomorrow",
      name: "设为明天复习（当前笔记）",
      callback: () => void this.setCurrentDate("review", 1),
    });
    this.addCommand({
      id: "manage-tags",
      name: "批量重命名 / 合并标签",
      callback: () => this.openTagManager(),
    });
    this.addCommand({
      id: "export-catalog",
      name: "导出笔记目录到 vault",
      callback: () => void this.exportCatalog(),
    });

    this.addSettingTab(new WorkbenchSettingTab(this.app, this));

    // 浏览历史由宿主的 file-open 自动采集，替代旧版手动记录。
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.store.addHistory(file.path, file.basename);
          this.speech.onActiveFileChanged(file.path);
        }
      }),
    );

    const status = this.addStatusBarItem();
    status.classList.add("kw-status");
    this.unsubscribeStatus = this.index.subscribe((state) => {
      if (state.phase === "scanning") {
        status.setText(`索引进度 ${state.indexed}/${state.total}`);
      } else if (state.phase === "error") {
        status.setText("索引异常，请查看工作台");
      } else if (state.phase === "ready") {
        status.setText(
          `索引 ${state.indexed} 篇 · 今日 ${this.workbench.getSnapshot().today.total} 项`,
        );
      } else {
        status.setText("索引待启动");
      }
    });

    this.workbench.start();
    // 后台推送的应用内替代：索引就绪且领域快照重算后，只弹一次今日汇总。
    this.unsubscribeStartup = this.workbench.subscribe((snapshot) => {
      if (this.startupNoticeShown || this.index.getStatus().phase !== "ready") {
        return;
      }
      this.startupNoticeShown = true;
      const parts: string[] = [];
      if (snapshot.today.overdue.length) {
        parts.push(`逾期 ${snapshot.today.overdue.length} 项`);
      }
      if (snapshot.today.due.length) {
        parts.push(`今日到期 ${snapshot.today.due.length} 项`);
      }
      if (snapshot.today.followup.length) {
        parts.push(`催办 ${snapshot.today.followup.length} 项`);
      }
      if (snapshot.today.review.length) {
        parts.push(`复习到期 ${snapshot.today.review.length} 项`);
      }
      if (snapshot.today.todo.length) {
        parts.push(`待办 ${snapshot.today.todo.length} 项`);
      }
      new Notice(
        parts.length
          ? `知识管理工作台：${parts.join("、")}。详情见工作台「今日」。`
          : "知识管理工作台：今日没有待处理事项。",
        6000,
      );
    });
    this.index.start();
  }

  async activateView(tab: WorkbenchTab = "today"): Promise<void> {
    this.store.patchView({ tab, scrollY: 0 });
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH);
    if (existing.length > 0) {
      const view = existing[0].view;
      if (view instanceof WorkbenchView) view.setActiveTab(tab);
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_WORKBENCH, active: true });
    await workspace.revealLeaf(leaf);
  }

  async copyIcs(): Promise<void> {
    const text = this.workbench.getIcsText();
    if (!text) {
      new Notice("尚未生成 .ics，请先执行「重建 .ics 提醒文件」");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      new Notice("已复制 .ics 内容，可粘贴或保存为日历文件");
    } catch {
      new Notice("当前设备不支持剪贴板，请直接在 vault 中打开 .ics 文件");
    }
  }

  /**
   * Android 无系统语音时的替代路径：把清洗后的朗读稿写成普通笔记，
   * 用户可用系统「随选朗读 / 选择即朗读」发声。仅在用户点按钮时写。
   */
  async saveSpeechDraft(title: string, text: string): Promise<void> {
    const safe = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "朗读稿";
    const folder = "知识管理工作台/朗读稿";
    const target = `${folder}/${safe}.md`;
    const body = `> 由知识管理工作台生成，供系统朗读使用。\n\n${text}\n`;
    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const existing = this.app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) await this.app.vault.modify(existing, body);
      else await this.app.vault.create(target, body);
      new Notice(`朗读稿已保存：${target}`);
    } catch (error) {
      console.error("[knowledge-workbench] save speech draft failed", error);
      new Notice("朗读稿保存失败，请改用「复制朗读稿」。");
    }
  }

  /** 写回用户笔记需「设置开关 + 主动执行命令」双重确认，默认关闭。 */
  async applyReviewPlan(): Promise<void> {
    if (!this.store.settings.writeReviewToFrontmatter) {
      new Notice("请先在设置中开启「写回复习日期到 frontmatter」");
      return;
    }
    const plan = planReview(
      this.index.getNotes(),
      todayString(),
      this.store.settings.reviewIntervals,
    );
    let written = 0;
    for (const item of plan) {
      const file = this.frontmatter.findFile(item.path);
      if (!file) continue;
      try {
        await this.frontmatter.writeReview(file, item.nextDate, item.nextStage);
        written += 1;
      } catch (error) {
        console.error("[knowledge-workbench] write review failed", error);
      }
    }
    new Notice(`已更新 ${written}/${plan.length} 篇笔记的复习日期`);
  }

  async writeSummaries(): Promise<void> {
    if (!this.store.settings.writeSummaryToFrontmatter) {
      new Notice("请先在设置中开启「写回摘要到 frontmatter」");
      return;
    }
    const notes = this.index.getNotes().filter((note) => note.summary);
    let written = 0;
    for (const note of notes) {
      const file = this.frontmatter.findFile(note.path);
      if (!file) continue;
      try {
        await this.frontmatter.writeSummary(file, note.summary);
        written += 1;
      } catch (error) {
        console.error("[knowledge-workbench] write summary failed", error);
      }
    }
    new Notice(`已把摘要写入 ${written}/${notes.length} 篇笔记的 kw-summary 字段`);
  }

  // ── v1.0.6：输入闭环 ─────────────────────────────────────
  /** 接通此前零调用的 startReview()：为当前笔记建立首次复习计划。 */
  async startReviewCurrent(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("请先打开一篇 Markdown 笔记。");
      return;
    }
    const note = this.index.getNote(file.path);
    if (!note) {
      new Notice("该笔记尚未进入索引，请稍候重试。");
      return;
    }
    const plan = startReview(
      note,
      todayString(),
      this.store.settings.reviewIntervals,
    );
    try {
      await this.frontmatter.writeReview(file, plan.nextDate, plan.nextStage);
      new Notice(`已为「${note.title}」安排首次复习：${plan.nextDate}`);
    } catch (error) {
      console.error("[knowledge-workbench] start review failed", error);
      new Notice("写入复习日期失败，请查看控制台。");
    }
  }

  /** due / review 快捷设置：today + offset 天。 */
  async setCurrentDate(key: "due" | "review", offset: number): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("请先打开一篇 Markdown 笔记。");
      return;
    }
    const value = addDays(todayString(), offset);
    try {
      await this.frontmatter.writeDateField(file, key, value);
      new Notice(`已把${key === "due" ? "到期" : "复习"}日期设为 ${value}`);
    } catch (error) {
      console.error("[knowledge-workbench] set date failed", error);
      new Notice("写入日期失败，请查看控制台。");
    }
  }

  /**
   * 今日清单就地处理。单篇、用户主动点击即确认（不依赖批量写回开关）。
   * 逾期/到期 → status: done；复习 → 推进下一轮；
   * 催办/待办 → 勾选正文对应任务行为 [x]。
   */
  async resolveTodayItem(
    path: string,
    kind: "overdue" | "due" | "review" | "followup" | "todo",
    taskLine?: number,
  ): Promise<void> {
    const file = this.frontmatter.findFile(path);
    if (!file) {
      new Notice("找不到原文文件。");
      return;
    }
    try {
      if (kind === "overdue" || kind === "due") {
        await this.frontmatter.writeStatus(file, "done");
        new Notice("已标记完成（status: done）。");
      } else if (kind === "review") {
        const note = this.index.getNote(path);
        const stage = note?.reviewStage ?? 0;
        const next = planReview(
          note ? [note] : [],
          todayString(),
          this.store.settings.reviewIntervals,
        );
        const nextDate = next.length
          ? next[0].nextDate
          : addDays(todayString(), this.store.settings.reviewIntervals[0] ?? 1);
        await this.frontmatter.writeReview(file, nextDate, Math.min(stage + 1, Math.max(0, this.store.settings.reviewIntervals.length - 1)));
        new Notice(`复习已推进，下次 ${nextDate}。`);
      } else if (typeof taskLine === "number") {
        await this.toggleTaskLine(file, taskLine);
        new Notice("已在原文勾选该任务。");
      } else {
        new Notice("该任务缺少行号，请在原文中勾选。");
        return;
      }
      this.workbench.recompute();
    } catch (error) {
      console.error("[knowledge-workbench] resolve item failed", error);
      new Notice("操作失败，请查看控制台。");
    }
  }

  /** 把正文第 line 行的 - [ ] 改为 - [x]（仅改这一行）。 */
  private async toggleTaskLine(file: TFile, line: number): Promise<void> {
    const text = await this.app.vault.read(file);
    const lines = text.split(/\r?\n/);
    if (line < 0 || line >= lines.length) {
      new Notice("任务行号已变化，请在原文中勾选。");
      return;
    }
    const updated = lines[line].replace(/^(\s*[-*+]\s+\[)([ xX])(\])/, "$1x$3");
    if (updated === lines[line]) {
      new Notice("该行不是未完成的任务，请在原文中确认。");
      return;
    }
    lines[line] = updated;
    await this.app.vault.modify(file, lines.join("\n"));
  }

  // ── v1.0.6：批量标签 ─────────────────────────────────────
  openTagManager(initialTag?: string): void {
    new TagManagerModal(this.app, {
      notes: () => this.index.getNotes(),
      initialTag,
      onExecute: (sources, target, includeChildren, replaceInline) =>
        this.executeTagEdit(sources, target, includeChildren, replaceInline),
    }).open();
  }

  private async executeTagEdit(
    sources: string[],
    target: string,
    includeChildren: boolean,
    replaceInline: boolean,
  ): Promise<void> {
    const preview = previewTagEdit(
      this.index.getNotes(),
      sources,
      target,
      includeChildren,
    );
    const wanted = new Set(preview.paths);
    let written = 0;
    let inlineFailed = 0;
    for (const path of preview.paths) {
      const file = this.frontmatter.findFile(path);
      if (!file) continue;
      try {
        await this.frontmatter.rewriteTags(file, sources, target, includeChildren);
        if (replaceInline) {
          const ok = await this.replaceInlineTags(file, sources, target, includeChildren);
          if (!ok) inlineFailed += 1;
        }
        written += 1;
      } catch (error) {
        console.error("[knowledge-workbench] rewrite tags failed", error);
      }
    }
    new Notice(
      `已更新 ${written}/${wanted.size} 篇笔记的标签${inlineFailed ? `，${inlineFailed} 篇正文内联替换失败` : ""}。`,
    );
    this.index.rescan();
  }

  /** 正文内联 #tag 替换：跳过 frontmatter 区与代码块，按整词边界替换。 */
  private async replaceInlineTags(
    file: TFile,
    sources: string[],
    target: string,
    includeChildren: boolean,
  ): Promise<boolean> {
    try {
      const text = await this.app.vault.read(file);
      const lines = text.split(/\r?\n/);
      let inFrontmatter = false;
      let inFence = false;
      let fmCount = 0;
      const sourceLower = sources.map((s) => s.replace(/^#/, "").toLowerCase());
      const changed = lines.map((raw) => {
        if (fmCount < 2) {
          fmCount += 1;
          if (raw.trim() === "---") inFrontmatter = !inFrontmatter;
          return raw;
        }
        if (/^\s*(```|~~~)/.test(raw)) {
          inFence = !inFence;
          return raw;
        }
        if (inFrontmatter || inFence) return raw;
        return raw.replace(/#([\w\u4e00-\u9fa5/-]+)/g, (full, tagText: string) => {
          const key = tagText.toLowerCase();
          const hit =
            sourceLower.includes(key) ||
            (includeChildren && sourceLower.some((s) => key.startsWith(`${s}/`)));
          if (!hit) return full;
          const suffix = includeChildren && key.includes("/")
            ? `/${key.slice(key.indexOf("/") + 1)}`
            : "";
          return `#${target}${suffix}`;
        });
      });
      if (changed.join("\n") !== text) {
        await this.app.vault.modify(file, changed.join("\n"));
      }
      return true;
    } catch (error) {
      console.error("[knowledge-workbench] inline tag replace failed", error);
      return false;
    }
  }

  // ── v1.0.6：导出目录 ─────────────────────────────────────
  async exportCatalog(): Promise<void> {
    const notes = this.index.getNotes();
    if (!notes.length) {
      new Notice("尚无已索引的笔记。");
      return;
    }
    const text = renderCatalog(notes, this.store.settings.classifyBy);
    const folder = "知识管理工作台";
    const target = `${folder}/笔记目录.md`;
    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const existing = this.app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) await this.app.vault.modify(existing, text);
      else await this.app.vault.create(target, text);
      new Notice(`笔记目录已导出：${target}（${notes.length} 篇）`);
    } catch (error) {
      console.error("[knowledge-workbench] export catalog failed", error);
      new Notice("导出目录失败，请查看控制台。");
    }
  }

  /** 设置页改变朗读引擎路径后调用：重新探测可选引擎并刷新界面。 */
  refreshSpeechEngine(): void {
    this.piperEngine?.prepare?.();
    this.speech.refreshPreferred();
    this.speech.refreshCloud();
  }

  onunload(): void {
    // 先 cancel 语音，避免禁用插件后仍有声音或定时器残留。
    this.speech.dispose();
    this.unsubscribeStatus?.();
    this.unsubscribeStartup?.();
    this.workbench.dispose();
    // 最后一次落盘：先启动快照写入，再清理事件与定时器。
    this.index.writeNow();
    void this.store.flush().then(
      () => this.store.dispose(),
      () => this.store.dispose(),
    );
    this.index.dispose();
  }
}
