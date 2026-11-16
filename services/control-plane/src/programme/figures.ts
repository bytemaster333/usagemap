// SPDX-License-Identifier: Apache-2.0
// Tenant-wide figures for the programme outputs (wire-formats §i.1, §i.3; ADR-0032): web totals from the daily rollups
// (`web_daily_totals`, never Umami), API totals from the preferred daily rows (`api_metrics_1d_pref`, C-22), the
// latest assurance level and on-chain badge. Exact values only — no breakdown rows, so no minimum count or rounding
// (C-95); never a trust score (C-47). Every query runs under the tenant's own context (RLS).

import { type AggRow, aggregateSql, LABEL } from "../api/metrics.ts";
import type { Tx } from "../db/database.ts";

export const DAY = 86_400_000;

export function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** First instants of the calendar months that intersect [start, end), each clipped to `start` (§i.3 `monthly`). */
export function monthStarts(start: number, end: number): number[] {
  const out: number[] = [];
  let d = new Date(start);
  let m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  while (m < end) {
    out.push(Math.max(m, start));
    d = new Date(m);
    m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}

export interface WebFigures {
  verified: { pageviews: number; visitors_sum: number };
  raw: { pageviews: number; visitors_sum: number };
  visit_metrics: {
    visits: number;
    bounces: number;
    bounce_rate_pct: number | null;
    avg_visit_duration_s: number | null;
    suspect_pageview_share: number | null;
  };
  /** per UTC day present in the rollups */
  days: Array<{ day: number; pv_v: number; pv_r: number; vis_v: number; vis_r: number }>;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

export async function tenantWeb(
  tx: Tx,
  tenantId: string,
  start: number,
  end: number,
): Promise<WebFigures> {
  const rows = await tx.query<{
    day: string;
    pv_v: string;
    pv_r: string;
    vis_v: string;
    vis_r: string;
    visits: string;
    bounces: string;
    dur: string;
  }>(
    `SELECT day::text AS day, sum(pageviews_verified)::text AS pv_v, sum(pageviews_raw)::text AS pv_r,
            sum(visitors_verified)::text AS vis_v, sum(visitors_raw)::text AS vis_r, sum(visits)::text AS visits,
            sum(bounces)::text AS bounces, sum(total_duration_s)::text AS dur
       FROM scf.web_daily_totals
      WHERE tenant_id = $1 AND day >= ($2::timestamptz AT TIME ZONE 'UTC')::date
        AND day < ($3::timestamptz AT TIME ZONE 'UTC')::date
      GROUP BY day ORDER BY day`,
    [tenantId, new Date(start), new Date(end)],
  );
  const t = { pv_v: 0, pv_r: 0, vis_v: 0, vis_r: 0, visits: 0, bounces: 0, dur: 0 };
  const days = rows.map((r) => {
    const d = {
      day: Date.parse(`${r.day}T00:00:00Z`),
      pv_v: Number(r.pv_v),
      pv_r: Number(r.pv_r),
      vis_v: Number(r.vis_v),
      vis_r: Number(r.vis_r),
    };
    t.pv_v += d.pv_v;
    t.pv_r += d.pv_r;
    t.vis_v += d.vis_v;
    t.vis_r += d.vis_r;
    t.visits += Number(r.visits);
    t.bounces += Number(r.bounces);
    t.dur += Number(r.dur);
    return d;
  });
  return {
    verified: { pageviews: t.pv_v, visitors_sum: t.vis_v },
    raw: { pageviews: t.pv_r, visitors_sum: t.vis_r },
    visit_metrics: {
      visits: t.visits,
      bounces: t.bounces,
      bounce_rate_pct: t.visits > 0 ? round((100 * t.bounces) / t.visits, 1) : null,
      avg_visit_duration_s: t.visits > 0 ? round(t.dur / t.visits, 1) : null,
      suspect_pageview_share: t.pv_r > 0 ? round((t.pv_r - t.pv_v) / t.pv_r, 4) : null,
    },
    days,
  };
}

export interface ApiFigures {
  label: typeof LABEL;
  requests: number;
  error_rate_5xx: number | null;
  p95_ms: number | null;
  accuracy_class: string | null;
  assurance_level: "A0" | "A1" | "A2" | null;
  onchain_consistent: "consistent" | "inconsistent" | "not_applicable" | "unavailable" | null;
  days: Array<{ day: number; requests: number }>;
}

export async function tenantApi(
  tx: Tx,
  tenantId: string,
  start: number,
  end: number,
): Promise<ApiFigures> {
  const src = `WITH m AS (SELECT * FROM scf.api_metrics_1d_pref v
                           WHERE v.tenant_id = $1 AND v.bucket_start >= $2 AND v.bucket_start < $3)`;
  const agg = aggregateSql("", "").replace(/^\s*WITH a AS/, ", a AS");
  const total = await tx.maybeOne<AggRow>(`${src}${agg}`, [
    tenantId,
    new Date(start),
    new Date(end),
  ]);
  const daily = await tx.query<{ day: string; n: string }>(
    `SELECT (bucket_start AT TIME ZONE 'UTC')::date::text AS day, sum(request_count)::text AS n
       FROM scf.api_metrics_1d_pref
      WHERE tenant_id = $1 AND bucket_start >= $2 AND bucket_start < $3
      GROUP BY 1 ORDER BY 1`,
    [tenantId, new Date(start), new Date(end)],
  );
  // Latest assurance row per active service within the window; the tenant shows its weakest service (conservative).
  const assurance = await tx.query<{ level: number; onchain_badge: string }>(
    `SELECT DISTINCT ON (a.service_id) a.level, a.onchain_badge
       FROM scf.api_service_assurance a
       JOIN scf.api_services s ON s.tenant_id = a.tenant_id AND s.service_id = a.service_id AND s.status = 'active'
      WHERE a.tenant_id = $1 AND a.day >= ($2::timestamptz AT TIME ZONE 'UTC')::date
        AND a.day < ($3::timestamptz AT TIME ZONE 'UTC')::date
      ORDER BY a.service_id, a.day DESC`,
    [tenantId, new Date(start), new Date(end)],
  );
  const n = Number(total?.n ?? 0);
  const n5 = Number(total?.n5 ?? 0);
  const p95 = total?.p95_s;
  const level = assurance.length ? Math.min(...assurance.map((a) => Number(a.level))) : null;
  const badges = new Set(assurance.map((a) => a.onchain_badge));
  const onchain = badges.has("inconsistent")
    ? "inconsistent"
    : badges.has("consistent")
      ? "consistent"
      : badges.has("unavailable")
        ? "unavailable"
        : badges.has("not_applicable")
          ? "not_applicable"
          : null;
  return {
    label: LABEL,
    requests: n,
    error_rate_5xx: n > 0 ? Math.round((n5 / n) * 10_000) / 10_000 : null,
    p95_ms: p95 === null || p95 === undefined ? null : Math.round(Number(p95) * 1e6) / 1e3,
    accuracy_class: n > 0 ? (total?.accuracy_class ?? null) : null,
    assurance_level: level === null ? null : (`A${level}` as "A0" | "A1" | "A2"),
    onchain_consistent: onchain,
    days: daily.map((d) => ({ day: Date.parse(`${d.day}T00:00:00Z`), requests: Number(d.n) })),
  };
}

/** Verification level, name, slug and confirmed registry sources of the tenant (§i.3 `project`). */
export async function projectInfo(tx: Tx, tenantId: string) {
  const t = await tx.one<{ slug: string; name: string; level: number; status: string }>(
    `SELECT slug, name, status::text AS status, scf.verification_level(tenant_id)::int AS level
       FROM scf.tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  const sources = await tx.query<{ source: string }>(
    `SELECT DISTINCT p.source FROM scf.tenant_registry_links l
       JOIN scf.registry_projects p ON p.registry_project_id = l.registry_project_id
      WHERE l.tenant_id = $1 AND l.status = 'confirmed' ORDER BY p.source`,
    [tenantId],
  );
  return {
    slug: t.slug,
    name: t.name,
    status: t.status,
    verification_level: `L${t.level}`,
    registry_matches: sources.map((s) => s.source),
  };
}

/**
 * Web traffic the gateway did not count as verified (2026-11-19 improvements; data-model §8.9 `web_edge_counters`):
 * events received in the window by verdict (exact totals, like the other document totals), their shares, and the
 * reason codes behind suspect and rejected events. Reason rows are a breakdown, so each passes `scf.op_count`
 * (k-threshold and rounding, C-95); rows under the threshold are left out and counted in `reasons_suppressed`.
 */
export interface FilteredFigures {
  events_received: number;
  verified: number;
  suspect: number;
  rejected: number;
  /** (suspect + rejected) ÷ received: events not in the verified figures; null without events */
  not_counted_share: number | null;
  suspect_share: number | null;
  rejected_share: number | null;
  reasons: Array<{ code: string; verdict: "suspect" | "rejected"; count: number }>;
  reasons_suppressed: number;
}

export async function tenantFiltered(
  tx: Tx,
  tenantId: string,
  start: number,
  end: number,
  verdictOf: Readonly<Record<string, "suspect" | "rejected">>,
): Promise<FilteredFigures> {
  const rows = await tx.query<{ counter: string; label: string; n: string; shown: string | null }>(
    `SELECT counter, label, sum(count)::text AS n, scf.op_count(sum(count)::bigint)::text AS shown
       FROM scf.web_edge_counters
      WHERE tenant_id = $1 AND counter IN ('verdict', 'reason')
        AND day >= ($2::timestamptz AT TIME ZONE 'UTC')::date AND day < ($3::timestamptz AT TIME ZONE 'UTC')::date
      GROUP BY counter, label`,
    [tenantId, new Date(start), new Date(end)],
  );
  const v = { verified: 0, suspect: 0, rejected: 0 };
  const reasons: FilteredFigures["reasons"] = [];
  let suppressed = 0;
  for (const r of rows) {
    if (r.counter === "verdict" && r.label in v) v[r.label as keyof typeof v] = Number(r.n);
    else if (r.counter === "reason") {
      const verdict = verdictOf[r.label];
      if (!verdict) continue; // not a §h.2 code: never published
      if (r.shown === null) suppressed++;
      else reasons.push({ code: r.label, verdict, count: Number(r.shown) });
    }
  }
  reasons.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
  const received = v.verified + v.suspect + v.rejected;
  const share = (n: number) => (received > 0 ? round(n / received, 4) : null);
  return {
    events_received: received,
    ...v,
    not_counted_share: share(v.suspect + v.rejected),
    suspect_share: share(v.suspect),
    rejected_share: share(v.rejected),
    reasons,
    reasons_suppressed: suppressed,
  };
}
