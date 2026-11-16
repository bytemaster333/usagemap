// SPDX-License-Identifier: Apache-2.0
// Operator console redesign (K1): registry facts of a tenant, the registry filters, the previous window of the movers,
// the hidden-value view of a breakdown and the overview's deltas. Pure functions; the database side is tested in
// db/tests/operator_console_test.go and test/integration/operator-console.test.ts.

import { describe, expect, it } from "vitest";
import {
  type ProjectLabel,
  type RegistryProjectRow,
  registryFacts,
} from "../../src/operator/common.ts";
import {
  type BreakdownRow,
  breakdownView,
  overviewView,
  previousWindow,
  registryMatches,
} from "../../src/operator/handlers.ts";

const project = (over: Partial<RegistryProjectRow>): RegistryProjectRow => ({
  registry_project_id: "00000000-0000-7000-8000-000000000001",
  source: "stellarlight",
  source_id: "p1",
  name: "P1",
  source_url: "https://registry.example/p1",
  scf_awarded: true,
  award_round: 30,
  award_stage: "t1_mvp",
  scf_categories: ["applications"],
  ...over,
});

describe("registryFacts", () => {
  it("is null without a confirmed link", () => {
    expect(registryFacts([])).toBeNull();
  });

  it("takes the link with the latest award round; categories are the sorted union", () => {
    const f = registryFacts([
      project({}),
      project({
        registry_project_id: "00000000-0000-7000-8000-000000000002",
        source_id: "p2",
        award_round: 36,
        award_stage: "t3_mainnet",
        scf_categories: ["infrastructure_services", "applications"],
      }),
      project({ registry_project_id: "00000000-0000-7000-8000-000000000003", award_round: null }),
    ]);
    expect(f).toEqual({
      registry_project_id: "00000000-0000-7000-8000-000000000002",
      source: "stellarlight",
      source_id: "p2",
      name: "P1",
      url: "https://registry.example/p1",
      award_round: 36,
      award_stage: "t3_mainnet",
      categories: ["applications", "infrastructure_services"],
    });
  });

  it("without rounds: awarded first, then the lowest id", () => {
    const f = registryFacts([
      project({
        registry_project_id: "00000000-0000-7000-8000-000000000001",
        award_round: null,
        scf_awarded: false,
      }),
      project({
        registry_project_id: "00000000-0000-7000-8000-000000000009",
        award_round: null,
        scf_awarded: true,
      }),
      project({
        registry_project_id: "00000000-0000-7000-8000-000000000005",
        award_round: null,
        scf_awarded: true,
      }),
    ]);
    expect(f?.registry_project_id).toBe("00000000-0000-7000-8000-000000000005");
    expect(f?.categories).toEqual(["applications"]);
  });
});

describe("registryMatches", () => {
  const label = (registry: ProjectLabel["registry"]): ProjectLabel => ({
    tenantId: "t",
    slug: "s",
    name: "n",
    status: "active",
    createdAt: new Date(0),
    level: 1,
    scfAwarded: true,
    registryProjectIds: [],
    siteCount: 0,
    serviceCount: 0,
    registry,
  });
  const linked = label(
    registryFacts([project({ scf_categories: ["applications", "developer_tooling"] })]),
  );
  const unlinked = label(null);

  it("filters on round, stage and category together", () => {
    expect(registryMatches(linked, {})).toBe(true);
    expect(registryMatches(linked, { award_round: 30 })).toBe(true);
    expect(registryMatches(linked, { award_round: 31 })).toBe(false);
    expect(registryMatches(linked, { award_stage: "t1_mvp", category: "developer_tooling" })).toBe(
      true,
    );
    expect(registryMatches(linked, { award_stage: "t2_testnet" })).toBe(false);
    expect(registryMatches(linked, { category: "financial_protocols" })).toBe(false);
  });

  it("a tenant without a registry link matches no registry filter", () => {
    expect(registryMatches(unlinked, {})).toBe(true);
    expect(registryMatches(unlinked, { award_round: 30 })).toBe(false);
    expect(registryMatches(unlinked, { category: "applications" })).toBe(false);
  });
});

describe("previousWindow", () => {
  it("is the equal-length window just before start", () => {
    expect(
      previousWindow(
        { start: "2026-11-03T00:00:00Z", end: "2026-11-10T00:00:00Z", compare: "previous" },
        "-pageviews",
      ),
    ).toEqual({ start: "2026-10-27T00:00:00.000Z", end: "2026-11-03T00:00:00.000Z" });
  });

  it("is null without compare; a *_change sort then is a 400", () => {
    expect(
      previousWindow({ start: "2026-11-03T00:00:00Z", end: "2026-11-10T00:00:00Z" }, "-pageviews"),
    ).toBeNull();
    expect(() => previousWindow({}, "-requests_change")).toThrow(/compare=previous/);
  });
});

describe("breakdownView (hidden values)", () => {
  const row = (over: Partial<BreakdownRow>): BreakdownRow => ({
    tenant_id: "a",
    value: "DE",
    visitors_sum: "20",
    pageviews: "30",
    events: null,
    hidden_rows: null,
    ...over,
  });

  it("passes value rows through and never a summary row", () => {
    const v = breakdownView([row({}), row({ value: "FR", visitors_sum: "10" })], 5);
    expect(v.rows).toEqual([
      { tenant_id: "a", value: "DE", visitors_sum: 20, pageviews: 30, events: null },
      { tenant_id: "a", value: "FR", visitors_sum: 10, pageviews: 30, events: null },
    ]);
    expect(v).toMatchObject({
      hidden_rows: null,
      hidden_rows_min: 5,
      hidden_total_suppressed: true,
      hidden_by_tenant: [],
    });
  });

  it("sums the reported counts; a count below the minimum is never reported", () => {
    const summary = (tenant: string, n: number) =>
      row({ tenant_id: tenant, value: null, visitors_sum: null, pageviews: null, hidden_rows: n });
    const v = breakdownView([row({}), summary("a", 6), summary("b", 5), summary("c", 1)], 5);
    expect(v.hidden_rows).toBe(11);
    expect(v.hidden_by_tenant).toEqual([
      { tenant_id: "a", hidden_rows: 6 },
      { tenant_id: "b", hidden_rows: 5 },
    ]);
    expect(v.rows).toHaveLength(1);
    expect(JSON.stringify(v)).not.toContain('"value":null');
  });
});

describe("overviewView", () => {
  it("reports value, previous and delta for each count", () => {
    const v = overviewView(
      {
        month_start: "2026-11-01",
        enrolled: 42,
        enrolled_at_month_start: 38,
        pending_approval: 3,
        pending_at_month_start: 5,
        new_this_month: 7,
        new_previous_month: 9,
        removed_this_month: 1,
        removed_previous_month: 0,
      },
      Date.parse("2026-11-19T12:00:00Z"),
    );
    expect(v).toEqual({
      as_of: "2026-11-19T12:00:00.000Z",
      month_start: "2026-11-01",
      enrolled: { value: 42, previous: 38, delta: 4 },
      pending_approval: { value: 3, previous: 5, delta: -2 },
      new_this_month: { value: 7, previous: 9, delta: -2 },
      removed_this_month: { value: 1, previous: 0, delta: 1 },
    });
  });
});
