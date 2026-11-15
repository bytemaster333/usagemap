// SPDX-License-Identifier: Apache-2.0
// `@usagemap/tracker/stellar-rpc` — browser-side Stellar RPC / Horizon telemetry, AGGREGATE ONLY
// (wire-formats §a.3.2).
//
//   import { rpc, Horizon } from "@stellar/stellar-sdk";
//   import { attachRpcTelemetry, attachHorizonTelemetry } from "@usagemap/tracker/stellar-rpc";
//   const server = new rpc.Server("https://soroban-testnet.stellar.org");
//   attachRpcTelemetry(server, { network: "testnet" });          // js-stellar-sdk 14.3.1 … 17.x: the server
//   attachRpcTelemetry(rpc);                                      // 13.x … 14.3.0: the module-wide client
//
// It hooks the SDK's public `httpClient.interceptors` (the same point as `@usagemap/stellar-otel` on the server,
// read at js-stellar-sdk 13.3.0, 14.1.0, 14.6.1, 15.1.0, 16.4.1 and 17.4.0) and keeps, IN MEMORY, one count per cell
// `[api, operation, network, outcome, latency bucket]`:
//   - api: `rpc` | `horizon`; operation: the JSON-RPC method or the Horizon route template (closed lists below,
//     anything else `other`); network: closed list; outcome: `ok`, `rpc_error`, `http_4xx`, `http_429`, `http_5xx`,
//     `timeout`, `network_error`; latency: `lt100ms`, `100_500ms`, `500_2000ms`, `gt2000ms`.
// When the page is hidden (or the UTC day changes) the cells are handed to the running tracker as ONE aggregate event
// (`stellar_rpc`) and cleared. The gateway stores it only as per-site daily totals (`web_rpc_client_daily`), never as
// a visitor event: it has no visitor key, no session, no per-call time or order, and its page path is not stored.
//
// Never read: the RPC/Horizon URL beyond its route template (paid providers put API keys in it), query strings,
// request params, transaction hashes, XDR, addresses, ledger keys, error text. Without a running tracker, or while
// tracking is blocked (GPC, DNT, opt-out, no consent), the aggregate is discarded.

type AnyRecord = Record<string, unknown>;

interface InterceptorManager {
  use(fulfilled: (v: unknown) => unknown, rejected?: (e: unknown) => unknown): number;
  eject(id: number): void;
}
interface HttpClientLike {
  interceptors?: { request?: InterceptorManager; response?: InterceptorManager } | undefined;
}
/** An `rpc.Server` / `Horizon.Server` (SDK ≥ 14.3.1) or the `rpc` / `Horizon` namespace (SDK 13.x – 14.3.0). */
export interface ServerLike {
  readonly httpClient?: HttpClientLike | undefined;
  readonly AxiosClient?: HttpClientLike | undefined;
}

export interface TelemetryOptions {
  /** `mainnet`, `testnet`, `futurenet`, `local` or a passphrase; RPC otherwise learns it from `getNetwork`. */
  network?: string;
}

export interface Telemetry {
  readonly attached: boolean;
  /** Remove the interceptors (the counts already kept stay until the next flush). Idempotent. */
  detach(): void;
}

export type Network = "mainnet" | "testnet" | "futurenet" | "local" | "unknown";
export type Outcome =
  | "ok"
  | "rpc_error"
  | "http_4xx"
  | "http_429"
  | "http_5xx"
  | "timeout"
  | "network_error";
export type Latency = "lt100ms" | "100_500ms" | "500_2000ms" | "gt2000ms";

/** Stellar RPC methods (js-stellar-sdk 17.4.0 `src/rpc/server.ts`) → operation. */
export const RPC_OPERATIONS: Readonly<Record<string, string>> = {
  getHealth: "get_health",
  getNetwork: "get_network",
  getLatestLedger: "get_latest_ledger",
  getLedgers: "get_ledgers",
  getLedgerEntries: "get_ledger_entries",
  getEvents: "get_events",
  getFeeStats: "get_fee_stats",
  getVersionInfo: "get_version_info",
  getTransaction: "get_transaction",
  getTransactions: "get_transactions",
  simulateTransaction: "simulate_transaction",
  sendTransaction: "send_transaction",
  queryEvents: "query_events",
};

/** Horizon route templates (the closed list of `@usagemap/stellar-otel`); operation = template in snake case. */
export const HORIZON_TEMPLATES = [
  "/",
  "/accounts",
  "/accounts/{id}",
  "/accounts/{id}/data/{key}",
  "/accounts/{id}/effects",
  "/accounts/{id}/offers",
  "/accounts/{id}/operations",
  "/accounts/{id}/payments",
  "/accounts/{id}/trades",
  "/accounts/{id}/transactions",
  "/assets",
  "/claimable_balances",
  "/claimable_balances/{id}",
  "/claimable_balances/{id}/operations",
  "/claimable_balances/{id}/transactions",
  "/effects",
  "/fee_stats",
  "/friendbot",
  "/health",
  "/ledgers",
  "/ledgers/{id}",
  "/ledgers/{id}/effects",
  "/ledgers/{id}/operations",
  "/ledgers/{id}/payments",
  "/ledgers/{id}/transactions",
  "/liquidity_pools",
  "/liquidity_pools/{id}",
  "/liquidity_pools/{id}/effects",
  "/liquidity_pools/{id}/operations",
  "/liquidity_pools/{id}/trades",
  "/liquidity_pools/{id}/transactions",
  "/offers",
  "/offers/{id}",
  "/offers/{id}/trades",
  "/operations",
  "/operations/{id}",
  "/operations/{id}/effects",
  "/order_book",
  "/paths",
  "/paths/strict-receive",
  "/paths/strict-send",
  "/payments",
  "/trade_aggregations",
  "/trades",
  "/transactions",
  "/transactions/{id}",
  "/transactions/{id}/effects",
  "/transactions/{id}/operations",
  "/transactions/{id}/payments",
  "/transactions_async",
] as const;

/** `/accounts/{id}/data/{key}` → `accounts_id_data_key`; `/` → `root`. */
export const templateOperation = (t: string): string =>
  t === "/" ? "root" : t.slice(1).replace(/[{}]/g, "").replace(/[/-]/g, "_");

const TEMPLATES: ReadonlySet<string> = new Set(HORIZON_TEMPLATES);
const COLLECTIONS: ReadonlySet<string> = new Set(
  HORIZON_TEMPLATES.map((t) => t.split("/")[1]).filter((s): s is string => !!s),
);

const templateOf = (seg: readonly string[]): string | undefined => {
  if (seg.length === 0) return "/";
  const [a, b, c, d] = seg;
  if (!a || !COLLECTIONS.has(a) || seg.length > 4) return undefined;
  const parts = [a];
  if (b !== undefined)
    parts.push(a === "paths" && (b === "strict-receive" || b === "strict-send") ? b : "{id}");
  if (c !== undefined) parts.push(c);
  if (d !== undefined) parts.push(c === "data" ? "{key}" : d);
  const t = `/${parts.join("/")}`;
  return TEMPLATES.has(t) ? t : undefined;
};

/**
 * A Horizon request URL → operation. A base path in front of the routes (paid providers put API keys there) is
 * skipped: the first suffix of the path that is a known template wins, so the prefix is never kept.
 */
export function horizonOperation(url: unknown): string {
  let seg: string[];
  try {
    seg = new URL(String(url), "http://h.invalid").pathname.split("/").filter(Boolean);
  } catch {
    return "other";
  }
  if (seg.length > 16) return "other";
  for (let i = 0; i <= seg.length; i++) {
    const rest = seg.slice(i);
    if (rest.length === 0 && i > 0) break;
    const t = templateOf(rest);
    if (t) return templateOperation(t);
  }
  return "other";
}

const PASSPHRASES: Readonly<Record<string, Network>> = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Test SDF Future Network ; October 2022": "futurenet",
  "Standalone Network ; February 2017": "local",
};
const networkOf = (p: unknown): Network =>
  typeof p !== "string"
    ? "unknown"
    : (PASSPHRASES[p] ??
      (["mainnet", "testnet", "futurenet", "local"].includes(p) ? (p as Network) : "unknown"));

export const latency = (ms: number): Latency =>
  ms < 100 ? "lt100ms" : ms < 500 ? "100_500ms" : ms < 2000 ? "500_2000ms" : "gt2000ms";

/** Outcome of a failed request (transport level): HTTP status class, `timeout` or `network_error`. */
export function failureOutcome(err: unknown): Outcome {
  const e = err as { response?: { status?: unknown }; code?: unknown; name?: unknown } | null;
  const status = e?.response?.status;
  if (typeof status === "number") {
    if (status === 429) return "http_429";
    if (status >= 500) return "http_5xx";
    if (status >= 400) return "http_4xx";
  }
  if (
    e?.code === "ECONNABORTED" ||
    e?.code === "ETIMEDOUT" ||
    e?.name === "TimeoutError" ||
    e?.name === "AbortError"
  )
    return "timeout";
  return "network_error";
}

// ---- the in-memory aggregate ----

/**
 * At most this many cells per aggregate (it must fit the 8 KiB batch, §a.1). The last `OTHER_RESERVE` are kept for
 * `other` cells: once the named cells reach `MAX_CELLS - OTHER_RESERVE`, a new operation is counted as `other`, and
 * a call that fits no cell at all is not counted.
 */
export const MAX_CELLS = 100;
const OTHER_RESERVE = 10;
const MAX_COUNT = 1_000_000;

const counts = new Map<string, number>();
let day: string | undefined;
let listening = false;

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** Count one call. Exposed for tests and for apps with their own HTTP layer; every value must be closed already. */
export function countCall(
  api: "rpc" | "horizon",
  operation: string,
  network: Network,
  outcome: Outcome,
  ms: number,
): void {
  const d = utcDay();
  if (day !== undefined && day !== d) flushRpcTelemetry();
  day = d;
  const lat = latency(ms);
  let k = `${api}|${operation}|${network}|${outcome}|${lat}`;
  if (!counts.has(k) && counts.size >= MAX_CELLS - OTHER_RESERVE) {
    k = `${api}|other|${network}|${outcome}|${lat}`;
    if (!counts.has(k) && counts.size >= MAX_CELLS) return;
  }
  counts.set(k, Math.min((counts.get(k) ?? 0) + 1, MAX_COUNT));
  listen();
}

function listen(): void {
  if (listening || typeof addEventListener !== "function") return;
  listening = true;
  addEventListener("pagehide", flushRpcTelemetry);
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushRpcTelemetry();
    });
}

/** The cells currently held, sorted (tests and debugging). */
export function rpcTelemetryCells(): [string, string, string, string, string, number][] {
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, n]) => [...(k.split("|") as [string, string, string, string, string]), n]);
}

interface TrackerLike {
  stellar?: (name: string, fields?: Record<string, unknown>) => boolean;
}

/**
 * Hand the cells to the running tracker as one `stellar_rpc` aggregate and clear them (called on page hide and on a
 * UTC day change; apps may call it, e.g. before a full-page navigation). Returns whether the tracker took it. The
 * cells are cleared either way: nothing is kept for a later page or sent twice.
 */
export function flushRpcTelemetry(): boolean {
  if (counts.size === 0) return false;
  const c = rpcTelemetryCells();
  counts.clear();
  day = undefined;
  const t =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as Record<symbol, TrackerLike | undefined>)[Symbol.for("scf.tracker")];
  return t?.stellar?.("stellar_rpc", { c }) ?? false;
}

// ---- the SDK hook ----

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

function hookOf(target: ServerLike | null | undefined) {
  try {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return undefined;
    const own = target.httpClient;
    if (own !== undefined) {
      const m = managers(own);
      return m && { hc: own as object, ...m };
    }
    const mod = target.AxiosClient;
    const mm = managers(mod);
    if (mod && mm) return { hc: mod as object, ...mm };
  } catch {}
  return undefined;
}

interface Stamp {
  t0: number;
  op: string;
}

/** Carries a request's stamp from the request to the response interceptor: a Symbol-keyed property (the 17.x fetch
 * client copies the config by spread) and a WeakMap (the axios flavour passes the same object). */
function carrier() {
  const sym = Symbol("scf.stellar-rpc");
  const map = new WeakMap<object, Stamp>();
  return {
    put(config: unknown, s: Stamp): void {
      if (!config || typeof config !== "object") return;
      try {
        (config as Record<symbol, unknown>)[sym] = s;
      } catch {}
      map.set(config, s);
    },
    get(config: unknown): Stamp | undefined {
      if (!config || typeof config !== "object") return undefined;
      return (
        ((config as Record<symbol, Stamp | undefined>)[sym] as Stamp | undefined) ?? map.get(config)
      );
    },
  };
}

const NOT_ATTACHED: Telemetry = Object.freeze({ attached: false, detach() {} });
const attachedTo = new WeakMap<object, Telemetry>();
const now = (): number => performance.now();
const safely = (f: () => void): void => {
  try {
    f();
  } catch {}
};

function attach(
  server: ServerLike,
  api: "rpc" | "horizon",
  net: { v: Network },
  request: (config: AnyRecord) => string | undefined,
  response: (s: Stamp, r: AnyRecord) => Outcome,
): Telemetry {
  const hook = hookOf(server);
  if (!hook) return NOT_ATTACHED;
  const prev = attachedTo.get(hook.hc);
  if (prev) return prev;
  const c = carrier();
  const reqId = hook.req.use((config) => {
    safely(() => {
      const op = request(config as AnyRecord);
      if (op) c.put(config, { t0: now(), op });
    });
    return config;
  });
  const resId = hook.res.use(
    (r) => {
      safely(() => {
        const s = c.get((r as AnyRecord | null)?.config);
        if (s) countCall(api, s.op, net.v, response(s, r as AnyRecord), now() - s.t0);
      });
      return r;
    },
    (err) => {
      safely(() => {
        const s = c.get((err as AnyRecord | null)?.config);
        if (s) countCall(api, s.op, net.v, failureOutcome(err), now() - s.t0);
      });
      return Promise.reject(err);
    },
  );
  let done = false;
  const handle: Telemetry = {
    attached: true,
    detach() {
      if (done) return;
      done = true;
      hook.req.eject(reqId);
      hook.res.eject(resId);
      attachedTo.delete(hook.hc);
    },
  };
  attachedTo.set(hook.hc, handle);
  return handle;
}

const MAX_BODY = 1 << 20;
const rpcMethodOf = (data: unknown): unknown => {
  let b = data;
  if (typeof b === "string" && b.length < MAX_BODY) {
    try {
      b = JSON.parse(b);
    } catch {
      return undefined;
    }
  }
  return b && typeof b === "object" && !ArrayBuffer.isView(b)
    ? (b as { method?: unknown }).method
    : undefined;
};

/**
 * Count the calls of one js-stellar-sdk `rpc.Server` (SDK ≥ 14.3.1), or of every server of an SDK copy when the `rpc`
 * namespace is passed (13.x – 14.3.0). Outcome `rpc_error` for a JSON-RPC error answer, else `ok`; transport
 * failures by HTTP status class, `timeout` or `network_error`. The network is `opts.network`, else learnt from a
 * `getNetwork` answer. Anything without the public interceptor API → `{attached: false}`, untouched.
 */
export function attachRpcTelemetry(server: ServerLike, opts: TelemetryOptions = {}): Telemetry {
  const fixed = opts.network !== undefined;
  const net = { v: networkOf(opts.network) };
  return attach(
    server,
    "rpc",
    net,
    (config) => {
      if (String(config.method ?? "post").toLowerCase() !== "post") return undefined;
      const m = rpcMethodOf(config.data);
      if (m === undefined) return undefined;
      return (
        (typeof m === "string" && Object.hasOwn(RPC_OPERATIONS, m) && RPC_OPERATIONS[m]) || "other"
      );
    },
    (s, r) => {
      const body = r.data as { error?: unknown; result?: { passphrase?: unknown } } | undefined;
      if (body && typeof body === "object" && body.error) return "rpc_error";
      if (s.op === "get_network" && !fixed) net.v = networkOf(body?.result?.passphrase);
      return "ok";
    },
  );
}

/**
 * Count the requests of one js-stellar-sdk `Horizon.Server` (SDK ≥ 14.3.1), or of the `Horizon` namespace (13.x –
 * 14.3.0), by route template. Outcome `ok` for an answered request, else the transport failure class. The network is
 * `opts.network` (Horizon has no cheap way to learn it), else `unknown`.
 */
export function attachHorizonTelemetry(server: ServerLike, opts: TelemetryOptions = {}): Telemetry {
  return attach(
    server,
    "horizon",
    { v: networkOf(opts.network) },
    (config) => horizonOperation(config.url),
    () => "ok",
  );
}
