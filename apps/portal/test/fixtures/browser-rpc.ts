// SPDX-License-Identifier: Apache-2.0
// Fixture of known value for "RPC calls from your users' browsers (daily totals)" (tracker 1.2.0, getSiteBrowserRpc):
// the mock's wallet site has browser RPC/Horizon calls, every other site none. Every figure is FAKE.

import type { ControlPlane } from "@usagemap/api-types";

type Report = ControlPlane.BrowserRpcReport;

function days(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function browserRpcFixture(
  range: Report["range"],
  variant: Report["variant"] = "verified",
): Report {
  const d = days(range.start, range.end);
  const extra = variant === "raw" ? 40 : 0; // suspect cells (Horizon) only in raw
  return {
    range,
    network: "all",
    variant,
    totals: { calls: 1500 + extra, errors: 63, rpc: 1200, horizon: 300 + extra },
    networks: [
      { network: "mainnet", calls: 1300 + extra },
      { network: "testnet", calls: 200 },
    ],
    operations: [
      {
        api: "rpc",
        operation: "simulate_transaction",
        calls: 800,
        errors: 24,
        outcomes: [
          { outcome: "ok", count: 776 },
          { outcome: "rpc_error", count: 20 },
          { outcome: "timeout", count: 4 },
        ],
        latency: { lt100ms: 100, "100_500ms": 600, "500_2000ms": 96, gt2000ms: 4 },
      },
      {
        api: "rpc",
        operation: "send_transaction",
        calls: 400,
        errors: 30,
        outcomes: [
          { outcome: "ok", count: 370 },
          { outcome: "http_429", count: 30 },
        ],
        latency: { lt100ms: 0, "100_500ms": 350, "500_2000ms": 50, gt2000ms: 0 },
      },
      {
        api: "horizon",
        operation: "accounts_id",
        calls: 250 + extra,
        errors: 9,
        outcomes: [
          { outcome: "ok", count: 241 + extra },
          { outcome: "http_4xx", count: 9 },
        ],
        latency: { lt100ms: 200 + extra, "100_500ms": 50, "500_2000ms": 0, gt2000ms: 0 },
      },
      {
        api: "horizon",
        operation: "paths_strict_send",
        calls: 50,
        errors: 0,
        outcomes: [{ outcome: "ok", count: 50 }],
        latency: { lt100ms: 0, "100_500ms": 50, "500_2000ms": 0, gt2000ms: 0 },
      },
    ],
    daily: d.map((day, i) =>
      i === d.length - 1
        ? { day, rpc: 1200, horizon: 300 + extra, errors: 63 }
        : { day, rpc: 0, horizon: 0, errors: 0 },
    ),
  };
}

export function emptyBrowserRpc(
  range: Report["range"],
  variant: Report["variant"] = "verified",
): Report {
  return {
    range,
    network: "all",
    variant,
    totals: { calls: 0, errors: 0, rpc: 0, horizon: 0 },
    networks: [],
    operations: [],
    daily: days(range.start, range.end).map((day) => ({ day, rpc: 0, horizon: 0, errors: 0 })),
  };
}
