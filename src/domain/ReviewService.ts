import { addDays, normalizeDate } from "./TaskService";
import type { NoteRecord } from "../types";

export interface ReviewPlanItem {
  path: string;
  title: string;
  /** 本次到期日期；首次排期为 null。 */
  from: string | null;
  stage: number;
  nextStage: number;
  nextDate: string;
  interval: number;
}

/** 固定间隔 1/3/7/15/30 天，stage 到顶后保持最后一档，后续可升级 SM-2。 */
export function nextInterval(intervals: number[], stage: number): number {
  if (!intervals.length) return 1;
  const index = Math.min(Math.max(0, Math.floor(stage)), intervals.length - 1);
  return Math.max(1, Math.floor(intervals[index]));
}

export function nextReviewDate(
  today: string,
  intervals: number[],
  stage: number,
): string {
  return addDays(today, nextInterval(intervals, stage));
}

/** 只为「已到期 / 已排期且日期不晚于今天」的笔记生成下一轮排期。 */
export function planReview(
  notes: NoteRecord[],
  today: string,
  intervals: number[],
): ReviewPlanItem[] {
  const plan: ReviewPlanItem[] = [];
  for (const note of notes) {
    const from = normalizeDate(note.review);
    if (!from || from > today) continue;
    const nextStage = Math.min(
      note.reviewStage + 1,
      Math.max(0, intervals.length - 1),
    );
    const interval = nextInterval(intervals, nextStage);
    plan.push({
      path: note.path,
      title: note.title,
      from,
      stage: note.reviewStage,
      nextStage,
      nextDate: addDays(today, interval),
      interval,
    });
  }
  return plan.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/** 给一篇尚未排期的笔记建立首次复习计划（由用户手动触发，不自动给全库加提醒）。 */
export function startReview(
  note: NoteRecord,
  today: string,
  intervals: number[],
): ReviewPlanItem {
  const stage = 0;
  const interval = nextInterval(intervals, stage);
  return {
    path: note.path,
    title: note.title,
    from: null,
    stage,
    nextStage: stage,
    nextDate: addDays(today, interval),
    interval,
  };
}
