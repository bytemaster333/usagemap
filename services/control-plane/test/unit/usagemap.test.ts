// SPDX-License-Identifier: Apache-2.0
// Ecosystem Usage Map shaping (src/usagemap/model.ts): the claim badge and its label, success rate, filters, order,
// the CSV rows (formula-safe through toCsv) and the tenant's footprint state per listed contract.

import { describe, expect, it } from "vitest";
import type { ScfCategory } from "../../src/onboarding/registry.ts";
import { toCsv } from "../../src/operator/common.ts";
import {
  csvRows,
  filterItems,
  footprintOf,
  LABELS,
  type OpUsageRow,
  sortItems,
  status,
  successRate,
  toItem,
} from "../../src/usagemap/model.ts";

const row = (o: Partial<OpUsageRow> = {}): OpUsageRow => ({
  registry_project_id: "019a0000-0000-7000-8000-000000000001",
  contracts_listed: 2,
  days_covered: 7,
  invocations: 70,
  successful_invocations: 63,
  contract_calls: 3,
  peak_daily_invokers: 12,
  daily_invocations: [10, null, 10, 10, 10, 20, 10],
  week_start: "2026-11-09",
  active_accounts: 40,
  active_accounts_successful: 35,
  prev_active_accounts: 30,
  claimed: false,
  contracts_verified: 0,
  ...o,
});
const summary = (name: string, o: { round?: number; cats?: ScfCategory[] } = {}) =>
  ({
    name,
    website: null,
    categories: o.cats ?? [],
    award_round: o.round ?? null,
    award_stage: null,
  }) as const;

describe("usage map model", () => {
  it("badges: unclaimed → public chain data, claimed without verified contracts, verified with one", () => {
    expect(status(false, 3)).toBe("unclaimed"); // a footprint without a claim proves nothing about the listing
    expect(status(true, 0)).toBe("claimed");
    expect(status(true, 1)).toBe("verified");
    expect(LABELS.unclaimed).toBe("public chain data — ownership not verified");
  });
  it("shapes a row: counts as numbers, success rate, nulls kept (floor)", () => {
    const i = toItem(
      row({ invocations: "70" as unknown as number, peak_daily_invokers: null }),
      summary("Dex", { round: 37 }),
      true,
    );
    expect(i).toMatchObject({
      invocations: 70,
      success_rate: 0.9,
      peak_daily_invokers: null,
      status: "unclaimed",
    });
    expect(i.daily_invocations).toEqual([10, null, 10, 10, 10, 20, 10]);
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(1, 3)).toBe(0.3333);
  });
  it("filters by name, round, category, status, awarded and activity; sorts by invocations", () => {
    const a = toItem(
      row({ registry_project_id: "a" }),
      summary("Alpha", { round: 37, cats: ["financial_protocols"] }),
      true,
    );
    const b = toItem(
      row({
        registry_project_id: "b",
        invocations: 0,
        successful_invocations: 0,
        contract_calls: 0,
        claimed: true,
      }),
      summary("Beta", { round: 38 }),
      false,
    );
    const c = toItem(row({ registry_project_id: "c", invocations: 900 }), summary("Gamma"), true);
    expect(filterItems([a, b, c], { round: 37 }).map((x) => x.name)).toEqual(["Alpha"]);
    expect(filterItems([a, b, c], { category: "financial_protocols" }).map((x) => x.name)).toEqual([
      "Alpha",
    ]);
    expect(filterItems([a, b, c], { status: "claimed" }).map((x) => x.name)).toEqual(["Beta"]);
    expect(
      filterItems([a, b, c], { awardedOnly: true, activeOnly: true }).map((x) => x.name),
    ).toEqual(["Alpha", "Gamma"]);
    expect(filterItems([a, b, c], { q: "AMM" }).map((x) => x.name)).toEqual(["Gamma"]);
    expect(sortItems([a, b, c]).map((x) => x.name)).toEqual(["Gamma", "Alpha", "Beta"]);
  });
  it("writes one CSV row per project; a formula-like name is neutralised", () => {
    const i = toItem(row(), summary('=HYPERLINK("x")'), true);
    const csv = toCsv(csvRows([i]));
    const [head, line] = csv.trim().split("\r\n");
    expect(head?.split(",").slice(0, 4)).toEqual([
      "registry_project_id",
      "name",
      "status",
      "label",
    ]);
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain("10  10 10 10 20 10"); // the uncovered day is an empty slot
  });
  it("footprint of a listed contract for the claimant", () => {
    const d = [
      { contract_id: "CA", status: "verified", conflict_since: null },
      { contract_id: "CB", status: "declared", conflict_since: null },
      { contract_id: "CC", status: "verified", conflict_since: "2026-11-01" },
    ];
    expect(["CA", "CB", "CC", "CD"].map((c) => footprintOf(c, d))).toEqual([
      "verified",
      "declared",
      "conflict",
      "not_declared",
    ]);
  });
});
