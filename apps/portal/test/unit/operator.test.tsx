// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// SCF-operator pieces with known values (operator.web-*, operator.api-*, operator.global-view-credentials).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toggleId } from "../../src/pages/operator/common.tsx";
import { PrivacyFloor, TrustCell } from "../../src/pages/operator/kit.tsx";
import { fmtCompact, nextSort, sortBy } from "../../src/pages/operator/model.ts";
import { ApiServiceTable } from "../../src/pages/operator/OperatorApi.tsx";
import { actionsFor } from "../../src/pages/operator/OperatorTenants.tsx";
import { WebProjectTable } from "../../src/pages/operator/OperatorWeb.tsx";
import { latestPerSite } from "../../src/pages/operator/WebTrust.tsx";
import { EXPECTED_OP, OP_PROJECTS, OP_SERVICES, PRIVACY } from "../fixtures/operator.ts";

// The tables link each row to its project; a plain anchor stands in for the router's Link here.
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#project" className={className}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);
const ranked = OP_PROJECTS.filter((p) => p.verification_level !== "L0");
const rows = ranked.map((p) => ({
  tenant_id: p.tenant_id,
  slug: p.slug,
  name: p.name,
  verification_level: p.verification_level,
  trust_score_28d: p.trust_score_28d,
  scf_awarded: p.scf_awarded,
  ...p.verified,
}));

describe("project table", () => {
  it("shows every metric and the trust indicator, picks and sorts", () => {
    const onPick = vi.fn();
    const onSort = vi.fn();
    render(
      <WebProjectTable
        rows={rows}
        variant="verified"
        sort="-pageviews"
        onSort={onSort}
        picked={[]}
        onPick={onPick}
      />,
    );
    expect(screen.getByTestId("web-row-stellar-docs").textContent).toMatch(
      /36\.9k—18\.3k41%1m 33s6\.0%84/,
    );
    expect(screen.getByTestId("web-row-pending-labs").textContent).toContain("not scored yet");
    fireEvent.click(screen.getByLabelText("Compare Soroban Swap"));
    expect(onPick).toHaveBeenCalledWith(OP_PROJECTS[1]?.tenant_id);
    fireEvent.click(screen.getByRole("button", { name: /^Bounce/ }));
    expect(onSort).toHaveBeenCalledWith("bounce_rate_pct");
    fireEvent.click(screen.getByRole("button", { name: /^Page views/ }));
    expect(onSort).toHaveBeenCalledWith("pageviews");
  });
  it("caps the comparison at four", () => {
    const four = Array.from({ length: 4 }, (_, i) => `id${i}`);
    expect(toggleId(four, "id7")).toEqual(four);
    expect(toggleId(four, "id0")).toHaveLength(3);
  });
  it("sorts with nulls last and toggles direction", () => {
    const r = [
      { name: "a", v: 2 },
      { name: "b", v: null },
      { name: "c", v: 5 },
    ];
    expect(sortBy(r, "-v", (x) => x.v).map((x) => x.name)).toEqual(["c", "a", "b"]);
    expect(sortBy(r, "v", (x) => x.v).map((x) => x.name)).toEqual(["a", "c", "b"]);
    expect(nextSort("-v", "v")).toBe("v");
    expect(nextSort("v", "w")).toBe("-w");
    expect(nextSort("v", "w", true)).toBe("w");
  });
  it("formats compact numbers like the design", () => {
    expect(fmtCompact(9840)).toBe("9,840");
    expect(fmtCompact(41_234)).toBe("41.2k");
    expect(fmtCompact(412_300)).toBe("412k");
    expect(fmtCompact(1_840_000)).toBe("1.84M");
    expect(fmtCompact(null)).toBe("—");
  });
  it("trust cell bands and the privacy floor", () => {
    render(<TrustCell score={58} />);
    expect(screen.getByText("58")).toBeTruthy();
    render(<PrivacyFloor privacy={PRIVACY} />);
    expect(screen.getByTestId("privacy-note").textContent).toMatch(
      /under 10 hidden, rounded to 10.*below L1/,
    );
  });
  it("keeps the latest trust score per website and window", () => {
    const base = {
      tenant_id: "t",
      slug: "s",
      components: {},
      reason_codes: [],
      algorithm_version: "trust/1",
    };
    const out = latestPerSite(
      [
        { ...base, site_id: "a", day: "2026-11-01", window_days: 28, score: 70 },
        { ...base, site_id: "a", day: "2026-11-02", window_days: 28, score: 60 },
        { ...base, site_id: "a", day: "2026-11-02", window_days: 1, score: 10 },
        { ...base, site_id: "b", day: "2026-11-02", window_days: 28, score: null },
      ],
      28,
    );
    expect(out.map((r) => [r.site_id, r.score])).toEqual([
      ["a", 60],
      ["b", null],
    ]);
  });
});

describe("API services table", () => {
  it("flags high- and low-usage services and shows assurance indicators", () => {
    const svcRows = OP_SERVICES.filter(
      (s) => s.tenant_id !== "a0000000-0000-4000-8000-000000000006",
    ).map((s) => ({
      tenant_id: s.tenant_id,
      slug: "p",
      service_id: s.service_id,
      service_name: s.service_name,
      verification_level: "L2" as const,
      assurance_level: s.assurance_level,
      onchain_badge: s.onchain_badge,
      active_days: s.active_days_30,
      ...s.cells,
    }));
    render(
      <ApiServiceTable
        rows={svcRows}
        days={30}
        sort="-requests"
        onSort={() => {}}
        picked={[]}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId("flag-swap-api").textContent).toBe("highest volume");
    expect(screen.getByTestId("flag-legacy-api").textContent).toBe("no requests in range");
    expect(screen.getByTestId("flag-anchor-sep").textContent).toBe("active on few days");
    expect(screen.queryByTestId("flag-horizon-proxy")).toBeNull();
    expect(screen.getByTestId("api-row-soroban-rpc-gw").textContent).toContain(EXPECTED_OP.rpcP50);
    expect(screen.getByTestId("api-row-swap-api").textContent).toContain("A2On-chain");
    expect(screen.getByTestId("api-row-anchor-sep").textContent).toContain("On-chain mismatch");
  });
});

describe("tenant lifecycle", () => {
  it("offers only valid transitions per status", () => {
    expect(actionsFor("pending")).toEqual(["approve", "remove"]);
    expect(actionsFor("active")).toEqual(["suspend", "remove"]);
    expect(actionsFor("suspended")).toEqual(["reinstate", "remove"]);
    expect(actionsFor("removed")).toEqual(["restore", "purge"]);
  });
});
