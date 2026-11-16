// SPDX-License-Identifier: Apache-2.0
// SCF Evidence Link (traction snapshot v3): presets (Growth Hack weekly averages and active-account interval, cohort
// share, Public Goods quarter), the cohort percentile with its confidence gates and minimum-data floors, the funnel's
// small-count floor, and the pasteable text's wording rule (C4).

import { describe, expect, it } from "vitest";
import { cohortPosition, comparisonBlock } from "../../src/evidence/comparison.ts";
import { floorCell, shapeFunnel } from "../../src/evidence/funnel.ts";
import {
  campaignAverages,
  cohortShare,
  growthHackBaseline,
  isWholeIsoWeeks,
  previousQuarter,
  publicGoodsBlock,
  quarterLabel,
  relativeChange,
  type WindowDays,
  weeklyAverage,
  weeklyFigures,
} from "../../src/evidence/presets.ts";
import { snapshotTextV3, WORDING } from "../../src/evidence/snapshot-v3.ts";

const DAY = 86_400_000;
const D = (s: string) => Date.parse(`${s}T00:00:00Z`);

describe("Growth Hack preset (C5)", () => {
  it("needs whole ISO weeks; the baseline is the same number of weeks right before", () => {
    // 2026-10-05 is a Monday
    expect(isWholeIsoWeeks(D("2026-10-05"), D("2026-11-02"))).toBe(true);
    expect(isWholeIsoWeeks(D("2026-10-06"), D("2026-11-03"))).toBe(false); // Tuesday
    expect(isWholeIsoWeeks(D("2026-10-05"), D("2026-10-30"))).toBe(false); // not a multiple of 7
    expect(isWholeIsoWeeks(D("2026-10-05"), D("2026-10-05"))).toBe(false);
    const b = growthHackBaseline(D("2026-10-05"), D("2026-11-02"));
    expect(new Date(b.start).toISOString().slice(0, 10)).toBe("2026-09-07");
    expect(b.end).toBe(D("2026-10-05"));
  });

  it("weekly values: on-chain calls, an honest active-account interval, web and API per week", () => {
    const w: WindowDays = {
      web: [
        { day: D("2026-10-05"), visitors_verified: 10, pageviews_verified: 20 },
        { day: D("2026-10-13"), visitors_verified: 7, pageviews_verified: 9 },
      ],
      api: [{ day: D("2026-10-06"), requests: 100 }],
      onchain: [
        { day: D("2026-10-05"), contract: "a", invocations: 30, successful: 29, invokers: 12 },
        { day: D("2026-10-06"), contract: "a", invocations: 10, successful: 10, invokers: 5 },
        { day: D("2026-10-06"), contract: "b", invocations: 4, successful: 4, invokers: 3 },
        { day: D("2026-10-14"), contract: "b", invocations: 8, successful: 7, invokers: 6 },
      ],
    };
    const weeks = weeklyFigures(w, D("2026-10-05"), D("2026-10-19"), "campaign");
    expect(weeks).toEqual([
      {
        start: "2026-10-05T00:00:00Z",
        window: "campaign",
        onchain_calls: 44,
        active_accounts_min: 12, // largest daily count of one contract
        active_accounts_max: 20, // 12 + 5 + 3: every account counted on every day and contract
        web_visitors_verified: 10,
        api_requests: 100,
      },
      {
        start: "2026-10-12T00:00:00Z",
        window: "campaign",
        onchain_calls: 8,
        active_accounts_min: 6,
        active_accounts_max: 6,
        web_visitors_verified: 7,
        api_requests: 0,
      },
    ]);
    // without on-chain figures the on-chain values are null, never 0
    const noChain = weeklyFigures(
      { ...w, onchain: null, api: null },
      D("2026-10-05"),
      D("2026-10-12"),
      "baseline",
    );
    expect(noChain[0]).toMatchObject({
      onchain_calls: null,
      active_accounts_min: null,
      api_requests: null,
    });
  });

  it("averages are sum of weekly values ÷ weeks; change = campaign − baseline; ratio guarded at 0", () => {
    const wk = (calls: number, v: number) => ({
      start: "x",
      window: "campaign" as const,
      onchain_calls: calls,
      active_accounts_min: calls / 2,
      active_accounts_max: calls,
      web_visitors_verified: v,
      api_requests: null,
    });
    const base = [wk(10, 0), wk(20, 0), wk(0, 0), wk(10, 0)];
    const camp = [wk(40, 5), wk(40, 5), wk(41, 5), wk(40, 6)];
    expect(weeklyAverage(base, "onchain_calls")).toBe(10);
    const a = campaignAverages(base, camp);
    expect(a.campaign.onchain_calls).toBe(40.3);
    expect(a.change.onchain_calls).toBe(30.3);
    expect(a.ratio.onchain_calls).toBe(4.03); // of the published (rounded) averages
    expect(a.ratio.web_visitors_verified).toBeNull(); // baseline 0
    expect(a.campaign.api_requests).toBeNull();
    expect(weeklyAverage([], "onchain_calls")).toBeNull();
  });

  it("cohort share = max(Δ,0) ÷ Σ max(Δ,0), only from 5 projects up", () => {
    const c = { kind: "round" as const, id: "29" };
    expect(cohortShare(c, 30, [30, 10, -5, 0, 20], 5)).toEqual({
      status: "shown",
      cohort: c,
      projects: 5,
      share: 0.5,
    });
    expect(cohortShare(c, 30, [30, 10, 20, 0], 5).status).toBe("not_enough_projects");
    expect(cohortShare(c, -3, [-3, 10, 20, 0, 1], 5).status).toBe("no_increase");
    expect(cohortShare(null, 30, [], 5).status).toBe("no_cohort");
    expect(cohortShare(c, null, [1, 2, 3, 4, 5], 5).status).toBe("no_onchain_data");
  });
});

describe("Public Goods preset", () => {
  it("quarter labels, the previous quarter, figures with change and the three months", () => {
    expect(quarterLabel(D("2026-07-01"))).toBe("2026-Q3");
    const pq = previousQuarter(D("2026-01-01"));
    expect(new Date(pq.start).toISOString().slice(0, 10)).toBe("2025-10-01");
    expect(relativeChange(150, 100)).toBe(0.5);
    expect(relativeChange(1, 0)).toBeNull();
    const cur: WindowDays = {
      web: [
        { day: D("2026-07-02"), visitors_verified: 100, pageviews_verified: 300 },
        { day: D("2026-09-30"), visitors_verified: 50, pageviews_verified: 60 },
      ],
      api: [{ day: D("2026-08-01"), requests: 1000 }],
      onchain: [
        { day: D("2026-08-10"), contract: "a", invocations: 70, successful: 69, invokers: 9 },
      ],
    };
    const prev: WindowDays = {
      web: [{ day: D("2026-05-01"), visitors_verified: 100, pageviews_verified: 100 }],
      api: [{ day: D("2026-05-01"), requests: 500 }],
      onchain: [
        { day: D("2026-05-01"), contract: "a", invocations: 35, successful: 35, invokers: 4 },
      ],
    };
    const b = publicGoodsBlock(
      D("2026-07-01"),
      D("2026-10-01"),
      cur,
      { error_rate_5xx: 0.01, p95_ms: 120 },
      prev,
      { error_rate_5xx: 0.02, p95_ms: 150 },
    ) as {
      quarter: string;
      previous_quarter: { label: string };
      figures: Array<{
        metric: string;
        value: number | null;
        previous: number | null;
        change: number | null;
      }>;
      monthly: Array<Record<string, unknown>>;
      not_measured: string[];
    };
    expect(b.quarter).toBe("2026-Q3");
    expect(b.previous_quarter.label).toBe("2026-Q2");
    const f = Object.fromEntries(b.figures.map((x) => [x.metric, x]));
    expect(f.onchain_calls).toEqual({
      metric: "onchain_calls",
      value: 70,
      previous: 35,
      change: 1,
    });
    expect(f.web_visitors_verified?.change).toBe(0.5);
    expect(f.api_requests?.change).toBe(1);
    expect(f.api_error_rate_5xx).toMatchObject({ value: 0.01, previous: 0.02, change: null });
    expect(b.monthly.map((m) => m.start)).toEqual([
      "2026-07-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
    ]);
    expect(b.monthly[1]).toMatchObject({
      onchain_calls: 70,
      api_requests: 1000,
      web_visitors_verified: 0,
    });
    expect(b.not_measured).toContain("uptime");
  });
});

describe("cohort position: confidence gates and minimum-data floors", () => {
  const base = { minProjects: 5, minValue: 10, selfEligible: true, confidence: "high" };

  it("is a mid-rank percentile rounded to 5 with ≥ 5 projects that reach the floor", () => {
    expect(cohortPosition({ ...base, self: 50, others: [10, 20, 30, 40] })).toEqual({
      status: "shown",
      projects: 5,
      percentile: 100,
    });
    expect(cohortPosition({ ...base, self: 25, others: [10, 20, 30, 40] }).percentile).toBe(50);
    // ties count half: 1 below + 0.5 × 1 tie of 4 peers = 37.5 % → 40
    expect(cohortPosition({ ...base, self: 20, others: [10, 20, 30, 40] }).percentile).toBe(40);
    expect(cohortPosition({ ...base, self: 10, others: [10, 20, 30, 40] }).percentile).toBe(15);
  });

  it("peers below the floor do not count: 'not enough projects to compare'", () => {
    expect(cohortPosition({ ...base, self: 50, others: [10, 20, 30, 9] })).toEqual({
      status: "not_enough_projects",
      projects: null,
      percentile: null,
    });
    expect(cohortPosition({ ...base, self: 50, others: [] }).status).toBe("not_enough_projects");
    // a floor below 5 projects is never used, whatever the setting says
    expect(cohortPosition({ ...base, minProjects: 2, self: 50, others: [10] }).status).toBe(
      "shown",
    );
  });

  it("gates in order: low confidence, not eligible, not enough own data", () => {
    const many = [10, 20, 30, 40, 50];
    expect(cohortPosition({ ...base, confidence: "low", self: 50, others: many }).status).toBe(
      "low_confidence",
    );
    expect(
      cohortPosition({ ...base, confidence: "insufficient", self: 50, others: many }).status,
    ).toBe("low_confidence");
    expect(cohortPosition({ ...base, selfEligible: false, self: 50, others: many }).status).toBe(
      "not_eligible",
    );
    expect(cohortPosition({ ...base, self: 9, others: many }).status).toBe("not_enough_data");
    expect(cohortPosition({ ...base, self: null, others: many }).status).toBe("not_enough_data");
  });

  it("the block lists round then categories × metric and never another project's figure", () => {
    const m = (
      id: string,
      round: number,
      cats: string[],
      web: number,
      oc: number | null,
      eligible = true,
    ) => ({
      tenantId: id,
      eligible,
      rounds: [round],
      categories: cats,
      values: [{ web_visitors_verified: web, onchain_calls: oc }],
    });
    const data = {
      minProjects: 5,
      minValue: 10,
      members: [
        m("me", 29, ["developer_tooling"], 100, null),
        m("a", 29, ["developer_tooling"], 11, 50),
        m("b", 29, [], 12, 50),
        m("c", 29, [], 13, 50),
        m("d", 29, [], 14_999, 50),
        m("e", 29, ["developer_tooling"], 20, 50, false), // not eligible: never a peer
      ],
    };
    const b = comparisonBlock(
      data,
      "me",
      { web_visitors_verified: 100, onchain_calls: null },
      "medium",
    ) as {
      status: string;
      positions: Array<Record<string, unknown>>;
    };
    expect(b.status).toBe("ok");
    expect(b.positions).toEqual([
      {
        cohort: { kind: "round", id: "29" },
        metric: "web_visitors_verified",
        status: "shown",
        projects: 5,
        percentile: 75,
      },
      {
        cohort: { kind: "round", id: "29" },
        metric: "onchain_calls",
        status: "not_enough_data",
        projects: null,
        percentile: null,
      },
      {
        cohort: { kind: "category", id: "developer_tooling" },
        metric: "web_visitors_verified",
        status: "not_enough_projects",
        projects: null,
        percentile: null,
      },
      {
        cohort: { kind: "category", id: "developer_tooling" },
        metric: "onchain_calls",
        status: "not_enough_data",
        projects: null,
        percentile: null,
      },
    ]);
    expect(JSON.stringify(b)).not.toContain("14999");
    const lone = comparisonBlock(
      { ...data, members: [] },
      "me",
      { web_visitors_verified: 1, onchain_calls: null },
      "high",
    );
    expect(lone).toMatchObject({ status: "no_registry_link", positions: [] });
  });
});

describe("funnel small-count floor (C-137)", () => {
  it("publishes 0 and ≥ k exactly, 1 … k−1 as null, counting the suppressed cells", () => {
    expect([floorCell(0, 10), floorCell(9, 10), floorCell(10, 10), floorCell(null, 10)]).toEqual([
      0,
      null,
      10,
      null,
    ]);
    const f = shapeFunnel(
      [
        {
          day: "2026-10-01",
          web_visitors_verified: 120,
          web_visitors_raw: 130,
          wallet_connects_verified: 3,
          wallet_connects_raw: 4,
          signatures_verified: 0,
          signatures_raw: 1,
          onchain_calls: 25,
          onchain_calls_successful: 24,
        },
        {
          day: "2026-10-02",
          web_visitors_verified: 80,
          web_visitors_raw: 85,
          wallet_connects_verified: 12,
          wallet_connects_raw: 12,
          signatures_verified: 2,
          signatures_raw: 2,
          onchain_calls: null,
          onchain_calls_successful: null,
        },
      ],
      { web_visitors_verified: 200, web_visitors_raw: 215, onchain: { calls: 25 } },
      "mainnet",
      10,
    );
    expect(f.daily[0]).toMatchObject({
      wallet_connects_verified: null,
      signatures_verified: 0,
      signatures_raw: null,
    });
    expect(f.daily[1]).toMatchObject({
      wallet_connects_verified: 12,
      signatures_verified: null,
      onchain_calls: null,
    });
    expect(f.suppressed_cells).toBe(7); // 5 daily cells + the two signature totals
    expect(f.stages).toEqual([
      { stage: "web_visitors", verified: 200, raw: 215 },
      { stage: "wallet_connects", verified: 15, raw: 16 },
      { stage: "signatures", verified: null, raw: null }, // totals of 2 and 3 are under the floor too
      { stage: "onchain_calls", verified: 25, raw: 25 },
    ]);
    expect(f.conversion).toEqual({
      connects_per_visitor: 0.075,
      signatures_per_connect: null,
    });
  });
});

describe("v3 pasteable text (C4 wording)", () => {
  const doc = {
    project: { name: "Acme" },
    series: { seq: 3 },
    period: { start: "2026-10-05T00:00:00Z", end: "2026-11-02T00:00:00Z", days: 28 },
    preset: "growth_hack_during",
    issuer: "app.example.test",
    methodology: { version: "scf-methodology/1.0.0" },
    web: {
      verified: { pageviews: 12000, visitors_sum: 3000 },
      raw: { pageviews: 13000 },
      visit_metrics: { suspect_pageview_share: 0.0769 },
    },
    api: null,
    onchain: {
      network: "mainnet",
      verified_contracts: 1,
      invocations: 4000,
      successful_invocations: 3900,
    },
    funnel: {
      network: "mainnet",
      min_count: 10,
      stages: [
        { stage: "web_visitors", verified: 3000, raw: 3200 },
        { stage: "wallet_connects", verified: 400, raw: 420 },
        { stage: "signatures", verified: null, raw: null },
        { stage: "onchain_calls", verified: 4000, raw: 4000 },
      ],
    },
    programme: {
      kind: "growth_hack",
      baseline: { weeks: 4 },
      averages: {
        baseline: {
          onchain_calls: 500,
          active_accounts_min: 20,
          active_accounts_max: 90,
          web_visitors_verified: 400,
        },
        campaign: {
          onchain_calls: 1000,
          active_accounts_min: 40,
          active_accounts_max: 170,
          web_visitors_verified: 750,
        },
      },
      cohort_share: {
        status: "shown",
        share: 0.31,
        cohort: { kind: "round", id: "29" },
        projects: 6,
      },
    },
    comparison: {
      status: "ok",
      positions: [
        {
          cohort: { kind: "round", id: "29" },
          metric: "web_visitors_verified",
          status: "shown",
          projects: 6,
          percentile: 80,
        },
      ],
    },
    coverage: { web_days_with_events: 28, days_in_period: 28 },
    confidence: { level: "high", reasons: [] },
    anomaly_flags: { open_web: 0, open_api: 0 },
    wording: {
      statement: WORDING,
      seal: "sealed on Stellar testnet: a demonstration, not a permanent record",
    },
    links: {
      verify: "https://app.example.test/verify?snapshot=s1",
      public_list: "https://app.example.test/public/v1/projects/acme/snapshots",
      evidence: "https://app.example.test/evidence/s1",
    },
  };

  it("carries the evidence link, funnel, Growth Hack line, position and the measurement-not-endorsement statement", () => {
    const t = snapshotTextV3(doc);
    expect(t).toContain("Evidence page: https://app.example.test/evidence/s1");
    expect(t).toContain(
      "Funnel (verified, mainnet): 3,000 daily visitors (sum) → 400 wallet connects → fewer than 10 signatures → 4,000 on-chain calls",
    );
    expect(t).toContain(
      "on-chain calls 1000 vs 500; weekly active accounts 40–170 (baseline 20–90)",
    );
    expect(t).toContain("among 6 SCF round 29 projects measured here: 31%");
    expect(t).toContain("80th percentile of 6 SCF round 29 projects measured here");
    expect(t).toContain("not an endorsement");
    expect(t).toContain("Seal: sealed on Stellar testnet: a demonstration");
    expect(t).not.toMatch(/SCF[- ]verified|SDF[- ]approved|endorsed by SCF/i);
    expect(t.length).toBeLessThanOrEqual(4000);
  });

  it("says 'not enough projects to compare' without a shown position", () => {
    const t = snapshotTextV3({
      ...doc,
      comparison: { status: "ok", positions: [{ status: "not_enough_projects" }] },
    });
    expect(t).toContain("Position in SCF cohort: not enough projects to compare");
  });

  void DAY;
});
