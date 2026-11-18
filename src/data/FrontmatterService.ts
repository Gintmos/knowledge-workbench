import { TFile, type App } from "obsidian";

/**
 * 唯一一处「写回用户笔记」的入口。
 * 所有调用都必须由设置开关 + 用户主动执行的命令双重把关（默认全部关闭）。
 */
export class FrontmatterService {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  findFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  async writeReview(file: TFile, review: string, stage: number): Promise<void> {
    await this.app.fileManager.processFrontMatter(
      file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter["review"] = review;
        frontmatter["review-stage"] = stage;
      },
    );
  }

  async writeSummary(file: TFile, summary: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(
      file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter["kw-summary"] = summary;
      },
    );
  }

  /** v1.0.6：就地标记完成——写 status: done（逾期 / 到期项）。 */
  async writeStatus(file: TFile, status: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(
      file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter["status"] = status;
      },
    );
  }

  /** v1.0.6：快捷设置日期字段（due / review），统一 yyyy-mm-dd。 */
  async writeDateField(file: TFile, key: "due" | "review", value: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(
      file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter[key] = value;
      },
    );
  }

  /**
   * v1.0.6：批量重命名 / 合并标签。把 frontmatter.tags 中命中源标签（含可选子标签）
   * 的项改写为目标标签并去重；兼容数组与逗号/空格分隔字符串两种形态。
   * 正文内联 #tag 不在本方法范围（由调用方按需单独处理）。
   */
  async rewriteTags(
    file: TFile,
    sources: string[],
    target: string,
    includeChildren: boolean,
  ): Promise<boolean> {
    const normalizedSources = new Set(sources.map((s) => normalizeTagKey(s)));
    let changed = false;
    await this.app.fileManager.processFrontMatter(
      file,
      (frontmatter: Record<string, unknown>) => {
        const raw = frontmatter["tags"];
        if (raw === undefined || raw === null) return;
        const values = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
        const next: string[] = [];
        const seen = new Set<string>();
        for (const item of values) {
          const text = typeof item === "string" ? item.trim() : "";
          if (!text) continue;
          const key = normalizeTagKey(text);
          const matched = normalizedSources.has(key) ||
            (includeChildren && [...normalizedSources].some((s) => key.startsWith(`${s}/`)));
          const replacement = matched ? target : text;
          const dedupKey = normalizeTagKey(replacement);
          if (seen.has(dedupKey)) {
            changed = true;
            continue;
          }
          seen.add(dedupKey);
          if (replacement !== text) changed = true;
          next.push(replacement);
        }
        if (changed) frontmatter["tags"] = next;
      },
    );
    return changed;
  }
}

/** 标签归一化：去前导 #、统一大小写比较用（保留原值写入）。 */
function normalizeTagKey(tag: string): string {
  return tag.trim().replace(/^#+/, "").toLowerCase();
}
