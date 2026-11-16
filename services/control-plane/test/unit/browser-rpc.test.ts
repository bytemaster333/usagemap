// SPDX-License-Identifier: Apache-2.0
// Browser Stellar RPC / Horizon aggregate (tracker 1.2.0; wire-formats §a.3.2, §d.3 `rpc`; migration 0086): the
// control plane's closed lists are the gateway's (services/gateway/internal/ingest/aggregate.go) and the table's
// (db/migrations/0086_tracker_1_2.sql) — one contract in three places, read from the sources so a drift fails here;
// the counter-record schema accepts the gateway's `rpc` rows and refuses anything else; the shaping is exact.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HORIZON_ROUTES,
  RPC_LATENCIES,
  RPC_METHODS,
  RPC_OUTCOMES,
  rpcCellOk,
} from "../../src/browser-rpc/cells.ts";
import { type BrowserRpcRow, shapeBrowserRpc } from "../../src/browser-rpc/handlers.ts";
import { PROP_VALUES, parseCounterRecord } from "../../src/edge/counters.ts";

const repo = new URL("../../../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${repo}${p}`, "utf8");

/** The string arguments of `name = set(...)` in a Go source. */
function goSet(src: string, name: string): string[] {
  const m = new RegExp(`${name}\\s*=\\s*set\\(([^)]*)\\)`).exec(src);
  if (!m?.[1]) throw new Error(`${name} not found`);
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1] as string);
}

/** The quoted words of the SQL between `start` and `end`. */
function sqlWords(src: string, start: string, end: string): string[] {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) throw new Error(`${start} not found`);
  return [...src.slice(i + start.length, j).matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1] as string);
}

const gw = read("services/gateway/internal/ingest/aggregate.go");
const gwStellar = read("services/gateway/internal/ingest/stellar.go");
const sql = read("db/migrations/0086_tracker_1_2.sql");

describe("browser RPC closed lists: gateway = control plane = database", () => {
  it("RPC methods and Horizon routes", () => {
    expect(goSet(gw, "rpcOperations").sort()).toEqual([...RPC_METHODS, "other"].sort());
    expect(goSet(gw, "horizonOperations").sort()).toEqual([...HORIZON_ROUTES, "other"].sort());
    expect(sqlWords(sql, "WHEN 'rpc' THEN operation IN (", ")").sort()).toEqual(
      [...RPC_METHODS].sort(),
    );
    expect(sqlWords(sql, "ELSE operation IN (", ")").sort()).toEqual([...HORIZON_ROUTES].sort());
  });

  it("outcomes and latency buckets", () => {
    expect(goSet(gw, "rpcOutcomes")).toEqual([...RPC_OUTCOMES]);
    expect(goSet(gw, "rpcLatencies")).toEqual([...RPC_LATENCIES]);
    expect(sqlWords(sql, "outcome    text   NOT NULL CHECK (outcome IN (", "))")).toEqual([
      ...RPC_OUTCOMES,
    ]);
    expect(sqlWords(sql, "latency    text   NOT NULL CHECK (latency IN (", "))")).toEqual([
      ...RPC_LATENCIES,
    ]);
  });

  it("the tracker 1.2.0 property values (§a.3.1) match the gateway", () => {
    for (const [key, goName] of [
      ["failure_reason", "stellarFailReasons"],
      ["wallet_context", "stellarContexts"],
      ["wc_state", "stellarWCStates"],
      ["wc_method", "stellarWCMethods"],
    ] as const)
      expect([...(PROP_VALUES[key] ?? [])].sort(), key).toEqual(goSet(gwStellar, goName).sort());
    expect(PROP_VALUES.wallet?.has("privy")).toBe(true);
  });

  it("an operation must belong to its api, or be `other`", () => {
    expect(rpcCellOk({ api: "rpc", operation: "send_transaction" })).toBe(true);
    expect(rpcCellOk({ api: "horizon", operation: "accounts_id_data_key" })).toBe(true);
    expect(rpcCellOk({ api: "rpc", operation: "other" })).toBe(true);
    expect(rpcCellOk({ api: "horizon", operation: "other" })).toBe(true);
    expect(rpcCellOk({ api: "rpc", operation: "accounts_id" })).toBe(false);
    expect(rpcCellOk({ api: "horizon", operation: "send_transaction" })).toBe(false);
    expect(rpcCellOk({ api: "rpc", operation: "get_everything" })).toBe(false);
  });
});

describe("counter record `rpc` part (§d.3)", () => {
  const T = "0b000000-0000-4000-8000-000000000001";
  const S = "0b000000-0000-4000-8000-000000000002";
  const base = {
    rv: 1,
    type: "counter",
    record_id: "0b000000-0000-4000-8000-000000000003",
    node_id: "edge-v1",
    period_start_ms: 1,
    period_end_ms: 2,
    web: [],
    otlp: [],
    tokens: [],
    spool: {
      boot_id: "0b000000-0000-4000-8000-000000000004",
      day: "2026-11-19",
      fsynced: 0,
      acked_stored: 0,
      acked_engine_bot: 0,
      acked_engine_rejected: 0,
      expired_72h: 0,
      queued: 0,
    },
  };
  // the JSON the gateway writes (spool.RPCCounter)
  const row = {
    tenant_id: T,
    site_id: S,
    day: "2026-11-19",
    api: "rpc",
    operation: "simulate_transaction",
    network: "testnet",
    outcome: "rpc_error",
    latency: "500_2000ms",
    verdict: "suspect",
    count: 3,
  };

  it("accepts the gateway's rows and records without the part", () => {
    expect(parseCounterRecord({ ...base, rpc: [row] }).rpc).toEqual([row]);
    expect(parseCounterRecord(base).rpc).toBeUndefined();
  });

  it.each([
    ["an unknown api", { api: "graphql" }],
    ["a malformed operation", { operation: "getHealth" }],
    ["an unknown outcome", { outcome: "200" }],
    ["an unknown latency bucket", { latency: "17ms" }],
    ["a rejected verdict", { verdict: "rejected" }],
    ["a zero count", { count: 0 }],
    ["an extra field", { url: "https://rpc.example/?key=x" }],
  ])("refuses %s", (_name, patch) => {
    expect(() => parseCounterRecord({ ...base, rpc: [{ ...row, ...patch }] })).toThrow();
  });
});

describe("shapeBrowserRpc", () => {
  const r = (
    day: string,
    api: "rpc" | "horizon",
    operation: string,
    outcome: string,
    latency: string,
    n: number,
    network = "mainnet",
  ): BrowserRpcRow => ({ day, api, operation, network, outcome, latency, n });

  it("sums totals, operations (by calls), outcomes, latency and one point per day", () => {
    const s = shapeBrowserRpc(
      [
        r("2026-11-01", "rpc", "send_transaction", "ok", "lt100ms", 5),
        r("2026-11-01", "rpc", "send_transaction", "http_429", "gt2000ms", 2),
        r("2026-11-02", "rpc", "send_transaction", "ok", "100_500ms", 3, "testnet"),
        r("2026-11-02", "horizon", "accounts_id", "ok", "lt100ms", 4),
        r("2026-11-02", "horizon", "other", "timeout", "gt2000ms", 1),
      ],
      ["2026-11-01", "2026-11-02", "2026-11-03"],
    );
    expect(s.totals).toEqual({ calls: 15, errors: 3, rpc: 10, horizon: 5 });
    expect(s.networks).toEqual([
      { network: "mainnet", calls: 12 },
      { network: "testnet", calls: 3 },
    ]);
    expect(s.operations.map((o) => [o.api, o.operation, o.calls, o.errors])).toEqual([
      ["rpc", "send_transaction", 10, 2],
      ["horizon", "accounts_id", 4, 0],
      ["horizon", "other", 1, 1],
    ]);
    expect(s.operations[0]?.outcomes).toEqual([
      { outcome: "ok", count: 8 },
      { outcome: "http_429", count: 2 },
    ]);
    expect(s.operations[0]?.latency).toEqual({
      lt100ms: 5,
      "100_500ms": 3,
      "500_2000ms": 0,
      gt2000ms: 2,
    });
    expect(s.daily).toEqual([
      { day: "2026-11-01", rpc: 7, horizon: 0, errors: 2 },
      { day: "2026-11-02", rpc: 3, horizon: 5, errors: 1 },
      { day: "2026-11-03", rpc: 0, horizon: 0, errors: 0 },
    ]);
  });

  it("an empty range is zeros, not missing days", () => {
    const s = shapeBrowserRpc([], ["2026-11-01"]);
    expect(s).toEqual({
      totals: { calls: 0, errors: 0, rpc: 0, horizon: 0 },
      networks: [],
      operations: [],
      daily: [{ day: "2026-11-01", rpc: 0, horizon: 0, errors: 0 }],
    });
  });
});
