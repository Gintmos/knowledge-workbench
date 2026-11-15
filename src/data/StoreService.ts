import { migratePaths, normalizeData, normalizeSettings, pushHistory } from "../domain/pluginData";
import type {
  HistoryEntry,
  PluginData,
  ReadProgress,
  ViewState,
  WorkbenchSettings,
} from "../types";

/** 只依赖这两个方法，便于在 Node 单测里用内存 persister 替换 Plugin.loadData/saveData。 */
export interface DataPersister {
  load(): Promise<unknown>;
  save(data: PluginData): Promise<void>;
}

export interface StoreOptions {
  saveDelay?: number;
  now?: () => number;
}

/**
 * 把 v16.1 的 4 组浏览器本地状态语义（view / read / history / todayFolded）
 * 合成单一 PluginData，经 loadData/saveData 持久化。业务数据不放在这里。
 */
export class StoreService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;

  private constructor(
    private readonly persister: DataPersister,
    private state: PluginData,
    private readonly saveDelay: number,
    private readonly now: () => number,
  ) {}

  static async create(
    persister: DataPersister,
    options: StoreOptions = {},
  ): Promise<StoreService> {
    let raw: unknown = null;
    try {
      raw = await persister.load();
    } catch {
      raw = null;
    }
    return new StoreService(
      persister,
      normalizeData(raw),
      Math.max(0, options.saveDelay ?? 400),
      options.now ?? Date.now,
    );
  }

  get snapshot(): PluginData {
    return this.state;
  }

  get settings(): WorkbenchSettings {
    return this.state.settings;
  }

  get view(): ViewState {
    return this.state.view;
  }

  get history(): HistoryEntry[] {
    return this.state.history;
  }

  private mutate(next: PluginData): void {
    if (this.disposed) return;
    this.state = next;
    this.dirty = true;
    this.scheduleSave();
  }

  patchView(patch: Partial<ViewState>): void {
    this.mutate({ ...this.state, view: { ...this.state.view, ...patch } });
  }

  setReadProgress(path: string, progress: ReadProgress | null): void {
    const read = { ...this.state.read };
    if (progress) read[path] = progress;
    else delete read[path];
    this.mutate({ ...this.state, read });
  }

  getReadProgress(path: string): ReadProgress | null {
    return this.state.read[path] ?? null;
  }

  addHistory(path: string, title: string): void {
    const history = pushHistory(this.state.history, { path, title, at: this.now() });
    this.mutate({ ...this.state, history });
  }

  setTodayFolded(value: boolean): void {
    this.mutate({ ...this.state, todayFolded: value });
  }

  updateSettings(patch: Partial<WorkbenchSettings>): void {
    const settings = normalizeSettings({ ...this.state.settings, ...patch });
    this.mutate({ ...this.state, settings });
  }

  renamePath(oldPath: string, newPath: string, newTitle?: string): void {
    this.mutate(migratePaths(this.state, oldPath, newPath, newTitle));
  }

  scheduleSave(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.saveDelay);
  }

  /** 立即落盘；无变更时不重复写，多次修改合并为一次写入。 */
  async flush(): Promise<void> {
    this.clearTimer();
    if (!this.dirty) {
      if (this.saving) await this.saving;
      return;
    }
    this.dirty = false;
    if (this.saving) await this.saving;
    const pending = this.persister.save(this.state);
    this.saving = pending;
    try {
      await pending;
    } finally {
      if (this.saving === pending) this.saving = null;
    }
  }

  /** 卸载插件：清理定时器、阻止后续写入，并把最后的脏数据落盘。 */
  dispose(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.disposed = true;
    if (this.dirty) {
      this.dirty = false;
      void this.persister.save(this.state);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
