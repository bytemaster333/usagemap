// SPDX-License-Identifier: Apache-2.0
// Job `tenant_purge` (hourly; data-model §6.3, §8.3; C-08, C-64, C-87, C-114; ADR-0015). A removed tenant whose
// `purge_after` (removal + 30 days, or now after an operator's `purge_now`) has passed loses all of its data:
//
//   1. Work discovery without any cross-tenant read: `scf.job_queue('tenant_purge')` (tenant unset, definer function,
//      returns only tenant ids, C-87).
//   2. Per tenant, ONE transaction under that tenant's context (F1, C-103) that first locks the tenant row
//      (`FOR UPDATE`): an operator's restore waits for it and is then refused by `tenants_guard` (purged), so a restore
//      cannot interleave with a running purge. The transaction re-checks that the tenant is still due.
//   3. Tombstones (C-64): `scf.write_removal_tombstones(tenant)` (definer function, migration 0057) — every verified
//      host, every owner's GitHub id and every valid Stellar account of the tenant gets an enrollment tombstone unless
//      one of this tenant (active or lifted — lifted ones stay lifted) or an active one of another tenant exists.
//      Idempotent: the removal already wrote them (owner self-removal or `op_tenant_transition('remove')`); this
//      repeats it so a tenant removed before migration 0057 still gets them.
//   4. The engine: through `packages/umami-adapter` (visit-token purge on every core, then P13 + P9 for every main and
//      twin website, then P13 + P11 for the tenant's user and team). Idempotent: what is already gone is skipped.
//   5. Every tenant table, children before parents, each DELETE under the tenant's context; host claims released
//      through `scf.release_host`; `umami_credentials` only after the engine purge succeeded.
//   6. `tenants.purged_at = now()` (the only column scf_jobs may update; the guard refuses it before purge_after) and
//      one audit row `tenant.purged` with counts only. The tenant row, its audit chain and the tombstones remain.
//
// Any failure rolls the tenant's transaction back and is audited as `tenant.purge_failed` (error class only) in its
// own transaction; the next run starts again (the engine part skips what is gone).
// Residual (documented in the README): if the engine purge succeeded and the transaction then failed, the engine data
// is gone while the tenant is still `removed` and, in principle, restorable until the next run completes the purge.

import type { ScfDb, Tx } from "../db.ts";
import type { EnginePurger, EngineTenant } from "../engine.ts";
import { errorFields } from "../log.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";

/**
 * Every tenant table tenant_purge deletes from, children before parents (foreign keys without ON DELETE CASCADE:
 * declared_contracts → verification_evidence, tenant_registry_links → registry_projects). The list equals the tables
 * whose `jobs_delete` policy names tenant_purge (checked by the integration test against pg_policies).
 */
export const PURGE_TABLES = [
  "web_dev_events", // C-136 (0063)
  "web_event_property_daily", // C-136 (0063)
  "seal_leaves", // C-136 (0065): before traction_snapshots (the day's root and the other leaves stay)
  "footprint_items", // C-136 (0066)
  "web_daily_breakdowns",
  "web_hourly_totals",
  "web_daily_totals",
  "web_edge_counters",
  "web_trust_scores",
  "trust_annotations",
  "erasure_requests",
  "api_metrics_1m",
  "api_metrics_1h",
  "api_metrics_1d",
  "api_service_day_groups",
  "api_route_day",
  "api_routes",
  "api_stream_groups",
  "api_stream_state",
  "api_ingest_counters",
  "api_service_assurance",
  "onchain_daily",
  "protocol_usage_tenant_daily", // 0082
  "declared_contracts",
  "api_services",
  "ingest_tokens",
  "share_keys",
  "footprint_keys", // 0081
  "traction_snapshots",
  "public_metrics_documents",
  "tenant_registry_links",
  "verification_evidence",
  "domain_verifications",
  "site_domains",
  "sites",
  "umami_credentials",
  "tenant_invitations",
  "memberships",
] as const;

export type PurgeOutcome = "purged" | "not_due";

export interface PurgeResult {
  outcome: PurgeOutcome;
  rows: Record<string, number>;
  tombstones: number;
  hostClaims: number;
  websites: number;
}

export function tenantPurgeJob(
  db: ScfDb,
  engine: EnginePurger | null,
  hourlyMinute: number,
): JobDef {
  return {
    name: "tenant_purge",
    triggers: [{ schedule: { kind: "hourly", minute: hourlyMinute }, mode: "hourly" }],
    run: async (ctx) => {
      await runTenantPurge(db, engine, ctx);
    },
  };
}

/** One pass: every due tenant, each in its own transaction. Failures are isolated per tenant and rethrown at the end. */
export async function runTenantPurge(
  db: ScfDb,
  engine: EnginePurger | null,
  ctx: JobContext,
): Promise<Map<string, PurgeResult | "failed">> {
  const queue = await db.tx("tenant_purge", null, (tx) =>
    tx.query<{ tenant_id: string }>(
      "SELECT DISTINCT q.tenant_id FROM scf.job_queue('tenant_purge') q ORDER BY q.tenant_id",
    ),
  );
  const out = new Map<string, PurgeResult | "failed">();
  let failed = 0;
  for (const { tenant_id } of queue) {
    checkAborted(ctx.signal);
    try {
      const r = await purgeTenant(db, engine, tenant_id, ctx);
      out.set(tenant_id, r);
      ctx.metrics.units.inc({
        job: "tenant_purge",
        outcome: r.outcome === "purged" ? "tenant_purged" : "tenant_not_due",
      });
      if (r.outcome === "purged") {
        for (const [rel, n] of Object.entries(r.rows)) {
          ctx.metrics.rows.inc({ job: "tenant_purge", relation: rel, action: "deleted" }, n);
        }
        ctx.log.info("tenant_purged", {
          job: "tenant_purge",
          tenant_id,
          rows: Object.values(r.rows).reduce((a, b) => a + b, 0),
          websites: r.websites,
          tombstones: r.tombstones,
        });
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      failed += 1;
      out.set(tenant_id, "failed");
      ctx.metrics.units.inc({ job: "tenant_purge", outcome: "tenant_failed" });
      ctx.log.error("tenant_purge_failed", { job: "tenant_purge", tenant_id, ...errorFields(err) });
      await auditPurgeFailed(db, tenant_id, err, ctx);
    }
  }
  ctx.log.info("tenant_purge_done", { job: "tenant_purge", due: queue.length, failed });
  if (failed > 0) {
    throw Object.assign(new Error(`${failed} tenant purges failed`), { name: "PurgeIncomplete" });
  }
  return out;
}

interface TenantRow {
  status: string;
  due: boolean;
  purged: boolean;
}

/** Purges one tenant (idempotent; a tenant that is no longer due is left alone). */
export async function purgeTenant(
  db: ScfDb,
  engine: EnginePurger | null,
  tenantId: string,
  ctx: JobContext,
): Promise<PurgeResult> {
  return db.tx("tenant_purge", tenantId, async (tx) => {
    const t = await tx.query<TenantRow>(
      `SELECT t.status::text AS status, (t.purge_after <= now()) AS due, (t.purged_at IS NOT NULL) AS purged
         FROM scf.tenants t WHERE t.tenant_id = $1 FOR UPDATE`,
      [tenantId],
    );
    const row = t[0];
    const empty = { rows: {}, tombstones: 0, hostClaims: 0, websites: 0 };
    if (row?.status !== "removed" || !row.due || row.purged)
      return { outcome: "not_due", ...empty };

    const tombstones = await writeTombstones(tx, tenantId);
    const spec = await engineSpec(tx);
    if (spec.websiteIds.length > 0 || spec.identity) {
      if (!engine) {
        throw Object.assign(new Error("engine purge not configured"), {
          name: "EngineNotConfigured",
        });
      }
      checkAborted(ctx.signal);
      await engine.purgeTenant(spec);
    }
    checkAborted(ctx.signal);

    const claims = await tx.query<{ host: string }>(
      "SELECT h.host FROM scf.host_claims h WHERE h.tenant_id = $1 ORDER BY h.host",
      [tenantId],
    );
    for (const c of claims) await tx.query("SELECT scf.release_host($1, $2)", [c.host, tenantId]);

    const rows: Record<string, number> = {};
    for (const rel of PURGE_TABLES) {
      // Table names come from the constant list above, never from input.
      rows[rel] = await tx.exec(`DELETE FROM scf.${rel} WHERE tenant_id = $1`, [tenantId]);
    }
    const marked = await tx.exec(
      "UPDATE scf.tenants SET purged_at = now() WHERE tenant_id = $1 AND purged_at IS NULL",
      [tenantId],
    );
    if (marked !== 1)
      throw Object.assign(new Error("tenant not marked purged"), { name: "PurgeMarkFailed" });
    const nonZero = Object.fromEntries(Object.entries(rows).filter(([, n]) => n > 0));
    await tx.audit("tenant.purged", "tenant", tenantId, {
      rows: nonZero,
      engine_websites: spec.websiteIds.length,
      engine_identity: spec.identity !== null,
      host_claims_released: claims.length,
      tombstones_added: tombstones,
    });
    return {
      outcome: "purged",
      rows,
      tombstones,
      hostClaims: claims.length,
      websites: spec.websiteIds.length,
    };
  });
}

/**
 * C-64: tombstones for verified hosts, the owners' GitHub ids and valid Stellar accounts through the definer function
 * of migration 0057 (scf_jobs cannot read `external_identities`). Must run before memberships and evidence are deleted.
 */
async function writeTombstones(tx: Tx, tenantId: string): Promise<number> {
  const r = await tx.query<{ n: number }>("SELECT scf.write_removal_tombstones($1) AS n", [
    tenantId,
  ]);
  return Number(r[0]?.n ?? 0);
}

/**
 * `tenant.purge_failed` (migration 0057) in the tenant's chain, in its own transaction (the purge transaction has
 * rolled back). Details carry the error class only — messages can name hosts or engine addresses. A failure to write
 * it is logged and does not mask the purge failure.
 */
async function auditPurgeFailed(
  db: ScfDb,
  tenantId: string,
  err: unknown,
  ctx: JobContext,
): Promise<void> {
  const error =
    err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : "Error";
  try {
    await db.tx("tenant_purge", tenantId, (tx) =>
      tx.audit("tenant.purge_failed", "tenant", tenantId, { error }),
    );
  } catch (e) {
    ctx.log.error("tenant_purge_failed_audit_failed", {
      job: "tenant_purge",
      tenant_id: tenantId,
      ...errorFields(e),
    });
  }
}

async function engineSpec(tx: Tx): Promise<EngineTenant> {
  const sites = await tx.query<{ main: string; twin: string | null }>(
    `SELECT s.umami_website_id::text AS main, s.umami_twin_website_id::text AS twin
       FROM scf.sites s WHERE s.tenant_id = $1 ORDER BY s.site_id`,
    [tx.tenantId],
  );
  const websiteIds = sites.flatMap((s) => (s.twin ? [s.main, s.twin] : [s.main]));
  const cred = await tx.query<{ user_id: string; team_id: string }>(
    `SELECT c.umami_user_id::text AS user_id, c.umami_team_id::text AS team_id
       FROM scf.umami_credentials c WHERE c.tenant_id = $1`,
    [tx.tenantId],
  );
  const c = cred[0];
  return { websiteIds, identity: c ? { userId: c.user_id, teamId: c.team_id } : null };
}
