/**
 * P5 朗读文本：复用 P3 的同一套 Markdown 清洗规则，但保留标题文字与表格数据行。
 *
 * v1.1 断句重构：此前把相邻行一律用「，」串成流水线，导致列表、表格、元数据
 * 被读成「标签：路径：…关联笔记：…创建时间：…」这类机械长句，且部分本地
 * 音素前端不识别标点停顿，听感极差。现在按语义块组织：
 * - 元数据行（🏷标签 / 📁路径 / 🔗关联笔记 / ⏰创建时间 等）整行跳过；
 * - 列表项、标题、表格行各自独立成句（行尾补句号），彼此用换行分隔而非逗号串联；
 * - 连续正文段落内部仍用逗号连接同一句话的换行，避免把一句话切碎；
 * - 段落之间保持单换行分隔（沿用既有契约，不产生空朗读段）。
 */
import { cleanMarkdownLine, stripFrontmatter } from "../domain/speechText";

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const LIST = /^\s{0,3}(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/;
const TABLE_ROW = /^\s*\|/;
const ENDS_WITH_PAUSE = /[。！？!?…；;，,、：:]$/;
/** 笔记顶部的 emoji 元数据行（Obsidian  templates / 人物库常见），非正文。 */
const META_LINE = /^\s*[\p{Extended_Pictographic}]\s*[^\p{Extended_Pictographic}]{0,4}[:：]/u;
/** 常见中文字段名 + 冒号开头且整行无明显句子标点的，也视为元数据（如「标签：#x #y」）。 */
const META_FIELD = /^\s*(标签|路径|关联笔记|创建时间|更新时间|分类|作者|来源|状态|别名)\s*[:：]/u;

/** 判断清洗后的行是否是无法朗读的元数据残留（如标签被删空后只剩「标签：」）。 */
function isMetadataRow(raw: string, cleaned: string): boolean {
  if (META_LINE.test(raw) || META_FIELD.test(raw)) return true;
  // 清洗后只剩「字段名：」或「字段名： 」且后面没有实质内容。
  if (/^\s*[\p{L}]{1,8}\s*[:：]\s*$/u.test(cleaned)) return true;
  return false;
}

/**
 * 与 P3 的 mdToPlainText 区别：
 * - 标题 / 列表 / 表格行独立成句，行尾补句号；
 * - 元数据行跳过；代码块跳过；
 * - 同一自然段的连续正文用「，」连接，段落之间用单个 \n 分隔。
 */
export function mdToSpeechText(md: string): string {
  const body = stripFrontmatter(md);
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inCode = false;

  const flush = (): void => {
    if (current.length) {
      let joined = "";
      for (const part of current) {
        joined += joined && !ENDS_WITH_PAUSE.test(joined) ? `，${part}` : part;
      }
      paragraphs.push(joined.trim());
      current = [];
    }
  };

  for (const raw of body.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      flush();
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    // 元数据行：整行跳过，不进入朗读文本。
    if (isMetadataRow(raw, cleanMarkdownLine(raw, { keepTableRows: true }))) {
      flush();
      continue;
    }

    const cleaned = cleanMarkdownLine(raw, { keepTableRows: true });
    if (!cleaned) {
      flush();
      continue;
    }

    // 标题、列表项、表格数据行：各自独立成句，避免被逗号串成流水线。
    if (HEADING.test(raw) || LIST.test(raw) || TABLE_ROW.test(raw)) {
      flush();
      const sentence = ENDS_WITH_PAUSE.test(cleaned) ? cleaned : `${cleaned}。`;
      paragraphs.push(sentence);
      continue;
    }

    current.push(cleaned);
  }
  flush();
  return paragraphs.filter(Boolean).join("\n");
}
