import { chartGeometry, type ChartOptions } from "../domain/uiModel";
import type { ChartSlice } from "../types";

/**
 * 内联 SVG 柱状图：零外部依赖，颜色全部由 styles.css 的主题变量提供。
 * 几何计算来自纯函数 chartGeometry，便于单测验证「文字不重叠、柱数 ≤ 10」。
 */
export function renderChart(
  parent: HTMLElement,
  slices: ChartSlice[],
  activeKey: string | null,
  onSelect: (key: string | null) => void,
  options: ChartOptions = {},
): void {
  const geo = chartGeometry(slices, options);
  const svg = parent.createSvg("svg", { cls: "kw-chart" });
  svg.setAttribute("viewBox", `0 0 ${geo.width} ${geo.height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `分类统计柱状图，共 ${geo.bars.length} 根柱子`);

  const axis = svg.createSvg("line", { cls: "kw-chart-axis" });
  axis.setAttribute("x1", "0");
  axis.setAttribute("y1", String(geo.plotBottom));
  axis.setAttribute("x2", String(geo.width));
  axis.setAttribute("y2", String(geo.plotBottom));

  for (const bar of geo.bars) {
    const cls = activeKey === bar.key ? "kw-chart-col is-active" : "kw-chart-col";
    const group = svg.createSvg("g", { cls });
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", "0");

    const rect = group.createSvg("rect", { cls: "kw-chart-bar" });
    rect.setAttribute("x", String(bar.x));
    rect.setAttribute("y", String(bar.y));
    rect.setAttribute("width", String(bar.width));
    rect.setAttribute("height", String(bar.height));
    rect.setAttribute("rx", "2");

    const tip = group.createSvg("title");
    tip.textContent = `${bar.key} · ${bar.count} 篇（点击筛选）`;

    const value = group.createSvg("text", { cls: "kw-chart-value" });
    value.setAttribute("x", String(bar.centerX));
    value.setAttribute("y", String(bar.valueY));
    value.setAttribute("text-anchor", "middle");
    value.textContent = String(bar.count);

    const label = group.createSvg("text", { cls: "kw-chart-label" });
    label.setAttribute("x", String(bar.centerX));
    label.setAttribute("y", String(bar.labelY));
    label.setAttribute("text-anchor", "middle");
    label.textContent = bar.label;

    const select = (): void => onSelect(activeKey === bar.key ? null : bar.key);
    group.addEventListener("click", select);
    group.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  }
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
