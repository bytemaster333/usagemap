// SPDX-License-Identifier: Apache-2.0
// SCF-operator reads and actions on the Registered Footprint (C-136, C-137): a project's Registered Footprint (`scf.op_footprint`), the
// resolution of a footprint conflict (`scf.op_footprint_reject`: operator_admin with step-up, audited
// `footprint.conflict_resolved`) and the SCF cohorts (`scf.op_cohorts`). As everywhere in the operator console, the
// database function authorises, audits in the same transaction and applies the floors (C-17); this module only shapes
// rows. The cohort floor is statistical, not a privacy boundary (C-137 (14)).

import { pgCode, type Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { levelNumber, numOrNull, op, opError } from "./common.ts";

export interface CohortRow extends Record<string, unknown> {
  cohort: string;
  tenant_count: number | null;
  pageviews_verified: string | null;
  pageviews_raw: string | null;
  visitors_sum_verified: string | null;
  tenants_with_onchain: number | null;
  onchain_invocations: string | null;
  onchain_successful_invocations: string | null;
  suppressed: boolean;
}

/** `scf.op_cohorts` in the caller's context (operator session or operator key); figures stay null where withheld. */
export async function readCohorts(
  tx: Tx,
  q: Record<string, unknown>,
): Promise<{ rows: CohortRow[]; minTenants: number }> {
  const rows = await op(() =>
    tx.query<CohortRow>(
      `SELECT cohort, tenant_count, pageviews_verified::text AS pageviews_verified,
              pageviews_raw::text AS pageviews_raw, visitors_sum_verified::text AS visitors_sum_verified,
              tenants_with_onchain, onchain_invocations::text AS onchain_invocations,
              onchain_successful_invocations::text AS onchain_successful_invocations, suppressed
         FROM scf.op_cohorts($1, $2, $3, $4::smallint)`,
      [q.start, q.end, q.by, levelNumber(q.min_level)],
    ),
  );
  const m = await tx.one<{ v: number | null }>(
    `SELECT (value #>> '{}')::int AS v FROM scf.settings WHERE key = 'cohort_min_tenants'`,
  );
  return { rows, minTenants: Math.max(m.v ?? 5, 2) };
}

export function cohortFigures(r: CohortRow) {
  return {
    pageviews_verified: numOrNull(r.pageviews_verified),
    pageviews_raw: numOrNull(r.pageviews_raw),
    visitors_sum_verified: numOrNull(r.visitors_sum_verified),
    onchain_invocations: numOrNull(r.onchain_invocations),
    onchain_successful_invocations: numOrNull(r.onchain_successful_invocations),
    suppressed: r.suppressed,
  };
}

interface OpFootprintRow extends Record<string, unknown> {
  tenant_id: string;
  item_id: string;
  kind: string;
  subject: string | null;
  network: string;
  label: string | null;
  status: string;
  verification_method: string | null;
  verified_at: Date | null;
  rejected_reason: string | null;
  conflict_since: Date | null;
  created_at: Date;
}

export function operatorFootprintView(r: OpFootprintRow): Record<string, unknown> {
  return {
    tenant_id: r.tenant_id,
    item_id: r.item_id,
    kind: r.kind,
    subject: r.subject,
    network: r.network,
    label: r.label,
    status: r.status,
    verification_method: r.verification_method,
    verified_at: r.verified_at?.toISOString() ?? null,
    rejected_reason: r.rejected_reason,
    conflict_since: r.conflict_since?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
  };
}

export function operatorFootprintHandlers(): Record<string, Handler> {
  const operatorTenantFootprint: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) =>
      op(() =>
        tx.query<OpFootprintRow>(
          `SELECT tenant_id::text AS tenant_id, item_id::text AS item_id, kind, subject, network, label, status,
                  verification_method, verified_at, rejected_reason, conflict_since, created_at
             FROM scf.op_footprint(ARRAY[$1]::uuid[], $2)`,
          [ctx.params.tenantId, ctx.query.status ?? null],
        ),
      ),
    );
    return { status: 200, body: rows.map(operatorFootprintView) };
  };

  const operatorRejectFootprintConflict: Handler = async (ctx) => {
    await ctx.tx(async (tx) => {
      try {
        await tx.query(`SELECT scf.op_footprint_reject($1::uuid, $2::uuid)`, [
          ctx.params.tenantId,
          ctx.params.itemId,
        ]);
      } catch (err) {
        const code = pgCode(err);
        if (code === "P0002") throw new ApiError("not_found");
        if (code === "22023")
          throw new ApiError("conflict", "the item is not in a footprint conflict");
        opError(err);
      }
    });
    return { status: 204 };
  };

  const operatorCohorts: Handler = async (ctx) => {
    const q = ctx.query;
    const { rows, minTenants } = await ctx.tx((tx) => readCohorts(tx, q));
    return {
      status: 200,
      body: {
        by: q.by,
        range: { start: q.start, end: q.end },
        min_tenants: minTenants,
        cohorts: rows.map((r) => ({
          cohort: r.cohort,
          tenant_count: r.tenant_count,
          tenants_with_onchain: r.tenants_with_onchain,
          ...cohortFigures(r),
        })),
      },
    };
  };

  return { operatorTenantFootprint, operatorRejectFootprintConflict, operatorCohorts };
}
