import { barWidthPercent } from "../domain/uiModel";

/**
 * 统计卡片下半部分的列表内横向条形图（v1.0.2）。
 * 不再绘制上方纵向 SVG 柱状图：每一行一条，宽度与该卡片最大值成比例。
 * 颜色全部来自 styles.css 的主题变量，不拼接 HTML、不引入外部依赖。
 * 条形与名称链接等价：可点击、可键盘操作，展开该分类的笔记清单。
 */
export function renderBarMeter(
  parent: HTMLElement,
  options: {
    count: number;
    max: number;
    label: string;
    onSelect: () => void;
  },
): HTMLElement {
  const meter = parent.createDiv({ cls: "kw-count-bar" });
  meter.setAttr("role", "button");
  meter.setAttr("tabindex", "0");
  meter.setAttr(
    "aria-label",
    `${options.label}，${options.count} 篇，点击查看笔记清单`,
  );
  const fill = meter.createDiv({ cls: "kw-count-bar-fill" });
  fill.style.width = `${barWidthPercent(options.count, options.max)}%`;

  const select = (): void => options.onSelect();
  meter.addEventListener("click", select);
  meter.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  });
  return meter;
}

/**
 * 明细区域的「可滚动 + 可拖动」：鼠标按住拖动改变 scrollTop，
 * 触屏保留浏览器原生滚动，链接与按钮不拦截。手机端同样可用。
 */
export function enableDragScroll(el: HTMLElement): void {
  el.classList.add("kw-drag-scroll");
  let dragging = false;
  let startY = 0;
  let startTop = 0;

  el.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("a, button, input, textarea")) return;
    dragging = true;
    startY = event.clientY;
    startTop = el.scrollTop;
    el.classList.add("is-dragging");
  });

  el.addEventListener("pointermove", (event: PointerEvent) => {
    if (!dragging) return;
    el.scrollTop = startTop - (event.clientY - startY);
  });

  const finish = (): void => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("is-dragging");
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
  el.addEventListener("pointerleave", finish);
}
