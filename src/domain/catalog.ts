import type { ClassifyBy, NoteRecord } from "../types";
import { primaryCategory } from "./ClassifierService";

/** Obsidian wiki 链接里的特殊字符转义，保证路径可被正确解析。 */
function wikiTarget(path: string): string {
  return path.replace(/\.md$/, "").replace(/\|/g, "\\|");
}

function safeLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
}

/**
 * 生成「笔记目录」Markdown：按主分类分组，每条含标题（wiki 链接直达原文）、
 * 标签、日期字段与规则摘要。纯函数、零依赖，可在 node 单测里直接断言。
 */
export function renderCatalog(
  notes: NoteRecord[],
  classifyBy: ClassifyBy,
  generatedAt = new Date(),
): string {
  const groups = new Map<string, NoteRecord[]>();
  for (const note of notes) {
    const key = primaryCategory(note, classifyBy);
    const list = groups.get(key) ?? [];
    list.push(note);
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const lines: string[] = [
    "# 笔记目录",
    "",
    `> 由知识管理工作台生成于 ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC · 共 ${notes.length} 篇 · 分类维度：${classifyBy === "folder" ? "文件夹" : "标签"}`,
    ">",
    "> 本文件是可重建的派生目录；点标题可在 Obsidian 内打开原文。",
    "",
  ];

  if (!notes.length) {
    lines.push("尚无已索引的笔记。");
    return `${lines.join("\n")}\n`;
  }

  for (const key of keys) {
    const list = groups.get(key) ?? [];
    lines.push(`## ${safeLine(key)}（${list.length} 篇）`, "");
    list.sort((a, b) =>
      a.title < b.title ? -1 : a.title > b.title ? 1 : 0,
    );
    for (const note of list) {
      const title = safeLine(note.title) || note.path;
      lines.push(`- [[${wikiTarget(note.path)}\\|${title}]]`);
      const tags = note.tags.length ? note.tags.map((t) => `#${t}`).join(" ") : "—";
      const dates: string[] = [];
      if (note.due) dates.push(`到期 ${note.due}`);
      if (note.review) dates.push(`复习 ${note.review}`);
      if (note.updated) dates.push(`更新 ${note.updated}`);
      lines.push(`  - 标签：${tags}`);
      lines.push(`  - 日期：${dates.length ? dates.join(" · ") : "—"}`);
      if (note.summary) lines.push(`  - 摘要：${safeLine(note.summary)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
