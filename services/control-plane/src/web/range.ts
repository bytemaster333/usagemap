// SPDX-License-Identifier: Apache-2.0
// Range resolution and the live/rollup split of a tenant web request (wire-formats §j.6, data-model §8.9; C-86, C-109,
// C-110(6), C-112(4)/(5)). Pure functions: every rule about which instant is answered by whom lives here.

import { ApiError } from "../http/problem.ts";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
const MAX_RANGE_MS = 3660 * DAY; // "range ≤ 10 years" (parameter `end`)

export type Preset = "24h" | "7d" | "30d" | "90d" | "12m" | "all" | "custom";

/** A half-open range [start, end) in Unix ms (C-86). */
export interface Span {
  start: number;
  end: number;
}

export function utcMidnight(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

export function isMidnight(ms: number): boolean {
  return ms % DAY === 0;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

export function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function bad(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

/**
 * Resolves the `range` preset (or `custom` with `start`/`end`) to a [start, end) pair. Presets other than `24h` end at
 * the end of today UTC and are day-aligned; `24h` ends now. `all` starts at the UTC day of the site's creation.
 */
export function resolveRange(
  q: { range?: unknown; start?: unknown; end?: unknown },
  now: number,
  siteCreatedAt: number,
): Span {
  const preset = (q.range ?? "30d") as Preset;
  const hasBounds = q.start !== undefined || q.end !== undefined;
  if (preset !== "custom") {
    if (hasBounds) throw bad("/range", "start and end are accepted with range=custom only");
    const endOfToday = utcMidnight(now) + DAY;
    switch (preset) {
      case "24h":
        return { start: now - DAY, end: now };
      case "7d":
        return { start: endOfToday - 7 * DAY, end: endOfToday };
      case "30d":
        return { start: endOfToday - 30 * DAY, end: endOfToday };
      case "90d":
        return { start: endOfToday - 90 * DAY, end: endOfToday };
      case "12m": {
        const d = new Date(endOfToday);
        return {
          start: Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()),
          end: endOfToday,
        };
      }
      case "all":
        return { start: Math.min(utcMidnight(siteCreatedAt), utcMidnight(now)), end: endOfToday };
      default:
        throw bad("/range", "unknown range preset");
    }
  }
  if (typeof q.start !== "string" || typeof q.end !== "string")
    throw bad(q.start === undefined ? "/start" : "/end", "range=custom requires start and end");
  const start = Date.parse(q.start);
  const end = Date.parse(q.end);
  if (!Number.isFinite(start)) throw bad("/start", "not an RFC 3339 UTC time");
  if (!Number.isFinite(end)) throw bad("/end", "not an RFC 3339 UTC time");
  if (end <= start) throw bad("/end", "end must be after start");
  if (end - start > MAX_RANGE_MS) throw bad("/end", "range must not exceed 10 years");
  return { start, end };
}

/**
 * resolveRange for the tenant web operations, bounded in time: no figures exist for the future,
 * so a custom range may not start after now and may end at most one day after now (the presets end at the end of
 * today) — a request cannot ask for years of empty buckets.
 */
export function resolveWebRange(
  q: { range?: unknown; start?: unknown; end?: unknown },
  now: number,
  siteCreatedAt: number,
): Span {
  const span = resolveRange(q, now, siteCreatedAt);
  if (span.start > now) throw bad("/start", "start must not be in the future");
  if (span.end > now + DAY) throw bad("/end", "end must not be more than one day after now");
  return span;
}

export interface Plan {
  span: Span;
  /** The live boundary b = today 00:00 UTC − (L − 1) days. */
  liveBoundary: number;
  /** Answered by the engine (§j.3); null when the whole range lies before the live window. */
  live: Span | null;
  /** Answered by the rollups; null when the whole range is live. */
  rollup: Span | null;
}

/**
 * The §j.6 split. A range that starts within the last 24 hours is live in full; otherwise the live part is
 * [max(start, b), end) and the rollup part [start, min(end, b)). With `requireWholeDays` (every figure except hourly
 * page-view/visitor series) the rollup part must be whole UTC days, else `400 validation_failed` naming b.
 */
export function planRange(
  span: Span,
  liveDays: number,
  now: number,
  requireWholeDays = true,
): Plan {
  const b = utcMidnight(now) - (Math.max(1, liveDays) - 1) * DAY;
  if (span.start >= now - DAY) return { span, liveBoundary: b, live: span, rollup: null };
  const live = span.end > b ? { start: Math.max(span.start, b), end: span.end } : null;
  const rollup = span.start < b ? { start: span.start, end: Math.min(span.end, b) } : null;
  if (rollup && requireWholeDays) {
    const detail = `the part of the range before the site's live window (which starts at ${iso(b)}) must be whole UTC days`;
    if (!isMidnight(rollup.start)) throw bad("/start", detail);
    if (!isMidnight(rollup.end)) throw bad("/end", detail);
  }
  return { span, liveBoundary: b, live, rollup };
}

/** The preceding range of equal length (compare=previous, C-112(5)). */
export function previousSpan(span: Span): Span {
  const len = span.end - span.start;
  return { start: span.start - len, end: span.start };
}

export type Unit = "hour" | "day" | "month";

/** Default unit: hour ≤ 2 days, day ≤ 92 days, else month (parameter `unit`). */
export function defaultUnit(span: Span): Unit {
  const len = span.end - span.start;
  if (len <= 2 * DAY) return "hour";
  if (len <= 92 * DAY) return "day";
  return "month";
}

/** Bucket starts covering [start, end) for a unit (hour and day buckets are UTC-aligned; months start on day 1). */
export function buckets(span: Span, unit: Unit): number[] {
  const out: number[] = [];
  if (unit === "month") {
    const d = new Date(span.start);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (t < span.end) {
      out.push(t);
      const n = new Date(t);
      t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
    }
    return out;
  }
  const step = unit === "hour" ? HOUR : DAY;
  for (let t = Math.floor(span.start / step) * step; t < span.end; t += step) out.push(t);
  return out;
}

/** Points one series may have (the API metrics use the same bound). */
export const MAX_SERIES_POINTS = 10_000;

/** The number of buckets of a series, refused above MAX_SERIES_POINTS (`400`, pointer `/unit`: ask a coarser unit). */
export function seriesPoints(span: Span, unit: Unit): number {
  const step = unit === "hour" ? HOUR : unit === "day" ? DAY : 28 * DAY;
  const estimate = Math.ceil((span.end - Math.floor(span.start / step) * step) / step);
  if (estimate > MAX_SERIES_POINTS + 1)
    throw bad(
      "/unit",
      `a series has at most ${MAX_SERIES_POINTS} points: choose a coarser unit or a shorter range`,
    );
  const n = buckets(span, unit).length;
  if (n > MAX_SERIES_POINTS)
    throw bad(
      "/unit",
      `a series has at most ${MAX_SERIES_POINTS} points: choose a coarser unit or a shorter range`,
    );
  return n;
}

/**
 * The reads of an anonymous-reports breakdown (C-51 with the per-day minimum count): every whole UTC day
 * before today comes from the daily rollup rows (one row set per day), and only partial days — the first day of a
 * range starting mid-day and today — are read live, one engine read per day. At most two live reads; the rollup part
 * is one contiguous span of whole days (null when empty).
 */
export function anonymousSegments(plan: Plan, now: number): { rollup: Span | null; live: Span[] } {
  const { span } = plan;
  const today = utcMidnight(now);
  const live: Span[] = [];
  let rStart: number | null = null;
  let rEnd: number | null = null;
  for (let d = utcMidnight(span.start); d < span.end; d += DAY) {
    const seg = { start: Math.max(d, span.start), end: Math.min(d + DAY, span.end) };
    const whole = seg.start === d && seg.end === d + DAY && d < today;
    if (whole) {
      rStart ??= d;
      rEnd = d + DAY;
    } else live.push(seg);
  }
  return { rollup: rStart !== null && rEnd !== null ? { start: rStart, end: rEnd } : null, live };
}

/** The bucket a time falls into. */
export function bucketOf(ms: number, unit: Unit): number {
  if (unit === "month") {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const step = unit === "hour" ? HOUR : DAY;
  return Math.floor(ms / step) * step;
}
