// SPDX-License-Identifier: Apache-2.0
// Ecosystem Usage Map (operator console): search parameters, sorting and wording. The figures come from
// operatorUsageMap / operatorUsageMapProject (job usage_map, public ledger files); this module only orders and labels.

import type { ControlPlane } from "@usagemap/api-types";
import { DAY_PRESETS, type DayPreset } from "../../../lib/days.ts";

export type UsageItem = ControlPlane.UsageMapItem;
export type UsageStatus = ControlPlane.UsageMapStatus;
export type ScfCategory = ControlPlane.ScfCategory;

export const SORT_KEYS = [
  "name",
  "round",
  "invocations",
  "success_rate",
  "contract_calls",
  "peak_daily_invokers",
  "waa",
  "waa_change",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const STATUSES: readonly UsageStatus[] = ["unclaimed", "claimed", "verified"];
export const CATEGORIES: readonly ScfCategory[] = [
  "end_user_application",
  "financial_protocols",
  "applications",
  "developer_tooling",
  "infrastructure_services",
];

export interface UsageMapSearch {
  range: DayPreset;
  network?: "mainnet" | "testnet";
  round?: number;
  category?: ScfCategory;
  status?: UsageStatus;
  q?: string;
  sort: SortKey;
  dir: "asc" | "desc";
  awarded: boolean;
  active: boolean;
}

/** Search parameters of the list; optional ones are present only when set (exactOptionalPropertyTypes). */
export function parseUsageMapSearch(s: Record<string, unknown>): UsageMapSearch {
  const out: UsageMapSearch = {
    range: (DAY_PRESETS as readonly unknown[]).includes(s.range) ? (s.range as DayPreset) : "30d",
    sort: (SORT_KEYS as readonly unknown[]).includes(s.sort) ? (s.sort as SortKey) : "invocations",
    dir: s.dir === "asc" ? "asc" : "desc",
    awarded: s.awarded === true || s.awarded === "true",
    active: s.active === true || s.active === "true",
  };
  const round = Number(s.round);
  if (s.network === "mainnet" || s.network === "testnet") out.network = s.network;
  if (Number.isInteger(round) && round >= 1 && round <= 999) out.round = round;
  if ((CATEGORIES as readonly unknown[]).includes(s.category))
    out.category = s.category as ScfCategory;
  if ((STATUSES as readonly unknown[]).includes(s.status)) out.status = s.status as UsageStatus;
  if (typeof s.q === "string" && s.q.trim()) out.q = s.q.trim().slice(0, 100);
  return out;
}

/** Applies a change to the search; a key set to undefined is removed. */
export function withSearch(
  cur: UsageMapSearch,
  change: { [K in keyof UsageMapSearch]?: UsageMapSearch[K] | undefined },
): UsageMapSearch {
  const next: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(change)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return parseUsageMapSearch(next);
}

export const STATUS_TEXT: Record<UsageStatus, string> = {
  unclaimed: "Unclaimed",
  claimed: "Claimed",
  verified: "Verified",
};

export const STATUS_BADGE: Record<UsageStatus, string> = {
  unclaimed: "badge warn",
  claimed: "badge",
  verified: "badge good",
};

export const SORT_TEXT: Record<SortKey, string> = {
  name: "Project",
  round: "Round",
  invocations: "Invocations",
  success_rate: "Success",
  contract_calls: "Calls from other contracts",
  peak_daily_invokers: "Peak daily invokers",
  waa: "Weekly active accounts",
  waa_change: "WAA change",
};

/** Week-over-week change of the weekly active accounts, as a ratio (0.25 = +25 %); null when either is withheld. */
export function waaChange(
  i: Pick<UsageItem, "weekly_active_accounts" | "prev_weekly_active_accounts">,
): number | null {
  const a = i.weekly_active_accounts;
  const b = i.prev_weekly_active_accounts;
  if (a === null || b === null || b === 0) return null;
  return (a - b) / b;
}

function key(i: UsageItem, k: SortKey): number | string | null {
  switch (k) {
    case "name":
      return i.name.toLowerCase();
    case "round":
      return i.award_round;
    case "invocations":
      return i.invocations;
    case "success_rate":
      return i.success_rate;
    case "contract_calls":
      return i.contract_calls;
    case "peak_daily_invokers":
      return i.peak_daily_invokers;
    case "waa":
      return i.weekly_active_accounts;
    case "waa_change":
      return waaChange(i);
  }
}

/** Sorted copy; withheld or missing values (null) always last, ties by name. */
export function sortUsage(
  items: readonly UsageItem[],
  k: SortKey,
  dir: "asc" | "desc",
): UsageItem[] {
  return [...items].sort((a, b) => {
    const x = key(a, k);
    const y = key(b, k);
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
    let c = 0;
    if (x !== null && y !== null)
      c =
        typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    if (dir === "desc") c = -c;
    return (
      c ||
      a.name.localeCompare(b.name) ||
      a.registry_project_id.localeCompare(b.registry_project_id)
    );
  });
}

/** Rounds present in the list (for the filter), newest first. */
export function roundsOf(items: readonly UsageItem[]): number[] {
  return [...new Set(items.flatMap((i) => (i.award_round === null ? [] : [i.award_round])))].sort(
    (a, b) => b - a,
  );
}

/** The next sort when a column header is pressed: a new column starts descending (names ascending). */
export function nextSort(
  cur: { sort: SortKey; dir: "asc" | "desc" },
  k: SortKey,
): { sort: SortKey; dir: "asc" | "desc" } {
  if (cur.sort === k) return { sort: k, dir: cur.dir === "desc" ? "asc" : "desc" };
  return { sort: k, dir: k === "name" ? "asc" : "desc" };
}

export function shortContract(c: string): string {
  return c.length > 12 ? `${c.slice(0, 6)}…${c.slice(-4)}` : c;
}
