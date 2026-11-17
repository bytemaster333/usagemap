// SPDX-License-Identifier: Apache-2.0
// Tenant web reports (funnel, goals, journey; wire-formats §j.3 R6–R8) through the HTTP API on the real database, with a
// scripted engine: the live-window rule (C-109: the part of a range before the window is left out, a range wholly
// before it is 400), 503 when the engine cannot answer (no rollup), step validation after the site check (C-87),
// the C-51 floor for funnels and goals and the unconditional floor for journeys. Every response is validated against
// the OpenAPI document by `call()`. The same reports against the real Umami: web-engine.test.ts.

import { randomBytes, randomUUID } from "node:crypto";
import {
  type FunnelStepResult,
  type GoalResult,
  type JourneyOptions,
  type JourneyRow,
  type Range,
  type ReportStep,
  UmamiUnavailableError,
  type Variant,
} from "@usagemap/umami-adapter";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptCredential } from "../../src/umami/credentials.ts";
import type { ReportReader } from "../../src/web/reports.ts";
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
const API_KEY = `umami_${"b".repeat(32)}`;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const dstr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Seen {
  fn: string;
  key: string;
  website: string;
  range: Range;
  variant: Variant;
  arg: unknown;
}

class FakeReports implements ReportReader {
  seen: Seen[] = [];
  fail = false;
  funnelVisitors = [120, 54, 4];
  goals: Record<string, GoalResult> = {};
  journeys: JourneyRow[] = [];
  #record(fn: string, key: string, website: string, range: Range, variant: Variant, arg: unknown) {
    this.seen.push({ fn, key, website, range, variant, arg });
    if (this.fail) throw new UmamiUnavailableError("GET", "/api/websites/{websiteId}/x", "timeout");
  }
  async funnel(
    key: string,
    website: string,
    range: Range,
    steps: readonly ReportStep[],
    windowMinutes: number,
    variant: Variant,
  ): Promise<FunnelStepResult[]> {
    this.#record("funnel", key, website, range, variant, { steps, windowMinutes });
    return steps.map((s, i) => ({ ...s, visitors: this.funnelVisitors[i] ?? 0 }));
  }
  async goal(
    key: string,
    website: string,
    range: Range,
    goal: ReportStep,
    variant: Variant,
  ): Promise<GoalResult> {
    this.#record("goal", key, website, range, variant, goal);
    return this.goals[`${goal.type}:${goal.value}`] ?? { visitors: 0, total: 0 };
  }
  async journey(
    key: string,
    website: string,
    range: Range,
    opts: JourneyOptions,
    variant: Variant,
  ): Promise<JourneyRow[]> {
    this.#record("journey", key, website, range, variant, opts);
    return this.journeys;
  }
}

const engine = new FakeReports();
let h: Harness;
let cookie = "";
let viewerCookie = "";
let tenant = "";
let site = "";
let otherSite = "";
let main = "";
let today = 0;

async function insertDaily(t: string, s: string, day: number) {
  await h.su.query(
    `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
       pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces,
       total_duration_s, events_raw, is_final, engine_version)
     VALUES ($1, $2, $3::date, 1, 1, 0, 0, 1, 1, 1, 1, 0, 50000, $4, 'umami/3.5.0')`,
    [t, s, dstr(day), day < today],
  );
}

beforeAll(async () => {
  h = await startHarness(
    { SCF_UMAMI_CREDS_KEYS: `1:${KEY.toString("base64")}` },
    { reports: engine },
  );
  today = Math.floor(Date.now() / DAY) * DAY;
  cookie = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, cookie);
  const mk = async (name: string) =>
    (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${tenant}/sites`,
        cookie,
        body: { name, visitor_id: "off" },
      })
    ).json().site_id as string;
  site = await mk("Reports");
  otherSite = await mk("Reports, other");
  main = (
    await h.su.query(`SELECT umami_website_id::text AS m FROM scf.sites WHERE site_id = $1`, [site])
  ).rows[0].m;
  const keys = { keys: new Map([[1, KEY]]), current: 1 };
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
      encryptCredential(keys, tenant, "api_key", API_KEY).ciphertext,
      encryptCredential(keys, tenant, "password", "pw").ciphertext,
    ],
  );
  // 40 closed days at 50,000 engine events each → live window floor(250,000 / 50,000) = 5 days (C-109).
  for (let d = today - 40 * DAY; d <= today; d += DAY) await insertDaily(tenant, site, d);
  const live = await h.su.query(`SELECT scf.web_live_window_days($1, $2) AS l`, [tenant, site]);
  expect(Number(live.rows[0].l)).toBe(5);
  // a viewer (the operations' minimum role)
  const inv = (
    await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/invitations`,
      cookie,
      body: { role: "viewer" },
    })
  ).json();
  viewerCookie = await signInGithub(h, newGithubUser());
  await call(h, {
    method: "POST",
    url: "/v1/invitations/accept",
    cookie: viewerCookie,
    body: { code: inv.code },
  });
});
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  engine.seen = [];
  engine.fail = false;
});

const anonymous = (on: boolean) =>
  call(h, {
    method: "PUT",
    url: `/v1/tenants/${tenant}/sites/${site}/anonymous-reports`,
    cookie,
    body: { anonymous_reports: on },
  });
const report = (kind: string, q: string, c = cookie, s = site) =>
  call(h, {
    method: "GET",
    url: `/v1/tenants/${tenant}/sites/${s}/web/reports/${kind}?${q}`,
    cookie: c,
  });
const FUNNEL_Q = "step=path:/&step=path:/pricing/&step=event:signup";

describe("funnel report", () => {
  it("covers the live window of a longer range, with the tenant key on the main website (exact counts)", async () => {
    await anonymous(false);
    const res = await report("funnel", `range=30d&${FUNNEL_Q}&window=30`, viewerCookie);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    const b0 = today - 4 * DAY;
    expect(b.range).toEqual({
      start: iso(today - 29 * DAY),
      end: iso(today + DAY),
      covered_start: iso(b0),
      truncated: true,
      source: "live",
      timezone: "UTC",
      anonymized: false,
    });
    expect(b.variant).toBe("verified");
    expect(b.window_minutes).toBe(30);
    expect(b.steps).toEqual([
      {
        type: "path",
        value: "/",
        visitors: 120,
        conversion_pct: 100,
        step_conversion_pct: null,
        suppressed: false,
      },
      {
        type: "path",
        value: "/pricing",
        visitors: 54,
        conversion_pct: 45,
        step_conversion_pct: 45,
        suppressed: false,
      },
      {
        type: "event",
        value: "signup",
        visitors: 4,
        conversion_pct: 3.3,
        step_conversion_pct: 7.4,
        suppressed: false,
      },
    ]);
    expect(engine.seen).toEqual([
      {
        fn: "funnel",
        key: API_KEY,
        website: main,
        range: { start: b0, end: today + DAY },
        variant: "verified",
        arg: {
          steps: [
            { type: "path", value: "/" },
            { type: "path", value: "/pricing" },
            { type: "event", value: "signup" },
          ],
          windowMinutes: 30,
        },
      },
    ]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("with anonymous reports (C-51) small steps are null and the rest rounded", async () => {
    await anonymous(true);
    const res = await report("funnel", `range=7d&${FUNNEL_Q}&variant=raw`);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.range.anonymized).toBe(true);
    expect(b.variant).toBe("raw");
    expect(b.window_minutes).toBe(60);
    expect(b.steps.map((s: { visitors: number | null }) => s.visitors)).toEqual([120, 50, null]);
    expect(b.steps.map((s: { suppressed: boolean }) => s.suppressed)).toEqual([false, false, true]);
    expect(engine.seen[0]?.variant).toBe("raw");
  });

  it("a range wholly before the live window is 400 naming the window's start; nothing is asked", async () => {
    const start = iso(today - 20 * DAY);
    const end = iso(today - 19 * DAY);
    const res = await report("funnel", `range=custom&start=${start}&end=${end}&${FUNNEL_Q}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([
      {
        pointer: "/start",
        detail: expect.stringContaining(iso(today - 4 * DAY)),
      },
    ]);
    expect(engine.seen).toEqual([]);
  });

  it("validates steps after the site: bounded count, no query strings, no Stellar addresses", async () => {
    const cases: Array<[string, string]> = [
      ["step=path:/", "/step"],
      [Array.from({ length: 9 }, () => "step=path:/").join("&"), "/step"],
      ["step=path:/&step=path:/pricing%3Futm_source%3Dx", "/step/1"],
      [`step=path:/&step=path:/account/G${"A".repeat(55)}`, "/step/1"],
      ["step=path:/&step=signup", "/step/1"],
      ["step=path:/&step=event:sign%20up", "/step/1"],
    ];
    for (const [q, pointer] of cases) {
      const res = await report("funnel", `range=7d&${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().errors[0].pointer, q).toBe(pointer);
    }
    const w = await report("funnel", `range=7d&${FUNNEL_Q}&window=1441`);
    expect(w.statusCode).toBe(400);
    expect(engine.seen).toEqual([]);
    // an unknown site is 404 even with invalid steps (C-87)
    const nf = await report("funnel", "range=7d&step=x", cookie, randomUUID());
    expect(nf.statusCode).toBe(404);
  });

  it("answers 503 with Retry-After when the engine does not answer (reports have no rollup)", async () => {
    engine.fail = true;
    const res = await report("funnel", `range=24h&${FUNNEL_Q}`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("unavailable");
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body).not.toMatch(/umami_|websites\//);
  });

  it("answers 503 for a tenant whose engine credentials are not provisioned yet", async () => {
    const c2 = await signInGithub(h, newGithubUser());
    const t2 = await createTenant(h, c2);
    const s2 = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t2}/sites`,
        cookie: c2,
        body: { name: "No engine" },
      })
    ).json().site_id;
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t2}/sites/${s2}/web/reports/funnel?${FUNNEL_Q}`,
      cookie: c2,
    });
    expect(res.statusCode).toBe(503);
    expect(engine.seen).toEqual([]);
  });
});

describe("goals report", () => {
  it("one engine call per goal; shares of all visitors in the range", async () => {
    await anonymous(false);
    engine.goals = {
      "path:/pricing": { visitors: 30, total: 120 },
      "event:signup": { visitors: 3, total: 120 },
    };
    const res = await report("goals", "range=24h&goal=path:/pricing&goal=event:signup");
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.range.truncated).toBe(false);
    expect(b.total_visitors).toBe(120);
    expect(b.goals).toEqual([
      { type: "path", value: "/pricing", visitors: 30, conversion_pct: 25, suppressed: false },
      { type: "event", value: "signup", visitors: 3, conversion_pct: 2.5, suppressed: false },
    ]);
    expect(engine.seen.map((s) => [s.fn, s.website, s.arg])).toEqual([
      ["goal", main, { type: "path", value: "/pricing" }],
      ["goal", main, { type: "event", value: "signup" }],
    ]);
    // a single goal is an array of one; more than five is refused
    expect((await report("goals", "goal=path:/")).statusCode).toBe(200);
    const six = Array.from({ length: 6 }, (_, i) => `goal=path:/g${i}`).join("&");
    expect((await report("goals", six)).statusCode).toBe(400);
  });

  it("with anonymous reports small goals are suppressed", async () => {
    await anonymous(true);
    const res = await report("goals", "range=24h&goal=path:/pricing&goal=event:signup");
    const b = res.json();
    expect(b.total_visitors).toBe(120);
    expect(b.goals.map((g: { visitors: number | null }) => g.visitors)).toEqual([30, null]);
  });
});

describe("journey report", () => {
  it("always floors sequences below the minimum count, also without anonymous reports", async () => {
    await anonymous(false);
    engine.journeys = [
      { items: ["/", "/pricing", "signup"], count: 42 },
      { items: ["/", "/docs"], count: 10 },
      { items: ["/blog/{slug}"], count: 9 },
      { items: ["/", "wallet_connected"], count: 1 },
    ];
    const res = await report("journey", "range=7d&steps=3&start_step=path:/&end_step=event:signup");
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.steps).toBe(3);
    expect(b.min_count).toBe(10);
    expect(b.journeys).toEqual([
      {
        items: [
          { type: "path", value: "/" },
          { type: "path", value: "/pricing" },
          { type: "event", value: "signup" },
        ],
        visits: 42,
      },
      {
        items: [
          { type: "path", value: "/" },
          { type: "path", value: "/docs" },
        ],
        visits: 10,
      },
    ]);
    expect(b.other_visits).toBe(10);
    expect(b.suppressed_journeys).toBe(2);
    expect(engine.seen[0]?.arg).toEqual({ steps: 3, startStep: "/", endStep: "signup" });
  });

  it("defaults to 4 steps, refuses 8 and a malformed start step", async () => {
    engine.journeys = [];
    const d = await report("journey", "range=24h");
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ steps: 4, journeys: [], other_visits: 0 });
    expect((await report("journey", "steps=8")).statusCode).toBe(400);
    const s = await report("journey", "start_step=/pricing");
    expect(s.statusCode).toBe(400);
    expect(s.json().errors[0].pointer).toBe("/start_step");
  });

  it("another site of the same tenant reads its own main website", async () => {
    engine.journeys = [];
    expect((await report("journey", "range=24h", cookie, otherSite)).statusCode).toBe(200);
    expect(engine.seen[0]?.website).not.toBe(main);
  });
});
