// SPDX-License-Identifier: Apache-2.0
// The tenant's own Usage Map (getTenantUsageMap): URL state, per-project totals and the wording of each listed
// contract's footprint state. The figures are the tenant's own view, exact; only registry projects the tenant has a
// CONFIRMED registry link to are ever returned. Sorting and labels shared with the operator console live in
// ../operator/usagemap/model.ts.

import type { ControlPlane } from "@usagemap/api-types";
import { DAY_PRESETS, type DayPreset } from "../../lib/days.ts";

export type TenantUsageProject = ControlPlane.TenantUsageMap["projects"][number];
export type TenantUsageContract = TenantUsageProject["contracts"][number];
export type Footprint = TenantUsageContract["footprint"];

export interface TenantUsageSearch {
  range: DayPreset;
  network?: "mainnet" | "testnet";
}

/** Search parameters of the page; unknown values fall back to the defaults, `network` is absent unless chosen. */
export function parseTenantUsageSearch(s: Record<string, unknown>): TenantUsageSearch {
  const out: TenantUsageSearch = {
    range: (DAY_PRESETS as readonly unknown[]).includes(s.range) ? (s.range as DayPreset) : "30d",
  };
  if (s.network === "mainnet" || s.network === "testnet") out.network = s.network;
  return out;
}

export const FOOTPRINT_TEXT: Record<Footprint, string> = {
  verified: "Verified",
  declared: "Declared, not yet verified",
  conflict: "Conflict — under review",
  not_declared: "Not declared",
};

export const FOOTPRINT_BADGE: Record<Footprint, string> = {
  verified: "badge good",
  declared: "badge",
  conflict: "badge warn",
  not_declared: "badge warn",
};

export const FOOTPRINT_HINT: Record<Footprint, string> = {
  verified: "in your verified footprint",
  declared: "in your footprint; the ownership check has not passed yet",
  conflict: "verified for another project too; counted nowhere until an SCF operator resolves it",
  not_declared: "listed in the registry but not in your footprint",
};

export interface ProjectTotals {
  invocations: number;
  successful_invocations: number;
  success_rate: number | null;
  contract_calls: number;
  days_with_data: number;
}

/** Sums of the daily series in the window; the success rate is null without invocations. */
export function projectTotals(p: Pick<TenantUsageProject, "daily">): ProjectTotals {
  let invocations = 0;
  let ok = 0;
  let calls = 0;
  for (const d of p.daily) {
    invocations += d.invocations;
    ok += d.successful_invocations;
    calls += d.contract_calls;
  }
  return {
    invocations,
    successful_invocations: ok,
    success_rate: invocations > 0 ? ok / invocations : null,
    contract_calls: calls,
    days_with_data: p.daily.length,
  };
}

/** The daily invocations over every day of the window, null on a day without a row (a gap, not a zero). */
export function dailySeries(
  p: Pick<TenantUsageProject, "daily">,
  start: string,
  end: string,
): (number | null)[] {
  const byDay = new Map(p.daily.map((d) => [d.day, d.invocations]));
  const out: (number | null)[] = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += 86_400_000)
    out.push(byDay.get(new Date(t).toISOString().slice(0, 10)) ?? null);
  return out;
}

/** True when at least one listed contract is outside the tenant's footprint (the page then links the wizard). */
export function hasUndeclared(projects: readonly Pick<TenantUsageProject, "contracts">[]): boolean {
  return projects.some((p) => p.contracts.some((c) => c.footprint === "not_declared"));
}
