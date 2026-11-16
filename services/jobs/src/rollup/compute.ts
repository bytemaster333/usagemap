// SPDX-License-Identifier: Apache-2.0
// Pure parts of the web rollup: which days a run covers (data-model §6.3, §8.9, C-110(6), C-112) and how the raw
// per-value counts become the stored top-N breakdown rows of both variants (C-73).

import { addDays, utcDay } from "../schedule.ts";

export type Dimension = "referrer" | "country" | "device" | "browser" | "os" | "path" | "event";
export const DIMENSIONS: readonly Dimension[] = [
  "referrer",
  "country",
  "device",
  "browser",
  "os",
  "path",
  "event",
];

export interface DayTask {
  day: string;
  final: boolean;
}

/**
 * Days after which a day's rollup is final: the daily run (01:30 UTC) re-rolls D-1…D-3 and marks D-4 final. The edge
 * spool may deliver an event up to 72 h after its receipt (ADR-0005), so the last event of day D can reach Umami until
 * D+3 23:59:59; D-4 at D 01:30 is 25.5 h past that. (Finalising D-3 would be only 49.5 h after D ended.)
 */
export const FINAL_AFTER_DAYS = 4;
/** How far back a run looks for days that were never rolled or never finalised (missed runs, downtime). */
export const CATCH_UP_DAYS = 7;
/** The previous day is refreshed by the hourly runs until 02:00 UTC (C-110(6)). */
export const PREVIOUS_DAY_UNTIL_HOUR = 2;

/**
 * The days a run rolls up from its trigger alone (catch-up comes on top, see `catchUpTasks`):
 * - hourly (and at start): today, and the previous day before 02:00 UTC — not final;
 * - daily (01:30 UTC): D-1, D-2 and D-3 not final, D-4 final.
 */
export function scheduledTasks(now: Date, mode: string): DayTask[] {
  const today = utcDay(now);
  if (mode === "daily") {
    const out: DayTask[] = [];
    for (let i = 1; i < FINAL_AFTER_DAYS; i++) out.push({ day: addDays(today, -i), final: false });
    out.push({ day: addDays(today, -FINAL_AFTER_DAYS), final: true });
    return out;
  }
  const out: DayTask[] = [{ day: today, final: false }];
  if (now.getUTCHours() < PREVIOUS_DAY_UNTIL_HOUR)
    out.push({ day: addDays(today, -1), final: false });
  return out;
}

/**
 * Catch-up for one site: within the last CATCH_UP_DAYS days before today (not before the site existed), every day
 * without a totals row is rolled, and every day at least FINAL_AFTER_DAYS old that is not final is rolled as final.
 */
export function catchUpTasks(
  now: Date,
  siteCreatedDay: string,
  existing: ReadonlyMap<string, boolean>,
): DayTask[] {
  const today = utcDay(now);
  const out: DayTask[] = [];
  for (let i = CATCH_UP_DAYS; i >= 1; i--) {
    const day = addDays(today, -i);
    if (day < siteCreatedDay) continue;
    const final = i >= FINAL_AFTER_DAYS;
    const have = existing.get(day);
    if (have === undefined || (final && have === false)) out.push({ day, final });
  }
  return out;
}

/** Merges task lists per day; a day rolled as final in any list is final. Sorted oldest first. */
export function mergeTasks(...lists: DayTask[][]): DayTask[] {
  const m = new Map<string, boolean>();
  for (const l of lists) for (const t of l) m.set(t.day, (m.get(t.day) ?? false) || t.final);
  return [...m]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, final]) => ({ day, final }));
}

/** One row of BREAKDOWN_SQL. */
export interface BreakdownCounts {
  dimension: Dimension;
  value: string;
  pageviews_raw: number;
  pageviews_verified: number;
  visitors_raw: number;
  visitors_verified: number;
  visits_raw: number;
  events_raw: number;
  events_verified: number;
  event_visitors_raw: number;
  event_visitors_verified: number;
}

/** A stored row of scf.web_daily_breakdowns (without tenant, site and day). */
export interface BreakdownRow {
  variant: "verified" | "raw";
  dimension: Dimension;
  value: string;
  rank: number;
  visitors: number | null;
  pageviews: number | null;
  visits: number | null;
  events: number | null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Top-N per dimension and variant (data-model §8.9): ranked by visitors — events for `event` — then by the value.
 * verified rows: page views / events tagged `v` (main + twin), visitors tagged `v` (main), no visits (C-73);
 * raw rows: page views / events unfiltered (main + twin), visitors and visits unfiltered (main).
 * A value with no page view (no event) in a variant makes no row of that variant. No "Other" row is stored.
 */
export function topN(counts: readonly BreakdownCounts[], n: number): BreakdownRow[] {
  const out: BreakdownRow[] = [];
  for (const dimension of DIMENSIONS) {
    const rows = counts.filter((c) => c.dimension === dimension);
    for (const variant of ["verified", "raw"] as const) {
      const ver = variant === "verified";
      const cand: BreakdownRow[] = [];
      for (const c of rows) {
        if (dimension === "event") {
          const events = ver ? c.events_verified : c.events_raw;
          if (events <= 0) continue;
          cand.push({
            variant,
            dimension,
            value: c.value,
            rank: 0,
            visitors: ver ? c.event_visitors_verified : c.event_visitors_raw,
            pageviews: null,
            visits: null,
            events,
          });
        } else {
          const pageviews = ver ? c.pageviews_verified : c.pageviews_raw;
          if (pageviews <= 0) continue;
          cand.push({
            variant,
            dimension,
            value: c.value,
            rank: 0,
            visitors: ver ? c.visitors_verified : c.visitors_raw,
            pageviews,
            visits: ver ? null : c.visits_raw,
            events: null,
          });
        }
      }
      const key = (r: BreakdownRow) =>
        dimension === "event" ? (r.events ?? 0) : (r.visitors ?? 0);
      cand.sort((a, b) => key(b) - key(a) || cmp(a.value, b.value));
      cand.slice(0, n).forEach((r, i) => {
        r.rank = i + 1;
        out.push(r);
      });
    }
  }
  return out;
}
