// SPDX-License-Identifier: Apache-2.0
// The documented worked examples of trust/1.0.0 (src/trust/algorithm.ts; ADR-0028, C-44, CR-35) and of the API
// assurance levels A0–A2 and the A3 badge (src/jobs/trust-scoring.ts). Default weights = the `trust_weights` setting.

import { describe, expect, it } from "vitest";
import { assurance } from "../../src/jobs/trust-scoring.ts";
import { jsd, percentileRank, scoreSite, validWeights } from "../../src/trust/algorithm.ts";

const W = validWeights({
  proof_coverage: 25,
  network_quality: 15,
  multiplicity: 15,
  engagement: 15,
  mix: 10,
  temporal: 10,
  pow_latency: 5,
  cross_signal: 5,
});

describe("trust/1.0.0 worked examples", () => {
  it("E1 clean site: every component below its lower threshold → 100, no codes", () => {
    const r = scoreSite(
      {
        pageviewsRaw: 1000,
        pageviewsVerified: 980,
        counters: {
          verdict: { verified: 980, suspect: 20 },
          asn_class: { eyeball_fixed: 900, eyeball_mobile: 50, datacenter: 50 },
          multiplicity: { one: 950, low: 30, high: 20 },
          client_signal: { hidden: 30 },
          pow_latency: { lt100ms: 10, "300ms_1s": 900, none: 90 },
        },
      },
      W,
      10,
    );
    expect(r.score).toBe(100);
    expect(r.reason_codes).toEqual([]);
    expect(r.decision_rate).toBe(0.02);
    expect(r.components.network_quality).toMatchObject({ value: 0.05, p: 0 });
    expect(r.components.mix).toMatchObject({ omitted: true, p: 0 }); // no 7-day history
  });

  it("E2 inflated site: five components at their documented values → 50 with five codes", () => {
    const r = scoreSite(
      {
        pageviewsRaw: 1000,
        pageviewsVerified: 400,
        counters: {
          verdict: { verified: 400, suspect: 500, rejected: 100 },
          asn_class: { eyeball_fixed: 700, datacenter: 300 },
          multiplicity: { one: 825, high: 175 },
          client_signal: { webdriver: 450 },
          pow_latency: { lt100ms: 275, "100_300ms": 725 },
        },
      },
      W,
      10,
    );
    // 25·1 + 15·0.5 + 15·0.5 + 15·0.5 + 5·0.5 = 50
    expect(r.score).toBe(50);
    expect(r.reason_codes).toEqual([
      "proof_coverage_low",
      "network_datacenter_share_high",
      "multiplicity_share_high",
      "engagement_low",
      "pow_latency_implausible",
    ]);
    expect(r.decision_rate).toBe(0.6);
    expect(r.components.proof_coverage).toMatchObject({
      value: 0.6,
      p: 1,
      code: "proof_coverage_low",
    });
    expect(r.components.engagement).toMatchObject({ value: 0.45, p: 0.5 });
  });

  it("E3 step change and device mix shift against the site's own 10-day baseline → 90", () => {
    const r = scoreSite(
      {
        pageviewsRaw: 650,
        pageviewsVerified: 650,
        counters: {},
        mix: {
          device: [{ desktop: 650 }, { desktop: 500, mobile: 500 }],
          country: [{ DE: 650 }, { DE: 1000 }],
        },
        history: new Array(10).fill(100),
      },
      W,
      10,
    );
    // mix: JSD = 0.3113 → p 0.5282 → 5.28; temporal: 650/100 = 6.5 → p 0.5 → 5; 100 − 10.28 → 90
    expect(r.components.mix).toMatchObject({
      value: 0.3113,
      p: 0.5282,
      code: "mix_divergent_device",
    });
    expect(r.components.temporal).toMatchObject({ value: 6.5, p: 0.5, code: "step_change" });
    expect(r.score).toBe(90);
    expect(r.reason_codes).toEqual(["mix_divergent_device", "step_change"]);
  });

  it("E6 burst without history: 60 % of the day's page views in one hour → p 0.7 → 93, burstiness_high", () => {
    const hourly = new Array(24).fill(0);
    hourly[10] = 60;
    for (const h of [0, 1, 2, 3]) hourly[h] = 10;
    const r = scoreSite({ pageviewsRaw: 100, pageviewsVerified: 100, counters: {}, hourly }, W, 10);
    // burst = 60 / 100 = 0.6 → p (0.6 − 0.25) / 0.5 = 0.7 → 7; step omitted (< 7 days of history)
    expect(r.components.temporal).toMatchObject({ value: 0.6, p: 0.7, code: "burstiness_high" });
    expect(r.score).toBe(93);
    expect(r.reason_codes).toEqual(["burstiness_high"]);
  });

  it("E7 temporal is the larger half: step 6.5 (p 0.5) vs burst 0.5 (p 0.5) → step; burst 0.75 wins", () => {
    const flat = (top: number) => {
      const h = new Array(24).fill(0);
      h[0] = top;
      h[1] = 650 - top;
      return h;
    };
    const base = {
      pageviewsRaw: 650,
      pageviewsVerified: 650,
      counters: {},
      history: new Array(10).fill(100),
    };
    const even = scoreSite({ ...base, hourly: flat(325) }, W, 10);
    expect(even.components.temporal).toMatchObject({ value: 6.5, p: 0.5, code: "step_change" });
    const spike = scoreSite({ ...base, hourly: flat(650) }, W, 10);
    expect(spike.components.temporal).toMatchObject({ value: 1, p: 1, code: "burstiness_high" });
    expect(spike.score).toBe(90);
    // no hourly rows and no history: temporal omitted
    const none = scoreSite({ pageviewsRaw: 650, pageviewsVerified: 650, counters: {} }, W, 10);
    expect(none.components.temporal).toMatchObject({ omitted: true, p: 0 });
  });

  it("E4 fewer raw page views than op_min_count → NULL with the single code insufficient_data (CR-35)", () => {
    const r = scoreSite(
      { pageviewsRaw: 9, pageviewsVerified: 0, counters: { verdict: { suspect: 9 } } },
      W,
      10,
    );
    expect(r).toEqual({
      score: null,
      components: {},
      reason_codes: ["insufficient_data"],
      decision_rate: 1,
    });
  });

  it("E5 strict site: client signals not collected → engagement omitted, never scored as missing (C-33)", () => {
    const r = scoreSite(
      {
        pageviewsRaw: 100,
        pageviewsVerified: 100,
        counters: { verdict: { verified: 100 }, client_signal: { not_collected: 100 } },
      },
      W,
      10,
    );
    expect(r.components.engagement).toMatchObject({ omitted: true, p: 0 });
    expect(r.score).toBe(100);
  });

  it("helpers: JSD bounds, percentile rank, weights must sum to 100", () => {
    expect(jsd({ a: 1 }, { a: 5 })).toBe(0);
    expect(jsd({ a: 1 }, { b: 1 })).toBe(1);
    expect(jsd({}, { b: 1 })).toBeNull();
    expect(percentileRank(3, [1, 2, 3, 4])).toBe(75);
    expect(() => validWeights({ ...W, mix: 11 })).toThrow();
  });
});

describe("API assurance A1-1.0.0", () => {
  const svc = {
    tenant_id: "t",
    service_id: "s",
    read_only_api: false,
    base_url: true,
    requests: 5000,
    dmin: 0.002,
    dmax: 1.2,
    dsum: 250,
    bad_status: false,
  };
  it("A1 passes on plausible data; A2 is not probed by this job; A3 consistent with on-chain activity", () => {
    const r = assurance(svc, {}, new Array(10).fill(4000), {
      verified: 1,
      rows: 1,
      successful: 40,
    });
    expect(r).toMatchObject({ level: 1, onchain_badge: "consistent", reason_codes: [] });
    expect(r.checks.A2).toMatchObject({ pass: false, status: "not_probed" });
  });
  it("A1 fails with the documented codes", () => {
    const r = assurance(
      { ...svc, dsum: 0.1, requests: 50_000 },
      { malformed_point: 3, route_overflow: 2 },
      new Array(10).fill(1000),
      { verified: 1, rows: 1, successful: 0 },
    );
    expect(r.level).toBe(0);
    expect(r.reason_codes).toEqual([
      "a1_status_mix_implausible",
      "a1_latency_implausible",
      "a1_rate_implausible",
      "a1_route_profile_implausible",
      "a3_onchain_inconsistent",
    ]);
  });
  it("A3 is not applicable without verified contracts or for read-only APIs, unavailable without on-chain rows", () => {
    expect(
      assurance({ ...svc, base_url: false }, {}, [], { verified: 0, rows: 0, successful: 0 }),
    ).toMatchObject({
      onchain_badge: "not_applicable",
      reason_codes: ["a2_no_base_url", "a3_no_verified_contract"],
    });
    expect(
      assurance({ ...svc, read_only_api: true }, {}, [], { verified: 2, rows: 2, successful: 0 })
        .onchain_badge,
    ).toBe("not_applicable");
    expect(assurance(svc, {}, [], { verified: 1, rows: 0, successful: 0 }).onchain_badge).toBe(
      "unavailable",
    );
  });
});
