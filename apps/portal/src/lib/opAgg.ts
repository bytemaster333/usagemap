// SPDX-License-Identifier: Apache-2.0
// Range totals from the operator's per-day rows (operator.web-global-view, operator.api-global-view). Counts add up; rates are recomputed from the summed
// counts (bounce rate = bounces / visits), averages are weighted (visit duration by visits, suspect share by page
// views) — never an average of daily averages. Percentiles cannot be added, so they are only shown per day.

import type { ControlPlane } from "@usagemap/api-types";

export interface WebTotals {
  pageviews: number;
  pageviews_unidentified: number;
  visitors_sum: number;
  visits: number;
  bounces: number;
  bounce_rate_pct: number | null;
  avg_visit_duration_s: number | null;
  suspect_pageview_share: number | null;
}

export function sumWebDays(days: ControlPlane.OpWebDay[]): WebTotals {
  let pv = 0;
  let un = 0;
  let vis = 0;
  let visits = 0;
  let bounces = 0;
  let durW = 0;
  let suspW = 0;
  for (const d of days) {
    pv += d.pageviews;
    un += d.pageviews_unidentified;
    vis += d.visitors_sum;
    visits += d.visits;
    bounces += d.bounces;
    durW += (d.avg_visit_duration_s ?? 0) * d.visits;
    suspW += (d.suspect_pageview_share ?? 0) * d.pageviews;
  }
  return {
    pageviews: pv,
    pageviews_unidentified: un,
    visitors_sum: vis,
    visits,
    bounces,
    bounce_rate_pct: visits === 0 ? null : (bounces / visits) * 100,
    avg_visit_duration_s: visits === 0 ? null : durW / visits,
    suspect_pageview_share: pv === 0 ? null : suspW / pv,
  };
}

export interface ApiTotals {
  requests: number;
  s4xx: number;
  s5xx: number;
  error_rate_5xx: number | null;
  active_days: number;
}

export function sumApiDays(days: ControlPlane.OpApiDay[]): ApiTotals {
  let requests = 0;
  let s4xx = 0;
  let s5xx = 0;
  let active = 0;
  for (const d of days) {
    requests += d.requests;
    s4xx += d.s4xx ?? 0;
    s5xx += d.s5xx ?? 0;
    if (d.requests > 0) active++;
  }
  return {
    requests,
    s4xx,
    s5xx,
    error_rate_5xx: requests === 0 ? null : s5xx / requests,
    active_days: active,
  };
}

export type TrustBand = "high" | "medium" | "low" | "unscored";

/** The bands of the `trust_band` filter: 28-day score ≥ 80 / 50–79 / < 50 / none. */
export function trustBand(score: number | null | undefined): TrustBand {
  if (score === null || score === undefined) return "unscored";
  return score >= 80 ? "high" : score >= 50 ? "medium" : "low";
}

/**
 * Usage flags for the API services table (operator.api-usage-ranking): the busiest service of the selection, services without requests
 * in the range, and services active on fewer than a quarter of its days.
 */
export function usageFlag(
  row: { requests: number; active_days?: number | undefined },
  maxRequests: number,
  days: number,
): "highest" | "inactive" | "low" | null {
  if (row.requests === 0) return "inactive";
  if (row.requests === maxRequests && maxRequests > 0) return "highest";
  if (row.active_days !== undefined && row.active_days < Math.max(1, days / 4)) return "low";
  return null;
}

// ------------------------------------------------------------------------------------------ operator overview

/** Flag thresholds of the operator overview (2026-11-19): advisory, shown in the page. */
export const OVERVIEW_FLAGS = {
  /** share of page views tagged suspect */
  suspectShare: 0.2,
  /** 5xx share of all API requests of the project */
  errorRate: 0.05,
} as const;

export type OverviewFlag = "high_suspect_share" | "high_error_rate" | "no_data";

export interface OverviewRow {
  tenant_id: string;
  slug: string;
  name: string;
  verification_level: string;
  pageviews: number;
  visitors_sum: number;
  suspect_share: number | null;
  services: number;
  requests: number;
  s5xx: number;
  error_rate_5xx: number | null;
  flags: OverviewFlag[];
}

/**
 * One row per project with web and API columns (operatorWebProjects + operatorApiServices summed per project; the
 * project list supplies the projects without any data). 5xx counts are summed exactly; percentiles are not merged
 * across services and therefore not shown here (the API page has them per service).
 */
export function overviewRows(
  tenants: ReadonlyArray<{
    tenant_id: string;
    slug: string;
    name: string;
    verification_level: string;
  }>,
  web: ReadonlyArray<ControlPlane.OpWebProjectRow>,
  api: ReadonlyArray<ControlPlane.OpApiServiceRow>,
): OverviewRow[] {
  const rows = new Map<string, OverviewRow>();
  const row = (t: {
    tenant_id: string;
    slug: string;
    name?: string;
    verification_level: string;
  }) => {
    let r = rows.get(t.tenant_id);
    if (!r) {
      r = {
        tenant_id: t.tenant_id,
        slug: t.slug,
        name: t.name ?? t.slug,
        verification_level: t.verification_level,
        pageviews: 0,
        visitors_sum: 0,
        suspect_share: null,
        services: 0,
        requests: 0,
        s5xx: 0,
        error_rate_5xx: null,
        flags: [],
      };
      rows.set(t.tenant_id, r);
    }
    if (t.name) r.name = t.name;
    return r;
  };
  for (const t of tenants) row(t);
  for (const w of web) {
    const r = row(w);
    r.pageviews += w.pageviews;
    r.visitors_sum += w.visitors_sum;
    r.suspect_share = w.suspect_pageview_share;
  }
  for (const s of api) {
    const r = row(s);
    r.services++;
    r.requests += s.requests;
    r.s5xx += s.s5xx ?? Math.round((s.error_rate_5xx ?? 0) * s.requests);
  }
  for (const r of rows.values()) {
    r.error_rate_5xx = r.requests > 0 ? r.s5xx / r.requests : null;
    if (r.suspect_share !== null && r.suspect_share >= OVERVIEW_FLAGS.suspectShare)
      r.flags.push("high_suspect_share");
    if (r.error_rate_5xx !== null && r.error_rate_5xx >= OVERVIEW_FLAGS.errorRate)
      r.flags.push("high_error_rate");
    if (r.pageviews === 0 && r.requests === 0) r.flags.push("no_data");
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.flags.length - a.flags.length ||
      b.pageviews - a.pageviews ||
      b.requests - a.requests ||
      a.slug.localeCompare(b.slug),
  );
}
