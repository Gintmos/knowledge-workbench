import type { App } from "obsidian";
import { buildDomainSnapshot, emptyIcsState } from "../domain/aggregate";
import { buildToday, todayString } from "../domain/TaskService";
import type { DomainSnapshot, WorkbenchSettings } from "../types";
import { IcsService } from "./IcsService";
import type { StoreService } from "./StoreService";
import type { VaultIndexService } from "./VaultIndexService";

/**
 * 领域聚合层：把索引结果换算为「今日 / 分类 / 统计 / .ics」单一快照，
 * 供视图订阅；索引每次 ready 或设置变更后重算，并防抖重建 .ics。
 */
export class WorkbenchService {
  private readonly store: StoreService;
  private readonly index: VaultIndexService;
  private readonly ics: IcsService;
  private readonly listeners = new Set<(snapshot: DomainSnapshot) => void>();
  private unsubscribeIndex?: () => void;
  private snapshot: DomainSnapshot;

  constructor(
    app: App,
    store: StoreService,
    index: VaultIndexService,
    options: { mobile: boolean },
  ) {
    this.store = store;
    this.index = index;
    this.ics = new IcsService(app, {
      mobile: options.mobile,
      getSettings: (): WorkbenchSettings => this.store.settings,
      onChange: (state) => {
        this.snapshot = { ...this.snapshot, ics: state };
        this.emit();
      },
    });
    const settings = this.store.settings;
    this.snapshot = buildDomainSnapshot(
      [],
      todayString(),
      settings,
      emptyIcsState(settings, options.mobile),
    );
  }

  start(): void {
    this.unsubscribeIndex = this.index.subscribe((status) => {
      if (status.phase === "ready") this.recompute();
    });
  }

  subscribe(listener: (snapshot: DomainSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): DomainSnapshot {
    return { ...this.snapshot };
  }

  recompute(): void {
    const notes = this.index.getNotes();
    const settings = this.store.settings;
    const today = todayString();
    const todaySummary = buildToday(notes, today, settings);
    this.ics.configure(settings);
    this.ics.setItems(todaySummary.items, today);
    this.snapshot = buildDomainSnapshot(
      notes,
      today,
      settings,
      this.ics.getState(),
      todaySummary,
    );
    this.emit();
    this.ics.schedule();
  }

  rebuildIcs(): void {
    void this.ics.rebuild();
  }

  getIcsText(): string {
    return this.ics.getText();
  }

  dispose(): void {
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = undefined;
    this.ics.dispose();
    this.listeners.clear();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[knowledge-workbench] domain listener failed", error);
      }
    }
  }
}
