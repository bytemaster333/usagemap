// SPDX-License-Identifier: Apache-2.0
// API analytics fixtures with known expected values (dashboard.api-*, isolation.api-dashboard, operator.api-*), shared by the component tests and the mock control
// plane. Every body is validated against the OpenAPI document (test/unit/fixtures-api.test.ts and, at runtime, by the
// mock server). The status classes, status codes and per-route rows add up exactly to the summary's request count, so
// the browser tests can check that the views agree with each other.

import type { ControlPlane } from "@usagemap/api-types";

type Service = ControlPlane.Service;
type ApiSummary = ControlPlane.ApiSummary;
type ApiRangeEcho = ControlPlane.ApiRangeEcho;
type ApiRouteRow = ControlPlane.ApiRouteRow;
type IngestToken = ControlPlane.IngestToken;

export const TENANT_DOCS = "a0000000-0000-4000-8000-000000000001";
export const SVC_HORIZON = "d0000000-0000-4000-8000-000000000001";
export const SVC_RPC = "d0000000-0000-4000-8000-000000000002";

export const SERVICES: Service[] = [
  {
    service_id: SVC_HORIZON,
    service_name: "horizon-proxy",
    display_name: "Horizon proxy",
    declared_base_url: "https://horizon.stellar-docs.example",
    read_only_api: true,
    rpc_method_dimension: false,
    registration: "portal",
    status: "active",
    registered_at: "2026-09-03T09:00:00Z",
    stream_groups: [
      {
        kind: "sdk_stable",
        metric_name: "http.server.request.duration",
        scope_name: "@opentelemetry/instrumentation-http",
        preferred_today: true,
      },
    ],
    multiple_groups_warning: false,
  },
  {
    service_id: SVC_RPC,
    service_name: "soroban-rpc-gw",
    display_name: null,
    declared_base_url: null,
    read_only_api: false,
    rpc_method_dimension: true,
    registration: "auto",
    status: "active",
    registered_at: "2026-10-20T14:30:00Z",
    stream_groups: [
      {
        kind: "sdk_stable",
        metric_name: "http.server.request.duration",
        scope_name: "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp",
        preferred_today: true,
      },
      {
        kind: "span_derived",
        metric_name: "http.server.request.duration",
        scope_name: "scf/signal_to_metrics",
        preferred_today: false,
      },
    ],
    multiple_groups_warning: true,
  },
];

/** The resolution the mock reports per preset (the control plane's `auto`: 1h up to 7 days, else 1d). */
export const API_RESOLUTION: Record<string, ApiRangeEcho["resolution"]> = {
  "24h": "1h",
  "7d": "1h",
  "30d": "1d",
  "90d": "1d",
  "12m": "1d",
  all: "1d",
  custom: "1d",
};

export function apiRange(
  start: string,
  end: string,
  resolution: ApiRangeEcho["resolution"],
  extra: Partial<ApiRangeEcho> = {},
): ApiRangeEcho {
  return { start, end, resolution, label: "self-attested telemetry", ...extra };
}

type SummaryBody = Omit<ApiSummary, "range">;

/** Horizon proxy, current period (any preset). 1,284,500 requests. */
export const HORIZON_SUMMARY: SummaryBody = {
  requests: 1284500,
  error_rate_5xx: 9800 / 1284500,
  error_rate_4xx: 61000 / 1284500,
  status: { s2xx: 1201000, s3xx: 12500, s4xx: 61000, s5xx: 9800, unknown: 200 },
  latency: { p50_ms: 42.7, p95_ms: 318.4, p99_ms: 912, mean_ms: 88.1, accuracy_class: "exp3" },
  assurance_level: "A1",
  onchain_badge: "not_applicable",
};

/** Horizon proxy, the previous period (answered for `range=custom`, which is how the portal asks for it). */
export const HORIZON_PREVIOUS: SummaryBody = {
  requests: 1100000,
  error_rate_5xx: 7700 / 1100000,
  error_rate_4xx: 52000 / 1100000,
  status: { s2xx: 1030000, s3xx: 10000, s4xx: 52000, s5xx: 7700, unknown: 300 },
  latency: { p50_ms: 40, p95_ms: 300, p99_ms: 850, mean_ms: 80, accuracy_class: "exp3" },
  assurance_level: "A1",
  onchain_badge: "not_applicable",
};

/** The Go gateway: a 15-bucket explicit histogram (C-103), two stream groups (C-22). */
export const RPC_SUMMARY: SummaryBody = {
  requests: 52000,
  error_rate_5xx: 500 / 52000,
  error_rate_4xx: 1500 / 52000,
  status: { s2xx: 50000, s3xx: 0, s4xx: 1500, s5xx: 500, unknown: 0 },
  latency: { p50_ms: 5, p95_ms: 25, p99_ms: 250, mean_ms: 14.2, accuracy_class: "explicit15" },
  assurance_level: "A0",
  onchain_badge: "unavailable",
};

export const RPC_STREAM_WARNING =
  "Two stream groups report for this service; SDK metrics are used, span-derived data only on days without them.";

export const STATUS_CODES: Record<string, { status_code: number; requests: number }[]> = {
  [SVC_HORIZON]: [
    { status_code: 200, requests: 1150000 },
    { status_code: 201, requests: 51000 },
    { status_code: 304, requests: 12500 },
    { status_code: 400, requests: 20000 },
    { status_code: 401, requests: 15000 },
    { status_code: 404, requests: 26000 },
    { status_code: 500, requests: 6800 },
    { status_code: 503, requests: 3000 },
    { status_code: 0, requests: 200 },
  ],
  [SVC_RPC]: [
    { status_code: 200, requests: 50000 },
    { status_code: 429, requests: 1500 },
    { status_code: 502, requests: 500 },
  ],
};

const lat = (
  p50: number,
  p95: number,
  p99: number,
  accuracy_class: ControlPlane.AccuracyClass = "exp3",
): ControlPlane.Percentiles => ({ p50_ms: p50, p95_ms: p95, p99_ms: p99, accuracy_class });

export const ROUTES: Record<string, ApiRouteRow[]> = {
  [SVC_HORIZON]: [
    {
      route: "/accounts/{account_id}",
      requests: 640000,
      error_rate_5xx: 0.005,
      latency: lat(38.2, 290.5, 870),
      rules_version: "1",
    },
    {
      route: "/transactions/{tx_hash}",
      requests: 410000,
      error_rate_5xx: 0.01,
      latency: lat(51, 402, 1210),
      rules_version: "1",
    },
    {
      route: "/ledgers",
      requests: 150000,
      error_rate_5xx: 0.002,
      latency: lat(12.4, 88, 140),
      rules_version: "1",
    },
    {
      route: "{overflow}",
      requests: 58500,
      error_rate_5xx: 0.03,
      latency: lat(60, 500, 1500),
      rules_version: "1",
    },
    {
      route: "{unknown}",
      requests: 26000,
      error_rate_5xx: 0,
      latency: lat(3.1, 9.8, 15),
      rules_version: "1",
    },
  ],
  [SVC_RPC]: [
    {
      route: "/rpc",
      rpc_method: "getLedgerEntries",
      requests: 40000,
      error_rate_5xx: 0.01,
      latency: lat(5, 25, 250, "explicit15"),
    },
    {
      route: "/rpc",
      rpc_method: "sendTransaction",
      requests: 12000,
      error_rate_5xx: 0.0083,
      latency: lat(10, 75, 500, "explicit15"),
    },
  ],
};

/** Data-quality counters for 7 days; 24h is ÷7 rounded down, 30d is ×4 (mock). */
export const DATA_QUALITY_7D: Record<string, { reason: string; count: number }[]> = {
  [SVC_HORIZON]: [
    { reason: "metric_not_allowed", count: 120400 },
    { reason: "route_overflow", count: 1960 },
    { reason: "span_not_server", count: 3200 },
    { reason: "token_expired", count: 14 },
    { reason: "route_redacted", count: 12 },
  ],
  [SVC_RPC]: [],
};

/** One point per bucket: requests 7,000 + 10 × i; 4xx 280; 5xx 50 + i mod 3; percentiles fixed (mock). */
export function apiPoints(
  start: string,
  end: string,
  resolution: ApiRangeEcho["resolution"],
  service: string,
): ControlPlane.ApiPoint[] {
  const step = resolution === "1m" ? 60_000 : resolution === "1h" ? 3_600_000 : 86_400_000;
  const out: ControlPlane.ApiPoint[] = [];
  const s = Date.parse(start);
  const e = Date.parse(end);
  const l = service === SVC_RPC ? RPC_SUMMARY.latency : HORIZON_SUMMARY.latency;
  for (let t = s, i = 0; t < e && i < 2000; t += step, i++) {
    out.push({
      t: new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z"),
      requests: 7000 + 10 * i,
      s4xx: 280,
      s5xx: 50 + (i % 3),
      p50_ms: l.p50_ms,
      p95_ms: l.p95_ms,
      p99_ms: l.p99_ms,
    });
  }
  return out;
}

export const TOKENS: IngestToken[] = [
  {
    token_id: "ProdColl0001",
    display: "scfa_ing_ProdColl0001_…x9Q2",
    label: "production collector",
    allowed_service_names: ["horizon-proxy"],
    created_at: "2026-09-03T09:05:00Z",
    expires_at: null,
    last_used_at: "2026-11-12T09:58:00Z",
    revoked_at: null,
    rotation_reminder: false,
  },
  {
    token_id: "OldStaging01",
    display: "scfa_ing_OldStaging01_…k3Lm",
    label: "old staging",
    allowed_service_names: null,
    created_at: "2025-10-01T12:00:00Z",
    expires_at: null,
    last_used_at: "2026-08-30T17:00:00Z",
    revoked_at: null,
    rotation_reminder: true,
  },
];

/** Strings the views must show for these fixtures (en-US grouping, UTC). */
export const EXPECTED_API = {
  requests: "1,284,500",
  requestsPrevious: "1,100,000",
  requestsDelta: "+16.8%",
  errorRate5xx: "0.76%",
  errorRate4xx: "4.75%",
  p50: "43 ms",
  p95: "318 ms",
  p99: "912 ms",
  p95Previous: "300 ms",
  rpcP50: "≤ 5 ms",
  rpcP95: "25 ms",
  share2xx: "93.50%",
  share5xx: "0.76%",
  transactionsP99: "1.21 s",
  unknownP50: "3.1 ms",
};

/** Secret-seed leak warning of the docs project (2026-11-19 improvements): 3 seeds in two services. */
export const SEED_WARNING: ControlPlane.SecretSeedWarning = {
  count: 3,
  since: "2026-11-04",
  last_seen: "2026-11-12",
  acknowledged_at: null,
  services: [
    { service_id: SVC_HORIZON, service_name: "horizon-proxy", count: 2 },
    { service_id: SVC_RPC, service_name: "soroban-rpc-gw", count: 1 },
  ],
};

/** Requests by Stellar surface (stellar-surfaces/1.0.0) for the 7-day range: the route fixtures grouped. */
export const SURFACES: Record<string, ControlPlane.ApiSurface[]> = {
  [SVC_HORIZON]: [
    {
      surface: "horizon",
      label: "Horizon API",
      requests: 1200000,
      error_rate_5xx: 0.0063,
      latency: lat(39, 330, 990),
      groups: [
        {
          group: "accounts",
          requests: 640000,
          error_rate_5xx: 0.005,
          latency: lat(38.2, 290.5, 870),
        },
        {
          group: "transactions",
          requests: 410000,
          error_rate_5xx: 0.01,
          latency: lat(51, 402, 1210),
        },
        { group: "ledgers", requests: 150000, error_rate_5xx: 0.002, latency: lat(12.4, 88, 140) },
      ],
    },
    {
      surface: "placeholder",
      label: "Requests without a route of their own",
      requests: 84500,
      error_rate_5xx: 0.0208,
      latency: lat(40, 480, 1450),
      groups: [
        { group: "{overflow}", requests: 58500, error_rate_5xx: 0.03, latency: lat(60, 500, 1500) },
        { group: "{unknown}", requests: 26000, error_rate_5xx: 0, latency: lat(3.1, 9.8, 15) },
      ],
    },
  ],
  [SVC_RPC]: [
    {
      surface: "soroban_rpc",
      label: "Stellar RPC (Soroban) JSON-RPC",
      requests: 52000,
      error_rate_5xx: 0.0096,
      latency: lat(5, 50, 400, "explicit15"),
      groups: [
        {
          group: "getLedgerEntries",
          requests: 40000,
          error_rate_5xx: 0.01,
          latency: lat(5, 25, 250, "explicit15"),
        },
        {
          group: "sendTransaction",
          requests: 12000,
          error_rate_5xx: 0.0083,
          latency: lat(10, 75, 500, "explicit15"),
        },
      ],
    },
  ],
};
