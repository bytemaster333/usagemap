// SPDX-License-Identifier: Apache-2.0
// Usage rules of the portal: the snapshot series check (§i.3.3), the usage rules behind the overview and the trust
// view (trust band, open anomaly flags D10, on-chain sums of verified contracts, methodology confidence), the privacy
// card against docs/privacy/data-inventory.md §8 (D-4), the wording rule C4 over every source file, the badge, the
// snapshot presets and the dev-origin entry check.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ControlPlane } from "@usagemap/api-types";
import { describe, expect, it } from "vitest";
import { devOriginProblem } from "../../src/components/FirstEventPanel.tsx";
import { badgeHtml, badgeLines, badgeSvg, escapeXml } from "../../src/lib/badge.ts";
import { canonicalize } from "../../src/lib/jcs.ts";
import { NEVER_STORED, STELLAR_ENTRY } from "../../src/lib/privacyCard.ts";
import {
  checkSeries,
  describeSeriesProblem,
  type ListEntry,
  placeInSeries,
  snapshotSha256,
} from "../../src/lib/snapshotSeries.ts";
import {
  anomalyFlags,
  confidence,
  onchainTotals,
  openFlagCount,
  trustBand,
} from "../../src/lib/usage.ts";
import { itemState } from "../../src/pages/Footprint.tsx";
import { cohortLabel, sortCohorts } from "../../src/pages/operator/OperatorCohorts.tsx";
import { completeQuarters, quarterPeriod } from "../../src/pages/TractionSnapshots.tsx";
import { fmtCount, funnelRows, walletRows } from "../../src/pages/WalletFunnel.tsx";

const ROOT = join(__dirname, "../../../..");

describe("snapshot series (§i.3.3)", () => {
  const h = (n: number) => String(n).repeat(64).slice(0, 64);
  const e = (seq: number, prev: string | null): ListEntry => ({
    snapshot_id: `id-${seq}`,
    seq,
    previous_sha256: prev,
    sha256: h(seq),
    status: "valid",
  });
  it("accepts 1, 2, 3 linked by hash", () => {
    expect(checkSeries([e(1, null), e(2, h(1)), e(3, h(2))])).toEqual([]);
    expect(checkSeries([])).toEqual([]);
  });
  it("finds a gap, a broken link, a wrong start and a wrong order", () => {
    expect(checkSeries([e(1, null), e(3, h(2))])).toEqual([{ kind: "gap", after: 1, next: 3 }]);
    expect(checkSeries([e(1, null), e(2, h(9))])).toEqual([{ kind: "broken_link", seq: 2 }]);
    expect(checkSeries([e(2, h(1))])).toEqual([{ kind: "does_not_start_at_1", first: 2 }]);
    expect(checkSeries([e(1, h(0))])).toEqual([{ kind: "first_has_previous", seq: 1 }]);
    expect(checkSeries([e(2, h(1)), e(1, null)]).some((p) => p.kind === "not_sorted")).toBe(true);
    expect(describeSeriesProblem({ kind: "gap", after: 1, next: 3 })).toBe(
      "Snapshot 2 is missing from the list.",
    );
    expect(describeSeriesProblem({ kind: "gap", after: 1, next: 5 })).toBe(
      "Snapshots 2–4 are missing from the list.",
    );
  });
  it("places a snapshot and compares its signed series with the list", () => {
    const list = [e(1, null), e(2, h(1))];
    expect(placeInSeries(list, "id-2", h(2), { seq: 2, previous_sha256: h(1) })).toMatchObject({
      kind: "listed",
      hashOk: true,
      seqOk: true,
      previousOk: true,
    });
    expect(placeInSeries(list, "id-2", h(7), { seq: 1, previous_sha256: null })).toMatchObject({
      hashOk: false,
      seqOk: false,
      previousOk: false,
    });
    expect(placeInSeries(list, "id-9", h(9), null)).toEqual({ kind: "not_listed" });
  });
  it("hashes the RFC 8785 form, like the server's list does", async () => {
    const doc = { b: [1, "é", { z: null, a: true }], a: 1.5 };
    expect(await snapshotSha256(doc)).toBe(
      createHash("sha256").update(canonicalize(doc), "utf8").digest("hex"),
    );
  });
});

type TrustScore = ControlPlane.TrustScore;
const score = (day: string, w: 1 | 28, s: number | null, codes: string[]): TrustScore => ({
  site_id: "s1",
  day,
  window_days: w,
  score: s,
  components: {},
  reason_codes: codes,
  algorithm_version: "t/1",
});
const ann = (
  start: string,
  end: string,
  codes: string[],
  marks = false,
): ControlPlane.Annotation => ({
  annotation_id: `a-${start}`,
  site_id: "s1",
  service_id: null,
  start: `${start}T00:00:00Z`,
  end: `${end}T00:00:00Z`,
  author_kind: "tenant",
  body: "x",
  explains_reason_codes: codes,
  marks_explained: marks,
  created_at: "2026-11-10T00:00:00Z",
});

describe("usage rules", () => {
  it("trust bands at 80 / 50 (the operator filter)", () => {
    expect([trustBand(80), trustBand(79), trustBand(50), trustBand(49), trustBand(null)]).toEqual([
      "high",
      "medium",
      "medium",
      "low",
      "unscored",
    ]);
  });
  it("open anomaly flags: 1-day scores, insufficient_data ignored, annotations explain codes (D10)", () => {
    const scores = [
      score("2026-11-09", 1, 41, ["step_change", "burstiness_high"]),
      score("2026-11-03", 1, 58, ["network_datacenter_share_high"]),
      score("2026-11-04", 1, null, ["insufficient_data"]),
      score("2026-11-12", 28, 84, ["step_change"]),
    ];
    const flags = anomalyFlags(scores, [ann("2026-11-09", "2026-11-10", ["step_change"])]);
    expect(flags.map((f) => f.day)).toEqual(["2026-11-09", "2026-11-03"]);
    expect(flags[0]?.explained).toBe(false);
    expect(openFlagCount(flags)).toBe(2); // burstiness_high and the 3 Nov code
    const all = anomalyFlags(scores, [
      ann("2026-11-09", "2026-11-10", ["step_change", "burstiness_high"]),
      ann("2026-11-01", "2026-11-08", [], true),
    ]);
    expect(all.every((f) => f.explained)).toBe(true);
    expect(openFlagCount(all)).toBe(0);
    // the range end is exclusive
    expect(anomalyFlags(scores, [ann("2026-11-08", "2026-11-09", [], true)])[0]?.explained).toBe(
      false,
    );
  });
  it("on-chain sums cover verified contracts only; `public` is mainnet", () => {
    const rows: ControlPlane.OnchainDay[] = [
      {
        contract_id: "C1",
        network: "public",
        contract_status: "verified",
        day: "2026-11-01",
        invocations: 10,
        successful_invocations: 9,
        distinct_invokers: 3,
      },
      {
        contract_id: "C1",
        network: "public",
        contract_status: "verified",
        day: "2026-11-02",
        invocations: 5,
        successful_invocations: 5,
        distinct_invokers: 2,
      },
      {
        contract_id: "C2",
        network: "public",
        contract_status: "declared",
        day: "2026-11-01",
        invocations: 100,
      },
      {
        contract_id: "C3",
        network: "testnet",
        contract_status: "verified",
        day: "2026-11-01",
        invocations: 50,
      },
    ];
    expect(onchainTotals(rows, "mainnet")).toEqual({
      network: "mainnet",
      verifiedContracts: 1,
      invocations: 15,
      successful: 14,
      invokersDailySum: 5,
      days: 2,
    });
    expect(onchainTotals(rows, "testnet").invocations).toBe(50);
  });
  it("confidence follows scf-methodology/1.0.0", () => {
    const base = {
      days: 30,
      rawPageviews: 50_000,
      daysWithEvents: 30,
      suspectShare: 0.05,
      openFlags: 0,
      level: "L3",
      hasApi: true,
      onchainEnabled: true,
      verifiedContracts: 1,
    };
    expect(confidence(base)).toEqual({ level: "high", reasons: [] });
    expect(confidence({ ...base, openFlags: 2 })).toEqual({
      level: "medium",
      reasons: ["open_anomaly_flags"],
    });
    expect(confidence({ ...base, openFlags: 2, suspectShare: 0.31, level: "L0" }).level).toBe(
      "low",
    );
    expect(confidence({ ...base, rawPageviews: 200 }).reasons).toContain("few_events");
    expect(confidence({ ...base, daysWithEvents: 23 }).reasons).toContain("partial_coverage");
    expect(confidence({ ...base, verifiedContracts: 0 }).reasons).toContain(
      "no_verified_contracts",
    );
    expect(confidence({ ...base, rawPageviews: 3, hasApi: false, verifiedContracts: 0 })).toEqual({
      level: "insufficient",
      reasons: [],
    });
  });
});

describe("privacy card (D-4): docs/privacy/data-inventory.md §8, word for word", () => {
  /** The inventory's bullets without Markdown, register references and the note naming the card. */
  function inventoryBullets(): string[] {
    const md = readFileSync(join(ROOT, "docs/privacy/data-inventory.md"), "utf8");
    const section = md.split(/^## 8\.[^\n]*\n/m)[1]?.split(/^## /m)[0] ?? "";
    const items: string[] = [];
    for (const line of section.split("\n")) {
      if (line.startsWith("- ")) items.push(line.slice(2));
      else if (/^\s+\S/.test(line) && items.length > 0)
        items[items.length - 1] += ` ${line.trim()}`;
    }
    return items.map((s) =>
      s
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .replace(/\s*\((?:C-\d+|ADR-\d+)(?:,\s*(?:C-\d+|ADR-\d+))*\)/g, "")
        .replace(/,\s*C-\d+\)/g, ")")
        .replace(/, §\d+\)/g, ")")
        .replace(/\s*This is the wording of the "what we never store" card \(plan D-4\)\./, "")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  it("every entry, in order", () => {
    expect(NEVER_STORED).toEqual(inventoryBullets());
  });
  it("leads with the Stellar statement", () => {
    expect(NEVER_STORED[STELLAR_ENTRY]).toMatch(/^Stellar account keys/);
    expect(NEVER_STORED[STELLAR_ENTRY]).toContain("No visitor's address is ever collected.");
  });
});

describe("wording rule C4: measurements, never an endorsement", () => {
  const FORBIDDEN = [
    /\bSCF[- ]verified\b/i,
    /\bSDF[- ]verified\b/i,
    /\bverified by (?:the )?(?:SCF|SDF)\b/i,
    /\b(?:SCF|SDF)[- ]approved\b/i,
    /\bapproved by (?:the )?(?:SCF|SDF)\b/i,
    /(?<!not an )(?<!not )\bendorsed by (?:the )?(?:SCF|SDF)\b/i,
    /\bcertified by (?:the )?(?:SCF|SDF)\b/i,
  ];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|html)$/.test(f) ? [p] : [];
    });
  it("no page, badge or card says SCF verified / SDF approved", () => {
    const hits: string[] = [];
    for (const f of [...files(join(__dirname, "../../src")), join(__dirname, "../../index.html")]) {
      const text = readFileSync(f, "utf8");
      for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });
  it("the rule itself catches the phrases", () => {
    expect(FORBIDDEN.some((r) => r.test("SCF verified project"))).toBe(true);
    expect(FORBIDDEN.some((r) => r.test("approved by SDF"))).toBe(true);
    expect(FORBIDDEN.some((r) => r.test("not endorsed by SCF or SDF"))).toBe(false);
  });
});

describe("badge (D-5)", () => {
  const input = {
    name: 'A & B <"x">',
    verifiedVisitors: 9118,
    days: 30,
    asOf: "2026-11-12",
    cardUrl: "https://portal.example/p/a-b",
  };
  it("describes a measurement and escapes every text", () => {
    expect(badgeLines(input).right).toBe("9,118 verified visitors / 30 d");
    expect(badgeLines(input).title).toContain("not an endorsement");
    // rule C4: our product name, nothing that reads as SCF's or SDF's own service or approval
    expect(badgeLines(input).title).toContain("Measured by UsageMap");
    expect(badgeLines(input).title).not.toMatch(/SCF (Web|Analytics)|Measured by SCF/);
    expect(badgeLines(input).title).toContain("not an endorsement by SCF, SDF or anyone else");
    const svg = badgeSvg(input);
    expect(svg).toContain("A &amp; B &lt;&quot;x&quot;&gt;");
    expect(svg).not.toContain("<script");
    expect(badgeHtml(input)).toMatch(
      /^<a href="https:\/\/portal\.example\/p\/a-b" rel="noopener"><svg /,
    );
    expect(escapeXml(`'`)).toBe("&apos;");
  });
});

describe("snapshot presets (§i.3.2)", () => {
  it("a PG renewal quarter is exactly one calendar quarter", () => {
    expect(quarterPeriod(2026, 3)).toEqual({
      start: "2026-07-01T00:00:00Z",
      end: "2026-10-01T00:00:00Z",
    });
    expect(quarterPeriod(2025, 4)).toEqual({
      start: "2025-10-01T00:00:00Z",
      end: "2026-01-01T00:00:00Z",
    });
  });
  it("offers complete quarters only, newest first", () => {
    const q = completeQuarters(new Date("2026-11-16T12:00:00Z"), 3);
    expect(q).toEqual([
      { year: 2026, q: 3 },
      { year: 2026, q: 2 },
      { year: 2026, q: 1 },
    ]);
    expect(completeQuarters(new Date("2026-01-05T00:00:00Z"), 1)).toEqual([{ year: 2025, q: 4 }]);
  });
});

describe("first-event panel: dev-origin entries (§a.8)", () => {
  it("accepts localhost, 127.0.0.1, exact hosts and one leftmost wildcard", () => {
    for (const ok of [
      "localhost",
      "127.0.0.1",
      "preview.example.org",
      "myapp-*.vercel.app",
      "*-team.example.org",
    ])
      expect(devOriginProblem(ok)).toBeNull();
  });
  it("refuses schemes, ports, paths and misplaced or repeated wildcards", () => {
    for (const bad of [
      "https://x.example",
      "localhost:3000",
      "x.example/a",
      "a.*.example",
      "*-*.example.org",
      "",
      "nodot",
    ])
      expect(devOriginProblem(bad)).not.toBeNull();
  });
});

describe("footprint state", () => {
  const item = (o: Partial<ControlPlane.FootprintItem>): ControlPlane.FootprintItem => ({
    item_id: "i",
    kind: "contract",
    subject: "C".padEnd(56, "A"),
    network: "mainnet",
    status: "claimed",
    created_at: "2026-11-01T00:00:00Z",
    ...o,
  });
  it("a conflict overrides verified; rejected names its reason", () => {
    expect(
      itemState(item({ status: "verified", conflict_since: "2026-11-08T00:00:00Z" })).text,
    ).toBe("conflict — under review");
    expect(itemState(item({ status: "verified" })).text).toBe("verified");
    expect(
      itemState(item({ status: "rejected", rejected_reason: "not_found_on_ledger" })).text,
    ).toBe("rejected: the contract was not found on the ledger");
    expect(itemState(item({})).text).toBe("claimed, not yet verified");
  });
});

describe("wallet funnel (D-6)", () => {
  const funnel: ControlPlane.WalletFunnel = {
    range: { start: "2026-10-14T00:00:00Z", end: "2026-11-13T00:00:00Z" },
    network: "mainnet",
    variant: "verified",
    schema: "scf-stellar-events/1",
    steps: [
      {
        event: "wallet_connect",
        count: 100,
        by_wallet: { freighter: 70, xbull: 30 },
        by_property: {},
      },
      { event: "wallet_modal_opened", count: 400, by_wallet: {}, by_property: {} },
      {
        event: "sign_requested",
        count: 50,
        by_wallet: { freighter: 40, xbull: 10 },
        by_property: {},
      },
      {
        event: "tx_submitted",
        count: 45,
        by_wallet: {},
        by_property: { result_class: { success: 40, failed: 5 } },
      },
    ],
    daily: [],
  };
  it("orders the steps, counts successful transaction submissions only and computes shares of the first step", () => {
    const rows = funnelRows(funnel);
    expect(rows.map((r) => r.event)).toEqual([
      "wallet_modal_opened",
      "wallet_selected",
      "wallet_connect",
      "sign_requested",
      "sign_approved",
      "tx_submitted",
    ]);
    expect(rows.find((r) => r.event === "tx_submitted")?.count).toBe(40);
    expect(rows.find((r) => r.event === "wallet_connect")?.share).toBe(0.25);
  });
  it("lists wallets by connections; a withheld (null) count is never shown as zero", () => {
    expect(walletRows(funnel).map((w) => w.wallet)).toEqual(["freighter", "xbull"]);
    expect(fmtCount(null)).toBe("withheld");
    expect(fmtCount(0)).toBe("0");
    const withheld = {
      ...funnel,
      steps: [
        {
          ...(funnel.steps[0] as ControlPlane.WalletFunnel["steps"][number]),
          count: null as unknown as number,
        },
      ],
    };
    expect(funnelRows(withheld).find((r) => r.event === "wallet_connect")?.count).toBeNull();
  });
});

describe("operator cohorts (C3)", () => {
  it("labels the vocabularies of §i.4 and orders rounds newest first", () => {
    expect(cohortLabel("round", "45")).toBe("Round #45");
    expect(cohortLabel("category", "infrastructure_services")).toBe("Infrastructure & Services");
    expect(cohortLabel("award_stage", "t2_testnet")).toBe("#2 Testnet");
    const c = (cohort: string) => ({ cohort }) as ControlPlane.Cohort;
    expect(sortCohorts("round", [c("43"), c("45"), c("44")]).map((x) => x.cohort)).toEqual([
      "45",
      "44",
      "43",
    ]);
    expect(
      sortCohorts("category", [c("developer_tooling"), c("end_user_application")]).map(
        (x) => x.cohort,
      ),
    ).toEqual(["end_user_application", "developer_tooling"]);
  });
});
