import { dateValue } from './model.js';
import { holidaysFileSchema, parseModel } from './schemas.js';

const DAY = 86400000;
export interface Interval {
  start: number;
  end: number;
  labels?: string[];
}
export interface CalendarInterval extends Interval {
  labels: string[];
}

export function mergeIntervals(intervals: Interval[]): CalendarInterval[] {
  const merged: (Interval & { sources: { order: number; labels: string[] }[] })[] = [];
  const sorted = intervals
    .map((interval, order) => ({
      ...interval,
      sources: [{ order, labels: interval.labels ?? [] }],
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start < last.end) {
      last.end = Math.max(last.end, interval.end);
      last.sources.push(...interval.sources);
    } else merged.push(interval);
  }
  return merged.map(({ start, end, sources }) => ({
    start,
    end,
    labels: [
      ...new Set(
        sources.sort((left, right) => left.order - right.order).flatMap((source) => source.labels),
      ),
    ],
  }));
}

export function calendarIntervals(
  holidays: unknown,
  timeline: { start: number; end: number },
  shadeWeekends = false,
) {
  const entries = parseModel(holidaysFileSchema, { holydays: holidays }).holydays;
  const clip = (intervals: CalendarInterval[]) =>
    intervals
      .map((interval) => ({
        ...interval,
        start: Math.max(interval.start, timeline.start),
        end: Math.min(interval.end, timeline.end),
      }))
      .filter((interval) => interval.start < interval.end);
  const labels = clip(
    mergeIntervals(
      entries.map((entry) => ({
        start: dateValue(entry.start),
        end: dateValue(entry.end) + DAY,
        labels: [entry.label],
      })),
    ),
  );
  const weekends: CalendarInterval[] = [];
  if (shadeWeekends) {
    const weekday = new Date(timeline.start).getUTCDay();
    let saturday = timeline.start - ((weekday + 1) % 7) * DAY;
    for (; saturday < timeline.end; saturday += 7 * DAY) {
      weekends.push({ start: saturday, end: saturday + 2 * DAY, labels: [] });
    }
  }
  return { labels, shading: mergeIntervals([...labels, ...clip(weekends)]) };
}
