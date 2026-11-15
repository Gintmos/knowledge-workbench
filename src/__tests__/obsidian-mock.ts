/**
 * 仅用于 Node 单测的内存版 Obsidian 宿主（由 run-tests.mjs 注入替换）。
 * 不参与插件构建，不引入任何外部依赖。
 */
type Handler = (...args: unknown[]) => unknown;
type EventRefLike = { name: string; callback: Handler };

export class Emitter {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(name: string, callback: Handler): EventRefLike {
    let bucket = this.handlers.get(name);
    if (!bucket) {
      bucket = new Set();
      this.handlers.set(name, bucket);
    }
    bucket.add(callback);
    return { name, callback };
  }

  offref(ref: EventRefLike): void {
    this.handlers.get(ref.name)?.delete(ref.callback);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const callback of [...(this.handlers.get(name) ?? [])]) {
      callback(...args);
    }
  }

  handlerCount(): number {
    let total = 0;
    for (const bucket of this.handlers.values()) total += bucket.size;
    return total;
  }
}

export class TAbstractFile {
  path: string;

  constructor(path: string) {
    this.path = path;
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };

  constructor(path: string, mtime = 1000, size = 100) {
    super(path);
    const name = path.split("/").pop() ?? path;
    this.basename = name.replace(/\.md$/, "");
    this.extension = "md";
    this.stat = { ctime: mtime, mtime, size };
  }
}

export class MockVault extends Emitter {
  readonly files = new Map<string, TFile>();
  readonly store = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly bodies = new Map<string, string>();
  readCount = 0;

  readonly adapter = {
    exists: async (path: string): Promise<boolean> =>
      this.dirs.has(path) || this.store.has(path),
    read: async (path: string): Promise<string> => this.store.get(path) ?? "",
    write: async (path: string, data: string): Promise<void> => {
      this.store.set(path, data);
    },
    mkdir: async (path: string): Promise<void> => {
      this.dirs.add(path);
    },
  };

  /** P3：正文摘要按需读取，记录次数以验证缓存命中时不读正文。 */
  async cachedRead(file: TFile): Promise<string> {
    this.readCount += 1;
    return this.bodies.get(file.path) ?? "";
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()];
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(path) ?? null;
  }
}

/** P6：模拟 Obsidian Component，验证生产路径用 registerEvent() 登记事件。 */
export class MockComponent {
  readonly refs: unknown[] = [];

  registerEvent(ref: unknown): void {
    this.refs.push(ref);
  }
}

export class MockFileManager {
  readonly frontmatters = new Map<string, Record<string, unknown>>();
  readonly writes: Array<{ path: string; patch: Record<string, unknown> }> = [];

  async processFrontMatter(
    file: TFile,
    fn: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    const frontmatter = this.frontmatters.get(file.path) ?? {};
    fn(frontmatter);
    this.frontmatters.set(file.path, frontmatter);
    this.writes.push({ path: file.path, patch: { ...frontmatter } });
  }
}

export class MockMetadataCache extends Emitter {
  readonly caches = new Map<string, unknown>();

  getFileCache(file: TFile): unknown {
    return this.caches.get(file.path) ?? null;
  }
}

export interface MockApp {
  vault: MockVault;
  metadataCache: MockMetadataCache;
  fileManager: MockFileManager;
  workspace: { onLayoutReady: (callback: () => void) => void };
}

export function createMockApp(): MockApp {
  return {
    vault: new MockVault(),
    metadataCache: new MockMetadataCache(),
    fileManager: new MockFileManager(),
    workspace: { onLayoutReady: (callback) => callback() },
  };
}

export function addMockFile(
  app: MockApp,
  path: string,
  mtime: number,
  cache: unknown,
): TFile {
  const file = new TFile(path, mtime, 100);
  app.vault.files.set(path, file);
  app.metadataCache.caches.set(path, cache);
  return file;
}
