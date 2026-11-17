// SPDX-License-Identifier: Apache-2.0
// Display rules of API and operator figures: percentiles with their accuracy class, the "≤ 5 ms" first bucket,
// error rates, status shares, every data-quality reason in plain language, range totals and usage flags.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCURACY_TEXT,
  accuracyLabel,
  DQ_REASON_TEXT,
  fmtMs,
  fmtRate,
  isRoutePlaceholder,
  ROUTE_PLACEHOLDER_TEXT,
  statusShares,
} from "../../src/lib/apiFormat.ts";
import { daysOf, presetSpan, previousSpan } from "../../src/lib/days.ts";
import { sumApiDays, sumWebDays, trustBand, usageFlag } from "../../src/lib/opAgg.ts";
import { EXPECTED_API, HORIZON_SUMMARY } from "../fixtures/api.ts";
import { EXPECTED_OP, OP_PROJECTS, OP_SERVICES } from "../fixtures/operator.ts";

describe("fmtMs", () => {
  it("formats by magnitude", () => {
    expect(fmtMs(0.8)).toBe("0.8 ms");
    expect(fmtMs(3.1)).toBe("3.1 ms");
    expect(fmtMs(42.7)).toBe(EXPECTED_API.p50);
    expect(fmtMs(1210)).toBe(EXPECTED_API.transactionsP99);
    expect(fmtMs(null)).toBe("—");
  });
  it("shows the first explicit bucket as ≤ 5 ms (C-103, C-110(9)) but not for exponential histograms", () => {
    expect(fmtMs(5, "explicit15")).toBe("≤ 5 ms");
    expect(fmtMs(4, "explicit15_approx")).toBe("≤ 5 ms");
    expect(fmtMs(5, "exp3")).toBe("5.0 ms");
    expect(fmtMs(25, "explicit15")).toBe("25 ms");
  });
  it("names every accuracy class", () => {
    for (const a of ["exp3", "explicit15", "explicit15_approx", "coarse"] as const) {
      expect(accuracyLabel(a)).not.toBe("");
      expect(ACCURACY_TEXT[a].length).toBeGreaterThan(20);
    }
    expect(accuracyLabel("exp3")).toBe("± 4.3 %");
    expect(accuracyLabel(null)).toBe("no data");
  });
});

describe("rates and shares", () => {
  it("error rates and status shares of the fixture", () => {
    expect(fmtRate(HORIZON_SUMMARY.error_rate_5xx)).toBe(EXPECTED_API.errorRate5xx);
    expect(fmtRate(HORIZON_SUMMARY.error_rate_4xx)).toBe(EXPECTED_API.errorRate4xx);
    const s = statusShares(HORIZON_SUMMARY.status);
    expect(fmtRate(s.find((x) => x.key === "s2xx")?.share)).toBe(EXPECTED_API.share2xx);
    expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 10);
    expect(
      statusShares({ s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, unknown: 0 }).every((x) => x.share === 0),
    ).toBe(true);
  });
});

describe("placeholders and data-quality reasons", () => {
  it("explains {unknown} and {overflow} only", () => {
    expect(isRoutePlaceholder("{unknown}")).toBe(true);
    expect(isRoutePlaceholder("{overflow}")).toBe(true);
    expect(isRoutePlaceholder("/accounts/{account_id}")).toBe(false);
    expect(ROUTE_PLACEHOLDER_TEXT["{overflow}"]).toContain("route limit");
  });
  it("has plain language for every reason of wire-formats §h.3", () => {
    const doc = readFileSync(join(__dirname, "../../../../docs/contracts/wire-formats.md"), "utf8");
    const raw = doc.slice(doc.indexOf("### h.3"), doc.indexOf("### h.4"));
    // Parenthesised text explains a reason (e.g. "under unit `s`"); it never lists one.
    let section = "";
    let depth = 0;
    for (const ch of raw) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0) section += ch;
    }
    const codes = [...section.matchAll(/`([a-z0-9_]+)`/g)]
      .map((m) => m[1] as string)
      .filter((c) => c !== "api_ingest_counters");
    const reasons = codes.filter((c) => !["scf", "reason"].includes(c) && !c.includes("."));
    expect(reasons.length).toBeGreaterThan(20);
    for (const r of reasons) expect(DQ_REASON_TEXT[r], r).toBeTruthy();
  });
});

describe("day spans", () => {
  it("presets end with today and are whole UTC days", () => {
    const s = presetSpan("7d", new Date("2026-11-12T10:00:00Z"));
    expect(s).toEqual({ start: "2026-11-06T00:00:00Z", end: "2026-11-13T00:00:00Z", days: 7 });
    expect(daysOf(s)).toHaveLength(7);
    expect(previousSpan(s)).toEqual({ start: "2026-10-30T00:00:00Z", end: "2026-11-06T00:00:00Z" });
  });
});

describe("operator totals", () => {
  const ranked = OP_PROJECTS.filter((p) => p.verification_level !== "L0");
  it("web: counts add, rates are recomputed, averages weighted", () => {
    const t = sumWebDays(ranked.map((p, i) => ({ day: `2026-11-0${i + 1}`, ...p.verified })));
    expect(t.pageviews.toLocaleString("en-US")).toBe(EXPECTED_OP.ecoPageviews);
    expect(t.visitors_sum.toLocaleString("en-US")).toBe(EXPECTED_OP.ecoVisitors);
    expect(t.visits.toLocaleString("en-US")).toBe(EXPECTED_OP.ecoVisits);
    expect(t.bounce_rate_pct?.toFixed(1)).toBe("45.6");
    expect(t.avg_visit_duration_s).toBeCloseTo(4118300 / 50300, 9);
    expect(t.suspect_pageview_share).toBeCloseTo(8665 / 97450, 9);
  });
  it("API: requests and 5xx rate", () => {
    const rankedIds = new Set(ranked.map((p) => p.tenant_id));
    const t = sumApiDays(
      OP_SERVICES.filter((s) => rankedIds.has(s.tenant_id)).map((s, i) => ({
        day: `d${i}`,
        ...s.cells,
      })),
    );
    expect(t.requests.toLocaleString("en-US")).toBe(EXPECTED_OP.ecoRequests);
    expect(fmtRate(t.error_rate_5xx)).toBe(EXPECTED_OP.ecoErrorRate);
  });
  it("trust bands and usage flags", () => {
    expect([trustBand(84), trustBand(58), trustBand(31), trustBand(null)]).toEqual([
      "high",
      "medium",
      "low",
      "unscored",
    ]);
    expect(usageFlag({ requests: 0 }, 10, 30)).toBe("inactive");
    expect(usageFlag({ requests: 10, active_days: 30 }, 10, 30)).toBe("highest");
    expect(usageFlag({ requests: 5, active_days: 2 }, 10, 30)).toBe("low");
    expect(usageFlag({ requests: 5, active_days: 20 }, 10, 30)).toBeNull();
  });
});
