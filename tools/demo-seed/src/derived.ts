// SPDX-License-Identifier: Apache-2.0
// The figures the jobs service would derive, for the demo days: trust scores (algorithm trust/1.0.0's components and
// thresholds, services/jobs/src/trust/algorithm.ts), edge counters, the Stellar wallet-event property rollup, API
// metric rows with histograms, API assurance and on-chain daily counts of verified contracts. All closed vocabularies
// are the contract's (wire-formats §a.3.1, §h, data-model §8.9); counts only, never an address or identifier.

import type { ApiPlan, ContractPlan, TenantPlan, WebsitePlan } from "./plan.ts";
import { gauss, rngFor } from "./random.ts";
import type { DayShape, DayTotals, DemoSession } from "./traffic.ts";

// ------------------------------------------------------------------ trust scores

const WEIGHTS = {
  proof_coverage: 25,
  network_quality: 15,
  multiplicity: 15,
  engagement: 15,
  mix: 10,
  temporal: 10,
  pow_latency: 5,
  cross_signal: 5,
} as const;
const lin = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export interface TrustRow {
  window_days: 1 | 28;
  score: number | null;
  components: Record<
    string,
    { value: number | null; p: number; eco_percentile: null; explanation: string }
  >;
  reason_codes: string[];
  decision_rate: number | null;
}

export interface TrustInput {
  pvVerified: number;
  pvRaw: number;
  datacenterShare: number;
  engagementShare: number;
  multiplicityHigh: number;
  powFast: number;
  /** day level only */
  mixJsd?: number;
  step?: number;
}

export function trustOf(windowDays: 1 | 28, x: TrustInput, rejectedShare: number): TrustRow {
  if (x.pvRaw < 10)
    return {
      window_days: windowDays,
      score: null,
      components: {},
      reason_codes: ["insufficient_data"],
      decision_rate: null,
    };
  const c: TrustRow["components"] = {};
  const codes: string[] = [];
  const add = (
    key: keyof typeof WEIGHTS,
    value: number | null,
    p: number,
    code: string | null,
    explanation: string,
  ) => {
    c[key] = {
      value: value === null ? null : r4(value),
      p: r4(p),
      eco_percentile: null,
      explanation,
    };
    if (p > 0 && code) codes.push(code);
  };
  const cov = 1 - x.pvVerified / x.pvRaw;
  add(
    "proof_coverage",
    cov,
    lin(cov, 0.1, 0.6),
    "proof_coverage_low",
    "Share of page views without a valid proof of work.",
  );
  add(
    "network_quality",
    x.datacenterShare,
    lin(x.datacenterShare, 0.1, 0.5),
    "network_datacenter_share_high",
    "Share of events from data-centre, VPN or Tor networks.",
  );
  add(
    "multiplicity",
    x.multiplicityHigh,
    lin(x.multiplicityHigh, 0.05, 0.3),
    "multiplicity_share_high",
    "Share of events from crowded network buckets with low engagement.",
  );
  add(
    "engagement",
    x.engagementShare,
    lin(x.engagementShare, 0.2, 0.7),
    "engagement_low",
    "Share of page views with automation, hidden-page or no-activation signals.",
  );
  if (windowDays === 1 && x.mixJsd !== undefined)
    add(
      "mix",
      x.mixJsd,
      lin(x.mixJsd, 0.1, 0.5),
      x.mixJsd > 0.1 ? "mix_divergent_country" : null,
      "How far the day's country mix is from the previous 28 days.",
    );
  if (windowDays === 1 && x.step !== undefined)
    add(
      "temporal",
      x.step,
      lin(x.step, 3, 10),
      "step_change",
      "Page views of the day against the median of the previous 28 days.",
    );
  add(
    "pow_latency",
    x.powFast,
    lin(x.powFast, 0.05, 0.5),
    "pow_latency_implausible",
    "Share of proofs of work solved implausibly fast.",
  );
  add("cross_signal", null, 0, null, "Not configured in trust/1.0.0 (never penalised).");
  let penalty = 0;
  for (const [k, v] of Object.entries(c)) penalty += WEIGHTS[k as keyof typeof WEIGHTS] * v.p;
  const decided = Math.min(1, cov + rejectedShare);
  return {
    window_days: windowDays,
    score: Math.round(100 - penalty),
    components: c,
    reason_codes: codes,
    decision_rate: r4(decided),
  };
}

// ------------------------------------------------------------------ edge counters

export interface Counter {
  counter:
    | "verdict"
    | "reason"
    | "asn_class"
    | "pow_latency"
    | "multiplicity"
    | "identifier"
    | "kit_present_pageviews";
  label: string;
  count: number;
}

export function edgeCountersOf(
  site: WebsitePlan,
  t: DayTotals,
  shape: DayShape,
): { counters: Counter[]; trust: Omit<TrustInput, "mixJsd" | "step"> } {
  const verified = t.pageviews_verified + t.custom_verified;
  const all = t.pageviews_raw + t.custom_raw;
  const suspect = all - verified;
  const rejected = Math.round(all * 0.018);
  const dc = Math.round(suspect * 0.7 + all * 0.02);
  const counters: Counter[] = [
    { counter: "verdict", label: "verified", count: verified },
    { counter: "verdict", label: "suspect", count: suspect },
    { counter: "verdict", label: "rejected", count: rejected },
    { counter: "reason", label: "ua_bot", count: rejected },
    { counter: "reason", label: "proof_missing", count: Math.round(suspect * 0.55) },
    { counter: "reason", label: "net_datacenter", count: Math.round(suspect * 0.6) },
    { counter: "asn_class", label: "eyeball_mobile", count: Math.round((all - dc) * 0.55) },
    {
      counter: "asn_class",
      label: "eyeball_fixed",
      count: all - dc - Math.round((all - dc) * 0.55),
    },
    { counter: "asn_class", label: "datacenter", count: dc },
    { counter: "pow_latency", label: "100_300ms", count: Math.round(verified * 0.62) },
    { counter: "pow_latency", label: "300ms_1s", count: verified - Math.round(verified * 0.62) },
    { counter: "pow_latency", label: "lt100ms", count: Math.round(suspect * 0.2) },
    { counter: "pow_latency", label: "none", count: suspect - Math.round(suspect * 0.2) },
    { counter: "multiplicity", label: "one", count: Math.round(all * 0.9) },
    { counter: "multiplicity", label: "low", count: all - Math.round(all * 0.9) },
    { counter: "identifier", label: "identified", count: t.pageviews_raw },
  ];
  if (shape.spike)
    counters.push({ counter: "reason", label: "rate_anomaly", count: Math.round(suspect * 0.5) });
  if (site.wallet)
    counters.push({
      counter: "kit_present_pageviews",
      label: "all",
      count: Math.round(t.pageviews_raw * 0.34),
    });
  return {
    counters: counters.filter((c) => c.count > 0),
    trust: {
      pvVerified: t.pageviews_verified,
      pvRaw: t.pageviews_raw,
      datacenterShare: all > 0 ? dc / all : 0,
      engagementShare: all > 0 ? (suspect * 0.4 + all * 0.05) / all : 0,
      multiplicityHigh: 0,
      powFast: verified + suspect > 0 ? Math.round(suspect * 0.2) / (verified + suspect) : 0,
    },
  };
}

// ------------------------------------------------------------------ Stellar wallet events (web_event_property_daily)

export interface PropRow {
  event: string;
  network: "mainnet" | "testnet";
  key: string;
  value: string;
  verdict: "verified" | "suspect";
  count: number;
}

const WALLET_MIX: [string, number][] = [
  ["freighter", 44],
  ["xbull", 14],
  ["lobstr", 12],
  ["albedo", 6],
  ["hana", 6],
  ["passkey", 8],
  ["walletconnect", 5],
  ["rabet", 2],
  ["hot", 1],
  ["unknown", 2],
];

/** Largest-remainder split of `n` by weights (sums exactly to `n`). */
export function split(n: number, parts: [string, number][]): [string, number][] {
  const total = parts.reduce((a, [, w]) => a + w, 0);
  const raw = parts.map(([k, w]) => [k, (n * w) / total] as const);
  const out = raw.map(([k, v]) => [k, Math.floor(v)] as [string, number]);
  let left = n - out.reduce((a, [, v]) => a + v, 0);
  const order = raw
    .map(([, v], i) => [i, v - Math.floor(v)] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (const [i] of order) {
    if (left <= 0) break;
    (out[i] as [string, number])[1] += 1;
    left -= 1;
  }
  return out.filter(([, v]) => v > 0);
}

/** One day of wallet-event counts for a site, from its sessions (modal/connect) and funnel ratios for the rest. */
export function walletPropsOf(
  site: WebsitePlan,
  sessions: DemoSession[],
  passkeyProduct: boolean,
): PropRow[] {
  if (!site.wallet) return [];
  const count = (name: string, verified: boolean) =>
    sessions.reduce(
      (a, s) => a + (s.verified === verified ? s.events.filter((e) => e.name === name).length : 0),
      0,
    );
  const rows: PropRow[] = [];
  for (const verdict of ["verified", "suspect"] as const) {
    const v = verdict === "verified";
    const modal = count("wallet_modal_opened", v);
    const connect = count("wallet_connect", v);
    const selected = Math.round(modal * 0.72);
    const closed = Math.round(modal * 0.96);
    const disconnect = Math.round(connect * 0.08);
    const signReq = Math.round(connect * 0.9);
    const approved = Math.round(signReq * 0.84);
    const rejected = signReq - approved;
    const submitted = Math.round(approved * 0.93);
    const smart = passkeyProduct ? Math.round(connect * 0.2) : 0;
    const passkeyUsed = passkeyProduct ? Math.round(connect * 0.6) : 0;
    const events: [string, number, [string, [string, number][]][]][] = [
      ["wallet_modal_opened", modal, []],
      [
        "wallet_modal_closed",
        closed,
        [
          [
            "outcome",
            [
              ["connected", connect],
              ["dismissed", Math.max(0, closed - connect - 2)],
              ["error", 2],
            ],
          ],
        ],
      ],
      ["wallet_selected", selected, [["wallet", WALLET_MIX]]],
      [
        "wallet_connect",
        connect,
        [
          ["wallet", WALLET_MIX],
          [
            "connect_kind",
            [
              ["new", 62],
              ["restored", 38],
            ],
          ],
        ],
      ],
      ["wallet_disconnect", disconnect, [["wallet", WALLET_MIX]]],
      [
        "sign_requested",
        signReq,
        [
          ["wallet", WALLET_MIX],
          [
            "sign_kind",
            [
              ["tx", 80],
              ["auth_entry", 15],
              ["message", 5],
            ],
          ],
        ],
      ],
      [
        "sign_approved",
        approved,
        [
          ["wallet", WALLET_MIX],
          [
            "sign_kind",
            [
              ["tx", 80],
              ["auth_entry", 15],
              ["message", 5],
            ],
          ],
          [
            "duration",
            [
              ["lt5s", 58],
              ["5_30s", 36],
              ["gt30s", 6],
            ],
          ],
        ],
      ],
      [
        "sign_rejected",
        rejected,
        [
          ["wallet", WALLET_MIX],
          [
            "error_class",
            [
              ["user_rejected", 71],
              ["timeout", 12],
              ["external_service", 7],
              ["internal", 4],
              ["unsupported", 3],
              ["unknown", 3],
            ],
          ],
        ],
      ],
      [
        "tx_submitted",
        submitted,
        [
          [
            "result_class",
            [
              ["success", 91],
              ["failed", 4],
              ["pending", 3],
              ["try_again_later", 1],
              ["error", 1],
            ],
          ],
        ],
      ],
      ["smart_wallet_created", smart, [["wallet", [["passkey", 1]]]]],
      [
        "passkey_used",
        passkeyUsed,
        [
          [
            "passkey_op",
            [
              ["authenticate", 70],
              ["sign", 25],
              ["register", 5],
            ],
          ],
        ],
      ],
    ];
    for (const [event, n, props] of events) {
      for (const [network, share] of [
        ["mainnet", 1 - site.testnetShare],
        ["testnet", site.testnetShare],
      ] as const) {
        const m = Math.round(n * share);
        if (m <= 0) continue;
        rows.push({ event, network, key: "_total", value: "all", verdict, count: m });
        for (const [key, weights] of props)
          for (const [value, k] of split(m, weights))
            rows.push({ event, network, key, value, verdict, count: k });
      }
    }
  }
  return rows;
}

// ------------------------------------------------------------------ API metrics

/** explicit15 upper bounds in seconds (scf.explicit15_bounds()); the 15th bucket is open-ended. */
export const EXPLICIT15 = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

export interface RoutePlan {
  route: string;
  rpcMethod: string | null;
  method: number;
  share: number;
  medianMs: number;
  /** extra non-2xx status besides 404 (e.g. 402 for x402 routes) */
  status4xx: number;
  share4xx: number;
}

export function routesOf(api: ApiPlan): RoutePlan[] {
  const r = (
    route: string,
    method: number,
    share: number,
    medianMs: number,
    status4xx = 404,
    share4xx = 0.02,
    rpcMethod: string | null = null,
  ): RoutePlan => ({ route, rpcMethod, method, share, medianMs, status4xx, share4xx });
  switch (api.kind) {
    case "horizon":
      return [
        r("/accounts/{account_id}", 1, 0.38, 38),
        r("/transactions/{tx_hash}", 1, 0.22, 51),
        r("/paths/strict-send", 1, 0.12, 140),
        r("/fee_stats", 1, 0.15, 12),
        r("/ledgers/{ledger}", 1, 0.06, 30),
        r("/transactions", 3, 0.07, 420, 400, 0.05),
      ];
    case "rpc":
      return [
        r("/", 3, 0.34, 22, 400, 0.01, "getLedgerEntries"),
        r("/", 3, 0.18, 9, 400, 0.01, "getLatestLedger"),
        r("/", 3, 0.16, 85, 400, 0.03, "simulateTransaction"),
        r("/", 3, 0.12, 30, 400, 0.02, "getTransaction"),
        r("/", 3, 0.08, 160, 400, 0.04, "sendTransaction"),
        r("/", 3, 0.12, 60, 400, 0.02, "getEvents"),
      ];
    case "x402":
      return [
        r("/v1/data/{id}", 1, 0.62, 70, 402, 0.31),
        r("/v1/settle", 3, 0.2, 640, 400, 0.03),
        r("/health", 1, 0.18, 4),
      ];
    default:
      return [
        r("/v1/quotes", 1, 0.3, 45),
        r("/v1/payments", 3, 0.2, 230, 400, 0.04),
        r("/v1/payments/{id}", 1, 0.25, 28),
        r("/v1/accounts/{id}", 1, 0.15, 33),
        r("/v1/webhooks", 3, 0.05, 90),
        r("/health", 1, 0.05, 3),
      ];
  }
}

function normCdf(z: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** A log-normal latency histogram over the explicit15 buckets (counts sum to `n`) and its duration sum (s). */
export function histogram(
  n: number,
  medianMs: number,
  sigma = 0.65,
): { hist: number[]; sum: number } {
  const mu = Math.log(medianMs / 1000);
  const cdf = EXPLICIT15.map((b) => normCdf((Math.log(b) - mu) / sigma));
  const probs = [...cdf, 1].map((c, i) => c - (i === 0 ? 0 : (cdf[i - 1] as number)));
  const hist = split(
    n,
    probs.map((p, i) => [String(i), p] as [string, number]),
  );
  const out = Array.from({ length: 15 }, () => 0);
  for (const [i, v] of hist) out[Number(i)] = v;
  const mean = Math.exp(mu + (sigma * sigma) / 2);
  return { hist: out, sum: Math.round(n * mean * 1000) / 1000 };
}

export interface ApiRow {
  route: string;
  rpcMethod: string | null;
  method: number;
  status: number;
  count: number;
  hist: number[];
  sum: number;
}

/** The rows of one bucket (day or hour) with `total` requests. */
export function apiRowsOf(api: ApiPlan, total: number, rateFactor = 1): ApiRow[] {
  const out: ApiRow[] = [];
  for (const rt of routesOf(api)) {
    const n = Math.round(total * rt.share);
    if (n <= 0) continue;
    const n5 = Math.round(n * api.errorRate5xx * rateFactor);
    const n4 = Math.round(n * rt.share4xx);
    const n2 = Math.max(0, n - n4 - n5);
    for (const [status, k, factor] of [
      [rt.method === 3 && rt.route !== "/" ? 201 : 200, n2, 1],
      [rt.status4xx, n4, 0.4],
      [500, n5, 2.5],
    ] as const) {
      if (k <= 0) continue;
      const h = histogram(k, rt.medianMs * factor);
      out.push({
        route: rt.route,
        rpcMethod: rt.rpcMethod,
        method: rt.method,
        status,
        count: k,
        hist: h.hist,
        sum: h.sum,
      });
    }
  }
  return out;
}

/** Daily request volume of a service: trend, weekly rhythm and noise. */
export function apiDayTotal(
  api: ApiPlan,
  phrase: string,
  day: string,
  daysBack: number,
  historyDays: number,
): number {
  const r = rngFor(phrase, `api:${api.serviceName}:${day}`);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const weekly = dow === 0 || dow === 6 ? 0.7 : 1.08;
  const trend = 1 - 0.35 * Math.min(1, daysBack / historyDays);
  return Math.max(
    0,
    Math.round(api.baseRequests * trend * weekly * Math.max(0.5, 1 + 0.07 * gauss(r))),
  );
}

/** Diurnal shape: share of a day's requests in each UTC hour (sums to 1). */
export const HOURLY_SHAPE = (() => {
  const w = Array.from(
    { length: 24 },
    (_, h) => 0.55 + 0.45 * Math.sin(((h - 8) / 24) * 2 * Math.PI),
  );
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
})();

export interface AssuranceRow {
  level: 0 | 1 | 2;
  onchain_badge: "consistent" | "inconsistent" | "not_applicable" | "unavailable";
  reason_codes: string[];
  checks: Record<string, { pass: boolean; codes: string[] }>;
}

export function assuranceOf(t: TenantPlan): AssuranceRow | null {
  if (!t.api) return null;
  const verified = t.contracts.some((c) => c.verified);
  const level = t.api.assurance;
  const a2codes = level >= 2 ? [] : ["a2_probe_failed"];
  const a3codes = verified ? [] : ["a3_no_verified_contract"];
  return {
    level,
    onchain_badge: verified ? "consistent" : "not_applicable",
    reason_codes: [...(level >= 1 ? [] : ["a1_rate_implausible"]), ...a2codes, ...a3codes],
    checks: {
      A1: { pass: level >= 1, codes: level >= 1 ? [] : ["a1_rate_implausible"] },
      A2: { pass: level >= 2, codes: a2codes },
      A3: { pass: verified, codes: a3codes },
    },
  };
}

// ------------------------------------------------------------------ on-chain

export function onchainDayOf(
  c: ContractPlan,
  phrase: string,
  day: string,
  daysBack: number,
  historyDays: number,
) {
  const r = rngFor(phrase, `chain:${c.contractId}:${day}`);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const weekly = dow === 0 || dow === 6 ? 0.85 : 1.04;
  const trend = 1 - 0.4 * Math.min(1, daysBack / historyDays);
  const invocations = Math.max(
    0,
    Math.round(c.baseInvocations * trend * weekly * Math.max(0.4, 1 + 0.12 * gauss(r))),
  );
  const successful = Math.round(invocations * (0.93 + 0.05 * r()));
  const invokers = Math.max(invocations > 0 ? 1 : 0, Math.round(invocations * (0.18 + 0.12 * r())));
  return { invocations, successful, invokers };
}
