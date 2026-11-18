// SPDX-License-Identifier: Apache-2.0
// `instrumentStellarRpc(server)` for js-stellar-sdk `rpc.Server` (supported: 13.x to 17.x; tested at 13.3.0,
// 14.1.0, 14.6.1, 15.1.0, 16.4.1 and 17.4.0).
//
// Attaches to the public `rpc.Server#httpClient.interceptors` (per server since v14.3.1, src/rpc/server.ts), or on
// 13.x to 14.3.0 to the module-wide `rpc.AxiosClient.interceptors` when the `rpc` namespace is passed. Every RPC call
// is `client.post(url, {jsonrpc, id, method, params})` (src/rpc/jsonrpc.ts, unchanged since 13.0.0), so the request
// interceptor sees the method name and the response interceptor sees the JSON-RPC result. One instrumented server also covers generated
// `contract.Client`s and `AssembledTransaction`s when it is passed as their `server` option.
//
// Never read into an attribute: the RPC URL (it may carry an API key), params, transaction hashes, XDR bodies,
// addresses, ledger keys, error message text, request ids. Result XDR is decoded in memory; only the class survives.

import type { Attributes } from "@opentelemetry/api";
import {
  closed,
  jsonRpcErrorType,
  type Network,
  networkOf,
  POLL_STATUSES,
  type RpcMethod,
  rpcMethod,
  SUBMIT_STATUSES,
  simErrorClass,
  transportErrorType,
  txResultClass,
} from "./classify.ts";
import {
  type HttpResponse,
  hookOf,
  type Instrumentation,
  type InstrumentOptions,
  instruments,
  NOT_INSTRUMENTED,
  now,
  type RequestConfig,
  type ServerLike,
  type Stamp,
  StampCarrier,
  safely,
  seconds,
} from "./common.ts";

interface RpcStamp extends Stamp {
  readonly method: RpcMethod;
}

const MAX_BODY = 1 << 20;
const parseBody = (data: unknown): { method?: unknown } | undefined => {
  if (data && typeof data === "object" && !ArrayBuffer.isView(data))
    return data as { method?: unknown };
  if (typeof data === "string" && data.length < MAX_BODY) {
    try {
      const v: unknown = JSON.parse(data);
      return v && typeof v === "object" ? (v as { method?: unknown }) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const attached = new WeakMap<object, Instrumentation>();

/**
 * Instrument one js-stellar-sdk `rpc.Server` (SDK ≥ 14.3.1), or, on SDK 13.x to 14.3.0, the `rpc` namespace (all
 * servers of that SDK copy share its `AxiosClient`). Idempotent per client: a second call returns the first handle.
 * Anything without the public interceptor API (an SDK older than 13, a 13.x server instance instead of the
 * namespace, or not a server at all) is left untouched and the handle says `instrumented: false`.
 *
 * Emits `rpc.client.call.duration` (s) per call, plus `stellar.tx.submissions` (sendTransaction),
 * `stellar.tx.polls` (getTransaction) and `stellar.tx.simulations` (simulateTransaction).
 */
export function instrumentStellarRpc(
  server: ServerLike,
  opts: InstrumentOptions = {},
): Instrumentation {
  const hook = hookOf(server);
  if (!hook) return NOT_INSTRUMENTED;
  const { hc, req, res, scope } = hook;
  const prev = attached.get(hc);
  if (prev) return prev;

  const ins = instruments(opts.meter);
  const carrier = new StampCarrier<RpcStamp>("scf.stellar-otel.rpc");
  const fixed = opts.network !== undefined;
  let net: Network = fixed ? networkOf(opts.network) : "unknown";

  const base = (m: RpcMethod): Attributes => ({
    "rpc.system.name": "jsonrpc",
    "rpc.method": m,
    "stellar.network": net,
  });

  const onRequest = (config: RequestConfig): RequestConfig => {
    safely(() => {
      if (String(config?.method ?? "post").toLowerCase() !== "post") return;
      const body = parseBody(config.data);
      if (body && "method" in body)
        carrier.put(config, { t0: now(), method: rpcMethod(body.method) });
    });
    return config;
  };

  const onResponse = (r: HttpResponse): HttpResponse => {
    safely(() => {
      const s = carrier.get(r?.config);
      if (!s) return;
      const body = r.data as { error?: { code?: unknown }; result?: unknown } | undefined;
      if (body && typeof body === "object" && body.error && typeof body.error === "object") {
        const t = jsonRpcErrorType(body.error.code);
        const a: Attributes = { ...base(s.method), "error.type": t };
        if (t !== "_OTHER") a["rpc.status_code"] = t;
        ins.rpcDuration.record(seconds(s.t0), a);
        return;
      }
      const result = body && typeof body === "object" ? body.result : undefined;
      const rr =
        result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
      if (s.method === "getNetwork" && !fixed && rr) net = networkOf(rr.passphrase);
      ins.rpcDuration.record(seconds(s.t0), base(s.method));
      if (!rr) return;
      const withNet = (a: Attributes): Attributes => ({ ...a, "stellar.network": net });
      switch (s.method) {
        case "sendTransaction": {
          const status = closed(SUBMIT_STATUSES, rr.status);
          const a: Attributes = { "stellar.tx.via": "rpc", "stellar.tx.status": status };
          if (status === "ERROR") a["stellar.tx.result_class"] = txResultClass(rr.errorResultXdr);
          ins.submissions.add(1, withNet(a));
          break;
        }
        case "getTransaction": {
          const status = closed(POLL_STATUSES, rr.status);
          const a: Attributes = { "stellar.tx.status": status };
          if (status === "FAILED") a["stellar.tx.result_class"] = txResultClass(rr.resultXdr);
          ins.polls.add(1, withNet(a));
          break;
        }
        case "simulateTransaction": {
          if (typeof rr.error === "string")
            ins.simulations.add(
              1,
              withNet({
                "stellar.sim.outcome": "error",
                "stellar.sim.error_class": simErrorClass(rr.error),
              }),
            );
          else if (rr.restorePreamble)
            ins.simulations.add(1, withNet({ "stellar.sim.outcome": "restore_required" }));
          else ins.simulations.add(1, withNet({ "stellar.sim.outcome": "success" }));
          break;
        }
      }
    });
    return r;
  };

  const onError = (err: unknown): unknown => {
    safely(() => {
      const s = carrier.get((err as { config?: unknown } | undefined)?.config);
      if (s)
        ins.rpcDuration.record(seconds(s.t0), {
          ...base(s.method),
          "error.type": transportErrorType(err),
        });
    });
    return Promise.reject(err);
  };

  const reqId = req.use(onRequest);
  const resId = res.use(onResponse, onError);
  let done = false;
  const handle: Instrumentation = {
    instrumented: true,
    scope,
    detach() {
      if (done) return;
      done = true;
      req.eject(reqId);
      res.eject(resId);
      attached.delete(hc);
    },
  };
  attached.set(hc, handle);
  return handle;
}
