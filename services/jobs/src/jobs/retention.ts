// SPDX-License-Identifier: Apache-2.0
// Jobs `retention` (hourly) and `stream_gc` (daily) — data-model §6.3, §14, §16.2.
//
// scf: the delete rules of `scf.retention_rules()` for the job are applied through `scf.retention_apply(rel, limit)`
// in batches. For a tenant-scoped relation the job first finds the tenants that have expired rows with a cross-tenant
// read (tenant unset, `app.job` set) and then deletes one tenant at a time, each batch in its own transaction under
// that tenant's context (F1, C-103). `retention` also replaces erasure selectors past finished_at + 56 days by their
// type and length (`scf.erasure_redact_selectors()`, C-88, C-112) and prunes Umami's event-level data.
//
// umami (§16.2): for every site, on BOTH website ids (main and twin, C-73), rows older than the site's effective
// retention LEAST(COALESCE(sites.event_retention_days, 395), settings.web_event_retention_days) — default 90 days,
// C-54 — are deleted in batches of 10,000 as scf_umami_maint: revenue, event_data, website_event, session_data and
// session_link by `created_at`, then sessions created before the cutoff that have no remaining event. Each tenant whose
// data was pruned gets one audit row `retention.umami_pruned` with counts only. `revenue` (Umami ≥ 2.18): saveEvent
// writes a row whenever an event's data has a numeric `revenue` and a `currency`, which the tracker's custom data can
// carry; it is event-level data tied to the pseudonymous session id and is pruned like the events.
// UMAMI_TABLES classifies every Umami table that has `website_id` and `created_at`; a contract test fails when an
// engine upgrade adds one that is not classified.
//
// Footprint accounts (C-137): an account subject (`G…`) of a footprint item that is rejected or removed is
// deleted at the next hourly run (`purgeUnprovenFootprint`), not 30 days later — the platform keeps only accounts a
// project proved are its own, plus the subject of a claim that is still open (at most 30 days, scf.retention_rules()).
// The data-inventory scanner (tests/lib/privacy-scan.ts) allows exactly these two sets.

import type { ScfDb, UmamiDb } from "../db.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";

export const SCF_BATCH = 10_000;
export const REDACT_BATCH = 1_000;
export const UMAMI_BATCH = 10_000;

const REL_RE = /^[a-z][a-z0-9_]{0,62}$/;

interface Rule {
  relname: string;
  tenant_scoped: boolean;
  age_expr: string;
  keep: string;
}

export function retentionJob(db: ScfDb, umami: UmamiDb | null, hourlyMinute: number): JobDef {
  return {
    name: "retention",
    triggers: [{ schedule: { kind: "hourly", minute: hourlyMinute }, mode: "hourly" }],
    run: async (ctx) => {
      await applyScfRules(db, "retention", ctx);
      await purgeUnprovenFootprint(db, ctx);
      await redactErasureSelectors(db, ctx);
      if (umami) await pruneUmami(db, umami, ctx);
    },
  };
}

export function streamGcJob(db: ScfDb, at: { hour: number; minute: number }): JobDef {
  return {
    name: "stream_gc",
    triggers: [{ schedule: { kind: "daily", ...at }, mode: "daily" }],
    run: async (ctx) => {
      await applyScfRules(db, "stream_gc", ctx);
    },
  };
}

/** Applies every `delete` rule of `scf.retention_rules()` that names `job`. Returns rows deleted per relation. */
export async function applyScfRules(
  db: ScfDb,
  job: "retention" | "stream_gc",
  ctx: JobContext,
): Promise<Record<string, number>> {
  const rules = await db.tx(job, null, (tx) =>
    tx.query<Rule & { keep: string }>(
      `SELECT r.relname, r.tenant_scoped, r.age_expr, r.keep::text AS keep
         FROM scf.retention_rules() r WHERE r.mechanism = 'delete' AND r.job = $1 ORDER BY r.relname`,
      [job],
    ),
  );
  const out: Record<string, number> = {};
  for (const rule of rules) {
    checkAborted(ctx.signal);
    if (!REL_RE.test(rule.relname))
      throw new Error("unexpected relation name in retention_rules()");
    let deleted = 0;
    if (rule.tenant_scoped) {
      // Cross-tenant read (named job, tenant unset): which tenants have expired rows. The rule's age expression is
      // defined by the migration (owned by scf_migrator), not by input.
      const tenants = await db.tx(job, null, (tx) =>
        tx.query<{ tenant_id: string }>(
          `SELECT DISTINCT t.tenant_id FROM scf.${rule.relname} t
            WHERE (${rule.age_expr}) < now() - $1::interval`,
          [rule.keep],
        ),
      );
      for (const { tenant_id } of tenants) {
        deleted += await drain(ctx, () =>
          db.tx(job, tenant_id, async (tx) => {
            const r = await tx.one<{ n: number }>("SELECT scf.retention_apply($1, $2) AS n", [
              rule.relname,
              SCF_BATCH,
            ]);
            return r.n;
          }),
        );
        ctx.metrics.units.inc({ job, outcome: "tenant_done" });
      }
    } else {
      deleted += await drain(ctx, () =>
        db.tx(job, null, async (tx) => {
          const r = await tx.one<{ n: number }>("SELECT scf.retention_apply($1, $2) AS n", [
            rule.relname,
            SCF_BATCH,
          ]);
          return r.n;
        }),
      );
    }
    out[rule.relname] = deleted;
    ctx.metrics.rows.inc({ job, relation: rule.relname, action: "deleted" }, deleted);
  }
  ctx.log.info("retention_scf_done", {
    job,
    relations: rules.length,
    rows_deleted: Object.values(out).reduce((a, b) => a + b, 0),
  });
  return out;
}

/** Runs `batch` until it affects fewer rows than a full batch; returns the total. */
async function drain(
  ctx: JobContext,
  batch: () => Promise<number>,
  limit = SCF_BATCH,
): Promise<number> {
  let total = 0;
  for (;;) {
    checkAborted(ctx.signal);
    const n = await batch();
    total += n;
    if (n < limit) return total;
  }
}

/** Account kinds of footprint items: their subject is a `G…` account (data-model §12.1). */
export const FOOTPRINT_ACCOUNT_KINDS = ["issuing_account", "app_account"] as const;

/**
 * C-137: deletes every rejected or removed footprint ACCOUNT item at once — an address a project could not
 * prove (or withdrew) is not kept for 30 days. One tenant at a time under its context. Returns the rows deleted.
 */
export async function purgeUnprovenFootprint(db: ScfDb, ctx: JobContext): Promise<number> {
  const tenants = await db.tx("retention", null, (tx) =>
    tx.query<{ tenant_id: string }>(
      `SELECT DISTINCT f.tenant_id FROM scf.footprint_items f
        WHERE f.kind = ANY ($1::text[]) AND (f.status = 'rejected' OR f.removed_at IS NOT NULL)`,
      [FOOTPRINT_ACCOUNT_KINDS],
    ),
  );
  let total = 0;
  for (const { tenant_id } of tenants) {
    checkAborted(ctx.signal);
    total += await db.tx("retention", tenant_id, (tx) =>
      tx.exec(
        `DELETE FROM scf.footprint_items f
          WHERE f.tenant_id = $1 AND f.kind = ANY ($2::text[]) AND (f.status = 'rejected' OR f.removed_at IS NOT NULL)`,
        [tenant_id, FOOTPRINT_ACCOUNT_KINDS],
      ),
    );
  }
  ctx.metrics.rows.inc(
    { job: "retention", relation: "footprint_items", action: "unproven_deleted" },
    total,
  );
  ctx.log.info("footprint_unproven_deleted", { job: "retention", rows: total });
  return total;
}

/** C-88, C-112: literal erasure selectors are replaced by type and length after finished_at + 56 days. */
export async function redactErasureSelectors(db: ScfDb, ctx: JobContext): Promise<number> {
  const tenants = await db.tx("retention", null, (tx) =>
    tx.query<{ tenant_id: string }>(
      `SELECT DISTINCT e.tenant_id FROM scf.erasure_requests e
        WHERE e.selector_redacted_at IS NULL
          AND e.finished_at < now() - (SELECT r.keep FROM scf.retention_rules() r
                                        WHERE r.relname = 'erasure_requests' AND r.mechanism = 'redact')`,
    ),
  );
  let total = 0;
  for (const { tenant_id } of tenants) {
    total += await drain(
      ctx,
      () =>
        db.tx("retention", tenant_id, async (tx) => {
          const r = await tx.one<{ n: number }>("SELECT scf.erasure_redact_selectors($1) AS n", [
            REDACT_BATCH,
          ]);
          return r.n;
        }),
      REDACT_BATCH,
    );
  }
  ctx.metrics.rows.inc(
    { job: "retention", relation: "erasure_requests", action: "redacted" },
    total,
  );
  ctx.log.info("erasure_selectors_redacted", { job: "retention", requests: total });
  return total;
}

export interface SiteRetention {
  tenant_id: string;
  site_id: string;
  umami_website_id: string;
  umami_twin_website_id: string | null;
  days: number;
}

export interface PruneCounts {
  revenue: number;
  website_event: number;
  event_data: number;
  session: number;
  session_data: number;
  session_link: number;
}

const emptyCounts = (): PruneCounts => ({
  revenue: 0,
  website_event: 0,
  event_data: 0,
  session: 0,
  session_data: 0,
  session_link: 0,
});

// Batches over the columns scf_umami_maint may read (§16.1 grants SELECT per column only). Each statement deletes at
// most one batch of one website's rows older than the cutoff.
const PRUNE_SQL: Record<keyof PruneCounts, string> = {
  revenue: `DELETE FROM public.revenue
             WHERE revenue_id = ANY (ARRAY(SELECT r.revenue_id FROM public.revenue r
                                            WHERE r.website_id = $1 AND r.created_at < $2 LIMIT $3))`,
  event_data: `DELETE FROM public.event_data
                WHERE website_id = $1 AND created_at < $2
                  AND website_event_id = ANY (ARRAY(SELECT d.website_event_id FROM public.event_data d
                                                     WHERE d.website_id = $1 AND d.created_at < $2 LIMIT $3))`,
  website_event: `DELETE FROM public.website_event
                   WHERE event_id = ANY (ARRAY(SELECT e.event_id FROM public.website_event e
                                                WHERE e.website_id = $1 AND e.created_at < $2 LIMIT $3))`,
  session_data: `DELETE FROM public.session_data
                  WHERE website_id = $1 AND created_at < $2
                    AND session_id = ANY (ARRAY(SELECT d.session_id FROM public.session_data d
                                                 WHERE d.website_id = $1 AND d.created_at < $2 LIMIT $3))`,
  session_link: `DELETE FROM public.session_link
                  WHERE website_id = $1 AND created_at < $2
                    AND session_id = ANY (ARRAY(SELECT l.session_id FROM public.session_link l
                                                 WHERE l.website_id = $1 AND l.created_at < $2 LIMIT $3))`,
  session: `DELETE FROM public.session
             WHERE session_id = ANY (ARRAY(
               SELECT s.session_id FROM public.session s
                WHERE s.website_id = $1 AND s.created_at < $2
                  AND NOT EXISTS (SELECT 1 FROM public.website_event e WHERE e.session_id = s.session_id)
                LIMIT $3))`,
};
// Order: revenue and event data before their events, sessions last (only those without a remaining event).
export const PRUNE_ORDER: (keyof PruneCounts)[] = [
  "revenue",
  "event_data",
  "website_event",
  "session_data",
  "session_link",
  "session",
];

/**
 * Every Umami table with `website_id` and `created_at` (Umami 3.5.0 schema), classified. A contract test lists the
 * engine's tables and fails on one that is in none of these lists, so an upgrade that adds event-level data cannot go
 * unnoticed.
 */
export const UMAMI_TABLES = {
  /** Event-level data written through POST /api/send: pruned here (PRUNE_ORDER). */
  pruned: PRUNE_ORDER as readonly string[],
  /** Configuration of a website, not visitor data; removed with the website (tenant_purge, erasure by site). */
  configuration: ["website", "report", "annotation", "segment"],
  /**
   * Written only by Umami endpoints the engine proxy never forwards (session replay, heatmaps, error tracking; only
   * POST /api/send with type `event` reaches the engine, services/engine-proxy): always empty on this platform.
   */
  unreachable: [
    "session_replay",
    "session_replay_saved",
    "heatmap_event",
    "error_issue",
    "error_event",
  ],
} as const;

/** Deletes one website's Umami rows older than `cutoff`. */
export async function pruneWebsite(
  umami: UmamiDb,
  websiteId: string,
  cutoff: Date,
  ctx: JobContext,
): Promise<PruneCounts> {
  const counts = emptyCounts();
  for (const table of PRUNE_ORDER) {
    counts[table] += await drain(
      ctx,
      () => umami.exec(PRUNE_SQL[table], [websiteId, cutoff, UMAMI_BATCH]),
      UMAMI_BATCH,
    );
  }
  return counts;
}

/** Umami event-level retention for every site (main and twin websites). */
export async function pruneUmami(
  db: ScfDb,
  umami: UmamiDb,
  ctx: JobContext,
): Promise<Map<string, PruneCounts>> {
  const sites = await db.tx("retention", null, (tx) =>
    tx.query<SiteRetention>(
      `SELECT s.tenant_id, s.site_id, s.umami_website_id, s.umami_twin_website_id,
              LEAST(COALESCE(s.event_retention_days, 395), scf.setting_int('web_event_retention_days')) AS days
         FROM scf.sites s ORDER BY s.tenant_id, s.site_id`,
    ),
  );
  const perTenant = new Map<string, PruneCounts & { sites: number }>();
  for (const site of sites) {
    checkAborted(ctx.signal);
    const cutoff = new Date(ctx.now.getTime() - site.days * 86_400_000);
    const total = emptyCounts();
    for (const wid of [site.umami_website_id, site.umami_twin_website_id]) {
      if (!wid) continue;
      const c = await pruneWebsite(umami, wid, cutoff, ctx);
      for (const k of PRUNE_ORDER) total[k] += c[k];
    }
    const n = PRUNE_ORDER.reduce((a, k) => a + total[k], 0);
    ctx.metrics.units.inc({ job: "retention", outcome: "site_pruned" });
    if (n === 0) continue;
    const t = perTenant.get(site.tenant_id) ?? { ...emptyCounts(), sites: 0 };
    for (const k of PRUNE_ORDER) {
      t[k] += total[k];
      ctx.metrics.rows.inc(
        { job: "retention", relation: `umami.${k}`, action: "deleted" },
        total[k],
      );
    }
    t.sites += 1;
    perTenant.set(site.tenant_id, t);
  }
  // One audit row per tenant whose data was pruned (counts only, never selectors or values; §16.2).
  for (const [tenantId, t] of perTenant) {
    await db.tx("retention", tenantId, (tx) =>
      tx.audit("retention.umami_pruned", "tenant", tenantId, { ...t }),
    );
  }
  ctx.log.info("retention_umami_done", {
    job: "retention",
    sites: sites.length,
    tenants_pruned: perTenant.size,
  });
  return perTenant;
}
