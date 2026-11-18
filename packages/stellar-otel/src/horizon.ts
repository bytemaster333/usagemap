// SPDX-License-Identifier: Apache-2.0
// `instrumentHorizon(server)` for js-stellar-sdk `Horizon.Server` (supported: 13.x to 17.x), through the same public
// interceptors as the RPC instrumentation: `Horizon.Server#httpClient` (since v14.3.1, src/horizon/server.ts) or,
// on 13.x to 14.3.0, the module-wide `Horizon.AxiosClient` when the `Horizon` namespace is passed.
//
// Emits the stable OTel HTTP client metric with a closed Horizon route template, and `stellar.tx.submissions`
// (`stellar.tx.via = horizon`) for POST /transactions and /transactions_async. Account ids, hashes, ledger numbers,
// cursors, query strings and any base-path prefix of the Horizon URL are replaced by the template, never recorded.

import type { Attributes } from "@opentelemetry/api";
import {
  closed,
  HORIZON_TX_CODES,
  horizonRoute,
  httpStatus,
  type Network,
  networkOf,
  type ResultClass,
  SUBMIT_STATUSES,
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

interface HorizonStamp extends Stamp {
  readonly route: string;
  readonly method: "GET" | "POST" | "_OTHER";
}

const attached = new WeakMap<object, Instrumentation>();

const submitRoute = (s: HorizonStamp) =>
  s.method === "POST" && (s.route === "/transactions" || s.route === "/transactions_async");

interface HorizonBody {
  tx_status?: unknown;
  errorResultXdr?: unknown;
  error_result_xdr?: unknown;
  extras?: { result_codes?: { transaction?: unknown }; result_xdr?: unknown };
}

const failureClass = (b: HorizonBody | undefined): ResultClass => {
  const code = b?.extras?.result_codes?.transaction;
  if (typeof code === "string" && Object.hasOwn(HORIZON_TX_CODES, code))
    return HORIZON_TX_CODES[code] as ResultClass;
  const xdr = b?.extras?.result_xdr ?? b?.errorResultXdr ?? b?.error_result_xdr;
  return xdr === undefined ? "other" : txResultClass(xdr);
};

/**
 * Instrument one js-stellar-sdk `Horizon.Server` (SDK ≥ 14.3.1), or, on SDK 13.x to 14.3.0, the `Horizon` namespace
 * (module-wide `AxiosClient`). Idempotent per client; anything without the public interceptor API is left untouched
 * and the handle says `instrumented: false`.
 */
export function instrumentHorizon(
  server: ServerLike,
  opts: InstrumentOptions = {},
): Instrumentation {
  const hook = hookOf(server);
  if (!hook) return NOT_INSTRUMENTED;
  const { hc, req, res, scope } = hook;
  const prev = attached.get(hc);
  if (prev) return prev;

  const ins = instruments(opts.meter);
  const carrier = new StampCarrier<HorizonStamp>("scf.stellar-otel.horizon");
  const net: Network = networkOf(opts.network);

  const attrs = (s: HorizonStamp, status?: number): Attributes => {
    const a: Attributes = {
      "http.request.method": s.method,
      "url.template": s.route,
      "stellar.network": net,
    };
    const st = httpStatus(status);
    if (st !== undefined) a["http.response.status_code"] = st;
    return a;
  };
  const submission = (a: Attributes) =>
    ins.submissions.add(1, { "stellar.tx.via": "horizon", ...a, "stellar.network": net });

  const onRequest = (config: RequestConfig): RequestConfig => {
    safely(() => {
      const m = String(config?.method ?? "get").toUpperCase();
      carrier.put(config, {
        t0: now(),
        route: horizonRoute(config.url),
        method: m === "GET" || m === "POST" ? m : "_OTHER",
      });
    });
    return config;
  };

  const onResponse = (r: HttpResponse): HttpResponse => {
    safely(() => {
      const s = carrier.get(r?.config);
      if (!s) return;
      ins.httpDuration.record(seconds(s.t0), attrs(s, r.status));
      if (!submitRoute(s)) return;
      const b = (r.data && typeof r.data === "object" ? r.data : undefined) as
        | HorizonBody
        | undefined;
      if (s.route === "/transactions_async") {
        const status = closed(SUBMIT_STATUSES, b?.tx_status);
        const a: Attributes = { "stellar.tx.status": status };
        if (status === "ERROR") a["stellar.tx.result_class"] = failureClass(b);
        submission(a);
      } else submission({ "stellar.tx.status": "SUCCESS" });
    });
    return r;
  };

  const onError = (err: unknown): unknown => {
    safely(() => {
      const e = err as
        | { config?: unknown; response?: { status?: unknown; data?: unknown } }
        | undefined;
      const s = carrier.get(e?.config);
      if (!s) return;
      const st = typeof e?.response?.status === "number" ? e.response.status : undefined;
      ins.httpDuration.record(seconds(s.t0), {
        ...attrs(s, st),
        "error.type": transportErrorType(err),
      });
      if (!submitRoute(s) || st === undefined) return;
      const b = (
        e?.response?.data && typeof e.response.data === "object" ? e.response.data : undefined
      ) as HorizonBody | undefined;
      if (s.route === "/transactions_async" && b?.tx_status !== undefined) {
        const status = closed(SUBMIT_STATUSES, b.tx_status);
        const a: Attributes = { "stellar.tx.status": status };
        if (status === "ERROR") a["stellar.tx.result_class"] = failureClass(b);
        submission(a);
        return;
      }
      submission({ "stellar.tx.status": "FAILED", "stellar.tx.result_class": failureClass(b) });
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
