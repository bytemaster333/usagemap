// SPDX-License-Identifier: Apache-2.0
// Browser Stellar RPC / Horizon aggregate (tracker 1.2.0, `stellar_rpc`; wire-formats §a.3.2, §d.3 `rpc`; migration
// 0086, scf.web_rpc_client_daily). The tracker's `/stellar-rpc` subpath counts the app's own RPC and Horizon calls in
// the visitor's browser per closed cell [api, operation, network, outcome, latency bucket] and sends one aggregate per
// page lifecycle; the gateway adds the cells of accepted aggregates to the counter record's optional `rpc` part. Here
// those rows are checked against the closed lists (the same lists as the table's checks and the gateway's parser) and
// added to the per-site daily table. No visitor key, session, page, time of call, URL or address exists to store.

import type { Tx } from "../db/database.ts";

export const RPC_APIS = ["rpc", "horizon"] as const;
export type RpcApi = (typeof RPC_APIS)[number];

/** RPC methods (js-stellar-sdk `rpc.Server`) in snake case; anything else arrives as `other` (gateway fold). */
export const RPC_METHODS = [
  "get_health",
  "get_network",
  "get_latest_ledger",
  "get_ledgers",
  "get_ledger_entries",
  "get_events",
  "get_fee_stats",
  "get_version_info",
  "get_transaction",
  "get_transactions",
  "simulate_transaction",
  "send_transaction",
  "query_events",
] as const;

/** Horizon route templates of packages/stellar-otel in snake case (`/` → root). */
export const HORIZON_ROUTES = [
  "root",
  "accounts",
  "accounts_id",
  "accounts_id_data_key",
  "accounts_id_effects",
  "accounts_id_offers",
  "accounts_id_operations",
  "accounts_id_payments",
  "accounts_id_trades",
  "accounts_id_transactions",
  "assets",
  "claimable_balances",
  "claimable_balances_id",
  "claimable_balances_id_operations",
  "claimable_balances_id_transactions",
  "effects",
  "fee_stats",
  "friendbot",
  "health",
  "ledgers",
  "ledgers_id",
  "ledgers_id_effects",
  "ledgers_id_operations",
  "ledgers_id_payments",
  "ledgers_id_transactions",
  "liquidity_pools",
  "liquidity_pools_id",
  "liquidity_pools_id_effects",
  "liquidity_pools_id_operations",
  "liquidity_pools_id_trades",
  "liquidity_pools_id_transactions",
  "offers",
  "offers_id",
  "offers_id_trades",
  "operations",
  "operations_id",
  "operations_id_effects",
  "order_book",
  "paths",
  "paths_strict_receive",
  "paths_strict_send",
  "payments",
  "trade_aggregations",
  "trades",
  "transactions",
  "transactions_id",
  "transactions_id_effects",
  "transactions_id_operations",
  "transactions_id_payments",
  "transactions_async",
] as const;

export const RPC_NETWORKS = ["mainnet", "testnet", "futurenet", "local", "unknown"] as const;
export const RPC_OUTCOMES = [
  "ok",
  "rpc_error",
  "http_4xx",
  "http_429",
  "http_5xx",
  "timeout",
  "network_error",
] as const;
export const RPC_LATENCIES = ["lt100ms", "100_500ms", "500_2000ms", "gt2000ms"] as const;

/** One row of the counter record's `rpc` part (wire-formats §d.3). */
export interface RpcRow {
  tenant_id: string;
  site_id: string;
  day: string;
  api: RpcApi;
  operation: string;
  network: (typeof RPC_NETWORKS)[number];
  outcome: (typeof RPC_OUTCOMES)[number];
  latency: (typeof RPC_LATENCIES)[number];
  verdict: "verified" | "suspect";
  count: number;
}

/** JSON schema of the `rpc` part (wire-formats §d.3, verbatim). */
export const RPC_PART_SCHEMA = {
  type: "array",
  maxItems: 100000,
  items: {
    type: "object",
    additionalProperties: false,
    required: [
      "tenant_id",
      "site_id",
      "day",
      "api",
      "operation",
      "network",
      "outcome",
      "latency",
      "verdict",
      "count",
    ],
    properties: {
      tenant_id: { type: "string", format: "uuid" },
      site_id: { type: "string", format: "uuid" },
      day: { type: "string", format: "date" },
      api: { enum: [...RPC_APIS] },
      operation: { type: "string", pattern: "^[a-z0-9_]{1,40}$" },
      network: { enum: [...RPC_NETWORKS] },
      outcome: { enum: [...RPC_OUTCOMES] },
      latency: { enum: [...RPC_LATENCIES] },
      verdict: { enum: ["verified", "suspect"] },
      count: { type: "integer", minimum: 1 },
    },
  },
} as const;

const KNOWN: Record<RpcApi, ReadonlySet<string>> = {
  rpc: new Set<string>(RPC_METHODS),
  horizon: new Set<string>(HORIZON_ROUTES),
};

/**
 * The operation rule of web_rpc_client_daily (constraint web_rpc_client_daily_operation): a known operation of its
 * api, or `other`. Checked before the insert so one cell outside the lists never fails a whole record.
 */
export function rpcCellOk(r: Pick<RpcRow, "api" | "operation">): boolean {
  return r.operation === "other" || KNOWN[r.api]?.has(r.operation) === true;
}

/**
 * `rpc` rows → `web_rpc_client_daily`, `count = count + EXCLUDED.count`; rows of sites not belonging to the tenant
 * and cells outside the lists are dropped and counted (returned), never a failed record (as `props` and `app`).
 */
export async function applyRpc(tx: Tx, tenantId: string, rows: RpcRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const valid = rows.filter(rpcCellOk);
  let skipped = rows.length - valid.length;
  if (valid.length === 0) return skipped;
  const key = (r: {
    site_id: string;
    day: string;
    api: string;
    operation: string;
    network: string;
    outcome: string;
    latency: string;
    verdict: string;
  }) =>
    [r.site_id, r.day, r.api, r.operation, r.network, r.outcome, r.latency, r.verdict].join("|");
  const groups = new Map<string, number>();
  for (const r of valid) groups.set(key(r), (groups.get(key(r)) ?? 0) + 1);
  const inserted = await tx.query<{
    site_id: string;
    day: string;
    api: string;
    operation: string;
    network: string;
    outcome: string;
    latency: string;
    verdict: string;
  }>(
    `WITH input AS (
       SELECT * FROM unnest($2::uuid[], $3::date[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                            $9::text[], $10::bigint[])
                AS x(site_id, day, api, operation, network, outcome, latency, verdict, count)
     ), agg AS (
       SELECT site_id, day, api, operation, network, outcome, latency, verdict, sum(count) AS count
         FROM input GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
     )
     INSERT INTO scf.web_rpc_client_daily AS c
            (tenant_id, site_id, day, api, operation, network, outcome, latency, verdict, count)
     SELECT $1, a.site_id, a.day, a.api, a.operation, a.network, a.outcome, a.latency, a.verdict, a.count FROM agg a
       JOIN scf.sites s ON s.tenant_id = $1 AND s.site_id = a.site_id
     ON CONFLICT (tenant_id, site_id, day, api, operation, network, outcome, latency, verdict)
       DO UPDATE SET count = c.count + EXCLUDED.count
     RETURNING c.site_id::text AS site_id, c.day::text AS day, c.api, c.operation, c.network, c.outcome, c.latency,
               c.verdict`,
    [
      tenantId,
      valid.map((r) => r.site_id),
      valid.map((r) => r.day),
      valid.map((r) => r.api),
      valid.map((r) => r.operation),
      valid.map((r) => r.network),
      valid.map((r) => r.outcome),
      valid.map((r) => r.latency),
      valid.map((r) => r.verdict),
      valid.map((r) => r.count),
    ],
  );
  for (const r of inserted) groups.delete(key(r));
  for (const n of groups.values()) skipped += n;
  return skipped;
}
