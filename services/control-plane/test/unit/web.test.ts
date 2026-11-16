// SPDX-License-Identifier: Apache-2.0
// The web read-path rules as pure functions: range presets, the live/rollup split and its whole-day rule (§j.6,
// C-109, C-110(6)), comparison ranges (C-112(5)), units and buckets, the C-73 figures, and the C-51 anonymous-reports
// presentation (rounding to 10, merging rows below 10 into "Other").

import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/http/problem.ts";
import {
  addTotals,
  presentBreakdown,
  type Totals,
  totalsView,
  visitMetrics,
  ZERO,
} from "../../src/web/figures.ts";
import { bucketTime } from "../../src/web/live.ts";
import {
  buckets,
  DAY,
  defaultUnit,
  HOUR,
  planRange,
  previousSpan,
  resolveRange,
} from "../../src/web/range.ts";

const NOW = Date.parse("2026-11-12T15:30:00Z");
const TODAY = Date.parse("2026-11-12T00:00:00Z");
const CREATED = Date.parse("2026-09-03T08:00:00Z");

function apiErr(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected an ApiError");
}

describe("range presets (C-86)", () => {
  it("resolves every preset to [start, end)", () => {
    expect(resolveRange({ range: "24h" }, NOW, CREATED)).toEqual({ start: NOW - DAY, end: NOW });
    expect(resolveRange({ range: "7d" }, NOW, CREATED)).toEqual({
      start: TODAY - 6 * DAY,
      end: TODAY + DAY,
    });
    expect(resolveRange({}, NOW, CREATED)).toEqual({ start: TODAY - 29 * DAY, end: TODAY + DAY });
    expect(resolveRange({ range: "90d" }, NOW, CREATED).start).toBe(TODAY - 89 * DAY);
    expect(resolveRange({ range: "12m" }, NOW, CREATED)).toEqual({
      start: Date.parse("2025-11-13T00:00:00Z"),
      end: TODAY + DAY,
    });
    expect(resolveRange({ range: "all" }, NOW, CREATED)).toEqual({
      start: Date.parse("2026-09-03T00:00:00Z"),
      end: TODAY + DAY,
    });
  });

  it("custom needs start and end, end after start, at most 10 years; bounds only with custom", () => {
    expect(
      resolveRange(
        { range: "custom", start: "2026-11-01T00:00:00Z", end: "2026-11-03T00:00:00Z" },
        NOW,
        CREATED,
      ),
    ).toEqual({
      start: Date.parse("2026-11-01T00:00:00Z"),
      end: Date.parse("2026-11-03T00:00:00Z"),
    });
    expect(apiErr(() => resolveRange({ range: "custom" }, NOW, CREATED)).code).toBe(
      "validation_failed",
    );
    expect(
      apiErr(() =>
        resolveRange(
          { range: "custom", start: "2026-11-03T00:00:00Z", end: "2026-11-03T00:00:00Z" },
          NOW,
          CREATED,
        ),
      ).errors?.[0]?.pointer,
    ).toBe("/end");
    expect(
      apiErr(() =>
        resolveRange(
          { range: "custom", start: "2000-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z" },
          NOW,
          CREATED,
        ),
      ).code,
    ).toBe("validation_failed");
    expect(
      apiErr(() => resolveRange({ range: "7d", start: "2026-11-01T00:00:00Z" }, NOW, CREATED))
        .errors?.[0]?.pointer,
    ).toBe("/range");
  });
});

describe("live/rollup split (§j.6, C-109, C-110(6))", () => {
  it("a range that starts within the last 24 hours is live in full", () => {
    const span = resolveRange({ range: "24h" }, NOW, CREATED);
    const p = planRange(span, 1, NOW);
    expect(p.live).toEqual(span);
    expect(p.rollup).toBeNull();
  });

  it("splits at b = today 00:00 − (L − 1) days; the rollup part is whole days", () => {
    const span = resolveRange({ range: "30d" }, NOW, CREATED);
    const p = planRange(span, 7, NOW);
    expect(p.liveBoundary).toBe(TODAY - 6 * DAY);
    expect(p.live).toEqual({ start: TODAY - 6 * DAY, end: TODAY + DAY });
    expect(p.rollup).toEqual({ start: TODAY - 29 * DAY, end: TODAY - 6 * DAY });
    // a live window covering the whole range → live only
    const all = planRange(span, 90, NOW);
    expect(all.rollup).toBeNull();
    expect(all.live).toEqual(span);
  });

  it("a range entirely before the live window is rollup only", () => {
    const span = { start: TODAY - 20 * DAY, end: TODAY - 10 * DAY };
    const p = planRange(span, 3, NOW);
    expect(p.live).toBeNull();
    expect(p.rollup).toEqual(span);
  });

  it("refuses a rollup part that is not whole UTC days (400 naming the boundary), except for hourly series", () => {
    const span = { start: TODAY - 10 * DAY + 5 * HOUR, end: TODAY + DAY };
    const e = apiErr(() => planRange(span, 2, NOW));
    expect(e.code).toBe("validation_failed");
    expect(e.errors?.[0]?.pointer).toBe("/start");
    expect(e.detail).toContain("2026-11-11T00:00:00Z");
    const endOff = { start: TODAY - 10 * DAY, end: TODAY - 5 * DAY + HOUR };
    expect(apiErr(() => planRange(endOff, 1, NOW)).errors?.[0]?.pointer).toBe("/end");
    // the end may lie in the live part at any time
    expect(planRange({ start: TODAY - 10 * DAY, end: NOW }, 2, NOW).live).toEqual({
      start: TODAY - DAY,
      end: NOW,
    });
    expect(() => planRange(span, 2, NOW, false)).not.toThrow();
  });

  it("the previous range has equal length and may be uncomposable (C-112(5))", () => {
    const span = resolveRange({ range: "7d" }, NOW, CREATED);
    expect(previousSpan(span)).toEqual({ start: span.start - 7 * DAY, end: span.start });
    const prev24 = previousSpan(resolveRange({ range: "24h" }, NOW, CREATED));
    expect(prev24).toEqual({ start: NOW - 2 * DAY, end: NOW - DAY });
    expect(() => planRange(prev24, 1, NOW)).toThrow(ApiError);
  });
});

describe("units and buckets", () => {
  it("defaults: hour ≤ 2 days, day ≤ 92 days, else month", () => {
    expect(defaultUnit({ start: 0, end: 2 * DAY })).toBe("hour");
    expect(defaultUnit({ start: 0, end: 92 * DAY })).toBe("day");
    expect(defaultUnit({ start: 0, end: 93 * DAY })).toBe("month");
  });
  it("month buckets start on the first of the month", () => {
    const b = buckets(
      { start: Date.parse("2025-11-13T00:00:00Z"), end: Date.parse("2026-02-01T00:00:00Z") },
      "month",
    );
    expect(b.map((t) => new Date(t).toISOString().slice(0, 10))).toEqual([
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
    ]);
    expect(buckets({ start: TODAY + 30 * 60_000, end: TODAY + 3 * HOUR }, "hour")).toEqual([
      TODAY,
      TODAY + HOUR,
      TODAY + 2 * HOUR,
    ]);
  });
  it("parses the engine's bucket times", () => {
    expect(bucketTime("2026-11-12T12:00:00Z")).toBe(TODAY + 12 * HOUR);
    expect(bucketTime("2026-11-12 12:00:00")).toBe(TODAY + 12 * HOUR);
    expect(bucketTime("2026-11-12")).toBe(TODAY);
    expect(() => bucketTime("yesterday")).toThrow();
  });
});

describe("figures (C-73)", () => {
  const t: Totals = {
    pvVerified: 900,
    pvRaw: 1000,
    pvUnidVerified: 40,
    pvUnidRaw: 50,
    visitorsVerified: 300,
    visitorsRaw: 320,
    visits: 400,
    bounces: 166,
    durationS: 37_250,
  };
  it("computes the visit metrics once, with the suspect share", () => {
    expect(visitMetrics(t)).toEqual({
      visits: 400,
      bounces: 166,
      bounce_rate_pct: 41.5,
      avg_visit_duration_s: 93.1,
      suspect_pageview_share: 0.1,
    });
    expect(visitMetrics(ZERO)).toEqual({
      visits: 0,
      bounces: 0,
      bounce_rate_pct: null,
      avg_visit_duration_s: null,
      suspect_pageview_share: null,
    });
  });
  it("adds disjoint parts (multi-day visitors are the sum of daily uniques, C-110)", () => {
    expect(addTotals(t, t).visitorsVerified).toBe(600);
    expect(totalsView(t, "verified")).toEqual({
      verified: { pageviews: 900, pageviews_unidentified: 40, visitors: 300 },
    });
    expect(Object.keys(totalsView(t, "both"))).toEqual(["verified", "raw"]);
  });
});

describe("anonymous reports (C-51)", () => {
  const rows = new Map([
    ["DE", { visitors: 4104, pageviews: 8196, events: null }],
    ["FR", { visitors: 15, pageviews: 26, events: null }],
    ["US", { visitors: 9, pageviews: 30, events: null }],
    ["Other", { visitors: 4, pageviews: 4, events: null }], // a literal value "Other" is not the merged row
    ["XX", { visitors: 1, pageviews: 1, events: null }],
  ]);
  it("merges rows below 10 into one is_other row and rounds every count to 10", () => {
    const out = presentBreakdown(rows, { limit: 20, anonymous: true, byEvents: false });
    expect(out).toEqual([
      {
        value: "DE",
        is_other: false,
        visitors: 4100,
        pageviews: 8200,
        events: null,
        share_pct: 99.3,
      },
      { value: "FR", is_other: false, visitors: 20, pageviews: 30, events: null, share_pct: 0.5 },
      { value: "Other", is_other: true, visitors: 10, pageviews: 40, events: null, share_pct: 0.2 },
    ]);
  });
  it("without anonymous reports shows exact rows; beyond the limit rows go to Other", () => {
    const out = presentBreakdown(rows, { limit: 2, anonymous: false, byEvents: false });
    expect(out.map((r) => [r.value, r.is_other, r.visitors, r.pageviews])).toEqual([
      ["DE", false, 4104, 8196],
      ["FR", false, 15, 26],
      ["Other", true, 14, 35],
    ]);
    const exact = presentBreakdown(rows, { limit: 20, anonymous: false, byEvents: false });
    expect(exact.find((r) => r.value === "Other")?.is_other).toBe(false);
    expect(exact).toHaveLength(5);
  });
  it("ranks event rows by events", () => {
    const ev = new Map([
      ["signup", { visitors: null, pageviews: null, events: 12 }],
      ["wallet_connect", { visitors: null, pageviews: null, events: 35 }],
      ["rare", { visitors: null, pageviews: null, events: 3 }],
    ]);
    expect(
      presentBreakdown(ev, { limit: 20, anonymous: true, byEvents: true }).map((r) => [
        r.value,
        r.events,
      ]),
    ).toEqual([
      ["wallet_connect", 40],
      ["signup", 10],
      ["Other", 0],
    ]);
  });
});
