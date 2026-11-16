// SPDX-License-Identifier: Apache-2.0
// Advisory web trust score, algorithm `trust/1.0.0` (ADR-0008 L7, ADR-0028, C-44, CR-35; wire-formats §h.4).
// Published here with its thresholds; the weights are the platform setting `trust_weights` (data-model §7.1) and the
// version the setting `trust_algorithm_version`. The worked examples in test/unit/trust.test.ts are the reference.
//
//   T = round(100 − Σ_i w_i · p_i),  Σ w_i = 100,  p_i ∈ [0, 1]
//   p_i = clamp((value_i − lo_i) / (hi_i − lo_i), 0, 1)       (piecewise linear between the published thresholds)
//
// | component        | value (from aggregates only; no event-level reads)                              | lo   | hi   | code                            |
// |------------------|----------------------------------------------------------------------------------|------|------|---------------------------------|
// | proof_coverage   | 1 − pageviews_verified / pageviews_raw (web_daily_totals)                        | 0.10 | 0.60 | proof_coverage_low              |
// | network_quality  | (datacenter + vpn + tor) / all asn_class counts (relay and mobile not numerator) | 0.10 | 0.50 | network_datacenter_share_high   |
// | multiplicity     | high / all multiplicity counts                                                   | 0.05 | 0.30 | multiplicity_share_high         |
// | engagement       | (webdriver + hidden + no_activation) / (all verdicts − not_collected), ≤ 1         | 0.20 | 0.70 | engagement_low                  |
// | mix              | max JSD(device, country page-view mix of the day ‖ the site's previous 28 days)  | 0.10 | 0.50 | mix_divergent_device / _country |
// | temporal         | max(step: day page views ÷ median of previous 28 days, mapped 3→0 … 10→1;        |      |      | step_change / burstiness_high   |
// |                  |     burst: largest hourly share of the day's page views, 0.25→0 … 0.75→1)        |      |      |                                 |
// | pow_latency      | lt100ms / pow_latency counts except none                                          | 0.05 | 0.50 | pow_latency_implausible         |
// | cross_signal     | neutral (p = 0) in 1.0.0: never penalise a signal that is not configured          |  —   |  —   | —                               |
//
// A component without input (no counters, a `strict` site without client signals, < 7 days of history for mix and
// step, no hourly rows for burst) is `omitted` and contributes p = 0 — never scored as missing (C-33). Every component with p > 0 emits its
// code. Below `op_min_count` raw page views in the window the score is NULL with the single code
// `insufficient_data` and no components (CR-35). `decision_rate` = (suspect + rejected) ÷ all verdict counts (MRC).
// The 28-day window sums the counters and totals of the 28 days ending with the day; mix and temporal are day-level
// signals and are omitted there. Ecosystem percentiles (`eco_percentile`) are attached only when at least
// `ecosystem_percentile_min_tenants` (20) tenants are active (C-44); they are informational in 1.0.0 — the thresholds
// above are absolute, because they have not been calibrated yet (ADR-0028 open point 1).

export const ALGORITHM_VERSION = "trust/1.0.0";

export type Weights = Record<
  | "proof_coverage"
  | "network_quality"
  | "multiplicity"
  | "engagement"
  | "mix"
  | "temporal"
  | "pow_latency"
  | "cross_signal",
  number
>;

export const THRESHOLDS = {
  proof_coverage: [0.1, 0.6],
  network_quality: [0.1, 0.5],
  multiplicity: [0.05, 0.3],
  engagement: [0.2, 0.7],
  mix: [0.1, 0.5],
  step: [3, 10],
  burst: [0.25, 0.75],
  pow_latency: [0.05, 0.5],
} as const;

export const MIN_HISTORY_DAYS = 7;

/** Counter label → count for one counter (web_edge_counters.counter). */
export type Counts = Record<string, number>;

export interface SiteInputs {
  pageviewsRaw: number;
  pageviewsVerified: number;
  counters: Partial<
    Record<"verdict" | "asn_class" | "multiplicity" | "client_signal" | "pow_latency", Counts>
  >;
  /** Day-level only: page-view mix of the day and of the baseline (previous 28 days), per dimension. */
  mix?: { device: [Counts, Counts]; country: [Counts, Counts] };
  /** Day-level only: the day's page views per hour (24) and the previous days' daily page views. */
  hourly?: number[];
  history?: number[];
}

export interface Component {
  value: number | null;
  p: number;
  eco_percentile: number | null;
  omitted?: true;
  code?: string;
}

export interface TrustResult {
  score: number | null;
  components: Record<string, Component>;
  reason_codes: string[];
  decision_rate: number | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lin = (v: number, [lo, hi]: readonly [number, number]) => clamp01((v - lo) / (hi - lo));
const sum = (c: Counts | undefined, keys?: string[]) =>
  Object.entries(c ?? {}).reduce(
    (a, [k, n]) => (keys === undefined || keys.includes(k) ? a + n : a),
    0,
  );
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

function share(c: Counts | undefined, num: string[], exclude: string[] = []): number | null {
  const den = Object.entries(c ?? {}).reduce((a, [k, n]) => (exclude.includes(k) ? a : a + n), 0);
  if (den <= 0) return null;
  return sum(c, num) / den;
}

/** Jensen–Shannon divergence (base 2, in [0, 1]) of two count distributions; null when either is empty. */
export function jsd(a: Counts, b: Counts): number | null {
  const ta = sum(a);
  const tb = sum(b);
  if (ta <= 0 || tb <= 0) return null;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let d = 0;
  for (const k of keys) {
    const p = (a[k] ?? 0) / ta;
    const q = (b[k] ?? 0) / tb;
    const m = (p + q) / 2;
    if (p > 0) d += 0.5 * p * Math.log2(p / m);
    if (q > 0) d += 0.5 * q * Math.log2(q / m);
  }
  return clamp01(d);
}

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

const omitted = (): Component => ({ value: null, p: 0, eco_percentile: null, omitted: true });
const comp = (value: number, p: number, code: string): Component => ({
  value: round4(value),
  p: round4(p),
  eco_percentile: null,
  ...(p > 0 ? { code } : {}),
});

export function scoreSite(inp: SiteInputs, weights: Weights, minCount: number): TrustResult {
  const v = inp.counters.verdict;
  const verdicts = sum(v);
  const decision_rate = verdicts > 0 ? round4(sum(v, ["suspect", "rejected"]) / verdicts) : null;
  if (inp.pageviewsRaw < minCount) {
    return { score: null, components: {}, reason_codes: ["insufficient_data"], decision_rate };
  }
  const c: Record<string, Component> = {};
  c.proof_coverage = (() => {
    const x = 1 - inp.pageviewsVerified / inp.pageviewsRaw;
    return comp(x, lin(x, THRESHOLDS.proof_coverage), "proof_coverage_low");
  })();
  const net = share(inp.counters.asn_class, ["datacenter", "vpn", "tor"]);
  c.network_quality =
    net === null
      ? omitted()
      : comp(net, lin(net, THRESHOLDS.network_quality), "network_datacenter_share_high");
  const mult = share(inp.counters.multiplicity, ["high"]);
  c.multiplicity =
    mult === null
      ? omitted()
      : comp(mult, lin(mult, THRESHOLDS.multiplicity), "multiplicity_share_high");
  // client_signal counts events that carried a signal (several per event possible); the base is every event with a
  // verdict whose signals were collected (`strict` traffic is `not_collected`, C-33).
  const sig = inp.counters.client_signal;
  const engDen = verdicts - (sig?.not_collected ?? 0);
  const eng =
    engDen > 0 ? Math.min(1, sum(sig, ["webdriver", "hidden", "no_activation"]) / engDen) : null;
  c.engagement =
    eng === null ? omitted() : comp(eng, lin(eng, THRESHOLDS.engagement), "engagement_low");
  const pow = share(inp.counters.pow_latency, ["lt100ms"], ["none"]);
  c.pow_latency =
    pow === null
      ? omitted()
      : comp(pow, lin(pow, THRESHOLDS.pow_latency), "pow_latency_implausible");

  if (inp.mix && (inp.history?.length ?? 0) >= MIN_HISTORY_DAYS) {
    const dev = jsd(...inp.mix.device);
    const cty = jsd(...inp.mix.country);
    const pd = dev === null ? 0 : lin(dev, THRESHOLDS.mix);
    const pc = cty === null ? 0 : lin(cty, THRESHOLDS.mix);
    if (dev === null && cty === null) c.mix = omitted();
    else if (pd >= pc) c.mix = comp(dev ?? 0, pd, "mix_divergent_device");
    else c.mix = comp(cty ?? 0, pc, "mix_divergent_country");
  } else c.mix = omitted();

  {
    // Step needs ≥ 7 days of history; burst only the day's own hourly page views (web_hourly_totals, migration
    // 0057), so it is scored without history. Either half alone is enough; ties go to step.
    let step: number | null = null;
    if (inp.history && inp.history.length >= MIN_HISTORY_DAYS) {
      const med = median(inp.history);
      step = med > 0 ? inp.pageviewsRaw / med : null;
    }
    const total = inp.hourly ? inp.hourly.reduce((a, b) => a + b, 0) : 0;
    const burst = inp.hourly && total > 0 ? Math.max(...inp.hourly) / total : null;
    const ps = step === null ? 0 : lin(step, THRESHOLDS.step);
    const pb = burst === null ? 0 : lin(burst, THRESHOLDS.burst);
    if (step === null && burst === null) c.temporal = omitted();
    else if (burst === null || (step !== null && ps >= pb))
      c.temporal = comp(step ?? 0, ps, "step_change");
    else c.temporal = comp(burst, pb, "burstiness_high");
  }

  c.cross_signal = omitted();

  let penalty = 0;
  for (const [k, x] of Object.entries(c)) penalty += (weights[k as keyof Weights] ?? 0) * x.p;
  const reason_codes = Object.values(c)
    .filter((x) => x.p > 0 && x.code)
    .map((x) => x.code as string);
  return {
    score: Math.max(0, Math.min(100, Math.round(100 - penalty))),
    components: c,
    reason_codes,
    decision_rate,
  };
}

/** Percentile rank (0–100, "≤" semantics) of `x` among `all`. */
export function percentileRank(x: number, all: number[]): number {
  if (all.length === 0) return 0;
  return Math.round((100 * all.filter((y) => y <= x).length) / all.length);
}

export function validWeights(w: unknown): Weights {
  const keys: (keyof Weights)[] = [
    "proof_coverage",
    "network_quality",
    "multiplicity",
    "engagement",
    "mix",
    "temporal",
    "pow_latency",
    "cross_signal",
  ];
  if (typeof w !== "object" || w === null) throw new Error("trust_weights is not an object");
  const o = w as Record<string, unknown>;
  const out = {} as Weights;
  let total = 0;
  for (const k of keys) {
    const n = o[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
      throw new Error("trust_weights has an invalid weight");
    out[k] = n;
    total += n;
  }
  if (Math.abs(total - 100) > 1e-9) throw new Error("trust_weights must sum to 100");
  return out;
}
