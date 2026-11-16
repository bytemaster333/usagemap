// SPDX-License-Identifier: Apache-2.0
// Job `durability_reconcile` (daily 02:00 UTC; C-76, AR-09; data-model §8.13; wire-formats §d.4, §o).
//
// Node balance, per edge node and UTC day, from `edge_spool_accounting`:
//   expected = queued_start + fsynced
//   observed = acked_stored + acked_engine_bot + acked_engine_rejected + expired_72h + queued_end
//   balanced     expected = observed
//   pending      the day's reports are incomplete (no queued_start/queued_end, or the last report ends before the
//                day does) and the day ended less than NODE_GRACE_HOURS ago — counter records may still arrive
//   loss         observed < expected and no restart explains it
//   unaccounted  a restart (boot_id change) left an unreported window, or the reports are still incomplete after the
//                grace period, or observed > expected (the gap is published as such, never hidden)
//
// Canary check, per probe source: expected = canary page views the probes saw accepted (hourly increase of
// `scf_probe_canary_accepted_total{source}` in Prometheus, wire-formats §o), observed = page views Umami holds for
// `/canary/<source>/…` on the canary tenants' main websites (the scf_ro view, unfiltered by tag). A shortfall within
// the last `canaryLagHours` (72 h) of the evaluation is `pending` — those events may still be in a spool — and the
// day is re-checked on later runs; after that it is `loss`. Hourly differences go to `details`.
//
// Every run reconciles D-1 and re-checks the previous days that are still `pending` (up to D-4). Results are upserted
// into `durability_reports` (one row per node and per canary source; no tenant data in either table).

import type { ScfDb, UmamiDb } from "../db.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import { addDays, dayStart, utcDay } from "../schedule.ts";

export const NODE_GRACE_HOURS = 24;
const HOUR = 3_600_000;

export type DurabilityStatus = "balanced" | "loss" | "unaccounted" | "pending";

export interface SpoolRow {
  node_id: string;
  queued_start: number | null;
  fsynced: number;
  acked_stored: number;
  acked_engine_bot: number;
  acked_engine_rejected: number;
  expired_72h: number;
  queued_end: number | null;
  last_period_end: Date | null;
  restarts: number;
}

export interface NodeReport {
  subject: string;
  expected: number;
  observed: number;
  status: DurabilityStatus;
  details: Record<string, unknown>;
}

/** Pure balance of one node-day (exported for unit tests). */
export function nodeBalance(r: SpoolRow, day: string, now: Date): NodeReport {
  const dayEnd = dayStart(addDays(day, 1)).getTime();
  const acked = r.acked_stored + r.acked_engine_bot + r.acked_engine_rejected;
  const expected = (r.queued_start ?? 0) + r.fsynced;
  const observed = acked + r.expired_72h + (r.queued_end ?? 0);
  const complete =
    r.queued_start !== null &&
    r.queued_end !== null &&
    r.last_period_end !== null &&
    r.last_period_end.getTime() >= dayEnd;
  let status: DurabilityStatus;
  let reason: string;
  if (!complete && now.getTime() < dayEnd + NODE_GRACE_HOURS * HOUR) {
    status = "pending";
    reason = "reports_incomplete";
  } else if (!complete) {
    status = "unaccounted";
    reason = "reports_missing";
  } else if (expected === observed) {
    status = "balanced";
    reason = r.restarts > 0 ? "balanced_across_restart" : "balanced";
  } else if (r.restarts > 0) {
    status = "unaccounted";
    reason = "restart_window";
  } else if (observed < expected) {
    status = "loss";
    reason = "shortfall";
  } else {
    status = "unaccounted";
    reason = "surplus";
  }
  return {
    subject: `node:${r.node_id}`,
    expected,
    observed,
    status,
    details: {
      reason,
      queued_start: r.queued_start,
      fsynced: r.fsynced,
      acked_stored: r.acked_stored,
      acked_engine_bot: r.acked_engine_bot,
      acked_engine_rejected: r.acked_engine_rejected,
      expired_72h: r.expired_72h,
      queued_end: r.queued_end,
      restarts: r.restarts,
      difference: observed - expected,
    },
  };
}

/** Hourly accepted canary counts per probe source for one UTC day: source → 24 values (index = hour). */
export interface CanarySource {
  acceptedPerHour(day: string): Promise<Map<string, number[]>>;
}

const SOURCE_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/**
 * Prometheus HTTP API (`/api/v1/query_range`): `sum by (source) (increase(scf_probe_canary_accepted_total[1h]))` at
 * step 1h; the sample at hh+1:00 is the increase during hour hh. `increase` extrapolates, so values are rounded.
 */
export class PrometheusCanarySource implements CanarySource {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 15_000) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = timeoutMs;
  }

  async acceptedPerHour(day: string): Promise<Map<string, number[]>> {
    const start = dayStart(day).getTime() / 1000 + 3600;
    const qs = new URLSearchParams({
      query: "sum by (source) (increase(scf_probe_canary_accepted_total[1h]))",
      start: String(start),
      end: String(start + 23 * 3600),
      step: "3600",
    });
    const res = await fetch(`${this.#base}/api/v1/query_range?${qs}`, {
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok)
      throw Object.assign(new Error(`prometheus answered ${res.status}`), {
        name: "PrometheusError",
      });
    const body = (await res.json()) as {
      status?: string;
      data?: { result?: Array<{ metric?: { source?: string }; values?: Array<[number, string]> }> };
    };
    if (body.status !== "success")
      throw Object.assign(new Error("prometheus query failed"), { name: "PrometheusError" });
    const out = new Map<string, number[]>();
    for (const series of body.data?.result ?? []) {
      const source = series.metric?.source;
      if (!source || !SOURCE_RE.test(source)) continue;
      const hours = new Array<number>(24).fill(0);
      for (const [ts, v] of series.values ?? []) {
        const h = Math.round((ts - start) / 3600);
        const n = Number(v);
        if (h >= 0 && h < 24 && Number.isFinite(n)) hours[h] = Math.max(0, Math.round(n));
      }
      out.set(source, hours);
    }
    return out;
  }
}

export interface CanaryReport extends NodeReport {}

/** Pure canary comparison of one source-day (exported for unit tests). */
export function canaryBalance(
  source: string,
  day: string,
  expectedHours: number[],
  observedHours: number[],
  now: Date,
  lagHours: number,
): CanaryReport {
  const expected = expectedHours.reduce((a, b) => a + b, 0);
  const observed = observedHours.reduce((a, b) => a + b, 0);
  const t0 = dayStart(day).getTime();
  const settledBefore = now.getTime() - lagHours * HOUR; // events after this may still be spooled
  const diffs: Record<string, number> = {};
  let shortfallSettled = 0;
  let shortfallRecent = 0;
  for (let h = 0; h < 24; h++) {
    const d = (observedHours[h] ?? 0) - (expectedHours[h] ?? 0);
    if (d !== 0) diffs[`h${String(h).padStart(2, "0")}`] = d;
    if (d < 0) {
      if (t0 + (h + 1) * HOUR <= settledBefore) shortfallSettled -= d;
      else shortfallRecent -= d;
    }
  }
  let status: DurabilityStatus;
  if (shortfallSettled > 0) status = "loss";
  else if (shortfallRecent > 0) status = "pending";
  else if (observed > expected) status = "unaccounted";
  else status = "balanced";
  return {
    subject: `canary:${source}`,
    expected,
    observed,
    status,
    details: { hourly_differences: diffs, shortfall: shortfallSettled + shortfallRecent },
  };
}

export interface DurabilityOptions {
  canary: CanarySource | null;
  umami: UmamiDb | null;
  canaryLagHours: number;
  dailyAt: { hour: number; minute: number };
}

export function durabilityJob(db: ScfDb, opts: DurabilityOptions): JobDef {
  return {
    name: "durability_reconcile",
    triggers: [{ schedule: { kind: "daily", ...opts.dailyAt }, mode: "daily" }],
    run: async (ctx) => {
      await runDurability(db, opts, ctx);
    },
  };
}

const JOB = "durability_reconcile" as const;

/** One run: D-1 plus pending days up to D-4. Returns the reports written per day. */
export async function runDurability(
  db: ScfDb,
  opts: Pick<DurabilityOptions, "canary" | "umami" | "canaryLagHours">,
  ctx: JobContext,
): Promise<Map<string, NodeReport[]>> {
  const today = utcDay(ctx.now);
  const pending = await db.tx(JOB, null, (tx) =>
    tx.query<{ day: string }>(
      `SELECT DISTINCT to_char(d.day, 'YYYY-MM-DD') AS day FROM scf.durability_reports d
        WHERE d.status = 'pending' AND d.day >= $1::date - 4 AND d.day < $1::date - 1`,
      [today],
    ),
  );
  const days = [...new Set([addDays(today, -1), ...pending.map((p) => p.day)])].sort();
  const out = new Map<string, NodeReport[]>();
  const tally = new Map<string, number>();
  for (const day of days) {
    checkAborted(ctx.signal);
    const reports = await reconcileDay(db, opts, day, ctx);
    out.set(day, reports);
    if (day === addDays(today, -1)) {
      for (const r of reports) {
        const kind = r.subject.startsWith("node:") ? "node" : "canary";
        const k = `${kind}|${r.status}`;
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }
    }
  }
  // Alert inputs (monitoring-plan): reports of the latest day by kind and status, and the shortfall in records.
  const g = ctx.metrics.durability;
  for (const kind of ["node", "canary"]) {
    for (const status of ["balanced", "loss", "unaccounted", "pending"]) {
      g.reports.set({ kind, status }, tally.get(`${kind}|${status}`) ?? 0);
    }
    const shortfall = (out.get(addDays(today, -1)) ?? [])
      .filter((r) => r.subject.startsWith(`${kind}:`) && r.status === "loss")
      .reduce((a, r) => a + Math.max(0, r.expected - r.observed), 0);
    g.shortfall.set({ kind }, shortfall);
  }
  g.lastDay.set({}, dayStart(addDays(today, -1)).getTime() / 1000);
  ctx.log.info("durability_done", {
    job: JOB,
    days: days.length,
    loss: tally.get("node|loss") ?? 0,
    canary_loss: tally.get("canary|loss") ?? 0,
  });
  return out;
}

async function reconcileDay(
  db: ScfDb,
  opts: Pick<DurabilityOptions, "canary" | "umami" | "canaryLagHours">,
  day: string,
  ctx: JobContext,
): Promise<NodeReport[]> {
  const rows = await db.tx(JOB, null, (tx) =>
    tx.query<SpoolRow>(
      `SELECT a.node_id, a.queued_start, a.fsynced, a.acked_stored, a.acked_engine_bot, a.acked_engine_rejected,
              a.expired_72h, a.queued_end, a.last_period_end, a.restarts
         FROM scf.edge_spool_accounting a WHERE a.day = $1::date ORDER BY a.node_id`,
      [day],
    ),
  );
  const reports = rows.map((r) => nodeBalance(r, day, ctx.now));
  if (opts.canary && opts.umami) {
    try {
      reports.push(
        ...(await canaryReports(db, opts.canary, opts.umami, day, opts.canaryLagHours, ctx)),
      );
    } catch (err) {
      // The node balance stands on its own; a missing canary source is visible as missing canary rows + this metric.
      ctx.metrics.anomalies.inc({ job: JOB, reason: "canary_source_unavailable" });
      ctx.log.warn("durability_canary_unavailable", { job: JOB, day });
      if (ctx.signal.aborted) throw err;
    }
  }
  await db.tx(JOB, null, async (tx) => {
    for (const r of reports) {
      await tx.exec(
        `INSERT INTO scf.durability_reports (day, subject, expected, observed, status, details, computed_at)
         VALUES ($1::date, $2, $3, $4, $5, $6::jsonb, now())
         ON CONFLICT (day, subject) DO UPDATE
           SET expected = EXCLUDED.expected, observed = EXCLUDED.observed, status = EXCLUDED.status,
               details = EXCLUDED.details, computed_at = EXCLUDED.computed_at`,
        [day, r.subject, r.expected, r.observed, r.status, JSON.stringify(r.details)],
      );
    }
  });
  ctx.metrics.units.inc({ job: JOB, outcome: "day_reconciled" });
  return reports;
}

async function canaryReports(
  db: ScfDb,
  source: CanarySource,
  umami: UmamiDb,
  day: string,
  lagHours: number,
  ctx: JobContext,
): Promise<NodeReport[]> {
  const sites = await db.tx(JOB, null, (tx) =>
    tx.query<{ website: string }>(
      `SELECT s.umami_website_id::text AS website FROM scf.sites s
         JOIN scf.tenants t ON t.tenant_id = s.tenant_id
        WHERE t.is_canary ORDER BY 1`,
    ),
  );
  const accepted = await source.acceptedPerHour(day);
  if (sites.length === 0) {
    if (accepted.size > 0) ctx.metrics.anomalies.inc({ job: JOB, reason: "canary_site_missing" });
    return [];
  }
  const t0 = dayStart(day);
  const t1 = dayStart(addDays(day, 1));
  // Page views per source and hour on the canary websites (unfiltered by tag: every canary counts, §o).
  const counted = await umami.query<{ source: string; h: number; n: number }>(
    `SELECT split_part(e.url_path, '/', 3) AS source,
            extract(hour FROM e.created_at AT TIME ZONE 'UTC')::int AS h, count(*) AS n
       FROM scf_ro.website_event e
      WHERE e.website_id = ANY ($1::uuid[]) AND e.event_type = 1
        AND e.created_at >= $2 AND e.created_at < $3 AND e.url_path LIKE '/canary/%'
      GROUP BY 1, 2`,
    [sites.map((s) => s.website), t0, t1],
  );
  const observed = new Map<string, number[]>();
  for (const c of counted) {
    if (!SOURCE_RE.test(c.source)) continue;
    const arr = observed.get(c.source) ?? new Array<number>(24).fill(0);
    arr[c.h] = c.n;
    observed.set(c.source, arr);
  }
  const sources = [...new Set([...accepted.keys(), ...observed.keys()])].sort();
  return sources.map((s) =>
    canaryBalance(
      s,
      day,
      accepted.get(s) ?? new Array<number>(24).fill(0),
      observed.get(s) ?? new Array<number>(24).fill(0),
      ctx.now,
      lagHours,
    ),
  );
}
