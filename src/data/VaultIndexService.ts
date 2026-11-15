import {
  TAbstractFile,
  TFile,
  type App,
  type CachedMetadata,
  type Component,
  type EventRef,
} from "obsidian";
import { scanInBatches, type ScanSignal } from "../domain/batchScan";
import { computeDiff } from "../domain/indexDiff";
import {
  buildNoteRecord,
  pickFrontmatterSummary,
  type FileCacheLike,
} from "../domain/noteRecord";
import { shouldRecompute, summarize, type SummaryCacheEntry } from "../domain/SummaryService";
import { buildSnapshot, normalizeSnapshot, serializeSnapshot } from "../domain/snapshot";
import {
  SUMMARY_ALGO,
  emptyStatus,
  type IndexDiff,
  type IndexSnapshot,
  type IndexStatus,
  type NoteRecord,
} from "../types";

export interface VaultIndexOptions {
  indexPath: string;
  /**
   * 生产环境传 Plugin（继承 Component）：用 registerEvent() 注册宿主事件，
   * 由 Obsidian 在插件卸载时自动清理，符合官方资源管理规范。
   * 仅在内存宿主的单元测试中省略，此时回退到手动 offref。
   */
  owner?: Component;
  /** 重命名时交给 StoreService 迁移以 path 为 key 的朗读断点与历史。 */
  onRename?: (oldPath: string, newPath: string, newTitle: string) => void;
}

interface ScannedRecord {
  record: NoteRecord;
  /** metadataCache 尚未解析该文件，等 resolved 事件后补扫。 */
  needsMeta: boolean;
}

const BATCH_SIZE = 60;
const CONCURRENCY = 8;
const FLUSH_DELAY = 250;
const WRITE_DELAY = 2000;

function toCacheLike(cache: CachedMetadata | null): FileCacheLike | null {
  if (!cache) return null;
  return {
    tags: cache.tags?.map((item) => ({ tag: item.tag })),
    frontmatter: cache.frontmatter
      ? ({ ...cache.frontmatter } as Record<string, unknown>)
      : null,
    headings: cache.headings?.map((item) => ({
      heading: item.heading,
      level: item.level,
    })),
    links: cache.links?.map((item) => ({ link: item.link })),
  };
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * vault 索引：全量分批扫描 + 事件驱动增量更新 + index.json 只读 diff。
 * P3 起对缺少 frontmatter 摘要、且缓存未命中的笔记分批 cachedRead() 生成正文摘要。
 * 不发起任何网络请求，不使用 Node/Electron API。
 * 差异只做只读提示：插件不删除任何笔记；后续若提供删除入口，必须走 vault.trash()。
 */
export class VaultIndexService {
  private readonly app: App;
  private readonly indexPath: string;
  private readonly owner?: Component;
  private readonly onRename: VaultIndexOptions["onRename"];

  private records = new Map<string, NoteRecord>();
  private baseline: IndexSnapshot | null = null;
  private baselineLoaded = false;
  private diff: IndexDiff | null = null;
  private status: IndexStatus;

  private readonly listeners = new Set<(status: IndexStatus) => void>();
  private readonly offs: Array<() => void> = [];
  private readonly pendingUpsert = new Set<string>();
  private readonly pendingRemove = new Set<string>();
  private readonly missingCache = new Set<string>();

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private scanSignal: ScanSignal | null = null;
  private disposed = false;
  private lastProgressEmit = 0;

  constructor(app: App, options: VaultIndexOptions) {
    this.app = app;
    this.indexPath = options.indexPath;
    this.owner = options.owner;
    this.onRename = options.onRename;
    this.status = emptyStatus(this.indexPath);
  }

  /** 在 layout 就绪后注册事件并启动全量扫描，避开 vault 加载期的 create 事件洪泛。 */
  start(): void {
    this.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      this.registerEvents();
      void this.fullScan();
    });
  }

  subscribe(listener: (status: IndexStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): IndexStatus {
    return { ...this.status };
  }

  getNotes(): NoteRecord[] {
    return [...this.records.values()];
  }

  getNote(path: string): NoteRecord | null {
    return this.records.get(path) ?? null;
  }

  getDiff(): IndexDiff | null {
    return this.diff;
  }

  rescan(): void {
    void this.fullScan();
  }

  writeNow(): void {
    void this.writeSnapshot();
  }

  private registerEvents(): void {
    const vault = this.app.vault;
    const cache = this.app.metadataCache;
    const track = (ref: EventRef, emitter: { offref(ref: EventRef): void }): void => {
      // 生产路径：交给宿主 Component 统一登记与卸载；测试路径：手动登记。
      if (this.owner) this.owner.registerEvent(ref);
      else this.offs.push(() => emitter.offref(ref));
    };

    track(vault.on("create", (file) => this.queueUpsert(file)), vault);
    track(vault.on("modify", (file) => this.queueUpsert(file)), vault);
    track(vault.on("delete", (file) => this.queueRemove(file)), vault);
    track(
      vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)),
      vault,
    );
    // metadataCache.changed 在 rename 时不会触发，rename 已由 vault 事件单独处理。
    track(cache.on("changed", (file) => this.queueUpsert(file)), cache);
    track(cache.on("deleted", (file) => this.queueRemove(file)), cache);
    track(cache.on("resolved", () => void this.rescanMissing()), cache);
  }

  private isNoteFile(file: TAbstractFile): file is TFile {
    return (
      file instanceof TFile &&
      file.extension === "md" &&
      !file.path.startsWith(".obsidian/") &&
      !file.path.startsWith(".trash/")
    );
  }

  /**
   * P3：正文摘要只在必要时读取。frontmatter 已有摘要 → 不读正文；
   * index.json 缓存命中（mtime 与 algo 都没变）→ 复用摘要、不读正文；
   * 其余情况才分批 cachedRead()。
   */
  private async readRecord(file: TFile): Promise<ScannedRecord> {
    const cache = this.app.metadataCache.getFileCache(file);
    const cacheLike = toCacheLike(cache);
    const meta = {
      path: file.path,
      basename: file.basename,
      mtime: file.stat.mtime,
      size: file.stat.size,
    };
    const explicit = pickFrontmatterSummary(cacheLike?.frontmatter ?? null);
    const baseline = this.baseline?.notes[file.path] ?? null;
    let summary: string;

    if (explicit) {
      summary = explicit;
    } else {
      const cached: SummaryCacheEntry | null = baseline
        ? {
            mtime: baseline.mtime,
            algo: this.baseline?.algo ?? SUMMARY_ALGO,
            summary: baseline.summary,
          }
        : null;
      if (cached && !shouldRecompute(cached, meta.mtime)) {
        summary = cached.summary;
      } else {
        let body = "";
        try {
          body = await this.app.vault.cachedRead(file);
        } catch {
          body = "";
        }
        summary = summarize({ cache: cacheLike, body, basename: meta.basename });
      }
    }

    return {
      record: buildNoteRecord(meta, cacheLike, summary),
      needsMeta: cache === null,
    };
  }

  private queueUpsert(file: TAbstractFile): void {
    if (!this.isNoteFile(file)) return;
    this.pendingUpsert.add(file.path);
    this.pendingRemove.delete(file.path);
    this.scheduleFlush(FLUSH_DELAY);
  }

  private queueRemove(file: TAbstractFile): void {
    if (typeof file?.path !== "string" || !file.path.endsWith(".md")) return;
    this.pendingRemove.add(file.path);
    this.pendingUpsert.delete(file.path);
    this.missingCache.delete(file.path);
    this.scheduleFlush(FLUSH_DELAY);
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    if (oldPath.endsWith(".md")) {
      this.pendingRemove.add(oldPath);
      this.pendingUpsert.delete(oldPath);
      this.missingCache.delete(oldPath);
      const previous = this.records.get(oldPath);
      if (previous) {
        this.records.delete(oldPath);
        if (this.isNoteFile(file)) {
          this.records.set(file.path, {
            ...previous,
            path: file.path,
            title: file.basename,
          });
        }
      }
    }
    if (this.isNoteFile(file)) {
      this.pendingUpsert.add(file.path);
      this.onRename?.(oldPath, file.path, file.basename);
    }
    this.scheduleFlush(FLUSH_DELAY);
  }

  private async loadBaseline(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.indexPath)) {
        const text = await adapter.read(this.indexPath);
        this.baseline = normalizeSnapshot(JSON.parse(text) as unknown);
      } else {
        this.baseline = null;
      }
    } catch {
      // index.json 是可重建的派生数据：损坏/不可读时按首次索引处理。
      this.baseline = null;
    }
    this.baselineLoaded = true;
  }

  private async fullScan(): Promise<void> {
    if (this.disposed) return;
    if (this.scanSignal) this.scanSignal.aborted = true;
    const signal: ScanSignal = { aborted: false };
    this.scanSignal = signal;
    this.lastProgressEmit = 0;
    this.status = {
      ...emptyStatus(this.indexPath),
      phase: "scanning",
      lastWriteAt: this.status.lastWriteAt,
    };
    this.emit();

    try {
      if (!this.baselineLoaded) await this.loadBaseline();
      if (signal.aborted || this.disposed) return;

      const files = this.app.vault
        .getMarkdownFiles()
        .filter((file) => this.isNoteFile(file));
      const result = await scanInBatches<TFile, ScannedRecord>(
        files,
        (file) => this.readRecord(file),
        {
          batchSize: BATCH_SIZE,
          concurrency: CONCURRENCY,
          signal,
          onProgress: (done, total) => {
            this.status.indexed = done;
            this.status.total = total;
            if (done === total || done - this.lastProgressEmit >= 300) {
              this.lastProgressEmit = done;
              this.emit();
            }
          },
        },
      );
      if (signal.aborted || this.disposed) return;

      const notes: Record<string, NoteRecord> = {};
      this.missingCache.clear();
      for (const item of result.items) {
        notes[item.record.path] = item.record;
        if (item.needsMeta) this.missingCache.add(item.record.path);
      }
      this.records = new Map(Object.entries(notes));
      this.recompute();
      this.status = {
        ...this.status,
        phase: "ready",
        total: files.length,
        indexed: this.records.size,
        durationMs: result.durationMs,
        yields: result.yields,
        cacheMisses: this.missingCache.size,
        diff: this.diff,
      };
      this.emit();
      this.scheduleWrite(WRITE_DELAY);
      if (this.pendingUpsert.size || this.pendingRemove.size) {
        this.scheduleFlush(0);
      }
    } catch (error) {
      this.status = {
        ...this.status,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit();
    }
  }

  /** metadataCache 全部解析完成后，只补扫缓存缺失的文件，不做全量重扫。 */
  private async rescanMissing(): Promise<void> {
    if (this.disposed || this.status.phase !== "ready" || this.missingCache.size === 0) {
      return;
    }
    let changed = false;
    for (const path of [...this.missingCache]) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const item = await this.readRecord(file);
      if (item.needsMeta) continue;
      this.records.set(path, item.record);
      this.missingCache.delete(path);
      changed = true;
    }
    if (!changed) return;
    this.status.cacheMisses = this.missingCache.size;
    this.recompute();
    this.emit();
    this.scheduleWrite(WRITE_DELAY);
  }

  private scheduleFlush(delay: number): void {
    if (this.disposed) return;
    this.clearFlushTimer();
    this.flushTimer = globalThis.setTimeout(() => {
      this.flushTimer = null;
      void this.flushPending();
    }, delay);
  }

  private async flushPending(): Promise<void> {
    this.clearFlushTimer();
    if (this.disposed) return;
    if (this.status.phase === "scanning") {
      this.scheduleFlush(300);
      return;
    }
    const upserts = [...this.pendingUpsert];
    const removes = [...this.pendingRemove];
    this.pendingUpsert.clear();
    this.pendingRemove.clear();
    if (!upserts.length && !removes.length) return;

    for (const path of removes) {
      this.records.delete(path);
      this.missingCache.delete(path);
    }
    for (const path of upserts) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        this.records.delete(path);
        this.missingCache.delete(path);
        continue;
      }
      const item = await this.readRecord(file);
      this.records.set(path, item.record);
      if (item.needsMeta) this.missingCache.add(path);
      else this.missingCache.delete(path);
    }

    this.status.indexed = this.records.size;
    this.status.total = this.records.size;
    this.status.cacheMisses = this.missingCache.size;
    this.recompute();
    this.emit();
    this.scheduleWrite(WRITE_DELAY);
  }

  private recompute(): void {
    const notes: Record<string, NoteRecord> = Object.fromEntries(this.records);
    this.diff = computeDiff(this.baseline, buildSnapshot(notes, SUMMARY_ALGO));
    this.status.diff = this.diff;
  }

  private scheduleWrite(delay: number): void {
    if (this.disposed) return;
    this.clearWriteTimer();
    this.writeTimer = globalThis.setTimeout(() => {
      this.writeTimer = null;
      void this.writeSnapshot();
    }, delay);
  }

  /** index.json 是可由 vault 重建的派生快照；用 adapter.write 避免触发 vault 的 md 事件回环。 */
  private async writeSnapshot(): Promise<void> {
    this.clearWriteTimer();
    if (this.disposed || this.status.phase !== "ready") return;
    try {
      const notes: Record<string, NoteRecord> = Object.fromEntries(this.records);
      const adapter = this.app.vault.adapter;
      const dir = parentDir(this.indexPath);
      if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(
        this.indexPath,
        serializeSnapshot(buildSnapshot(notes, SUMMARY_ALGO)),
      );
      this.status.lastWriteAt = Date.now();
      this.emit();
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : String(error);
      this.emit();
    }
  }

  private emit(): void {
    const snapshot = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[knowledge-workbench] index listener failed", error);
      }
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      globalThis.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private clearWriteTimer(): void {
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  /** 卸载插件：取消扫描、清理全部事件引用与定时器、清空订阅。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.scanSignal) this.scanSignal.aborted = true;
    this.clearFlushTimer();
    this.clearWriteTimer();
    // owner 存在时事件由 Component 在插件卸载时统一注销，此处不再重复 offref。
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.listeners.clear();
    this.pendingUpsert.clear();
    this.pendingRemove.clear();
    this.missingCache.clear();
  }
}
