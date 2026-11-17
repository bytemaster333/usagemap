// SPDX-License-Identifier: Apache-2.0
// Ecosystem Usage Map (migration 0075, job usage_map): pure shaping of the operator list, the project detail and the
// tenant view. Every figure is computed by job usage_map from the public ledger files; nothing here reads a database.
//
// Labels (lead's default, 2026-11-19): a project nobody has claimed is "public chain data — ownership not verified";
// a claimed project (a confirmed registry link, made through /onboard) whose claimant has not verified any of its
// contracts is "claimed — contracts not verified"; it is "verified" once at least one listed contract is a verified
// footprint item of the claimant without conflict (the existing footprint verification, C-137). The badge never says
// more than that: the registry's contract list is a third-party statement.

import type { ProjectSummary } from "../onboarding/registry.ts";

export type UsageStatus = "unclaimed" | "claimed" | "verified";
export type UsageNetwork = "mainnet" | "testnet";

export const LABELS: Record<UsageStatus, string> = {
  unclaimed: "public chain data — ownership not verified",
  claimed: "claimed — contracts not verified",
  verified: "verified — contracts in the claimant's verified footprint",
};

export const DEFINITIONS = {
  invocations:
    "Top-level InvokeHostFunction operations calling one of the project's listed contracts (failed included).",
  contract_calls:
    "Calls of a listed contract made by another contract, as far as Soroban authorization trees show them (lower bound).",
  distinct_invokers:
    "Distinct source accounts of those operations per UTC day (relayers and smart wallets: the submitting account).",
  weekly_active_accounts:
    "SCF Growth Hack: accounts that initiated at least one operation in the ISO week (Monday–Sunday UTC). Counts every included operation; the successful-only reading is given beside it.",
} as const;

export interface OpUsageRow extends Record<string, unknown> {
  registry_project_id: string;
  contracts_listed: number;
  days_covered: number;
  invocations: number;
  successful_invocations: number;
  contract_calls: number;
  peak_daily_invokers: number | null;
  daily_invocations: (number | null)[] | null;
  week_start: string | null;
  active_accounts: number | null;
  active_accounts_successful: number | null;
  prev_active_accounts: number | null;
  claimed: boolean;
  contracts_verified: number;
}

export function status(claimed: boolean, contractsVerified: number): UsageStatus {
  return !claimed ? "unclaimed" : contractsVerified > 0 ? "verified" : "claimed";
}

/** Success rate in [0, 1] with 4 decimals, null without invocations. */
export function successRate(ok: number, total: number): number | null {
  return total > 0 ? Math.round((ok / total) * 10_000) / 10_000 : null;
}

export interface UsageItem {
  registry_project_id: string;
  name: string;
  website: string | null;
  categories: string[];
  award_round: number | null;
  award_stage: string | null;
  scf_awarded: boolean;
  contracts_listed: number;
  contracts_verified: number;
  status: UsageStatus;
  label: string;
  days_covered: number;
  invocations: number;
  successful_invocations: number;
  success_rate: number | null;
  contract_calls: number;
  peak_daily_invokers: number | null;
  daily_invocations: (number | null)[];
  week_start: string | null;
  weekly_active_accounts: number | null;
  weekly_active_accounts_successful: number | null;
  prev_weekly_active_accounts: number | null;
}

export function toItem(
  r: OpUsageRow,
  s: Pick<ProjectSummary, "name" | "website" | "categories" | "award_round" | "award_stage">,
  scfAwarded: boolean,
): UsageItem {
  const st = status(r.claimed, Number(r.contracts_verified));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    registry_project_id: r.registry_project_id,
    name: s.name,
    website: s.website,
    categories: [...s.categories],
    award_round: s.award_round,
    award_stage: s.award_stage,
    scf_awarded: scfAwarded,
    contracts_listed: Number(r.contracts_listed),
    contracts_verified: Number(r.contracts_verified),
    status: st,
    label: LABELS[st],
    days_covered: Number(r.days_covered),
    invocations: Number(r.invocations),
    successful_invocations: Number(r.successful_invocations),
    success_rate: successRate(Number(r.successful_invocations), Number(r.invocations)),
    contract_calls: Number(r.contract_calls),
    peak_daily_invokers: n(r.peak_daily_invokers),
    daily_invocations: (r.daily_invocations ?? []).map((v) => n(v)),
    week_start: r.week_start,
    weekly_active_accounts: n(r.active_accounts),
    weekly_active_accounts_successful: n(r.active_accounts_successful),
    prev_weekly_active_accounts: n(r.prev_active_accounts),
  };
}

export interface UsageFilter {
  q?: string | undefined;
  round?: number | undefined;
  category?: string | undefined;
  status?: UsageStatus | undefined;
  awardedOnly?: boolean | undefined;
  activeOnly?: boolean | undefined;
}

export function filterItems(items: UsageItem[], f: UsageFilter): UsageItem[] {
  const q = f.q?.trim().toLowerCase() ?? "";
  return items.filter(
    (i) =>
      (!q || i.name.toLowerCase().includes(q)) &&
      (f.round === undefined || i.award_round === f.round) &&
      (!f.category || i.categories.includes(f.category)) &&
      (!f.status || i.status === f.status) &&
      (!f.awardedOnly || i.scf_awarded) &&
      (!f.activeOnly || i.invocations + i.contract_calls > 0),
  );
}

/** Default order: most invocations first, then name. */
export function sortItems(items: UsageItem[]): UsageItem[] {
  return [...items].sort(
    (a, b) =>
      b.invocations - a.invocations ||
      b.contract_calls - a.contract_calls ||
      a.name.localeCompare(b.name) ||
      a.registry_project_id.localeCompare(b.registry_project_id),
  );
}

/** One CSV row per project (the sparkline series as one space-separated cell, empty for an uncovered day). */
export function csvRows(items: UsageItem[]): Record<string, unknown>[] {
  return items.map((i) => ({
    registry_project_id: i.registry_project_id,
    name: i.name,
    status: i.status,
    label: i.label,
    award_round: i.award_round,
    categories: i.categories.join(" "),
    scf_awarded: i.scf_awarded,
    contracts_listed: i.contracts_listed,
    contracts_verified: i.contracts_verified,
    days_covered: i.days_covered,
    invocations: i.invocations,
    successful_invocations: i.successful_invocations,
    success_rate: i.success_rate,
    contract_calls: i.contract_calls,
    peak_daily_invokers: i.peak_daily_invokers,
    week_start: i.week_start,
    weekly_active_accounts: i.weekly_active_accounts,
    weekly_active_accounts_successful: i.weekly_active_accounts_successful,
    prev_weekly_active_accounts: i.prev_weekly_active_accounts,
    daily_invocations: i.daily_invocations.map((v) => (v === null ? "" : String(v))).join(" "),
  }));
}

export type Footprint = "verified" | "declared" | "conflict" | "not_declared";

/** The claimant tenant's footprint state of one listed contract (declared_contracts of that tenant). */
export function footprintOf(
  contractId: string,
  declared: readonly { contract_id: string; status: string; conflict_since: unknown }[],
): Footprint {
  const d = declared.filter((x) => x.contract_id === contractId);
  if (d.length === 0) return "not_declared";
  if (d.some((x) => x.conflict_since !== null && x.conflict_since !== undefined)) return "conflict";
  return d.some((x) => x.status === "verified") ? "verified" : "declared";
}
