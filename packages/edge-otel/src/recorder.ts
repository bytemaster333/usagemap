// SPDX-License-Identifier: Apache-2.0
// Aggregates http.server.request.duration into one delta histogram per window
// and exports it as OTLP/HTTP JSON. Only four values per request are kept: the
// method, the route template, the status code and the duration. Nothing about
// the request itself (query string, headers, IP address, User-Agent, cookies,
// body) is ever read here.

import { normalize } from "./pathnorm.ts";
import { createMatcher } from "./routes.ts";
import { VERSION } from "./version.ts";

/** OTel's advisory bucket boundaries for http.server.request.duration (seconds). */
export const BOUNDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];
const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
  "PATCH",
  "QUERY",
]);
export const SCOPE_NAME = "@usagemap/edge-otel";
export const METRIC_NAME = "http.server.request.duration";

export interface RecorderOptions {
  /** OTLP base URL, e.g. "https://e1.usagemap.dev"; "/v1/metrics" is appended. */
  endpoint?: string | undefined;
  /** Full metrics URL (OTEL_EXPORTER_OTLP_METRICS_ENDPOINT); used as is, wins over `endpoint`. */
  metricsEndpoint?: string | undefined;
  /** Ingest token (scfa_ing_…), sent as "Authorization: Bearer <token>". */
  token?: string | undefined;
  /** OTel service.name; must be a service registered for the project. */
  serviceName?: string | undefined;
  /** Route templates of the app (":id", "{id}", "[id]", "*", "[...slug]" …). */
  routes?: readonly string[] | undefined;
  /** Requests that match no template: "normalize" (default) folds the path like the Collector; "unknown" sends no route. */
  unmatched?: "normalize" | "unknown" | undefined;
  /** Delta window in ms (default 10 000). */
  flushIntervalMs?: number | undefined;
  /** Export early when this many distinct (method, route, status) series are held (default 500). */
  maxSeries?: number | undefined;
  /** Failed batches kept for a retry at the next flush (default 2; older ones are dropped and counted). */
  maxPendingBatches?: number | undefined;
  /** Export request timeout in ms (default 5 000). */
  exportTimeoutMs?: number | undefined;
  /** fetch used for the export (default globalThis.fetch). */
  fetch?: typeof fetch | undefined;
  /** Clock in ms (default Date.now). */
  now?: (() => number) | undefined;
  /** Called once per failed export with a short reason; never receives request data. */
  onExportError?: ((reason: string) => void) | undefined;
}

export interface RecorderStats {
  recorded: number;
  exportedBatches: number;
  failedExports: number;
  droppedBatches: number;
}

interface Series {
  method: string;
  route: string | undefined;
  status: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: number[];
}

export interface Recorder {
  readonly stats: RecorderStats;
  /** The route reported for a pathname. */
  routeFor(pathname: string): string | undefined;
  record(method: string, route: string | undefined, status: number, seconds: number): void;
  /** True when the window has elapsed or the series cap is reached. */
  due(): boolean;
  /** Build the OTLP/JSON body of the current window and start a new one (null when empty). */
  drain(): OtlpMetricsBody | null;
  /** Export the current window and any pending retries. Never throws or rejects. */
  flush(): Promise<void>;
}

export interface OtlpMetricsBody {
  resourceMetrics: unknown[];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Validate options; returns the reason they cannot be used, or undefined. */
export function invalidReason(o: RecorderOptions): string | undefined {
  const url = o.metricsEndpoint ?? o.endpoint;
  if (!url) return "no endpoint (USAGEMAP_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT)";
  if (!o.token) return "no ingest token (USAGEMAP_TOKEN or OTEL_EXPORTER_OTLP_HEADERS)";
  if (!o.serviceName) return "no service name (OTEL_SERVICE_NAME)";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "endpoint is not a URL";
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    return "endpoint must use https (http only for localhost)";
  }
  if (/[?#]/.test(url) || u.username || u.password) {
    return "endpoint must not carry a query, fragment or credentials";
  }
  if (!/^[\x21-\x7e]{8,512}$/.test(o.token)) return "ingest token has an invalid format";
  if (o.serviceName.length > 255 || hasControlChar(o.serviceName)) {
    return "service name must be at most 255 printable characters";
  }
  return undefined;
}

export function metricsUrl(o: RecorderOptions): string {
  if (o.metricsEndpoint) return o.metricsEndpoint;
  return `${(o.endpoint ?? "").replace(/\/+$/, "")}/v1/metrics`;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Create a recorder. Throws TypeError on unusable options (see invalidReason). */
export function createRecorder(opts: RecorderOptions): Recorder {
  const bad = invalidReason(opts);
  if (bad) throw new TypeError(`usagemap edge-otel: ${bad}`);
  const token = opts.token as string;
  const serviceName = opts.serviceName as string;
  const url = metricsUrl(opts);
  const match = createMatcher(opts.routes ?? []);
  const unmatched = opts.unmatched ?? "normalize";
  const flushIntervalMs = Math.max(0, opts.flushIntervalMs ?? 10_000);
  const maxSeries = Math.max(1, opts.maxSeries ?? 500);
  const maxPending = Math.max(0, opts.maxPendingBatches ?? 2);
  const timeoutMs = Math.max(1, opts.exportTimeoutMs ?? 5_000);
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  const stats: RecorderStats = {
    recorded: 0,
    exportedBatches: 0,
    failedExports: 0,
    droppedBatches: 0,
  };

  let series = new Map<string, Series>();
  let windowStart = now();
  let pending: string[] = [];

  function routeFor(pathname: string): string | undefined {
    const r = match(pathname);
    if (r !== undefined) return r;
    return unmatched === "unknown" ? undefined : normalize(pathname, "path");
  }

  function record(method: string, route: string | undefined, status: number, seconds: number) {
    const m = METHODS.has(method) ? method : "_OTHER";
    const st = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
    const key = `${m} ${route ?? ""} ${st}`;
    let s = series.get(key);
    if (!s) {
      s = {
        method: m,
        route,
        status: st,
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: 0,
        buckets: new Array<number>(BOUNDS.length + 1).fill(0),
      };
      series.set(key, s);
    }
    const v = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    s.count++;
    s.sum += v;
    s.min = Math.min(s.min, v);
    s.max = Math.max(s.max, v);
    let i = 0;
    while (i < BOUNDS.length && v > (BOUNDS[i] as number)) i++;
    s.buckets[i] = (s.buckets[i] ?? 0) + 1;
    stats.recorded++;
  }

  function due(): boolean {
    return series.size > 0 && (series.size >= maxSeries || now() - windowStart >= flushIntervalMs);
  }

  function drain(): OtlpMetricsBody | null {
    if (series.size === 0) return null;
    const t = now();
    const start = String(BigInt(Math.floor(windowStart)) * 1_000_000n);
    const end = String(BigInt(Math.floor(t)) * 1_000_000n);
    const dataPoints = [...series.values()].map((s) => {
      const attributes: unknown[] = [
        { key: "http.request.method", value: { stringValue: s.method } },
      ];
      if (s.route !== undefined)
        attributes.push({ key: "http.route", value: { stringValue: s.route } });
      attributes.push({ key: "http.response.status_code", value: { intValue: String(s.status) } });
      return {
        attributes,
        startTimeUnixNano: start,
        timeUnixNano: end,
        count: String(s.count),
        sum: s.sum,
        min: s.min,
        max: s.max,
        bucketCounts: s.buckets.map(String),
        explicitBounds: BOUNDS,
      };
    });
    series = new Map();
    windowStart = t;
    return {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
          scopeMetrics: [
            {
              scope: { name: SCOPE_NAME, version: VERSION },
              metrics: [
                {
                  name: METRIC_NAME,
                  unit: "s",
                  // 1 = AGGREGATION_TEMPORALITY_DELTA
                  histogram: { aggregationTemporality: 1, dataPoints },
                },
              ],
            },
          ],
        },
      ],
    };
  }

  /** Send one body; returns whether it should be retried. */
  async function send(body: string): Promise<boolean> {
    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        ...(signal ? { signal } : {}),
      });
      // Drain the body so the connection can be reused (Workers count open subrequests).
      await res.body?.cancel().catch(() => {});
      if (res.ok) {
        stats.exportedBatches++;
        return false;
      }
      stats.failedExports++;
      opts.onExportError?.(`HTTP ${res.status}`);
      return RETRYABLE.has(res.status);
    } catch (e) {
      stats.failedExports++;
      opts.onExportError?.(
        e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network error",
      );
      return true;
    }
  }

  async function flush(): Promise<void> {
    try {
      const body = drain();
      const batch = pending;
      pending = [];
      if (body) batch.push(JSON.stringify(body));
      for (const b of batch) {
        if (await send(b)) pending.push(b);
      }
      while (pending.length > maxPending) {
        pending.shift();
        stats.droppedBatches++;
      }
    } catch {
      // Analytics must never break the application.
    }
  }

  return { stats, routeFor, record, due, drain, flush };
}
