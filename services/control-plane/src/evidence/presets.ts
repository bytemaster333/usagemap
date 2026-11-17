// SPDX-License-Identifier: Apache-2.0
// Programme presets of the SCF Evidence Link (traction snapshot v3).
//
// Growth Hack (official rules L51): "The average WAA is
// the sum of WAAs for each week during the 4-week campaign period, divided by 4. An active account means the account
// that initiated at least one operation." We hold per contract and UTC day the number of distinct accounts that
// invoked a verified contract (`onchain_daily.distinct_invokers`), not weekly distinct accounts. A week's distinct
// count therefore is reported as an honest interval: at least the largest daily count of one contract, at most the sum
// of the daily counts over every contract and day. Weekly averages of the campaign are compared with the same number
// of whole ISO weeks immediately before it (the baseline). Our accounts are those that invoked the project's verified
// contracts — narrower than "initiated at least one operation" in the project's whole protocol (ambiguity A1).
//
// Public Goods renewal (official rules L101–L104, PG working group Metric Gate): report on the last three months'
// work and demonstrate measurable impact (for example usage). The quarter's adoption figures (on-chain calls,
// invoking accounts, verified web visitors, API requests) and reliability figures (API 5xx rate and p95), each with
// the previous calendar quarter for comparison, plus the three months. Uptime, downloads, dependents and the pony
// factor are PG Atlas signals we do not measure; they are listed as not measured, never estimated.

import type { Tx } from "../db/database.ts";
import { DAY, isoZ, monthStarts, tenantApi } from "../programme/figures.ts";
import { isoWeekStart } from "../programme/snapshot-v2.ts";

const WEEK = 7 * DAY;

/** [start, end) is one or more whole ISO weeks (Monday 00:00 UTC to Monday 00:00 UTC). */
export function isWholeIsoWeeks(start: number, end: number): boolean {
  return (
    start % DAY === 0 && isoWeekStart(start) === start && end > start && (end - start) % WEEK === 0
  );
}

/** The baseline of a Growth Hack campaign: the same number of whole ISO weeks immediately before it. */
export function growthHackBaseline(start: number, end: number): { start: number; end: number } {
  return { start: start - (end - start), end: start };
}

/** The calendar quarter before the one starting at `start`. */
export function previousQuarter(start: number): { start: number; end: number } {
  const d = new Date(start);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1), end: start };
}

export function quarterLabel(start: number): string {
  const d = new Date(start);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** Daily inputs of one window, read under the tenant's context. */
export interface WindowDays {
  web: Array<{ day: number; visitors_verified: number; pageviews_verified: number }>;
  api: Array<{ day: number; requests: number }> | null;
  /** per contract and day; null when the document has no on-chain figures */
  onchain: Array<{
    day: number;
    contract: string;
    invocations: number;
    successful: number;
    invokers: number;
  }> | null;
}

export interface WeekFigures {
  start: string;
  window: "baseline" | "campaign";
  onchain_calls: number | null;
  active_accounts_min: number | null;
  active_accounts_max: number | null;
  web_visitors_verified: number;
  api_requests: number | null;
}

/** Per ISO week of [start, end): the Growth Hack weekly values (pure). */
export function weeklyFigures(
  w: WindowDays,
  start: number,
  end: number,
  window: "baseline" | "campaign",
): WeekFigures[] {
  const out: WeekFigures[] = [];
  for (let s = start; s < end; s += WEEK) {
    const inWeek = (day: number) => day >= s && day < s + WEEK;
    const oc = w.onchain?.filter((o) => inWeek(o.day)) ?? null;
    out.push({
      start: isoZ(s),
      window,
      onchain_calls: oc ? oc.reduce((a, o) => a + o.invocations, 0) : null,
      active_accounts_min: oc ? oc.reduce((a, o) => Math.max(a, o.invokers), 0) : null,
      active_accounts_max: oc ? oc.reduce((a, o) => a + o.invokers, 0) : null,
      web_visitors_verified: w.web
        .filter((d) => inWeek(d.day))
        .reduce((a, d) => a + d.visitors_verified, 0),
      api_requests: w.api
        ? w.api.filter((d) => inWeek(d.day)).reduce((a, d) => a + d.requests, 0)
        : null,
    });
  }
  return out;
}

type Metric =
  | "onchain_calls"
  | "active_accounts_min"
  | "active_accounts_max"
  | "web_visitors_verified"
  | "api_requests";
const METRICS: Metric[] = [
  "onchain_calls",
  "active_accounts_min",
  "active_accounts_max",
  "web_visitors_verified",
  "api_requests",
];

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Sum of the weekly values ÷ number of weeks (the Growth Hack "average WAA"), one decimal; null without data. */
export function weeklyAverage(weeks: WeekFigures[], m: Metric): number | null {
  if (weeks.length === 0) return null;
  let s = 0;
  for (const w of weeks) {
    const v = w[m];
    if (v === null) return null;
    s += v;
  }
  return r1(s / weeks.length);
}

export interface Averages {
  baseline: Record<Metric, number | null>;
  campaign: Record<Metric, number | null>;
  /** campaign − baseline (the Growth Hack "increase") */
  change: Record<Metric, number | null>;
  /** campaign ÷ baseline, 4 digits; null when the baseline is 0 or missing */
  ratio: Record<Metric, number | null>;
}

export function campaignAverages(baseline: WeekFigures[], campaign: WeekFigures[]): Averages {
  const a = {} as Averages;
  a.baseline = {} as Record<Metric, number | null>;
  a.campaign = {} as Record<Metric, number | null>;
  a.change = {} as Record<Metric, number | null>;
  a.ratio = {} as Record<Metric, number | null>;
  for (const m of METRICS) {
    const b = weeklyAverage(baseline, m);
    const c = weeklyAverage(campaign, m);
    a.baseline[m] = b;
    a.campaign[m] = c;
    a.change[m] = b === null || c === null ? null : r1(c - b);
    a.ratio[m] = b === null || c === null || b === 0 ? null : Math.round((c / b) * 10_000) / 10_000;
  }
  return a;
}

export interface CohortShare {
  status: "shown" | "not_enough_projects" | "no_increase" | "no_cohort" | "no_onchain_data";
  cohort: { kind: "round" | "category"; id: string } | null;
  /** projects of the cohort with on-chain data in both windows (shown only from the floor up) */
  projects: number | null;
  /** max(Δ, 0) ÷ Σ max(Δ, 0) over the cohort, rounded to 0.01 */
  share: number | null;
}

/**
 * The Growth Hack award formula's X/ΣX on our footprint data (pure): the project's share of the cohort's total
 * increase in average weekly on-chain calls. `deltas` are the increases of every cohort member with on-chain data in
 * both windows, the project's own included. Shown only with at least `minProjects` members (C-136 floor ≥ 5).
 */
export function cohortShare(
  cohort: CohortShare["cohort"],
  self: number | null,
  deltas: number[],
  minProjects: number,
): CohortShare {
  if (!cohort) return { status: "no_cohort", cohort: null, projects: null, share: null };
  if (self === null) return { status: "no_onchain_data", cohort, projects: null, share: null };
  if (deltas.length < minProjects)
    return { status: "not_enough_projects", cohort, projects: null, share: null };
  const total = deltas.reduce((a, d) => a + Math.max(d, 0), 0);
  if (total <= 0 || self <= 0)
    return { status: "no_increase", cohort, projects: deltas.length, share: null };
  return {
    status: "shown",
    cohort,
    projects: deltas.length,
    share: Math.round((Math.max(self, 0) / total) * 100) / 100,
  };
}

export interface QuarterFigures {
  onchain_calls: number | null;
  onchain_successful_calls: number | null;
  onchain_invokers_daily_sum: number | null;
  web_visitors_verified: number;
  web_pageviews_verified: number;
  api_requests: number | null;
  api_error_rate_5xx: number | null;
  api_p95_ms: number | null;
}

export function quarterTotals(
  w: WindowDays,
  api: { error_rate_5xx: number | null; p95_ms: number | null } | null,
): QuarterFigures {
  const sum = <T>(xs: T[] | null, f: (x: T) => number) =>
    xs ? xs.reduce((a, x) => a + f(x), 0) : null;
  return {
    onchain_calls: sum(w.onchain, (o) => o.invocations),
    onchain_successful_calls: sum(w.onchain, (o) => o.successful),
    onchain_invokers_daily_sum: sum(w.onchain, (o) => o.invokers),
    web_visitors_verified: w.web.reduce((a, d) => a + d.visitors_verified, 0),
    web_pageviews_verified: w.web.reduce((a, d) => a + d.pageviews_verified, 0),
    api_requests: sum(w.api, (d) => d.requests),
    api_error_rate_5xx: api?.error_rate_5xx ?? null,
    api_p95_ms: api?.p95_ms ?? null,
  };
}

/** (current − previous) ÷ previous, 4 digits; null when previous is 0 or missing. */
export function relativeChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 10_000) / 10_000;
}

export const PG_NOT_MEASURED = ["uptime", "downloads", "direct_dependents", "pony_factor"] as const;

export function publicGoodsBlock(
  start: number,
  end: number,
  cur: WindowDays,
  curApi: { error_rate_5xx: number | null; p95_ms: number | null } | null,
  prev: WindowDays,
  prevApi: { error_rate_5xx: number | null; p95_ms: number | null } | null,
): Record<string, unknown> {
  const pq = previousQuarter(start);
  const c = quarterTotals(cur, curApi);
  const p = quarterTotals(prev, prevApi);
  const figures = (Object.keys(c) as Array<keyof QuarterFigures>).map((metric) => ({
    metric,
    value: c[metric],
    previous: p[metric],
    change:
      metric.startsWith("api_error") || metric === "api_p95_ms"
        ? null
        : relativeChange(c[metric], p[metric]),
  }));
  const months = monthStarts(start, end).map((m, i, all) => {
    const mEnd = all[i + 1] ?? end;
    const inM = (day: number) => day >= m && day < mEnd;
    return {
      start: isoZ(m),
      onchain_calls: cur.onchain
        ? cur.onchain.filter((o) => inM(o.day)).reduce((a, o) => a + o.invocations, 0)
        : null,
      web_visitors_verified: cur.web
        .filter((d) => inM(d.day))
        .reduce((a, d) => a + d.visitors_verified, 0),
      api_requests: cur.api
        ? cur.api.filter((d) => inM(d.day)).reduce((a, d) => a + d.requests, 0)
        : null,
    };
  });
  return {
    quarter: quarterLabel(start),
    previous_quarter: { label: quarterLabel(pq.start), start: isoZ(pq.start), end: isoZ(pq.end) },
    figures,
    monthly: months,
    not_measured: [...PG_NOT_MEASURED],
  };
}

/** One window's daily inputs (tenant context, job public_metrics); contracts = the verified footprint refs. */
export async function loadWindow(
  tx: Tx,
  tenantId: string,
  start: number,
  end: number,
  includeApi: boolean,
  contracts: string[] | null,
): Promise<{
  days: WindowDays;
  api: { error_rate_5xx: number | null; p95_ms: number | null } | null;
}> {
  const d0 = isoZ(start).slice(0, 10);
  const d1 = isoZ(end).slice(0, 10);
  const web = await tx.query<{ day: string; v: string; pv: string }>(
    `SELECT day::text AS day, sum(visitors_verified)::text AS v, sum(pageviews_verified)::text AS pv
       FROM scf.web_daily_totals WHERE tenant_id = $1 AND day >= $2::date AND day < $3::date GROUP BY day`,
    [tenantId, d0, d1],
  );
  let api: WindowDays["api"] = null;
  let apiSummary: { error_rate_5xx: number | null; p95_ms: number | null } | null = null;
  if (includeApi) {
    const a = await tenantApi(tx, tenantId, start, end);
    api = a.days;
    apiSummary = { error_rate_5xx: a.error_rate_5xx, p95_ms: a.p95_ms };
  }
  let onchain: WindowDays["onchain"] = null;
  if (contracts && contracts.length > 0) {
    const rows = await tx.query<{ day: string; c: string; inv: string; ok: string; d: string }>(
      `SELECT day::text AS day, contract_ref::text AS c, invocations::text AS inv,
              successful_invocations::text AS ok, distinct_invokers::text AS d
         FROM scf.onchain_daily
        WHERE tenant_id = $1 AND contract_ref = ANY($2::uuid[]) AND day >= $3::date AND day < $4::date`,
      [tenantId, contracts, d0, d1],
    );
    onchain = rows.map((r) => ({
      day: Date.parse(`${r.day}T00:00:00Z`),
      contract: r.c,
      invocations: Number(r.inv),
      successful: Number(r.ok),
      invokers: Number(r.d),
    }));
  }
  return {
    days: {
      web: web.map((r) => ({
        day: Date.parse(`${r.day}T00:00:00Z`),
        visitors_verified: Number(r.v),
        pageviews_verified: Number(r.pv),
      })),
      api,
      onchain,
    },
    api: apiSummary,
  };
}
