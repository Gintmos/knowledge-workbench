import {
  Component,
  MarkdownRenderer,
  Modal,
  TFile,
  type App,
} from "obsidian";
import type { SpeechService } from "../data/SpeechService";
import { SpeechBar } from "./SpeechBar";

function formatFrontmatter(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface NoteModalOptions {
  speech?: SpeechService;
  /** 命令「朗读当前笔记」打开时自动开始播放。 */
  autoPlay?: boolean;
  /** 从设置读取：打开笔记时若有断点是否自动续读。 */
  autoResume?: () => boolean;
}

/**
 * 所有 Markdown 原文窗口的统一入口：交给宿主 MarkdownRenderer 渲染，
 * 用 Component 管理渲染子组件的生命周期，全程不拼接 HTML 字符串。
 * 内部链接显式接管，避免在弹窗里出现无响应的 [[wiki]] 链接。
 * P5：顶部挂一条朗读控制条，关闭窗口时停止语音并保存断点。
 */
export class NoteModal extends Modal {
  private readonly component = new Component();
  private readonly file: TFile;
  private readonly speech: SpeechService | null;
  private readonly autoPlay: boolean;
  private readonly autoResume: (() => boolean) | undefined;
  private speechBar?: SpeechBar;

  constructor(app: App, file: TFile, options: NoteModalOptions = {}) {
    super(app);
    this.file = file;
    this.speech = options.speech ?? null;
    this.autoPlay = options.autoPlay ?? false;
    this.autoResume = options.autoResume;
  }

  onOpen(): void {
    this.modalEl.classList.add("kw-note-modal");
    this.titleEl.setText(this.file.basename);
    this.component.load();
    if (this.speech) {
      this.speechBar = new SpeechBar(this.contentEl, {
        speech: this.speech,
        autoPlay: this.autoPlay,
        autoResume: this.autoResume,
      });
    }
    void this.renderBody();
  }

  onClose(): void {
    this.speechBar?.dispose();
    this.speechBar = undefined;
    this.component.unload();
    this.contentEl.empty();
  }

  private async renderBody(): Promise<void> {
    const host = this.contentEl.createDiv({ cls: "kw-modal-scroll" });

    const actions = host.createDiv({ cls: "kw-modal-actions" });
    const open = actions.createEl("button", { text: "在 Obsidian 中打开" });
    open.addEventListener("click", () => {
      void this.app.workspace.openLinkText(this.file.basename, this.file.path, false);
      this.close();
    });
    actions.createSpan({
      cls: "kw-hint",
      text: `来源：${this.file.path}`,
    });

    const frontmatter = host.createDiv({ cls: "kw-modal-frontmatter" });
    this.renderFrontmatter(frontmatter);

    const body = host.createDiv({ cls: "kw-modal-markdown" });
    let markdown = "";
    try {
      markdown = await this.app.vault.cachedRead(this.file);
    } catch {
      body.createDiv({ cls: "kw-hint", text: "无法读取该笔记，请直接打开原文查看。" });
      this.speechBar?.attach(this.file.path, this.file.basename, "");
      return;
    }
    this.speechBar?.attach(this.file.path, this.file.basename, markdown);
    try {
      await MarkdownRenderer.render(
        this.app,
        markdown,
        body,
        this.file.path,
        this.component,
      );
    } catch {
      body.createDiv({ cls: "kw-hint", text: "渲染失败，请直接打开笔记查看。" });
      return;
    }
    this.wireInternalLinks(body);
  }

  private renderFrontmatter(parent: HTMLElement): void {
    const frontmatter = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    if (!frontmatter) return;
    const keys = Object.keys(frontmatter).filter((key) => key !== "position");
    if (!keys.length) return;
    parent.createDiv({ cls: "kw-modal-section-title", text: "属性" });
    const grid = parent.createDiv({ cls: "kw-fm-grid" });
    for (const key of keys) {
      const row = grid.createDiv({ cls: "kw-fm-row" });
      row.createSpan({ cls: "kw-fm-key", text: key });
      row.createSpan({
        cls: "kw-fm-val",
        text: formatFrontmatter(frontmatter[key]),
      });
    }
  }

  private wireInternalLinks(root: HTMLElement): void {
    const anchors = root.querySelectorAll<HTMLAnchorElement>("a.internal-link");
    for (const anchor of Array.from(anchors)) {
      anchor.addEventListener(
        "click",
        (event: MouseEvent) => {
          const linktext =
            anchor.getAttribute("data-href") ??
            anchor.getAttribute("href") ??
            anchor.textContent ??
            "";
          if (!linktext) return;
          event.preventDefault();
          event.stopPropagation();
          void this.app.workspace.openLinkText(linktext, this.file.path, false);
          this.close();
        },
        true,
      );
    }
  }
}
