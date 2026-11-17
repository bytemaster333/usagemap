// SPDX-License-Identifier: Apache-2.0
// SCF-operator fixtures with known expected values (operator.web-*, operator.api-*, operator.global-view-credentials). Totals per project are fixed for
// any range; the mock spreads each total over the requested days so that the days add up exactly to it. Web totals and
// API metrics are exact (C-91, C-95); only web breakdown rows carry the minimum count and rounding (PrivacyEcho).

import type { ControlPlane } from "@usagemap/api-types";

type OpWebCells = ControlPlane.OpWebCells;
type OpApiCells = ControlPlane.OpApiCells;
type VerificationLevel = ControlPlane.VerificationLevel;

export const T = {
  docs: "a0000000-0000-4000-8000-000000000001",
  pending: "a0000000-0000-4000-8000-000000000002",
  swap: "a0000000-0000-4000-8000-000000000003",
  anchor: "a0000000-0000-4000-8000-000000000004",
  oldWallet: "a0000000-0000-4000-8000-000000000005",
  hobby: "a0000000-0000-4000-8000-000000000006",
} as const;

export const PRIVACY: ControlPlane.PrivacyEcho = {
  min_count: 10,
  round_to: 10,
  aggregation: "sum_of_unrounded_then_rounded",
  excluded_levels_below: "L1",
};

export interface OpProject {
  tenant_id: string;
  slug: string;
  name: string;
  status: ControlPlane.TenantStatus;
  verification_level: VerificationLevel;
  scf_awarded: boolean | null;
  trust_score_28d: number | null;
  verified: OpWebCells;
  raw: Pick<OpWebCells, "pageviews" | "pageviews_unidentified" | "visitors_sum">;
}

const cells = (
  pageviews: number,
  pageviews_unidentified: number,
  visitors_sum: number,
  visits: number,
  bounces: number,
  avg_visit_duration_s: number | null,
  suspect_pageview_share: number | null,
): OpWebCells => ({
  pageviews,
  pageviews_unidentified,
  visitors_sum,
  visits,
  bounces,
  bounce_rate_pct: visits === 0 ? null : Math.round((bounces / visits) * 1000) / 10,
  avg_visit_duration_s,
  suspect_pageview_share,
});

/** Removed tenants have no figures in the operator views (data hidden, C-08). */
export const OP_PROJECTS: OpProject[] = [
  {
    tenant_id: T.docs,
    slug: "stellar-docs",
    name: "Stellar Docs",
    status: "active",
    verification_level: "L3",
    scf_awarded: true,
    trust_score_28d: 84,
    verified: cells(36900, 1200, 18300, 21000, 8700, 93, 0.06),
    raw: { pageviews: 39200, pageviews_unidentified: 1310, visitors_sum: 19400 },
  },
  {
    tenant_id: T.swap,
    slug: "soroban-swap",
    name: "Soroban Swap",
    status: "active",
    verification_level: "L2",
    scf_awarded: false,
    trust_score_28d: 58,
    verified: cells(52400, 900, 20100, 24800, 12900, 61, 0.12),
    raw: { pageviews: 61000, pageviews_unidentified: 1100, visitors_sum: 23500 },
  },
  {
    tenant_id: T.anchor,
    slug: "anchor-hub",
    name: "Anchor Hub",
    status: "suspended",
    verification_level: "L2",
    scf_awarded: true,
    trust_score_28d: null,
    verified: cells(8150, 300, 4020, 4500, 1350, 145, 0.02),
    raw: { pageviews: 8300, pageviews_unidentified: 310, visitors_sum: 4100 },
  },
  {
    tenant_id: T.pending,
    slug: "pending-labs",
    name: "Pending Labs",
    status: "pending",
    verification_level: "L1",
    scf_awarded: null,
    trust_score_28d: null,
    verified: cells(0, 0, 0, 0, 0, null, null),
    raw: { pageviews: 0, pageviews_unidentified: 0, visitors_sum: 0 },
  },
  {
    tenant_id: T.hobby,
    slug: "hobby-site",
    name: "Hobby Site",
    status: "active",
    verification_level: "L0",
    scf_awarded: null,
    trust_score_28d: 31,
    verified: cells(2000, 100, 1500, 1600, 1100, 20, 0.4),
    raw: { pageviews: 2600, pageviews_unidentified: 120, visitors_sum: 1900 },
  },
];

export interface OpService {
  tenant_id: string;
  service_id: string;
  service_name: string;
  assurance_level: "A0" | "A1" | "A2" | null;
  onchain_badge: "consistent" | "inconsistent" | "not_applicable" | "unavailable" | null;
  /** active days per 30 (scaled by the mock to the range length) */
  active_days_30: number;
  cells: OpApiCells;
}

const api = (
  requests: number,
  s: [number, number, number, number, number],
  p: [number, number, number, number] | null,
  accuracy_class: ControlPlane.AccuracyClass | null,
): OpApiCells => ({
  requests,
  s2xx: s[0],
  s3xx: s[1],
  s4xx: s[2],
  s5xx: s[3],
  unknown: s[4],
  error_rate_5xx: requests === 0 ? null : s[3] / requests,
  mean_ms: p ? p[0] : null,
  p50_ms: p ? p[1] : null,
  p95_ms: p ? p[2] : null,
  p99_ms: p ? p[3] : null,
  accuracy_class,
});

export const OP_SERVICES: OpService[] = [
  {
    tenant_id: T.docs,
    service_id: "d0000000-0000-4000-8000-000000000001",
    service_name: "horizon-proxy",
    assurance_level: "A1",
    onchain_badge: "not_applicable",
    active_days_30: 30,
    cells: api(1284500, [1201000, 12500, 61000, 9800, 200], [88.1, 42.7, 318.4, 912], "exp3"),
  },
  {
    tenant_id: T.docs,
    service_id: "d0000000-0000-4000-8000-000000000002",
    service_name: "soroban-rpc-gw",
    assurance_level: "A0",
    onchain_badge: "unavailable",
    active_days_30: 12,
    cells: api(52000, [50000, 0, 1500, 500, 0], [14.2, 5, 25, 250], "explicit15"),
  },
  {
    tenant_id: T.swap,
    service_id: "d0000000-0000-4000-8000-000000000003",
    service_name: "swap-api",
    assurance_level: "A2",
    onchain_badge: "consistent",
    active_days_30: 30,
    cells: api(3410000, [3300000, 0, 90000, 20000, 0], [190.4, 120.5, 640, 2100], "exp3"),
  },
  {
    tenant_id: T.swap,
    service_id: "d0000000-0000-4000-8000-000000000004",
    service_name: "legacy-api",
    assurance_level: null,
    onchain_badge: null,
    active_days_30: 0,
    cells: api(0, [0, 0, 0, 0, 0], null, null),
  },
  {
    tenant_id: T.anchor,
    service_id: "d0000000-0000-4000-8000-000000000005",
    service_name: "anchor-sep",
    assurance_level: "A0",
    onchain_badge: "inconsistent",
    active_days_30: 2,
    cells: api(900, [880, 0, 20, 0, 0], [260, 210, 980, 1900], "exp3"),
  },
  {
    tenant_id: T.hobby,
    service_id: "d0000000-0000-4000-8000-000000000006",
    service_name: "hobby-api",
    assurance_level: "A0",
    onchain_badge: "not_applicable",
    active_days_30: 30,
    cells: api(3000, [3000, 0, 0, 0, 0], [8, 6, 9, 12], "exp3"),
  },
];

/** Ecosystem per-day percentiles (merged histograms of mixed layouts: the coarsest class wins). */
export const ECO_LATENCY = { p50_ms: 98, p95_ms: 520, p99_ms: 1800, mean_ms: 160 } as const;

/** Country breakdown rows (already thresholded and rounded by the API, C-95). */
export const OP_COUNTRY_ROWS: ControlPlane.OperatorBreakdown["rows"] = [
  { tenant_id: T.docs, value: "DE", visitors_sum: 4100, pageviews: 8200, events: null },
  { tenant_id: T.docs, value: "US", visitors_sum: 3500, pageviews: 7000, events: null },
  { tenant_id: T.swap, value: "BR", visitors_sum: 5600, pageviews: 12300, events: null },
  { tenant_id: T.anchor, value: "NG", visitors_sum: 1200, pageviews: 2400, events: null },
];

export const OP_API_KEYS: ControlPlane.OperatorApiKey[] = [
  {
    key_id: "Dash0Board01",
    display: "scfa_op_Dash0Board01_…7Hq1",
    label: "SCF funding dashboard",
    scopes: ["web:read", "api:read"],
    tenant_restriction: null,
    rate_limit_per_min: 60,
    created_by: "c0000000-0000-4000-8000-000000000003",
    created_at: "2026-10-01T08:00:00Z",
    expires_at: "2027-10-01T08:00:00Z",
    last_used_at: "2026-11-12T07:00:00Z",
    revoked_at: null,
    flagged_for_review: false,
  },
];

export const OP_TOMBSTONES: ControlPlane.Tombstone[] = [
  {
    tombstone_id: "f0000000-0000-4000-8000-000000000001",
    kind: "host",
    subject: "oldwallet.example",
    tenant_id: T.oldWallet,
    reason: "Not part of the Stellar ecosystem",
    created_at: "2026-10-20T10:00:00Z",
    lifted_at: null,
  },
  {
    tombstone_id: "f0000000-0000-4000-8000-000000000002",
    kind: "github_user",
    subject: "old-wallet-dev",
    tenant_id: T.oldWallet,
    reason: "Not part of the Stellar ecosystem",
    created_at: "2026-10-20T10:00:00Z",
    lifted_at: null,
  },
];

export const OP_SETTINGS: ControlPlane.Setting[] = [
  {
    key: "op_min_count",
    value: 10,
    description: "Web breakdown rows below this count are omitted in SCF-operator views (C-95).",
    public: true,
    updated_at: "2026-11-01T00:00:00Z",
  },
  {
    key: "op_round_to",
    value: 10,
    description: "Web breakdown rows are rounded to this step in SCF-operator views (C-95).",
    public: true,
    updated_at: "2026-11-01T00:00:00Z",
  },
  {
    key: "op_rank_min_level",
    value: "L1",
    description: "Projects below this verification level are excluded from rankings (ADR-0015).",
    public: true,
    updated_at: "2026-11-01T00:00:00Z",
  },
];

/** Strings the operator views must show for the default filter (min level L1; Hobby Site L0 excluded). */
export const EXPECTED_OP = {
  ecoPageviews: "97,450",
  ecoPageviewsRaw: "108,500",
  ecoVisitors: "42,420",
  ecoVisits: "50,300",
  ecoBounce: "45.6%",
  ecoDuration: "1 min 22 s",
  ecoSuspect: "8.9%",
  ecoRequests: "4,747,400",
  ecoErrorRate: "0.64%",
  swapRequests: "3,410,000",
  docsApiRequests: "1,336,500",
  rpcP50: "≤ 5 ms",
};
