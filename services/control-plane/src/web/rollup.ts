// SPDX-License-Identifier: Apache-2.0
// Reads of the web rollups (data-model §8.9: web_daily_totals, web_daily_breakdowns, web_hourly_totals), always under
// the tenant's own context with an explicit tenant filter on top of RLS. Filled by job `web_rollup` (services/jobs).

import type { Tx } from "../db/database.ts";
import { addTotals, type BreakdownMap, type Totals, ZERO } from "./figures.ts";
import { DAY, dayString, HOUR, isMidnight, type Span, utcMidnight } from "./range.ts";

export type Dimension = "referrer" | "country" | "device" | "browser" | "os" | "path" | "event";

const TOTAL_COLUMNS = `pageviews_verified::float8 AS pv_v, pageviews_raw::float8 AS pv_r,
  pageviews_unidentified_verified::float8 AS unid_v, pageviews_unidentified_raw::float8 AS unid_r,
  visitors_verified::float8 AS vis_v, visitors_raw::float8 AS vis_r`;

interface TotalsRow extends Record<string, unknown> {
  pv_v: number;
  pv_r: number;
  unid_v: number;
  unid_r: number;
  vis_v: number;
  vis_r: number;
  visits?: number;
  bounces?: number;
  dur?: number;
}

function toTotals(r: TotalsRow | undefined): Totals {
  if (!r) return { ...ZERO };
  return {
    pvVerified: Number(r.pv_v ?? 0),
    pvRaw: Number(r.pv_r ?? 0),
    pvUnidVerified: Number(r.unid_v ?? 0),
    pvUnidRaw: Number(r.unid_r ?? 0),
    visitorsVerified: Number(r.vis_v ?? 0),
    visitorsRaw: Number(r.vis_r ?? 0),
    visits: Number(r.visits ?? 0),
    bounces: Number(r.bounces ?? 0),
    durationS: Number(r.dur ?? 0),
  };
}

/** One totals row per UTC day in [start, end) that the rollup has (days without a row are absent). */
export async function dailyTotals(
  tx: Tx,
  tenantId: string,
  siteId: string,
  span: Span,
): Promise<Map<number, Totals>> {
  const rows = await tx.query<TotalsRow & { day: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, ${TOTAL_COLUMNS}, visits::float8 AS visits, bounces::float8 AS bounces,
            total_duration_s::float8 AS dur
       FROM scf.web_daily_totals
      WHERE tenant_id = $1 AND site_id = $2 AND day >= $3::date AND day < $4::date
      ORDER BY day`,
    [
      tenantId,
      siteId,
      dayString(utcMidnight(span.start)),
      dayString(utcMidnight(span.end - 1) + DAY),
    ],
  );
  const out = new Map<number, Totals>();
  for (const r of rows) {
    const t = Date.parse(`${r.day}T00:00:00Z`);
    if (t >= utcMidnight(span.start) && t < span.end) out.set(t, toTotals(r));
  }
  return out;
}

/** Hourly page views and visitors in [start, end) (hour buckets starting inside the span). */
export async function hourlyTotals(
  tx: Tx,
  tenantId: string,
  siteId: string,
  span: Span,
): Promise<Map<number, Totals>> {
  const rows = await tx.query<TotalsRow & { h: Date }>(
    `SELECT hour_start AS h, ${TOTAL_COLUMNS}
       FROM scf.web_hourly_totals
      WHERE tenant_id = $1 AND site_id = $2 AND hour_start >= $3 AND hour_start < $4
      ORDER BY hour_start`,
    [tenantId, siteId, new Date(Math.floor(span.start / HOUR) * HOUR), new Date(span.end)],
  );
  return new Map(rows.map((r) => [r.h.getTime(), toTotals(r)]));
}

/**
 * Totals of a span from the rollups: whole UTC days from `web_daily_totals` (today's row — refreshed hourly, not final
 * — stands for today up to now), other partial-day segments from `web_hourly_totals` (page views and visitors only;
 * hourly visitors are summed, an upper bound; such segments carry no visit metrics). Used for the rollup part (whole
 * days by construction) and for a live part that fell back (C-112(6)).
 */
export async function rollupTotals(
  tx: Tx,
  tenantId: string,
  siteId: string,
  span: Span,
  now: number,
): Promise<Totals> {
  const today = utcMidnight(now);
  const firstWhole = isMidnight(span.start) ? span.start : utcMidnight(span.start) + DAY;
  // A segment ending now (or later) on today counts as today's whole day: nothing exists after now.
  const lastWhole =
    span.end >= now && utcMidnight(span.end - 1) <= today ? today + DAY : utcMidnight(span.end);
  let t: Totals = { ...ZERO };
  if (lastWhole > firstWhole) {
    for (const v of (
      await dailyTotals(tx, tenantId, siteId, { start: firstWhole, end: lastWhole })
    ).values())
      t = addTotals(t, v);
  }
  const partials: Span[] = [];
  if (firstWhole > span.start)
    partials.push({ start: span.start, end: Math.min(firstWhole, span.end) });
  // (A span inside one day has lastWhole < firstWhole: only the first partial applies.)
  if (span.end > lastWhole && lastWhole >= firstWhole)
    partials.push({ start: lastWhole, end: span.end });
  for (const p of partials) {
    for (const v of (await hourlyTotals(tx, tenantId, siteId, p)).values()) t = addTotals(t, v);
  }
  return t;
}

/**
 * Per-value breakdown counts of one variant over whole UTC days (top-N rows per day, summed). Values outside a day's
 * stored top-N contribute nothing for that day (`truncated`). Event rows carry `events` only.
 */
export async function dailyBreakdown(
  tx: Tx,
  tenantId: string,
  siteId: string,
  span: Span,
  dimension: Dimension,
  variant: "verified" | "raw",
  now: number,
): Promise<BreakdownMap> {
  const today = utcMidnight(now);
  const first = utcMidnight(span.start);
  const last = span.end >= now && utcMidnight(span.end - 1) <= today ? today + DAY : span.end;
  const rows = await tx.query<{
    value: string;
    visitors: number | null;
    pageviews: number | null;
    events: number | null;
  }>(
    `SELECT value, sum(visitors)::float8 AS visitors, sum(pageviews)::float8 AS pageviews, sum(events)::float8 AS events
       FROM scf.web_daily_breakdowns
      WHERE tenant_id = $1 AND site_id = $2 AND day >= $3::date AND day < $4::date
        AND variant = $5::scf.web_variant AND dimension = $6::scf.web_dimension
      GROUP BY value`,
    [
      tenantId,
      siteId,
      dayString(first),
      dayString(Math.max(first, utcMidnight(last - 1) + DAY)),
      variant,
      dimension,
    ],
  );
  const out: BreakdownMap = new Map();
  for (const r of rows) {
    out.set(
      r.value,
      dimension === "event"
        ? { visitors: null, pageviews: null, events: r.events === null ? 0 : Number(r.events) }
        : {
            visitors: r.visitors === null ? null : Number(r.visitors),
            pageviews: r.pageviews === null ? null : Number(r.pageviews),
            events: null,
          },
    );
  }
  return out;
}

/**
 * Per-day breakdown counts of one variant over whole UTC days [span.start, span.end) (anonymous reports with the
 * per-day minimum count): one map per day that has rows, in day order.
 */
export async function dailyBreakdownByDay(
  tx: Tx,
  tenantId: string,
  siteId: string,
  span: Span,
  dimension: Dimension,
  variant: "verified" | "raw",
): Promise<BreakdownMap[]> {
  const rows = await tx.query<{
    day: string;
    value: string;
    visitors: string | null;
    pageviews: string | null;
    events: string | null;
  }>(
    `SELECT day::text AS day, value, visitors::text AS visitors, pageviews::text AS pageviews, events::text AS events
       FROM scf.web_daily_breakdowns
      WHERE tenant_id = $1 AND site_id = $2 AND day >= $3::date AND day < $4::date
        AND variant = $5::scf.web_variant AND dimension = $6::scf.web_dimension
      ORDER BY day, value`,
    [tenantId, siteId, dayString(span.start), dayString(span.end), variant, dimension],
  );
  const byDay = new Map<string, BreakdownMap>();
  for (const r of rows) {
    let m = byDay.get(r.day);
    if (!m) {
      m = new Map();
      byDay.set(r.day, m);
    }
    m.set(
      r.value,
      dimension === "event"
        ? { visitors: null, pageviews: null, events: r.events === null ? 0 : Number(r.events) }
        : {
            visitors: r.visitors === null ? null : Number(r.visitors),
            pageviews: r.pageviews === null ? null : Number(r.pageviews),
            events: null,
          },
    );
  }
  return [...byDay.values()];
}
