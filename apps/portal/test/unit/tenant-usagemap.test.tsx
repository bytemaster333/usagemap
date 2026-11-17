// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// The tenant's own Usage Map: URL state, per-project totals (success rate null without invocations), the daily series
// over the window with gaps as null, the footprint wording per contract, and one claimed project rendered — status,
// exact figures, per-day table, weekly series, every listed contract with its footprint state, calls per function.

import type { IncomingMessage } from "node:http";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ControlPlane } from "@usagemap/api-types";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_TENANT_CONTRACTS, usageMapHandlers } from "../../e2e/support/mock-usagemap.ts";
import {
  dailySeries,
  FOOTPRINT_BADGE,
  FOOTPRINT_TEXT,
  hasUndeclared,
  parseTenantUsageSearch,
  projectTotals,
} from "../../src/pages/usagemap/model.ts";
import { TenantUsageProjectView } from "../../src/pages/usagemap/TenantUsageMap.tsx";

afterEach(cleanup);

const START = "2026-11-09T00:00:00Z";
const END = "2026-11-16T00:00:00Z";
const DOCS = "a0000000-0000-4000-8000-000000000001";

function tenantMap(tenantId: string): ControlPlane.TenantUsageMap {
  const h = usageMapHandlers({
    session: () => ({ userId: "u-dev", role: null }),
    member: () => {},
  });
  const a = h.getTenantUsageMap?.({
    req: { headers: {} } as IncomingMessage,
    q: new URLSearchParams({ start: START, end: END }),
    p: { tenantId },
  });
  return a?.body as ControlPlane.TenantUsageMap;
}

describe("tenant usage map search", () => {
  it("defaults to 30 days and keeps a known network only", () => {
    expect(parseTenantUsageSearch({})).toEqual({ range: "30d" });
    expect(parseTenantUsageSearch({ range: "7d", network: "testnet" })).toEqual({
      range: "7d",
      network: "testnet",
    });
    expect(parseTenantUsageSearch({ range: "1y", network: "futurenet" })).toEqual({
      range: "30d",
    });
  });
});

describe("tenant usage map model", () => {
  const [dex, kit] = tenantMap(DOCS).projects;
  it("lists only the confirmed links of the tenant", () => {
    expect(tenantMap(DOCS).projects.map((p) => p.status)).toEqual(["verified", "claimed"]);
    expect(tenantMap("a0000000-0000-4000-8000-000000000002").projects).toEqual([]);
  });
  it("sums the daily series", () => {
    const t = projectTotals(dex as ControlPlane.TenantUsageMap["projects"][number]);
    expect(t.invocations).toBe(4200);
    expect(t.successful_invocations).toBe(4200 - 7 * 3);
    expect(t.success_rate).toBeCloseTo(0.995, 3);
    expect(t.days_with_data).toBe(7);
    expect(projectTotals({ daily: [] })).toEqual({
      invocations: 0,
      successful_invocations: 0,
      success_rate: null,
      contract_calls: 0,
      days_with_data: 0,
    });
  });
  it("spans the window, a day without a row is a gap", () => {
    const one = {
      day: "2026-11-10",
      invocations: 5,
      successful_invocations: 5,
      distinct_invokers: 2,
      contract_calls: 0,
      contracts_invoked: 1,
      contracts_listed: 1,
    };
    expect(dailySeries({ daily: [one] }, START, END)).toEqual([
      null,
      5,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
  it("words every footprint state and flags undeclared contracts", () => {
    expect(Object.keys(FOOTPRINT_TEXT).sort()).toEqual(
      ["conflict", "declared", "not_declared", "verified"].sort(),
    );
    expect(FOOTPRINT_BADGE.verified).toBe("badge good");
    expect(hasUndeclared([dex as never])).toBe(true);
    expect(hasUndeclared([kit as never])).toBe(false);
    expect(hasUndeclared([])).toBe(false);
  });
});

describe("tenant usage map project", () => {
  it("renders status, exact figures, days, weeks, contracts and functions", () => {
    const [dex] = tenantMap(DOCS).projects;
    render(
      <TenantUsageProjectView
        project={dex as ControlPlane.TenantUsageMap["projects"][number]}
        start={START}
        end={END}
      />,
    );
    expect(screen.getByRole("heading", { name: "Fakeswap DEX (FAKE)" })).toBeTruthy();
    expect(screen.getByTestId("tenant-usage-status").textContent).toContain(
      "1 of 2 listed contracts verified",
    );
    const totals = screen.getByTestId("tenant-usage-totals");
    expect(totals.textContent).toContain("4,200");
    expect(totals.textContent).toContain("99.5%");
    expect(
      screen.getByRole("img", { name: "Daily invocations of Fakeswap DEX (FAKE)" }),
    ).toBeTruthy();
    const daily = screen.getByTestId("tenant-usage-daily");
    expect(within(daily).getAllByRole("row")).toHaveLength(1 + 7);
    expect(daily.textContent).toContain("2026-11-15");
    expect(screen.getByTestId("tenant-usage-weekly").textContent).toContain("2026-11-09");
    const verified = screen.getByTestId(
      `tenant-usage-contract-${FAKE_TENANT_CONTRACTS.dexVerified}`,
    );
    expect(verified.textContent).toContain("Verified");
    expect(verified.querySelector(".badge.good")).toBeTruthy();
    const undeclared = screen.getByTestId(
      `tenant-usage-contract-${FAKE_TENANT_CONTRACTS.dexUndeclared}`,
    );
    expect(undeclared.textContent).toContain("Not declared");
    const fns = screen.getByTestId("tenant-usage-functions");
    expect(fns.textContent).toContain("swap");
    expect(fns.textContent).toContain("another contract");
  });
  it("says so when nothing happened in the window", () => {
    const [, kit] = tenantMap(DOCS).projects;
    const quiet = {
      ...(kit as ControlPlane.TenantUsageMap["projects"][number]),
      daily: [],
      weekly: [],
      functions: [],
    };
    render(<TenantUsageProjectView project={quiet} start={START} end={END} />);
    expect(screen.getByTestId("tenant-usage-daily").textContent).toContain(
      "No on-chain activity in this window.",
    );
    expect(screen.getByTestId("tenant-usage-weekly").textContent).toContain(
      "No complete week in this window yet.",
    );
    expect(screen.getByTestId("tenant-usage-functions").textContent).toContain(
      "No contract function was called in this window.",
    );
    expect(screen.getByTestId("tenant-usage-totals").textContent).toContain("—");
    expect(
      screen.getByTestId(`tenant-usage-contract-${FAKE_TENANT_CONTRACTS.kitConflict}`).textContent,
    ).toContain("Conflict — under review");
  });
});
