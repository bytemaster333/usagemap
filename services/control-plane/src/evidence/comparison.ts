// SPDX-License-Identifier: Apache-2.0
// The project's position within its SCF round and categories (traction snapshot v3, SCF Evidence Link).
//
// Cohorts come from the confirmed registry link (registry_projects.award_round, scf_categories; C-136 §i.4). Members
// are the projects measured here that SCF operators would compare (op_eligible_tenants' rule: active, not purged, not
// a canary, verification level ≥ 1). Gates, in order (the first that fails names the status):
//   1. low_confidence      — the snapshot's own confidence is `low` or `insufficient` (its numbers are not comparable)
//   2. not_eligible        — the project itself is level 0 or a canary
//   3. not_enough_data     — the project's own figure is below the minimum-data floor (op_min_count, default 10)
//   4. not_enough_projects — fewer than cohort_min_tenants (≥ 5) members, the project included, reach that floor
// Otherwise the mid-rank percentile (share of the other members below, ties counting half), rounded to a multiple of
// 5 so a cohort of a few projects never yields a precise rank of anyone else. Only the project's own percentile and
// the cohort size are published — never another project's figure, name or rank.

import type { Tx } from "../db/database.ts";
import { isoZ } from "../programme/figures.ts";

export type ComparisonMetric = "web_visitors_verified" | "onchain_calls";
export type PositionStatus =
  | "shown"
  | "low_confidence"
  | "not_eligible"
  | "not_enough_data"
  | "not_enough_projects";

export interface PositionInput {
  self: number | null;
  /** the other members' figures (eligible projects of the cohort, the project itself excluded) */
  others: number[];
  minProjects: number;
  minValue: number;
  selfEligible: boolean;
  confidence: string;
}

export interface Position {
  status: PositionStatus;
  projects: number | null;
  percentile: number | null;
}

/** Mid-rank percentile with the confidence gates and minimum-data floors above (pure). */
export function cohortPosition(i: PositionInput): Position {
  const none = (status: PositionStatus): Position => ({ status, projects: null, percentile: null });
  if (i.confidence === "low" || i.confidence === "insufficient") return none("low_confidence");
  if (!i.selfEligible) return none("not_eligible");
  if (i.self === null || i.self < i.minValue) return none("not_enough_data");
  const peers = i.others.filter((v) => v >= i.minValue);
  const n = peers.length + 1;
  if (n < Math.max(i.minProjects, 2)) return none("not_enough_projects");
  const self = i.self;
  const below = peers.filter((v) => v < self).length;
  const ties = peers.filter((v) => v === self).length;
  const raw = ((below + 0.5 * ties) / peers.length) * 100;
  return { status: "shown", projects: n, percentile: Math.round(raw / 5) * 5 };
}

export interface CohortMember {
  tenantId: string;
  eligible: boolean;
  rounds: number[];
  categories: string[];
  /** per window index: verified visitors (sum of daily) and on-chain calls of the verified footprint */
  values: Array<{ web_visitors_verified: number; onchain_calls: number | null }>;
}

export interface CohortData {
  minProjects: number;
  minValue: number;
  members: CohortMember[];
}

/**
 * Cross-tenant read (job public_metrics, tenant unset — scf.cross_tenant_read_ok, C-17) of the cohort members'
 * figures for each window. Runs in its own transaction before the tenant's signing transaction; nothing of it is
 * stored except the project's own position. `selfTenant` is included even when not eligible (to know its cohorts).
 */
export async function loadCohortData(
  tx: Tx,
  selfTenant: string,
  windows: Array<{ start: number; end: number }>,
  network: "public" | "testnet",
): Promise<CohortData> {
  const s = await tx.one<{ min_tenants: number | null; min_count: number | null }>(
    `SELECT (SELECT (value #>> '{}')::int FROM scf.settings WHERE key = 'cohort_min_tenants') AS min_tenants,
            (SELECT (value #>> '{}')::int FROM scf.settings WHERE key = 'op_min_count') AS min_count`,
  );
  const rows = await tx.query<{
    tenant_id: string;
    eligible: boolean;
    award_round: number | null;
    scf_categories: string[];
  }>(
    `SELECT t.tenant_id::text AS tenant_id,
            (t.status = 'active' AND t.purged_at IS NULL AND NOT t.is_canary
             AND scf.verification_level(t.tenant_id) >= 1) AS eligible,
            p.award_round, p.scf_categories
       FROM scf.tenants t
       JOIN scf.tenant_registry_links l ON l.tenant_id = t.tenant_id AND l.status = 'confirmed'
       JOIN scf.registry_projects p ON p.registry_project_id = l.registry_project_id
      WHERE t.tenant_id = $1::uuid
         OR (t.status = 'active' AND t.purged_at IS NULL AND NOT t.is_canary
             AND scf.verification_level(t.tenant_id) >= 1)`,
    [selfTenant],
  );
  const byTenant = new Map<string, CohortMember>();
  for (const r of rows) {
    let m = byTenant.get(r.tenant_id);
    if (!m) {
      m = {
        tenantId: r.tenant_id,
        eligible: r.eligible,
        rounds: [],
        categories: [],
        values: windows.map(() => ({ web_visitors_verified: 0, onchain_calls: null })),
      };
      byTenant.set(r.tenant_id, m);
    }
    if (r.award_round !== null && !m.rounds.includes(Number(r.award_round)))
      m.rounds.push(Number(r.award_round));
    for (const c of r.scf_categories ?? []) if (!m.categories.includes(c)) m.categories.push(c);
  }
  const ids = [...byTenant.keys()];
  if (ids.length > 0) {
    for (const [i, w] of windows.entries()) {
      const d0 = isoZ(w.start).slice(0, 10);
      const d1 = isoZ(w.end).slice(0, 10);
      const web = await tx.query<{ tenant_id: string; v: string }>(
        `SELECT tenant_id::text AS tenant_id, sum(visitors_verified)::text AS v FROM scf.web_daily_totals
          WHERE tenant_id = ANY($1::uuid[]) AND day >= $2::date AND day < $3::date GROUP BY tenant_id`,
        [ids, d0, d1],
      );
      for (const x of web) {
        const m = byTenant.get(x.tenant_id);
        if (m?.values[i]) m.values[i].web_visitors_verified = Number(x.v);
      }
      // the same footprint rule as the document (C-137): verified, not removed, no open conflict, this network
      const oc = await tx.query<{ tenant_id: string; inv: string }>(
        `SELECT x.tenant_id::text AS tenant_id, sum(x.invocations)::text AS inv
           FROM scf.onchain_daily x
           JOIN scf.declared_contracts dc ON dc.tenant_id = x.tenant_id AND dc.contract_ref = x.contract_ref
                                         AND dc.status = 'verified' AND dc.removed_at IS NULL
                                         AND dc.conflict_since IS NULL AND dc.network = $4
          WHERE x.tenant_id = ANY($1::uuid[]) AND x.day >= $2::date AND x.day < $3::date
          GROUP BY x.tenant_id`,
        [ids, d0, d1, network],
      );
      for (const x of oc) {
        const m = byTenant.get(x.tenant_id);
        if (m?.values[i]) m.values[i].onchain_calls = Number(x.inv);
      }
    }
  }
  return {
    minProjects: Math.max(s.min_tenants ?? 5, 5),
    minValue: Math.max(s.min_count ?? 10, 1),
    members: [...byTenant.values()],
  };
}

export interface CohortRef {
  kind: "round" | "category";
  id: string;
}

/** The cohorts of the project: its award rounds, then its categories (sorted, stable). */
export function cohortsOf(m: CohortMember | undefined): CohortRef[] {
  if (!m) return [];
  return [
    ...[...m.rounds].sort((a, b) => a - b).map((r) => ({ kind: "round" as const, id: String(r) })),
    ...[...m.categories].sort().map((c) => ({ kind: "category" as const, id: c })),
  ];
}

export function inCohort(m: CohortMember, c: CohortRef): boolean {
  return c.kind === "round" ? m.rounds.includes(Number(c.id)) : m.categories.includes(c.id);
}

/** The document's `comparison` block (pure): every cohort × metric, with the self figures of the document. */
export function comparisonBlock(
  data: CohortData,
  selfTenant: string,
  self: { web_visitors_verified: number; onchain_calls: number | null },
  confidence: string,
  windowIndex = 0,
): Record<string, unknown> {
  const me = data.members.find((m) => m.tenantId === selfTenant);
  const cohorts = cohortsOf(me);
  const metrics: ComparisonMetric[] = ["web_visitors_verified", "onchain_calls"];
  const positions = cohorts.flatMap((c) =>
    metrics.map((metric) => {
      const others = data.members
        .filter((m) => m.tenantId !== selfTenant && m.eligible && inCohort(m, c))
        .map((m) => m.values[windowIndex]?.[metric] ?? null)
        .filter((v): v is number => v !== null);
      return {
        cohort: c,
        metric,
        ...cohortPosition({
          self: self[metric],
          others,
          minProjects: data.minProjects,
          minValue: data.minValue,
          selfEligible: me?.eligible === true,
          confidence,
        }),
      };
    }),
  );
  return {
    status: cohorts.length === 0 ? "no_registry_link" : "ok",
    method:
      "mid-rank percentile among Stellar ecosystem projects measured by this service in the same cohort, rounded to 5; " +
      "only cohorts with enough projects that reach the minimum-data floor",
    min_projects: data.minProjects,
    min_value: data.minValue,
    positions,
  };
}
