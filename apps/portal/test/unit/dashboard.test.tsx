// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// Component tests of the dashboard pieces with the fixtures' known values.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client.ts";
import { LineChart, niceMax } from "../../src/components/LineChart.tsx";
import { ProblemAlert } from "../../src/components/ProblemAlert.tsx";
import {
  BreakdownTable,
  rangeQuery,
  SourceIndicator,
  StatTiles,
} from "../../src/pages/SiteDashboard.tsx";
import {
  DOCS_BREAKDOWN,
  DOCS_PREVIOUS,
  DOCS_STATS,
  EXPECTED_DOCS,
  rangeEcho,
  WALLET_BREAKDOWN,
} from "../fixtures/web.ts";

afterEach(cleanup);

const range = rangeEcho("2026-10-14T00:00:00Z", "2026-11-13T00:00:00Z", "live", true);

describe("StatTiles", () => {
  it("shows every metric of the fixture, verified", () => {
    render(<StatTiles stats={{ range, ...DOCS_STATS }} variant="verified" compare={false} />);
    expect(
      within(screen.getByTestId("tile-pageviews")).getByText(EXPECTED_DOCS.pageviews),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-visitors")).getByText(EXPECTED_DOCS.visitors),
    ).toBeTruthy();
    expect(within(screen.getByTestId("tile-visits")).getByText(EXPECTED_DOCS.visits)).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-bounce")).getByText(EXPECTED_DOCS.bounceRate),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-duration")).getByText(EXPECTED_DOCS.duration),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-suspect")).getByText(EXPECTED_DOCS.suspect),
    ).toBeTruthy();
    expect(screen.queryByTestId("tile-pageviews-delta")).toBeNull();
  });
  it("raw changes page views and visitors only (C-73)", () => {
    render(<StatTiles stats={{ range, ...DOCS_STATS }} variant="raw" compare={false} />);
    expect(
      within(screen.getByTestId("tile-pageviews")).getByText(EXPECTED_DOCS.pageviewsRaw),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-visitors")).getByText(EXPECTED_DOCS.visitorsRaw),
    ).toBeTruthy();
    expect(within(screen.getByTestId("tile-visits")).getByText(EXPECTED_DOCS.visits)).toBeTruthy();
  });
  it("shows deltas against the previous period", () => {
    render(
      <StatTiles
        stats={{ range, ...DOCS_STATS, previous: DOCS_PREVIOUS }}
        variant="verified"
        compare
      />,
    );
    expect(screen.getByTestId("tile-pageviews-delta").textContent).toBe(
      `${EXPECTED_DOCS.deltaPageviews} vs previous period`,
    );
    expect(screen.getByTestId("tile-bounce-delta").textContent).toBe(
      `${EXPECTED_DOCS.deltaBounce} vs previous period`,
    );
    expect(screen.getByTestId("tile-duration-delta").textContent).toBe(
      `${EXPECTED_DOCS.deltaDuration} vs previous period`,
    );
  });
});

describe("BreakdownTable", () => {
  it("labels the merged row and keeps a literal 'Other' value apart (CR-38)", () => {
    render(
      <BreakdownTable
        title="Custom events"
        dimension="event"
        valueHeader="Event"
        rows={DOCS_BREAKDOWN.event.verified}
        truncated={false}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[1]?.textContent).toBe("Other20020.0%");
    expect(rows[2]?.textContent).toBe("Othercombined101.0%");
  });
  it("country names, unknown country, DB-IP attribution", () => {
    render(
      <BreakdownTable
        title="Countries"
        dimension="country"
        valueHeader="Country"
        rows={DOCS_BREAKDOWN.country.verified}
        truncated
      />,
    );
    expect(screen.getByText("Germany")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getByText("IP Geolocation by DB-IP")).toBeTruthy();
    expect(screen.getByText(/top 50 rows/)).toBeTruthy();
  });
  it("exact counts when anonymous reports are off", () => {
    render(
      <BreakdownTable
        title="Countries"
        dimension="country"
        valueHeader="Country"
        rows={WALLET_BREAKDOWN.country.verified}
        truncated={false}
      />,
    );
    expect(screen.getAllByRole("row")[2]?.textContent).toBe("Nigeria340.3%");
  });
  it("empty", () => {
    render(
      <BreakdownTable
        title="Referrers"
        dimension="referrer"
        valueHeader="Referrer"
        rows={[]}
        truncated={false}
      />,
    );
    expect(screen.getByText("No data in this range.")).toBeTruthy();
  });
});

describe("SourceIndicator (C-109, C-112)", () => {
  it.each([
    [rangeEcho("2026-10-14T00:00:00Z", "2026-11-13T00:00:00Z", "live", true), "Source: Live."],
    [
      rangeEcho("2026-08-15T00:00:00Z", "2026-11-13T00:00:00Z", "mixed", true, {
        live_start: "2026-10-20T00:00:00Z",
      }),
      "before 20 Oct 2026",
    ],
    [
      rangeEcho("2025-11-13T00:00:00Z", "2026-11-13T00:00:00Z", "rollup", true),
      "Source: Daily rollups.",
    ],
  ])("%#", (r, text) => {
    render(<SourceIndicator range={r} />);
    expect(screen.getByTestId("source-indicator").textContent).toContain(text);
    expect(screen.queryByTestId("partial-today")).toBeNull();
  });
  it("partial today", () => {
    render(
      <SourceIndicator
        range={rangeEcho("2025-11-13T00:00:00Z", "2026-11-13T00:00:00Z", "rollup", true, {
          partial_today: true,
        })}
      />,
    );
    expect(screen.getByTestId("partial-today")).toBeTruthy();
  });
});

describe("rangeQuery", () => {
  it("presets pass through; custom becomes start/end; incomplete custom is an error", () => {
    expect(rangeQuery({ range: "7d", variant: "verified", compare: false })).toEqual({
      query: { range: "7d" },
      days: 7,
    });
    expect(
      rangeQuery({
        range: "custom",
        from: "2026-10-01",
        to: "2026-10-01",
        variant: "verified",
        compare: false,
      }),
    ).toEqual({
      query: { range: "custom", start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" },
      days: 1,
    });
    expect(rangeQuery({ range: "custom", variant: "verified", compare: false })).toHaveProperty(
      "error",
    );
  });
});

describe("LineChart", () => {
  it("draws one path per series with a data table alternative", () => {
    const { container } = render(
      <LineChart
        title="Page views"
        unit="day"
        format={(v) => String(v)}
        series={[
          {
            name: "Page views",
            points: [
              { t: "2026-11-01T00:00:00Z", v: 1 },
              { t: "2026-11-02T00:00:00Z", v: null },
              { t: "2026-11-03T00:00:00Z", v: 3 },
            ],
          },
        ]}
      />,
    );
    expect(container.querySelectorAll("path.line")).toHaveLength(1);
    expect(container.querySelectorAll("circle")).toHaveLength(2);
    expect(screen.getByRole("img").getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });
  it("nice axis maxima", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(37)).toBe(50);
    expect(niceMax(36900)).toBe(50000);
    expect(niceMax(2100)).toBe(2500);
  });
});

describe("ProblemAlert", () => {
  it("shows title, detail, fields, hint and request id", () => {
    const e = new ApiError(400, {
      type: "about:blank",
      title: "Validation failed",
      status: 400,
      code: "validation_failed",
      detail: "bad input",
      request_id: "r-1",
      errors: [{ pointer: "/slug", detail: "lower-case" }],
    });
    render(<ProblemAlert error={e} />);
    const a = screen.getByRole("alert");
    expect(a.textContent).toContain("Validation failed");
    expect(a.textContent).toContain("bad input");
    expect(a.textContent).toContain("/slug: lower-case");
    expect(a.textContent).toContain("Request id: r-1");
  });
  it("explains csrf_failed", () => {
    render(
      <ProblemAlert
        error={
          new ApiError(403, { type: "x", title: "Forbidden", status: 403, code: "csrf_failed" })
        }
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Reload the page");
  });
});
