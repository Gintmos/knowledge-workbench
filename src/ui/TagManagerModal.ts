import { Modal, type App } from "obsidian";
import {
  listTagKeys,
  previewTagEdit,
  type TagEditPreview,
} from "../domain/tagEdit";
import type { NoteRecord } from "../types";

export interface TagManagerOptions {
  /** 当前索引的全部笔记记录。 */
  notes: () => NoteRecord[];
  /** 预览某个源标签重命名后的影响（target 传空表示只统计源）。 */
  onExecute: (
    sources: string[],
    target: string,
    includeChildren: boolean,
    replaceInline: boolean,
  ) => Promise<void>;
  /** 初始预选的标签（从统计页「管理」入口进入时带入）。 */
  initialTag?: string;
}

/**
 * 批量重命名 / 合并标签弹窗：源标签（可多个）、目标标签、是否含子标签、
 * 是否替换正文内联 #标签；执行前展示影响范围并要求二次确认。
 */
export class TagManagerModal extends Modal {
  private readonly options: TagManagerOptions;
  private sources: string[] = [];
  private target = "";
  private includeChildren = true;
  private replaceInline = false;
  private previewEl?: HTMLElement;

  constructor(app: App, options: TagManagerOptions) {
    super(app);
    this.options = options;
    this.sources = options.initialTag ? [options.initialTag.replace(/^#/, "")] : [];
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.classList.add("kw-tag-modal");
    contentEl.createEl("h2", { text: "管理标签" });
    contentEl.createDiv({
      cls: "kw-hint",
      text: "批量重命名或合并标签。修改会写进相关笔记的 frontmatter，执行前请确认已备份。",
    });

    const tagList = listTagKeys(this.options.notes());
    const available = new Set(tagList.map((item) => item.key));
    if (this.sources.length && !available.has(this.sources[0])) {
      this.sources = [];
    }

    // 源标签多选。
    contentEl.createDiv({ cls: "kw-tag-section", text: "源标签（可多选，合并时选多个）" });
    const sourceBox = contentEl.createDiv({ cls: "kw-tag-choices" });
    if (!tagList.length) {
      sourceBox.createDiv({ cls: "kw-empty", text: "尚无标签。" });
    }
    for (const item of tagList) {
      const chip = sourceBox.createEl("button", {
        cls: "kw-tag-chip",
        text: `#${item.key} · ${item.count}`,
      });
      chip.setAttr("type", "button");
      const sync = () =>
        chip.classList.toggle(
          "is-selected",
          this.sources.includes(item.key),
        );
      sync();
      chip.addEventListener("click", () => {
        if (this.sources.includes(item.key)) {
          this.sources = this.sources.filter((s) => s !== item.key);
        } else {
          this.sources = [...this.sources, item.key];
        }
        sync();
        this.refreshPreview();
      });
    }

    // 目标标签输入。
    contentEl.createDiv({ cls: "kw-tag-section", text: "新名称 / 目标标签" });
    const targetInput = contentEl.createEl("input", {
      cls: "kw-tag-target",
      attr: { type: "text", placeholder: "例如：行业观察" },
    });
    targetInput.value = this.target;
    targetInput.addEventListener("input", () => {
      this.target = targetInput.value;
      this.refreshPreview();
    });

    // 选项。
    const childrenRow = contentEl.createDiv({ cls: "kw-tag-option" });
    const children = childrenRow.createEl("input", {
      attr: { type: "checkbox", id: "kw-include-children" },
    });
    children.checked = this.includeChildren;
    children.addEventListener("change", () => {
      this.includeChildren = children.checked;
      this.refreshPreview();
    });
    childrenRow.createEl("label", {
      attr: { for: "kw-include-children" },
      text: "同时处理子标签（如 行业研究/汽车 → 行业观察/汽车）",
    });

    const inlineRow = contentEl.createDiv({ cls: "kw-tag-option" });
    const inline = inlineRow.createEl("input", {
      attr: { type: "checkbox", id: "kw-replace-inline" },
    });
    inline.checked = this.replaceInline;
    inline.addEventListener("change", () => {
      this.replaceInline = inline.checked;
    });
    inlineRow.createEl("label", {
      attr: { for: "kw-replace-inline" },
      text: "高风险：同时替换正文内联 #标签（可能误伤代码块，默认关闭）",
    });

    this.previewEl = contentEl.createDiv({ cls: "kw-tag-preview" });
    this.refreshPreview();

    const actions = contentEl.createDiv({ cls: "kw-tag-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.setAttr("type", "button");
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "mod-cta",
      text: "确认修改",
    });
    confirm.setAttr("type", "button");
    confirm.addEventListener("click", () => void this.confirm(targetInput));
  }

  private refreshPreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    const targetReady = this.target.trim().length > 0;
    if (!this.sources.length || !targetReady) {
      this.previewEl.createDiv({
        cls: "kw-hint",
        text: "请选择源标签并填写目标标签，以预览影响范围。",
      });
      return;
    }
    const preview: TagEditPreview = previewTagEdit(
      this.options.notes(),
      this.sources,
      this.target.trim(),
      this.includeChildren,
    );
    this.previewEl.createDiv({
      cls: "kw-tag-preview-title",
      text: `影响 ${preview.paths.length} 篇笔记 · 合并后「${this.target.trim()}」共 ${preview.targetTotal} 篇`,
    });
    const list = this.previewEl.createEl("ul", { cls: "kw-list" });
    for (const path of preview.paths.slice(0, 8)) {
      list.createEl("li", { text: path });
    }
    if (preview.paths.length > 8) {
      list.createEl("li", {
        text: `另有 ${preview.paths.length - 8} 篇…`,
      });
    }
  }

  private async confirm(targetInput: HTMLInputElement): Promise<void> {
    const target = (this.target || targetInput.value).trim();
    if (!this.sources.length || !target) {
      return;
    }
    const preview = previewTagEdit(
      this.options.notes(),
      this.sources,
      target,
      this.includeChildren,
    );
    const ok = window.confirm(
      `将修改 ${preview.paths.length} 篇笔记的标签：\n${this.sources.map((s) => `#${s}`).join("、")} → #${target}\n\n此操作会写入笔记，确认继续？`,
    );
    if (!ok) return;
    await this.options.onExecute(
      this.sources,
      target,
      this.includeChildren,
      this.replaceInline,
    );
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
