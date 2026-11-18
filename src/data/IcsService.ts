import type { App } from "obsidian";
import { buildIcsEvents, renderIcs } from "../domain/ics";
import { todayString } from "../domain/TaskService";
import type { IcsState, TodayItem, WorkbenchSettings } from "../types";

export interface IcsServiceOptions {
  mobile: boolean;
  getSettings: () => WorkbenchSettings;
  onChange: (state: IcsState) => void;
  writeDelay?: number;
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * 把今日待办 / 复习 / 催办项写成 vault 内的 .ics（含 VALARM 提前 1 天）。
 * 提醒最终由系统日历触发，插件不常驻后台；手机端只写库内，由界面提示导入方式。
 */
export class IcsService {
  private readonly app: App;
  private readonly options: IcsServiceOptions;
  private items: TodayItem[] = [];
  private day = "";
  private state: IcsState;
  private lastText = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(app: App, options: IcsServiceOptions) {
    this.app = app;
    this.options = options;
    const settings = options.getSettings();
    this.state = {
      enabled: settings.icsEnabled,
      mobile: options.mobile,
      events: 0,
      path: settings.icsPath,
      lastWriteAt: null,
      error: null,
    };
  }

  configure(settings: WorkbenchSettings): void {
    this.state = {
      ...this.state,
      enabled: settings.icsEnabled,
      path: settings.icsPath,
      mobile: this.options.mobile,
    };
  }

  setItems(items: TodayItem[], day: string): void {
    this.items = items;
    this.day = day;
  }

  getState(): IcsState {
    return { ...this.state };
  }

  getText(): string {
    return this.lastText;
  }

  schedule(): void {
    if (this.disposed || !this.state.enabled) return;
    this.clearTimer();
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.rebuild();
    }, this.options.writeDelay ?? 2000);
  }

  /** 立即重建并写入 vault；生成内容是纯函数，失败只记录错误、不抛给宿主。 */
  async rebuild(): Promise<void> {
    this.clearTimer();
    if (this.disposed) return;
    this.configure(this.options.getSettings());
    if (!this.state.enabled) {
      this.emit();
      return;
    }
    try {
      const today = this.day || todayString();
      const events = buildIcsEvents(this.items, today);
      const text = renderIcs(events);
      this.lastText = text;
      const adapter = this.app.vault.adapter;
      const dir = parentDir(this.state.path);
      if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(this.state.path, text);
      this.state = {
        ...this.state,
        events: events.length,
        lastWriteAt: Date.now(),
        error: null,
      };
    } catch (error) {
      this.state = {
        ...this.state,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.items = [];
  }

  private emit(): void {
    this.options.onChange(this.getState());
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
