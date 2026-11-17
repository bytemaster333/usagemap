// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// Product improvements of 2026-11-19: the secret-seed leak warning (wording, services, guidance, who may acknowledge),
// filtered traffic by reason, …

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilteredTraffic } from "../../src/components/FilteredTraffic.tsx";
import {
  ROTATION_GUIDE_URL,
  SecretSeedWarningView,
  seedWarningHeadline,
} from "../../src/components/SecretSeedBanner.tsx";
import { filteredView, sloView, WEB_REASON_TEXT } from "../../src/lib/apiFormat.ts";
import { overviewRows } from "../../src/lib/opAgg.ts";
import { SurfacesTable } from "../../src/pages/ApiSurfaces.tsx";
import { apiRange, HORIZON_SUMMARY, SURFACES, SVC_HORIZON, SVC_RPC } from "../fixtures/api.ts";

afterEach(cleanup);
const W = {
  count: 3,
  since: "2026-11-04",
  last_seen: "2026-11-12",
  acknowledged_at: null,
  services: [
    { service_id: "00000000-0000-7000-8000-000000000001", service_name: "horizon-proxy", count: 2 },
    { service_id: "00000000-0000-0000-0000-000000000000", service_name: null, count: 1 },
  ],
};

describe("secret-seed warning", () => {
  it("states the count, the date and the action", () => {
    expect(seedWarningHeadline(W)).toBe(
      "3 Stellar secret seeds appeared in your API request paths since 4 Nov 2026 — rotate those keys",
    );
    expect(seedWarningHeadline({ count: 1, since: "2026-11-04" })).toMatch(
      /^1 Stellar secret seed appeared/,
    );
  });
  it("renders nothing without seeds", () => {
    const { container } = render(
      <SecretSeedWarningView warning={{ ...W, count: 0, services: [] }} canAcknowledge />,
    );
    expect(container.textContent).toBe("");
  });
  it("lists services, links the rotation guide and lets an admin acknowledge", () => {
    const onAck = vi.fn();
    render(<SecretSeedWarningView warning={W} canAcknowledge onAcknowledge={onAck} />);
    const el = screen.getByTestId("seed-warning");
    expect(el.tagName).toBe("SECTION");
    expect(screen.getByRole("region", { name: "Secret-seed warning" })).toBe(el);
    expect(screen.getByTestId("seed-warning-services").textContent).toContain("horizon-proxy: 2");
    expect(el.textContent).toContain("never the seed or any part of it");
    expect(screen.getByRole("link", { name: /guide to signers/ }).getAttribute("href")).toBe(
      ROTATION_GUIDE_URL,
    );
    fireEvent.click(screen.getByRole("button", { name: /acknowledge/ }));
    expect(onAck).toHaveBeenCalledOnce();
  });
  it("a viewer sees no acknowledge button", () => {
    render(<SecretSeedWarningView warning={W} canAcknowledge={false} />);
    expect(screen.queryByRole("button", { name: /acknowledge/ })).toBeNull();
    expect(screen.getByTestId("seed-warning").textContent).toContain(
      "A project admin can acknowledge",
    );
  });
});

describe("filtered traffic", () => {
  it("computes shares of all events received and labels reasons in plain language", () => {
    const f = filteredView({ verified: 800, suspect: 150, rejected: 50 }, [
      { code: "ua_bot", verdict: "rejected", count: 50 },
      { code: "proof_missing", verdict: "suspect", count: 120 },
      { code: "kit_present", verdict: "counter", count: 9 },
    ]);
    expect(f.received).toBe(1000);
    expect(f.notCounted).toBeCloseTo(0.2);
    expect(f.rows.map((r) => r.code)).toEqual(["proof_missing", "ua_bot"]);
    expect(f.rows[0]?.label).toBe(WEB_REASON_TEXT.proof_missing);
    expect(f.rows[1]?.share).toBeCloseTo(0.05);
    expect(filteredView({ verified: 0, suspect: 0, rejected: 0 }, []).notCounted).toBeNull();
  });
  it("every §h.2 reason code has a label", () => {
    const md = readFileSync(join(__dirname, "../../../../docs/contracts/wire-formats.md"), "utf8");
    const h2 = md.slice(md.indexOf("### h.2 Web reason codes"), md.indexOf("### h.3"));
    const codes = [...h2.matchAll(/^\| `([a-z_]+)` \| (suspect|rejected) \|/gm)].map(
      (m) => m[1] as string,
    );
    expect(codes.length).toBeGreaterThan(20);
    for (const c of codes) expect(WEB_REASON_TEXT[c], c).toBeTruthy();
  });
  it("renders the headline, the table and the threshold note", () => {
    render(
      <FilteredTraffic
        verdicts={{ verified: 800, suspect: 150, rejected: 50 }}
        reasons={[{ code: "ua_bot", verdict: "rejected", count: 50 }]}
        suppressed={1}
        caption="Why"
      />,
    );
    expect(screen.getByTestId("filtered-traffic-headline").textContent).toBe(
      "20 % of 1,000 events were not counted in the verified figures: 15 % suspect (counted in raw figures only) and 5 % rejected (never counted).",
    );
    expect(screen.getByTestId("filtered-traffic").textContent).toContain(
      "1 less frequent reason is not shown",
    );
  });
});

describe("SLO / error budget", () => {
  it("measures requests with a status code against the objective and reports coverage", () => {
    const days = ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"];
    const pts = days.flatMap((d, i) => [
      { t: `${d}T00:00:00Z`, requests: i === 2 ? 0 : 10 },
      { t: `${d}T01:00:00Z`, requests: 0 },
    ]);
    const v = sloView(HORIZON_SUMMARY.status, 99.5, pts);
    expect(v.eligible).toBe(1284300);
    expect(v.noStatus).toBe(200);
    expect(v.availability).toBeCloseTo(1274500 / 1284300, 8);
    expect(v.budget).toBeCloseTo(6421.5, 6);
    expect(v.burned).toBeCloseTo(9800 / 6421.5, 6);
    expect(v.met).toBe(false);
    expect(v.coverage).toBe(0.75);
    expect([v.daysWithData, v.days]).toEqual([3, 4]);
    expect(
      sloView({ s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, unknown: 4 }, 99.5, []).availability,
    ).toBeNull();
    const ok = sloView({ s2xx: 1999, s3xx: 0, s4xx: 0, s5xx: 1, unknown: 0 }, 99.5, []);
    expect(ok.met).toBe(true);
    expect(ok.burned).toBeCloseTo(0.1, 6);
  });
});

describe("requests by Stellar surface", () => {
  it("lists surfaces with their groups, shares and the mapping version", () => {
    render(
      <SurfacesTable
        data={{
          range: apiRange("2026-11-06T00:00:00Z", "2026-11-13T00:00:00Z", "1h"),
          mapping_version: "stellar-surfaces/1.0.0",
          surfaces: [...(SURFACES[SVC_HORIZON] ?? []), ...(SURFACES[SVC_RPC] ?? [])],
        }}
      />,
    );
    const h = screen.getByTestId("surface-horizon");
    expect(h.textContent).toContain("Horizon API");
    expect(h.textContent).toContain("accounts");
    expect(h.textContent).toContain("640,000");
    expect(screen.getByTestId("surface-soroban_rpc").textContent).toContain("sendTransaction");
    expect(screen.getByTestId("api-surfaces").textContent).toContain("stellar-surfaces/1.0.0");
  });
});

describe("operator overview", () => {
  const cells = (pv: number, suspect: number | null) => ({
    pageviews: pv,
    pageviews_unidentified: 0,
    visitors_sum: Math.round(pv / 3),
    visits: 0,
    bounces: 0,
    bounce_rate_pct: null,
    avg_visit_duration_s: null,
    suspect_pageview_share: suspect,
  });
  const apiCells = (requests: number, s5xx: number) => ({
    requests,
    s5xx,
    error_rate_5xx: requests ? s5xx / requests : null,
    p50_ms: null,
    p95_ms: null,
    p99_ms: null,
    accuracy_class: null,
  });
  it("joins web and API per project, sums 5xx exactly and flags", () => {
    const rows = overviewRows(
      [
        { tenant_id: "a", slug: "a", name: "A", verification_level: "L2" },
        { tenant_id: "q", slug: "quiet", name: "Quiet", verification_level: "L1" },
      ],
      [
        { tenant_id: "a", slug: "a", name: "A", verification_level: "L2", ...cells(900, 0.05) },
        { tenant_id: "b", slug: "b", name: "B", verification_level: "L3", ...cells(100, 0.4) },
      ],
      [
        {
          tenant_id: "a",
          slug: "a",
          service_id: "s1",
          service_name: "x",
          verification_level: "L2",
          ...apiCells(1000, 10),
        },
        {
          tenant_id: "a",
          slug: "a",
          service_id: "s2",
          service_name: "y",
          verification_level: "L2",
          ...apiCells(1000, 150),
        },
      ],
    );
    expect(rows.map((r) => [r.slug, r.flags])).toEqual([
      ["a", ["high_error_rate"]],
      ["b", ["high_suspect_share"]],
      ["quiet", ["no_data"]],
    ]);
    const a = rows[0];
    expect([a?.services, a?.requests, a?.s5xx, a?.error_rate_5xx]).toEqual([2, 2000, 160, 0.08]);
  });
});
