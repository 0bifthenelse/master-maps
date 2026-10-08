/**
 * A pragmatic reader for the OSM opening_hours syntax covering what Gers
 * shops actually publish: day ranges, lists, several time spans, "off",
 * "24/7" and public-holiday rules (ignored). Anything it cannot read yields
 * null so the interface shows the raw string instead of a wrong verdict.
 */

export const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
export const DAY_LABELS: Readonly<Record<(typeof DAYS)[number], string>> = { Mo: "Mon", Tu: "Tue", We: "Wed", Th: "Thu", Fr: "Fri", Sa: "Sat", Su: "Sun" };

export type WeekSchedule = [number, number][][]; // per weekday Monday=0: list of [startMinute, endMinute]

function minutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 24 || mins > 59) return null;
  return hours * 60 + mins;
}

function dayIndex(value: string): number {
  return DAYS.indexOf(value as (typeof DAYS)[number]);
}

function parseDays(value: string): number[] | null {
  const days = new Set<number>();
  for (const part of value.split(",")) {
    const range = part.trim().split("-");
    if (range.length === 1) {
      const index = dayIndex(range[0]!);
      if (index < 0) return null;
      days.add(index);
    } else if (range.length === 2) {
      const from = dayIndex(range[0]!);
      const to = dayIndex(range[1]!);
      if (from < 0 || to < 0) return null;
      for (let day = from; ; day = (day + 1) % 7) {
        days.add(day);
        if (day === to) break;
      }
    } else return null;
  }
  return [...days];
}

export function parseOpeningHours(raw: string | undefined): WeekSchedule | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "") return null;
  const week: WeekSchedule = Array.from({ length: 7 }, () => []);
  if (text === "24/7") {
    for (const day of week) day.push([0, 1440]);
    return week;
  }
  for (const ruleRaw of text.split(";")) {
    const rule = ruleRaw.trim();
    if (rule === "") continue;
    if (/^PH\b/.test(rule) || /^SH\b/.test(rule)) continue;
    const match = /^([A-Za-z,\- ]+?)\s+(.+)$/.exec(rule);
    let days: number[] | null;
    let spans: string;
    if (match !== null && /^(Mo|Tu|We|Th|Fr|Sa|Su)/.test(match[1]!)) {
      days = parseDays(match[1]!.replace(/\s+/g, "").replace(/,PH|PH,?/g, ""));
      spans = match[2]!.trim();
    } else if (/^\d/.test(rule)) {
      days = [0, 1, 2, 3, 4, 5, 6];
      spans = rule;
    } else return null;
    if (days === null) return null;
    if (/^(off|closed)$/i.test(spans)) {
      for (const day of days) week[day] = [];
      continue;
    }
    const intervals: [number, number][] = [];
    for (const span of spans.split(",")) {
      const [start, end] = span.split("-");
      if (start === undefined || end === undefined) return null;
      const from = minutes(start);
      let to = minutes(end.replace(/\+$/, ""));
      if (from === null || to === null) return null;
      if (to <= from) to += 1440;
      intervals.push([from, to]);
    }
    for (const day of days) week[day] = intervals;
  }
  return week;
}

export interface OpenState {
  open: boolean;
  /** Human sentence such as "Closes 19:00" or "Opens Mon 09:00". */
  detail: string;
}

function clock(minute: number): string {
  const normalized = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export function openState(week: WeekSchedule, now: Date): OpenState {
  const day = (now.getDay() + 6) % 7;
  const minute = now.getHours() * 60 + now.getMinutes();
  const yesterday = (day + 6) % 7;
  for (const [, end] of week[yesterday]!) {
    if (end > 1440 && minute < end - 1440) return { open: true, detail: `Closes ${clock(end)}` };
  }
  for (const [start, end] of week[day]!) {
    if (minute >= start && minute < end) return { open: true, detail: end >= 1440 && start === 0 && end === 1440 ? "Open 24 hours" : `Closes ${clock(end)}` };
  }
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = (day + offset) % 7;
    const next = week[candidate]!.map(([start]) => start).filter((start) => offset > 0 || start > minute).sort((a, b) => a - b)[0];
    if (next !== undefined) return { open: false, detail: `Opens ${offset === 0 ? "" : `${DAY_LABELS[DAYS[candidate]!]} `}${clock(next)}` };
  }
  return { open: false, detail: "Closed" };
}

export function formatDay(intervals: [number, number][]): string {
  if (intervals.length === 0) return "Closed";
  if (intervals.length === 1 && intervals[0]![0] === 0 && intervals[0]![1] >= 1440) return "Open 24 hours";
  return intervals.map(([start, end]) => `${clock(start)}–${clock(end)}`).join(", ");
}
