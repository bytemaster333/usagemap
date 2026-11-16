// SPDX-License-Identifier: Apache-2.0
// Job `trust_scoring` (daily 03:00 UTC; ADR-0008 L7, ADR-0028, C-44, CR-35; data-model §8.10).
//
// For D-1 (after `web_rollup` closed it) and D-4 (final rollups, FINAL_AFTER_DAYS) it writes, per site, `web_trust_scores` for
// window_days 1 and 28 (algorithm in src/trust/algorithm.ts), and per API service with data that day
// `api_service_assurance`:
//   A0  the service reported data with a valid ingest token that day (tenant bound server-side) — every row has it;
//   A1  plausibility (A1-1.0.0): structural (no malformed_point / negative_value / count_overflow, status codes in
//       100–599, duration_min ≥ 0 and ≤ duration_max) → a1_status_mix_implausible; latency shape (≥ 1,000 requests
//       with a mean below 0.1 ms) → a1_latency_implausible; seasonality (requests > 10 × the median of ≥ 7 previous
//       days) → a1_rate_implausible; route cardinality vs volume (route_overflow counted) → a1_route_profile_implausible;
//   A2  liveness probe of the declared base URL — the probe is not part of this job (the jobs service has no egress);
//       without a base URL `a2_no_base_url`, otherwise A2 is "not_probed" and not passed. A0–A2 are cumulative.
//   A3  separate badge: `not_applicable` (read-only API, or no verified declared contract — a3_not_applicable /
//       a3_no_verified_contract), `unavailable` (no on-chain rows for the day), `consistent` / `inconsistent` (requests
//       reported but no successful invocation of any verified contract that day → a3_onchain_inconsistent).
// Reads are cross-tenant (named job, tenant unset); writes are per tenant under that tenant's context (F1).
// Canary tenants are scored but never enter ecosystem percentiles. Upserts make re-runs idempotent.
// Burstiness reads the day's hourly raw page views from web_hourly_totals (policy since migration 0057); a site
// without hourly rows for the day has burst omitted.

import type { ScfDb, Tx } from "../db.ts";
import { FINAL_AFTER_DAYS } from "../rollup/compute.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import { addDays, utcDay } from "../schedule.ts";
import {
  ALGORITHM_VERSION,
  type Counts,
  percentileRank,
  type SiteInputs,
  scoreSite,
  type TrustResult,
  validWeights,
  type Weights,
} from "../trust/algorithm.ts";

const JOB = "trust_scoring" as const;
export const ASSURANCE_VERSION = "A1-1.0.0";

export function trustScoringJob(
  db: ScfDb,
  dailyAt: { hour: number; minute: number },
  network: "public" | "testnet",
): JobDef {
  return {
    name: JOB,
    triggers: [{ schedule: { kind: "daily", ...dailyAt }, mode: "daily" }],
    run: async (ctx) => {
      const today = utcDay(ctx.now);
      for (const day of [addDays(today, -FINAL_AFTER_DAYS), addDays(today, -1)]) {
        checkAborted(ctx.signal);
        await runTrustScoring(db, day, ctx, network);
      }
    },
  };
}

interface SiteRow {
  tenant_id: string;
  site_id: string;
  canary: boolean;
}

interface Settings {
  weights: Weights;
  version: string;
  minCount: number;
  ecoMin: number;
}

async function settings(tx: Tx): Promise<Settings> {
  const r = await tx.one<{ w: unknown; v: unknown; k: number; e: number }>(
    `SELECT (SELECT s.value FROM scf.settings s WHERE s.key = 'trust_weights') AS w,
            (SELECT s.value FROM scf.settings s WHERE s.key = 'trust_algorithm_version') AS v,
            scf.setting_int('op_min_count') AS k, scf.setting_int('ecosystem_percentile_min_tenants') AS e`,
  );
  if (r.v !== ALGORITHM_VERSION) {
    throw Object.assign(new Error("trust_algorithm_version does not match this build"), {
      name: "TrustVersionMismatch",
    });
  }
  return { weights: validWeights(r.w), version: ALGORITHM_VERSION, minCount: r.k, ecoMin: r.e };
}

export interface TrustRunResult {
  sites: number;
  scored: number;
  insufficient: number;
  services: number;
  ecoPercentiles: boolean;
}

export async function runTrustScoring(
  db: ScfDb,
  day: string,
  ctx: JobContext,
  /** This deployment's Stellar network (SCF_STELLAR_NETWORK): the A3 badge counts only its contracts. */
  network: "public" | "testnet" = "public",
): Promise<TrustRunResult> {
  const from28 = addDays(day, -27);
  const hist0 = addDays(day, -28);
  const read = await db.tx(JOB, null, async (tx) => {
    const s = await settings(tx);
    const sites = await tx.query<SiteRow>(
      `SELECT s.tenant_id, s.site_id, t.is_canary AS canary FROM scf.sites s JOIN scf.tenants t USING (tenant_id)
        WHERE t.status IN ('active', 'pending', 'suspended') ORDER BY s.tenant_id, s.site_id`,
    );
    const totals = await tx.query<{ site_id: string; day: string; raw: number; ver: number }>(
      `SELECT d.site_id, to_char(d.day, 'YYYY-MM-DD') AS day, d.pageviews_raw AS raw, d.pageviews_verified AS ver
         FROM scf.web_daily_totals d WHERE d.day BETWEEN $1::date AND $2::date`,
      [hist0, day],
    );
    const counters = await tx.query<{
      site_id: string;
      recent: boolean;
      counter: string;
      label: string;
      n: number;
    }>(
      `SELECT c.site_id, c.day = $2::date AS recent, c.counter, c.label, sum(c.count)::bigint AS n
         FROM scf.web_edge_counters c
        WHERE c.day BETWEEN $1::date AND $2::date
          AND c.counter IN ('verdict', 'asn_class', 'multiplicity', 'client_signal', 'pow_latency')
        GROUP BY 1, 2, 3, 4`,
      [from28, day],
    );
    const mix = await tx.query<{
      site_id: string;
      recent: boolean;
      dimension: string;
      value: string;
      n: number;
    }>(
      `SELECT b.site_id, b.day = $2::date AS recent, b.dimension::text, b.value, sum(b.pageviews)::bigint AS n
         FROM scf.web_daily_breakdowns b
        WHERE b.day BETWEEN $1::date AND $2::date AND b.variant = 'raw' AND b.dimension IN ('device', 'country')
        GROUP BY 1, 2, 3, 4`,
      [hist0, day],
    );
    // UTC hours of the day (web_rollup writes hour_start in UTC); raw page views, as the step half uses.
    const hourly = await tx.query<{ site_id: string; h: number; n: number }>(
      `SELECT w.site_id, extract(hour FROM w.hour_start AT TIME ZONE 'UTC')::int AS h, sum(w.pageviews_raw)::bigint AS n
         FROM scf.web_hourly_totals w
        WHERE w.hour_start >= ($1::date)::timestamp AT TIME ZONE 'UTC'
          AND w.hour_start < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
        GROUP BY 1, 2`,
      [day],
    );
    return { s, sites, totals, counters, mix, hourly };
  });

  // Assemble inputs per site and window.
  const results = new Map<string, { site: SiteRow; w1: TrustResult; w28: TrustResult }>();
  for (const site of read.sites) {
    const t = read.totals.filter((x) => x.site_id === site.site_id);
    const today = t.find((x) => x.day === day);
    const w28rows = t.filter((x) => x.day >= from28);
    const history = t.filter((x) => x.day < day).map((x) => x.raw);
    const cnt = (dayOnly: boolean) => {
      const out: SiteInputs["counters"] = {};
      for (const c of read.counters) {
        if (c.site_id !== site.site_id || (dayOnly && !c.recent)) continue;
        const k = c.counter as keyof SiteInputs["counters"];
        const m: Counts = out[k] ?? {};
        m[c.label] = (m[c.label] ?? 0) + c.n;
        out[k] = m;
      }
      return out;
    };
    const mixOf = (dim: string, recent: boolean): Counts =>
      Object.fromEntries(
        read.mix
          .filter((m) => m.site_id === site.site_id && m.dimension === dim && m.recent === recent)
          .map((m) => [m.value, m.n]),
      );
    const hours = read.hourly.filter((x) => x.site_id === site.site_id);
    let hourly: number[] | undefined;
    if (hours.length > 0) {
      hourly = new Array<number>(24).fill(0);
      for (const x of hours) hourly[x.h] = (hourly[x.h] ?? 0) + Number(x.n);
    }
    const w1 = scoreSite(
      {
        pageviewsRaw: today?.raw ?? 0,
        pageviewsVerified: today?.ver ?? 0,
        counters: cnt(true),
        mix: {
          device: [mixOf("device", true), mixOf("device", false)],
          country: [mixOf("country", true), mixOf("country", false)],
        },
        history,
        ...(hourly ? { hourly } : {}),
      },
      read.s.weights,
      read.s.minCount,
    );
    const w28 = scoreSite(
      {
        pageviewsRaw: w28rows.reduce((a, x) => a + x.raw, 0),
        pageviewsVerified: w28rows.reduce((a, x) => a + x.ver, 0),
        counters: cnt(false),
      },
      read.s.weights,
      read.s.minCount,
    );
    results.set(site.site_id, { site, w1, w28 });
  }

  // Ecosystem percentiles (informational in trust/1.0.0) only with enough active, non-canary tenants (C-44).
  const eligible = [...results.values()].filter((r) => !r.site.canary && r.w1.score !== null);
  const activeTenants = new Set(eligible.map((r) => r.site.tenant_id)).size;
  const eco = activeTenants >= read.s.ecoMin;
  if (eco) {
    for (const w of ["w1", "w28"] as const) {
      const values = new Map<string, number[]>();
      for (const r of eligible) {
        for (const [k, c] of Object.entries(r[w].components)) {
          if (c.value !== null) values.set(k, [...(values.get(k) ?? []), c.value]);
        }
      }
      for (const r of results.values()) {
        for (const [k, c] of Object.entries(r[w].components)) {
          if (c.value !== null && values.has(k))
            c.eco_percentile = percentileRank(c.value, values.get(k) as number[]);
        }
      }
    }
  }

  // Writes per tenant.
  const byTenant = new Map<string, Array<{ site: SiteRow; w1: TrustResult; w28: TrustResult }>>();
  for (const r of results.values())
    byTenant.set(r.site.tenant_id, [...(byTenant.get(r.site.tenant_id) ?? []), r]);
  let scored = 0;
  let insufficient = 0;
  for (const [tenantId, rows] of byTenant) {
    checkAborted(ctx.signal);
    await db.tx(JOB, tenantId, async (tx) => {
      for (const r of rows) {
        for (const [windowDays, res] of [
          [1, r.w1],
          [28, r.w28],
        ] as const) {
          await tx.exec(
            `INSERT INTO scf.web_trust_scores (tenant_id, site_id, day, window_days, score, components, reason_codes,
                                               decision_rate, algorithm_version, computed_at)
             VALUES ($1, $2, $3::date, $4, $5, $6::jsonb, $7::text[], $8, $9, now())
             ON CONFLICT (tenant_id, site_id, day, window_days) DO UPDATE
               SET score = EXCLUDED.score, components = EXCLUDED.components, reason_codes = EXCLUDED.reason_codes,
                   decision_rate = EXCLUDED.decision_rate, algorithm_version = EXCLUDED.algorithm_version,
                   computed_at = EXCLUDED.computed_at`,
            [
              tenantId,
              r.site.site_id,
              day,
              windowDays,
              res.score,
              JSON.stringify(res.components),
              res.reason_codes,
              res.decision_rate,
              read.s.version,
            ],
          );
        }
        if (r.w1.score === null) insufficient += 1;
        else scored += 1;
      }
    });
  }
  const services = await scoreServices(db, day, network, ctx);
  ctx.metrics.units.inc({ job: JOB, outcome: "day_scored" });
  ctx.metrics.rows.inc(
    { job: JOB, relation: "web_trust_scores", action: "upserted" },
    results.size * 2,
  );
  ctx.metrics.rows.inc(
    { job: JOB, relation: "api_service_assurance", action: "upserted" },
    services,
  );
  ctx.log.info("trust_scoring_done", {
    job: JOB,
    day,
    sites: results.size,
    scored,
    insufficient,
    services,
    eco,
  });
  return { sites: results.size, scored, insufficient, services, ecoPercentiles: eco };
}

interface ServiceRow {
  tenant_id: string;
  service_id: string;
  read_only_api: boolean;
  base_url: boolean;
  requests: number;
  dmin: number | null;
  dmax: number | null;
  dsum: number;
  bad_status: boolean;
}

export interface AssuranceResult {
  level: number;
  onchain_badge: "consistent" | "inconsistent" | "not_applicable" | "unavailable";
  checks: Record<string, unknown>;
  reason_codes: string[];
}

export function assurance(
  s: ServiceRow,
  dq: Record<string, number>,
  history: number[],
  onchain: { verified: number; rows: number; successful: number },
): AssuranceResult {
  const a1: string[] = [];
  if (
    (dq.malformed_point ?? 0) + (dq.negative_value ?? 0) + (dq.count_overflow ?? 0) > 0 ||
    s.bad_status ||
    (s.dmin !== null && (s.dmin < 0 || (s.dmax !== null && s.dmax < s.dmin)))
  ) {
    a1.push("a1_status_mix_implausible");
  }
  if (s.requests >= 1000 && s.dsum / s.requests < 0.0001) a1.push("a1_latency_implausible");
  if (history.length >= 7) {
    const sorted = [...history].sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)] as number;
    if (med > 0 && s.requests > 10 * med) a1.push("a1_rate_implausible");
  }
  if ((dq.route_overflow ?? 0) > 0) a1.push("a1_route_profile_implausible");
  const a1pass = a1.length === 0;
  const a2codes = s.base_url ? [] : ["a2_no_base_url"];
  const level = a1pass ? 1 : 0; // A2 needs a probe result (not produced by this job): never passed here
  let badge: AssuranceResult["onchain_badge"];
  const a3: string[] = [];
  if (s.read_only_api) {
    badge = "not_applicable";
    a3.push("a3_not_applicable");
  } else if (onchain.verified === 0) {
    badge = "not_applicable";
    a3.push("a3_no_verified_contract");
  } else if (onchain.rows === 0) badge = "unavailable";
  else if (s.requests > 0 && onchain.successful === 0) {
    badge = "inconsistent";
    a3.push("a3_onchain_inconsistent");
  } else badge = "consistent";
  return {
    level,
    onchain_badge: badge,
    checks: {
      version: ASSURANCE_VERSION,
      A0: { pass: true, codes: [] },
      A1: { pass: a1pass, codes: a1 },
      A2: { pass: false, status: s.base_url ? "not_probed" : "no_base_url", codes: a2codes },
      A3: { badge, codes: a3 },
    },
    reason_codes: [...a1, ...a2codes, ...a3],
  };
}

/**
 * A3 inputs per (tenant, service): verified contracts counted for the badge and their on-chain rows of the day. Only
 * contracts on this deployment's network ($2, SCF_STELLAR_NETWORK) and without an open footprint conflict count
 * (C-137: a conflicted contract is counted nowhere) — the same set onchain_correlation reads.
 */
export const ONCHAIN_BADGE_SQL = `SELECT c.tenant_id, c.service_id, count(*)::int AS verified, count(o.day)::int AS rows,
        COALESCE(sum(o.successful_invocations), 0)::bigint AS ok
   FROM scf.declared_contracts c
   LEFT JOIN scf.onchain_daily o ON o.tenant_id = c.tenant_id AND o.contract_ref = c.contract_ref AND o.day = $1::date
  WHERE c.status = 'verified' AND c.removed_at IS NULL AND c.conflict_since IS NULL AND c.network = $2
  GROUP BY 1, 2`;

async function scoreServices(
  db: ScfDb,
  day: string,
  network: "public" | "testnet",
  ctx: JobContext,
): Promise<number> {
  const read = await db.tx(JOB, null, async (tx) => ({
    services: await tx.query<ServiceRow>(
      `SELECT s.tenant_id, s.service_id, s.read_only_api, s.declared_base_url IS NOT NULL AS base_url,
              sum(m.request_count)::bigint AS requests, min(m.duration_min) AS dmin, max(m.duration_max) AS dmax,
              COALESCE(sum(m.duration_sum), 0) AS dsum,
              bool_or(m.status_code IS NOT NULL AND m.status_code NOT BETWEEN 100 AND 599) AS bad_status
         FROM scf.api_services s JOIN scf.tenants t USING (tenant_id)
         JOIN scf.api_metrics_1d m ON m.tenant_id = s.tenant_id AND m.service_id = s.service_id
        WHERE t.status IN ('active', 'pending', 'suspended')
          AND m.bucket_start >= $1::date AND m.bucket_start < $1::date + 1
        GROUP BY 1, 2, 3, 4 HAVING sum(m.request_count) > 0`,
      [day],
    ),
    dq: await tx.query<{ service_id: string; reason: string; n: number }>(
      `SELECT c.service_id, c.reason, sum(c.count)::bigint AS n FROM scf.api_ingest_counters c
        WHERE c.day = $1::date AND c.service_id IS NOT NULL GROUP BY 1, 2`,
      [day],
    ),
    history: await tx.query<{ service_id: string; n: number }>(
      `SELECT m.service_id, sum(m.request_count)::bigint AS n FROM scf.api_metrics_1d m
        WHERE m.bucket_start >= $1::date - 28 AND m.bucket_start < $1::date
        GROUP BY m.service_id, m.bucket_start`,
      [day],
    ),
    onchain: await tx.query<{
      tenant_id: string;
      service_id: string | null;
      verified: number;
      rows: number;
      ok: number;
    }>(ONCHAIN_BADGE_SQL, [day, network]),
  }));
  const byTenant = new Map<string, Array<[ServiceRow, AssuranceResult]>>();
  for (const s of read.services) {
    const dq = Object.fromEntries(
      read.dq.filter((d) => d.service_id === s.service_id).map((d) => [d.reason, d.n]),
    );
    const hist = read.history.filter((h) => h.service_id === s.service_id).map((h) => h.n);
    // Contracts linked to this service count for it; contracts without a service count for every service of the tenant.
    const oc = read.onchain.filter(
      (o) =>
        o.tenant_id === s.tenant_id && (o.service_id === s.service_id || o.service_id === null),
    );
    const res = assurance(s, dq, hist, {
      verified: oc.reduce((a, o) => a + o.verified, 0),
      rows: oc.reduce((a, o) => a + o.rows, 0),
      successful: oc.reduce((a, o) => a + o.ok, 0),
    });
    byTenant.set(s.tenant_id, [...(byTenant.get(s.tenant_id) ?? []), [s, res]]);
  }
  for (const [tenantId, rows] of byTenant) {
    checkAborted(ctx.signal);
    await db.tx(JOB, tenantId, async (tx) => {
      for (const [s, r] of rows) {
        await tx.exec(
          `INSERT INTO scf.api_service_assurance (tenant_id, service_id, day, level, onchain_badge, checks, reason_codes,
                                                  computed_at)
           VALUES ($1, $2, $3::date, $4, $5, $6::jsonb, $7::text[], now())
           ON CONFLICT (tenant_id, service_id, day) DO UPDATE
             SET level = EXCLUDED.level, onchain_badge = EXCLUDED.onchain_badge, checks = EXCLUDED.checks,
                 reason_codes = EXCLUDED.reason_codes, computed_at = EXCLUDED.computed_at`,
          [
            tenantId,
            s.service_id,
            day,
            r.level,
            r.onchain_badge,
            JSON.stringify(r.checks),
            r.reason_codes,
          ],
        );
      }
    });
  }
  return read.services.length;
}
