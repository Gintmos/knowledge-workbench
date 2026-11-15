/**
 * P5 朗读控制条：v14 的 speechBarHtml() + v15 的 role="slider" 可拖进度 / seekCommit()。
 * 只消费 SpeechSnapshot，不直接碰宿主语音 API；不支持时隐藏全部按钮，只留中文提示。
 */
import type { SpeechService } from "../data/SpeechService";
import { ratioForIndex, ratioFromPointer, seekFromRatio } from "../speech/machine";
import type { SpeechSnapshot, SpeechState } from "../speech/types";

const STATE_TEXT: Record<SpeechState, string> = {
  idle: "就绪",
  playing: "朗读中",
  paused: "已暂停",
  stopped: "已停止",
};

export interface SpeechBarOptions {
  speech: SpeechService;
  autoPlay?: boolean;
  autoResume?: () => boolean;
  /** 保存朗读稿到 vault，供 Android 交给系统「随选朗读」。 */
  onExport?: (text: string) => void;
}

export class SpeechBar {
  private readonly speech: SpeechService;
  private readonly autoPlay: boolean;
  private readonly autoResume: () => boolean;
  private readonly root: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly slider: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly engineEl: HTMLElement;
  private readonly fallbackEl: HTMLElement;
  private readonly onExport?: (text: string) => void;
  private unsubscribe?: () => void;
  private dragging = false;
  private previewRatio: number | null = null;
  private total = 0;
  private disposed = false;

  constructor(parent: HTMLElement, options: SpeechBarOptions) {
    this.speech = options.speech;
    this.autoPlay = options.autoPlay ?? false;
    this.autoResume = options.autoResume ?? (() => false);
    this.root = parent.createDiv({ cls: "kw-speech" });
    this.controls = this.root.createDiv({ cls: "kw-speech-controls" });

    const row = this.controls.createDiv({ cls: "kw-speech-row" });
    this.playBtn = row.createEl("button", { cls: "kw-speech-btn", text: "朗读" });
    this.pauseBtn = row.createEl("button", { cls: "kw-speech-btn", text: "暂停" });
    this.stopBtn = row.createEl("button", { cls: "kw-speech-btn", text: "停止" });
    this.countEl = row.createSpan({ cls: "kw-speech-count", text: "0 / 0 段" });
    this.stateEl = row.createSpan({ cls: "kw-speech-state", text: "就绪" });
    this.engineEl = row.createSpan({ cls: "kw-speech-engine", text: "" });

    this.slider = this.controls.createDiv({ cls: "kw-speech-slider" });
    this.slider.setAttr("role", "slider");
    this.slider.setAttr("tabindex", "0");
    this.slider.setAttr("aria-label", "朗读进度，可拖动或用方向键跳转");
    this.slider.setAttr("data-seek", "1");
    this.fill = this.slider.createDiv({ cls: "kw-speech-fill" });
    this.thumb = this.slider.createDiv({ cls: "kw-speech-thumb" });

    this.hintEl = this.root.createDiv({ cls: "kw-speech-hint" });
    this.onExport = options.onExport;
    this.fallbackEl = this.root.createDiv({ cls: "kw-speech-fallback" });
    this.fallbackEl.createDiv({
      cls: "kw-hint",
      text: "Android 的 WebView 通常不提供 Web Speech。要真人级语气，请在「设置 → 朗读」开启云端神经语音并填写服务地址与密钥；离线时可把朗读稿复制到剪贴板或保存到库内，再用系统「随选朗读 / 选择即朗读」发声。",
    });
    const fallbackRow = this.fallbackEl.createDiv({ cls: "kw-speech-row" });
    const copy = fallbackRow.createEl("button", {
      cls: "kw-speech-btn",
      text: "复制朗读稿",
    });
    copy.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(this.speech.getPlainText())
        .then(() => this.hintEl.setText("朗读稿已复制，可粘贴到系统朗读或笔记中。"))
        .catch(() => this.hintEl.setText("复制失败，请改用「保存朗读稿到库内」。"));
    });
    const save = fallbackRow.createEl("button", {
      cls: "kw-speech-btn",
      text: "保存朗读稿到库内",
    });
    save.addEventListener("click", () => {
      if (!this.onExport) {
        this.hintEl.setText("当前入口未提供保存能力，请改用复制。");
        return;
      }
      this.onExport(this.speech.getPlainText());
      this.hintEl.setText("已保存到「知识管理工作台/朗读稿」，可用系统朗读打开。");
    });

    this.playBtn.addEventListener("click", () => this.speech.play());
    this.pauseBtn.addEventListener("click", () => this.speech.pause());
    this.stopBtn.addEventListener("click", () => this.speech.stop(true));
    this.slider.addEventListener("pointerdown", this.onPointerDown);
    this.slider.addEventListener("pointermove", this.onPointerMove);
    this.slider.addEventListener("pointerup", this.onPointerUp);
    this.slider.addEventListener("pointercancel", this.onPointerCancel);
    this.slider.addEventListener("keydown", this.onKeyDown);

    this.unsubscribe = this.speech.subscribe((state) => this.render(state));
  }

  /** 绑定笔记：清洗分块 + 读断点；autoPlay / 自动续读由设置决定。 */
  attach(path: string, title: string, markdown: string): void {
    if (this.disposed) return;
    this.speech.prepare(path, title, markdown);
    if (this.autoPlay) this.speech.play(0);
    else if (this.autoResume() && this.speech.getSnapshot().resumable) {
      this.speech.play();
    }
  }

  private render(state: SpeechSnapshot): void {
    if (this.disposed) return;
    this.total = state.total;
    const available = state.supported && state.total > 0;
    // 能力不可用时隐藏整组控件，不留空白按钮。
    this.controls.classList.toggle("kw-hidden", !available);

    const at = state.total > 0 ? Math.min(state.idx + 1, state.total) : 0;
    this.countEl.setText(`${at} / ${state.total} 段`);
    this.stateEl.setText(STATE_TEXT[state.state]);
    this.stateEl.classList.toggle("is-playing", state.state === "playing");

    this.playBtn.setText(
      state.state === "paused"
        ? "继续朗读"
        : state.resumable
          ? "从断点续读"
          : "朗读",
    );
    this.playBtn.disabled = !available || state.state === "playing";
    this.pauseBtn.disabled = state.state !== "playing";
    this.stopBtn.disabled = !available;

    this.slider.setAttr("aria-valuemin", "0");
    this.slider.setAttr("aria-valuemax", String(Math.max(0, state.total - 1)));
    this.slider.setAttr("aria-valuenow", String(Math.min(state.idx, Math.max(0, state.total - 1))));
    this.slider.setAttr("aria-valuetext", `第 ${at} 段，共 ${state.total} 段`);
    const ratio =
      this.previewRatio ?? ratioForIndex(state.idx, state.total);
    this.paint(ratio);

    const preview = state.preview
      ? `${state.preview.slice(0, 60)}${state.preview.length > 60 ? "…" : ""}`
      : "";
    this.engineEl.setText(state.engineLabel);
    this.fallbackEl.classList.toggle("kw-hidden", state.supported);
    this.hintEl.setText(
      state.message || preview || "点「朗读」开始听这篇笔记；进度可拖动，关闭窗口会保存断点。",
    );
    this.hintEl.classList.toggle("kw-speech-error", !state.supported);
  }

  private paint(ratio: number): void {
    const percent = `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(1)}%`;
    this.fill.style.width = percent;
    this.thumb.style.left = percent;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.total <= 0) return;
    this.dragging = true;
    this.slider.setPointerCapture(event.pointerId);
    this.updatePreview(event.clientX);
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.updatePreview(event.clientX);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.updatePreview(event.clientX);
    const ratio = this.previewRatio ?? 0;
    this.dragging = false;
    this.previewRatio = null;
    if (this.slider.hasPointerCapture(event.pointerId)) {
      this.slider.releasePointerCapture(event.pointerId);
    }
    // v15 seekCommit()：只在松手时真正跳转，避免拖动过程中反复 cancel/speak。
    this.speech.seek(seekFromRatio(ratio, this.total));
    this.render(this.speech.getSnapshot());
  };

  private readonly onPointerCancel = (): void => {
    this.dragging = false;
    this.previewRatio = null;
    this.render(this.speech.getSnapshot());
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.total <= 0) return;
    const current = Number(this.slider.getAttribute("aria-valuenow") ?? "0");
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = current + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = this.total - 1;
    else if (event.key === "Enter" || event.key === " ") {
      this.speech.toggle();
      event.preventDefault();
      return;
    }
    if (next === null) return;
    this.speech.seek(Math.min(this.total - 1, Math.max(0, next)));
    event.preventDefault();
  };

  private updatePreview(clientX: number): void {
    const rect = this.slider.getBoundingClientRect();
    this.previewRatio = ratioFromPointer(clientX, rect.left, rect.width);
    this.paint(this.previewRatio);
    this.slider.setAttr(
      "aria-valuenow",
      String(seekFromRatio(this.previewRatio, this.total)),
    );
  }

  /** 关闭窗口：停止朗读并保存断点、注销订阅与事件。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.slider.removeEventListener("pointerdown", this.onPointerDown);
    this.slider.removeEventListener("pointermove", this.onPointerMove);
    this.slider.removeEventListener("pointerup", this.onPointerUp);
    this.slider.removeEventListener("pointercancel", this.onPointerCancel);
    this.slider.removeEventListener("keydown", this.onKeyDown);
    const state = this.speech.getSnapshot();
    if (state.state === "playing" || state.state === "paused") {
      this.speech.stop(true);
    }
    this.root.remove();
  }
}
