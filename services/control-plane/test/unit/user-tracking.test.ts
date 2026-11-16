// SPDX-License-Identifier: Apache-2.0
// The grant-application "user tracking" paragraph (src/evidence/user-tracking.ts): it names exactly what was measured, never a
// source that delivered nothing, follows the project's privacy settings, and keeps wording rule C4.
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_WORDING,
  NEVER_COLLECTED,
  type SiteFacts,
  type UserTrackingFacts,
  userTrackingStatement,
} from "../../src/evidence/user-tracking.ts";
import { userTrackingWindow } from "../../src/evidence/user-tracking-handler.ts";

const site = (o: Partial<SiteFacts> = {}): SiteFacts => ({
  name: "Main site",
  profile: "standard",
  visitorId: "on",
  anonymousReports: true,
  retentionDays: 90,
  pageviews: true,
  wallet: false,
  passkey: false,
  ...o,
});

const facts = (o: Partial<UserTrackingFacts> = {}): UserTrackingFacts => ({
  projectName: "Acme Pay",
  window: { start: new Date("2026-10-20T00:00:00Z"), end: new Date("2026-11-19T00:00:00Z") },
  sites: [],
  services: [],
  contracts: { declared: 0, verified: 0, activity: false },
  publicStatsUrl: null,
  snapshotUrl: null,
  privacyUrl: "https://docs.example.org/privacy",
  ...o,
});

describe("userTrackingStatement", () => {
  it("says honestly that nothing is tracked when nothing was received", () => {
    const out = userTrackingStatement(
      facts({
        sites: [site({ pageviews: false })],
        services: [{ name: "api", requests: false, stellarClient: false }],
      }),
    );
    expect(out.paragraph).toContain("no usage data was received between 2026-10-20 and 2026-11-19");
    expect(out.paragraph).not.toMatch(/page views|OpenTelemetry/);
    expect(out.sources.map((s) => [s.source, s.status])).toEqual([
      ["web", "configured"],
      ["api", "configured"],
    ]);
    expect(out.mermaid).toContain("No usage data received yet");
    expect(out.paragraph).toContain("https://docs.example.org/privacy");
  });

  it("describes a standard-profile site with a visitor identifier, and nothing that was not measured", () => {
    const out = userTrackingStatement(facts({ sites: [site()] }));
    expect(out.paragraph).toContain("Acme Pay measures usage with UsageMap");
    expect(out.paragraph).toContain("referring host");
    expect(out.paragraph).toContain(
      "Unique visitors are counted with a code derived from a secret that changes every day",
    );
    expect(out.paragraph).toContain("deleted after 90 days");
    expect(out.paragraph).toContain("Global Privacy Control");
    expect(out.paragraph).toContain("round small numbers");
    expect(out.paragraph).not.toMatch(
      /wallet connections|OpenTelemetry|Stellar RPC|ledger|snapshot|public at/,
    );
    expect(out.sources).toEqual([
      { source: "web", status: "measured", detail: "Page views on Main site (standard)." },
    ]);
  });

  it("follows the strict profile and a disabled identifier", () => {
    const out = userTrackingStatement(
      facts({
        sites: [
          site({ profile: "strict", visitorId: "off", anonymousReports: false, retentionDays: 30 }),
        ],
      }),
    );
    expect(out.paragraph).toContain("only the page path");
    expect(out.paragraph).not.toContain("referring host");
    expect(out.paragraph).toContain("we count page views, not visitors");
    expect(out.paragraph).toContain("deleted after 30 days");
    expect(out.paragraph).not.toContain("round small numbers");
  });

  it("qualifies the identifier when it is off for some countries or sites, and gives a retention range", () => {
    const out = userTrackingStatement(
      facts({
        sites: [
          site({ visitorId: "off_in", retentionDays: 30 }),
          site({ name: "Docs", profile: "strict", visitorId: "off" }),
        ],
      }),
    );
    expect(out.paragraph).toContain("our 2 websites");
    expect(out.paragraph).toContain("Where enabled, unique visitors are counted");
    expect(out.paragraph).toContain("our standard-profile sites also keep the referring host");
    expect(out.paragraph).toContain("deleted after 30 to 90 days");
  });

  it("names wallet, passkey, API, Stellar client and on-chain sources only when they delivered data", () => {
    const out = userTrackingStatement(
      facts({
        sites: [site({ wallet: true, passkey: true })],
        services: [
          { name: "quotes-api", requests: true, stellarClient: true },
          { name: "idle", requests: false, stellarClient: false },
        ],
        contracts: { declared: 2, verified: 1, activity: true },
        publicStatsUrl: "https://app.example.org/p/acme",
        snapshotUrl: "https://app.example.org/evidence/0199",
      }),
    );
    expect(out.paragraph).toContain(
      "wallet connections (the wallet type, the network and whether it succeeded)",
    );
    expect(out.paragraph).toContain("passkey and smart-wallet use");
    expect(out.paragraph).toContain("wallet addresses are never sent");
    expect(out.paragraph).toContain("Our API sends technical usage metrics through OpenTelemetry");
    expect(out.paragraph).toContain("calls to Stellar RPC and Horizon");
    expect(out.paragraph).toContain("public Stellar ledger data for our registered contracts");
    expect(out.paragraph).toContain(
      "Aggregated figures are public at https://app.example.org/p/acme",
    );
    expect(out.paragraph).toContain("https://app.example.org/evidence/0199");
    expect(out.paragraph).not.toContain("idle");
    expect(out.sources.map((s) => `${s.source}:${s.status}`)).toEqual([
      "web:measured",
      "wallet:measured",
      "passkey:measured",
      "api:measured",
      "stellar_client:measured",
      "onchain:measured",
    ]);
    expect(out.mermaid.split("\n")[0]).toBe("flowchart LR");
    expect(out.mermaid).toContain("wallet events, no address");
    expect(out.mermaid).toContain("Public Stellar ledger");
    expect(out.mermaid).toContain("Public aggregated statistics");
  });

  it("keeps registered contracts without ledger activity out of the paragraph", () => {
    const out = userTrackingStatement(
      facts({
        services: [{ name: "api", requests: true, stellarClient: false }],
        contracts: { declared: 1, verified: 0, activity: false },
      }),
    );
    expect(out.paragraph).not.toContain("ledger");
    expect(out.paragraph).not.toContain("Global Privacy Control"); // no browser source measured
    expect(out.sources.find((s) => s.source === "onchain")?.status).toBe("configured");
  });

  it("never uses endorsement wording (C4) and never names data it does not store", () => {
    const variants = [
      facts(),
      facts({ sites: [site({ wallet: true })] }),
      facts({
        sites: [site({ passkey: true, profile: "strict" })],
        services: [{ name: "a", requests: true, stellarClient: true }],
        contracts: { declared: 3, verified: 3, activity: true },
        publicStatsUrl: "https://x.example/p/a",
        snapshotUrl: "https://x.example/verify/1",
      }),
    ];
    for (const f of variants) {
      const out = userTrackingStatement(f);
      expect(out.paragraph).not.toMatch(FORBIDDEN_WORDING);
      expect(out.paragraph).not.toMatch(/\bSCF verified\b|\bSDF\b/);
      expect(out.never_collected).toEqual([...NEVER_COLLECTED]);
    }
    expect("verified by SCF").toMatch(FORBIDDEN_WORDING);
    expect("GDPR compliant").toMatch(FORBIDDEN_WORDING);
  });
});

describe("userTrackingWindow", () => {
  it("is the last 30 complete UTC days", () => {
    const w = userTrackingWindow(Date.parse("2026-11-19T15:30:00Z"));
    expect(w.end.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    expect(w.start.toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });
});
