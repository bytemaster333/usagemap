// SPDX-License-Identifier: Apache-2.0
// The C-51 minimum count is applied per UTC day (one person
// on 10 days of 30 cannot meet it, overlapping windows cannot be differenced below it), the thresholds come from the
// settings, and a tenant time series is bounded (no future start, end ≤ now + 1 day, ≤ 10,000 points).

import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/http/problem.ts";
import {
  anonPolicyOf,
  type BreakdownMap,
  floorPerDay,
  presentBreakdown,
} from "../../src/web/figures.ts";
import {
  anonymousSegments,
  DAY,
  HOUR,
  MAX_SERIES_POINTS,
  planRange,
  resolveRange,
  resolveWebRange,
  seriesPoints,
} from "../../src/web/range.ts";

const NOW = Date.parse("2026-11-18T15:30:00Z");
const TODAY = Date.parse("2026-11-18T00:00:00Z");
const CREATED = Date.parse("2025-01-03T08:00:00Z");

function apiErr(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected an ApiError");
}

const day = (rows: Record<string, number>): BreakdownMap =>
  new Map(Object.entries(rows).map(([k, v]) => [k, { visitors: v, pageviews: v, events: null }]));

describe("per-day minimum count", () => {
  it("one visitor from a rare country on 10 days of a 30-day window is suppressed", () => {
    const days: BreakdownMap[] = [];
    for (let i = 0; i < 30; i++) days.push(day(i < 10 ? { DE: 50, IS: 1 } : { DE: 50 }));
    const floored = floorPerDay(days, 10, false);
    expect(floored.rows.has("IS")).toBe(false);
    expect(floored.rows.get("DE")?.visitors).toBe(1500);
    // the suppressed visitor-days go to "Other" only (never under their own value)
    expect(floored.suppressed?.visitors).toBe(10);
    const out = presentBreakdown(floored.rows, {
      limit: 20,
      anonymous: true,
      byEvents: false,
      suppressed: floored.suppressed,
    });
    expect(out.map((r) => r.value)).toEqual(["DE", "Other"]);
    expect(out.find((r) => r.value === "IS")).toBeUndefined();
  });

  it("windows differing by one day cannot reveal a below-k day (differencing, #14)", () => {
    const base: BreakdownMap[] = Array.from({ length: 10 }, () => day({ BR: 12 }));
    const plusOne = [...base, day({ BR: 3 })];
    const a = floorPerDay(base, 10, false).rows.get("BR")?.visitors;
    const b = floorPerDay(plusOne, 10, false).rows.get("BR")?.visitors;
    expect(a).toBe(120);
    expect(b).toBe(120); // the day with 3 contributes nothing to the row
  });

  it("a row at or above k on a day counts that day; rounding uses the policy step", () => {
    const out = presentBreakdown(floorPerDay([day({ FR: 10 }), day({ FR: 14 })], 10, false).rows, {
      limit: 20,
      anonymous: true,
      byEvents: false,
      policy: { minCount: 10, roundTo: 5 },
    });
    expect(out[0]).toMatchObject({ value: "FR", visitors: 25 });
  });

  it("event rows are floored per day on their event count", () => {
    const ev = (n: number): BreakdownMap =>
      new Map([["rare", { visitors: null, pageviews: null, events: n }]]);
    const f = floorPerDay([ev(3), ev(3), ev(3), ev(3)], 10, true);
    expect(f.rows.size).toBe(0);
    expect(f.suppressed?.events).toBe(12);
  });
});

describe("tenant thresholds from the settings", () => {
  it("reads tenant_min_count / tenant_round_to; anything not a positive integer falls back to 10/10", () => {
    expect(anonPolicyOf({ tenant_min_count: 25, tenant_round_to: 5 })).toEqual({
      minCount: 25,
      roundTo: 5,
    });
    expect(anonPolicyOf({})).toEqual({ minCount: 10, roundTo: 10 });
    expect(anonPolicyOf({ tenant_min_count: 0, tenant_round_to: "x" })).toEqual({
      minCount: 10,
      roundTo: 10,
    });
    expect(anonPolicyOf({ tenant_min_count: 2.5, tenant_round_to: -1 })).toEqual({
      minCount: 10,
      roundTo: 10,
    });
  });

  it("presentBreakdown honours a raised minimum count", () => {
    const out = presentBreakdown(day({ DE: 40, FR: 20 }), {
      limit: 20,
      anonymous: true,
      byEvents: false,
      policy: { minCount: 30, roundTo: 10 },
    });
    expect(out.map((r) => [r.value, r.is_other])).toEqual([
      ["DE", false],
      ["Other", true],
    ]);
  });
});

describe("anonymous breakdown segments: whole past days from rollups, partial days live", () => {
  it("30d preset: 29 whole days from rollups, today live", () => {
    const span = resolveRange({ range: "30d" }, NOW, CREATED);
    const s = anonymousSegments(planRange(span, 7, NOW), NOW);
    expect(s.rollup).toEqual({ start: TODAY - 29 * DAY, end: TODAY });
    expect(s.live).toEqual([{ start: TODAY, end: TODAY + DAY }]);
  });
  it("24h preset: two partial days, each its own live read", () => {
    const span = resolveRange({ range: "24h" }, NOW, CREATED);
    const s = anonymousSegments(planRange(span, 7, NOW), NOW);
    expect(s.rollup).toBeNull();
    expect(s.live).toEqual([
      { start: NOW - DAY, end: TODAY },
      { start: TODAY, end: NOW },
    ]);
  });
  it("a custom range inside the live window starting mid-day: first day live, rest whole days", () => {
    const span = resolveRange(
      { range: "custom", start: "2026-11-15T12:00:00Z", end: "2026-11-18T00:00:00Z" },
      NOW,
      CREATED,
    );
    const s = anonymousSegments(planRange(span, 7, NOW), NOW);
    expect(s.live).toEqual([{ start: Date.parse("2026-11-15T12:00:00Z"), end: TODAY - 2 * DAY }]);
    expect(s.rollup).toEqual({ start: TODAY - 2 * DAY, end: TODAY });
  });
});

describe("bounded tenant time series", () => {
  it("rejects a start in the future", () => {
    const e = apiErr(() =>
      resolveWebRange(
        { range: "custom", start: "2026-11-19T00:00:00Z", end: "2026-11-20T00:00:00Z" },
        NOW,
        CREATED,
      ),
    );
    expect(e.code).toBe("validation_failed");
    expect(e.errors?.[0]?.pointer).toBe("/start");
  });

  it("rejects an end more than one day after now (the audit probe: today → today + 10 years)", () => {
    const e = apiErr(() =>
      resolveWebRange(
        { range: "custom", start: "2026-11-18T00:00:00Z", end: "2036-11-14T00:00:00Z" },
        NOW,
        CREATED,
      ),
    );
    expect(e.errors?.[0]?.pointer).toBe("/end");
    // the end of today is still accepted
    expect(
      resolveWebRange(
        { range: "custom", start: "2026-11-18T00:00:00Z", end: "2026-11-19T00:00:00Z" },
        NOW,
        CREATED,
      ).end,
    ).toBe(TODAY + DAY);
  });

  it("caps the number of points per series", () => {
    expect(MAX_SERIES_POINTS).toBe(10_000);
    const span = { start: NOW - 500 * DAY, end: NOW };
    const e = apiErr(() => seriesPoints(span, "hour"));
    expect(e.code).toBe("validation_failed");
    expect(e.errors?.[0]?.pointer).toBe("/unit");
    expect(seriesPoints(span, "day")).toBe(501);
    expect(seriesPoints({ start: TODAY, end: TODAY + 48 * HOUR }, "hour")).toBe(48);
  });
});
