import { Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { FrontmatterService } from "./data/FrontmatterService";
import { SpeechService } from "./data/SpeechService";
import { StoreService } from "./data/StoreService";
import { VaultIndexService } from "./data/VaultIndexService";
import { WorkbenchService } from "./data/WorkbenchService";
import { planReview } from "./domain/ReviewService";
import { todayString } from "./domain/TaskService";
import { TAB_LABELS, TAB_ORDER } from "./domain/uiModel";
import { createDomSpeechEngine } from "./speech/engine";
import { NoteModal } from "./ui/NoteModal";
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
    });
    this.frontmatter = new FrontmatterService(this.app);
    this.workbench = new WorkbenchService(this.app, this.store, this.index, {
      mobile: Platform.isMobile,
    });
    // P5：引擎可注入，生产用宿主 Web Speech；断点直接写入 PluginData.read[path]。
    this.speech = new SpeechService({
      engine: createDomSpeechEngine(),
      mobile: Platform.isMobile,
      rate: this.store.settings.speechRate,
      preferChineseVoice: this.store.settings.speechPreferChineseVoice,
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
      if (snapshot.today.review.length) {
        parts.push(`复习到期 ${snapshot.today.review.length} 项`);
      }
      if (snapshot.today.stale.length) {
        parts.push(`过时提醒 ${snapshot.today.stale.length} 项`);
      }
      new Notice(
        parts.length
          ? `知识管理工作台：${parts.join("、")}。详情见工作台「今日要处理」。`
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
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_WORKBENCH, active: true });
    workspace.revealLeaf(leaf);
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
