// SPDX-License-Identifier: Apache-2.0
// Spike: `instrumentHorizon(server)` for js-stellar-sdk `Horizon.Server` (same public `httpClient.interceptors`,
// src/horizon/server.ts:93-131 at v17.4.0). Emits the stable OTel HTTP client metric with a Horizon route template:
//   http.client.request.duration  histogram, s  http.request.method, url.template (closed set or _OTHER),
//                                               http.response.status_code, error.type, stellar.network
//   stellar.tx.submissions        counter       via=horizon, stellar.tx.status (SUCCESS|FAILED), result_class
// Account ids, hashes, ledger numbers, cursors and query strings are replaced by the template, never recorded.

import { type Attributes, type Meter, metrics } from "@opentelemetry/api";
import { horizonRoute, type ResultClass } from "./classify.ts";
import type { RpcServerLike } from "./instrument-stellar-rpc.ts";

const STAMP = Symbol.for("usagemap.horizon.stamp");
interface Stamp {
  t0: number;
  route: string;
  method: string;
}

const H_TX: Record<string, ResultClass> = {
  tx_bad_seq: "bad_seq",
  tx_insufficient_fee: "insufficient_fee",
  tx_insufficient_balance: "insufficient_balance",
  tx_bad_auth: "bad_auth",
  tx_bad_auth_extra: "bad_auth",
  tx_too_early: "time_bounds",
  tx_too_late: "time_bounds",
  tx_no_source_account: "no_account",
  tx_malformed: "malformed",
  tx_failed: "op_failed",
  tx_soroban_invalid: "soroban_invalid",
};

const METHODS = new Set(["GET", "POST"]);

export function instrumentHorizon(
  server: RpcServerLike,
  opts: { meter?: Meter; network?: "mainnet" | "testnet" | "futurenet" | "local" } = {},
): () => void {
  const hc = server.httpClient;
  const meter = opts.meter ?? metrics.getMeter("@usagemap/stellar", "0.0.0-spike");
  const duration = meter.createHistogram("http.client.request.duration", {
    unit: "s",
    advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] },
  });
  const submissions = meter.createCounter("stellar.tx.submissions", { unit: "{transaction}" });
  const net = opts.network ?? "unknown";

  const reqId = hc.interceptors.request.use((config) => {
    try {
      const m = String(config.method ?? "get").toUpperCase();
      (config as Record<symbol, Stamp>)[STAMP] = {
        t0: performance.now(),
        route: horizonRoute(config.url),
        method: METHODS.has(m) ? m : "_OTHER",
      };
    } catch {}
    return config;
  });
  const attrs = (s: Stamp, status?: number): Attributes => ({
    "http.request.method": s.method,
    "url.template": s.route,
    ...(status !== undefined ? { "http.response.status_code": status } : {}),
    "stellar.network": net,
  });
  const resId = hc.interceptors.response.use(
    (res) => {
      try {
        const s = (res.config as Record<symbol, Stamp> | undefined)?.[STAMP];
        if (s) {
          duration.record((performance.now() - s.t0) / 1000, attrs(s, res.status));
          if (s.method === "POST" && (s.route === "/transactions" || s.route === "/transactions_async"))
            submissions.add(1, { via: "horizon", "stellar.tx.status": "SUCCESS", "stellar.network": net });
        }
      } catch {}
      return res;
    },
    (err) => {
      try {
        const e = err as {
          config?: Record<symbol, Stamp>;
          response?: { status?: number; data?: { extras?: { result_codes?: { transaction?: unknown } } } };
        };
        const s = e.config?.[STAMP];
        if (s) {
          const st = e.response?.status;
          duration.record((performance.now() - s.t0) / 1000, {
            ...attrs(s, st),
            "error.type": typeof st === "number" ? String(st) : "network",
          });
          if (s.method === "POST" && s.route.startsWith("/transactions")) {
            const code = e.response?.data?.extras?.result_codes?.transaction;
            submissions.add(1, {
              via: "horizon",
              "stellar.tx.status": "FAILED",
              "stellar.tx.result_class": (typeof code === "string" && H_TX[code]) || "other",
              "stellar.network": net,
            });
          }
        }
      } catch {}
      return Promise.reject(err);
    },
  );
  return () => {
    hc.interceptors.request.eject(reqId);
    hc.interceptors.response.eject(resId);
  };
}
