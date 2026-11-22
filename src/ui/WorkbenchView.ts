import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type KnowledgeWorkbenchPlugin from "../main";
import { describeDiff, isEmptyDiff } from "../domain/indexDiff";
import { planReview } from "../domain/ReviewService";
import { todayString } from "../domain/TaskService";
import {
  KIND_LABEL,
  TAB_LABELS,
  TAB_ORDER,
  barRowsMax,
  decodeSelection,
  encodeSelection,
  groupToday,
  lazyPage,
  nextLoaded,
  normalizeTabDetail,
  readCategory,
  restoreViewState,
  shouldLoadMore,
  todayCardTitle,
  writeCategory,
  DETAIL_PAGE_SIZE,
  type ChartScope,
} from "../domain/uiModel";
import { VIEW_TYPE_WORKBENCH } from "../types";
import type {
  CategoryCount,
  ChartSlice,
  DomainSnapshot,
  IndexStatus,
  NoteRecord,
  TodayItem,
  TodayKind,
  WorkbenchTab,
} from "../types";
import { enableDragScroll, renderBarMeter } from "./Chart";
import { HistoryView } from "./HistoryView";
import { NoteModal } from "./NoteModal";

const PHASE_TEXT: Record<string, string> = {
  idle: "等待索引",
  scanning: "索引中",
  ready: "就绪",
  error: "异常",
};

/**
 * 正式视图：四个页签（今日 / 复习 / 统计 / 浏览历史）。
 * 统计页两张已有卡片的下半部分列表每行带横向条形图，点条形或名称原地展开
 * 笔记清单，笔记名直达 vault 原文；卡片上方不再有纵向柱状图。
 * 渲染全程 try/catch，任何异常都不会留下空白页。
 */
export class WorkbenchView extends ItemView {
  private readonly plugin: KnowledgeWorkbenchPlugin;
  private readonly tabButtons = new Map<WorkbenchTab, HTMLElement>();
  private unsubscribeIndex?: () => void;
  private unsubscribeDomain?: () => void;
  private scrollEl?: HTMLElement;
  private paneEl?: HTMLElement;
  private tab: WorkbenchTab = "today";
  /** 持久化的选中项（encodeSelection 后的字符串），旧脏值在 normalize 阶段清除。 */
  private category: string | null = null;
  private restoringScroll = false;
  private detailScroll = 0;
  /** P2-5：「运行信息」折叠状态记在实例上，索引 emit 重渲染不再把展开状态复位。 */
  private runtimeInfoOpen = false;

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
    try {
      const domain = this.plugin.workbench.getSnapshot();
      const status = this.plugin.index.getStatus();

      if (this.tab === "today") this.renderToday(this.paneEl, domain);
      else if (this.tab === "review") this.renderReview(this.paneEl, domain);
      else if (this.tab === "history") this.renderHistory(this.paneEl);
      else this.renderStats(this.paneEl, domain, status);

      this.renderFooter(this.paneEl);
    } catch (error) {
      console.error("[knowledge-workbench] render failed", error);
      this.renderError(this.paneEl, error);
    }

    for (const detail of Array.from(
      this.paneEl.querySelectorAll<HTMLElement>(".kw-detail"),
    )) {
      enableDragScroll(detail);
      detail.scrollTop = this.detailScroll;
    }
    if (savedScroll > 0) this.applyScroll(savedScroll);
  }

  /** 渲染异常时的自救卡片：永远保留可见内容与「重置视图」按钮。 */
  private renderError(parent: HTMLElement, error: unknown): void {
    const card = parent.createDiv({ cls: "kw-card kw-error-card" });
    card.createDiv({ cls: "kw-card-title", text: "界面渲染出错" });
    card.createDiv({
      cls: "kw-hint",
      text:
        "已阻止空白页。可以点「重置视图」清除页签与分类筛选后重新渲染；原始错误已写入开发者控制台。",
    });
    card.createDiv({
      cls: "kw-hint",
      text: `错误摘要：${error instanceof Error ? error.message : String(error)}`,
    });
    const reset = card.createEl("button", { text: "重置视图" });
    reset.addEventListener("click", () => {
      this.category = null;
      this.tab = "today";
      this.detailScroll = 0;
      this.plugin.store.patchView({
        tab: "today",
        scrollY: 0,
        tabDetail: {},
      });
      this.render();
      if (this.scrollEl) this.scrollEl.scrollTop = 0;
    });
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
    // P2-7：用宿主的 activeWindow，避免多窗口 / popout 下拿到错误的全局 rAF。
    activeWindow.requestAnimationFrame(() => {
      this.restoringScroll = false;
    });
  }

  private stat(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createDiv({ cls: "kw-stat" });
    item.createDiv({ cls: "kw-stat-label", text: label });
    item.createDiv({ cls: "kw-stat-value", text: value });
  }

  // ── 今日 ──────────────────────────────────────────────────
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
        text: "今日没有待处理、复习、催办或待办任务。",
      });
    }
    const groups = groupToday(domain.today.items);
    for (const [kind, items] of groups) {
      this.renderTodayGroup(card, kind, items);
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

  /** P2-6：分组清单复用 60/页懒加载；无日期待办不设上限，长清单不再一次性渲染。 */
  private renderTodayGroup(parent: HTMLElement, kind: TodayKind, items: TodayItem[]): void {
    parent.createDiv({
      cls: "kw-group-title",
      text: `${KIND_LABEL[kind]} · ${items.length} 项`,
    });
    if (items.length <= DETAIL_PAGE_SIZE) {
      for (const item of items) this.renderTodayItem(parent, item);
      return;
    }
    const more = parent.createEl("button", { cls: "kw-load-more" });
    more.setAttr("type", "button");
    let loaded = 0;
    const appendBatch = (): void => {
      const from = loaded;
      loaded = nextLoaded(loaded, items.length);
      for (const item of items.slice(from, loaded)) {
        this.renderTodayItem(parent, item, more);
      }
      const page = lazyPage(items, loaded);
      if (page.hasMore) more.setText(`加载更多（还有 ${items.length - loaded} 项）`);
      else more.setAttr("hidden", "true");
    };
    appendBatch();
    more.addEventListener("click", appendBatch);
  }

  private renderTodayItem(parent: HTMLElement, item: TodayItem, before?: HTMLElement): void {
    const row = parent.createDiv({ cls: "kw-today-row" });
    if (before) before.before(row);
    row.createSpan({ cls: "kw-kind", text: KIND_LABEL[item.kind] });
    const link = row.createEl("a", { cls: "kw-note-link", text: item.title });
    link.setAttr("href", "#");
    link.setAttr("aria-label", `打开「${item.title}」的原文窗口`);
    // U-2：完整路径收进悬浮提示，窄栏 meta 行不再被路径撑高。
    link.setAttr("title", item.path);
    link.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      this.openNote(item.path);
    });

    // 单篇就地操作：逾期/到期 → 完成；复习 → 推进；催办/待办 → 勾选任务行。
    const done = row.createEl("button", {
      cls: "kw-resolve-btn",
      text: item.kind === "review" ? "完成复习" : "完成",
    });
    done.setAttr("type", "button");
    done.setAttr(
      "aria-label",
      item.kind === "followup" || item.kind === "todo"
        ? `勾选任务「${item.title}」`
        : `标记「${item.title}」为已完成`,
    );
    done.addEventListener("click", () => {
      void this.plugin.resolveTodayItem(
        item.path,
        item.kind,
        item.task?.line,
      );
    });

    // U-2：meta 只保留 detail；完整路径已移到标题与笔记名的 title 悬浮提示。
    if (item.detail) {
      const meta = row.createDiv({ cls: "kw-note-meta", text: item.detail });
      meta.setAttr("title", `${item.detail} · ${item.path}`);
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
      text: "艾宾浩斯间隔按天离散化，默认 1/2/4/7/15/30/60 天；到期项点「完成复习」后自动推进到下一轮并写回。明细区可滚动、可拖动。",
    });
    const detail = planCard.createDiv({ cls: "kw-detail" });
    if (!plan.length) {
      detail.createDiv({
        cls: "kw-empty",
        text: "没有已到期的复习项。在笔记里点「开始复习」加入艾宾浩斯序列后，到期时会出现在今日页与这里。",
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

  // ── 浏览历史（独立页签）────────────────────────────────────
  private renderHistory(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "kw-card" });
    new HistoryView(card, (path) => this.openNote(path)).render(
      this.plugin.store.history,
    );
  }

  // ── 统计 ──────────────────────────────────────────────────
  private renderStats(
    parent: HTMLElement,
    domain: DomainSnapshot,
    status: IndexStatus,
  ): void {
    const selection = decodeSelection(this.category);

    // U-3：业务数据优先——主分类 / 标签分布上移，索引状态与 .ics 状态卡下移。
    // 已有卡片：全量分类。不新增卡片、不改 layout；仅在下半部分列表每行加横向条。
    const countsCard = parent.createDiv({ cls: "kw-card" });
    countsCard.createDiv({
      cls: "kw-card-title",
      text: `主分类总览（${domain.categories.length} 类，每篇只归一类）`,
    });
    countsCard.createDiv({
      cls: "kw-hint",
      text: "用于看互斥的大盘分布；同一篇笔记在下方「标签 / 文件夹」卡里可计入多个标签。",
    });
    const activeCategory =
      selection?.scope === "category" ? selection.key : null;
    const catMax = barRowsMax(domain.categories);
    const pickedCategory = activeCategory
      ? domain.chart.find((slice) => slice.key === activeCategory)
      : undefined;
    if (pickedCategory) {
      this.renderCategoryNotes(countsCard, pickedCategory, domain, "category");
    } else {
      countsCard.createDiv({
        cls: "kw-hint",
        text: `共 ${domain.categories.length} 类，条形按篇数比例绘制；点名称或条形查看该类笔记清单。`,
      });
      const detail = countsCard.createDiv({
        cls: "kw-detail kw-detail-short",
      });
      this.renderCountRows(
        detail,
        domain.categories,
        (key) => key,
        "category",
        catMax,
      );
      if (!domain.categories.length) {
        detail.createDiv({ cls: "kw-empty", text: "尚无索引结果。" });
      }
    }

    // 已有卡片：标签 / 文件夹。条形 key 与列表行显示名完全一致。
    const tagCard = parent.createDiv({ cls: "kw-card" });
    const tagHead = tagCard.createDiv({
      cls: "kw-card-title kw-card-title-row",
    });
    tagHead.createSpan({
      text: `标签 / 文件夹（标签 ${domain.tagCounts.length} 个，文件夹 ${domain.folderCounts.length} 个）`,
    });
    const manageBtn = tagHead.createEl("button", {
      cls: "kw-manage-tags",
      text: "管理标签",
    });
    manageBtn.setAttr("type", "button");
    manageBtn.setAttr("aria-label", "批量重命名或合并标签");
    manageBtn.addEventListener("click", () =>
      this.plugin.openTagManager(),
    );
    const activeDetail = selection?.scope === "detail" ? selection.key : null;
    const tagMax = barRowsMax([...domain.tagCounts, ...domain.folderCounts]);
    const pickedDetail = activeDetail
      ? domain.detailChart.find((slice) => slice.key === activeDetail)
      : undefined;
    if (pickedDetail) {
      this.renderCategoryNotes(tagCard, pickedDetail, domain, "detail");
    } else {
      tagCard.createDiv({
        cls: "kw-hint",
        text: `标签 ${domain.tagCounts.length} 个、文件夹 ${domain.folderCounts.length} 个，条形按篇数比例绘制；点名称或条形查看笔记清单。`,
      });
      const tagDetail = tagCard.createDiv({
        cls: "kw-detail kw-detail-short",
      });
      this.renderCountRows(
        tagDetail,
        domain.tagCounts.slice(0, 30),
        (key) => `#${key}`,
        "detail",
        tagMax,
      );
      this.renderCountRows(
        tagDetail,
        domain.folderCounts.slice(0, 30),
        (key) => `目录 · ${key}`,
        "detail",
        tagMax,
      );
      // P2-4：top-30 截断必须有可见提示，避免用户误以为只有这些标签。
      if (domain.tagCounts.length > 30) {
        tagDetail.createDiv({
          cls: "kw-hint",
          text: `标签已显示前 30 个（共 ${domain.tagCounts.length} 个），完整列表可在「管理标签」中查看。`,
        });
      }
      if (domain.folderCounts.length > 30) {
        tagDetail.createDiv({
          cls: "kw-hint",
          text: `文件夹已显示前 30 个（共 ${domain.folderCounts.length} 个）。`,
        });
      }
      if (!domain.tagCounts.length && !domain.folderCounts.length) {
        tagDetail.createDiv({
          cls: "kw-empty",
          text: "尚无标签与目录统计。",
        });
      }
    }

    // ── U-3：维护类信息下移（索引状态 / 只读差异 / .ics 状态）──────
    const card = parent.createDiv({ cls: "kw-card" });
    card.createDiv({ cls: "kw-card-title", text: "索引状态" });
    const grid = card.createDiv({ cls: "kw-grid" });
    this.stat(grid, "阶段", PHASE_TEXT[status.phase] ?? status.phase);
    this.stat(grid, "已索引", `${status.indexed} 篇`);
    // v1.0.6：调试指标收进默认折叠的「运行信息」，常显只留阶段与篇数。
    const runtime = card.createDiv({ cls: "kw-runtime-info" });
    const runtimeToggle = runtime.createEl("button", {
      cls: "kw-fold-btn kw-runtime-toggle",
      text: this.runtimeInfoOpen ? "运行信息 ⌃" : "运行信息 ⌄",
    });
    runtimeToggle.setAttr("type", "button");
    runtimeToggle.setAttr("aria-expanded", String(this.runtimeInfoOpen));
    const runtimeBody = runtime.createDiv({ cls: "kw-runtime-body" });
    if (!this.runtimeInfoOpen) runtimeBody.setAttr("hidden", "true");
    this.stat(runtimeBody, "本次耗时", `${status.durationMs} ms`);
    this.stat(runtimeBody, "主线程让出", `${status.yields} 次`);
    this.stat(runtimeBody, "待补元数据", `${status.cacheMisses} 篇`);
    runtimeToggle.addEventListener("click", () => {
      // P2-5：折叠状态记入实例字段，索引 emit 触发的重渲染不再把展开状态复位。
      this.runtimeInfoOpen = !this.runtimeInfoOpen;
      if (this.runtimeInfoOpen) runtimeBody.removeAttribute("hidden");
      else runtimeBody.setAttr("hidden", "true");
      runtimeToggle.setAttr("aria-expanded", String(this.runtimeInfoOpen));
      runtimeToggle.setText(this.runtimeInfoOpen ? "运行信息 ⌃" : "运行信息 ⌄");
    });
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

    // v1.0.6：四个维护按钮已移到设置页（那里有逐项说明），统计页不再重复摆放。
  }

  private renderCountRows(
    parent: HTMLElement,
    counts: CategoryCount[],
    label: (key: string) => string,
    scope: ChartScope,
    max: number,
  ): void {
    for (const item of counts) {
      const name = label(item.key);
      const row = parent.createDiv({ cls: "kw-count-row" });
      const link = row.createEl("a", {
        cls: "kw-count-key kw-count-link",
        text: name,
      });
      link.setAttr("href", "#");
      link.setAttr("aria-label", `查看${name}的笔记清单`);
      link.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        this.selectSlice(scope, name);
      });
      renderBarMeter(row, {
        count: item.count,
        max,
        label: name,
        onSelect: () => this.selectSlice(scope, name),
      });
      row.createSpan({ cls: "kw-count-value", text: `${item.count} 篇` });
    }
  }

  /** 点击柱子 / 名称后：在同一张卡片内原地展开该分类的笔记清单。 */
  private renderCategoryNotes(
    card: HTMLElement,
    slice: ChartSlice,
    domain: DomainSnapshot,
    scope: ChartScope,
  ): void {
    const head = card.createDiv({ cls: "kw-detail-head" });
    head.createDiv({
      cls: "kw-card-title",
      text: `笔记清单 · ${slice.key}`,
    });
    const clear = head.createEl("button", {
      // U-7：导航类按钮用次级样式；保留 kw-open-btn 基类，兼容既有冒烟脚本选择器。
      cls: "kw-open-btn kw-nav-btn",
      text: "返回分类列表",
    });
    clear.addEventListener("click", () => this.selectSlice(scope, null));
    const percent = domain.noteCount
      ? ((slice.count / domain.noteCount) * 100).toFixed(1)
      : "0.0";
    card.createDiv({
      cls: "kw-hint",
      text: `${slice.count} 篇 / 全库 ${domain.noteCount} 篇，占 ${percent}%；点击笔记名直达原文，「预览」打开带朗读的弹窗。`,
    });

    const allowed = new Set(slice.paths);
    const notes = this.plugin.index
      .getNotes()
      .filter((note) => allowed.has(note.path))
      .sort((a, b) => b.mtime - a.mtime);
    const hint = card.createDiv({ cls: "kw-hint" });
    const detail = card.createDiv({ cls: "kw-detail" });
    const more = card.createEl("button", {
      cls: "kw-load-more",
      text: "加载更多",
    });
    more.setAttr("type", "button");
    let loaded = 0;
    const updateHint = (): void => {
      hint.setText(
        `已显示 ${loaded} / ${notes.length} 篇 · 明细区可滚动、可按住鼠标拖动；滚动到底部自动加载更多。`,
      );
    };
    const appendBatch = (): void => {
      const from = loaded;
      loaded = nextLoaded(loaded, notes.length);
      for (const note of notes.slice(from, loaded)) {
        this.renderCategoryNoteRow(detail, note);
      }
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
  }

  /** 清单里的笔记名是「直达原文」链接，预览按钮才打开 Markdown 弹窗。 */
  private renderCategoryNoteRow(parent: HTMLElement, note: NoteRecord): void {
    const row = parent.createDiv({ cls: "kw-note-row" });
    const link = row.createEl("a", {
      cls: "kw-note-link",
      text: note.title || note.path,
    });
    link.setAttr("href", "#");
    link.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      this.openOriginal(note.path);
    });
    const preview = row.createEl("button", {
      cls: "kw-open-btn",
      text: "预览",
    });
    preview.addEventListener("click", () => this.openNote(note.path));
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

  private selectSlice(scope: ChartScope, key: string | null): void {
    this.category = key ? encodeSelection({ scope, key }) : null;
    this.detailScroll = 0;
    this.plugin.store.patchView({
      tabDetail: writeCategory(
        normalizeTabDetail(this.plugin.store.view.tabDetail),
        this.category,
      ),
    });
    this.render();
  }

  private renderFooter(parent: HTMLElement): void {
    parent.createDiv({
      cls: "kw-hint kw-footer",
      // U-6/P0-3：默认离线、仅朗读可选联网，不再宣称"零网络/已搁置"。
      text: `知识管理工作台 v${this.plugin.manifest.version} · 默认离线，仅朗读可选联网。业务数据存于笔记 frontmatter，派生数据存于 vault 内 index.json / .ics；跨设备同步由你既有的同步方案负责。`,
    });
  }

  /** 所有 Markdown 原文窗口统一走 NoteModal（宿主 MarkdownRenderer）。 */
  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      new NoteModal(this.app, file, {
        speech: this.plugin.speech,
        autoResume: () => this.plugin.store.settings.speechAutoResume,
        onExport: (title, text) => void this.plugin.saveSpeechDraft(title, text),
        onRateChange: (rate) => this.plugin.store.updateSettings({ speechRate: rate }),
        onStartReview: () => void this.plugin.startReviewCurrent(file),
        onStopReview: () => void this.plugin.stopReviewCurrent(file),
      }).open();
    }
  }

  /** 统计清单笔记名的直达原文入口，重命名后由 vault 路径自动跟随。 */
  private openOriginal(path: string): void {
    void this.app.workspace.openLinkText(
      path.replace(/\.md$/i, ""),
      path,
      false,
    );
  }
}
