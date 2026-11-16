// SPDX-License-Identifier: Apache-2.0
// Pure parts of the Stellar site features and the Registered Footprint (C-136, C-137): dev-origin rules (wire-formats §a.8), the wallet-funnel shaping (§a.3.1),
// snapshot v2 helpers (§i.3.2–§i.3.4: ISO weeks, confidence, text, presets) and the seal network view (§m.2).

import { describe, expect, it } from "vitest";
import { checkDevOrigins, isPublicSuffix } from "../../src/domain/dev-origins.ts";
import { PROP_VALUES } from "../../src/edge/counters.ts";
import {
  networkSettings,
  parseSealNetwork,
  SEAL_STATEMENT,
  sealNetworkView,
  TESTNET_NOTICE,
} from "../../src/programme/seal-network.ts";
import {
  confidence,
  isoWeekStart,
  isoWeeks,
  snapshotText,
  thousands,
} from "../../src/programme/snapshot-v2.ts";
import { isCalendarQuarter } from "../../src/programme/snapshots.ts";
import { FUNNEL_EVENTS, shapeFunnel } from "../../src/web/stellar.ts";

const D = (s: string) => Date.parse(`${s}T00:00:00Z`);

describe("dev origins (§a.8)", () => {
  const none = new Set<string>();
  it("accepts localhost, 127.0.0.1, exact hosts and preview patterns with ≥ 3 literal characters", () => {
    expect(
      checkDevOrigins(
        [
          "localhost",
          "127.0.0.1",
          "staging.example.org",
          "myapp-*.vercel.app",
          "*-myteam.example.org",
        ],
        none,
      ),
    ).toEqual([]);
  });

  it("refuses a bare wildcard above a public suffix, private section included, even when 'verified'", () => {
    for (const o of [
      "*.vercel.app",
      "*.netlify.app",
      "*.pages.dev",
      "*.github.io",
      "*.com",
      "*.co.uk",
    ]) {
      const p = checkDevOrigins([o], new Set([o.slice(2)]));
      expect(p, o).toHaveLength(1);
      expect(p[0]?.detail).toContain("public suffix");
    }
    expect(isPublicSuffix("vercel.app")).toBe(true);
    expect(isPublicSuffix("example.org")).toBe(false);
  });

  it("refuses fewer than 3 literal characters unless the rest is (under) a verified host of the tenant", () => {
    expect(checkDevOrigins(["ab*.example.org"], none)).toHaveLength(1);
    expect(checkDevOrigins(["*.preview.example.org"], none)).toHaveLength(1);
    expect(checkDevOrigins(["*.preview.example.org"], new Set(["example.org"]))).toEqual([]);
    expect(checkDevOrigins(["*.example.org"], new Set(["example.org"]))).toEqual([]);
    expect(checkDevOrigins(["ab*.example.org"], new Set(["other.example"]))).toHaveLength(1);
  });

  it("refuses bad grammar, duplicates and more than 10 entries", () => {
    for (const o of [
      "*",
      "*.*.example.org",
      "a.*.example.org",
      "Example.org",
      "http://x.org",
      "x.org:8080",
      "",
    ])
      expect(checkDevOrigins([o], none), JSON.stringify(o)).toHaveLength(1);
    expect(checkDevOrigins(["a.example", "a.example"], none)).toEqual([
      { index: 1, detail: "listed twice" },
    ]);
    const eleven = Array.from({ length: 11 }, (_, i) => `h${i}.example.org`);
    expect(checkDevOrigins(eleven, none).some((p) => p.detail.includes("at most 10"))).toBe(true);
  });
});

describe("wallet funnel shaping (§a.3.1)", () => {
  it("lists every v1 event in funnel order with totals, wallets, other properties and the daily series", () => {
    const f = shapeFunnel(
      [
        {
          day: "2026-11-01",
          event_name: "wallet_connect",
          prop_key: "_total",
          prop_value: "all",
          n: 3,
        },
        {
          day: "2026-11-02",
          event_name: "wallet_connect",
          prop_key: "_total",
          prop_value: "all",
          n: 2,
        },
        {
          day: "2026-11-01",
          event_name: "wallet_connect",
          prop_key: "wallet",
          prop_value: "freighter",
          n: 4,
        },
        {
          day: "2026-11-02",
          event_name: "wallet_connect",
          prop_key: "wallet",
          prop_value: "passkey",
          n: 1,
        },
        {
          day: "2026-11-01",
          event_name: "wallet_connect",
          prop_key: "connect_kind",
          prop_value: "new",
          n: 5,
        },
        {
          day: "2026-11-02",
          event_name: "tx_submitted",
          prop_key: "_total",
          prop_value: "all",
          n: 2,
        },
        {
          day: "2026-11-02",
          event_name: "tx_submitted",
          prop_key: "result_class",
          prop_value: "success",
          n: 1,
        },
        {
          day: "2026-11-02",
          event_name: "tx_submitted",
          prop_key: "result_class",
          prop_value: "failed",
          n: 1,
        },
        {
          day: "2026-11-02",
          event_name: "sign_approved",
          prop_key: "_total",
          prop_value: "all",
          n: 7,
        },
        {
          day: "2026-11-02",
          event_name: "not_an_event",
          prop_key: "_total",
          prop_value: "all",
          n: 9,
        },
      ],
      ["2026-11-01", "2026-11-02", "2026-11-03"],
    );
    expect(f.steps.map((s) => s.event)).toEqual([...FUNNEL_EVENTS]);
    expect(f.steps.find((s) => s.event === "wallet_connect")).toEqual({
      event: "wallet_connect",
      count: 5,
      by_wallet: { freighter: 4, passkey: 1 },
      by_property: { connect_kind: { new: 5 } },
    });
    expect(f.steps.find((s) => s.event === "tx_submitted")?.by_property).toEqual({
      result_class: { success: 1, failed: 1 },
    });
    expect(f.daily).toEqual([
      { day: "2026-11-01", wallet_connect: 3, sign_approved: 0, tx_submitted_success: 0 },
      { day: "2026-11-02", wallet_connect: 2, sign_approved: 7, tx_submitted_success: 1 },
      { day: "2026-11-03", wallet_connect: 0, sign_approved: 0, tx_submitted_success: 0 },
    ]);
  });

  it("the counter endpoint's closed value lists match the database check (§a.3.1)", () => {
    expect(Object.keys(PROP_VALUES).sort()).toEqual([
      "_total",
      "connect_kind",
      "duration",
      "error_class",
      "failure_reason",
      "outcome",
      "passkey_op",
      "result_class",
      "sign_kind",
      "wallet",
      "wallet_context",
      "wc_method",
      "wc_state",
    ]);
    expect(PROP_VALUES.wallet?.size).toBe(23); // + privy (tracker 1.2.0, migration 0086)
    expect(PROP_VALUES.result_class?.has("try_again_later")).toBe(true);
  });
});

describe("traction snapshot v2 helpers (§i.3.2–§i.3.4)", () => {
  it("ISO weeks start on Monday and are clipped to the period", () => {
    expect(new Date(isoWeekStart(D("2026-11-01"))).toISOString()).toBe("2026-10-26T00:00:00.000Z"); // a Sunday
    expect(isoWeekStart(D("2026-11-02"))).toBe(D("2026-11-02")); // a Monday
    expect(
      isoWeeks(D("2026-11-01"), D("2026-11-12")).map((w) => [
        new Date(w.start).toISOString().slice(0, 10),
        w.days,
      ]),
    ).toEqual([
      ["2026-10-26", 1],
      ["2026-11-02", 7],
      ["2026-11-09", 3],
    ]);
  });

  it("pg_renewal_quarter needs exactly one calendar quarter", () => {
    expect(isCalendarQuarter(D("2026-07-01"), D("2026-10-01"))).toBe(true);
    expect(isCalendarQuarter(D("2026-10-01"), D("2027-01-01"))).toBe(true);
    expect(isCalendarQuarter(D("2026-08-01"), D("2026-11-01"))).toBe(false);
    expect(isCalendarQuarter(D("2026-07-01"), D("2026-09-30"))).toBe(false);
    expect(isCalendarQuarter(D("2026-07-02"), D("2026-10-01"))).toBe(false);
  });

  const base = {
    days: 30,
    rawPageviews: 1000,
    verifiedPageviews: 900,
    webDaysWithEvents: 30,
    webDaysFinal: 30,
    minCount: 10,
    hasApiData: false,
    hasOnchainData: false,
    openFlags: 0,
    level: 1,
    onchainEnabled: false,
    verifiedContracts: 0,
  };
  it("confidence: high, medium, low and insufficient by the methodology 1.0.0 rule", () => {
    expect(confidence(base)).toEqual({ level: "high", reasons: [] });
    expect(confidence({ ...base, openFlags: 2 })).toEqual({
      level: "medium",
      reasons: ["open_anomaly_flags"],
    });
    expect(confidence({ ...base, level: 0, verifiedPageviews: 500, webDaysFinal: 29 })).toEqual({
      level: "low",
      reasons: ["days_not_final", "high_suspect_share", "domain_unverified"],
    });
    expect(confidence({ ...base, rawPageviews: 9, verifiedPageviews: 9 }).level).toBe(
      "insufficient",
    );
    // API or on-chain data lift a period with few page views out of `insufficient`
    expect(
      confidence({ ...base, rawPageviews: 9, verifiedPageviews: 9, hasApiData: true }),
    ).toEqual({
      level: "medium",
      reasons: ["few_events"],
    });
  });

  it("formats numbers with , separators and renders the pasteable text deterministically", () => {
    expect(thousands(1234567)).toBe("1,234,567");
    expect(thousands(12)).toBe("12");
    const doc = {
      project: { name: "Example" },
      series: { seq: 3 },
      period: { start: "2026-07-01T00:00:00Z", end: "2026-10-01T00:00:00Z", days: 92 },
      preset: "pg_renewal_quarter",
      issuer: "portal.test",
      methodology: { version: "scf-methodology/1.0.0" },
      web: {
        verified: { pageviews: 48213, visitors_sum: 9118 },
        raw: { pageviews: 51034 },
        visit_metrics: { suspect_pageview_share: 0.0553 },
      },
      api: null,
      onchain: {
        network: "mainnet",
        verified_contracts: 2,
        invocations: 1000,
        successful_invocations: 975,
        distinct_invokers_daily_sum: 4321,
      },
      coverage: { web_days_with_events: 90, days_in_period: 92 },
      confidence: { level: "medium", reasons: ["days_not_final"] },
      anomaly_flags: { open_web: 0, open_api: 0 },
      links: {
        verify: "https://portal.test/verify?snapshot=x",
        public_list: "https://portal.test/l",
      },
    };
    expect(snapshotText(doc)).toBe(
      [
        "Example — measured usage, 2026-07-01 to 2026-09-30 (92 days, Public Goods renewal quarter)",
        "Snapshot 3 of this project (all are listed at the link below)",
        "Web: 48,213 verified page views (51,034 raw; 5.5% suspect); 9,118 daily visitors (sum)",
        "On-chain (mainnet, 2 verified contracts): 1,000 invocations, 97.5% successful, 4,321 daily invokers (sum)",
        "Coverage: 90/92 days with web events; confidence medium: days_not_final",
        "Open anomaly flags: web 0, API 0",
        'Measured by portal.test (methodology scf-methodology/1.0.0). "Verified" means passed our bot checks, not endorsed by SCF or SDF.',
        "Verify: https://portal.test/verify?snapshot=x   All snapshots of this project: https://portal.test/l",
      ].join("\n"),
    );
    // wording rule C4: never "endorsed by"/"approved" as a claim
    expect(snapshotText(doc)).not.toMatch(/\b(approved|genuine)\b/i);
  });
});

describe("seal network (§m.2)", () => {
  const env = (o: Record<string, string>) => (n: string) => o[n];
  it("defaults to testnet with the demonstration notice and no ledger-file root", () => {
    const cfg = parseSealNetwork(env({}));
    expect(sealNetworkView(cfg)).toEqual({
      name: "testnet",
      passphrase: "Test SDF Network ; September 2015",
      durable: false,
      notice: TESTNET_NOTICE,
      lookup: {
        horizon: "https://horizon-testnet.stellar.org",
        explorer: "https://stellar.expert/explorer/testnet/tx/{tx_hash}",
        ledger_files: null,
      },
    });
    expect(SEAL_STATEMENT).toContain("does not show that the numbers are genuine");
  });

  it("mainnet is durable, has no notice and points at the public ledger files; another network gets defaults", () => {
    const cfg = parseSealNetwork(
      env({ SCF_SEAL_NETWORK: "mainnet", SCF_SEAL_HORIZON_URL: "https://horizon.example.org/" }),
    );
    const v = sealNetworkView(cfg);
    expect(v).toMatchObject({ name: "mainnet", durable: true, notice: null });
    expect(v.lookup.horizon).toBe("https://horizon.example.org");
    expect(v.lookup.ledger_files).toContain("/v1.1/stellar/ledgers/pubnet");
    expect(sealNetworkView(networkSettings(cfg, "testnet")).notice).toBe(TESTNET_NOTICE);
    expect(() => parseSealNetwork(env({ SCF_SEAL_NETWORK: "futurenet" }))).toThrow();
    expect(() => parseSealNetwork(env({ SCF_SEAL_EXPLORER_URL: "https://x.org/tx" }))).toThrow();
    expect(() => parseSealNetwork(env({ SCF_SEAL_HORIZON_URL: "http://x.org" }))).toThrow();
  });
});
