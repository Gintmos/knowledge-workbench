import {
  chartGeometry,
  type ChartGeometry,
  type ChartOptions,
} from "../domain/uiModel";
import type { ChartSlice } from "../types";

/**
 * 内联 SVG 全量柱状图：零外部依赖，颜色全部由 styles.css 的主题变量提供。
 * 几何计算来自纯函数 chartGeometry；所有分类都出柱，总宽超过容器时横向滚动。
 *
 * 关键规范：createSvg 的 cls 只能是单个类名（宿主内部用 classList.add，
 * 含空格会抛 InvalidCharacterError 并中断整页渲染），多类名必须事后 add。
 */
export function renderChart(
  parent: HTMLElement,
  slices: ChartSlice[],
  activeKey: string | null,
  onSelect: (key: string | null) => void,
  options: ChartOptions = {},
): ChartGeometry {
  const geo = chartGeometry(slices, options);
  const svg = parent.createSvg("svg", { cls: "kw-chart" });
  svg.setAttribute("viewBox", `0 0 ${geo.width} ${geo.height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `全量分类柱状图，共 ${geo.bars.length} 根柱子，可横向滚动；点击柱子查看该分类笔记`,
  );
  // 明确像素宽度，避免 SVG 被容器压扁导致所有柱子挤在一起。
  svg.style.width = `${geo.width}px`;
  svg.style.height = `${geo.height}px`;

  const axis = svg.createSvg("line", { cls: "kw-chart-axis" });
  axis.setAttribute("x1", "0");
  axis.setAttribute("y1", String(geo.plotBottom));
  axis.setAttribute("x2", String(geo.width));
  axis.setAttribute("y2", String(geo.plotBottom));

  for (const bar of geo.bars) {
    const group = svg.createSvg("g", { cls: "kw-chart-col" });
    if (activeKey === bar.key) group.classList.add("is-active");
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", "0");
    group.setAttribute("aria-label", `${bar.key}，${bar.count} 篇，点击查看笔记清单`);

    const rect = group.createSvg("rect", { cls: "kw-chart-bar" });
    rect.setAttribute("x", String(bar.x));
    rect.setAttribute("y", String(bar.y));
    rect.setAttribute("width", String(bar.width));
    rect.setAttribute("height", String(bar.height));
    rect.setAttribute("rx", "2");

    const tip = group.createSvg("title");
    tip.textContent = `${bar.key} · ${bar.count} 篇（点击查看笔记清单）`;

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
  return geo;
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
