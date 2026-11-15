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
}
