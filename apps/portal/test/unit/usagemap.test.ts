// SPDX-License-Identifier: Apache-2.0
// Ecosystem Usage Map page model: search parsing (unknown values dropped, optional keys absent), sorting (withheld
// figures last, ties by name), the week-over-week WAA change, round options and the column-header sort cycle.

import { describe, expect, it } from "vitest";
import { FAKE_USAGE } from "../../e2e/support/mock-usagemap.ts";
import {
  nextSort,
  parseUsageMapSearch,
  roundsOf,
  shortContract,
  sortUsage,
  waaChange,
  withSearch,
} from "../../src/pages/operator/usagemap/model.ts";
import { fmtChange } from "../../src/pages/operator/usagemap/UsageMap.tsx";

describe("usage map search", () => {
  it("keeps known values only and leaves unset keys out", () => {
    expect(parseUsageMapSearch({})).toEqual({
      range: "30d",
      sort: "invocations",
      dir: "desc",
      awarded: false,
      active: false,
    });
    expect(
      parseUsageMapSearch({
        range: "90d",
        round: "35",
        category: "financial_protocols",
        status: "unclaimed",
        q: "  dex ",
        sort: "waa",
        dir: "asc",
        awarded: "true",
        network: "testnet",
      }),
    ).toEqual({
      range: "90d",
      round: 35,
      category: "financial_protocols",
      status: "unclaimed",
      q: "dex",
      sort: "waa",
      dir: "asc",
      awarded: true,
      active: false,
      network: "testnet",
    });
    const bad = parseUsageMapSearch({
      range: "1y",
      round: "0",
      category: "x",
      status: "owned",
      sort: "evil",
    });
    expect(bad).toEqual(parseUsageMapSearch({}));
    expect(
      withSearch(parseUsageMapSearch({ round: 35, q: "x" }), { round: undefined }),
    ).not.toHaveProperty("round");
  });
});

describe("usage map sorting", () => {
  it("sorts by any figure, withheld values last, ties by name", () => {
    const byWaa = sortUsage(FAKE_USAGE, "waa", "desc").map((i) => i.name);
    expect(byWaa).toEqual(["Fakeswap DEX (FAKE)", "Fakelend (FAKE)", "Fakewallet Kit (FAKE)"]);
    const asc = sortUsage(FAKE_USAGE, "waa", "asc").map((i) => i.name);
    expect(asc.at(-1)).toBe("Fakewallet Kit (FAKE)"); // null stays last in both directions
    expect(sortUsage(FAKE_USAGE, "name", "asc").map((i) => i.name)[0]).toBe("Fakelend (FAKE)");
    expect(sortUsage(FAKE_USAGE, "round", "desc")[2]?.award_round).toBe(33);
  });
  it("cycles the header sort: a new column starts descending, names ascending", () => {
    expect(nextSort({ sort: "invocations", dir: "desc" }, "invocations")).toEqual({
      sort: "invocations",
      dir: "asc",
    });
    expect(nextSort({ sort: "invocations", dir: "asc" }, "waa")).toEqual({
      sort: "waa",
      dir: "desc",
    });
    expect(nextSort({ sort: "waa", dir: "desc" }, "name")).toEqual({ sort: "name", dir: "asc" });
  });
  it("computes the WAA change and formats it", () => {
    const [dex, lend, kit] = FAKE_USAGE;
    expect(waaChange(dex as (typeof FAKE_USAGE)[number])).toBeCloseTo(0.2667, 3);
    expect(fmtChange(waaChange(lend as (typeof FAKE_USAGE)[number]))).toBe("-20.8%");
    expect(waaChange(kit as (typeof FAKE_USAGE)[number])).toBeNull();
    expect(fmtChange(null)).toBe("—");
    expect(roundsOf(FAKE_USAGE)).toEqual([35, 33]);
    expect(shortContract(`C${"F".repeat(54)}A`)).toBe("CFFFFF…FFFA");
  });
});
