// SPDX-License-Identifier: Apache-2.0
// The fixtures the browser tests rely on are valid control-plane answers.
import { describe, expect, it } from "vitest";
import { assertValidResponse } from "../../e2e/support/openapi.ts";
import {
  DOCS_BREAKDOWN,
  DOCS_PREVIOUS,
  DOCS_STATS,
  PRESET_RANGES,
  PRESET_SOURCE,
  rangeEcho,
  series,
  WALLET_BREAKDOWN,
  WALLET_STATS,
} from "../fixtures/web.ts";

const ranges = Object.entries(PRESET_RANGES).map(([k, r]) => {
  const { source, ...extra } = PRESET_SOURCE[k] ?? { source: "live" as const };
  return rangeEcho(r.start, r.end, source, true, extra);
});

describe("fixtures match the OpenAPI document", () => {
  it("stats, with and without a comparison", () => {
    for (const range of ranges) {
      for (const s of [DOCS_STATS, WALLET_STATS]) {
        assertValidResponse("getWebStats", 200, { range, ...s });
        assertValidResponse("getWebStats", 200, {
          range,
          ...s,
          previous: DOCS_PREVIOUS,
          comparison_unavailable: false,
        });
        assertValidResponse("getWebStats", 200, {
          range,
          ...s,
          previous: null,
          comparison_unavailable: true,
        });
      }
    }
  });
  it("breakdowns of every dimension", () => {
    for (const table of [DOCS_BREAKDOWN, WALLET_BREAKDOWN]) {
      for (const [dimension, rows] of Object.entries(table)) {
        assertValidResponse("getWebBreakdown", 200, {
          range: ranges[0],
          dimension,
          ...rows,
          truncated: false,
        });
      }
    }
  });
  it("time series at every unit; hour without visit metrics", () => {
    for (const range of ranges) {
      for (const unit of ["hour", "day", "month"] as const) {
        if (unit === "hour" && Date.parse(range.end) - Date.parse(range.start) > 7 * 86_400_000)
          continue;
        const ts = series(range, unit, ["pageviews", "visitors", "visits"]);
        assertValidResponse("getWebTimeseries", 200, ts);
        expect(ts.visit_metrics === undefined).toBe(unit === "hour");
      }
    }
  });
  it("anonymised rows are multiples of 10 with exactly one merged row where present", () => {
    for (const rows of Object.values(DOCS_BREAKDOWN)) {
      for (const r of [...rows.verified, ...rows.raw]) {
        for (const v of [r.visitors, r.pageviews, r.events]) if (v != null) expect(v % 10).toBe(0);
      }
      expect(rows.verified.filter((r) => r.is_other).length).toBeLessThanOrEqual(1);
    }
  });
  it("an invalid fixture is caught", () => {
    expect(() => assertValidResponse("getWebStats", 200, { range: ranges[0] })).toThrow(/OpenAPI/);
  });
});
