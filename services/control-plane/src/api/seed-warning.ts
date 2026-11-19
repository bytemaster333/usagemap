// SPDX-License-Identifier: Apache-2.0
// Secret-seed leak warning (2026-11-19 product improvements; migration 0072; wire-formats §h.3 `route_seed_redacted`).
// The Collector replaces a Stellar secret seed in a request path by `{redacted}` and counts the data point under
// `route_seed_redacted`; nothing of the seed is stored anywhere. This module sums those counters for the tenant's
// portal banner ("N secret seeds appeared in your API request paths since <date> — rotate those keys") and records a
// tenant admin's acknowledgement. Counters are per UTC day, so the acknowledgement keeps each service's count of its own
// day as a baseline: seeds seen later that day still raise the warning again.

import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { visibleTenant } from "./services.ts";

export const SEED_REASON = "route_seed_redacted";

interface AckRow extends Record<string, unknown> {
  ack_at: Date | null;
  ack_day: string | null;
  baseline: Record<string, unknown>;
}

interface DayRow extends Record<string, unknown> {
  service_id: string;
  service_name: string | null;
  day: string;
  n: string;
}

export interface SeedWarning {
  count: number;
  since: string | null;
  last_seen: string | null;
  acknowledged_at: string | null;
  services: Array<{ service_id: string; service_name: string | null; count: number }>;
}

/**
 * Applies the acknowledgement to per-service daily counts: days before the acknowledgement's day are dropped; on the
 * acknowledgement's day each service counts only what exceeds its baseline (its count at the acknowledgement).
 */
export function seedWarningFrom(
  rows: readonly DayRow[],
  ack: { at: Date | null; day: string | null; baseline: Record<string, unknown> },
): SeedWarning {
  const kept: Array<{ service_id: string; service_name: string | null; day: string; n: number }> =
    [];
  for (const r of rows) {
    if (ack.day !== null && r.day < ack.day) continue;
    const b = ack.day !== null && r.day === ack.day ? Number(ack.baseline[r.service_id] ?? 0) : 0;
    const n = Number(r.n) - (Number.isFinite(b) && b > 0 ? b : 0);
    if (n > 0) kept.push({ ...r, n });
  }
  const per = new Map<string, { service_id: string; service_name: string | null; count: number }>();
  let since: string | null = null;
  let last: string | null = null;
  let count = 0;
  for (const r of kept) {
    count += r.n;
    if (since === null || r.day < since) since = r.day;
    if (last === null || r.day > last) last = r.day;
    const p = per.get(r.service_id) ?? {
      service_id: r.service_id,
      service_name: r.service_name,
      count: 0,
    };
    p.count += r.n;
    per.set(r.service_id, p);
  }
  return {
    count,
    since,
    last_seen: last,
    acknowledged_at: ack.at ? ack.at.toISOString() : null,
    services: [...per.values()]
      .sort((a, b) => b.count - a.count || a.service_id.localeCompare(b.service_id))
      .slice(0, 1000),
  };
}

async function load(tx: Tx, tenantId: string): Promise<SeedWarning> {
  const ack = await tx.one<AckRow>(
    `SELECT seed_warning_ack_at AS ack_at,
            (seed_warning_ack_at AT TIME ZONE 'UTC')::date::text AS ack_day,
            seed_warning_ack_baseline AS baseline
       FROM scf.tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  const rows = await tx.query<DayRow>(
    `SELECT c.service_id::text AS service_id, s.service_name, c.day::text AS day, sum(c.count)::bigint AS n
       FROM scf.api_ingest_counters c
       LEFT JOIN scf.api_services s ON s.tenant_id = c.tenant_id AND s.service_id = c.service_id
      WHERE c.tenant_id = $1 AND c.reason = $2 AND ($3::date IS NULL OR c.day >= $3::date)
      GROUP BY 1, 2, 3`,
    [tenantId, SEED_REASON, ack.ack_day],
  );
  return seedWarningFrom(rows, { at: ack.ack_at, day: ack.ack_day, baseline: ack.baseline });
}

export function seedWarningHandlers(): Record<string, Handler> {
  const getSecretSeedWarning: Handler = async (ctx) => {
    const tenantId = visibleTenant(ctx);
    return { status: 200, body: await ctx.tx((tx) => load(tx, tenantId)) };
  };

  const acknowledgeSecretSeedWarning: Handler = async (ctx) => {
    const tenantId = visibleTenant(ctx);
    const body = await ctx.tx(async (tx) => {
      // Baseline: each service's count of today at this moment (today's counters keep growing after it).
      await tx.query(
        `UPDATE scf.tenants
            SET seed_warning_ack_at = now(),
                seed_warning_ack_baseline = COALESCE((
                  SELECT jsonb_object_agg(c.service_id::text, c.count) FROM scf.api_ingest_counters c
                   WHERE c.tenant_id = $1 AND c.reason = $2 AND c.day = (now() AT TIME ZONE 'UTC')::date), '{}')
          WHERE tenant_id = $1`,
        [tenantId, SEED_REASON],
      );
      await tx.audit({
        action: "tenant.updated",
        targetType: "tenant",
        targetId: tenantId,
        details: { fields: ["secret_seed_warning"] },
      });
      return load(tx, tenantId);
    });
    return { status: 200, body };
  };

  return { getSecretSeedWarning, acknowledgeSecretSeedWarning };
}
