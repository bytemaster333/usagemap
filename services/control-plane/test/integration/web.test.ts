// SPDX-License-Identifier: Apache-2.0
// Tenant web analytics through the HTTP API on the real database, with a scripted engine (the LiveReader the adapter
// provides) so every figure has a known expected value: the live/rollup composition of §j.6 (C-109), the 5 s fallback
// with `partial_today` (C-112(6)), compare=previous (C-112(5)), the C-73 figures (verified/raw page views and
// visitors, one visit figure, twin page views), time series units (C-112(4)), breakdowns with anonymous reports
// (C-51: rounding to 10 and "Other") and the CSV export with `X-SCF-Source`. Every response is validated against the
// OpenAPI document by `call()`.

import { randomBytes, randomUUID } from "node:crypto";
import {
  type ExpandedRow,
  type PageviewsResult,
  type Range,
  type StatsResult,
  UmamiHttpError,
  UmamiUnavailableError,
} from "@usagemap/umami-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpMetrics } from "../../src/obs/metrics.ts";
import { encryptCredential } from "../../src/umami/credentials.ts";
import type { LiveReader } from "../../src/web/handlers.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const KEY = randomBytes(32);
const API_KEY = `umami_${"a".repeat(32)}`;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const dstr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Call {
  fn: string;
  website: string;
  range: Range;
  variant: string;
}

/** A scripted engine: fixed answers per (website, variant); records every call; can be made to time out. */
class FakeEngine implements LiveReader {
  calls: Call[] = [];
  down = false;
  /** The website is not readable with the tenant's key (e.g. outside the tenant's team): Umami answers 401. */
  unauthorized = false;
  main = "";
  twin = "";
  stats = async (key: string, website: string, range: Range, variant: "verified" | "raw") => {
    this.#check(key, "stats", website, range, variant);
    const r: Record<string, StatsResult> = {
      [`${this.main}/verified`]: {
        pageviews: 70,
        visitors: 30,
        visits: 999,
        bounces: 999,
        totaltime: 999,
      },
      [`${this.main}/raw`]: {
        pageviews: 80,
        visitors: 35,
        visits: 45,
        bounces: 9,
        totaltime: 4500,
      },
      [`${this.twin}/verified`]: {
        pageviews: 5,
        visitors: 99,
        visits: 99,
        bounces: 99,
        totaltime: 99,
      },
      [`${this.twin}/raw`]: { pageviews: 7, visitors: 99, visits: 99, bounces: 99, totaltime: 99 },
    };
    return r[`${website}/${variant}`] as StatsResult;
  };
  pageviews = async (
    key: string,
    website: string,
    range: Range,
    unit: "hour" | "day",
    variant: "verified" | "raw",
  ): Promise<PageviewsResult> => {
    this.#check(key, `pageviews:${unit}`, website, range, variant);
    const step = unit === "hour" ? HOUR : DAY;
    const pv =
      website === this.main ? (variant === "verified" ? 10 : 12) : variant === "verified" ? 1 : 2;
    const ses = website === this.main ? (variant === "verified" ? 4 : 5) : 99;
    const pts: PageviewsResult = { pageviews: [], sessions: [] };
    for (let t = Math.floor(range.start / step) * step; t < range.end; t += step) {
      pts.pageviews.push({ x: new Date(t).toISOString(), y: pv });
      pts.sessions.push({ x: new Date(t).toISOString(), y: ses });
    }
    return pts;
  };
  expanded = async (
    key: string,
    website: string,
    range: Range,
    type: string,
    variant: "verified" | "raw",
  ): Promise<ExpandedRow[]> => {
    this.#check(key, `expanded:${type}`, website, range, variant);
    const row = (name: string, pageviews: number, visitors: number) => ({
      name,
      pageviews,
      visitors,
      visits: 0,
      bounces: 0,
      totaltime: 0,
    });
    if (website === this.twin) return [row("DE", 3, 0)];
    return variant === "verified"
      ? [row("DE", 40, 22), row("FR", 6, 4), row("", 9, 9)]
      : [row("DE", 50, 26), row("FR", 8, 5), row("NL", 2, 2)];
  };
  events = async (key: string, website: string, range: Range, variant: "verified" | "raw") => {
    this.#check(key, "events", website, range, variant);
    return website === this.main
      ? [{ name: "signup", events: 8 }]
      : [{ name: "signup", events: 1 }];
  };
  #check(key: string, fn: string, website: string, range: Range, variant: string) {
    if (key !== API_KEY) throw new Error("wrong api key");
    this.calls.push({ fn, website, range, variant });
    if (this.down)
      throw new UmamiUnavailableError("GET", "/api/websites/{websiteId}/stats", "timeout");
    if (this.unauthorized) throw new UmamiHttpError("GET", "/api/websites/{websiteId}/stats", 401);
  }
}

let h: Harness;
const engine = new FakeEngine();
let cookie = "";
let tenant = "";
let site = "";
let today = 0;
let b = 0; // live boundary with L = 5

const ROW = {
  pv_v: 100,
  pv_r: 120,
  unid_v: 10,
  unid_r: 12,
  vis_v: 40,
  vis_r: 50,
  visits: 60,
  bounces: 30,
  dur: 6000,
};
const TODAY_ROW = {
  ...ROW,
  pv_v: 11,
  pv_r: 13,
  unid_v: 1,
  unid_r: 2,
  vis_v: 3,
  vis_r: 4,
  visits: 5,
  bounces: 2,
  dur: 700,
};

async function insertDaily(day: number, r: typeof ROW, eventsRaw = 50_000) {
  await h.su.query(
    `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
       pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces,
       total_duration_s, events_raw, is_final, engine_version)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'umami/3.5.0')`,
    [
      tenant,
      site,
      dstr(day),
      r.pv_v,
      r.pv_r,
      r.unid_v,
      r.unid_r,
      r.vis_v,
      r.vis_r,
      r.visits,
      r.bounces,
      r.dur,
      eventsRaw,
      day < today,
    ],
  );
}

async function insertBreakdown(
  day: number,
  variant: string,
  value: string,
  visitors: number,
  pageviews: number,
) {
  await h.su.query(
    `INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews, visits)
     VALUES ($1, $2, $3::date, $4::scf.web_variant, 'country', $5, 1, $6, $7, $8)`,
    [
      tenant,
      site,
      dstr(day),
      variant,
      value,
      visitors,
      pageviews,
      variant === "raw" ? visitors : null,
    ],
  );
}

beforeAll(async () => {
  h = await startHarness(
    { SCF_UMAMI_CREDS_KEYS: `1:${KEY.toString("base64")}` },
    { reader: engine },
  );
  today = Math.floor(Date.now() / DAY) * DAY;
  b = today - 4 * DAY;
  cookie = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, cookie);
  const s = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenant}/sites`,
    cookie,
    body: { name: "Web", visitor_id: "off" },
  });
  site = s.json().site_id;
  const ids = (
    await h.su.query(
      `UPDATE scf.sites SET twin_provisioned_at = now() WHERE site_id = $1
        RETURNING umami_website_id::text AS m, umami_twin_website_id::text AS t`,
      [site],
    )
  ).rows[0] as { m: string; t: string };
  engine.main = ids.m;
  engine.twin = ids.t;
  const k = encryptCredential(
    { keys: new Map([[1, KEY]]), current: 1 },
    tenant,
    "api_key",
    API_KEY,
  );
  const p = encryptCredential({ keys: new Map([[1, KEY]]), current: 1 }, tenant, "password", "pw");
  await h.su.query(
    `INSERT INTO scf.umami_credentials (tenant_id, umami_team_id, umami_user_id, umami_username, umami_api_key_id,
       api_key_ciphertext, password_ciphertext, key_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
    [
      tenant,
      randomUUID(),
      randomUUID(),
      `scf-t-${tenant.replace(/-/g, "")}`,
      randomUUID(),
      k.ciphertext,
      p.ciphertext,
    ],
  );
  // 40 closed days at 50,000 engine events each → live window floor(250,000 / 50,000) = 5 days (C-109).
  for (let d = today - 40 * DAY; d < today; d += DAY) await insertDaily(d, ROW);
  await insertDaily(today, TODAY_ROW, 1000);
  // breakdown rows: 25 rollup days of the 30d range get DE and FR; one day has a rare value
  for (let d = today - 29 * DAY; d < b; d += DAY) {
    await insertBreakdown(d, "verified", "DE", 20, 30);
    await insertBreakdown(d, "raw", "DE", 22, 33);
  }
  await insertBreakdown(today - 20 * DAY, "verified", "JP", 3, 3);
  await insertBreakdown(today - 20 * DAY, "raw", "JP", 3, 4);
  await h.su.query(`SELECT scf.ensure_partitions()`);
  const live = await h.su.query(`SELECT scf.web_live_window_days($1, $2) AS l`, [tenant, site]);
  expect(Number(live.rows[0].l)).toBe(5);
});
afterAll(async () => {
  await h?.close();
});

const stats = (q: string) =>
  call(h, { method: "GET", url: `/v1/tenants/${tenant}/sites/${site}/web/stats?${q}`, cookie });

describe("web stats (C-73, C-109, C-110)", () => {
  it("composes a 30-day range: rollup days before b, the engine from b on (source mixed)", async () => {
    engine.calls = [];
    const res = await stats("range=30d");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["x-scf-source"]).toBe("mixed");
    const body = res.json();
    expect(body.range).toMatchObject({
      start: iso(today - 29 * DAY),
      end: iso(today + DAY),
      source: "mixed",
      live_start: iso(b),
      partial_today: false,
      timezone: "UTC",
      anonymized: true,
    });
    // 25 rollup days × ROW + the engine's live figures (main + twin page views; main visitors; one visit figure)
    expect(body.verified).toEqual({ pageviews: 2575, pageviews_unidentified: 255, visitors: 1030 });
    expect(body.raw).toEqual({ pageviews: 3087, pageviews_unidentified: 307, visitors: 1285 });
    expect(body.visit_metrics).toEqual({
      visits: 1545,
      bounces: 759,
      bounce_rate_pct: 49.1,
      avg_visit_duration_s: 100,
      suspect_pageview_share: 0.1659,
    });
    expect(body.previous).toBeUndefined();
    // four R1 calls for the live part [b, end): M and T, verified and raw
    expect(
      engine.calls
        .map((c) => `${c.fn}:${c.website === engine.main ? "M" : "T"}:${c.variant}`)
        .sort(),
    ).toEqual(["stats:M:raw", "stats:M:verified", "stats:T:raw", "stats:T:verified"]);
    for (const c of engine.calls) expect(c.range).toEqual({ start: b, end: today + DAY });
  });

  it("variant=verified returns only verified figures; visit metrics always", async () => {
    const body = (await stats("range=30d&variant=verified")).json();
    expect(body.verified).toBeDefined();
    expect(body.raw).toBeUndefined();
    expect(body.visit_metrics.visits).toBe(1545);
  });

  it("falls back to the rollups when the engine does not answer (source rollup, partial_today)", async () => {
    engine.down = true;
    try {
      const res = await stats("range=30d");
      const body = res.json();
      expect(res.headers["x-scf-source"]).toBe("rollup");
      expect(body.range).toMatchObject({ source: "rollup", live_start: null, partial_today: true });
      // 29 closed days × ROW + today's (not final) row
      expect(body.verified).toEqual({
        pageviews: 2911,
        pageviews_unidentified: 291,
        visitors: 1163,
      });
      expect(body.raw).toEqual({ pageviews: 3493, pageviews_unidentified: 350, visitors: 1454 });
      expect(body.visit_metrics.visits).toBe(29 * 60 + 5);
    } finally {
      engine.down = false;
    }
  });

  it("a live read refused by the engine (401) falls back, and is counted and logged — never silent (2026-11-13 regression)", async () => {
    const before = cpMetrics.registry.value("scf_cp_web_live_fallbacks_total", {
      reason: "unauthorized",
    });
    engine.unauthorized = true;
    try {
      const res = await stats("range=24h");
      expect(res.statusCode).toBe(200);
      expect(res.json().range).toMatchObject({ source: "rollup", partial_today: true });
    } finally {
      engine.unauthorized = false;
    }
    expect(
      cpMetrics.registry.value("scf_cp_web_live_fallbacks_total", { reason: "unauthorized" }),
    ).toBeGreaterThan(before);
    const line = h.logs.lines.find(
      (l) => l.includes("web live read answered from the rollups") && l.includes("unauthorized"),
    );
    expect(line).toBeDefined();
    const entry = JSON.parse(line as string);
    expect(entry).toMatchObject({ site_id: site, reason: "unauthorized", status: 401 });
    expect(line).not.toContain(API_KEY);
    // The Prometheus text carries the reason label only.
    expect(await cpMetrics.registry.render()).toMatch(
      /scf_cp_web_live_fallbacks_total\{reason="unauthorized"\} \d+/,
    );
  });

  it("compare=previous composes the preceding range by the same rules (C-112(5))", async () => {
    const body = (await stats("range=7d&compare=previous")).json();
    // main: rollup [today−6, b) = 2 days + live; previous: [today−13, today−6) = 7 rollup days
    expect(body.range.source).toBe("mixed");
    expect(body.verified.pageviews).toBe(2 * 100 + 75);
    expect(body.comparison_unavailable).toBe(false);
    expect(body.previous.verified).toEqual({
      pageviews: 700,
      pageviews_unidentified: 70,
      visitors: 280,
    });
    expect(body.previous.visit_metrics).toEqual({
      visits: 420,
      bounces: 210,
      bounce_rate_pct: 50,
      avg_visit_duration_s: 100,
      suspect_pageview_share: 0.1667,
    });
  });

  it("24h is live in full; with a 5-day window its previous 24 hours are live too", async () => {
    const body = (await stats("range=24h&compare=previous")).json();
    expect(body.range.source).toBe("live");
    expect(body.range.live_start).toBe(body.range.start);
    expect(body.verified.pageviews).toBe(75);
    expect(body.comparison_unavailable).toBe(false);
    expect(body.previous.verified.pageviews).toBe(75);
  });

  it("a range entirely before the live window is rollup only", async () => {
    const q = `range=custom&start=${iso(today - 20 * DAY)}&end=${iso(today - 10 * DAY)}`;
    const body = (await stats(q)).json();
    expect(body.range).toMatchObject({ source: "rollup", live_start: null, partial_today: false });
    expect(body.verified.pageviews).toBe(1000);
  });

  it("a custom range whose rollup part is not whole UTC days is 400 naming the boundary (DV-38)", async () => {
    const res = await stats(`range=custom&start=${iso(today - 10 * DAY + HOUR)}&end=${iso(today)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
    expect(res.json().errors[0].pointer).toBe("/start");
    expect(res.json().detail).toContain(iso(b));
    const bad = await stats(`range=7d&start=${iso(today)}`);
    expect(bad.statusCode).toBe(400);
  });

  it("a tenant without engine credentials is answered from the rollups", async () => {
    const other = await createTenant(h, cookie);
    const s = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${other}/sites`,
        cookie,
        body: { name: "N" },
      })
    ).json();
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${other}/sites/${s.site_id}/web/stats?range=7d`,
      cookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().range).toMatchObject({ source: "rollup", partial_today: true });
    expect(res.json().verified).toEqual({ pageviews: 0, pageviews_unidentified: 0, visitors: 0 });
    expect(res.json().visit_metrics.bounce_rate_pct).toBeNull();
    // live window 1 day: the previous 24 hours lie before it and are not whole UTC days → not composable
    const cmp = await call(h, {
      method: "GET",
      url: `/v1/tenants/${other}/sites/${s.site_id}/web/stats?range=24h&compare=previous`,
      cookie,
    });
    expect(cmp.json().previous).toBeNull();
    expect(cmp.json().comparison_unavailable).toBe(true);
  });
});

describe("web time series (C-112(4))", () => {
  it("daily series: rollup days from the table, live days from R2, visit metrics from complete days + today live", async () => {
    engine.calls = [];
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/timeseries?range=7d&unit=day&metrics=pageviews,visitors,visits,bounce_rate_pct,suspect_pageview_share`,
      cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.unit).toBe("day");
    expect(body.verified).toHaveLength(7);
    // two rollup days, then five live days (R2: M 10 + T 1 verified page views, M 4 sessions)
    expect(body.verified.map((p: { pageviews: number }) => p.pageviews)).toEqual([
      100, 100, 11, 11, 11, 11, 11,
    ]);
    expect(body.raw.map((p: { visitors: number }) => p.visitors)).toEqual([50, 50, 5, 5, 5, 5, 5]);
    expect(body.verified[0].t).toBe(iso(today - 6 * DAY));
    // visits: complete days from the daily rows; today from a live R1 (raw, main) over [today, now)
    expect(body.visit_metrics.map((p: { visits: number }) => p.visits)).toEqual([
      60, 60, 60, 60, 60, 60, 45,
    ]);
    expect(body.visit_metrics[6].bounce_rate_pct).toBe(20);
    expect(body.visit_metrics[0].suspect_pageview_share).toBe(0.1667);
    expect(body.visit_metrics[0]).not.toHaveProperty("bounces");
    const r2 = engine.calls.filter((c) => c.fn === "pageviews:day");
    expect(r2).toHaveLength(4);
    for (const c of r2) expect(c.range).toEqual({ start: b, end: today + DAY });
    const r1 = engine.calls.filter((c) => c.fn === "stats");
    expect(r1).toHaveLength(1);
    expect(r1[0]?.range.start).toBe(today);
  });

  it("monthly buckets are sums of days", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/timeseries?range=90d&unit=month&variant=raw`,
      cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const pts = res.json().raw as Array<{ t: string; pageviews: number }>;
    expect(pts[0]?.t.endsWith("-01T00:00:00Z")).toBe(true);
    // 41 days of rows inside the 90-day range: 36 rollup days × 120 + 5 live days × 14 (M 12 + T 2)
    expect(pts.reduce((s, p) => s + p.pageviews, 0)).toBe(36 * 120 + 5 * 14);
  });

  it("visit metrics with unit=hour are 400; hourly page views over 24h come live per hour", async () => {
    const bad = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/timeseries?range=24h&unit=hour&metrics=visits`,
      cookie,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0].pointer).toBe("/metrics");
    const ok = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/timeseries?range=24h`,
      cookie,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().unit).toBe("hour");
    expect(ok.json().range.source).toBe("live");
    expect(ok.json().verified.length).toBeGreaterThanOrEqual(24);
  });

  it("hourly rows serve the part before the live window", async () => {
    const h0 = today - 8 * DAY;
    await h.su.query(`SELECT scf.ensure_partitions()`);
    const part = await h.su.query(
      `SELECT to_regclass('scf_part.web_hourly_totals_' || to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYYMM')) AS p`,
      [new Date(h0)],
    );
    if (!part.rows[0].p) return; // the month before the current one has no partition in a fresh database
    await h.su.query(
      `INSERT INTO scf.web_hourly_totals (tenant_id, site_id, hour_start, pageviews_verified, pageviews_raw,
         pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, events_raw)
       VALUES ($1, $2, $3, 7, 9, 1, 1, 3, 4, 20), ($1, $2, $4, 5, 6, 0, 0, 2, 2, 10)`,
      [tenant, site, new Date(h0 + 2 * HOUR), new Date(h0 + 3 * HOUR)],
    );
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/timeseries?range=custom&start=${iso(h0 + HOUR)}&end=${iso(h0 + 5 * HOUR)}&unit=hour`,
      cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().range.source).toBe("rollup");
    expect(res.json().verified.map((p: { pageviews: number }) => p.pageviews)).toEqual([
      0, 7, 5, 0,
    ]);
  });

  it("a series is bounded: no future start, end ≤ now + 1 day, ≤ 10,000 points", async () => {
    const url = (q: string) =>
      `/v1/tenants/${tenant}/sites/${site}/web/timeseries?range=custom&${q}`;
    const probe = await call(h, {
      method: "GET",
      url: url(`start=${iso(today)}&end=${iso(today + 3650 * DAY)}&unit=hour`),
      cookie,
    });
    expect(probe.statusCode, probe.body).toBe(400);
    expect(probe.json().errors[0].pointer).toBe("/end");
    const future = await call(h, {
      method: "GET",
      url: url(`start=${iso(today + 2 * DAY)}&end=${iso(today + 3 * DAY)}`),
      cookie,
    });
    expect(future.statusCode).toBe(400);
    expect(future.json().errors[0].pointer).toBe("/start");
    const many = await call(h, {
      method: "GET",
      url: url(`start=${iso(today - 500 * DAY)}&end=${iso(today)}&unit=hour`),
      cookie,
    });
    expect(many.statusCode).toBe(400);
    expect(many.json().errors[0].pointer).toBe("/unit");
  });
});

describe("web breakdown (C-51, C-73)", () => {
  it("merges rollup and live rows, rounds to 10 and merges small rows into Other (anonymous reports on)", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/breakdown?range=30d&dimension=country`,
      cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.truncated).toBe(true);
    expect(body.range.anonymized).toBe(true);
    // verified DE: 25 days × 20 visitors + 22 live = 522 → 520; page views 25 × 30 + 40 + 3 (twin) = 793 → 790
    // FR live 4 visitors and JP 3 (rollup) are below 10 → Other (7 → 10, page views 6 + 3 = 9 → 10)
    expect(body.verified).toEqual([
      {
        value: "DE",
        is_other: false,
        visitors: 520,
        pageviews: 790,
        events: null,
        share_pct: 98.1,
      },
      { value: "Other", is_other: true, visitors: 10, pageviews: 10, events: null, share_pct: 1.9 },
    ]);
    expect(body.raw[0]).toMatchObject({ value: "DE", visitors: 580, pageviews: 880 });
  });

  it("with anonymous reports off the rows are exact", async () => {
    const put = await call(h, {
      method: "PUT",
      url: `/v1/tenants/${tenant}/sites/${site}/anonymous-reports`,
      cookie,
      body: { anonymous_reports: false },
    });
    expect(put.statusCode).toBe(200);
    try {
      const body = (
        await call(h, {
          method: "GET",
          url: `/v1/tenants/${tenant}/sites/${site}/web/breakdown?range=30d&dimension=country&variant=verified`,
          cookie,
        })
      ).json();
      expect(body.range.anonymized).toBe(false);
      expect(body.raw).toBeUndefined();
      expect(
        body.verified.map((r: { value: string; visitors: number }) => [r.value, r.visitors]),
      ).toEqual([
        ["DE", 522],
        ["FR", 4],
        ["JP", 3],
      ]);
    } finally {
      await call(h, {
        method: "PUT",
        url: `/v1/tenants/${tenant}/sites/${site}/anonymous-reports`,
        cookie,
        body: { anonymous_reports: true },
      });
    }
  });

  it("event breakdowns count events of main + twin", async () => {
    const body = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/sites/${site}/web/breakdown?range=24h&dimension=event&variant=raw`,
        cookie,
      })
    ).json();
    expect(body.truncated).toBe(false);
    // Anonymous reports apply the minimum count per UTC day: the 24 h range is read live once
    // per UTC day it touches (the scripted engine answers 8 + 1 events to each read); 9 < 10 on each day, so both
    // days go to "Other" (18, rounded to 20).
    expect(engine.calls.filter((c) => c.fn === "events").length).toBeGreaterThanOrEqual(4);
    expect(body.raw).toEqual([
      {
        value: "Other",
        is_other: true,
        visitors: null,
        pageviews: null,
        events: 20,
        share_pct: 100,
      },
    ]);
  });
});

describe("CSV export", () => {
  it("one row per UTC day with the read path in X-SCF-Source", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/export?range=7d`,
      cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["x-scf-source"]).toBe("mixed");
    expect(res.headers["x-scf-anonymized"]).toBe("true");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe(
      "day,pageviews_verified,pageviews_raw,pageviews_unidentified_verified,pageviews_unidentified_raw,visitors_verified,visitors_raw,visits,bounces,bounce_rate_pct,avg_visit_duration_s,suspect_pageview_share",
    );
    expect(lines).toHaveLength(8);
    expect(lines[1]).toBe(`${dstr(today - 6 * DAY)},100,120,10,12,40,50,60,30,50,100,0.1667`);
    expect(lines[7]?.startsWith(`${dstr(today)},11,14,1,2,4,5,45,9,20,100,`)).toBe(true);
    const bad = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/export?range=24h`,
      cookie,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("hidden data", () => {
  it("a removed tenant's web data is 404 (C-08)", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    const s = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "R" },
      })
    ).json();
    const removed = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/removal`,
      cookie: owner,
      body: { reason: "test" },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t}/sites/${s.site_id}/web/stats`,
      cookie: owner,
    });
    expect(res.statusCode).toBe(404);
  });
});
