// SPDX-License-Identifier: Apache-2.0
// `@usagemap/partner-otel` — OpenTelemetry metric for a backend's outbound calls to SCF Integration List partner
// APIs (Soroswap, DeFindex, Trustless Work, ramps, bridges …): latency, operation template and outcome class.
//
//   import { partnerFetch } from "@usagemap/partner-otel";
//   const fetch = partnerFetch();                       // wraps globalThis.fetch
//   await fetch("https://api.soroswap.finance/quote?network=testnet", { method: "POST", body });
//
//   import { instrumentPartnerAxios } from "@usagemap/partner-otel";
//   instrumentPartnerAxios(axios.create({ baseURL: "https://api.bridge.xyz/v0" }));
//
// Emits `stellar.partner.call.duration` (s) with `stellar.partner`, `stellar.partner.operation`,
// `stellar.partner.outcome` and `stellar.network`, all closed sets. Calls to any other host are passed through
// untouched and not measured. Never recorded: the URL, query string, ids in the path, headers (API keys), bodies,
// amounts, addresses. Uses the application's own MeterProvider through `@opentelemetry/api` (peer dependency).

import { type Attributes, type Histogram, type Meter, metrics } from "@opentelemetry/api";
import {
  type CallClass,
  classifyUrl,
  type Outcome,
  outcomeOfError,
  outcomeOfStatus,
} from "./classify.ts";

export type { CallClass, Network, Outcome } from "./classify.ts";
export {
  classifyUrl,
  NETWORKS,
  OUTCOMES,
  operationOf,
  outcomeOfError,
  outcomeOfStatus,
  partnerOfHost,
} from "./classify.ts";
export type { Partner } from "./partners.ts";
export { PARTNER_IDS, PARTNERS } from "./partners.ts";

export const SCOPE_NAME = "@usagemap/partner-otel";
export const SCOPE_VERSION = "0.1.0";
/** Metric name (wire-formats §f.5 step 4b). */
export const METRIC_PARTNER_DURATION = "stellar.partner.call.duration";
/** Histogram bucket boundaries in seconds (the same as @usagemap/stellar-otel). */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export interface PartnerOptions {
  /** OTel `Meter`; default `metrics.getMeter("@usagemap/partner-otel")` (the global provider). */
  meter?: Meter;
  /**
   * Stellar network the calls serve (name or passphrase). Default: the partner host's environment (production host →
   * `mainnet`, sandbox host → `testnet`; Soroswap and DeFindex: their `network` query parameter), else `unknown`.
   */
  network?: string;
  /**
   * Force the partner (one of `PARTNER_IDS`) for every call through this wrapper: for a partner API behind your own
   * proxy or custom domain. A value outside the list disables measurement.
   */
  partner?: string;
}

const cache = new WeakMap<Meter, Histogram>();
function histogram(meter: Meter | undefined): Histogram {
  const m = meter ?? metrics.getMeter(SCOPE_NAME, SCOPE_VERSION);
  let h = cache.get(m);
  if (!h) {
    h = m.createHistogram(METRIC_PARTNER_DURATION, {
      unit: "s",
      description:
        "Duration of outbound calls to SCF Integration List partner APIs, by operation template",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    });
    cache.set(m, h);
  }
  return h;
}

const attrs = (c: CallClass, outcome: Outcome): Attributes => ({
  "stellar.partner": c.partner,
  "stellar.partner.operation": c.operation,
  "stellar.partner.outcome": outcome,
  "stellar.network": c.network,
});

const now = (): number => performance.now();
const seconds = (t0: number): number => Math.max(0, (now() - t0) / 1000);
const safely = (f: () => void): void => {
  try {
    f();
  } catch {
    /* instrumentation never breaks the call */
  }
};

/**
 * Record one partner call measured by your own code (any HTTP client): `status` when an HTTP answer arrived, else
 * `error` (a timeout or network failure). Returns false when the URL is not a partner API (nothing recorded).
 */
export function recordPartnerCall(
  call: { url: string | URL; durationSeconds: number; status?: number; error?: unknown },
  opts: PartnerOptions = {},
): boolean {
  let done = false;
  safely(() => {
    const c = classifyUrl(call.url, opts);
    if (!c || !Number.isFinite(call.durationSeconds)) return;
    const outcome =
      call.status !== undefined ? outcomeOfStatus(call.status) : outcomeOfError(call.error);
    histogram(opts.meter).record(Math.max(0, call.durationSeconds), attrs(c, outcome));
    done = true;
  });
  return done;
}

const urlOf = (input: unknown): string | undefined => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const u = (input as { url?: unknown } | null | undefined)?.url;
  return typeof u === "string" ? u : undefined;
};

/**
 * Wrap a `fetch` implementation (default `globalThis.fetch`). The returned function has the same signature and
 * returns the same response or rejection; it reads only the request URL, the response status and the error class.
 */
export function partnerFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
  opts: PartnerOptions = {},
): typeof fetch {
  const h = histogram(opts.meter);
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    let c: CallClass | undefined;
    safely(() => {
      const u = urlOf(input);
      c = u === undefined ? undefined : classifyUrl(u, opts);
    });
    if (!c) return fetchImpl(input, init);
    const cls = c;
    const t0 = now();
    let res: Response;
    try {
      res = await fetchImpl(input, init);
    } catch (err) {
      safely(() => h.record(seconds(t0), attrs(cls, outcomeOfError(err))));
      throw err;
    }
    safely(() => h.record(seconds(t0), attrs(cls, outcomeOfStatus(res.status))));
    return res;
  };
  return wrapped as typeof fetch;
}

/** Minimal structural view of an axios instance's interceptor managers (axios 1.x). */
export interface AxiosLike {
  interceptors: {
    // biome-ignore lint/suspicious/noExplicitAny: matches axios' own `(error: any) => any` signature.
    request: { use(f: (c: any) => any, r?: (e: any) => any): number; eject(id: number): void };
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    response: { use(f: (r: any) => any, r?: (e: any) => any): number; eject(id: number): void };
  };
}
export interface Instrumentation {
  readonly instrumented: boolean;
  /** Remove the interceptors. Idempotent. */
  detach(): void;
}

interface Stamp {
  readonly t0: number;
  readonly c: CallClass;
}
interface AxiosConfig {
  url?: unknown;
  baseURL?: unknown;
}

/**
 * Instrument an axios instance (axios 1.x) through its public interceptors. Requests to partner hosts (resolved
 * against `baseURL`) are timed; everything else passes untouched. Idempotent per instance.
 */
export function instrumentPartnerAxios(
  instance: AxiosLike,
  opts: PartnerOptions = {},
): Instrumentation {
  const req = instance?.interceptors?.request;
  const res = instance?.interceptors?.response;
  if (typeof req?.use !== "function" || typeof res?.use !== "function")
    return { instrumented: false, detach() {} };
  const prev = attached.get(instance);
  if (prev) return prev;
  const h = histogram(opts.meter);
  const sym = Symbol("scf.partner-otel");
  const stamps = new WeakMap<object, Stamp>();
  const put = (cfg: object, s: Stamp) => {
    try {
      (cfg as Record<symbol, unknown>)[sym] = s;
    } catch {
      /* frozen config: the WeakMap still works */
    }
    stamps.set(cfg, s);
  };
  const get = (cfg: unknown): Stamp | undefined =>
    cfg && typeof cfg === "object"
      ? ((cfg as Record<symbol, Stamp | undefined>)[sym] ?? stamps.get(cfg))
      : undefined;

  const reqId = req.use((cfg: AxiosConfig) => {
    safely(() => {
      const rel = typeof cfg?.url === "string" ? cfg.url : "";
      const base = typeof cfg?.baseURL === "string" ? cfg.baseURL : undefined;
      // axios joins baseURL and a relative url by concatenation (combineURLs), not by URL resolution.
      const full =
        base && !/^[a-z][a-z\d+.-]*:/i.test(rel)
          ? `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`
          : rel;
      const c = classifyUrl(full, opts);
      if (c) put(cfg as object, { t0: now(), c });
    });
    return cfg;
  });
  const resId = res.use(
    (r: { config?: unknown; status?: unknown }) => {
      safely(() => {
        const s = get(r?.config);
        if (s) h.record(seconds(s.t0), attrs(s.c, outcomeOfStatus(r.status)));
      });
      return r;
    },
    (err: { config?: unknown; response?: { status?: unknown } }) => {
      safely(() => {
        const s = get(err?.config);
        if (!s) return;
        const st = err?.response?.status;
        h.record(
          seconds(s.t0),
          attrs(s.c, st !== undefined ? outcomeOfStatus(st) : outcomeOfError(err)),
        );
      });
      return Promise.reject(err);
    },
  );
  let done = false;
  const handle: Instrumentation = {
    instrumented: true,
    detach() {
      if (done) return;
      done = true;
      req.eject(reqId);
      res.eject(resId);
      attached.delete(instance);
    },
  };
  attached.set(instance, handle);
  return handle;
}
const attached = new WeakMap<object, Instrumentation>();
