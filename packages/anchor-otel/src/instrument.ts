// SPDX-License-Identifier: Apache-2.0
// Axios interceptors that time and classify a wallet's calls to anchors, and the Wallet SDK hook that feeds them the
// anchors' server URLs. Response bodies are read for four closed values only (`status`, `kind`, a SEP-6 403 `type`,
// and the transaction `id`, which stays in a bounded in-memory map to count each lifecycle step once and is never an
// attribute). Requests to URLs that are not a registered anchor server are not observed at all.

import { type Counter, type Histogram, type Meter, metrics, ValueType } from "@opentelemetry/api";
import {
  type AnchorEvent,
  type Kind,
  kindOf,
  lifecycleOf,
  type Network,
  networkOf,
  type Outcome,
  outcomeOfError,
  outcomeOfStatus,
  type Sep,
} from "./classify.ts";
import { type DomainPolicy, type Match, Registry } from "./registry.ts";

export const SCOPE_NAME = "@usagemap/anchor-otel";
export const SCOPE_VERSION = "0.1.0";

/** Metric names (proposed wire-formats §f.5 step 4b). */
export const METRIC_REQUEST_DURATION = "stellar.anchor.request.duration";
export const METRIC_EVENTS = "stellar.anchor.events";

export const ATTR_HOME_DOMAIN = "stellar.anchor.home_domain";
export const ATTR_SEP = "stellar.sep";
export const ATTR_STEP = "stellar.anchor.step";
export const ATTR_OUTCOME = "stellar.anchor.outcome";
export const ATTR_EVENT = "stellar.anchor.event";
export const ATTR_NETWORK = "stellar.network";

/** Seconds; anchor calls include interactive back-ends and quote engines, so the top bucket is 30 s. */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Transactions remembered (per process) to count each lifecycle step of a transaction once. */
const SEEN_CAP = 10_000;
/** At most this many transactions of one `/transactions` response are inspected. */
const LIST_CAP = 200;

// ---------------------------------------------------------------------------------------------------------------------
// Structural views (no runtime dependency on axios or the Wallet SDK)

// biome-ignore lint/suspicious/noExplicitAny: matches axios' own `(error: any) => any` signature.
type Rejected = (e: any) => any;
export interface AxiosInterceptorManagerLike<V> {
  use(
    fulfilled: (v: V) => V | Promise<V>,
    rejected?: Rejected,
    options?: { synchronous?: boolean },
  ): number;
  eject(id: number): void;
}
export interface AxiosRequestConfigLike {
  url?: string | undefined;
  baseURL?: string | undefined;
  method?: string | undefined;
}
export interface AxiosResponseLike {
  status?: number | undefined;
  data?: unknown;
  config?: AxiosRequestConfigLike | undefined;
}
/** What `instrumentAnchorClient` needs from an axios instance. */
export interface AxiosLike {
  interceptors: {
    request: AxiosInterceptorManagerLike<AxiosRequestConfigLike>;
    response: AxiosInterceptorManagerLike<AxiosResponseLike>;
  };
}
/** What `instrumentAnchor` needs from a Wallet SDK `Anchor` (6.x). */
export interface AnchorLike {
  homeDomain: string;
  sep1(shouldRefresh?: boolean): Promise<unknown>;
}
/** What `instrumentWalletSdk` needs from a Wallet SDK `Wallet` (6.x). */
export interface WalletLike {
  cfg: { app: { defaultClient: unknown }; stellar?: { network?: unknown } };
  anchor(params: never): unknown;
}

export interface AnchorOtelOptions extends DomainPolicy {
  /** OTel `Meter`; default `metrics.getMeter("@usagemap/anchor-otel")` (the global provider). */
  meter?: Meter | undefined;
  /** Network name or passphrase. `instrumentWalletSdk` reads it from the wallet's configuration when absent. */
  network?: string | undefined;
}

export interface AnchorTelemetry {
  /** False when the client lacks the axios interceptor API. */
  readonly instrumented: boolean;
  /** Register an anchor's servers from its stellar.toml (raw SEP-1 keys or the Wallet SDK's `TomlInfo`). */
  register(homeDomain: string, toml: Readonly<Record<string, unknown>>): number;
  /** Instrument a Wallet SDK `Anchor` created before `instrumentWalletSdk`, or with `new Anchor(…)`. Idempotent. */
  instrumentAnchor<A extends object>(anchor: A): A;
  /** Remove the interceptors and hooks. Idempotent. */
  detach(): void;
}

// ---------------------------------------------------------------------------------------------------------------------

interface Instruments {
  duration: Histogram;
  events: Counter;
}

function makeInstruments(meter: Meter | undefined): Instruments {
  const m = meter ?? metrics.getMeter(SCOPE_NAME, SCOPE_VERSION);
  return {
    duration: m.createHistogram(METRIC_REQUEST_DURATION, {
      unit: "s",
      description: "Duration of a wallet's calls to anchors, by SEP step and outcome class",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    events: m.createCounter(METRIC_EVENTS, {
      unit: "{event}",
      valueType: ValueType.INT,
      description: "Anchor funnel events seen by the wallet, by SEP and event",
    }),
  };
}

const safely = (f: () => void): void => {
  try {
    f();
  } catch {
    /* instrumentation never breaks the call */
  }
};
const now = (): number => performance.now();

interface Stamp {
  readonly t0: number;
  readonly match: Match;
}
const STAMP = Symbol("anchor-otel.stamp");

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
/** Objects and functions (an axios instance is a callable function object). */
const isRef = (v: unknown): v is Record<string, unknown> =>
  !!v && (typeof v === "object" || typeof v === "function");

const KYC_TYPES = new Set(["non_interactive_customer_info_needed", "customer_info_status"]);
const SEP12_STATUS: Record<string, AnchorEvent> = {
  NEEDS_INFO: "customer_needs_info",
  PROCESSING: "customer_processing",
  ACCEPTED: "customer_accepted",
  REJECTED: "customer_rejected",
};

/** Funnel events implied by one classified response (or error). */
export function eventsOf(m: Match, outcome: Outcome, data: unknown): AnchorEvent[] {
  const ok = outcome === "ok";
  const d = isObj(data) ? data : undefined;
  switch (m.step) {
    case "challenge":
      return [ok ? "challenge_received" : "auth_failed"];
    case "token":
      return [ok ? "authenticated" : "auth_failed"];
    case "customer_get": {
      const e = ok && typeof d?.status === "string" ? SEP12_STATUS[d.status] : undefined;
      return e ? [e] : [];
    }
    case "customer_put":
      return ok ? ["customer_submitted"] : [];
    case "customer_delete":
      return ok ? ["customer_deleted"] : [];
    case "deposit":
    case "deposit_exchange":
    case "withdraw":
    case "withdraw_exchange": {
      const kind = m.step.startsWith("deposit") ? "deposit" : "withdraw";
      if (ok) return [`${kind}_requested`];
      if (outcome === "forbidden" && typeof d?.type === "string" && KYC_TYPES.has(d.type))
        return ["kyc_required"];
      return [`${kind}_request_failed`];
    }
    case "deposit_interactive":
      return [ok ? "deposit_interactive_started" : "deposit_request_failed"];
    case "withdraw_interactive":
      return [ok ? "withdraw_interactive_started" : "withdraw_request_failed"];
    case "transaction_create":
      return [ok ? "receive_requested" : "receive_request_failed"];
    case "prices":
    case "price":
      return ok ? ["price_quoted"] : [];
    case "quote_create":
      return [ok ? "quote_created" : "quote_failed"];
    default:
      return [];
  }
}

/** The transactions carried by a `/transaction(s)` response, as `{ id, kind, status }` (unknown parts dropped). */
function transactionsOf(m: Match, data: unknown): { id: string; kind: Kind; status: unknown }[] {
  if (!isObj(data)) return [];
  let list: unknown[] = [];
  if (m.step === "transactions" && Array.isArray(data.transactions))
    list = data.transactions.slice(0, LIST_CAP);
  else if (m.step === "transaction" && isObj(data.transaction)) list = [data.transaction];
  const out: { id: string; kind: Kind; status: unknown }[] = [];
  for (const t of list) {
    if (!isObj(t) || typeof t.id !== "string" || t.id.length === 0 || t.id.length > 256) continue;
    const kind = m.sep === "31" ? "receive" : kindOf(t.kind);
    if (kind) out.push({ id: t.id, kind, status: t.status });
  }
  return out;
}

class Telemetry implements AnchorTelemetry {
  readonly instrumented: boolean;
  readonly registry: Registry;
  readonly #inst: Instruments;
  readonly #network: Network;
  readonly #seen = new Map<string, string>();
  readonly #client: AxiosLike | undefined;
  #ids: [number, number] | undefined;
  readonly #anchors = new WeakSet<object>();
  readonly #undo: (() => void)[] = [];
  #detached = false;

  constructor(client: unknown, opts: AnchorOtelOptions) {
    this.registry = new Registry(opts);
    this.#inst = makeInstruments(opts.meter);
    this.#network = networkOf(opts.network);
    this.#client = isAxiosLike(client) ? client : undefined;
    this.instrumented = this.#client !== undefined;
    if (this.#client) {
      const req = this.#client.interceptors.request.use(
        (config) => {
          safely(() => this.#onRequest(config));
          return config;
        },
        undefined,
        { synchronous: true },
      );
      const res = this.#client.interceptors.response.use(
        (response) => {
          safely(() => this.#onResponse(response));
          return response;
        },
        (error: unknown) => {
          safely(() => this.#onError(error));
          return Promise.reject(error);
        },
      );
      this.#ids = [req, res];
    }
  }

  register(homeDomain: string, toml: Readonly<Record<string, unknown>>): number {
    return this.registry.register(homeDomain, toml);
  }

  instrumentAnchor<A extends object>(target: A): A {
    if (this.#detached || !isObj(target) || this.#anchors.has(target)) return target;
    const anchor = target as unknown as AnchorLike;
    if (typeof anchor.sep1 !== "function" || typeof anchor.homeDomain !== "string") return target;
    this.#anchors.add(anchor);
    const hadOwn = Object.hasOwn(anchor, "sep1");
    const original = anchor.sep1;
    const self = this;
    const wrapped = async function sep1(this: unknown, shouldRefresh?: boolean): Promise<unknown> {
      // The Wallet SDK caches the TOML in the anchor's `toml` field; a cached read is not a request.
      const cached = !shouldRefresh && (anchor as unknown as { toml?: unknown }).toml !== undefined;
      if (cached || self.#detached) return original.call(anchor, shouldRefresh);
      const t0 = now();
      try {
        const info = await original.call(anchor, shouldRefresh);
        safely(() => {
          if (isObj(info)) self.registry.register(anchor.homeDomain, info);
          self.#recordToml(anchor.homeDomain, t0, "ok");
        });
        return info;
      } catch (e) {
        safely(() => self.#recordToml(anchor.homeDomain, t0, outcomeOfError(e)));
        throw e;
      }
    };
    anchor.sep1 = wrapped;
    this.#undo.push(() => {
      if (anchor.sep1 !== wrapped) return;
      if (hadOwn) anchor.sep1 = original;
      else delete (anchor as { sep1?: unknown }).sep1;
    });
    return target;
  }

  /** Hook a Wallet SDK wallet's `anchor()` factory so every anchor it creates is instrumented. */
  hookWallet(wallet: WalletLike): void {
    const hadOwn = Object.hasOwn(wallet, "anchor");
    const original = wallet.anchor;
    const self = this;
    const wrapped = function anchor(this: unknown, params: never): unknown {
      const a = original.call(wallet, params);
      return self.#detached || !isObj(a) ? a : self.instrumentAnchor(a);
    };
    wallet.anchor = wrapped;
    this.#undo.push(() => {
      if (wallet.anchor !== wrapped) return;
      if (hadOwn) wallet.anchor = original;
      else delete (wallet as { anchor?: unknown }).anchor;
    });
  }

  detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    if (this.#client && this.#ids) {
      safely(() => this.#client?.interceptors.request.eject(this.#ids?.[0] as number));
      safely(() => this.#client?.interceptors.response.eject(this.#ids?.[1] as number));
    }
    for (const u of this.#undo.splice(0)) safely(u);
    this.#seen.clear();
    clients.delete(this.#client as object);
  }

  #attrs(domain: string, sep: Sep): Record<string, string> {
    return { [ATTR_HOME_DOMAIN]: domain, [ATTR_SEP]: sep, [ATTR_NETWORK]: this.#network };
  }

  #recordToml(homeDomain: string, t0: number, outcome: Outcome): void {
    const a = this.#attrs(this.registry.domain(homeDomain), "1");
    this.#inst.duration.record(Math.max(0, (now() - t0) / 1000), {
      ...a,
      [ATTR_STEP]: "toml",
      [ATTR_OUTCOME]: outcome,
    });
    this.#inst.events.add(1, {
      ...a,
      [ATTR_EVENT]: outcome === "ok" ? "toml_resolved" : "toml_failed",
    });
  }

  #onRequest(config: AxiosRequestConfigLike): void {
    if (this.#detached || this.registry.size === 0) return;
    const url = resolveUrl(config);
    if (!url) return;
    const match = this.registry.match(config.method ?? "GET", url);
    if (!match) return;
    (config as Record<symbol, Stamp>)[STAMP] = { t0: now(), match };
  }

  #stampOf(config: unknown): Stamp | undefined {
    return isObj(config)
      ? ((config as Record<symbol, Stamp | undefined>)[STAMP] ?? undefined)
      : undefined;
  }

  #onResponse(response: AxiosResponseLike): void {
    const s = this.#stampOf(response?.config);
    if (!s || this.#detached) return;
    const outcome = typeof response.status === "number" ? outcomeOfStatus(response.status) : "ok";
    this.#record(s, outcome, response.data);
  }

  #onError(error: unknown): void {
    if (this.#detached || !isObj(error)) return;
    const s = this.#stampOf(error.config);
    if (!s) return;
    const resp = isObj(error.response) ? error.response : undefined;
    this.#record(s, outcomeOfError(error), resp?.data);
  }

  #record(s: Stamp, outcome: Outcome, data: unknown): void {
    const { match } = s;
    const a = this.#attrs(match.domain, match.sep);
    this.#inst.duration.record(Math.max(0, (now() - s.t0) / 1000), {
      ...a,
      [ATTR_STEP]: match.step,
      [ATTR_OUTCOME]: outcome,
    });
    for (const e of eventsOf(match, outcome, data))
      this.#inst.events.add(1, { ...a, [ATTR_EVENT]: e });
    if (outcome !== "ok") return;
    for (const t of transactionsOf(match, data)) {
      const life = lifecycleOf(t.status);
      if (!life) continue;
      const key = `${match.domain}\u0000${match.sep}\u0000${t.id}`;
      if (this.#seen.get(key) === life) continue;
      this.#seen.delete(key);
      this.#seen.set(key, life);
      if (this.#seen.size > SEEN_CAP) this.#seen.delete(this.#seen.keys().next().value as string);
      this.#inst.events.add(1, { ...a, [ATTR_EVENT]: `${t.kind}_${life}` as AnchorEvent });
    }
  }
}

function isAxiosLike(c: unknown): c is AxiosLike {
  if (!isRef(c) || !isObj(c.interceptors)) return false;
  const { request, response } = c.interceptors as Record<string, unknown>;
  return (
    isObj(request) &&
    isObj(response) &&
    typeof request.use === "function" &&
    typeof request.eject === "function" &&
    typeof response.use === "function" &&
    typeof response.eject === "function"
  );
}

function resolveUrl(config: AxiosRequestConfigLike): string | undefined {
  const url = config.url ?? "";
  if (/^https?:\/\//i.test(url)) return url;
  if (!config.baseURL) return undefined;
  return `${config.baseURL.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

const clients = new WeakMap<object, Telemetry>();

function telemetryFor(client: unknown, opts: AnchorOtelOptions): Telemetry {
  if (isRef(client)) {
    const hit = clients.get(client);
    if (hit) return hit;
  }
  const t = new Telemetry(client, opts);
  if (isRef(client) && t.instrumented) clients.set(client, t);
  return t;
}

/**
 * Instrument an axios instance used for anchor calls. Register each anchor's servers with `register(homeDomain, toml)`
 * (e.g. for SEP-31 sends, which the Wallet SDK does not implement). Calling it again for the same instance returns
 * the existing instrumentation.
 */
export function instrumentAnchorClient(
  client: object,
  opts: AnchorOtelOptions = {},
): AnchorTelemetry {
  return telemetryFor(client, opts);
}

/**
 * Instrument a Wallet SDK (`@stellar/typescript-wallet-sdk` 6.x) `Wallet`: its shared axios client
 * (`cfg.app.defaultClient`, used for SEP-6/10/12/24/38) and every `Anchor` created by `wallet.anchor()` from now on
 * (SEP-1, which the SDK resolves through js-stellar-sdk rather than that client, is timed around `anchor.sep1()`).
 */
export function instrumentWalletSdk(target: object, opts: AnchorOtelOptions = {}): AnchorTelemetry {
  // `Wallet.cfg` is private in the SDK's typings, so the parameter is structural at run time only.
  const wallet = target as WalletLike;
  const client = wallet?.cfg?.app?.defaultClient;
  const network = opts.network ?? (wallet?.cfg?.stellar?.network as string | undefined);
  const existing = isRef(client) ? clients.get(client) : undefined;
  if (existing) return existing;
  const t = telemetryFor(client, { ...opts, network });
  if (t.instrumented && typeof wallet.anchor === "function") t.hookWallet(wallet);
  return t;
}
