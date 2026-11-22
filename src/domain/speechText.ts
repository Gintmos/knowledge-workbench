/**
 * P3 摘要与 P5 朗读共用的 Markdown 清洗规则（纯函数、零依赖）。
 * v14 真实笔记噪音来源：表格分隔行 `:---`、emoji、Obsidian 标题锚点 `笔记#章节`。
 * 这里只做「md → 干净文本」，不做分块队列 / SP 状态机（留给 P5）。
 */

const FRONT_MATTER_END = /^\s*(---|\.\.\.)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const HORIZONTAL_RULE = /^\s*([-*_]\s*){3,}$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const LIST_PREFIX = /^\s{0,3}(?:>\s*)?(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/;
// 拆成两条「非字符类」正则，避免把 ZWJ / 变体选择符与 emoji 放进同一字符类。
const EMOJI = /\p{Extended_Pictographic}/gu;
const EMOJI_MODIFIER = /\uFE0F|\u200D|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}/gu;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const ANCHOR_OR_TAG = /#[\p{L}\p{N}/_-]+/gu;
const WIKI_LINK = /!?\[\[([^\]]+)\]\]/g;
const MD_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s)]+/g;
const INLINE_CODE = /`([^`]+)`/g;
const HTML_TAG = /<[^>]+>/g;
const OB_COMMENT = /%%[^%]*%%/g;
const BLOCK_ID = /\s\^[\w-]+\s*$/;
const CALLOUT = /^\s*\[!\w+\]\s*/;
const DECORATION = /[*_~]/g;

function wikiTarget(raw: string): string {
  const withoutEmbed = raw.replace(/^!/, "");
  // 先取别名，再去标题锚点；否则 [[笔记#章节|别名]] 的别名会被一起丢掉。
  const parts = withoutEmbed.split("|");
  const alias = parts.length > 1 ? parts[1] : parts[0];
  return alias.split("#")[0].trim();
}

/** 去掉 YAML frontmatter；不是以 `---` 开头时原样返回。 */
export function stripFrontmatter(md: string): string {
  const lines = md.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return md;
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONT_MATTER_END.test(lines[index])) {
      return lines.slice(index + 1).join("\n");
    }
  }
  return md;
}

export interface CleanLineOptions {
  /**
   * P5 朗读专用：表格分隔行仍是噪音，但表格数据行要保留文字，
   * 否则验收里的「不丢字」不成立。P3 摘要保持默认（整行跳过）。
   */
  keepTableRows?: boolean;
}

/** 单行清洗：返回空串表示该行是噪音，应被跳过。 */
export function cleanMarkdownLine(raw: string, options: CleanLineOptions = {}): string {
  let line = raw
    .replace(ZERO_WIDTH, "")
    .replace(EMOJI, "")
    .replace(EMOJI_MODIFIER, "");
  if (!line.trim()) return "";
  if (FENCE.test(line) || HORIZONTAL_RULE.test(line) || TABLE_SEPARATOR.test(line)) return "";
  if (/^\s*<!--/.test(line)) return "";
  if (/^\s*\|/.test(line)) {
    if (!options.keepTableRows) return ""; // 表格数据行：既不朗读也不做摘要段落
    // 表格单元格两侧的对齐空格会让 TTS 读出「维度 ， 内容」这类断续停顿；
    // 去掉空格、用逗号连接，既保留逐格文字（摘要与朗读验收都要求不丢字），
    // 又不会在单元格边界制造多余的停顿。
    line = line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim())
      .join("，");
  }
  line = line
    .replace(OB_COMMENT, "")
    .replace(MD_LINK, (_match, text: string) => text)
    .replace(WIKI_LINK, (_match, target: string) => wikiTarget(target))
    .replace(BARE_URL, "")
    .replace(INLINE_CODE, "$1")
    .replace(HTML_TAG, "")
    .replace(CALLOUT, "")
    .replace(BLOCK_ID, "")
    .replace(/^\s*>\s*/, "")
    .replace(LIST_PREFIX, "")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(ANCHOR_OR_TAG, "")
    .replace(DECORATION, "")
    .replace(/\\([\\`*_{}[\]()#+.!-])/g, "$1");

  line = line.replace(/\s+/g, " ").trim();
  if (!line || /^[\s\p{P}\p{S}]+$/u.test(line)) return "";
  return line;
}

/** md → 段落数组：跳过 frontmatter、代码块、表格、标题与装饰行。 */
export function toParagraphs(md: string): string[] {
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
    const isHeading = HEADING.test(raw);
    const cleaned = cleanMarkdownLine(raw);
    if (isHeading || !cleaned) {
      flush();
      continue;
    }
    current.push(cleaned);
  }
  flush();
  return paragraphs.filter(Boolean);
}

/**
 * 正文首个「非标题、非 frontmatter、非空」段落。
 * 太短的前导段落（如「注：」「见下」）会被跳过，最多向前看 maxScan 段。
 */
export function firstMeaningfulParagraph(md: string, minLength = 12, maxScan = 6): string {
  const paragraphs = toParagraphs(md);
  if (!paragraphs.length) return "";
  let best = "";
  for (const paragraph of paragraphs.slice(0, maxScan)) {
    if (paragraph.length > best.length) best = paragraph;
    if (paragraph.length >= minLength) return paragraph;
  }
  return best;
}

/** P5 朗读文本可直接复用；此处只拼接段落，不做分块与状态机。 */
export function mdToPlainText(md: string): string {
  return toParagraphs(md).join("\n\n");
}
