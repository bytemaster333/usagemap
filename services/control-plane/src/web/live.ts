// SPDX-License-Identifier: Apache-2.0
// Live-window reads through the adapter with the tenant's own view-only key (wire-formats §j.3 call table, C-73).
// Every call has the adapter's 5 s timeout; any failure is surfaced to the caller, which answers from the rollups.

import { composeTotals, type PageviewsResult, type SeriesPoint } from "@usagemap/umami-adapter";
import type { BreakdownMap, Totals } from "./figures.ts";
import type { LiveReader } from "./handlers.ts";
import type { Span, Unit } from "./range.ts";
import type { Dimension } from "./rollup.ts";

export interface Websites {
  main: string;
  /** Only once provisioned (`twin_provisioned_at`), C-73. */
  twin: string | null;
}

/** R1 on M (verified, raw) and on T (verified, raw), composed per §j.3. */
export async function liveTotals(
  reader: LiveReader,
  key: string,
  w: Websites,
  span: Span,
): Promise<Totals> {
  const [mv, mr, tv, tr] = await Promise.all([
    reader.stats(key, w.main, span, "verified"),
    reader.stats(key, w.main, span, "raw"),
    w.twin ? reader.stats(key, w.twin, span, "verified") : Promise.resolve(null),
    w.twin ? reader.stats(key, w.twin, span, "raw") : Promise.resolve(null),
  ]);
  const c = composeTotals(mv, mr, tv, tr);
  return {
    pvVerified: c.pageviews.verified,
    pvRaw: c.pageviews.raw,
    pvUnidVerified: c.pageviewsUnidentified.verified,
    pvUnidRaw: c.pageviewsUnidentified.raw,
    visitorsVerified: c.visitors.verified,
    visitorsRaw: c.visitors.raw,
    visits: c.visits,
    bounces: c.bounces,
    durationS: c.totaltimeSeconds,
  };
}

/** R1 raw on M only: the one visit figure (visits, bounces, duration) of a span, e.g. today's bucket (C-112(4)). */
export async function liveVisitFigures(
  reader: LiveReader,
  key: string,
  w: Websites,
  span: Span,
): Promise<Pick<Totals, "visits" | "bounces" | "durationS">> {
  const r = await reader.stats(key, w.main, span, "raw");
  return { visits: r.visits, bounces: r.bounces, durationS: r.totaltime };
}

/** Umami's bucket times: ISO with `Z`, or `YYYY-MM-DD HH:MM:SS` (UTC because `timezone=UTC`). */
export function bucketTime(x: string): number {
  let s = x.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s))
    s = `${s.replace(" ", "T")}Z`;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s}Z`;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error("unparseable bucket time from the engine");
  return t;
}

function blank(): Totals {
  return {
    pvVerified: 0,
    pvRaw: 0,
    pvUnidVerified: 0,
    pvUnidRaw: 0,
    visitorsVerified: 0,
    visitorsRaw: 0,
    visits: 0,
    bounces: 0,
    durationS: 0,
  };
}

function into(
  out: Map<number, Totals>,
  points: SeriesPoint[],
  f: (t: Totals, y: number) => void,
): void {
  for (const p of points) {
    const t = bucketTime(p.x);
    const cur = out.get(t) ?? blank();
    f(cur, p.y);
    out.set(t, cur);
  }
}

/**
 * R2 series per hour or day: page views from M + T, visitors (sessions) from M, per variant asked for. Visit figures
 * stay zero (series of visit metrics never come from R2, C-112(4)).
 */
export async function liveSeries(
  reader: LiveReader,
  key: string,
  w: Websites,
  span: Span,
  unit: Exclude<Unit, "month">,
  variants: { verified: boolean; raw: boolean },
): Promise<Map<number, Totals>> {
  const none: PageviewsResult = { pageviews: [], sessions: [] };
  const call = (id: string | null, v: "verified" | "raw", want: boolean) =>
    id && want ? reader.pageviews(key, id, span, unit, v) : Promise.resolve(none);
  const [mv, mr, tv, tr] = await Promise.all([
    call(w.main, "verified", variants.verified),
    call(w.main, "raw", variants.raw),
    call(w.twin, "verified", variants.verified),
    call(w.twin, "raw", variants.raw),
  ]);
  const out = new Map<number, Totals>();
  into(out, mv.pageviews, (t, y) => {
    t.pvVerified += y;
  });
  into(out, mv.sessions, (t, y) => {
    t.visitorsVerified += y;
  });
  into(out, mr.pageviews, (t, y) => {
    t.pvRaw += y;
  });
  into(out, mr.sessions, (t, y) => {
    t.visitorsRaw += y;
  });
  into(out, tv.pageviews, (t, y) => {
    t.pvVerified += y;
    t.pvUnidVerified += y;
  });
  into(out, tr.pageviews, (t, y) => {
    t.pvRaw += y;
    t.pvUnidRaw += y;
  });
  return out;
}

/** R4 (or R3 for events) on M and T for one variant: page views M + T, visitors M only, events M + T. */
export async function liveBreakdown(
  reader: LiveReader,
  key: string,
  w: Websites,
  span: Span,
  dimension: Dimension,
  variant: "verified" | "raw",
): Promise<BreakdownMap> {
  const out: BreakdownMap = new Map();
  if (dimension === "event") {
    const [m, t] = await Promise.all([
      reader.events(key, w.main, span, variant, 500),
      w.twin ? reader.events(key, w.twin, span, variant, 500) : Promise.resolve([]),
    ]);
    for (const r of [...m, ...t]) {
      if (!r.name) continue;
      const cur = out.get(r.name);
      out.set(r.name, { visitors: null, pageviews: null, events: (cur?.events ?? 0) + r.events });
    }
    return out;
  }
  const [m, t] = await Promise.all([
    reader.expanded(key, w.main, span, dimension, variant, 500),
    w.twin ? reader.expanded(key, w.twin, span, dimension, variant, 500) : Promise.resolve([]),
  ]);
  for (const r of m) {
    // Direct visits have no referrer domain and make no row (data-model §8.9).
    if (!r.name) continue;
    const cur = out.get(r.name);
    out.set(r.name, {
      visitors: (cur?.visitors ?? 0) + r.visitors,
      pageviews: (cur?.pageviews ?? 0) + r.pageviews,
      events: null,
    });
  }
  for (const r of t) {
    if (!r.name) continue;
    const cur = out.get(r.name);
    out.set(r.name, {
      visitors: cur?.visitors ?? 0,
      pageviews: (cur?.pageviews ?? 0) + r.pageviews,
      events: null,
    });
  }
  return out;
}
