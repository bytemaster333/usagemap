// SPDX-License-Identifier: Apache-2.0
// Web reports (funnel, goals, journey): step parameters and the privacy floor of the presentation (wire-formats §j.3
// R6–R8; C-51, C-65).

import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/http/problem.ts";
import { DEFAULT_ANON_POLICY } from "../../src/web/figures.ts";
import {
  displayCount,
  parseStep,
  presentFunnel,
  presentGoals,
  presentJourneys,
} from "../../src/web/reports.ts";

const P = DEFAULT_ANON_POLICY; // min 10, round to 10

function refused(raw: unknown): string {
  try {
    parseStep(raw, "/step/0");
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("validation_failed");
    return (e as ApiError).message;
  }
  throw new Error(`accepted ${String(raw)}`);
}

describe("parseStep", () => {
  it("parses paths and normalises them like tracked paths", () => {
    expect(parseStep("path:/", "/s")).toEqual({ type: "path", value: "/" });
    expect(parseStep("path:/pricing/", "/s")).toEqual({ type: "path", value: "/pricing" });
    expect(parseStep("path://docs///api//", "/s")).toEqual({ type: "path", value: "/docs/api" });
    expect(parseStep("path:/tx/{hash}", "/s")).toEqual({ type: "path", value: "/tx/{hash}" });
    expect(parseStep("path:/docs/*", "/s")).toEqual({ type: "path", value: "/docs/*" });
  });

  it("parses event names in the gateway's alphabet, with the * wildcard", () => {
    expect(parseStep("event:wallet_connected", "/s")).toEqual({
      type: "event",
      value: "wallet_connected",
    });
    expect(parseStep("event:signup.v2:done-1", "/s").value).toBe("signup.v2:done-1");
    expect(parseStep("event:wallet_*", "/s").value).toBe("wallet_*");
  });

  it("refuses query strings, fragments, spaces, control characters and relative paths", () => {
    expect(refused("path:/pricing?utm_source=x")).toMatch(/query string/);
    expect(refused("path:/pricing#top")).toMatch(/fragment/);
    expect(refused("path:/a b")).toMatch(/spaces/);
    expect(refused("path:/a\u0000")).toMatch(/control/);
    expect(refused("path:pricing")).toMatch(/starts with \//);
    expect(refused(`path:/${"a".repeat(500)}`)).toMatch(/at most 500/);
  });

  it("refuses a Stellar address as a path segment (tracked paths hold placeholders)", () => {
    const g = `G${"A".repeat(55)}`;
    expect(refused(`path:/account/${g}`)).toMatch(/\{account\}/);
    expect(refused(`path:/c/C${"B".repeat(55)}/x`)).toMatch(/placeholder/);
    // a lower-case or short segment is an ordinary path
    expect(parseStep(`path:/account/${g.toLowerCase()}`, "/s").type).toBe("path");
  });

  it("refuses bad event names and unknown kinds", () => {
    expect(refused("event:")).toMatch(/1–50/);
    expect(refused(`event:${"a".repeat(51)}`)).toMatch(/1–50/);
    expect(refused("event:/pricing")).toMatch(/event name/);
    expect(refused("event:sign up")).toMatch(/event name/);
    expect(refused("url:/x")).toMatch(/expected/);
    expect(refused("/pricing")).toMatch(/expected/);
    expect(refused(42)).toMatch(/expected/);
  });
});

describe("displayCount (C-51)", () => {
  it("is exact without anonymous reports; floored and rounded with them", () => {
    expect(displayCount(3, false, P)).toBe(3);
    expect(displayCount(9, true, P)).toBeNull();
    expect(displayCount(10, true, P)).toBe(10);
    expect(displayCount(14, true, P)).toBe(10);
    expect(displayCount(15, true, P)).toBe(20);
  });
});

describe("presentFunnel", () => {
  const rows = [
    { type: "path" as const, value: "/", visitors: 200 },
    { type: "path" as const, value: "/pricing", visitors: 54 },
    { type: "event" as const, value: "signup", visitors: 4 },
  ];
  it("computes conversions from the first and the previous step", () => {
    expect(presentFunnel(rows, false, P)).toEqual([
      {
        type: "path",
        value: "/",
        visitors: 200,
        conversion_pct: 100,
        step_conversion_pct: null,
        suppressed: false,
      },
      {
        type: "path",
        value: "/pricing",
        visitors: 54,
        conversion_pct: 27,
        step_conversion_pct: 27,
        suppressed: false,
      },
      {
        type: "event",
        value: "signup",
        visitors: 4,
        conversion_pct: 2,
        step_conversion_pct: 7.4,
        suppressed: false,
      },
    ]);
  });
  it("with anonymous reports, suppresses small steps and derives shares from the shown counts only", () => {
    const v = presentFunnel(rows, true, P);
    expect(v.map((s) => s.visitors)).toEqual([200, 50, null]);
    expect(v.map((s) => s.conversion_pct)).toEqual([100, 25, null]);
    expect(v.map((s) => s.step_conversion_pct)).toEqual([null, 25, null]);
    expect(v.map((s) => s.suppressed)).toEqual([false, false, true]);
  });
  it("has no shares without first-step visitors", () => {
    const v = presentFunnel(
      [
        { type: "path", value: "/", visitors: 0 },
        { type: "path", value: "/a", visitors: 0 },
      ],
      false,
      P,
    );
    expect(v.map((s) => [s.conversion_pct, s.step_conversion_pct])).toEqual([
      [null, null],
      [null, null],
    ]);
  });
});

describe("presentGoals", () => {
  const goals = [
    { type: "path" as const, value: "/pricing" },
    { type: "event" as const, value: "signup" },
  ];
  it("shares of all visitors in the range", () => {
    expect(
      presentGoals(
        goals,
        [
          { visitors: 30, total: 120 },
          { visitors: 3, total: 120 },
        ],
        false,
        P,
      ),
    ).toEqual({
      total_visitors: 120,
      goals: [
        { type: "path", value: "/pricing", visitors: 30, conversion_pct: 25, suppressed: false },
        { type: "event", value: "signup", visitors: 3, conversion_pct: 2.5, suppressed: false },
      ],
    });
  });
  it("with anonymous reports, small goals and a small total are suppressed", () => {
    const v = presentGoals(
      goals,
      [
        { visitors: 30, total: 124 },
        { visitors: 3, total: 124 },
      ],
      true,
      P,
    );
    expect(v.total_visitors).toBe(120);
    expect(v.goals.map((g) => [g.visitors, g.conversion_pct, g.suppressed])).toEqual([
      [30, 25, false],
      [null, null, true],
    ]);
    const small = presentGoals(goals.slice(0, 1), [{ visitors: 5, total: 8 }], true, P);
    expect(small).toEqual({
      total_visitors: null,
      goals: [
        { type: "path", value: "/pricing", visitors: null, conversion_pct: null, suppressed: true },
      ],
    });
  });
});

describe("presentJourneys (always floored)", () => {
  const rows = [
    { items: ["/", "/pricing", "signup"], count: 42 },
    { items: ["/", "/docs"], count: 10 },
    { items: ["/blog/{slug}"], count: 9 },
    { items: ["/", "wallet_connected"], count: 1 },
    { items: [], count: 3 },
  ];
  it("leaves out sequences below the minimum count even without anonymous reports; types items", () => {
    expect(presentJourneys(rows, false, P)).toEqual({
      journeys: [
        {
          items: [
            { type: "path", value: "/" },
            { type: "path", value: "/pricing" },
            { type: "event", value: "signup" },
          ],
          visits: 42,
        },
        {
          items: [
            { type: "path", value: "/" },
            { type: "path", value: "/docs" },
          ],
          visits: 10,
        },
      ],
      other_visits: 10,
      suppressed_journeys: 2,
    });
  });
  it("rounds the counts with anonymous reports", () => {
    const v = presentJourneys(rows, true, P);
    expect(v.journeys.map((j) => j.visits)).toEqual([40, 10]);
    expect(v.other_visits).toBe(10);
  });
  it("follows the tenant's minimum count", () => {
    const v = presentJourneys(rows, false, { minCount: 1, roundTo: 1 });
    expect(v.journeys).toHaveLength(4);
    expect(v.suppressed_journeys).toBe(0);
  });
});
