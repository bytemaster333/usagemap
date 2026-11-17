// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  countryName,
  fmtDelta,
  fmtDuration,
  fmtInt,
  fmtPct,
  fmtRange,
  fmtShare,
} from "../../src/lib/format.ts";
import {
  allowedUnits,
  customRange,
  defaultUnit,
  parseDay,
  visitSeriesAvailable,
} from "../../src/lib/range.ts";
import { safeReturnTo } from "../../src/lib/returnTo.ts";
import { parseDashboardSearch } from "../../src/lib/search.ts";

describe("format", () => {
  it("formats the fixture figures exactly as the dashboard shows them", () => {
    expect(fmtInt(36900)).toBe("36,900");
    expect(fmtInt(null)).toBe("—");
    expect(fmtPct(41.4)).toBe("41.4%");
    expect(fmtShare(0.06)).toBe("6.0%");
    expect(fmtDuration(93)).toBe("1 min 33 s");
    expect(fmtDuration(45)).toBe("45 s");
    expect(fmtDuration(120)).toBe("2 min");
    expect(fmtDuration(3725)).toBe("1 h 02 min");
    expect(fmtDelta(36900, 32800)).toBe("+12.5%");
    expect(fmtDelta(93, 100)).toBe("−7.0%");
    expect(fmtDelta(5, 0)).toBeNull();
    expect(fmtDelta(0, 0)).toBe("0.0%");
  });
  it("shows half-open ranges as inclusive UTC days", () => {
    expect(fmtRange("2026-10-14T00:00:00Z", "2026-11-13T00:00:00Z")).toBe(
      "14 Oct 2026 – 12 Nov 2026",
    );
    expect(fmtRange("2026-11-12T00:00:00Z", "2026-11-13T00:00:00Z")).toBe("12 Nov 2026");
  });
  it("names countries; XX is unknown", () => {
    expect(countryName("DE")).toBe("Germany");
    expect(countryName("XX")).toBe("Unknown");
    expect(countryName("weird")).toBe("weird");
  });
});

describe("ranges (C-86, C-112)", () => {
  it("turns inclusive days into the half-open API pair", () => {
    expect(customRange("2026-10-01", "2026-10-07")).toEqual({
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-08T00:00:00Z",
      days: 7,
    });
  });
  it("rejects impossible, reversed and too long ranges", () => {
    expect(parseDay("2026-02-30")).toBeNull();
    expect(customRange("2026-10-07", "2026-10-01")).toHaveProperty("error");
    expect(customRange("2000-01-01", "2026-01-01")).toHaveProperty("error");
    expect(customRange(undefined, "2026-01-01")).toHaveProperty("error");
  });
  it("chooses units like the control plane and never asks visit metrics by hour", () => {
    expect(defaultUnit(1)).toBe("hour");
    expect(defaultUnit(30)).toBe("day");
    expect(defaultUnit(366)).toBe("month");
    expect(defaultUnit(null)).toBe("month");
    expect(allowedUnits(7)).toEqual(["hour", "day", "month"]);
    expect(allowedUnits(null)).toEqual(["month"]);
    expect(visitSeriesAvailable("hour")).toBe(false);
    expect(visitSeriesAvailable("day")).toBe(true);
  });
  it("parses dashboard search with safe defaults", () => {
    expect(parseDashboardSearch({})).toEqual({ range: "30d", variant: "verified", compare: false });
    expect(
      parseDashboardSearch({
        range: "custom",
        from: "2026-10-01",
        to: "x",
        variant: "raw",
        compare: "true",
        unit: "hour",
      }),
    ).toEqual({
      range: "custom",
      from: "2026-10-01",
      variant: "raw",
      compare: true,
      unit: "hour",
    });
    expect(parseDashboardSearch({ range: "5y" }).range).toBe("30d");
  });
});

describe("return_to (C-114)", () => {
  it.each([
    ["/tenants", "/tenants"],
    ["/t/x?range=7d", "/t/x?range=7d"],
    ["//evil.example", "/"],
    ["https://evil.example", "/"],
    ["/\\evil", "/"],
    ["/a\u0000b", "/"],
    ["/a\nb", "/"],
    ["/a\u0085b", "/"],
    ["/signin?return_to=/x", "/"],
    ["", "/"],
    [42, "/"],
  ])("%j → %j", (v, want) => {
    expect(safeReturnTo(v)).toBe(want);
  });
});
