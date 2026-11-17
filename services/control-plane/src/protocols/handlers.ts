// SPDX-License-Identifier: Apache-2.0
// Protocol interactions (migration 0082, job protocol_usage): which DeFi protocols the
// users of a project interact with — per UTC day, how many transactions that touch the project's contracts also touch
// the public contracts of Blend, Soroswap, DeFindex, Aquarius or Reflector (curated, versioned registry of the jobs
// service). Public ledger counts, exact (C-95), lower bounds (contracts a protocol creates at run time and the registry
// does not list are not seen).
//
//   getTenantProtocols   a tenant's own view (its verified contracts, opted in to the on-chain correlation), read
//                        under its context (RLS of 0082): totals and daily series per protocol and the share of its
//                        transactions that touched each protocol.
//   operatorProtocols    SCF operators: every registry project that lists contracts and every tenant, per protocol,
//                        plus the protocols' network totals, through scf.op_protocol_usage (audited, registry:read).
//                        Registry projects are labelled "public chain data — ownership not verified" as in the Usage Map.

import type { Handler, RequestContext } from "../http/pipeline.ts";
import { op } from "../operator/common.ts";
import { dayRange } from "../trust/handlers.ts";

export interface ProtocolsDeps {
  /** The deployment's network (C-114); the default of the `network` query parameter. */
  network: "public" | "testnet";
}

export const PROTOCOLS = {
  blend: { name: "Blend", website: "https://www.blend.capital", kind: "lending" },
  soroswap: { name: "Soroswap", website: "https://soroswap.finance", kind: "exchange" },
  defindex: { name: "DeFindex", website: "https://www.defindex.io", kind: "yield vaults" },
  aquarius: { name: "Aquarius", website: "https://aqua.network", kind: "exchange" },
  reflector: { name: "Reflector", website: "https://reflector.network", kind: "price oracle" },
} as const;
export type ProtocolId = keyof typeof PROTOCOLS;
const IDS = Object.keys(PROTOCOLS) as ProtocolId[];

export const DEFINITION =
  "Transactions that touch your contracts and also touch a protocol's public contracts (top-level call, authorization tree or Soroban footprint), failed included; from the public ledger files, day anchors checked against Horizon. A lower bound: pools, pairs or vaults a protocol creates and its registry does not list are not seen.";

const iso = (d: Date) => d.toISOString().replace(/\.000Z$/, "Z");

function netOf(ctx: RequestContext, deps: ProtocolsDeps): "mainnet" | "testnet" {
  const v = ctx.query.network;
  if (v === "mainnet" || v === "testnet") return v;
  return deps.network === "public" ? "mainnet" : "testnet";
}

const share = (n: number, total: number): number | null =>
  total > 0 ? Math.round((n / total) * 10_000) / 10_000 : null;

interface Totals {
  transactions: number;
  successful_transactions: number;
  days_active: number;
}

/** Per-protocol entries in the fixed order, zeros included; share of the subject's transactions. */
function protocolEntries(by: Map<string, Totals>, total: number) {
  return IDS.map((id) => {
    const t = by.get(id) ?? { transactions: 0, successful_transactions: 0, days_active: 0 };
    return {
      protocol: id,
      name: PROTOCOLS[id].name,
      website: PROTOCOLS[id].website,
      kind: PROTOCOLS[id].kind,
      transactions: t.transactions,
      successful_transactions: t.successful_transactions,
      days_active: t.days_active,
      share: share(t.transactions, total),
    };
  });
}

export function protocolsHandlers(deps: ProtocolsDeps) {
  const getTenantProtocols: Handler = async (ctx) => {
    const { start, end } = dayRange(ctx.query, 400);
    const network = netOf(ctx, deps);
    const tenantId = ctx.tenant?.id as string;
    const d0 = `($2::timestamptz AT TIME ZONE 'UTC')::date`;
    const d1 = `($3::timestamptz AT TIME ZONE 'UTC')::date`;
    const data = await ctx.tx(async (tx) => {
      const rows = await tx.query<{
        day: string;
        protocol: string;
        transactions: string;
        ok: string;
        v: string;
      }>(
        `SELECT day::text AS day, protocol, transactions::text AS transactions, successful_transactions::text AS ok,
                registry_version AS v
           FROM scf.protocol_usage_tenant_daily
          WHERE tenant_id = $1 AND network = $4 AND day >= ${d0} AND day < ${d1}
          ORDER BY day, protocol`,
        [tenantId, start, end, network],
      );
      const covered = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM scf.protocol_usage_days
          WHERE network = $3 AND day >= ($1::timestamptz AT TIME ZONE 'UTC')::date
            AND day < ($2::timestamptz AT TIME ZONE 'UTC')::date`,
        [start, end, network],
      );
      // The tenant's own verified contracts on this network (the subject of the figures; public chain objects).
      const contracts = await tx.query<{ contract_id: string }>(
        `SELECT contract_id FROM scf.declared_contracts
          WHERE tenant_id = $1 AND network = $2 AND status = 'verified' AND removed_at IS NULL
            AND conflict_since IS NULL
          ORDER BY contract_id`,
        [tenantId, network === "mainnet" ? "public" : "testnet"],
      );
      return { rows, days: covered[0]?.n ?? 0, contracts: contracts.map((c) => c.contract_id) };
    });
    const by = new Map<string, Totals>();
    let total = 0;
    let ok = 0;
    let version: string | null = null;
    for (const r of data.rows) {
      version = r.v;
      const n = Number(r.transactions);
      if (r.protocol === "any") {
        total += n;
        ok += Number(r.ok);
        continue;
      }
      const t = by.get(r.protocol) ?? {
        transactions: 0,
        successful_transactions: 0,
        days_active: 0,
      };
      t.transactions += n;
      t.successful_transactions += Number(r.ok);
      if (n > 0) t.days_active++;
      by.set(r.protocol, t);
    }
    return {
      status: 200,
      body: {
        network,
        start: iso(start),
        end: iso(end),
        days_covered: data.days,
        days_with_data: new Set(data.rows.map((r) => r.day)).size,
        registry_version: version,
        definition: DEFINITION,
        transactions: total,
        successful_transactions: ok,
        contracts: data.contracts,
        protocols: protocolEntries(by, total),
        daily: data.rows
          .filter((r) => r.protocol !== "any")
          .map((r) => ({ day: r.day, protocol: r.protocol, transactions: Number(r.transactions) })),
      },
    };
  };

  const operatorProtocols: Handler = async (ctx) => {
    const { start, end } = dayRange(ctx.query, 92);
    const network = netOf(ctx, deps);
    const data = await ctx.tx(async (tx) => {
      const rows = await op(() =>
        tx.query<{
          subject_kind: "project" | "tenant" | "network";
          subject_id: string | null;
          protocol: string;
          transactions: string;
          successful_transactions: string;
          days_active: number;
          days_covered: number;
        }>(
          `SELECT subject_kind, subject_id::text AS subject_id, protocol, transactions::text AS transactions,
                  successful_transactions::text AS successful_transactions, days_active, days_covered
             FROM scf.op_protocol_usage($1::timestamptz, $2::timestamptz, $3)`,
          [start, end, network],
        ),
      );
      const ids = [
        ...new Set(rows.filter((r) => r.subject_kind === "project").map((r) => r.subject_id)),
      ];
      const names =
        ids.length > 0
          ? await tx.query<{ id: string; name: string }>(
              `SELECT registry_project_id::text AS id, name FROM scf.registry_projects
                WHERE registry_project_id = ANY($1::uuid[])`,
              [ids],
            )
          : [];
      return { rows, names: new Map(names.map((n) => [n.id, n.name])) };
    });
    const days = data.rows[0]?.days_covered ?? 0;
    const subjects = new Map<
      string,
      { kind: "project" | "tenant"; id: string; total: number; ok: number; by: Map<string, Totals> }
    >();
    const network_by = new Map<string, Totals>();
    for (const r of data.rows) {
      const t = {
        transactions: Number(r.transactions),
        successful_transactions: Number(r.successful_transactions),
        days_active: r.days_active,
      };
      if (r.subject_kind === "network") {
        network_by.set(r.protocol, t);
        continue;
      }
      const key = `${r.subject_kind}/${r.subject_id}`;
      const s = subjects.get(key) ?? {
        kind: r.subject_kind,
        id: r.subject_id as string,
        total: 0,
        ok: 0,
        by: new Map<string, Totals>(),
      };
      if (r.protocol === "any") {
        s.total = t.transactions;
        s.ok = t.successful_transactions;
      } else s.by.set(r.protocol, t);
      subjects.set(key, s);
    }
    const list = [...subjects.values()]
      .map((s) => ({
        kind: s.kind,
        id: s.id,
        name: s.kind === "project" ? (data.names.get(s.id) ?? null) : null,
        label:
          s.kind === "project"
            ? "public chain data — ownership not verified"
            : "tenant (verified contracts)",
        transactions: s.total,
        successful_transactions: s.ok,
        protocols: protocolEntries(s.by, s.total),
      }))
      .filter(
        (s) => ctx.query.active_only !== "true" || s.protocols.some((p) => p.transactions > 0),
      )
      .sort(
        (a, b) =>
          b.protocols.reduce((n, p) => n + p.transactions, 0) -
            a.protocols.reduce((n, p) => n + p.transactions, 0) ||
          b.transactions - a.transactions ||
          a.id.localeCompare(b.id),
      );
    return {
      status: 200,
      body: {
        network,
        start: iso(start),
        end: iso(end),
        days_covered: days,
        definition: DEFINITION,
        network_totals: IDS.map((id) => {
          const t = network_by.get(id) ?? {
            transactions: 0,
            successful_transactions: 0,
            days_active: 0,
          };
          return { protocol: id, name: PROTOCOLS[id].name, ...t };
        }),
        subjects: list,
      },
    };
  };

  return { getTenantProtocols, operatorProtocols };
}
