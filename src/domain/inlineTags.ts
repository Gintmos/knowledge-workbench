/**
 * 正文内联 #标签 替换（纯函数、零依赖，便于 node 单测）。
 * 复审 V2 · P1-1：原 main.ts 逐行实现按行数而非 `---` 定界计数，
 * `inFrontmatter` 置位后永远无法翻回，导致带 frontmatter 笔记正文
 * 一个内联标签都不替换且恒报成功。此处改为与 stripFrontmatter 同一
 * 定界规则先整体拆分，再对正文做行级替换。
 *
 * 保护规则：
 *  - frontmatter 区原样保留（YAML 行内 `#` 注释不误伤）；
 *  - 代码块（``` / ~~~ 开合）内不替换；
 *  - wiki 链接 [[笔记#锚点]] 与 Markdown 链接 [文字](url#锚点) 内的
 *    `#` 是链接锚点而非标签，不替换；
 *  - 子标签（父/子）按 includeChildren 处理并保留后缀。
 */

const FRONT_MATTER_END = /^\s*(---|\.\.\.)\s*$/;
const FENCE = /^\s*(```|~~~)/;
/** 捕获组交替分割：奇数下标是链接片段（不参与替换），偶数下标是普通文本。 */
const LINK_SPLIT = /(!?\[\[[^\]]*\]\]|!?\[[^\]]*\]\([^)]*\))/g;
const INLINE_TAG = /#([\w\u4e00-\u9fa5/-]+)/g;

export interface FrontmatterSplit {
  /** frontmatter 行（含首尾 `---`）；无 frontmatter 时为空数组。 */
  frontmatter: string[];
  /** frontmatter 之后的正文行。 */
  body: string[];
}

/** 拆出 frontmatter 与正文；首个 `---` 未闭合时整体视为正文（与宿主判定一致）。 */
export function splitFrontmatterLines(text: string): FrontmatterSplit {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { frontmatter: [], body: lines };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONT_MATTER_END.test(lines[index])) {
      return { frontmatter: lines.slice(0, index + 1), body: lines.slice(index + 1) };
    }
  }
  return { frontmatter: [], body: lines };
}

/**
 * 在正文里把 sources 标签替换为 target；返回替换后的完整文本
 * （含原 frontmatter）。没有命中时返回与原文等价的内容（换行统一为 \n）。
 */
export function replaceInlineTags(
  text: string,
  sources: string[],
  target: string,
  includeChildren: boolean,
): string {
  const { frontmatter, body } = splitFrontmatterLines(text);
  const sourceLower = sources.map((s) => s.replace(/^#/, "").toLowerCase());
  let inFence = false;
  const nextBody = body.map((raw) => {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      return raw;
    }
    if (inFence) return raw;
    return raw
      .split(LINK_SPLIT)
      .map((segment, index) =>
        index % 2 === 1
          ? segment
          : segment.replace(INLINE_TAG, (full, tagText: string) => {
              const key = tagText.toLowerCase();
              const hit =
                sourceLower.includes(key) ||
                (includeChildren && sourceLower.some((s) => key.startsWith(`${s}/`)));
              if (!hit) return full;
              const suffix =
                includeChildren && key.includes("/")
                  ? `/${key.slice(key.indexOf("/") + 1)}`
                  : "";
              return `#${target}${suffix}`;
            }),
      )
      .join("");
  });
  return [...frontmatter, ...nextBody].join("\n");
}
