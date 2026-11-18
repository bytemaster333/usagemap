// SPDX-License-Identifier: Apache-2.0
// SCF operator console: wording, number formats, sorting and the search parameters of the web and API pages. No data
// fetching here; every figure the pages show comes from the control plane (this module only labels and orders it).

import type { ControlPlane } from "@usagemap/api-types";
import { parseOperatorSearch } from "../../lib/search.ts";

export type AwardStage = ControlPlane.AwardStage;
export type ScfCategory = ControlPlane.ScfCategory;

export const STAGE_SHORT: Record<AwardStage, string> = {
  t0_prelaunch: "Pre-launch #0",
  t1_mvp: "MVP #1",
  t2_testnet: "Testnet #2",
  t3_mainnet: "Mainnet #3",
};

export const CATEGORY_SHORT: Record<ScfCategory, string> = {
  end_user_application: "End-user app",
  financial_protocols: "Financial protocol",
  applications: "Application",
  developer_tooling: "Developer tooling",
  infrastructure_services: "Infrastructure",
};

export const STAGES = Object.keys(STAGE_SHORT) as AwardStage[];
export const CATEGORIES = Object.keys(CATEGORY_SHORT) as ScfCategory[];

/** "Round 34 · Mainnet #3 · Financial protocol" from whatever the registry states (nothing invented). */
export function awardLine(r: {
  award_round?: number | null | undefined;
  award_stage?: AwardStage | null | undefined;
  categories?: ScfCategory[] | undefined;
}): string {
  const parts: string[] = [];
  if (r.award_round !== null && r.award_round !== undefined) parts.push(`Round ${r.award_round}`);
  if (r.award_stage) parts.push(STAGE_SHORT[r.award_stage]);
  const c = r.categories?.[0];
  if (c) parts.push(CATEGORY_SHORT[c]);
  return parts.join(" · ") || "No SCF award on record";
}

// ---------------------------------------------------------------------------------------------- numbers

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** The design's compact numbers: 9,840 · 41.2k · 412k · 1.84M. Exact below 10,000. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return INT.format(Math.round(n));
}

export function fmtExact(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : INT.format(Math.round(n));
}

/** A share in [0, 1] → "6.0%" (digits configurable). */
export function fmtShareD(s: number | null | undefined, digits = 1): string {
  return s === null || s === undefined ? "—" : `${(s * 100).toFixed(digits)}%`;
}

/** Seconds → "1m 52s". */
export function fmtMinSec(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  const r = Math.round(s);
  return `${Math.floor(r / 60)}m ${String(r % 60).padStart(2, "0")}s`;
}

/** Relative change in percent (12.5 = +12.5 %); null without a base. */
export function changePct(cur: number | null | undefined, prev: number | null | undefined) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / prev) * 100;
}

export function deltaOf(pct: number | null): {
  text: string;
  direction: "up" | "down" | "flat";
} | null {
  if (pct === null) return null;
  const direction = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return { text: `${sign}${Math.abs(pct).toFixed(1)}%`, direction };
}

// ---------------------------------------------------------------------------------------------- sorting

/** Sorted copy by `key` ("-x" = descending); nulls always last, ties by name. */
export function sortBy<T extends { name?: string; service_name?: string }>(
  rows: readonly T[],
  sort: string,
  get: (r: T, key: string) => number | string | null | undefined,
): T[] {
  const desc = sort.startsWith("-");
  const key = sort.replace(/^-/, "");
  const nameOf = (r: T) => r.service_name ?? r.name ?? "";
  return [...rows].sort((a, b) => {
    const x = get(a, key);
    const y = get(b, key);
    const xn = x === null || x === undefined;
    const yn = y === null || y === undefined;
    if (xn && !yn) return 1;
    if (yn && !xn) return -1;
    let c = 0;
    if (!xn && !yn)
      c =
        typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    if (desc) c = -c;
    return c || nameOf(a).localeCompare(nameOf(b));
  });
}

/** The next sort when a header is pressed: a new column starts descending (names and "lower is better" ascending). */
export function nextSort(cur: string, key: string, ascFirst = false): string {
  const active = cur.replace(/^-/, "") === key;
  if (active) return cur.startsWith("-") ? key : `-${key}`;
  return ascFirst ? key : `-${key}`;
}

// ---------------------------------------------------------------------------------------------- trust

export const TRUST_SIGNALS: { key: string; label: string; hint: string }[] = [
  {
    key: "proof_coverage",
    label: "Proof of work",
    hint: "Share of page views without a valid proof from the tracker",
  },
  {
    key: "network_quality",
    label: "Network mix",
    hint: "Share of traffic from data centres, VPNs and Tor",
  },
  {
    key: "multiplicity",
    label: "Many visitors, one network",
    hint: "Share of traffic from networks with unusually many visitors",
  },
  {
    key: "engagement",
    label: "Real engagement",
    hint: "Share of visits from automated browsers, hidden tabs or no interaction",
  },
  {
    key: "mix",
    label: "Device and country mix",
    hint: "How far a day’s mix drifts from the previous 28 days",
  },
  {
    key: "temporal",
    label: "Sudden spikes",
    hint: "Day against the 28-day median and the busiest hour’s share",
  },
  {
    key: "pow_latency",
    label: "Proof speed",
    hint: "Share of proofs solved implausibly fast (under 100 ms)",
  },
  {
    key: "cross_signal",
    label: "Matches other signals",
    hint: "Agreement with wallet and API activity",
  },
];

export const REASON_TEXT: Record<string, string> = {
  proof_coverage_low: "Few page views carried a valid browser proof",
  network_datacenter_share_high: "A high share of traffic came from data-centre networks",
  multiplicity_share_high: "Many events repeated from the same browser and network",
  engagement_low: "Visits showed unusually little engagement",
  burstiness_high: "Traffic arrived in sharp bursts",
  step_change: "Traffic jumped abruptly compared with the previous days",
  mix_divergent_country: "The country mix differs sharply from this site’s usual mix",
  mix_divergent_device: "The device mix differs sharply from this site’s usual mix",
  pow_latency_implausible: "Many proofs were solved implausibly fast",
  insufficient_data: "Too few page views to score",
};

export const reasonText = (code: string) => REASON_TEXT[code] ?? code.replaceAll("_", " ");

export type Band = "high" | "medium" | "low" | "unscored";
export const BAND_TEXT: Record<Band, string> = {
  high: "High · 80 and up",
  medium: "Medium · 50 to 79",
  low: "Low · under 50",
  unscored: "Not scored yet",
};

// ---------------------------------------------------------------------------------------------- search

export const WEB_TABS = ["projects", "campaigns", "trust"] as const;
export type WebTab = (typeof WEB_TABS)[number];
export const WEB_DIMS = [
  "referrer",
  "country",
  "device",
  "browser",
  "os",
  "path",
  "event",
] as const;
export type WebDim = (typeof WEB_DIMS)[number];
export const MAX_PICKS = 4;

export type OpSearch = ReturnType<typeof parseOperatorSearch> & {
  tab?: WebTab;
  dim?: WebDim;
  round?: number;
  stage?: AwardStage;
  cat?: ScfCategory;
  q?: string;
  /** the side-by-side panel is open */
  sbs?: boolean;
  /** API page: the service whose routes are shown */
  svc?: string;
};

/** The web and API pages' search: the shared operator filters plus tab, registry filters, search text and panels. */
export function parseOpSearch(s: Record<string, unknown>): OpSearch {
  const out: OpSearch = parseOperatorSearch(s);
  out.ids = out.ids.slice(0, MAX_PICKS);
  if ((WEB_TABS as readonly unknown[]).includes(s.tab) && s.tab !== "projects")
    out.tab = s.tab as WebTab;
  if ((WEB_DIMS as readonly unknown[]).includes(s.dim)) out.dim = s.dim as WebDim;
  const round = Number(s.round);
  if (Number.isInteger(round) && round >= 1 && round <= 999) out.round = round;
  if ((STAGES as readonly unknown[]).includes(s.stage)) out.stage = s.stage as AwardStage;
  if ((CATEGORIES as readonly unknown[]).includes(s.cat)) out.cat = s.cat as ScfCategory;
  if (typeof s.q === "string" && s.q.trim()) out.q = s.q.trim().slice(0, 100);
  if (s.sbs === true || s.sbs === "true") out.sbs = true;
  if (typeof s.svc === "string" && /^[0-9a-f-]{36}$/.test(s.svc)) out.svc = s.svc;
  return out;
}

/** Applies a change; keys set to undefined are removed. */
export function withOp(cur: OpSearch, change: Partial<Record<keyof OpSearch, unknown>>): OpSearch {
  const next: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(change)) {
    if (v === undefined || v === false || v === "") delete next[k];
    else next[k] = v;
  }
  return parseOpSearch(next);
}

/** Series colours of a comparison (ink, orange, yellow, green), as in the design. */
export const PICK_COLORS = ["#111111", "#e8763a", "#c9a000", "#3fa66b"] as const;
export const pickColorClass = (i: number) => `um-op-c${i}`;
