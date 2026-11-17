// SPDX-License-Identifier: Apache-2.0
// Acceptance (C-109, wire-formats §j.5): the daily rollup of a fixture day equals Umami's own API answers for the
// same day — /stats (unfiltered and tag=v), /metrics/expanded per dimension, /metrics?type=event and /pageviews per
// hour — under the C-73 rules (verified = tag v, raw = unfiltered; page views and events add main + twin; visitors,
// visits, bounces and duration from the main website only, visit metrics once over all identified events); the job
// reads Umami only through scf_ro as scf_umami_ro, writes under the site's tenant context, and is idempotent.

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb, UmamiDb } from "../../src/db.ts";
import { runWebRollup } from "../../src/jobs/web-rollup.ts";
import { addDays, dayStart, utcDay } from "../../src/schedule.ts";
import {
  capture,
  jobsDb,
  num,
  type SeededSite,
  seedSite,
  superClient,
  UA,
  UmamiApi,
  umamiRo,
} from "../support/harness.ts";

const DIMS = ["referrer", "country", "device", "browser", "os", "path"] as const;

let su: pg.Pool;
let db: ScfDb;
let ro: UmamiDb;
let api: UmamiApi;
let site: SeededSite;
let other: SeededSite;
const DAY = utcDay(new Date());
const at = (hhmmss: string, day = DAY) => new Date(`${day}T${hhmmss}Z`);

/**
 * The fixture day (S-01 §4's shape, extended): visits with and without bounces, a custom event inside a visit (not a
 * bounce), a custom-event-only visit (neither visit nor visitor), suspect (`s`) page views inside verified visits, a
 * returning session with a second visit, twin page views, and events just outside the day on both sides.
 */
async function seedFixture(): Promise<void> {
  const M = site.umamiId;
  const T = site.twinId as string;
  const s = (n: number) => `2001:db8:5c1f::${n.toString(16)}`;
  // V1: bounce, referrer HN (session S1)
  await api.send({
    website: M,
    surrogate: s(1),
    country: "DE",
    ua: UA.chromeWin,
    at: at("01:00:00"),
    url: "/",
    tag: "v",
    referrer: "news.ycombinator.com",
  });
  // V2: three page views with the visit's cache token, 300 s, referrer github (S2, iOS)
  let c = await api.send({
    website: M,
    surrogate: s(2),
    country: "FR",
    ua: UA.safariIos,
    at: at("01:00:00"),
    url: "/",
    tag: "v",
    referrer: "github.com",
    screen: "390x844",
  });
  c = await api.send({
    website: M,
    surrogate: s(2),
    country: "FR",
    ua: UA.safariIos,
    at: at("01:02:00"),
    url: "/pricing",
    tag: "v",
    cache: c,
    screen: "390x844",
  });
  await api.send({
    website: M,
    surrogate: s(2),
    country: "FR",
    ua: UA.safariIos,
    at: at("01:05:00"),
    url: "/docs",
    tag: "v",
    cache: c,
    screen: "390x844",
  });
  // V3: page view + custom wallet event → not a bounce, 0 s (S3, Firefox/Linux)
  c = await api.send({
    website: M,
    surrogate: s(3),
    country: "US",
    ua: UA.firefoxLinux,
    at: at("02:10:00"),
    url: "/",
    tag: "v",
  });
  await api.send({
    website: M,
    surrogate: s(3),
    country: "US",
    ua: UA.firefoxLinux,
    at: at("02:11:00"),
    url: "/",
    tag: "v",
    name: "wallet_selected",
    cache: c,
  });
  // V4: suspect-only bounce (S4)
  await api.send({
    website: M,
    surrogate: s(4),
    country: "DE",
    ua: UA.chromeWin,
    at: at("03:20:00"),
    url: "/",
    tag: "s",
  });
  // V5: v then s page view, 61 s (S5, Android)
  c = await api.send({
    website: M,
    surrogate: s(5),
    country: "DE",
    ua: UA.chromeAndroid,
    at: at("03:30:00"),
    url: "/",
    tag: "v",
    screen: "412x915",
  });
  await api.send({
    website: M,
    surrogate: s(5),
    country: "DE",
    ua: UA.chromeAndroid,
    at: at("03:31:01"),
    url: "/pricing",
    tag: "s",
    cache: c,
    screen: "412x915",
  });
  // V6: custom event only → neither a visit nor a visitor (S6)
  await api.send({
    website: M,
    surrogate: s(6),
    country: "GB",
    ua: UA.chromeWin,
    at: at("04:40:00"),
    url: "/",
    tag: "v",
    name: "modal_opened",
  });
  // V7: S1 returns in another hour → same session, new visit: s then v page view, 125.5 s (floor), custom event s
  c = await api.send({
    website: M,
    surrogate: s(1),
    country: "DE",
    ua: UA.chromeWin,
    at: at("06:00:00"),
    url: "/docs",
    tag: "s",
  });
  c = await api.send({
    website: M,
    surrogate: s(1),
    country: "DE",
    ua: UA.chromeWin,
    at: at("06:02:05"),
    url: "/docs",
    tag: "v",
    cache: c,
  });
  await api.send({
    website: M,
    surrogate: s(1),
    country: "DE",
    ua: UA.chromeWin,
    at: at("06:03:00"),
    url: "/docs",
    tag: "s",
    name: "connect",
    cache: c,
  });
  // Twin (unidentified, C-73): page views only count
  await api.send({
    website: T,
    surrogate: s(7),
    country: "DE",
    ua: UA.chromeWin,
    at: at("07:00:00"),
    url: "/",
    tag: "v",
  });
  await api.send({
    website: T,
    surrogate: s(8),
    country: "FR",
    ua: UA.safariIos,
    at: at("07:30:00"),
    url: "/pricing",
    tag: "s",
  });
  await api.send({
    website: T,
    surrogate: s(9),
    country: "DE",
    ua: UA.firefoxLinux,
    at: at("23:59:59"),
    url: "/",
    tag: "v",
    referrer: "news.ycombinator.com",
  });
  await api.send({
    website: T,
    surrogate: s(9),
    country: "DE",
    ua: UA.firefoxLinux,
    at: at("23:59:59"),
    url: "/",
    tag: "v",
    name: "wallet_selected",
  });
  // Just outside the day: excluded by both Umami's range and ours
  await api.send({
    website: M,
    surrogate: s(10),
    country: "DE",
    ua: UA.chromeWin,
    at: at("23:59:59", addDays(DAY, -1)),
    url: "/",
    tag: "v",
  });
  await api.send({
    website: M,
    surrogate: s(11),
    country: "DE",
    ua: UA.chromeWin,
    at: at("00:00:00", addDays(DAY, 1)),
    url: "/",
    tag: "v",
  });
  // Another tenant's site the same day: never mixed into this site's rows
  await api.send({
    website: other.umamiId,
    surrogate: s(12),
    country: "DE",
    ua: UA.chromeWin,
    at: at("05:00:00"),
    url: "/other",
    tag: "v",
  });
}

const range = () => ({
  startAt: dayStart(DAY).getTime(),
  // Umami's endAt is inclusive (S-01): end − 1 ms for our exclusive end (wire-formats §j.3)
  endAt: dayStart(addDays(DAY, 1)).getTime() - 1,
  timezone: "UTC",
});

interface Stats {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}

async function stats(id: string, tag?: "v"): Promise<Stats> {
  const r = await api.get<Record<string, unknown>>(`/api/websites/${id}/stats`, {
    ...range(),
    ...(tag ? { tag } : {}),
  });
  return {
    pageviews: num(r.pageviews),
    visitors: num(r.visitors),
    visits: num(r.visits),
    bounces: num(r.bounces),
    totaltime: num(r.totaltime),
  };
}

type Expanded = Map<string, { pageviews: number; visitors: number; visits: number }>;
async function expanded(id: string, type: string, tag?: "v"): Promise<Expanded> {
  const r = await api.get<Record<string, unknown>[]>(`/api/websites/${id}/metrics/expanded`, {
    ...range(),
    type,
    limit: 500,
    ...(tag ? { tag } : {}),
  });
  return new Map(
    r.map((x) => [
      String(x.name),
      { pageviews: num(x.pageviews), visitors: num(x.visitors), visits: num(x.visits) },
    ]),
  );
}

async function eventMetrics(id: string, tag?: "v"): Promise<Map<string, number>> {
  const r = await api.get<{ x: string; y: unknown }[]>(`/api/websites/${id}/metrics`, {
    ...range(),
    type: "event",
    limit: 500,
    ...(tag ? { tag } : {}),
  });
  return new Map(r.map((x) => [x.x, num(x.y)]));
}

interface Series {
  pageviews: { x: string; y: unknown }[];
  sessions: { x: string; y: unknown }[];
}
async function hourly(
  id: string,
  tag?: "v",
): Promise<{ pv: Map<string, number>; sess: Map<string, number> }> {
  const r = await api.get<Series>(`/api/websites/${id}/pageviews`, {
    ...range(),
    unit: "hour",
    ...(tag ? { tag } : {}),
  });
  const hourKey = (x: string) =>
    new Date(/Z$|[+-]\d\d:?\d\d$/.test(x) ? x : `${x.replace(" ", "T")}Z`).toISOString();
  return {
    pv: new Map(r.pageviews.map((p) => [hourKey(p.x), num(p.y)])),
    sess: new Map(r.sessions.map((p) => [hourKey(p.x), num(p.y)])),
  };
}

async function tableRows(siteId: string): Promise<unknown[]> {
  const t = await su.query(
    `SELECT pageviews_verified, pageviews_raw, pageviews_unidentified_verified, pageviews_unidentified_raw,
            visitors_verified, visitors_raw, visits, bounces, total_duration_s, events_raw, is_final, engine_version,
            tenant_id, day::text
       FROM scf.web_daily_totals WHERE site_id = $1 ORDER BY day`,
    [siteId],
  );
  const h = await su.query(
    `SELECT hour_start, pageviews_verified, pageviews_raw, pageviews_unidentified_verified, pageviews_unidentified_raw,
            visitors_verified, visitors_raw, events_raw
       FROM scf.web_hourly_totals WHERE site_id = $1 ORDER BY hour_start`,
    [siteId],
  );
  const b = await su.query(
    `SELECT day::text, variant::text, dimension::text, value, rank, visitors, pageviews, visits, events
       FROM scf.web_daily_breakdowns WHERE site_id = $1 ORDER BY day, variant, dimension, rank`,
    [siteId],
  );
  return [t.rows, h.rows, b.rows];
}

beforeAll(async () => {
  su = superClient();
  db = jobsDb();
  ro = umamiRo();
  api = new UmamiApi();
  await api.login();
  site = await seedSite(su, { twin: true });
  other = await seedSite(su);
  await api.createWebsite(site.umamiId, "wsg main");
  await api.createWebsite(site.twinId as string, "wsg twin");
  await api.createWebsite(other.umamiId, "wsg other");
  await seedFixture();
});

afterAll(async () => {
  await su?.end();
  await db?.pool.end();
  await ro?.pool.end();
});

describe("web_rollup against Umami 3.5.0 (fixture day)", () => {
  it("live window before any rollup row: 1 day (no history, no hourly rows)", async () => {
    const n = await db.tx("web_rollup", site.tenantId, (tx) =>
      tx.one<{ n: number }>("SELECT scf.web_live_window_days($1, $2) AS n", [
        site.tenantId,
        site.siteId,
      ]),
    );
    expect(n.n).toBe(1);
  });

  it("rolls the day and every figure equals Umami's own answer", async () => {
    const cap = capture();
    const res = await runWebRollup(db, ro, cap.ctx(), "umami/3.5.0", {
      siteIds: [site.siteId, other.siteId],
      tasks: [{ day: DAY, final: true }],
    });
    expect(res).toMatchObject({ siteDays: 2, failed: 0 });

    const M = site.umamiId;
    const T = site.twinId as string;
    const [mAll, mV, tAll, tV] = await Promise.all([
      stats(M),
      stats(M, "v"),
      stats(T),
      stats(T, "v"),
    ]);
    // sanity: the fixture is what S-01 §4 describes (8+ page views, a custom-only visit that is not a visit, …)
    expect(mAll).toEqual({
      pageviews: 10,
      visitors: 5,
      visits: 6,
      bounces: 2,
      totaltime: 300 + 61 + 125,
    });
    const { rows } = await su.query(
      `SELECT * FROM scf.web_daily_totals WHERE tenant_id = $1 AND site_id = $2 AND day = $3::date`,
      [site.tenantId, site.siteId, DAY],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect({
      pageviews_raw: num(row.pageviews_raw),
      pageviews_verified: num(row.pageviews_verified),
      pageviews_unidentified_raw: num(row.pageviews_unidentified_raw),
      pageviews_unidentified_verified: num(row.pageviews_unidentified_verified),
      visitors_raw: num(row.visitors_raw),
      visitors_verified: num(row.visitors_verified),
      visits: num(row.visits),
      bounces: num(row.bounces),
      total_duration_s: num(row.total_duration_s),
      is_final: row.is_final,
      engine_version: row.engine_version,
    }).toEqual({
      pageviews_raw: mAll.pageviews + tAll.pageviews,
      pageviews_verified: mV.pageviews + tV.pageviews,
      pageviews_unidentified_raw: tAll.pageviews,
      pageviews_unidentified_verified: tV.pageviews,
      visitors_raw: mAll.visitors,
      visitors_verified: mV.visitors,
      // C-73: one figure each, from the UNFILTERED main-website call — never from tag=v, never adding the twin
      visits: mAll.visits,
      bounces: mAll.bounces,
      total_duration_s: mAll.totaltime,
      is_final: true,
      engine_version: "umami/3.5.0",
    });
    // C-73 distortion check: tag=v would have given different visit metrics; we did not use them
    expect(mV.totaltime).not.toBe(mAll.totaltime);
    // events_raw: every engine event of main + twin that day (13 main + 4 twin)
    expect(num(row.events_raw)).toBe(17);
  });

  it("breakdowns equal /metrics/expanded per dimension and variant (main + twin page views)", async () => {
    const M = site.umamiId;
    const T = site.twinId as string;
    const { rows } = await su.query(
      `SELECT variant::text, dimension::text, value, rank, visitors, pageviews, visits, events
         FROM scf.web_daily_breakdowns WHERE tenant_id = $1 AND site_id = $2 AND day = $3::date`,
      [site.tenantId, site.siteId, DAY],
    );
    for (const dim of DIMS) {
      for (const variant of ["raw", "verified"] as const) {
        const tag = variant === "verified" ? "v" : undefined;
        const [m, t] = await Promise.all([expanded(M, dim, tag), expanded(T, dim, tag)]);
        const want = new Map<
          string,
          { pageviews: number; visitors: number; visits: number | null }
        >();
        for (const name of new Set([...m.keys(), ...t.keys()])) {
          want.set(name, {
            pageviews: (m.get(name)?.pageviews ?? 0) + (t.get(name)?.pageviews ?? 0),
            visitors: m.get(name)?.visitors ?? 0,
            visits: variant === "raw" ? (m.get(name)?.visits ?? 0) : null,
          });
        }
        const got = new Map(
          rows
            .filter((r) => r.variant === variant && r.dimension === dim)
            .map((r) => [
              r.value as string,
              {
                pageviews: num(r.pageviews),
                visitors: num(r.visitors),
                visits: r.visits === null ? null : num(r.visits),
              },
            ]),
        );
        expect(got, `${dim}/${variant}`).toEqual(want);
        expect(want.size, `${dim}/${variant} non-empty`).toBeGreaterThan(0);
      }
    }
    // ranks: 1..n per (variant, dimension), ordered by visitors desc then value
    for (const variant of ["raw", "verified"]) {
      for (const dim of [...DIMS, "event"]) {
        const sel = rows
          .filter((r) => r.variant === variant && r.dimension === dim)
          .sort((a, b) => a.rank - b.rank);
        expect(sel.map((r) => r.rank)).toEqual(sel.map((_, i) => i + 1));
      }
    }
  });

  it("event breakdowns equal /metrics?type=event (main + twin), visitors from main", async () => {
    const M = site.umamiId;
    const T = site.twinId as string;
    const { rows } = await su.query(
      `SELECT variant::text, value, events, visitors, pageviews, visits FROM scf.web_daily_breakdowns
        WHERE site_id = $1 AND day = $2::date AND dimension = 'event'`,
      [site.siteId, DAY],
    );
    for (const variant of ["raw", "verified"] as const) {
      const tag = variant === "verified" ? "v" : undefined;
      const [m, t] = await Promise.all([eventMetrics(M, tag), eventMetrics(T, tag)]);
      const want = new Map<string, number>();
      for (const k of new Set([...m.keys(), ...t.keys()]))
        want.set(k, (m.get(k) ?? 0) + (t.get(k) ?? 0));
      const got = new Map(
        rows.filter((r) => r.variant === variant).map((r) => [r.value as string, num(r.events)]),
      );
      expect(got, variant).toEqual(want);
    }
    expect(rows.every((r) => r.pageviews === null && r.visits === null)).toBe(true);
  });

  it("hourly rows equal /pageviews?unit=hour (page views main + twin, sessions main)", async () => {
    const M = site.umamiId;
    const T = site.twinId as string;
    const { rows } = await su.query(
      `SELECT hour_start, pageviews_raw, pageviews_verified, visitors_raw, visitors_verified, events_raw,
              pageviews_unidentified_raw
         FROM scf.web_hourly_totals WHERE site_id = $1 AND hour_start >= $2 AND hour_start < $3`,
      [site.siteId, dayStart(DAY), dayStart(addDays(DAY, 1))],
    );
    for (const tag of [undefined, "v"] as const) {
      const [m, t] = await Promise.all([hourly(M, tag), hourly(T, tag)]);
      const pv = new Map<string, number>();
      for (const [k, v] of [...m.pv, ...t.pv]) if (v > 0) pv.set(k, (pv.get(k) ?? 0) + v);
      const sess = new Map([...m.sess].filter(([, v]) => v > 0));
      const gotPv = new Map(
        rows
          .map(
            (r) =>
              [
                (r.hour_start as Date).toISOString(),
                num(tag ? r.pageviews_verified : r.pageviews_raw),
              ] as const,
          )
          .filter(([, v]) => v > 0),
      );
      const gotSess = new Map(
        rows
          .map(
            (r) =>
              [
                (r.hour_start as Date).toISOString(),
                num(tag ? r.visitors_verified : r.visitors_raw),
              ] as const,
          )
          .filter(([, v]) => v > 0),
      );
      expect(gotPv, `pageviews ${tag ?? "raw"}`).toEqual(pv);
      expect(gotSess, `sessions ${tag ?? "raw"}`).toEqual(sess);
    }
    // the hours add up to the day
    const day = await su.query(
      `SELECT pageviews_raw, events_raw FROM scf.web_daily_totals WHERE site_id = $1 AND day = $2::date`,
      [site.siteId, DAY],
    );
    expect(rows.reduce((a, r) => a + num(r.pageviews_raw), 0)).toBe(num(day.rows[0].pageviews_raw));
    expect(rows.reduce((a, r) => a + num(r.events_raw), 0)).toBe(num(day.rows[0].events_raw));
  });

  it("keeps other sites apart: the other tenant's site has only its own event", async () => {
    const { rows } = await su.query(
      `SELECT tenant_id, pageviews_raw, visitors_raw, events_raw FROM scf.web_daily_totals
        WHERE site_id = $1 AND day = $2::date`,
      [other.siteId, DAY],
    );
    expect(rows).toEqual([
      { tenant_id: other.tenantId, pageviews_raw: "1", visitors_raw: "1", events_raw: "1" },
    ]);
  });

  it("is idempotent: a re-run produces exactly the same rows", async () => {
    const before = await tableRows(site.siteId);
    const cap = capture();
    await runWebRollup(db, ro, cap.ctx(), "umami/3.5.0", {
      siteIds: [site.siteId],
      tasks: [{ day: DAY, final: true }],
    });
    await runWebRollup(db, ro, cap.ctx(), "umami/3.5.0", {
      siteIds: [site.siteId],
      tasks: [{ day: DAY, final: true }],
    });
    expect(await tableRows(site.siteId)).toEqual(before);
  });

  it("re-rolling replaces rows whose source data disappeared (no stale breakdown rows)", async () => {
    // a stale row a previous run could have left behind
    await su.query(
      `INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews)
       VALUES ($1, $2, $3::date, 'raw', 'path', '/gone', 99, 1, 1)`,
      [site.tenantId, site.siteId, DAY],
    );
    const cap = capture();
    await runWebRollup(db, ro, cap.ctx(), "umami/3.5.0", {
      siteIds: [site.siteId],
      tasks: [{ day: DAY, final: true }],
    });
    const { rows } = await su.query(
      `SELECT 1 FROM scf.web_daily_breakdowns WHERE site_id = $1 AND value = '/gone'`,
      [site.siteId],
    );
    expect(rows).toHaveLength(0);
  });

  it("feeds the live window: today's hourly rows are the projection input of scf.web_live_window_days()", async () => {
    const n = await db.tx("web_rollup", site.tenantId, (tx) =>
      tx.one<{ n: number }>("SELECT scf.web_live_window_days($1, $2) AS n", [
        site.tenantId,
        site.siteId,
      ]),
    );
    // 17 events today at most projected to a day stay far below the 250,000 budget → the upper bound (90 days)
    expect(n.n).toBe(90);
  });

  it("writes nothing without the tenant context and reads Umami only through scf_ro", async () => {
    // the umami role sees the two views and nothing else (data-model §16.3)
    await expect(ro.query("SELECT count(*) FROM public.website_event")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      ro.query("SELECT url_query FROM scf_ro.website_event LIMIT 1"),
    ).rejects.toMatchObject({
      code: "42703",
    });
    // F1 / backstop: web_rollup cannot write under another context
    await expect(
      db.tx("web_rollup", null, (tx) =>
        tx.exec(
          `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
             pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits,
             bounces, total_duration_s, events_raw, is_final, engine_version)
           VALUES ($1, $2, '2020-01-01', 0,0,0,0,0,0,0,0,0,0, false, 'umami/3.5.0')`,
          [site.tenantId, site.siteId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.tx("web_rollup", other.tenantId, (tx) =>
        tx.exec("DELETE FROM scf.web_daily_totals WHERE site_id = $1", [site.siteId]),
      ),
    ).resolves.toBe(0);
  });

  it("logs carry no personal data", async () => {
    const cap = capture();
    await runWebRollup(db, ro, cap.ctx({ mode: "hourly" }), "umami/3.5.0", {
      siteIds: [site.siteId],
    });
    const text = cap.lines.join("\n");
    expect(text).not.toMatch(
      /2001:db8|Mozilla|news\.ycombinator|github\.com|\/pricing|wallet_selected/,
    );
    expect(cap.lines.length).toBeGreaterThan(0);
  });
});
