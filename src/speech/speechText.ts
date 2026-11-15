/**
 * P5 朗读文本：复用 P3 的同一套 Markdown 清洗规则，但保留标题文字与表格数据行。
 * v14 真实笔记噪声来源（表格分隔行 :---、emoji、[[笔记#章节]] 锚点）由清洗层处理；
 * 这里只负责「md → 可朗读的纯文本段落」，分块队列在 chunks.ts。
 */
import { cleanMarkdownLine, stripFrontmatter } from "../domain/speechText";

const FENCE = /^\s*(```|~~~)/;

/**
 * 与 P3 的 mdToPlainText 区别：
 * - 标题行保留文字（只去掉 # 前缀），不整行丢弃；
 * - 表格数据行保留文字，单元格用「，」连接；分隔行仍跳过；
 * - 段落之间用 \n 分隔，供分块器作为优先切分点。
 */
export function mdToSpeechText(md: string): string {
  const body = stripFrontmatter(md);
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inCode = false;

  const flush = (): void => {
    if (current.length) {
      paragraphs.push(current.join(" ").trim());
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
    const cleaned = cleanMarkdownLine(raw, { keepTableRows: true });
    if (!cleaned) {
      flush();
      continue;
    }
    current.push(cleaned);
  }
  flush();
  return paragraphs.filter(Boolean).join("\n");
}
