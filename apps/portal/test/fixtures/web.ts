// SPDX-License-Identifier: Apache-2.0
// Web analytics fixtures with known expected values, shared by the component tests (Vitest) and the mock control
// plane of the browser tests. Every response here is validated against the OpenAPI document
// (test/unit/fixtures.test.ts and, at runtime, by the mock server). Values are what the control plane sends — the
// rounding to 10 and the "Other" merge of anonymous reports (C-51, C-95) are applied by the control plane, so the
// fixtures carry already-rounded breakdown rows and exact totals, exactly as the contract says; the portal must show
// them unchanged and label them.

import type { ControlPlane } from "@usagemap/api-types";

type WebStats = ControlPlane.WebStats;
type WebBreakdown = ControlPlane.WebBreakdown;
type WebTimeseries = ControlPlane.WebTimeseries;
type RangeEcho = ControlPlane.RangeEcho;
type Dimension = WebBreakdown["dimension"];

export const VISITOR_NOTE =
  "Unique visitors are per UTC day; over several days they are the sum of daily uniques.";

export function rangeEcho(
  start: string,
  end: string,
  source: RangeEcho["source"],
  anonymized: boolean,
  extra: Partial<RangeEcho> = {},
): RangeEcho {
  return {
    start,
    end,
    source,
    live_start: source === "rollup" ? null : source === "live" ? start : (extra.live_start ?? null),
    partial_today: false,
    timezone: "UTC",
    anonymized,
    visitor_note: VISITOR_NOTE,
    ...extra,
  };
}

/** The ranges each preset resolves to in the fixtures (the mock's fixed "now" is 2026-11-12T10:00:00Z). */
export const PRESET_RANGES: Record<string, { start: string; end: string }> = {
  "24h": { start: "2026-11-11T10:00:00Z", end: "2026-11-12T10:00:00Z" },
  "7d": { start: "2026-11-06T00:00:00Z", end: "2026-11-13T00:00:00Z" },
  "30d": { start: "2026-10-14T00:00:00Z", end: "2026-11-13T00:00:00Z" },
  "90d": { start: "2026-08-15T00:00:00Z", end: "2026-11-13T00:00:00Z" },
  "12m": { start: "2025-11-13T00:00:00Z", end: "2026-11-13T00:00:00Z" },
  all: { start: "2024-01-01T00:00:00Z", end: "2026-11-13T00:00:00Z" },
};

/** Read path per preset, to exercise every `source` state: live, mixed, rollup (+ partial_today). */
export const PRESET_SOURCE: Record<string, Partial<RangeEcho> & { source: RangeEcho["source"] }> = {
  "24h": { source: "live" },
  "7d": { source: "live" },
  "30d": { source: "live" },
  "90d": { source: "mixed", live_start: "2026-10-20T00:00:00Z" },
  "12m": { source: "rollup", partial_today: true },
  all: { source: "rollup" },
  custom: { source: "rollup" },
};

/** Totals of the anonymous-reports site ("Docs site") for every range, exact (C-95). */
export const DOCS_STATS: Omit<WebStats, "range" | "previous" | "comparison_unavailable"> = {
  verified: { pageviews: 36900, pageviews_unidentified: 1200, visitors: 18300 },
  raw: { pageviews: 39200, pageviews_unidentified: 1310, visitors: 19400 },
  visit_metrics: {
    visits: 21000,
    bounces: 8700,
    bounce_rate_pct: 41.4,
    avg_visit_duration_s: 93,
    suspect_pageview_share: 0.06,
  },
};

export const DOCS_PREVIOUS: NonNullable<WebStats["previous"]> = {
  verified: { pageviews: 32800, pageviews_unidentified: 1000, visitors: 16000 },
  raw: { pageviews: 35000, pageviews_unidentified: 1100, visitors: 17000 },
  visit_metrics: {
    visits: 20000,
    bounces: 8000,
    bounce_rate_pct: 40.0,
    avg_visit_duration_s: 100,
    suspect_pageview_share: 0.05,
  },
};

/** Totals of the site with anonymous reports off ("Wallet app"): exact, not multiples of 10. */
export const WALLET_STATS: Omit<WebStats, "range" | "previous" | "comparison_unavailable"> = {
  verified: { pageviews: 1234, pageviews_unidentified: 7, visitors: 567 },
  raw: { pageviews: 1301, pageviews_unidentified: 9, visitors: 602 },
  visit_metrics: {
    visits: 640,
    bounces: 288,
    bounce_rate_pct: 45.0,
    avg_visit_duration_s: 3725,
    suspect_pageview_share: 0.052,
  },
};

type Row = ControlPlane.BreakdownRow;
const r = (
  value: string,
  visitors: number | null,
  pageviews: number | null,
  share: number,
  events: number | null = null,
): Row => ({
  value,
  is_other: false,
  visitors,
  pageviews,
  events,
  share_pct: share,
});
const other = (
  visitors: number | null,
  pageviews: number | null,
  share: number,
  events: number | null = null,
): Row => ({
  value: "Other",
  is_other: true,
  visitors,
  pageviews,
  events,
  share_pct: share,
});

/**
 * Anonymised breakdowns (verified and raw), rounded to 10 by the control plane, rows below 10 merged into the
 * `is_other` row. The event dimension also has a *literal* event named "Other" (CR-38) next to the merged row.
 */
export const DOCS_BREAKDOWN: Record<
  Dimension,
  { verified: Row[]; raw: Row[]; truncated?: boolean }
> = {
  referrer: {
    verified: [
      r("github.com", 2400, 3100, 41.2),
      r("stellar.org", 1200, 1500, 20.6),
      r("", 900, 1100, 15.5),
      other(40, 60, 0.7),
    ],
    raw: [
      r("github.com", 2600, 3300, 40.1),
      r("stellar.org", 1300, 1600, 20.0),
      r("", 1000, 1200, 15.4),
      other(50, 70, 0.8),
    ],
  },
  path: {
    verified: [
      r("/", 9100, 14200, 38.5),
      r("/docs/getting-started", 4300, 6900, 18.7),
      r("/docs/{id}", 2100, 3600, 9.8),
    ],
    raw: [
      r("/", 9600, 15100, 38.5),
      r("/docs/getting-started", 4500, 7300, 18.6),
      r("/docs/{id}", 2200, 3800, 9.7),
    ],
  },
  country: {
    verified: [
      r("DE", 4100, 8200, 22.4),
      r("US", 3900, 7600, 21.3),
      r("XX", 300, 500, 1.6),
      other(40, 90, 0.2),
    ],
    raw: [
      r("DE", 4300, 8600, 22.2),
      r("US", 4100, 8000, 21.1),
      r("XX", 400, 700, 2.1),
      other(50, 100, 0.3),
    ],
  },
  device: {
    verified: [
      r("desktop", 11000, 25000, 60.1),
      r("mobile", 7000, 11500, 38.3),
      other(30, 40, 0.2),
    ],
    raw: [r("desktop", 11500, 26500, 59.9), r("mobile", 7600, 12300, 39.3), other(30, 50, 0.2)],
  },
  browser: {
    verified: [
      r("chrome", 9000, 19000, 49.2),
      r("firefox", 4000, 8000, 21.9),
      r("safari", 3500, 7000, 19.1),
    ],
    raw: [
      r("chrome", 9600, 20300, 49.5),
      r("firefox", 4200, 8400, 21.6),
      r("safari", 3600, 7200, 18.6),
    ],
  },
  os: {
    verified: [
      r("Linux", 6000, 13000, 32.8),
      r("Mac OS", 5500, 11000, 30.1),
      r("Windows", 5000, 10000, 27.3),
    ],
    raw: [
      r("Linux", 6300, 13700, 32.5),
      r("Mac OS", 5800, 11500, 29.9),
      r("Windows", 5400, 10600, 27.8),
    ],
  },
  event: {
    verified: [
      r("wallet_connect", null, null, 61.0, 610),
      r("Other", null, null, 20.0, 200),
      other(null, null, 1.0, 10),
    ],
    raw: [
      r("wallet_connect", null, null, 60.0, 650),
      r("Other", null, null, 19.4, 210),
      other(null, null, 1.8, 20),
    ],
  },
};

/** The same breakdowns for the site with anonymous reports off: exact counts, no merged row. */
export const WALLET_BREAKDOWN: Record<Dimension, { verified: Row[]; raw: Row[] }> = {
  referrer: {
    verified: [r("lobstr.co", 123, 245, 19.9), r("x.com", 7, 9, 0.7)],
    raw: [r("lobstr.co", 131, 260, 20.0), r("x.com", 8, 11, 0.8)],
  },
  path: { verified: [r("/swap", 301, 777, 63.0)], raw: [r("/swap", 320, 815, 62.6)] },
  country: {
    verified: [r("BR", 211, 503, 40.8), r("NG", 3, 4, 0.3)],
    raw: [r("BR", 220, 530, 40.7), r("NG", 4, 5, 0.4)],
  },
  device: { verified: [r("mobile", 400, 900, 72.9)], raw: [r("mobile", 420, 950, 73.0)] },
  browser: { verified: [r("chrome", 350, 800, 64.8)], raw: [r("chrome", 370, 840, 64.6)] },
  os: { verified: [r("Android", 330, 760, 61.6)], raw: [r("Android", 345, 790, 60.7)] },
  event: {
    verified: [r("swap_submitted", null, null, 100.0, 87)],
    raw: [r("swap_submitted", null, null, 100.0, 93)],
  },
};

const DAY_MS = 86_400_000;

/** Deterministic time series between start and end at the given unit. Visit series only for day/month (C-112(4)). */
export function series(
  range: RangeEcho,
  unit: WebTimeseries["unit"],
  metrics: string[],
): WebTimeseries {
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  const ts: string[] = [];
  if (unit === "hour") {
    for (let t = start; t < end; t += 3_600_000)
      ts.push(new Date(t).toISOString().replace(".000Z", "Z"));
  } else if (unit === "day") {
    for (let t = Math.floor(start / DAY_MS) * DAY_MS; t < end; t += DAY_MS)
      ts.push(new Date(t).toISOString().replace(".000Z", "Z"));
  } else {
    const d = new Date(start);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    while (Date.UTC(y, m, 1) < end) {
      ts.push(new Date(Date.UTC(y, m, 1)).toISOString().replace(".000Z", "Z"));
      m += 1;
      if (m === 12) {
        m = 0;
        y += 1;
      }
    }
  }
  const scale = unit === "hour" ? 1 : unit === "day" ? 24 : 720;
  const point = (t: string, i: number, raw: boolean) => ({
    t,
    pageviews: (50 + i * 3) * scale + (raw ? 5 * scale : 0),
    pageviews_unidentified: 2 * scale,
    visitors: (20 + i) * scale + (raw ? 2 * scale : 0),
  });
  const out: WebTimeseries = {
    range,
    unit,
    verified: ts.map((t, i) => point(t, i, false)),
    raw: ts.map((t, i) => point(t, i, true)),
  };
  if (
    unit !== "hour" &&
    metrics.some((m) =>
      ["visits", "bounces", "bounce_rate_pct", "avg_visit_duration_s"].includes(m),
    )
  ) {
    out.visit_metrics = ts.map((t, i) => ({
      t,
      visits: (25 + i) * scale,
      bounces: (10 + (i % 3)) * scale,
      bounce_rate_pct: 40 + (i % 3),
      avg_visit_duration_s: 90 + i,
      suspect_pageview_share: 0.06,
    }));
  }
  return out;
}

/** What the tests expect to see for the Docs site (anonymous reports on) with `variant=verified`. */
export const EXPECTED_DOCS = {
  pageviews: "36,900",
  pageviewsRaw: "39,200",
  visitors: "18,300",
  visitorsRaw: "19,400",
  visits: "21,000",
  bounceRate: "41.4%",
  duration: "1 min 33 s",
  suspect: "6.0%",
  // compare=previous (30d): (36900−32800)/32800 = +12.5 %; visitors (18300−16000)/16000 = +14.4 %;
  // visits +5.0 %; bounce rate 41.4 − 40.0 = +1.4 pp; duration (93−100)/100 = −7.0 %
  deltaPageviews: "+12.5%",
  deltaVisitors: "+14.4%",
  deltaVisits: "+5.0%",
  deltaBounce: "+1.4 pp",
  deltaDuration: "−7.0%",
};

export const EXPECTED_WALLET = {
  pageviews: "1,234",
  visitors: "567",
  visits: "640",
  bounceRate: "45.0%",
  duration: "1 h 02 min",
  suspect: "5.2%",
};
