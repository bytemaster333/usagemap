// SPDX-License-Identifier: Apache-2.0
// The tenant web read path against the REAL engine: our Umami 3.5.0 image behind the real engine proxy (mutual TLS,
// reader certificate), a tenant provisioned through the adapter (P1–P7t), events sent as an edge (`POST /api/send`),
// and a 7-day range that spans the rollup part (rows written as the web_rollup job would) and the live part (Umami).
// Expected values are derived from the events below by the C-73 rules; Umami's answers are not echoed back.
//
// Engine stack: compose project `scf-wsf-engw` (override SCF_WSF_ENGW_PROJECT), host ports 56155/56156.

import { randomBytes } from "node:crypto";
import { UmamiProvisioner, UmamiReader } from "@usagemap/umami-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EngineStackInfo,
  type EngineTools,
  engineTools,
  startEngineStack,
} from "../../../../packages/umami-adapter/test/support/engine-stack.ts";
import { encryptCredential } from "../../src/umami/credentials.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const DAY = 86_400_000;
const KEY = randomBytes(32);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

let stack: { info: EngineStackInfo; stop: () => Promise<void> } | undefined;
let tools: EngineTools;
let h: Harness;
let cookie = "";
let tenant = "";
let site = "";
let today = 0;
let teamId = "";

// Rollup rows for the three days before today (as job web_rollup writes them).
const ROLLUP = {
  pv_v: 30,
  pv_r: 40,
  unid_v: 3,
  unid_r: 4,
  vis_v: 12,
  vis_r: 15,
  visits: 20,
  bounces: 8,
  dur: 1200,
};

beforeAll(async () => {
  stack = await startEngineStack({
    project: process.env.SCF_WSF_ENGW_PROJECT ?? "scf-wsf-engw",
    proxyPort: Number(process.env.SCF_WSF_ENGW_PROXY_PORT ?? 56155),
    metricsPort: Number(process.env.SCF_WSF_ENGW_METRICS_PORT ?? 56156),
  });
  tools = engineTools(stack.info);
  const reader = new UmamiReader({
    baseUrl: stack.info.proxyUrl,
    tls: { ...stack.info.reader, ca: stack.info.ca },
    timeoutMs: 5000,
  });
  h = await startHarness({ SCF_UMAMI_CREDS_KEYS: `1:${KEY.toString("base64")}` }, { reader });
  today = Math.floor(Date.now() / DAY) * DAY;
  cookie = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, cookie);
  site = (
    await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/sites`,
      cookie,
      body: { name: "Engine", visitor_id: "off" },
    })
  ).json().site_id;
  await call(h, {
    method: "PUT",
    url: `/v1/tenants/${tenant}/sites/${site}/anonymous-reports`,
    cookie,
    body: { anonymous_reports: false },
  });
  const ids = (
    await h.su.query(
      `UPDATE scf.sites SET twin_provisioned_at = now() WHERE site_id = $1
        RETURNING umami_website_id::text AS m, umami_twin_website_id::text AS t`,
      [site],
    )
  ).rows[0] as { m: string; t: string };

  // Provisioning through the adapter and the proxy (P1–P7t), credentials stored encrypted (C-85).
  const prov = new UmamiProvisioner(tools.client("provisioner"));
  const admin = await tools.adminToken();
  const ident = await prov.provisionTenant(admin, tenant);
  teamId = ident.teamId;
  for (const [id, name] of [
    [ids.m, site],
    [ids.t, `${site}/twin`],
  ] as const)
    await prov.createWebsite(admin, { id, name, domain: "app.example.org", teamId: ident.teamId });
  const keys = { keys: new Map([[1, KEY]]), current: 1 };
  await h.su.query(
    `INSERT INTO scf.umami_credentials (tenant_id, umami_team_id, umami_user_id, umami_username, umami_api_key_id,
       api_key_ciphertext, password_ciphertext, key_version) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
    [
      tenant,
      ident.teamId,
      ident.userId,
      ident.username,
      ident.apiKeyId,
      encryptCredential(keys, tenant, "api_key", ident.apiKey).ciphertext,
      encryptCredential(keys, tenant, "password", ident.password).ciphertext,
    ],
  );

  // Today's events (live part): visitor A two verified page views 60 s apart and a custom event (one visit, 60 s);
  // B one suspect page view (bounce); C one verified page view from FR (bounce); one verified page view without an
  // identifier (twin website).
  const base = Math.max(Date.now() - 10 * 60_000, today + 1000);
  const send = async (website: string, ev: Parameters<EngineTools["sendEvent"]>[1]) =>
    expect(await tools.sendEvent(website, ev)).toBe(200);
  await send(ids.m, { tag: "v", ts: base, surrogate: "2001:db8::a", url: "/", country: "DE" });
  await send(ids.m, {
    tag: "v",
    ts: base + 60_000,
    surrogate: "2001:db8::a",
    url: "/docs",
    country: "DE",
  });
  await send(ids.m, {
    tag: "v",
    ts: base + 70_000,
    surrogate: "2001:db8::a",
    url: "/docs",
    name: "signup",
    country: "DE",
  });
  await send(ids.m, {
    tag: "s",
    ts: base + 90_000,
    surrogate: "2001:db8::b",
    url: "/",
    country: "DE",
  });
  await send(ids.m, {
    tag: "v",
    ts: base + 120_000,
    surrogate: "2001:db8::c",
    url: "/",
    country: "FR",
  });
  await send(ids.t, {
    tag: "v",
    ts: base + 150_000,
    surrogate: "2001:db8::d",
    url: "/",
    country: "DE",
    visit: "none",
  });

  // Rollup part: three closed days; 500k engine events per day keeps the live window at 1 day (today).
  for (let d = today - 3 * DAY; d < today; d += DAY) {
    await h.su.query(
      `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
         pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces,
         total_duration_s, events_raw, is_final, engine_version)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, 500000, true, 'umami/3.5.0')`,
      [
        tenant,
        site,
        new Date(d).toISOString().slice(0, 10),
        ROLLUP.pv_v,
        ROLLUP.pv_r,
        ROLLUP.unid_v,
        ROLLUP.unid_r,
        ROLLUP.vis_v,
        ROLLUP.vis_r,
        ROLLUP.visits,
        ROLLUP.bounces,
        ROLLUP.dur,
      ],
    );
    for (const variant of ["verified", "raw"])
      await h.su.query(
        `INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews, visits)
         VALUES ($1, $2, $3::date, $4::scf.web_variant, 'country', 'DE', 1, 5, 9, $5)`,
        [
          tenant,
          site,
          new Date(d).toISOString().slice(0, 10),
          variant,
          variant === "raw" ? 5 : null,
        ],
      );
  }
}, 300_000);

afterAll(async () => {
  await h?.close();
  await stack?.stop();
});

describe("web read path against Umami 3.5.0 behind the engine proxy", () => {
  it("stats: rollup days + live today, by the C-73 rules (source mixed)", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/stats?range=7d`,
      cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.range).toMatchObject({
      source: "mixed",
      live_start: iso(today),
      partial_today: false,
    });
    // live: verified page views A 2 + C 1 + twin 1 = 4; raw 4 + B 1 = 5; visitors verified A, C; raw A, B, C
    expect(b.verified).toEqual({
      pageviews: 3 * 30 + 4,
      pageviews_unidentified: 3 * 3 + 1,
      visitors: 3 * 12 + 2,
    });
    expect(b.raw).toEqual({
      pageviews: 3 * 40 + 5,
      pageviews_unidentified: 3 * 4 + 1,
      visitors: 3 * 15 + 3,
    });
    // one visit figure over all identified events: A (2 page views, 60 s), B (bounce), C (bounce)
    expect(b.visit_metrics).toMatchObject({
      visits: 3 * 20 + 3,
      bounces: 3 * 8 + 2,
      avg_visit_duration_s: Math.round(((3 * 1200 + 60) / 63) * 10) / 10,
    });
  });

  it("timeseries: today's daily bucket comes from the engine's R2 answer", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/timeseries?range=7d&unit=day`,
      cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json().verified as Array<{ t: string; pageviews: number; visitors: number }>;
    expect(v.at(-1)).toEqual({ t: iso(today), pageviews: 4, visitors: 2 });
    expect(v.at(-2)).toEqual({ t: iso(today - DAY), pageviews: 30, visitors: 12 });
    expect(v.slice(0, 3).every((p) => p.pageviews === 0)).toBe(true);
  });

  it("breakdown by country and by event (anonymous reports off: exact)", async () => {
    const country = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/sites/${site}/web/breakdown?range=7d&dimension=country&variant=raw`,
        cookie,
      })
    ).json();
    // raw DE: rollup 3 × (5 visitors, 9 page views) + live A, B (+ twin page view); FR: C
    expect(
      country.raw.map((r: { value: string; visitors: number; pageviews: number }) => [
        r.value,
        r.visitors,
        r.pageviews,
      ]),
    ).toEqual([
      ["DE", 15 + 2, 27 + 3 + 1],
      ["FR", 1, 1],
    ]);
    const events = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/sites/${site}/web/breakdown?range=24h&dimension=event&variant=verified`,
        cookie,
      })
    ).json();
    expect(events.verified).toEqual([
      {
        value: "signup",
        is_other: false,
        visitors: null,
        pageviews: null,
        events: 1,
        share_pct: 100,
      },
    ]);
  });
});

describe("web reports (funnel, goals, journey) against Umami 3.5.0 behind the engine proxy (§j.3 R6–R8)", () => {
  // A second site of the same tenant, anonymous reports off. Today: J1–J10 visit / then /pricing; K visits /, /pricing
  // and signs up; L visits / only.
  let rsite = "";
  beforeAll(async () => {
    rsite = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${tenant}/sites`,
        cookie,
        body: { name: "Reports", visitor_id: "off" },
      })
    ).json().site_id;
    await call(h, {
      method: "PUT",
      url: `/v1/tenants/${tenant}/sites/${rsite}/anonymous-reports`,
      cookie,
      body: { anonymous_reports: false },
    });
    const m = (
      await h.su.query(`SELECT umami_website_id::text AS m FROM scf.sites WHERE site_id = $1`, [
        rsite,
      ])
    ).rows[0].m as string;
    const prov = new UmamiProvisioner(tools.client("provisioner"));
    await prov.createWebsite(await tools.adminToken(), {
      id: m,
      name: rsite,
      domain: "app.example.org",
      teamId,
    });
    const base = Math.max(Date.now() - 10 * 60_000, today + 1000);
    const pv = async (who: string, dt: number, url: string, name?: string) =>
      expect(
        await tools.sendEvent(m, {
          tag: "v",
          ts: base + dt,
          surrogate: `2001:db8:7::${who}`,
          url,
          ...(name ? { name } : {}),
        }),
      ).toBe(200);
    for (let i = 1; i <= 10; i++) {
      await pv(`a${i}`, i * 1000, "/");
      await pv(`a${i}`, i * 1000 + 30_000, "/pricing");
    }
    await pv("b", 60_000, "/");
    await pv("b", 70_000, "/pricing");
    await pv("b", 80_000, "/pricing", "signup");
    await pv("c", 90_000, "/");
  }, 120_000);

  const rep = (kind: string, q: string) =>
    call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${rsite}/web/reports/${kind}?${q}`,
      cookie,
    });

  it("funnel: visitors per step in order", async () => {
    const res = await rep("funnel", "range=24h&step=path:/&step=path:/pricing&step=event:signup");
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.range).toMatchObject({ source: "live", truncated: false, anonymized: false });
    expect(b.steps.map((s: { visitors: number }) => s.visitors)).toEqual([12, 11, 1]);
    expect(b.steps.map((s: { conversion_pct: number }) => s.conversion_pct)).toEqual([
      100, 91.7, 8.3,
    ]);
  });

  it("goals: visitors reaching a path or an event of all visitors", async () => {
    const res = await rep("goals", "range=7d&goal=path:/pricing&goal=event:signup&variant=raw");
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.total_visitors).toBe(12);
    expect(b.goals.map((g: { visitors: number }) => g.visitors)).toEqual([11, 1]);
    // the site's live window is today only: the rest of the 7 days is left out, not guessed
    expect(b.range).toMatchObject({ truncated: true, covered_start: iso(today) });
  });

  it("journey: the frequent sequence is shown, rare ones only counted (minimum count 10)", async () => {
    const res = await rep("journey", "range=24h&steps=3");
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.journeys).toEqual([
      {
        items: [
          { type: "path", value: "/" },
          { type: "path", value: "/pricing" },
        ],
        visits: 10,
      },
    ]);
    expect(b).toMatchObject({ min_count: 10, other_visits: 2, suppressed_journeys: 2 });
    expect(JSON.stringify(b)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("with anonymous reports the funnel's small steps are suppressed", async () => {
    await call(h, {
      method: "PUT",
      url: `/v1/tenants/${tenant}/sites/${rsite}/anonymous-reports`,
      cookie,
      body: { anonymous_reports: true },
    });
    const res = await rep("funnel", "range=24h&step=path:/&step=path:/pricing&step=event:signup");
    expect(res.json().steps.map((s: { visitors: number | null }) => s.visitors)).toEqual([
      10,
      10,
      null,
    ]);
  });
});
