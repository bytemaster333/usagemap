// SPDX-License-Identifier: Apache-2.0
// Shared pieces of the RPC and Horizon instrumentation: the structural view of js-stellar-sdk's HttpClient, the
// per-request stamp, the meter and the instruments.

import { type Counter, type Histogram, type Meter, metrics, ValueType } from "@opentelemetry/api";

/** Instrumentation scope name and version of every instrument this package creates. */
export const SCOPE_NAME = "@usagemap/stellar-otel";
export const SCOPE_VERSION = "0.1.0";

/** Metric names (wire-formats §f.5 step 4a). */
export const METRIC_RPC_DURATION = "rpc.client.call.duration";
export const METRIC_HTTP_DURATION = "http.client.request.duration";
export const METRIC_SUBMISSIONS = "stellar.tx.submissions";
export const METRIC_POLLS = "stellar.tx.polls";
export const METRIC_SIMULATIONS = "stellar.tx.simulations";

/** Histogram bucket boundaries in seconds (semantic-conventions advice for durations, plus 30 s for slow RPCs). */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/**
 * Minimal structural view of js-stellar-sdk's `HttpClient` interceptor managers. The same shape in every supported
 * major (13.x to 17.x; axios and fetch flavours): `use(fulfilled, rejected) → id` and `eject(id)`.
 */
export interface InterceptorManager<V> {
  // biome-ignore lint/suspicious/noExplicitAny: matches the SDK's own `(error: any) => any` signature.
  use(fulfilled: (v: V) => V | Promise<V>, rejected?: (e: any) => any): number;
  eject(id: number): void;
}
export interface RequestConfig {
  url?: string | undefined;
  method?: string | undefined;
  data?: unknown;
}
export interface HttpResponse {
  data?: unknown;
  status?: number | undefined;
  config?: RequestConfig | undefined;
}
export interface HttpClientLike {
  interceptors?:
    | {
        request?: InterceptorManager<RequestConfig> | undefined;
        response?: InterceptorManager<HttpResponse> | undefined;
      }
    | undefined;
}
/**
 * What `instrumentStellarRpc` / `instrumentHorizon` accept:
 * - an `rpc.Server` / `Horizon.Server` with its own `httpClient` (js-stellar-sdk 14.3.1 and later, 15, 16, 17), or
 * - the SDK's `rpc` / `Horizon` namespace with the module-wide `AxiosClient` that every server of that SDK copy
 *   shares (js-stellar-sdk 13.x and 14.0.0 to 14.3.0, where servers have no `httpClient` of their own).
 */
export interface ServerLike {
  readonly httpClient?: HttpClientLike | undefined;
  readonly AxiosClient?: HttpClientLike | undefined;
}

export interface InstrumentOptions {
  /** OTel `Meter` to record with; default `metrics.getMeter("@usagemap/stellar-otel")` (the global provider). */
  meter?: Meter;
  /**
   * Network name (`mainnet`, `testnet`, `futurenet`, `local`) or passphrase, when known up front. Otherwise the RPC
   * instrumentation learns it from a `getNetwork` response; Horizon stays `unknown`.
   */
  network?: string;
}

/** Returned by both functions. `instrumented` is false when the server lacks the public interceptor API. */
export interface Instrumentation {
  readonly instrumented: boolean;
  /**
   * `server`: this server's own client (SDK ≥ 14.3.1). `module`: the SDK copy's module-wide client (SDK 13.x to
   * 14.3.0), so every server created from that copy is covered. Absent when not instrumented.
   */
  readonly scope?: "server" | "module";
  /** Why the server was not instrumented (`no_interceptors`), when `instrumented` is false. */
  readonly reason?: "no_interceptors";
  /** Remove the interceptors. Idempotent. */
  detach(): void;
}

export const NOT_INSTRUMENTED: Instrumentation = Object.freeze({
  instrumented: false,
  reason: "no_interceptors" as const,
  detach() {},
});

export interface Hook {
  readonly hc: object;
  readonly req: InterceptorManager<RequestConfig>;
  readonly res: InterceptorManager<HttpResponse>;
  readonly scope: "server" | "module";
}
const managers = (c: HttpClientLike | undefined) => {
  const req = c?.interceptors?.request;
  const res = c?.interceptors?.response;
  return typeof req?.use === "function" &&
    typeof req.eject === "function" &&
    typeof res?.use === "function" &&
    typeof res.eject === "function"
    ? { req, res }
    : undefined;
};
/**
 * Find the interceptor managers: the server's own `httpClient` first, then a namespace's module-wide `AxiosClient`.
 * Reading the properties never throws out (a hostile getter is contained); anything else is "not instrumentable".
 */
export function hookOf(target: ServerLike | null | undefined): Hook | undefined {
  try {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return undefined;
    const own = target.httpClient;
    const m = managers(own);
    if (own && m) return { hc: own, ...m, scope: "server" };
    if (own !== undefined) return undefined;
    const mod = target.AxiosClient;
    const mm = managers(mod);
    if (mod && mm) return { hc: mod, ...mm, scope: "module" };
  } catch {
    /* not instrumentable */
  }
  return undefined;
}

export interface Stamp {
  readonly t0: number;
}

/**
 * Carries a request's stamp from the request interceptor to the response/error interceptor. The 17.x fetch client
 * copies the config with object spread (Symbol-keyed own properties survive); the axios flavour passes the same
 * object through (the WeakMap finds it). Both are tried.
 */
export class StampCarrier<S extends Stamp> {
  readonly #sym: symbol;
  readonly #map = new WeakMap<object, S>();
  constructor(name: string) {
    this.#sym = Symbol(name);
  }
  put(config: RequestConfig, s: S): void {
    try {
      (config as Record<symbol, unknown>)[this.#sym] = s;
    } catch {
      /* frozen config: the WeakMap still works */
    }
    this.#map.set(config, s);
  }
  get(config: unknown): S | undefined {
    if (!config || typeof config !== "object") return undefined;
    return (
      ((config as Record<symbol, S | undefined>)[this.#sym] as S | undefined) ??
      this.#map.get(config)
    );
  }
}

export const now = (): number => performance.now();
export const seconds = (t0: number): number => Math.max(0, (now() - t0) / 1000);

export interface Instruments {
  rpcDuration: Histogram;
  httpDuration: Histogram;
  submissions: Counter;
  polls: Counter;
  simulations: Counter;
}

const cache = new WeakMap<Meter, Instruments>();
export function instruments(meter: Meter | undefined): Instruments {
  const m = meter ?? metrics.getMeter(SCOPE_NAME, SCOPE_VERSION);
  const hit = cache.get(m);
  if (hit) return hit;
  const advice = { explicitBucketBoundaries: DURATION_BUCKETS };
  const made: Instruments = {
    rpcDuration: m.createHistogram(METRIC_RPC_DURATION, {
      unit: "s",
      description: "Duration of outbound Stellar RPC calls, by JSON-RPC method",
      advice,
    }),
    httpDuration: m.createHistogram(METRIC_HTTP_DURATION, {
      unit: "s",
      description: "Duration of outbound Horizon requests, by route template",
      advice,
    }),
    submissions: m.createCounter(METRIC_SUBMISSIONS, {
      unit: "{transaction}",
      valueType: ValueType.INT,
      description: "Transaction submissions by status class",
    }),
    polls: m.createCounter(METRIC_POLLS, {
      unit: "{call}",
      valueType: ValueType.INT,
      description: "getTransaction results by status class",
    }),
    simulations: m.createCounter(METRIC_SIMULATIONS, {
      unit: "{call}",
      valueType: ValueType.INT,
      description: "simulateTransaction results by outcome class",
    }),
  };
  cache.set(m, made);
  return made;
}

/** Run instrumentation code; it must never break or alter the caller's request. */
export const safely = (f: () => void): void => {
  try {
    f();
  } catch {
    /* instrumentation never breaks the call */
  }
};
