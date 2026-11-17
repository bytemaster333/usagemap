// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// SCF Evidence Link page (traction snapshot v3): the view model (schema dispatch, withheld cells, stage shares, the
// Growth Hack week rule of the create form) and the rendered page — funnel verified vs raw with on-chain calls beside
// it, the Growth Hack and Public Goods blocks, the cohort position with "not enough projects to compare", the verify
// link by URL, the C4 wording (a measurement, never an endorsement; testnet seal = demonstration) and privacy.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotBodyV2 } from "../../e2e/support/mock-d1.ts";
import { snapshotBodyV3 } from "../../e2e/support/mock-evidence.ts";
import { EvidenceView } from "../../src/pages/evidence/EvidencePage.tsx";
import {
  asEvidence,
  cellText,
  type EvidenceDoc,
  FORBIDDEN_WORDING,
  stageShares,
  wordingOf,
} from "../../src/pages/evidence/model.ts";
import { wholeIsoWeeks } from "../../src/pages/TractionSnapshots.tsx";

afterEach(cleanup);

const input = (
  preset: "custom" | "growth_hack_during" | "pg_renewal_quarter",
  sealEnabled = true,
) => ({
  id: "0190f0aa-0000-7000-8000-000000000001",
  tenant: { slug: "docs", name: "Stellar Docs Explorer", verification_level: "L3" },
  start: "2026-10-05T00:00:00Z",
  end: "2026-11-02T00:00:00Z",
  preset,
  seq: 4,
  previous: "ab".repeat(32),
  issuedAt: "2026-11-02T03:00:00Z",
  sealEnabled,
  onchain: true,
});

const v3 = (preset: Parameters<typeof input>[0], seal = true) =>
  asEvidence(snapshotBodyV3(input(preset, seal))) as EvidenceDoc;

describe("evidence model", () => {
  it("shows v2 and v3 documents, never v1", () => {
    expect(asEvidence({ schema: "scf-analytics/traction-snapshot/1" })).toBeNull();
    expect(asEvidence(null)).toBeNull();
    expect(asEvidence(snapshotBodyV2(input("custom")))?.schema).toBe(
      "scf-analytics/traction-snapshot/2",
    );
    expect(v3("custom").funnel?.min_count).toBe(10);
  });

  it("a withheld cell reads 'fewer than k', never 0; shares are of the first stage", () => {
    expect(cellText(null, 10, String)).toBe("fewer than 10");
    expect(cellText(0, 10, String)).toBe("0");
    const s = stageShares([
      { stage: "web_visitors", verified: 200, raw: 210 },
      { stage: "wallet_connects", verified: 50, raw: 55 },
      { stage: "signatures", verified: null, raw: null },
    ]);
    expect(s.map((x) => x.share)).toEqual([1, 0.25, null]);
  });

  it("v2 documents get the C4 statement and the seal label too", () => {
    const w = wordingOf(asEvidence(snapshotBodyV2(input("custom"))) as EvidenceDoc);
    expect(w.statement).toContain("not an endorsement");
    expect(w.seal).toContain("testnet: a demonstration");
  });

  it("the create form's Growth Hack rule: Monday to Monday, whole weeks", () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(wholeIsoWeeks(d("2026-10-05"), d("2026-11-02"))).toBe(true);
    expect(wholeIsoWeeks(d("2026-10-06"), d("2026-11-03"))).toBe(false);
    expect(wholeIsoWeeks(d("2026-10-05"), d("2026-10-30"))).toBe(false);
    expect(wholeIsoWeeks(null, d("2026-10-30"))).toBe(false);
  });
});

describe("EvidenceView", () => {
  it("renders the funnel verified vs raw, on-chain calls beside it, and the withheld-cell note", () => {
    render(<EvidenceView doc={v3("custom")} status="valid" revokedAt={null} />);
    const funnel = screen.getByTestId("evidence-funnel");
    expect(within(funnel).getByTestId("evidence-stage-web_visitors").textContent).toContain(
      "9,118",
    );
    expect(within(funnel).getByTestId("evidence-stage-web_visitors").textContent).toContain(
      "9,802 raw",
    );
    expect(within(funnel).getByTestId("evidence-stage-wallet_connects").textContent).toContain(
      "1,204",
    );
    expect(within(funnel).getByTestId("evidence-stage-onchain_calls").textContent).toContain(
      "4,820",
    );
    expect(within(funnel).getByTestId("evidence-stage-onchain_calls").textContent).toContain(
      "never joined to visitors",
    );
    expect(screen.getByTestId("evidence-floor").textContent).toContain("never as 0");
    expect(screen.getAllByText("Daily funnel, verified").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("evidence-growth-hack")).toBeNull();
  });

  it("links to the verify UI by URL and shows trust, coverage, window and position", () => {
    const doc = v3("custom");
    render(<EvidenceView doc={doc} status="valid" revokedAt={null} />);
    expect(screen.getByTestId("evidence-verify").getAttribute("href")).toBe(
      `/verify?snapshot=${doc.snapshot_id}`,
    );
    expect(screen.getByTestId("evidence-confidence").textContent).toContain("Confidence medium");
    expect(screen.getByTestId("evidence-confidence").textContent).toContain("open anomaly flags");
    expect(screen.getByTestId("evidence-coverage").textContent).toContain("28 of 28 days");
    expect(screen.getByTestId("evidence-window").textContent).toContain(
      "A period the project chose",
    );
    expect(
      screen.getByTestId("evidence-position-round-web_visitors_verified").textContent,
    ).toContain("85th percentile of 7 projects measured here");
    expect(
      screen.getByTestId("evidence-position-category-web_visitors_verified").textContent,
    ).toContain("not enough projects to compare");
    expect(screen.getByTestId("evidence-api").textContent).toContain("self-attested telemetry");
  });

  it("C4: a measurement, never an endorsement; a testnet seal is a demonstration", () => {
    const { container } = render(
      <EvidenceView doc={v3("custom")} status="valid" revokedAt={null} />,
    );
    expect(screen.getByTestId("evidence-wording").textContent).toContain("not an endorsement");
    expect(screen.getByTestId("evidence-seal").textContent).toContain("testnet: a demonstration");
    expect(container.textContent).not.toMatch(FORBIDDEN_WORDING);
    cleanup();
    render(<EvidenceView doc={v3("custom", false)} status="valid" revokedAt={null} />);
    expect(screen.getByTestId("evidence-seal").textContent).toContain("not sealed");
  });

  it("privacy: no account or contract address and no other project on the page", () => {
    const { container } = render(
      <EvidenceView doc={v3("growth_hack_during")} status="valid" revokedAt={null} />,
    );
    const text = container.innerHTML;
    expect(text).not.toMatch(/G[A-Z2-7]{55}/);
    expect(text).not.toMatch(/C[A-Z2-7]{55}/);
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); // no IP address
  });

  it("Growth Hack: weekly averages campaign vs baseline and the cohort share", () => {
    render(<EvidenceView doc={v3("growth_hack_during")} status="valid" revokedAt={null} />);
    const gh = screen.getByTestId("evidence-growth-hack");
    expect(gh.textContent).toContain("4 campaign weeks");
    const rows = within(screen.getByTestId("evidence-gh-table")).getAllByRole("row");
    expect(rows[1]?.textContent).toContain("520");
    expect(rows[1]?.textContent).toContain("1,205");
    expect(rows[1]?.textContent).toContain("+685");
    expect(screen.getByTestId("evidence-gh-share").textContent).toContain(
      "18% of the increase among 7 SCF round 29 projects measured here",
    );
  });

  it("Public Goods: the quarter with the previous quarter and what is not measured", () => {
    render(<EvidenceView doc={v3("pg_renewal_quarter")} status="valid" revokedAt={null} />);
    const pg = screen.getByTestId("evidence-public-goods");
    expect(pg.textContent).toContain("2026-Q3");
    expect(pg.textContent).toContain("2026-Q2");
    expect(pg.textContent).toContain("+55.5%");
    expect(pg.textContent).toContain("uptime");
  });

  it("a revoked snapshot says so; a v2 snapshot shows what it has", () => {
    render(<EvidenceView doc={v3("custom")} status="revoked" revokedAt="2026-11-10T00:00:00Z" />);
    expect(screen.getByTestId("evidence-revoked").textContent).toContain("revoked");
    cleanup();
    render(
      <EvidenceView
        doc={asEvidence(snapshotBodyV2(input("custom"))) as EvidenceDoc}
        status="valid"
        revokedAt={null}
      />,
    );
    expect(screen.getByTestId("evidence-v2").textContent).toContain("schema v2");
    expect(screen.queryByTestId("evidence-comparison")).toBeNull();
  });
});
