import {
  allCategorySlices,
  countByCategory,
  detailSlices,
  folderCounts,
  tagCounts,
} from "./ClassifierService";
import { buildIcsEvents } from "./ics";
import { buildToday } from "./TaskService";
import type {
  DomainSnapshot,
  IcsState,
  NoteRecord,
  TodaySummary,
  WorkbenchSettings,
} from "../types";

export function emptyIcsState(settings: WorkbenchSettings, mobile: boolean): IcsState {
  return {
    enabled: settings.icsEnabled,
    mobile,
    events: 0,
    path: settings.icsPath,
    lastWriteAt: null,
    error: null,
  };
}

export function buildDomainSnapshot(
  notes: NoteRecord[],
  today: string,
  settings: WorkbenchSettings,
  icsState: IcsState,
  todaySummary: TodaySummary = buildToday(notes, today, settings),
): DomainSnapshot {
  return {
    generatedAt: Date.now(),
    noteCount: notes.length,
    today: todaySummary,
    categories: countByCategory(notes, settings.classifyBy),
    chart: allCategorySlices(notes, settings.classifyBy),
    detailChart: detailSlices(notes),
    tagCounts: tagCounts(notes),
    folderCounts: folderCounts(notes),
    ics: {
      ...icsState,
      events: buildIcsEvents(todaySummary.items, today).length,
    },
  };
}
