import { sortHistory } from "../domain/uiModel";
import type { HistoryEntry } from "../types";

/**
 * 浏览历史：由宿主的 file-open 自动采集，最新在前、同一路径去重、最多 20 篇。
 * 独立页签；标题即入口，打开带朗读的原文窗口（窗口内有「在 Obsidian 中打开」）。
 * v1.0.2 起不再重复提供「打开原文」按钮。
 */
export class HistoryView {
  constructor(
    private readonly parent: HTMLElement,
    private readonly onOpen: (path: string) => void,
  ) {}

  render(entries: HistoryEntry[]): void {
    this.parent.empty();
    const list = sortHistory(entries);
    this.parent.createDiv({
      cls: "kw-card-title",
      text: `最近浏览（${list.length} 篇）`,
    });
    if (!list.length) {
      this.parent.createDiv({
        cls: "kw-hint",
        text: "打开任意 Markdown 笔记后会自动记录，最新在前，最多保留 20 篇。",
      });
      return;
    }
    const box = this.parent.createDiv({ cls: "kw-detail kw-history" });
    for (const entry of list) {
      const row = box.createDiv({ cls: "kw-note-row" });
      const link = row.createEl("a", {
        cls: "kw-note-link",
        text: entry.title || entry.path,
      });
      link.setAttr("href", "#");
      link.setAttr("aria-label", `打开「${entry.title || entry.path}」的原文窗口`);
      link.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        this.onOpen(entry.path);
      });
      row.createDiv({
        cls: "kw-note-meta",
        text: `${new Date(entry.at).toLocaleString("zh-CN")} · ${entry.path}`,
      });
    }
  }
}
