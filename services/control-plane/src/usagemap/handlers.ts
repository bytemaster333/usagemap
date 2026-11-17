// SPDX-License-Identifier: Apache-2.0
// Ecosystem Usage Map (migration 0075, job usage_map):
//
//   operatorUsageMap         SCF operators: every registry project that lists contract ids, with its on-chain usage in
//                            the window (≤ 92 days), the sparkline series, the Growth Hack weekly active accounts and
//                            the claim badge; filters by round, category, status, name; CSV with Accept: text/csv.
//                            Through scf.op_usage_map (audited, registry:read; distinct-account floor op_min_count).
//   operatorUsageMapProject  one project's detail (≤ 400 days): daily and weekly series, per contract (with the
//                            claimant's footprint state) and per contract function and caller kind.
//   getTenantUsageMap        a tenant's own view: the same series for the registry projects it has CLAIMED (a
//                            confirmed registry link), read under its context (RLS of 0075), exact, each listed
//                            contract marked with the tenant's own footprint state. Unclaimed projects never appear.
//
// Visibility (lead's default, 2026-11-19): unclaimed projects are operator-only and labelled "public chain data —
// ownership not verified"; never on public pages. The registry's contract list is a third-party statement; a
// verified badge needs the claimant's own footprint verification (C-137).

import type { Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import {
  groupRows,
  type ProjectSummary,
  REGISTRY_COLUMNS,
  type RegistryRow,
} from "../onboarding/registry.ts";
import { op, privacySettings, toCsv } from "../operator/common.ts";
import { dayRange } from "../trust/handlers.ts";
import {
  csvRows,
  DEFINITIONS,
  filterItems,
  footprintOf,
  LABELS,
  type OpUsageRow,
  sortItems,
  status,
  successRate,
  toItem,
  type UsageNetwork,
  type UsageStatus,
} from "./model.ts";

export interface UsageMapDeps {
  /** The deployment's network (C-114); the default of the `network` query parameter. */
  network: "public" | "testnet";
}

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().replace(/\.000Z$/, "Z");

function netOf(ctx: RequestContext, deps: UsageMapDeps): UsageNetwork {
  const v = ctx.query.network;
  if (v === "mainnet" || v === "testnet") return v;
  return deps.network === "public" ? "mainnet" : "testnet";
}

function wantsCsv(ctx: RequestContext): boolean {
  const a = ctx.header("accept") ?? "";
  return a.includes("text/csv") && !a.includes("json");
}

type SummaryOf = Map<string, { summary: ProjectSummary; scfAwarded: boolean }>;

/** Registry rows → each row id's merged project summary (one project is often listed by two sources). */
async function summaries(tx: Tx): Promise<SummaryOf> {
  const rows = await tx.query<RegistryRow & { scf_awarded: boolean | null }>(
    `SELECT ${REGISTRY_COLUMNS}, scf_awarded FROM scf.registry_projects WHERE missing_since IS NULL
      ORDER BY registry_project_id`,
  );
  const out: SummaryOf = new Map();
  for (const g of groupRows(rows)) {
    const awarded = g.rows.some(
      (r) => (r as { scf_awarded?: boolean | null }).scf_awarded === true,
    );
    for (const r of g.rows) {
      // The row's own name wins (its contracts are its own statement); the group adds categories, round and stage.
      out.set(r.registry_project_id, {
        summary: { ...g.summary, name: r.name, registry_project_id: r.registry_project_id },
        scfAwarded: awarded,
      });
    }
  }
  return out;
}

const fallback = (id: string): ProjectSummary => ({
  registry_project_id: id,
  name: id,
  website: null,
  domain: null,
  categories: [],
  award_round: null,
  award_stage: null,
  sources: [],
});

export function usageMapHandlers(deps: UsageMapDeps) {
  const operatorUsageMap: Handler = async (ctx) => {
    const { start, end } = dayRange(ctx.query, 92);
    const network = netOf(ctx, deps);
    const { rows, names, privacy } = await ctx.tx(async (tx) => {
      const rows = await op(() =>
        tx.query<OpUsageRow>(
          `SELECT registry_project_id::text AS registry_project_id, contracts_listed, days_covered, invocations,
                  successful_invocations, contract_calls, peak_daily_invokers, daily_invocations,
                  week_start::text AS week_start, active_accounts, active_accounts_successful, prev_active_accounts,
                  claimed, contracts_verified
             FROM scf.op_usage_map($1::timestamptz, $2::timestamptz, $3)`,
          [start, end, network],
        ),
      );
      return { rows, names: await summaries(tx), privacy: await privacySettings(tx) };
    });
    const all = rows.map((r) => {
      const s = names.get(r.registry_project_id);
      return toItem(r, s?.summary ?? fallback(r.registry_project_id), s?.scfAwarded ?? false);
    });
    const round = ctx.query.round === undefined ? undefined : Number(ctx.query.round);
    const items = sortItems(
      filterItems(all, {
        q: typeof ctx.query.q === "string" ? ctx.query.q : undefined,
        round,
        category: ctx.query.category as string | undefined,
        status: ctx.query.status as UsageStatus | undefined,
        awardedOnly: ctx.query.awarded_only === true || ctx.query.awarded_only === "true",
        activeOnly: ctx.query.active_only === true || ctx.query.active_only === "true",
      }),
    );
    if (wantsCsv(ctx))
      return {
        status: 200,
        body: toCsv(csvRows(items)),
        contentType: "text/csv; charset=utf-8",
        headers: {
          "x-scf-min-count": String(privacy.minCount),
          "content-disposition": `attachment; filename="usage-map-${network}-${iso(start).slice(0, 10)}.csv"`,
        },
      };
    const days: string[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += DAY)
      days.push(new Date(t).toISOString().slice(0, 10));
    const totals = { projects: all.length, unclaimed: 0, claimed: 0, verified: 0, active: 0 };
    for (const i of all) {
      totals[i.status]++;
      if (i.invocations + i.contract_calls > 0) totals.active++;
    }
    return {
      status: 200,
      body: {
        network,
        start: iso(start),
        end: iso(end),
        days,
        min_count: privacy.minCount,
        source: "public Stellar ledger files, day anchors checked against Horizon (job usage_map)",
        labels: LABELS,
        definitions: DEFINITIONS,
        totals,
        items,
      },
    };
  };

  const operatorUsageMapProject: Handler = async (ctx) => {
    const { start, end } = dayRange(ctx.query, 400);
    const network = netOf(ctx, deps);
    const id = ctx.params.registryProjectId as string;
    const { doc, names, privacy } = await ctx.tx(async (tx) => {
      const r = await op(() =>
        tx.query<{ doc: Record<string, unknown> | null }>(
          `SELECT scf.op_usage_map_project($1::uuid, $2::timestamptz, $3::timestamptz, $4) AS doc`,
          [id, start, end, network],
        ),
      );
      return {
        doc: r[0]?.doc ?? null,
        names: await summaries(tx),
        privacy: await privacySettings(tx),
      };
    });
    if (!doc) throw new ApiError("not_found");
    const d = doc as {
      daily: { invocations: number; successful_invocations: number }[];
      contracts: { footprint_verified: boolean }[];
      claimed: boolean;
    };
    const verified = d.contracts.filter((c) => c.footprint_verified).length;
    const st = status(d.claimed, verified);
    const s = names.get(id);
    const inv = d.daily.reduce((a, x) => a + Number(x.invocations), 0);
    const ok = d.daily.reduce((a, x) => a + Number(x.successful_invocations), 0);
    return {
      status: 200,
      body: {
        project: {
          ...(s?.summary ?? fallback(id)),
          scf_awarded: s?.scfAwarded ?? false,
        },
        network,
        start: iso(start),
        end: iso(end),
        min_count: privacy.minCount,
        status: st,
        label: LABELS[st],
        definitions: DEFINITIONS,
        success_rate: successRate(ok, inv),
        ...doc,
      },
    };
  };

  const getTenantUsageMap: Handler = async (ctx) => {
    const { start, end } = dayRange(ctx.query, 400);
    const network = netOf(ctx, deps);
    const tenantId = ctx.tenant?.id as string;
    const data = await ctx.tx(async (tx) => {
      const projects = await tx.query<{
        registry_project_id: string;
        name: string;
        contract_ids: string[];
      }>(
        `SELECT p.registry_project_id::text AS registry_project_id, p.name, p.contract_ids
           FROM scf.tenant_registry_links l JOIN scf.registry_projects p USING (registry_project_id)
          WHERE l.tenant_id = $1 AND l.status = 'confirmed' AND p.missing_since IS NULL
            AND cardinality(p.contract_ids) > 0
          ORDER BY p.name, p.registry_project_id`,
        [tenantId],
      );
      const ids = projects.map((p) => p.registry_project_id);
      const contracts = [...new Set(projects.flatMap((p) => p.contract_ids))];
      const d0 = `($2::timestamptz AT TIME ZONE 'UTC')::date`;
      const d1 = `($3::timestamptz AT TIME ZONE 'UTC')::date`;
      // RLS (0075) already limits every table below to the projects this tenant claimed.
      const daily = await tx.query<Record<string, unknown> & { registry_project_id: string }>(
        `SELECT registry_project_id::text AS registry_project_id, day::text AS day, invocations,
                successful_invocations, distinct_invokers, contract_calls, contracts_listed, contracts_invoked
           FROM scf.usage_map_project_daily
          WHERE registry_project_id = ANY($1::uuid[]) AND network = $4 AND day >= ${d0} AND day < ${d1}
          ORDER BY day`,
        [ids, start, end, network],
      );
      const weekly = await tx.query<Record<string, unknown> & { registry_project_id: string }>(
        `SELECT registry_project_id::text AS registry_project_id, week_start::text AS week_start, active_accounts,
                active_accounts_successful, invocations, successful_invocations, contract_calls
           FROM scf.usage_map_project_weekly
          WHERE registry_project_id = ANY($1::uuid[]) AND network = $4 AND week_start >= ${d0}
            AND week_start + 7 <= ${d1}
          ORDER BY week_start`,
        [ids, start, end, network],
      );
      const perContract = await tx.query<{
        contract_id: string;
        invocations: number;
        successful_invocations: number;
        contract_calls: number;
        days_active: number;
      }>(
        `SELECT contract_id, sum(invocations)::bigint AS invocations,
                sum(successful_invocations)::bigint AS successful_invocations,
                sum(contract_calls)::bigint AS contract_calls,
                (count(*) FILTER (WHERE invocations + contract_calls > 0))::int AS days_active
           FROM scf.usage_map_contract_daily
          WHERE contract_id = ANY($1::text[]) AND network = $4 AND day >= ${d0} AND day < ${d1}
          GROUP BY contract_id`,
        [contracts, start, end, network],
      );
      const functions = await tx.query<{
        contract_id: string;
        function: string;
        caller_kind: string;
        calls: number;
        successful_calls: number;
      }>(
        `SELECT contract_id, function_name AS function, caller_kind, sum(calls)::bigint AS calls,
                sum(successful_calls)::bigint AS successful_calls
           FROM scf.usage_map_function_daily
          WHERE contract_id = ANY($1::text[]) AND network = $4 AND day >= ${d0} AND day < ${d1}
          GROUP BY contract_id, function_name, caller_kind
          ORDER BY sum(calls) DESC, contract_id, function_name, caller_kind`,
        [contracts, start, end, network],
      );
      const declared = await tx.query<{
        contract_id: string;
        status: string;
        conflict_since: unknown;
      }>(
        `SELECT contract_id, status, conflict_since FROM scf.declared_contracts
          WHERE tenant_id = $1 AND removed_at IS NULL AND contract_id = ANY($2::text[])`,
        [tenantId, contracts],
      );
      return { projects, daily, weekly, perContract, functions, declared };
    });
    // int8 arrives as text from the driver: counts become numbers; day / week_start stay strings.
    const strip = (r: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k === "registry_project_id") continue;
        out[k] = k === "day" || k === "week_start" || v === null ? v : Number(v);
      }
      return out;
    };
    const byContract = new Map(data.perContract.map((c) => [c.contract_id, c]));
    return {
      status: 200,
      body: {
        network,
        start: iso(start),
        end: iso(end),
        definitions: DEFINITIONS,
        projects: data.projects.map((p) => {
          const contracts = p.contract_ids.map((c) => {
            const x = byContract.get(c);
            return {
              contract_id: c,
              footprint: footprintOf(c, data.declared),
              invocations: Number(x?.invocations ?? 0),
              successful_invocations: Number(x?.successful_invocations ?? 0),
              contract_calls: Number(x?.contract_calls ?? 0),
              days_active: Number(x?.days_active ?? 0),
            };
          });
          const verified = contracts.filter((c) => c.footprint === "verified").length;
          const st = status(true, verified);
          return {
            registry_project_id: p.registry_project_id,
            name: p.name,
            status: st,
            label: LABELS[st],
            contracts_listed: contracts.length,
            contracts_verified: verified,
            daily: data.daily
              .filter((d) => d.registry_project_id === p.registry_project_id)
              .map(strip),
            weekly: data.weekly
              .filter((w) => w.registry_project_id === p.registry_project_id)
              .map(strip),
            contracts,
            functions: data.functions
              .filter((f) => p.contract_ids.includes(f.contract_id))
              .map((f) => ({
                ...f,
                calls: Number(f.calls),
                successful_calls: Number(f.successful_calls),
              })),
          };
        }),
      },
    };
  };

  return { operatorUsageMap, operatorUsageMapProject, getTenantUsageMap };
}
