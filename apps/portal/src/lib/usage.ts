// SPDX-License-Identifier: Apache-2.0
// Pure rules behind the project overview's "verified usage" panel (plan D-1), the trust view (D-2) and the band
// chart's anomaly markers (D-3). Every rule restates a contract so the tenant sees what an operator or a snapshot
// reader sees (decision D6):
//   - trust band: high ≥ 80, medium ≥ 50, low below, unscored when the score is null (the operator filter, C-28);
//   - an open anomaly flag is a (site, day, reason code) of a 1-day trust score, code ≠ insufficient_data, not covered
//     by an annotation of that site whose range holds the day and that names the code or marks the day explained
//     (wire-formats §i.3.2, D10);
//   - confidence follows methodology scf-methodology/1.0.0 (§i.3.2): insufficient without enough data, otherwise
//     high / medium / low by the number of reasons;
//   - on-chain counts come from verified contracts only; the stored network `public` is shown as `mainnet` (C-137).

import type { ControlPlane } from "@usagemap/api-types";

type TrustScore = ControlPlane.TrustScore;
type Annotation = ControlPlane.Annotation;
type OnchainDay = ControlPlane.OnchainDay;

export type TrustBand = "high" | "medium" | "low" | "unscored";

export function trustBand(score: number | null | undefined): TrustBand {
  if (score === null || score === undefined) return "unscored";
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}

export const BAND_TEXT: Record<TrustBand, string> = {
  high: "high",
  medium: "medium",
  low: "low",
  unscored: "not scored yet",
};

/** wire-formats §h.4, in plain language. */
export const TRUST_REASON_TEXT: Record<string, string> = {
  proof_coverage_low: "Few page views carried a valid browser proof",
  network_datacenter_share_high: "A high share of traffic came from data-centre networks",
  multiplicity_share_high: "Many events repeated from the same browser and network",
  engagement_low: "Visits showed unusually little engagement",
  hidden_share_high: "Many page views came from hidden or background tabs",
  duration_entropy_low: "Visit durations were unusually uniform",
  mix_divergent_device: "The device mix differs sharply from this site's usual mix",
  mix_divergent_country: "The country mix differs sharply from this site's usual mix",
  night_share_high: "An unusual share of traffic arrived at night",
  step_change: "Traffic jumped abruptly compared with the previous days",
  burstiness_high: "Traffic arrived in sharp bursts",
  pow_latency_implausible: "Proof-of-work timings were implausible for real browsers",
  cross_signal_inconsistent: "Independent signals disagreed with each other",
  insufficient_data: "Too few page views to score",
};

/** wire-formats §h.5. */
export const ASSURANCE_REASON_TEXT: Record<string, string> = {
  a1_rate_implausible: "Request rate is implausible",
  a1_status_mix_implausible: "Status-code mix is implausible",
  a1_latency_implausible: "Latency distribution is implausible",
  a1_route_profile_implausible: "Route profile is implausible",
  a2_no_base_url: "No public base URL to probe",
  a2_probe_failed: "Our probes of the public base URL failed",
  a3_no_verified_contract: "No verified contract to compare with",
  a3_onchain_inconsistent: "API volume and on-chain activity disagree",
  a3_not_applicable: "On-chain comparison does not apply",
};

export const reasonText = (code: string): string => TRUST_REASON_TEXT[code] ?? code;

/** The newest 28-day score of a site (the figure the operator console shows). */
export function latestWindowScore(scores: readonly TrustScore[]): TrustScore | null {
  let best: TrustScore | null = null;
  for (const s of scores) {
    if (s.window_days !== 28) continue;
    if (!best || s.day > best.day) best = s;
  }
  return best;
}

export interface AnomalyFlag {
  site_id: string;
  day: string;
  codes: string[];
  score: number | null;
  /** annotations of that site whose range holds the day */
  annotations: Annotation[];
  /** every code is explained by an annotation (or the day is marked explained) */
  explained: boolean;
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** Annotations of `siteId` whose half-open range [start, end) holds `day` (YYYY-MM-DD). */
export function annotationsFor(
  annotations: readonly Annotation[],
  siteId: string,
  day: string,
): Annotation[] {
  return annotations.filter(
    (a) => a.site_id === siteId && dayOf(a.start) <= day && day < dayOf(a.end),
  );
}

/** Days with reason codes from the 1-day scores, newest first, with the annotations that cover them. */
export function anomalyFlags(
  scores: readonly TrustScore[],
  annotations: readonly Annotation[],
): AnomalyFlag[] {
  const out: AnomalyFlag[] = [];
  for (const s of scores) {
    if (s.window_days !== 1) continue;
    const codes = s.reason_codes.filter((c) => c !== "insufficient_data");
    if (codes.length === 0) continue;
    const anns = annotationsFor(annotations, s.site_id, s.day);
    const explained = codes.every((c) =>
      anns.some((a) => a.marks_explained === true || (a.explains_reason_codes ?? []).includes(c)),
    );
    out.push({
      site_id: s.site_id,
      day: s.day,
      codes,
      score: s.score,
      annotations: anns,
      explained,
    });
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** D10 count: open (site, day, code) triples. */
export function openFlagCount(flags: readonly AnomalyFlag[]): number {
  let n = 0;
  for (const f of flags)
    for (const c of f.codes)
      if (
        !f.annotations.some(
          (a) => a.marks_explained === true || (a.explains_reason_codes ?? []).includes(c),
        )
      )
        n++;
  return n;
}

export type Network = "mainnet" | "testnet";
export const networkName = (n: string): string => (n === "public" ? "mainnet" : n);

export interface OnchainTotals {
  network: Network;
  verifiedContracts: number;
  invocations: number;
  successful: number;
  invokersDailySum: number;
  days: number;
}

/** Sums of verified contracts on one network (C-136 on-chain rule). */
export function onchainTotals(rows: readonly OnchainDay[], network: Network): OnchainTotals {
  const mine = rows.filter(
    (r) => r.contract_status === "verified" && networkName(r.network) === network,
  );
  return {
    network,
    verifiedContracts: new Set(mine.map((r) => r.contract_id)).size,
    invocations: mine.reduce((a, r) => a + r.invocations, 0),
    successful: mine.reduce((a, r) => a + (r.successful_invocations ?? 0), 0),
    invokersDailySum: mine.reduce((a, r) => a + (r.distinct_invokers ?? 0), 0),
    days: new Set(mine.map((r) => r.day)).size,
  };
}

export type ConfidenceLevel = "high" | "medium" | "low" | "insufficient";
export type ConfidenceReason =
  | "few_events"
  | "partial_coverage"
  | "high_suspect_share"
  | "open_anomaly_flags"
  | "domain_unverified"
  | "no_verified_contracts";

export const CONFIDENCE_REASON_TEXT: Record<ConfidenceReason, string> = {
  few_events: "few page views for the period",
  partial_coverage: "web events on fewer than 80% of the days",
  high_suspect_share: "more than 30% of page views were suspect",
  open_anomaly_flags: "open anomaly flags",
  domain_unverified: "no verified domain (level L0)",
  no_verified_contracts: "on-chain correlation is on but no contract is verified",
};

export interface ConfidenceInput {
  days: number;
  rawPageviews: number;
  daysWithEvents: number;
  suspectShare: number | null;
  openFlags: number;
  level: string;
  hasApi: boolean;
  onchainEnabled: boolean;
  verifiedContracts: number;
  /** op_min_count (10) */
  minCount?: number;
}

/** scf-methodology/1.0.0 (wire-formats §i.3.2), without `days_not_final`, which only a snapshot can know. */
export function confidence(i: ConfidenceInput): {
  level: ConfidenceLevel;
  reasons: ConfidenceReason[];
} {
  const min = i.minCount ?? 10;
  const hasOnchain = i.onchainEnabled && i.verifiedContracts > 0;
  if (i.rawPageviews < min && !i.hasApi && !hasOnchain)
    return { level: "insufficient", reasons: [] };
  const reasons: ConfidenceReason[] = [];
  if (i.rawPageviews < 10 * i.days) reasons.push("few_events");
  if (i.daysWithEvents < 0.8 * i.days) reasons.push("partial_coverage");
  if (i.suspectShare !== null && i.suspectShare > 0.3) reasons.push("high_suspect_share");
  if (i.openFlags > 0) reasons.push("open_anomaly_flags");
  if (i.level === "L0") reasons.push("domain_unverified");
  if (i.onchainEnabled && i.verifiedContracts === 0) reasons.push("no_verified_contracts");
  const level = reasons.length === 0 ? "high" : reasons.length === 1 ? "medium" : "low";
  return { level, reasons };
}
