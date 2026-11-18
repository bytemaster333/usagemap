// SPDX-License-Identifier: Apache-2.0
// Spike B4: `instrumentStellarRpc(server)` for js-stellar-sdk (tested at 17.4.0).
//
// Attaches to the public `rpc.Server#httpClient.interceptors` (src/rpc/server.ts:322-354 at v17.4.0). Every RPC call
// is `httpClient.post(url, {jsonrpc, id, method, params})` (src/rpc/jsonrpc.ts:49-64), so the request interceptor sees
// the method name and the response interceptor sees the JSON-RPC result. One instrumented server also covers generated
// `contract.Client`s (`options.server`, src/contract/types.ts:201) and AssembledTransaction/SentTransaction.
//
// Emitted (OTel metrics API; no spans, no logs):
//   rpc.client.call.duration   histogram, s   rpc.system.name=jsonrpc, rpc.method (13 known or _OTHER),
//                                             rpc.status_code (JSON-RPC error code, only on error), error.type
//                                             (on failure: the code, "timeout", "http_<status>", "network"),
//                                             stellar.network
//   stellar.tx.submissions      counter         stellar.tx.status (PENDING|DUPLICATE|TRY_AGAIN_LATER|ERROR),
//                                             stellar.tx.result_class (only for ERROR), stellar.network
//   stellar.tx.polls            counter         stellar.tx.status (SUCCESS|FAILED|NOT_FOUND), result_class on FAILED
//   stellar.tx.simulations      counter         stellar.sim.outcome (success|error|restore_required),
//                                             stellar.sim.error_class (on error)
//
// Never read or recorded: the RPC URL (it may carry an API key), params, tx hashes, XDR bodies, addresses, ledger
// keys, error message text, request ids. Decoding of result XDR happens in memory and only the class survives.

import { type Attributes, type Meter, metrics } from "@opentelemetry/api";
import {
  type Network,
  networkOf,
  type ResultClass,
  rpcMethod,
  type RpcMethod,
  simErrorClass,
  txResultClass,
} from "./classify.ts";

/** Minimal structural view of js-stellar-sdk's HttpClient interceptor managers. */
interface InterceptorManager<V> {
  use(fulfilled?: (v: V) => V | Promise<V>, rejected?: (e: unknown) => unknown): number;
  eject(id: number): void;
}
interface RequestConfig {
  url?: string;
  method?: string;
  data?: unknown;
  [k: string]: unknown;
}
interface Response {
  data?: unknown;
  status?: number;
  config?: RequestConfig;
}
export interface RpcServerLike {
  httpClient: {
    interceptors: { request: InterceptorManager<RequestConfig>; response: InterceptorManager<Response> };
  };
}

export interface InstrumentOptions {
  /** OTel meter; defaults to `metrics.getMeter("@usagemap/stellar")`. */
  meter?: Meter;
  /** Network passphrase or name, when known up front. Otherwise learnt from a `getNetwork` response. */
  network?: string;
  /** Record `stellar.network` at all (default true). */
  recordNetwork?: boolean;
}

// The request interceptor stamps the config with a Symbol; Symbol-keyed own properties survive `{...config}` copies,
// so the response (and error) interceptor finds the same stamp on `response.config` / `error.config`.
const STAMP = Symbol.for("usagemap.rpc.stamp");
interface Stamp {
  t0: number;
  method: RpcMethod;
}

const parseBody = (data: unknown): { method?: unknown } | undefined => {
  if (data && typeof data === "object") return data as { method?: unknown };
  if (typeof data === "string" && data.length < 1 << 20) {
    try {
      return JSON.parse(data) as { method?: unknown };
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const NAMED_NETWORKS = new Set(["mainnet", "testnet", "futurenet", "local"]);

/** Instrument one js-stellar-sdk `rpc.Server`. Returns `detach()`. Idempotent per server. */
export function instrumentStellarRpc(server: RpcServerLike, opts: InstrumentOptions = {}): () => void {
  const hc = server?.httpClient;
  if (!hc?.interceptors?.request || !hc.interceptors.response)
    throw new TypeError("instrumentStellarRpc: not a js-stellar-sdk rpc.Server (no httpClient.interceptors)");
  const already = (hc as unknown as Record<symbol, () => void>)[STAMP];
  if (typeof already === "function") return already;

  const meter = opts.meter ?? metrics.getMeter("@usagemap/stellar", "0.0.0-spike");
  const duration = meter.createHistogram("rpc.client.call.duration", {
    unit: "s",
    description: "Duration of outbound Stellar RPC calls, by JSON-RPC method",
    advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] },
  });
  const submissions = meter.createCounter("stellar.tx.submissions", { unit: "{transaction}" });
  const polls = meter.createCounter("stellar.tx.polls", { unit: "{call}" });
  const simulations = meter.createCounter("stellar.tx.simulations", { unit: "{call}" });

  let net: Network = "unknown";
  if (opts.network) net = NAMED_NETWORKS.has(opts.network) ? (opts.network as Network) : networkOf(opts.network);
  const base = (m: RpcMethod): Attributes => {
    const a: Attributes = { "rpc.system.name": "jsonrpc", "rpc.method": m };
    if (opts.recordNetwork !== false) a["stellar.network"] = net;
    return a;
  };
  const withNet = (a: Attributes): Attributes =>
    opts.recordNetwork === false ? a : { ...a, "stellar.network": net };

  const onRequest = (config: RequestConfig): RequestConfig => {
    try {
      if (String(config?.method ?? "post").toLowerCase() === "post") {
        const body = parseBody(config.data);
        if (body && "method" in body)
          (config as Record<symbol, Stamp>)[STAMP] = { t0: performance.now(), method: rpcMethod(body.method) };
      }
    } catch {
      /* instrumentation must never break the call */
    }
    return config;
  };

  const record = (stamp: Stamp, attrs: Attributes) => {
    duration.record((performance.now() - stamp.t0) / 1000, { ...base(stamp.method), ...attrs });
  };

  const onResponse = (res: Response): Response => {
    try {
      const stamp = (res?.config as Record<symbol, Stamp> | undefined)?.[STAMP];
      if (!stamp) return res;
      const body = res.data as { error?: { code?: unknown }; result?: Record<string, unknown> } | undefined;
      if (body && typeof body === "object" && body.error) {
        const code = typeof body.error.code === "number" ? String(body.error.code) : "unknown";
        record(stamp, { "rpc.status_code": code, "error.type": code });
        return res;
      }
      record(stamp, {});
      const r = body?.result;
      if (!r || typeof r !== "object") return res;
      switch (stamp.method) {
        case "getNetwork":
          if (!opts.network) net = networkOf(r.passphrase);
          break;
        case "sendTransaction": {
          const st = String(r.status);
          const status = ["PENDING", "DUPLICATE", "TRY_AGAIN_LATER", "ERROR"].includes(st) ? st : "_OTHER";
          const a: Attributes = { "stellar.tx.status": status };
          if (status === "ERROR") a["stellar.tx.result_class"] = txResultClass(r.errorResultXdr);
          submissions.add(1, withNet(a));
          break;
        }
        case "getTransaction": {
          const st = String(r.status);
          const status = ["SUCCESS", "FAILED", "NOT_FOUND"].includes(st) ? st : "_OTHER";
          const a: Attributes = { "stellar.tx.status": status };
          if (status === "FAILED") a["stellar.tx.result_class"] = txResultClass(r.resultXdr) as ResultClass;
          polls.add(1, withNet(a));
          break;
        }
        case "simulateTransaction": {
          if (typeof r.error === "string")
            simulations.add(1, withNet({ "stellar.sim.outcome": "error", "stellar.sim.error_class": simErrorClass(r.error) }));
          else if (r.restorePreamble)
            simulations.add(1, withNet({ "stellar.sim.outcome": "restore_required" }));
          else simulations.add(1, withNet({ "stellar.sim.outcome": "success" }));
          break;
        }
      }
    } catch {
      /* never break the call */
    }
    return res;
  };

  const onError = (err: unknown): unknown => {
    try {
      const e = err as { config?: RequestConfig; response?: { status?: number }; code?: unknown; name?: unknown };
      const stamp = (e?.config as Record<symbol, Stamp> | undefined)?.[STAMP];
      if (stamp) {
        const status = e.response?.status;
        const type =
          typeof status === "number"
            ? `http_${status}`
            : e.code === "ECONNABORTED" || e.name === "TimeoutError" || e.code === "ETIMEDOUT"
              ? "timeout"
              : "network";
        record(stamp, { "error.type": type });
      }
    } catch {
      /* never break the call */
    }
    return Promise.reject(err);
  };

  const reqId = hc.interceptors.request.use(onRequest);
  const resId = hc.interceptors.response.use(onResponse, onError);
  const detach = () => {
    hc.interceptors.request.eject(reqId);
    hc.interceptors.response.eject(resId);
    delete (hc as unknown as Record<symbol, unknown>)[STAMP];
  };
  (hc as unknown as Record<symbol, () => void>)[STAMP] = detach;
  return detach;
}
