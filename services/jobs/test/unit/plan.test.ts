// SPDX-License-Identifier: Apache-2.0
// The rollup plan (data-model §6.3, §8.9; C-110(6), C-112): which days a run covers and when a day becomes final;
// the top-N rule of web_daily_breakdowns; the schedules.

import { describe, expect, it } from "vitest";
import {
  type BreakdownCounts,
  catchUpTasks,
  mergeTasks,
  scheduledTasks,
  topN,
} from "../../src/rollup/compute.ts";
import { addDays, nextRun, utcDay } from "../../src/schedule.ts";

const t = (iso: string) => new Date(iso);

describe("scheduledTasks", () => {
  it("hourly before 02:00 UTC: today and the previous day, neither final", () => {
    expect(scheduledTasks(t("2026-11-12T01:05:00Z"), "hourly")).toEqual([
      { day: "2026-11-12", final: false },
      { day: "2026-11-11", final: false },
    ]);
    expect(scheduledTasks(t("2026-11-12T01:59:59Z"), "start")).toHaveLength(2);
  });
  it("hourly from 02:00 UTC: today only", () => {
    expect(scheduledTasks(t("2026-11-12T02:00:00Z"), "hourly")).toEqual([
      { day: "2026-11-12", final: false },
    ]);
  });
  it("daily (01:30): D-1…D-3 refreshed, D-4 final (late spool ≤ 72 h after receipt)", () => {
    expect(scheduledTasks(t("2026-11-12T01:30:00Z"), "daily")).toEqual([
      { day: "2026-11-11", final: false },
      { day: "2026-11-10", final: false },
      { day: "2026-11-09", final: false },
      { day: "2026-11-08", final: true },
    ]);
  });
  it("never finalises a day the spool can still deliver to (receipt + 72 h)", () => {
    for (const iso of ["2026-11-12T00:00:00Z", "2026-11-12T01:30:00Z", "2026-11-12T23:59:59Z"]) {
      const now = t(iso);
      const finals = [
        ...scheduledTasks(now, "daily"),
        ...scheduledTasks(now, "hourly"),
        ...catchUpTasks(now, "2020-01-01", new Map()),
      ].filter((x) => x.final);
      for (const f of finals) {
        // the last event of day f.day may reach Umami until f.day + 1 day + 72 h
        const lastDelivery = new Date(`${addDays(f.day, 1)}T00:00:00Z`).getTime() + 72 * 3_600_000;
        expect(lastDelivery, `${iso} ${f.day}`).toBeLessThanOrEqual(now.getTime());
      }
    }
  });
  it("crosses month and year boundaries", () => {
    expect(scheduledTasks(t("2027-01-01T00:10:00Z"), "hourly").map((x) => x.day)).toEqual([
      "2027-01-01",
      "2026-12-31",
    ]);
    expect(scheduledTasks(t("2028-03-01T01:30:00Z"), "daily").map((x) => x.day)).toEqual([
      "2028-02-29",
      "2028-02-28",
      "2028-02-27",
      "2028-02-26",
    ]);
  });
});

describe("catchUpTasks", () => {
  const now = t("2026-11-12T10:00:00Z");
  it("rolls missing days of the last week, final from D-4 on", () => {
    const got = catchUpTasks(now, "2020-01-01", new Map());
    expect(got).toEqual([
      { day: "2026-11-05", final: true },
      { day: "2026-11-06", final: true },
      { day: "2026-11-07", final: true },
      { day: "2026-11-08", final: true },
      { day: "2026-11-09", final: false },
      { day: "2026-11-10", final: false },
      { day: "2026-11-11", final: false },
    ]);
  });
  it("re-rolls non-final days ≥ 4 days old as final; leaves rolled recent and final days alone", () => {
    const existing = new Map<string, boolean>([
      ["2026-11-05", true],
      ["2026-11-06", true],
      ["2026-11-07", true],
      ["2026-11-08", false],
      ["2026-11-09", false],
      ["2026-11-10", false],
      ["2026-11-11", false],
    ]);
    expect(catchUpTasks(now, "2020-01-01", existing)).toEqual([{ day: "2026-11-08", final: true }]);
  });
  it("never before the site existed", () => {
    expect(catchUpTasks(now, "2026-11-10", new Map()).map((x) => x.day)).toEqual([
      "2026-11-10",
      "2026-11-11",
    ]);
  });
});

describe("mergeTasks", () => {
  it("final wins per day; oldest first", () => {
    expect(
      mergeTasks(
        [
          { day: "2026-11-09", final: false },
          { day: "2026-11-12", final: false },
        ],
        [{ day: "2026-11-09", final: true }],
      ),
    ).toEqual([
      { day: "2026-11-09", final: true },
      { day: "2026-11-12", final: false },
    ]);
  });
});

describe("topN", () => {
  const c = (dimension: BreakdownCounts["dimension"], value: string, o: Partial<BreakdownCounts>) =>
    ({
      dimension,
      value,
      pageviews_raw: 0,
      pageviews_verified: 0,
      visitors_raw: 0,
      visitors_verified: 0,
      visits_raw: 0,
      events_raw: 0,
      events_verified: 0,
      event_visitors_raw: 0,
      event_visitors_verified: 0,
      ...o,
    }) as BreakdownCounts;

  it("ranks by visitors then value, cuts at N, verified rows have no visits, values without page views make no row", () => {
    const rows = topN(
      [
        c("path", "/b", {
          pageviews_raw: 5,
          pageviews_verified: 2,
          visitors_raw: 3,
          visitors_verified: 1,
          visits_raw: 3,
        }),
        c("path", "/a", {
          pageviews_raw: 4,
          pageviews_verified: 4,
          visitors_raw: 3,
          visitors_verified: 3,
          visits_raw: 4,
        }),
        c("path", "/c", { pageviews_raw: 9, visitors_raw: 1, visits_raw: 1 }),
        c("path", "/twin-only", { pageviews_raw: 1, pageviews_verified: 1 }),
      ],
      2,
    );
    expect(rows).toEqual([
      {
        variant: "verified",
        dimension: "path",
        value: "/a",
        rank: 1,
        visitors: 3,
        pageviews: 4,
        visits: null,
        events: null,
      },
      {
        variant: "verified",
        dimension: "path",
        value: "/b",
        rank: 2,
        visitors: 1,
        pageviews: 2,
        visits: null,
        events: null,
      },
      {
        variant: "raw",
        dimension: "path",
        value: "/a",
        rank: 1,
        visitors: 3,
        pageviews: 4,
        visits: 4,
        events: null,
      },
      {
        variant: "raw",
        dimension: "path",
        value: "/b",
        rank: 2,
        visitors: 3,
        pageviews: 5,
        visits: 3,
        events: null,
      },
    ]);
  });

  it("event rows rank by events and carry no page views or visits", () => {
    const rows = topN(
      [
        c("event", "connect", { events_raw: 1, event_visitors_raw: 1 }),
        c("event", "wallet_selected", {
          events_raw: 3,
          events_verified: 2,
          event_visitors_raw: 2,
          event_visitors_verified: 1,
        }),
      ],
      50,
    );
    expect(rows).toEqual([
      {
        variant: "verified",
        dimension: "event",
        value: "wallet_selected",
        rank: 1,
        visitors: 1,
        pageviews: null,
        visits: null,
        events: 2,
      },
      {
        variant: "raw",
        dimension: "event",
        value: "wallet_selected",
        rank: 1,
        visitors: 2,
        pageviews: null,
        visits: null,
        events: 3,
      },
      {
        variant: "raw",
        dimension: "event",
        value: "connect",
        rank: 2,
        visitors: 1,
        pageviews: null,
        visits: null,
        events: 1,
      },
    ]);
  });
});

describe("schedules (UTC)", () => {
  it("hourly at minute m", () => {
    expect(nextRun({ kind: "hourly", minute: 5 }, t("2026-11-12T10:04:59Z")).toISOString()).toBe(
      "2026-11-12T10:05:00.000Z",
    );
    expect(nextRun({ kind: "hourly", minute: 5 }, t("2026-11-12T10:05:00Z")).toISOString()).toBe(
      "2026-11-12T11:05:00.000Z",
    );
    expect(nextRun({ kind: "hourly", minute: 5 }, t("2026-12-31T23:30:00Z")).toISOString()).toBe(
      "2027-01-01T00:05:00.000Z",
    );
  });
  it("daily at HH:MM", () => {
    expect(
      nextRun({ kind: "daily", hour: 1, minute: 30 }, t("2026-11-12T01:29:00Z")).toISOString(),
    ).toBe("2026-11-12T01:30:00.000Z");
    expect(
      nextRun({ kind: "daily", hour: 1, minute: 30 }, t("2026-11-12T01:30:00Z")).toISOString(),
    ).toBe("2026-11-13T01:30:00.000Z");
  });
  it("day arithmetic", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(utcDay(t("2026-11-12T23:59:59.999Z"))).toBe("2026-11-12");
  });
});
