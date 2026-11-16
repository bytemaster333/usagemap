// SPDX-License-Identifier: Apache-2.0
// Job `web_rollup` (data-model §6.3, §8.9, §16.3; wire-formats §j.5; C-73, C-109, C-110, C-112).
//
// Reads Umami's events through the scf_ro views as scf_umami_ro and writes, per site and UTC day, under that site's
// tenant context and in ONE transaction: the web_daily_totals row (upsert), the day's web_hourly_totals rows and the
// web_daily_breakdowns rows of both variants, replacing what was there — so a re-run produces the same rows.
// Schedule: hourly for the current day (and the previous day until 02:00 UTC), daily at 01:30 UTC for D-1…D-4 with D-4
// final; every run also catches up days of the last week that were never rolled or never finalised. The hourly rows
// of today are what scf.web_live_window_days() projects a site's daily volume from (C-112(6)).
//
// Erasure fence (privacy.tenant-erasure, C-46): a rollup must never write back data an erasure removed. The
// Umami read and the scf write of a site-day happen inside ONE scf transaction that first takes the tenant's erasure
// fence SHARED (pg_try_advisory_xact_lock_shared on ERASURE_FENCE_KEY_SQL); the erasure worker holds the same key
// EXCLUSIVE in a transaction that spans its Umami deletes and its scf deletes up to `completed` (and the 72 h spool
// sweep likewise). The two are therefore never interleaved: a rollup that read before the erasure began has committed
// before the erasure's scf delete runs, and one that starts later reads Umami without the erased rows. A rollup that
// finds the fence taken skips that site-day for this run (`site_day_deferred_erasure`, not a failure); the next hourly
// run, or the catch-up of the last 7 days, rolls it.

import type { ScfDb, Tx, UmamiDb } from "../db.ts";
import { errorFields } from "../log.ts";
import {
  type BreakdownCounts,
  type BreakdownRow,
  CATCH_UP_DAYS,
  catchUpTasks,
  type DayTask,
  mergeTasks,
  scheduledTasks,
  topN,
} from "../rollup/compute.ts";
import { BREAKDOWN_SQL, HOURLY_SQL, TOTALS_SQL } from "../rollup/sql.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import { addDays, dayStart, utcDay } from "../schedule.ts";

export interface RollupSite {
  tenant_id: string;
  site_id: string;
  umami_website_id: string;
  umami_twin_website_id: string | null;
  created_day: string;
}

export interface Totals {
  pageviews_verified: number;
  pageviews_raw: number;
  pageviews_unidentified_verified: number;
  pageviews_unidentified_raw: number;
  visitors_verified: number;
  visitors_raw: number;
  visits: number;
  bounces: number;
  total_duration_s: number;
  events_raw: number;
  unexpected_types: number;
}

export interface HourRow {
  hour_start: Date;
  pageviews_verified: number;
  pageviews_raw: number;
  pageviews_unidentified_verified: number;
  pageviews_unidentified_raw: number;
  visitors_verified: number;
  visitors_raw: number;
  events_raw: number;
}

export interface SiteDay {
  totals: Totals;
  hours: HourRow[];
  breakdowns: BreakdownRow[];
}

export interface RollupOptions {
  engineVersion: string;
  hourlyMinute: number;
  dailyAt: { hour: number; minute: number };
}

/**
 * The tenant's erasure fence (advisory lock key, transaction level). The SAME expression is used by the control plane's
 * erasure worker (exclusive); `$1` is the tenant id.
 */
export const ERASURE_FENCE_KEY_SQL = "hashtextextended('scf.erasure-fence/' || $1::uuid::text, 0)";

export class RollupIncompleteError extends Error {
  readonly failed: number;
  constructor(failed: number) {
    super(`${failed} site-days failed`);
    this.failed = failed;
    this.name = "RollupIncomplete";
  }
}

export function webRollupJob(db: ScfDb, umami: UmamiDb, opts: RollupOptions): JobDef {
  return {
    name: "web_rollup",
    triggers: [
      // after `partitions` (same minute + 5) so a new month's partition exists before the first rollup into it
      { schedule: { kind: "hourly", minute: (opts.hourlyMinute + 5) % 60 }, mode: "hourly" },
      { schedule: { kind: "daily", ...opts.dailyAt }, mode: "daily" },
    ],
    run: async (ctx) => {
      await runWebRollup(db, umami, ctx, opts.engineVersion);
    },
  };
}

/** Reads one site-day from Umami. */
export async function readSiteDay(
  umami: UmamiDb,
  site: Pick<RollupSite, "umami_website_id" | "umami_twin_website_id">,
  day: string,
  topNLimit: number,
): Promise<SiteDay> {
  const ids = [site.umami_website_id, site.umami_twin_website_id].filter((x): x is string => !!x);
  const start = dayStart(day);
  const end = dayStart(addDays(day, 1));
  const params = [site.umami_website_id, ids, start, end];
  const [totals] = await umami.query<Totals>(TOTALS_SQL, params);
  const hours = await umami.query<HourRow>(HOURLY_SQL, params);
  const counts = await umami.query<BreakdownCounts>(BREAKDOWN_SQL, params);
  if (!totals) throw new Error("totals query returned no row");
  return { totals, hours, breakdowns: topN(counts, topNLimit) };
}

/** Hooks for tests: called between the Umami read and the scf write of a site-day (inside the fenced transaction). */
export interface RollupHooks {
  afterRead?(siteId: string, day: string): Promise<void>;
}

/**
 * Reads one site-day from Umami and writes it, in one scf transaction under the site's tenant context that holds the
 * tenant's erasure fence shared (see the header). Returns false when an erasure holds the fence (nothing written).
 */
export async function rollSiteDay(
  db: ScfDb,
  umami: UmamiDb,
  site: Pick<RollupSite, "tenant_id" | "site_id" | "umami_website_id" | "umami_twin_website_id">,
  task: DayTask,
  topNLimit: number,
  engineVersion: string,
  hooks: RollupHooks = {},
): Promise<SiteDay | null> {
  return db.tx("web_rollup", site.tenant_id, async (tx) => {
    const fence = await tx.one<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock_shared(${ERASURE_FENCE_KEY_SQL}) AS ok`,
      [site.tenant_id],
    );
    if (!fence.ok) return null;
    const data = await readSiteDay(umami, site, task.day, topNLimit);
    await hooks.afterRead?.(site.site_id, task.day);
    await writeSiteDay(tx, site, task.day, task.final, data, engineVersion);
    return data;
  });
}

/** Writes one site-day inside the caller's transaction under the site's tenant context (replace semantics, idempotent). */
export async function writeSiteDay(
  tx: Tx,
  site: Pick<RollupSite, "tenant_id" | "site_id">,
  day: string,
  final: boolean,
  data: SiteDay,
  engineVersion: string,
): Promise<void> {
  const t = data.totals;
  {
    await tx.exec(
      `INSERT INTO scf.web_daily_totals AS w (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
              pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits,
              bounces, total_duration_s, events_raw, is_final, engine_version, computed_at)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
       ON CONFLICT (tenant_id, site_id, day) DO UPDATE SET
         pageviews_verified = EXCLUDED.pageviews_verified, pageviews_raw = EXCLUDED.pageviews_raw,
         pageviews_unidentified_verified = EXCLUDED.pageviews_unidentified_verified,
         pageviews_unidentified_raw = EXCLUDED.pageviews_unidentified_raw,
         visitors_verified = EXCLUDED.visitors_verified, visitors_raw = EXCLUDED.visitors_raw,
         visits = EXCLUDED.visits, bounces = EXCLUDED.bounces, total_duration_s = EXCLUDED.total_duration_s,
         events_raw = EXCLUDED.events_raw, is_final = EXCLUDED.is_final, engine_version = EXCLUDED.engine_version,
         computed_at = EXCLUDED.computed_at`,
      [
        site.tenant_id,
        site.site_id,
        day,
        t.pageviews_verified,
        t.pageviews_raw,
        t.pageviews_unidentified_verified,
        t.pageviews_unidentified_raw,
        t.visitors_verified,
        t.visitors_raw,
        t.visits,
        t.bounces,
        t.total_duration_s,
        t.events_raw,
        final,
        engineVersion,
      ],
    );

    const start = dayStart(day);
    const end = dayStart(addDays(day, 1));
    await tx.exec(
      `DELETE FROM scf.web_hourly_totals
        WHERE tenant_id = $1 AND site_id = $2 AND hour_start >= $3 AND hour_start < $4`,
      [site.tenant_id, site.site_id, start, end],
    );
    if (data.hours.length > 0) {
      const h = data.hours;
      await tx.exec(
        `INSERT INTO scf.web_hourly_totals (tenant_id, site_id, hour_start, pageviews_verified, pageviews_raw,
                pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw,
                events_raw)
         SELECT $1, $2, u.* FROM unnest($3::timestamptz[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[],
                                        $8::bigint[], $9::bigint[], $10::bigint[]) AS u`,
        [
          site.tenant_id,
          site.site_id,
          h.map((r) => r.hour_start),
          h.map((r) => r.pageviews_verified),
          h.map((r) => r.pageviews_raw),
          h.map((r) => r.pageviews_unidentified_verified),
          h.map((r) => r.pageviews_unidentified_raw),
          h.map((r) => r.visitors_verified),
          h.map((r) => r.visitors_raw),
          h.map((r) => r.events_raw),
        ],
      );
    }

    await tx.exec(
      "DELETE FROM scf.web_daily_breakdowns WHERE tenant_id = $1 AND site_id = $2 AND day = $3::date",
      [site.tenant_id, site.site_id, day],
    );
    if (data.breakdowns.length > 0) {
      const b = data.breakdowns;
      await tx.exec(
        `INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors,
                pageviews, visits, events)
         SELECT $1, $2, $3::date, u.variant::scf.web_variant, u.dimension::scf.web_dimension, u.value, u.rank,
                u.visitors, u.pageviews, u.visits, u.events
           FROM unnest($4::text[], $5::text[], $6::text[], $7::int[], $8::bigint[], $9::bigint[], $10::bigint[],
                       $11::bigint[]) AS u (variant, dimension, value, rank, visitors, pageviews, visits, events)`,
        [
          site.tenant_id,
          site.site_id,
          day,
          b.map((r) => r.variant),
          b.map((r) => r.dimension),
          b.map((r) => r.value),
          b.map((r) => r.rank),
          b.map((r) => r.visitors),
          b.map((r) => r.pageviews),
          b.map((r) => r.visits),
          b.map((r) => r.events),
        ],
      );
    }
  }
}

export interface RollupResult {
  siteDays: number;
  failed: number;
  /** Site-days skipped because an erasure of the tenant was running (rolled by a later run). */
  deferred: number;
  tasks: Map<string, DayTask[]>;
}

/** One run: plans the days per site, then reads and writes each site-day. */
export async function runWebRollup(
  db: ScfDb,
  umami: UmamiDb,
  ctx: JobContext,
  engineVersion: string,
  only?: { siteIds?: string[]; tasks?: DayTask[] },
  hooks: RollupHooks = {},
): Promise<RollupResult> {
  const today = utcDay(ctx.now);
  // Cross-tenant reads (tenant unset, app.job = web_rollup): the sites, the top-N setting and the recent days rolled.
  const { sites, topNLimit, existing } = await db.tx("web_rollup", null, async (tx) => {
    const sites = await tx.query<RollupSite>(
      `SELECT s.tenant_id, s.site_id, s.umami_website_id, s.umami_twin_website_id,
              ((s.created_at AT TIME ZONE 'UTC')::date)::text AS created_day
         FROM scf.sites s
        WHERE s.status <> 'purging' AND ($1::uuid[] IS NULL OR s.site_id = ANY ($1::uuid[]))
        ORDER BY s.tenant_id, s.site_id`,
      [only?.siteIds ?? null],
    );
    const n = await tx.one<{ n: number | null }>(
      "SELECT scf.setting_int('web_breakdown_top_n') AS n",
    );
    const rows = await tx.query<{ site_id: string; day: string; is_final: boolean }>(
      `SELECT w.site_id, w.day::text AS day, w.is_final FROM scf.web_daily_totals w
        WHERE w.day >= $1::date AND w.day < $2::date`,
      [addDays(today, -CATCH_UP_DAYS), today],
    );
    const existing = new Map<string, Map<string, boolean>>();
    for (const r of rows) {
      const m = existing.get(r.site_id) ?? new Map<string, boolean>();
      m.set(r.day, r.is_final);
      existing.set(r.site_id, m);
    }
    return { sites, topNLimit: n.n ?? 50, existing };
  });

  const scheduled = only?.tasks ?? scheduledTasks(ctx.now, ctx.mode);
  const result: RollupResult = { siteDays: 0, failed: 0, deferred: 0, tasks: new Map() };
  for (const site of sites) {
    const tasks = (
      only?.tasks
        ? scheduled
        : mergeTasks(
            scheduled,
            catchUpTasks(ctx.now, site.created_day, existing.get(site.site_id) ?? new Map()),
          )
    ).filter((t) => t.day >= site.created_day);
    result.tasks.set(site.site_id, tasks);
    for (const task of tasks) {
      checkAborted(ctx.signal);
      try {
        const data = await rollSiteDay(db, umami, site, task, topNLimit, engineVersion, hooks);
        if (data === null) {
          result.deferred += 1;
          ctx.metrics.units.inc({ job: "web_rollup", outcome: "site_day_deferred_erasure" });
          ctx.log.info("rollup_site_day_deferred_erasure", {
            job: "web_rollup",
            site_id: site.site_id,
            day: task.day,
          });
          continue;
        }
        if (data.totals.unexpected_types > 0) {
          ctx.metrics.anomalies.inc(
            { job: "web_rollup", reason: "unexpected_event_type" },
            data.totals.unexpected_types,
          );
          ctx.log.warn("rollup_unexpected_event_types", {
            job: "web_rollup",
            site_id: site.site_id,
            day: task.day,
            count: data.totals.unexpected_types,
          });
        }
        result.siteDays += 1;
        ctx.metrics.units.inc({ job: "web_rollup", outcome: "site_day_done" });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        result.failed += 1;
        ctx.metrics.units.inc({ job: "web_rollup", outcome: "site_day_failed" });
        ctx.log.error("rollup_site_day_failed", {
          job: "web_rollup",
          site_id: site.site_id,
          day: task.day,
          ...errorFields(err),
        });
      }
    }
  }
  ctx.log.info("rollup_done", {
    job: "web_rollup",
    mode: ctx.mode,
    sites: sites.length,
    site_days: result.siteDays,
    failed: result.failed,
    deferred: result.deferred,
  });
  if (result.failed > 0) throw new RollupIncompleteError(result.failed);
  return result;
}
