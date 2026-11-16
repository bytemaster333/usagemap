// SPDX-License-Identifier: Apache-2.0
// Whole-UTC-day ranges for the SCF operator views: the operator API takes `start`/`end` as midnights, the end being the
// midnight after the last day (C-86; OpenAPI `dayStart`/`dayEnd`). Presets end with today (a partial day: its rollup is
// refreshed hourly, C-110(6)).

import { customRange, dayString, isoZ, parseDay } from "./range.ts";

export const DAY_PRESETS = ["7d", "30d", "90d"] as const;
export type DayPreset = (typeof DAY_PRESETS)[number];
export const DAY_PRESET_LABELS: Record<DayPreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

const DAY_MS = 86_400_000;

export interface DaySpan {
  start: string;
  end: string;
  days: number;
}

export function presetSpan(p: DayPreset, now = new Date()): DaySpan {
  const n = p === "7d" ? 7 : p === "30d" ? 30 : 90;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: isoZ(new Date(today - (n - 1) * DAY_MS)),
    end: isoZ(new Date(today + DAY_MS)),
    days: n,
  };
}

/** The search parameters `range` (preset or custom) + `from`/`to` (inclusive days) → a span, or a form error. */
export function daySpan(
  range: DayPreset | "custom",
  from: string | undefined,
  to: string | undefined,
  now = new Date(),
): DaySpan | { error: string } {
  if (range !== "custom") return presetSpan(range, now);
  return customRange(from, to);
}

/** The previous span of the same length, ending where this one starts (for comparisons). */
export function previousSpan(s: { start: string; end: string }): { start: string; end: string } {
  const a = Date.parse(s.start);
  const b = Date.parse(s.end);
  return { start: isoZ(new Date(a - (b - a))), end: isoZ(new Date(a)) };
}

/** Each UTC day (YYYY-MM-DD) of a whole-day span. */
export function daysOf(s: { start: string; end: string }): string[] {
  const out: string[] = [];
  for (let t = Date.parse(s.start); t < Date.parse(s.end); t += DAY_MS)
    out.push(dayString(new Date(t)));
  return out;
}

export { parseDay };
