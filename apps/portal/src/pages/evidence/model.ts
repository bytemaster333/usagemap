// SPDX-License-Identifier: Apache-2.0
// The view model of the SCF Evidence Link page (traction snapshot v3; v2 documents shown with what they have). Pure:
// it reads only the signed document the public endpoint serves, so the page shows nothing the signature does not
// cover. Wording rule C4: a measurement, never an endorsement; a testnet seal is labelled a demonstration.

export type Preset =
  | "build_tranche"
  | "growth_hack_before"
  | "growth_hack_during"
  | "pg_renewal_quarter"
  | "custom";

export const SCHEMA_V2 = "scf-analytics/traction-snapshot/2";
export const SCHEMA_V3 = "scf-analytics/traction-snapshot/3";

/** What each preset window means, for a reader who does not know the SCF programmes. */
export const PRESET_EXPLAINED: Record<Preset, string> = {
  build_tranche:
    "The dates of an SCF Build award period, chosen by the project: usage measured during the period it reports on.",
  growth_hack_before:
    "The weeks before a Growth Hack campaign (whole ISO weeks): the baseline a campaign is compared with.",
  growth_hack_during:
    "A Growth Hack campaign (whole ISO weeks), compared week by week with the same number of weeks right before it.",
  pg_renewal_quarter:
    "One calendar quarter, as a Public Goods renewal reports it, compared with the quarter before.",
  custom: "A period the project chose.",
};

export const STAGE_TEXT: Record<string, string> = {
  web_visitors: "Web visitors (daily, summed)",
  wallet_connects: "Wallet connects",
  signatures: "Signatures",
  onchain_calls: "On-chain calls",
};

export const POSITION_TEXT: Record<string, string> = {
  shown: "",
  low_confidence: "not compared: this snapshot's confidence is too low",
  not_eligible: "not compared: the project's domain is not verified",
  not_enough_data: "not compared: too little data in this period",
  not_enough_projects: "not enough projects to compare",
};

export const METRIC_TEXT: Record<string, string> = {
  web_visitors_verified: "verified web visitors",
  onchain_calls: "on-chain calls",
};

export const CONFIDENCE_REASON_TEXT: Record<string, string> = {
  few_events: "few events for the length of the period",
  partial_coverage: "web events on fewer than 80% of the days",
  days_not_final: "some days are not final yet",
  high_suspect_share: "more than 30% of page views were suspect",
  open_anomaly_flags: "open anomaly flags in the period",
  domain_unverified: "the project's domain is not verified",
  no_verified_contracts: "on-chain correlation is on, but no contract is verified",
};

export const CATEGORY_TEXT: Record<string, string> = {
  end_user_application: "End-User Application",
  financial_protocols: "Financial Protocols",
  applications: "Applications",
  developer_tooling: "Developer Tooling",
  infrastructure_services: "Infrastructure & Services",
};

export function cohortName(c: { kind: string; id: string }): string {
  return c.kind === "round" ? `SCF round ${c.id}` : (CATEGORY_TEXT[c.id] ?? c.id);
}

export interface FunnelStage {
  stage: string;
  verified: number | null;
  raw: number | null;
}
export interface FunnelDay {
  day: string;
  web_visitors_verified: number | null;
  web_visitors_raw: number | null;
  wallet_connects_verified: number | null;
  wallet_connects_raw: number | null;
  signatures_verified: number | null;
  signatures_raw: number | null;
  onchain_calls: number | null;
  onchain_calls_successful: number | null;
}
export interface Funnel {
  network: string;
  min_count: number;
  stages: FunnelStage[];
  conversion: { connects_per_visitor: number | null; signatures_per_connect: number | null };
  daily: FunnelDay[];
  suppressed_cells: number;
}
export interface Position {
  cohort: { kind: string; id: string };
  metric: string;
  status: string;
  projects: number | null;
  percentile: number | null;
}

/** The parts of a v2/v3 document the page shows (wire-formats §i.3.2, §i.3.5). */
export interface EvidenceDoc {
  schema: string;
  snapshot_id: string;
  issued_at: string;
  issuer: string;
  project: { slug: string; name: string; verification_level: string; registry_matches: string[] };
  series: { seq: number; previous_sha256: string | null };
  period: { start: string; end: string; days: number };
  preset: Preset;
  methodology: { version: string; url: string };
  web: {
    verified: { pageviews: number; visitors_sum: number };
    raw: { pageviews: number; visitors_sum: number };
    visit_metrics: { suspect_pageview_share: number | null };
  };
  api: null | {
    label: string;
    requests: number;
    error_rate_5xx: number | null;
    p95_ms: number | null;
    assurance_level: string | null;
    onchain_consistent: string | null;
  };
  onchain: null | {
    network: string;
    verified_contracts: number;
    invocations: number;
    successful_invocations: number;
    distinct_invokers_daily_sum: number;
  };
  coverage: {
    days_in_period: number;
    web_days_with_events: number;
    web_days_final: number;
    api_days_with_data: number | null;
    onchain_days_complete: number | null;
  };
  confidence: { level: string; reasons: string[] };
  anomaly_flags: { open_web: number; open_api: number };
  seal: { enabled: boolean; network: string | null; proof_url: string | null };
  links: { verify: string; public_list: string; definitions?: string; evidence?: string };
  text?: string;
  // v3 only
  funnel?: Funnel;
  programme?: null | Record<string, unknown>;
  comparison?: { status: string; min_projects: number; min_value: number; positions: Position[] };
  wording?: { statement: string; seal: string };
}

/** A document the page can show (v2 or v3); null for v1 or anything else. */
export function asEvidence(snapshot: unknown): EvidenceDoc | null {
  const s = snapshot as { schema?: unknown } | null;
  if (!s || (s.schema !== SCHEMA_V2 && s.schema !== SCHEMA_V3)) return null;
  return s as EvidenceDoc;
}

/** The C4 statement (v2 documents do not carry one). */
export function wordingOf(doc: EvidenceDoc): { statement: string; seal: string } {
  if (doc.wording) return doc.wording;
  return {
    statement:
      "A measurement by this service, not an endorsement: SCF and SDF have not reviewed or approved these figures.",
    seal: !doc.seal.enabled
      ? "not sealed"
      : doc.seal.network === "testnet"
        ? "sealed on Stellar testnet: a demonstration, not a permanent record"
        : "sealed on Stellar mainnet",
  };
}

/** Each funnel stage's share of the first stage (verified), for the bars; null when a side is withheld. */
export function stageShares(stages: FunnelStage[]): Array<FunnelStage & { share: number | null }> {
  const first = stages[0]?.verified ?? null;
  return stages.map((s) => ({
    ...s,
    share: first && s.verified !== null ? Math.min(1, s.verified / first) : null,
  }));
}

/** A count the document withholds (C-137 floor) reads "fewer than k", never 0. */
export function cellText(v: number | null, k: number, fmt: (n: number) => string): string {
  return v === null ? `fewer than ${k}` : fmt(v);
}

export interface GrowthHackView {
  campaign: { start: string; end: string; weeks: number };
  baseline: { start: string; end: string; weeks: number };
  active_account_definition: string;
  averages: {
    baseline: Record<string, number | null>;
    campaign: Record<string, number | null>;
    change: Record<string, number | null>;
    ratio: Record<string, number | null>;
  };
  weekly: Array<Record<string, unknown> & { start: string; window: string }>;
  cohort_share: {
    status: string;
    cohort: { kind: string; id: string } | null;
    projects: number | null;
    share: number | null;
  };
  ambiguities: string[];
}

export interface PublicGoodsView {
  quarter: string;
  previous_quarter: { label: string; start: string; end: string };
  figures: Array<{
    metric: string;
    value: number | null;
    previous: number | null;
    change: number | null;
  }>;
  monthly: Array<{
    start: string;
    onchain_calls: number | null;
    web_visitors_verified: number;
    api_requests: number | null;
  }>;
  not_measured: string[];
  ambiguities: string[];
}

export function growthHackOf(doc: EvidenceDoc): GrowthHackView | null {
  return doc.programme?.kind === "growth_hack"
    ? (doc.programme as unknown as GrowthHackView)
    : null;
}
export function publicGoodsOf(doc: EvidenceDoc): PublicGoodsView | null {
  return doc.programme?.kind === "public_goods"
    ? (doc.programme as unknown as PublicGoodsView)
    : null;
}

export const PG_METRIC_TEXT: Record<string, string> = {
  onchain_calls: "On-chain calls",
  onchain_successful_calls: "Successful on-chain calls",
  onchain_invokers_daily_sum: "Invoking accounts (daily, summed)",
  web_visitors_verified: "Verified web visitors (daily, summed)",
  web_pageviews_verified: "Verified page views",
  api_requests: "API requests (self-attested)",
  api_error_rate_5xx: "API 5xx error rate",
  api_p95_ms: "API p95 latency (ms)",
};

export const COHORT_SHARE_TEXT: Record<string, string> = {
  shown: "",
  not_enough_projects: "not enough projects to compare",
  no_increase: "no increase to share in this cohort",
  no_cohort: "no confirmed SCF registry link",
  no_onchain_data: "no on-chain figures for this project",
};

/** Sentences the page must never contain (C4; Official Rules §3A(e)). */
export const FORBIDDEN_WORDING =
  /SCF[- ]verified|SDF[- ]approved|endorsed by (SCF|SDF)|certified by/i;
