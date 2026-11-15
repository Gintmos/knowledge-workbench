import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type KnowledgeWorkbenchPlugin from "../main";
import { describeDiff, isEmptyDiff } from "../domain/indexDiff";
import { planReview } from "../domain/ReviewService";
import { todayString } from "../domain/TaskService";
import {
  KIND_LABEL,
  TAB_LABELS,
  TAB_ORDER,
  filterPaths,
  groupToday,
  lazyPage,
  nextLoaded,
  readCategory,
  restoreViewState,
  shouldLoadMore,
  todayCardTitle,
  writeCategory,
} from "../domain/uiModel";
import { CHART_LIMIT, VIEW_TYPE_WORKBENCH } from "../types";
import type {
  DomainSnapshot,
  IndexStatus,
  NoteRecord,
  TodayItem,
  WorkbenchTab,
} from "../types";
import { enableDragScroll, renderChart } from "./Chart";
import { HistoryView } from "./HistoryView";
import { NoteModal } from "./NoteModal";

const PHASE_TEXT: Record<string, string> = {
  idle: "等待索引",
  scanning: "索引中",
  ready: "就绪",
  error: "异常",
};

/**
 * P4 正式视图：四个页签 + 内联 SVG 柱状图 + 统一 Markdown 弹窗 + 浏览历史。
 * 位置、折叠与分类筛选都写回 PluginData，同一天内重新打开可恢复。
 */
export class WorkbenchView extends ItemView {
  private readonly plugin: KnowledgeWorkbenchPlugin;
  private readonly tabButtons = new Map<WorkbenchTab, HTMLElement>();
  private unsubscribeIndex?: () => void;
  private unsubscribeDomain?: () => void;
  private scrollEl?: HTMLElement;
  private paneEl?: HTMLElement;
  private tab: WorkbenchTab = "today";
  private category: string | null = null;
  private restoringScroll = false;
  private detailScroll = 0;

  constructor(leaf: WorkspaceLeaf, plugin: KnowledgeWorkbenchPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_WORKBENCH;
  }

  getDisplayText(): string {
    return "知识管理工作台";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    this.contentEl.classList.add("kw-view");
    const view = restoreViewState(this.plugin.store.view, todayString());
    this.plugin.store.patchView(view);
    this.tab = view.tab;
    this.category = readCategory(view.tabDetail);

    const tabs = this.contentEl.createDiv({ cls: "kw-tabs" });
    tabs.setAttr("role", "tablist");
    for (const tab of TAB_ORDER) {
      const button = tabs.createEl("button", {
        cls: "kw-tab",
        text: TAB_LABELS[tab],
      });
      button.setAttr("role", "tab");
      button.addEventListener("click", () => this.setTab(tab));
      this.tabButtons.set(tab, button);
    }

    this.scrollEl = this.contentEl.createDiv({ cls: "kw-scroll" });
    this.scrollEl.addEventListener("scroll", () => {
      if (this.restoringScroll || !this.scrollEl) return;
      this.plugin.store.patchView({ scrollY: this.scrollEl.scrollTop });
    });
    this.paneEl = this.scrollEl.createDiv({ cls: "kw-pane" });

    this.unsubscribeIndex = this.plugin.index.subscribe(() => this.render());
    this.unsubscribeDomain = this.plugin.workbench.subscribe(() => this.render());
    this.render();
    this.applyScroll(view.scrollY);
  }

  async onClose(): Promise<void> {
    this.unsubscribeIndex?.();
    this.unsubscribeDomain?.();
    this.unsubscribeIndex = undefined;
    this.unsubscribeDomain = undefined;
    if (this.scrollEl) {
      this.plugin.store.patchView({ scrollY: this.scrollEl.scrollTop });
    }
    this.contentEl.empty();
    this.tabButtons.clear();
  }

  private render(): void {
    if (!this.paneEl) return;
    const previousDetail = this.paneEl.querySelector<HTMLElement>(".kw-detail");
    if (previousDetail) this.detailScroll = previousDetail.scrollTop;
    const savedScroll = this.scrollEl?.scrollTop ?? 0;

    this.paneEl.empty();
    this.updateTabs();
    const domain = this.plugin.workbench.getSnapshot();
    const status = this.plugin.index.getStatus();

    if (this.tab === "today") this.renderToday(this.paneEl, domain);
    else if (this.tab === "knowledge") this.renderKnowledge(this.paneEl, domain);
    else if (this.tab === "review") this.renderReview(this.paneEl, domain);
    else this.renderStats(this.paneEl, domain, status);

    this.renderFooter(this.paneEl);

    const detail = this.paneEl.querySelector<HTMLElement>(".kw-detail");
    if (detail) {
      enableDragScroll(detail);
      detail.scrollTop = this.detailScroll;
    }
    if (savedScroll > 0) this.applyScroll(savedScroll);
  }

  private updateTabs(): void {
    for (const [tab, button] of this.tabButtons) {
      const active = tab === this.tab;
      button.classList.toggle("is-active", active);
      button.setAttr("aria-selected", String(active));
    }
  }

  /** 供命令面板在视图已打开时直接切换页签。 */
  setActiveTab(tab: WorkbenchTab): void {
    this.setTab(tab);
  }

  private setTab(tab: WorkbenchTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.detailScroll = 0;
    this.plugin.store.patchView({
      tab,
      scrollY: 0,
      tabDetail: writeCategory(this.plugin.store.view.tabDetail, this.category),
    });
    this.render();
    if (this.scrollEl) this.scrollEl.scrollTop = 0;
  }

  private applyScroll(y: number): void {
    if (!this.scrollEl) return;
    this.restoringScroll = true;
    this.scrollEl.scrollTop = Math.max(0, y);
    requestAnimationFrame(() => {
      this.restoringScroll = false;
    });
  }

  private stat(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createDiv({ cls: "kw-stat" });
    item.createDiv({ cls: "kw-stat-label", text: label });
    item.createDiv({ cls: "kw-stat-value", text: value });
  }

  // ── 今日要处理 ────────────────────────────────────────────
  private renderToday(parent: HTMLElement, domain: DomainSnapshot): void {
    const folded = this.plugin.store.snapshot.todayFolded;
    const card = parent.createDiv({ cls: "kw-card kw-today-card" });
    const head = card.createDiv({ cls: "kw-today-head" });
    // 折叠前后标题行完全一致，不附带任何计数备注；单行由 CSS 保证不换行。
    head.createSpan({
      cls: "kw-today-title",
      text: todayCardTitle(domain.today.day),
    });
    const toggle = head.createEl("button", { cls: "kw-fold-btn", text: "⌄" });
    toggle.setAttr("aria-label", folded ? "展开今日清单" : "收起今日清单");
    toggle.setAttr("aria-expanded", String(!folded));
    toggle.classList.toggle("is-folded", folded);
    toggle.addEventListener("click", () => {
      this.plugin.store.setTodayFolded(!folded);
      this.render();
    });

    if (folded) return;

    if (!domain.today.items.length) {
      card.createDiv({
        cls: "kw-hint",
        text: "今日没有待处理、复习或过时提醒。",
      });
    }
    const groups = groupToday(domain.today.items);
    for (const [kind, items] of groups) {
      card.createDiv({
        cls: "kw-group-title",
        text: `${KIND_LABEL[kind]} · ${items.length} 项`,
      });
      for (const item of items) this.renderTodayItem(card, item);
    }

    const ics = card.createDiv({ cls: "kw-hint kw-today-ics" });
    ics.setText(
      domain.ics.enabled
        ? `提醒已写入 ${domain.ics.path}（${domain.ics.events} 条日程，含提前 1 天提醒）；关闭 Obsidian 后由系统日历触发。`
        : ".ics 提醒已在设置中关闭；应用内清单仍会正常显示。",
    );
    if (domain.ics.mobile) {
      card.createDiv({
        cls: "kw-hint",
        text: "手机端：请在系统日历导入或订阅 vault 内的 .ics 文件，插件不常驻后台。",
      });
    }
    if (domain.ics.error) {
      card.createDiv({
        cls: "kw-error",
        text: `.ics 写入失败：${domain.ics.error}`,
      });
    }
  }

  private renderTodayItem(parent: HTMLElement, item: TodayItem): void {
    const row = parent.createDiv({ cls: "kw-today-row" });
    row.createSpan({ cls: "kw-kind", text: KIND_LABEL[item.kind] });
    const link = row.createEl("a", { cls: "kw-note-link", text: item.title });
    link.setAttr("href", "#");
    link.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      this.openNote(item.path);
    });
    const open = row.createEl("button", {
      cls: "kw-open-btn",
      text: "打开原文",
    });
    open.addEventListener("click", () => this.openOriginal(item.path));
    row.createDiv({
      cls: "kw-note-meta",
      text: `${item.detail} · ${item.path}`,
    });
  }

  // ── 知识库 ────────────────────────────────────────────────
  private renderKnowledge(parent: HTMLElement, domain: DomainSnapshot): void {
    const chartCard = parent.createDiv({ cls: "kw-card" });
    chartCard.createDiv({ cls: "kw-card-title", text: "分类统计" });
    const host = chartCard.createDiv({ cls: "kw-chart-host" });
    renderChart(host, domain.chart, this.category, (key) => {
      this.category = key;
      this.detailScroll = 0;
      this.plugin.store.patchView({
        tabDetail: writeCategory(this.plugin.store.view.tabDetail, key),
      });
      this.render();
    });
    chartCard.createDiv({
      cls: "kw-hint",
      text: `共 ${domain.noteCount} 篇 / ${domain.categories.length} 类；逐篇统计不设上限，仅柱状图取 Top ${CHART_LIMIT}，长尾归入「其他」。点击柱子筛选，再点一次取消。`,
    });

    const detailCard = parent.createDiv({ cls: "kw-card" });
    const head = detailCard.createDiv({ cls: "kw-detail-head" });
    head.createDiv({
      cls: "kw-card-title",
      text: this.category ? `分类明细 · ${this.category}` : "分类明细（全部）",
    });
    if (this.category) {
      const clear = head.createEl("button", {
        cls: "kw-open-btn",
        text: "清除筛选",
      });
      clear.addEventListener("click", () => {
        this.category = null;
        this.detailScroll = 0;
        this.plugin.store.patchView({
          tabDetail: writeCategory(this.plugin.store.view.tabDetail, null),
        });
        this.render();
      });
    }

    const allowed = filterPaths(domain.chart, this.category);
    const notes = this.plugin.index
      .getNotes()
      .filter((note) => !allowed || allowed.has(note.path))
      .sort((a, b) => b.mtime - a.mtime);
    // P6：万篇库下分批渲染，首屏只创建 60 行；滚动到底或点按钮追加下一批。
    const hint = detailCard.createDiv({ cls: "kw-hint" });
    const detail = detailCard.createDiv({ cls: "kw-detail" });
    const more = detailCard.createEl("button", {
      cls: "kw-load-more",
      text: "加载更多",
    });
    more.setAttr("type", "button");
    let loaded = 0;
    const updateHint = (): void => {
      hint.setText(
        `已显示 ${loaded} / ${notes.length} 篇 · 明细区可滚动、可按住鼠标拖动；滚动到底部自动加载更多。标题在弹窗中按 Markdown 渲染。`,
      );
    };
    const appendBatch = (): void => {
      const from = loaded;
      loaded = nextLoaded(loaded, notes.length);
      for (const note of notes.slice(from, loaded)) this.renderNoteRow(detail, note);
      if (lazyPage(notes, loaded).hasMore) more.removeAttribute("hidden");
      else more.setAttr("hidden", "true");
      updateHint();
    };

    if (!notes.length) {
      detail.createDiv({ cls: "kw-empty", text: "没有匹配的笔记。" });
      more.setAttr("hidden", "true");
      updateHint();
    } else {
      appendBatch();
      more.addEventListener("click", appendBatch);
      detail.addEventListener("scroll", () => {
        if (shouldLoadMore(detail.scrollTop, detail.clientHeight, detail.scrollHeight)) {
          appendBatch();
        }
      });
    }

    const historyCard = parent.createDiv({ cls: "kw-card" });
    new HistoryView(historyCard, (path) => this.openNote(path)).render(
      this.plugin.store.history,
    );
  }

  private renderNoteRow(parent: HTMLElement, note: NoteRecord): void {
    const row = parent.createDiv({ cls: "kw-note-row" });
    const link = row.createEl("a", {
      cls: "kw-note-link",
      text: note.title || note.path,
    });
    link.setAttr("href", "#");
    link.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      this.openNote(note.path);
    });
    const open = row.createEl("button", {
      cls: "kw-open-btn",
      text: "打开原文",
    });
    open.addEventListener("click", () => this.openOriginal(note.path));
    const tags = note.tags.length
      ? note.tags.map((tag) => `#${tag}`).join(" ")
      : "无标签";
    row.createDiv({
      cls: "kw-note-meta",
      text: `${tags} · ${new Date(note.mtime).toLocaleDateString("zh-CN")} · ${note.path}`,
    });
    if (note.summary) {
      row.createDiv({ cls: "kw-note-summary", text: note.summary });
    }
  }

  // ── 复习 ──────────────────────────────────────────────────
  private renderReview(parent: HTMLElement, domain: DomainSnapshot): void {
    const dueCard = parent.createDiv({ cls: "kw-card" });
    dueCard.createDiv({
      cls: "kw-card-title",
      text: `到期复习 · ${domain.today.review.length} 项`,
    });
    if (!domain.today.review.length) {
      dueCard.createDiv({ cls: "kw-hint", text: "今天没有到期的复习项。" });
    }
    for (const item of domain.today.review) this.renderTodayItem(dueCard, item);

    const plan = planReview(
      this.plugin.index.getNotes(),
      todayString(),
      this.plugin.store.settings.reviewIntervals,
    );
    const planCard = parent.createDiv({ cls: "kw-card" });
    planCard.createDiv({
      cls: "kw-card-title",
      text: `下一轮排期预览（${plan.length} 篇）`,
    });
    planCard.createDiv({
      cls: "kw-hint",
      text: "固定间隔 1/3/7/15/30 天；仅预览，不会自动改动笔记。明细区可滚动、可拖动。",
    });
    const detail = planCard.createDiv({ cls: "kw-detail" });
    if (!plan.length) {
      detail.createDiv({
        cls: "kw-empty",
        text: "没有带 review 字段且已到期的笔记。给笔记添加 review 日期后，这里会生成排期。",
      });
    }
    for (const item of plan) {
      const row = detail.createDiv({ cls: "kw-note-row" });
      const link = row.createEl("a", {
        cls: "kw-note-link",
        text: item.title,
      });
      link.setAttr("href", "#");
      link.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        this.openNote(item.path);
      });
      row.createDiv({
        cls: "kw-note-meta",
        text: `${item.from ?? "首次"} → ${item.nextDate}（间隔 ${item.interval} 天，阶段 ${item.nextStage}） · ${item.path}`,
      });
    }

    const actions = parent.createDiv({ cls: "kw-actions" });
    const apply = actions.createEl("button", {
      text: "应用复习排期到笔记",
    });
    apply.addEventListener("click", () => void this.plugin.applyReviewPlan());
    parent.createDiv({
      cls: "kw-hint",
      text: "写回用户笔记默认关闭：需先在设置中开启，再主动执行此操作；插件不会自动给全库笔记加提醒。",
    });
  }

  // ── 统计 ──────────────────────────────────────────────────
  private renderStats(
    parent: HTMLElement,
    domain: DomainSnapshot,
    status: IndexStatus,
  ): void {
    const card = parent.createDiv({ cls: "kw-card" });
    card.createDiv({ cls: "kw-card-title", text: "索引状态" });
    const grid = card.createDiv({ cls: "kw-grid" });
    this.stat(grid, "阶段", PHASE_TEXT[status.phase] ?? status.phase);
    this.stat(grid, "已索引", `${status.indexed} 篇`);
    this.stat(grid, "本次耗时", `${status.durationMs} ms`);
    this.stat(grid, "主线程让出", `${status.yields} 次`);
    this.stat(grid, "待补元数据", `${status.cacheMisses} 篇`);
    card.createDiv({ cls: "kw-hint", text: `index.json：${status.indexPath}` });
    if (status.error) {
      card.createDiv({ cls: "kw-error", text: `索引异常：${status.error}` });
    }

    const diff = status.diff;
    if (diff?.initial) {
      parent.createDiv({
        cls: "kw-hint",
        text: `首次索引完成，共 ${status.indexed} 篇；快照写入 vault 后，从下次启动开始提示差异。`,
      });
    } else if (diff && !isEmptyDiff(diff)) {
      const box = parent.createDiv({ cls: "kw-card kw-diff" });
      box.createDiv({
        cls: "kw-card-title",
        text: "与上次快照的差异（只读）",
      });
      box.createDiv({ cls: "kw-hint", text: describeDiff(diff) });
      const list = box.createEl("ul", { cls: "kw-list" });
      const groups: Array<[string, string[]]> = [
        ["新增", diff.added],
        ["修改", diff.modified],
        ["减少", diff.removed],
      ];
      for (const [label, paths] of groups) {
        for (const path of paths.slice(0, 3)) {
          list.createEl("li", { text: `${label} · ${path}` });
        }
        if (paths.length > 3) {
          list.createEl("li", {
            text: `${label} · 另有 ${paths.length - 3} 篇`,
          });
        }
      }
      box.createDiv({
        cls: "kw-hint",
        text: "只读提示：不执行删除、不提供恢复；删除笔记请使用 Obsidian 自带的「移到回收站」。",
      });
    } else if (diff) {
      parent.createDiv({ cls: "kw-hint", text: "与上次快照一致，无变化。" });
    }

    const icsCard = parent.createDiv({ cls: "kw-card" });
    icsCard.createDiv({ cls: "kw-card-title", text: ".ics 提醒" });
    const icsGrid = icsCard.createDiv({ cls: "kw-grid" });
    this.stat(icsGrid, "状态", domain.ics.enabled ? "已启用" : "已关闭");
    this.stat(icsGrid, "日程数", `${domain.ics.events} 条`);
    this.stat(
      icsGrid,
      "最近写入",
      domain.ics.lastWriteAt
        ? new Date(domain.ics.lastWriteAt).toLocaleTimeString("zh-CN")
        : "尚未写入",
    );
    icsCard.createDiv({ cls: "kw-hint", text: `路径：${domain.ics.path}` });

    const countsCard = parent.createDiv({ cls: "kw-card" });
    countsCard.createDiv({
      cls: "kw-card-title",
      text: `全量分类（${domain.categories.length} 类，逐篇统计不设上限）`,
    });
    const detail = countsCard.createDiv({ cls: "kw-detail kw-detail-short" });
    for (const item of domain.categories) {
      const row = detail.createDiv({ cls: "kw-count-row" });
      row.createSpan({ cls: "kw-count-key", text: item.key });
      row.createSpan({ cls: "kw-count-value", text: `${item.count} 篇` });
    }
    if (!domain.categories.length) {
      detail.createDiv({ cls: "kw-empty", text: "尚无索引结果。" });
    }

    const tagCard = parent.createDiv({ cls: "kw-card" });
    tagCard.createDiv({
      cls: "kw-card-title",
      text: `标签 / 文件夹（标签 ${domain.tagCounts.length} 个，文件夹 ${domain.folderCounts.length} 个）`,
    });
    const tagDetail = tagCard.createDiv({ cls: "kw-detail kw-detail-short" });
    for (const item of domain.tagCounts.slice(0, 30)) {
      const row = tagDetail.createDiv({ cls: "kw-count-row" });
      row.createSpan({ cls: "kw-count-key", text: `#${item.key}` });
      row.createSpan({ cls: "kw-count-value", text: `${item.count} 篇` });
    }
    for (const item of domain.folderCounts.slice(0, 30)) {
      const row = tagDetail.createDiv({ cls: "kw-count-row" });
      row.createSpan({ cls: "kw-count-key", text: `目录 · ${item.key}` });
      row.createSpan({ cls: "kw-count-value", text: `${item.count} 篇` });
    }
    if (!domain.tagCounts.length && !domain.folderCounts.length) {
      tagDetail.createDiv({ cls: "kw-empty", text: "尚无标签与目录统计。" });
    }

    const actions = parent.createDiv({ cls: "kw-actions" });
    const rebuild = actions.createEl("button", { text: "重建索引" });
    rebuild.addEventListener("click", () => this.plugin.index.rescan());
    const write = actions.createEl("button", { text: "写入快照" });
    write.addEventListener("click", () => this.plugin.index.writeNow());
    const ics = actions.createEl("button", { text: "重建 .ics" });
    ics.addEventListener("click", () => this.plugin.workbench.rebuildIcs());
    const copy = actions.createEl("button", { text: "复制 .ics" });
    copy.addEventListener("click", () => void this.plugin.copyIcs());
  }

  private renderFooter(parent: HTMLElement): void {
    parent.createDiv({
      cls: "kw-hint kw-footer",
      text: `知识管理工作台 v${this.plugin.manifest.version} · 业务数据存于笔记 frontmatter，派生数据存于 vault 内 index.json / .ics；跨设备同步由你既有的同步方案负责，本插件零网络请求。`,
    });
  }

  /** 所有 Markdown 原文窗口统一走 NoteModal（宿主 MarkdownRenderer）。 */
  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.plugin.store.patchView({
        lastModal: path,
        note: { path, title: file.basename },
      });
      new NoteModal(this.app, file, {
        speech: this.plugin.speech,
        autoResume: () => this.plugin.store.settings.speechAutoResume,
      }).open();
    }
  }

  /** 笔记名对应的「打开原文」入口，重命名后由 vault 路径自动跟随。 */
  private openOriginal(path: string): void {
    void this.app.workspace.openLinkText(
      path.replace(/\.md$/i, ""),
      path,
      false,
    );
  }
}
