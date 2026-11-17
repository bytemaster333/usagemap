// SPDX-License-Identifier: Apache-2.0
// Fixtures of getPartnerCalls, getPaymentEvents, getAnchorFunnel and getAppEvents. Every figure is FAKE.
import type { ControlPlane } from "@usagemap/api-types";

type Range = ControlPlane.PartnerCalls["range"];

export const emptyPartnerCalls = (range: Range): ControlPlane.PartnerCalls => ({
  range,
  networks: [],
  partners: [],
  operations: [],
  series: [],
});

export const partnerCallsFixture = (range: Range): ControlPlane.PartnerCalls => ({
  range,
  networks: ["mainnet"],
  partners: [{ partner: "soroswap", calls: 120, errors: 6, error_rate: 0.05 }],
  operations: [
    {
      partner: "soroswap",
      operation: "/quote",
      network: "mainnet",
      calls: 120,
      errors: 6,
      error_rate: 0.05,
      p50_ms: 250,
      p95_ms: 750,
      mean_ms: 310,
      accuracy_class: "explicit15",
      outcomes: [
        { outcome: "success", count: 114 },
        { outcome: "rate_limited", count: 6 },
      ],
    },
  ],
  series: [
    { t: "2026-11-18T00:00:00Z", calls: 70, errors: 2 },
    { t: "2026-11-19T00:00:00Z", calls: 50, errors: 4 },
  ],
});

const zeroStages = { required: 0, verified: 0, settled: 0, paid: 0, failed: 0, canceled: 0 };

export const emptyPayments = (range: Range): ControlPlane.PaymentEvents => ({
  range,
  totals: { events: 0, required: 0, completed: 0, failed: 0, success_rate: null },
  stages: { ...zeroStages, other: 0 },
  protocols: [],
  networks: [],
  rails: [],
  assets: [],
  amount_buckets: [],
  failures: [],
  series: [],
});

export const paymentsFixture = (range: Range): ControlPlane.PaymentEvents => ({
  range,
  totals: { events: 21, required: 10, completed: 8, failed: 2, success_rate: 0.8 },
  stages: { required: 10, verified: 1, settled: 6, paid: 2, failed: 1, canceled: 1, other: 0 },
  protocols: [
    {
      protocol: "x402",
      events: 18,
      stages: { ...zeroStages, required: 10, verified: 1, settled: 6, failed: 1 },
    },
    { protocol: "mpp", events: 3, stages: { ...zeroStages, paid: 2, canceled: 1 } },
  ],
  networks: [{ network: "stellar:pubnet", count: 21 }],
  rails: [{ protocol: "x402", rail: "exact", intent: null, network: "stellar:pubnet", count: 6 }],
  assets: [{ asset: "USDC", count: 8 }],
  amount_buckets: [{ bucket: "0.01_0.1", count: 6 }],
  failures: [
    {
      protocol: "x402",
      stage: "failed",
      reason_class: "verification_failed",
      error_type: "invalid_exact_stellar_payload_wrong_amount",
      count: 1,
    },
  ],
  series: [{ t: "2026-11-19T00:00:00Z", events: 21, failed: 2 }],
});

const funnel = (flow: "deposit" | "withdraw" | "receive", n: number[]) => ({
  flow,
  steps: (["authenticated", "requested", "started", "completed"] as const).map((step, i) => ({
    step,
    count: n[i] ?? 0,
  })),
  pending_user: 0,
  pending_anchor: 0,
  failed: n[4] ?? 0,
  refunded: 0,
  expired: 0,
});

export const emptyAnchorFunnel = (range: Range): ControlPlane.AnchorFunnel => ({
  range,
  networks: [],
  wallet: {
    reported: false,
    funnels: [funnel("deposit", []), funnel("withdraw", []), funnel("receive", [])],
    kyc: [],
    events: [],
    requests: [],
    anchors: [],
  },
  anchor: {
    reported: false,
    transfers_created: 0,
    created: [],
    statuses: [],
    transitions: [],
    time_in_status: [],
    durations: [],
    customers: [],
    quotes_created: 0,
    clients: [],
  },
});

export const anchorFunnelFixture = (range: Range): ControlPlane.AnchorFunnel => ({
  ...emptyAnchorFunnel(range),
  networks: ["testnet"],
  wallet: {
    ...emptyAnchorFunnel(range).wallet,
    reported: true,
    funnels: [funnel("deposit", [10, 8, 6, 4, 1]), funnel("withdraw", []), funnel("receive", [])],
    anchors: [
      {
        home_domain: "testanchor.stellar.org",
        events: 29,
        requests: 40,
        errors: 2,
        error_rate: 0.05,
      },
    ],
  },
  anchor: {
    ...emptyAnchorFunnel(range).anchor,
    reported: true,
    transfers_created: 12,
    statuses: [{ status: "pending_anchor", entered: 9 }],
    time_in_status: [{ status: "pending_anchor", count: 9, mean_s: 420 }],
    durations: [{ kind: "deposit", final_status: "completed", count: 5, mean_s: 5400 }],
    quotes_created: 3,
    clients: [{ client: "wallet.example.org", transfers: 12, quotes: 3, customer_updates: 2 }],
  },
});

type DayRange = ControlPlane.AppEvents["range"];

export const emptyAppEvents = (range: DayRange): ControlPlane.AppEvents => ({
  range,
  site_id: null,
  attestation: "self_attested",
  totals: { events: 0, sessions: 0, dropped: 0 },
  sites: [],
  platforms: (["ios", "android", "web"] as const).map((platform) => ({
    platform,
    events: 0,
    sessions: 0,
  })),
  events: [],
  properties: [],
  app_versions: [],
  sdk_versions: [],
  tma_platforms: [],
  dropped: [],
  daily: [],
});

export const appEventsFixture = (range: DayRange): ControlPlane.AppEvents => ({
  ...emptyAppEvents(range),
  totals: { events: 20, sessions: 9, dropped: 1 },
  events: [{ event: "app_open", count: 20, platforms: { ios: 12, android: 8, web: 0 } }],
  app_versions: [{ version: "1.4.0", count: 9 }],
  daily: [{ day: "2026-11-19", events: 20, sessions: 9 }],
});
