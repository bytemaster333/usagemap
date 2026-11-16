// SPDX-License-Identifier: Apache-2.0
// Web figures and their composition (C-73, C-110, C-51, C-95; wire-formats §j.3, §j.6). Pure functions.
//
// - Page views (verified/raw) include the twin website's page views; `*_unidentified` are the twin's alone.
// - Unique visitors are the main website's sessions; over several days the exact sum of daily uniques (C-110).
// - Visits, bounces and duration are one figure each (unfiltered main website), never added across tags or websites
//   for the same days — only across disjoint UTC days (live part + rollup part).

export interface Totals {
  pvVerified: number;
  pvRaw: number;
  pvUnidVerified: number;
  pvUnidRaw: number;
  visitorsVerified: number;
  visitorsRaw: number;
  visits: number;
  bounces: number;
  durationS: number;
}

export const ZERO: Totals = Object.freeze({
  pvVerified: 0,
  pvRaw: 0,
  pvUnidVerified: 0,
  pvUnidRaw: 0,
  visitorsVerified: 0,
  visitorsRaw: 0,
  visits: 0,
  bounces: 0,
  durationS: 0,
});

export function addTotals(a: Totals, b: Totals): Totals {
  return {
    pvVerified: a.pvVerified + b.pvVerified,
    pvRaw: a.pvRaw + b.pvRaw,
    pvUnidVerified: a.pvUnidVerified + b.pvUnidVerified,
    pvUnidRaw: a.pvUnidRaw + b.pvUnidRaw,
    visitorsVerified: a.visitorsVerified + b.visitorsVerified,
    visitorsRaw: a.visitorsRaw + b.visitorsRaw,
    visits: a.visits + b.visits,
    bounces: a.bounces + b.bounces,
    durationS: a.durationS + b.durationS,
  };
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export type Variant = "verified" | "raw" | "both";

export interface WebTotalsView {
  pageviews: number;
  pageviews_unidentified: number;
  visitors: number;
}

export interface VisitMetricsView {
  visits: number;
  bounces: number;
  bounce_rate_pct: number | null;
  avg_visit_duration_s: number | null;
  suspect_pageview_share: number | null;
}

/** Bounce rate in % (1 decimal), average visit duration in s (1 decimal), suspect share (4 decimals). */
export function visitMetrics(t: Totals): VisitMetricsView {
  return {
    visits: t.visits,
    bounces: t.bounces,
    bounce_rate_pct: t.visits > 0 ? round((100 * t.bounces) / t.visits, 1) : null,
    avg_visit_duration_s: t.visits > 0 ? round(t.durationS / t.visits, 1) : null,
    suspect_pageview_share: t.pvRaw > 0 ? round(1 - t.pvVerified / t.pvRaw, 4) : null,
  };
}

export function totalsView(t: Totals, variant: Variant): Record<string, WebTotalsView> {
  const out: Record<string, WebTotalsView> = {};
  if (variant !== "raw")
    out.verified = {
      pageviews: t.pvVerified,
      pageviews_unidentified: t.pvUnidVerified,
      visitors: t.visitorsVerified,
    };
  if (variant !== "verified")
    out.raw = {
      pageviews: t.pvRaw,
      pageviews_unidentified: t.pvUnidRaw,
      visitors: t.visitorsRaw,
    };
  return out;
}

// ------------------------------------------------------------------------------------------------- breakdowns

export interface BreakdownCounts {
  visitors: number | null;
  pageviews: number | null;
  events: number | null;
}

/** Per-value counts of one variant, keyed by value. */
export type BreakdownMap = Map<string, BreakdownCounts>;

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export function mergeBreakdowns(a: BreakdownMap, b: BreakdownMap): BreakdownMap {
  const out: BreakdownMap = new Map(a);
  for (const [k, v] of b) {
    const cur = out.get(k);
    out.set(
      k,
      cur
        ? {
            visitors: addNullable(cur.visitors, v.visitors),
            pageviews: addNullable(cur.pageviews, v.pageviews),
            events: addNullable(cur.events, v.events),
          }
        : { ...v },
    );
  }
  return out;
}

export interface BreakdownRowView {
  value: string;
  is_other: boolean;
  visitors: number | null;
  pageviews: number | null;
  events: number | null;
  share_pct: number | null;
}

/** C-51 defaults: rows below this count are merged into "Other" and displayed counts are rounded to this step. */
export const ANON_MIN_COUNT = 10;
export const ANON_ROUND_TO = 10;

/** The tenant-dashboard thresholds (settings `tenant_min_count`, `tenant_round_to`; C-51). */
export interface AnonPolicy {
  minCount: number;
  roundTo: number;
}

export const DEFAULT_ANON_POLICY: AnonPolicy = { minCount: ANON_MIN_COUNT, roundTo: ANON_ROUND_TO };

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/** The policy from the setting values; a missing or malformed value falls back to the C-51 default. */
export function anonPolicyOf(settings: Record<string, unknown>): AnonPolicy {
  return {
    minCount: positiveInt(settings.tenant_min_count) ?? ANON_MIN_COUNT,
    roundTo: positiveInt(settings.tenant_round_to) ?? ANON_ROUND_TO,
  };
}

function addCounts(a: BreakdownCounts | null, b: BreakdownCounts): BreakdownCounts {
  return a
    ? {
        visitors: addNullable(a.visitors, b.visitors),
        pageviews: addNullable(a.pageviews, b.pageviews),
        events: addNullable(a.events, b.events),
      }
    : { ...b };
}

/**
 * The minimum count applied per UTC day: a value's day contributes to the value's row only
 * when that day's ranking count (visitors; events for the `event` dimension) is at least `minCount`; the other days'
 * counts go to `suppressed` ("Other"). Visitors are daily uniques, so one person adds at most 1 per day and can never
 * meet the floor alone; and every day is floored on its own, so windows that differ by one day cannot be differenced
 * to reveal a below-k day.
 */
export function floorPerDay(
  days: readonly BreakdownMap[],
  minCount: number,
  byEvents: boolean,
): { rows: BreakdownMap; suppressed: BreakdownCounts | null } {
  const rows: BreakdownMap = new Map();
  let suppressed: BreakdownCounts | null = null;
  for (const d of days) {
    for (const [value, c] of d) {
      const rank = byEvents ? (c.events ?? 0) : (c.visitors ?? 0);
      if (rank >= minCount) rows.set(value, addCounts(rows.get(value) ?? null, c));
      else suppressed = addCounts(suppressed, c);
    }
  }
  return { rows, suppressed };
}

function roundTo(x: number | null, step: number): number | null {
  return x === null ? null : Math.round(x / step) * step;
}

/**
 * Orders the rows (by visitors — events for the `event` dimension — then page views, then value), merges into one
 * `is_other` row every row beyond `limit` and, with `anonymous` (C-51), every row whose ranking count is below the
 * policy's minimum count (with per-day input from `floorPerDay`, its `suppressed` counts join "Other" too); then rounds
 * the displayed counts to the policy's step when anonymous. `share_pct` is the row's ranking count as a share of the
 * sum over all rows (after rounding when anonymous), one decimal.
 */
export function presentBreakdown(
  rows: BreakdownMap,
  opts: {
    limit: number;
    anonymous: boolean;
    byEvents: boolean;
    policy?: AnonPolicy;
    suppressed?: BreakdownCounts | null;
  },
): BreakdownRowView[] {
  const policy = opts.policy ?? DEFAULT_ANON_POLICY;
  const rank = (c: BreakdownCounts) => (opts.byEvents ? (c.events ?? 0) : (c.visitors ?? 0));
  const sorted = [...rows.entries()].sort(
    ([va, a], [vb, b]) =>
      rank(b) - rank(a) ||
      (b.pageviews ?? 0) - (a.pageviews ?? 0) ||
      (va < vb ? -1 : va > vb ? 1 : 0),
  );
  const kept: Array<[string, BreakdownCounts]> = [];
  let other: BreakdownCounts | null = opts.suppressed ? { ...opts.suppressed } : null;
  for (const [value, c] of sorted) {
    const small = opts.anonymous && rank(c) < policy.minCount;
    if (!small && kept.length < opts.limit) {
      kept.push([value, c]);
      continue;
    }
    other = addCounts(other, c);
  }
  const shown: Array<{ value: string; is_other: boolean; c: BreakdownCounts }> = kept.map(
    ([value, c]) => ({ value, is_other: false, c }),
  );
  if (other) shown.push({ value: "Other", is_other: true, c: other });
  const display = shown.map((r) => ({
    ...r,
    c: opts.anonymous
      ? {
          visitors: roundTo(r.c.visitors, policy.roundTo),
          pageviews: roundTo(r.c.pageviews, policy.roundTo),
          events: roundTo(r.c.events, policy.roundTo),
        }
      : r.c,
  }));
  const total = display.reduce((s, r) => s + rank(r.c), 0);
  return display.map((r) => ({
    value: r.value,
    is_other: r.is_other,
    visitors: r.c.visitors,
    pageviews: r.c.pageviews,
    events: r.c.events,
    share_pct: total > 0 ? round((100 * rank(r.c)) / total, 1) : null,
  }));
}
