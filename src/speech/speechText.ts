/**
 * P5 朗读文本：复用 P3 的同一套 Markdown 清洗规则，但保留标题文字与表格数据行。
 * v1.0.1 口语化：标题后补句号、相邻行用中文逗号连接，让系统 TTS 有自然停顿，
 * 而不是把逐行文字用 ASCII 空格拼成一串机械的长句。
 */
import { cleanMarkdownLine, stripFrontmatter } from "../domain/speechText";

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const ENDS_WITH_PAUSE = /[。！？!?…；;，,、：:]$/;

/**
 * 与 P3 的 mdToPlainText 区别：
 * - 标题行保留文字（只去掉 # 前缀），并在末尾补句号；
 * - 表格数据行保留文字，单元格用「，」连接；分隔行仍跳过；
 * - 同一段落的相邻行用「，」连接，段落之间用 \n 分隔。
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
    const cleaned = cleanMarkdownLine(raw, { keepTableRows: true });
    if (!cleaned) {
      flush();
      continue;
    }
    current.push(HEADING.test(raw) ? `${cleaned}。` : cleaned);
  }
  flush();
  return paragraphs.filter(Boolean).join("\n");
}
