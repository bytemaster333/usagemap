// SPDX-License-Identifier: Apache-2.0
// Builds `scf-analytics/metrics-endpoint/1` documents (docs/contracts/wire-formats.md §i.1) for the 20 synthetic DEMO
// projects of tools/demo-seed, from the same deterministic generators the seed uses (plan, daily sessions, daily API
// volume). No network, no database: the badge and feed prototypes run against exactly the shape the control plane
// serves at /public/v1/projects/{slug}/metrics.json.

import { apiDayTotal } from "../../../../tools/demo-seed/src/derived.ts";
import { buildPlan, DEFAULT_PHRASE, type TenantPlan } from "../../../../tools/demo-seed/src/plan.ts";
import { siteHistory } from "../../../../tools/demo-seed/src/sql.ts";
import { DAY_MS, dayString } from "../../../../tools/demo-seed/src/traffic.ts";

export interface MetricsDoc {
  schema: "scf-analytics/metrics-endpoint/1";
  project: { slug: string; name: string; verification_level: "L0" | "L1" | "L2" | "L3" | "L4" };
  generated_at: string;
  window: { start: string; end: string; days: number };
  web: {
    verified: { pageviews: number; visitors_sum: number };
    raw: { pageviews: number; visitors_sum: number };
    visit_metrics: {
      visits: number;
      bounces: number;
      bounce_rate_pct: number | null;
      avg_visit_duration_s: number | null;
      suspect_pageview_share: number | null;
    };
    daily: {
      start: string;
      pageviews_verified: number;
      pageviews_raw: number;
      visitors_sum_verified: number;
      visitors_sum_raw: number;
    }[];
  };
  api: {
    label: "self-attested telemetry";
    requests: number;
    error_rate_5xx: number | null;
    p95_ms: number | null;
    accuracy_class: "exp3" | "explicit15" | "explicit15_approx" | "coarse" | null;
    assurance_level: "A0" | "A1" | "A2" | null;
    onchain_consistent?: "consistent" | "inconsistent" | "not_applicable" | "unavailable" | null;
    daily: { start: string; requests: number }[];
  };
  links: { definitions: string };
}

export const WINDOW_DAYS = 30;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const r1 = (x: number) => Math.round(x * 10) / 10;

export function metricsDocOf(t: TenantPlan, today: Date, phrase = DEFAULT_PHRASE): MetricsDoc {
  const days = siteHistory(t, { phrase, today, historyDays: WINDOW_DAYS });
  const sum = (f: (d: (typeof days)[number]) => number) => days.reduce((a, d) => a + f(d), 0);
  const pvV = sum((d) => d.totals.pageviews_verified);
  const pvR = sum((d) => d.totals.pageviews_raw);
  const visits = sum((d) => d.totals.visits);
  const bounces = sum((d) => d.totals.bounces);
  const dur = sum((d) => d.totals.total_duration_s);
  const apiDaily = t.api
    ? Array.from({ length: WINDOW_DAYS }, (_, i) => {
        const back = WINDOW_DAYS - i;
        const day = dayString(today, back);
        return { start: `${day}T00:00:00Z`, requests: apiDayTotal(t.api!, phrase, day, back, WINDOW_DAYS) };
      })
    : [];
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return {
    schema: "scf-analytics/metrics-endpoint/1",
    project: { slug: t.slug, name: t.name, verification_level: t.level },
    generated_at: new Date(midnight + 3_600_000).toISOString().replace(".000Z", "Z"),
    window: {
      start: new Date(midnight - WINDOW_DAYS * DAY_MS).toISOString().replace(".000Z", "Z"),
      end: new Date(midnight).toISOString().replace(".000Z", "Z"),
      days: WINDOW_DAYS,
    },
    web: {
      verified: { pageviews: pvV, visitors_sum: sum((d) => d.totals.visitors_verified) },
      raw: { pageviews: pvR, visitors_sum: sum((d) => d.totals.visitors_raw) },
      visit_metrics: {
        visits,
        bounces,
        bounce_rate_pct: visits ? r1((100 * bounces) / visits) : null,
        avg_visit_duration_s: visits ? r1(dur / visits) : null,
        suspect_pageview_share: pvR ? r4((pvR - pvV) / pvR) : null,
      },
      daily: days.map((d) => ({
        start: `${d.day}T00:00:00Z`,
        pageviews_verified: d.totals.pageviews_verified,
        pageviews_raw: d.totals.pageviews_raw,
        visitors_sum_verified: d.totals.visitors_verified,
        visitors_sum_raw: d.totals.visitors_raw,
      })),
    },
    api: {
      label: "self-attested telemetry",
      requests: apiDaily.reduce((a, d) => a + d.requests, 0),
      error_rate_5xx: t.api ? t.api.errorRate5xx : null,
      p95_ms: null,
      accuracy_class: t.api ? "exp3" : null,
      assurance_level: t.api ? (`A${t.api.assurance}` as "A0" | "A1" | "A2") : null,
      onchain_consistent: t.api ? "not_applicable" : null,
      daily: apiDaily,
    },
    links: { definitions: "http://localhost:5173/docs/metric-definitions/1" },
  };
}

/** The demo cohort and its metrics documents, for a fixed "today" so every output is reproducible. */
export function demoCohort(today: Date, phrase = DEFAULT_PHRASE): { plan: TenantPlan; doc: MetricsDoc }[] {
  return buildPlan(phrase).map((plan) => ({ plan, doc: metricsDocOf(plan, today, phrase) }));
}
