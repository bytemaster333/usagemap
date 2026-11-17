// SPDX-License-Identifier: Apache-2.0
// Gate G2 — e2e web suite. Real browsers (Chromium desktop, Chromium with an Android phone profile) load a tenant page that
// embeds the SRI-pinned tracker served by the gateway; events go tracker → gateway (challenge, proof, verdict, spool)
// → engine proxy → Umami; the jobs service rolls the day up; the control-plane API and the portal dashboard show the
// seven web metrics. Every expected value is fixed by the script below, not read back from the system:
//
//   visitor A  Chromium/Windows  /landing?…#… (referrer news.example.org) → SPA /pricing      2 pv, 1 visit
//   visitor B  Chromium/Android  /landing                                                      1 pv, bounce
//   visitor C  Chromium/macOS    /docs → custom event "signup" → SPA /docs/intro               2 pv + 1 event
//   scripted S1  curl, no challenge, 3 page views                                → rejected (never stored)
//   scripted S2  Firefox UA, valid challenge + proof, but no Sec-Fetch-*/Accept-Language → suspect (raw only), bounce
//
//   verified: 5 page views, 3 visitors · raw: 6 page views, 4 visitors · visits 4 · bounces 2 (50 %)
//   referrers (verified): news.example.org 1 · devices: 1 mobile · browsers: chrome 3 verified, + firefox 1 raw
//   pages (verified): /landing 2, /pricing 1, /docs 1, /docs/intro 1 · events: signup 1 · countries: XX (see below)
//
// WebKit is not used: its engine needs system libraries this host lacks (Playwright's `install --with-deps` adds them); the request headers a WebKit build sends are covered by the gateway's own header tests.
// Country: the test traffic comes from the Docker host's bridge address (private), which has no country in DB-IP,
// so every event is `XX`. Country resolution itself is covered by the gateway's geo test against the real DB-IP file.

import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  context,
  type IngestProxy,
  launch,
  serveSite,
  sitePage,
  startIngestProxy,
  type TrackerRef,
} from "../../lib/browser.ts";
import { Compose } from "../../lib/compose.ts";
import { reasonCount } from "../../lib/cp-client.ts";
import { loadEnv } from "../../lib/env.ts";
import {
  createFixture,
  eventually,
  type Fixture,
  gatewayTarget,
  waitForGateway,
} from "../../lib/fixture.ts";
import { requires } from "../../lib/gate.ts";
import {
  browserHeaders,
  CHROME_UA,
  curlHeaders,
  GatewayClient,
  solvePow,
} from "../../lib/gateway-client.ts";
import { insecureGet } from "../../lib/http.ts";
import { Recorder } from "../../lib/recorder.ts";

const env = loadEnv();
const compose = new Compose(env);
const rec = new Recorder(
  env,
  "e2e-web",
  "web",
  "E2E web suite: tracker → gateway → engine proxy → Umami → rollup → API → portal",
  "Real Chromium browsers (desktop profiles and an Android phone profile) load a tenant page with the SRI-pinned tracker from the gateway; two scripted clients send traffic without a challenge and with inconsistent headers. Expected values are fixed by the script (see the test file header) and compared with the control-plane API, the jobs rollup and the portal dashboard.",
);

const EXPECT = {
  verified: { pageviews: 5, visitors: 3 },
  raw: { pageviews: 6, visitors: 4 },
  visits: 4,
  bounces: 2,
  events: { verified: 6, suspect: 1, rejected: 3 }, // page views and the custom event
};

let fx: Fixture | undefined;
let proxy: IngestProxy | undefined;
let tracker: TrackerRef | undefined;
/** Receipt times (ms) of the page views of visitors A and C, for the duration check. */
const times: Record<string, number[]> = { A: [], C: [] };
let ready = false;

const site = () => {
  const s = fx?.sites.web;
  if (!s) throw new Error("fixture missing");
  return s;
};

beforeAll(async () => {
  // The gate decides per test; set up only when the stack is there.
  try {
    const h = await insecureGet(`${env.gatewayMetricsUrl}/healthz`, 3000);
    const c = await insecureGet(`${env.controlPlaneUrl}/healthz`, 3000);
    if (h.status !== 200 || c.status !== 200) return;
  } catch {
    return;
  }
  fx = await createFixture(env, compose, `wsl-web-${Date.now().toString(36)}`, [
    { key: "web", host: "shop.wsl.test", anonymousReports: false },
  ]);
  await waitForGateway(env, compose, [site()]);
  const gw = new URL(env.gatewayUrl);
  proxy = await startIngestProxy(env.ingestHosts, gw.hostname, Number(gw.port));
  const m = JSON.parse((await insecureGet(`${env.gatewayUrl}/lib/manifest.json`)).body) as {
    versions: { version: string; files: { path: string; integrity: string }[] }[];
  };
  // the newest released version (the manifest lists them in directory order, oldest first)
  const semver = (x: string) => x.split(".").map(Number) as [number, number, number];
  const v = [...m.versions].sort((a, b) => {
    const [x, y] = [semver(a.version), semver(b.version)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  })[0];
  const f = v?.files.find((x) => x.path === "standard.js");
  if (!v || !f) throw new Error("manifest has no standard.js");
  tracker = {
    version: v.version,
    integrity: f.integrity,
    src: `https://${env.ingestHosts[0]}/lib/${v.version}/standard.js`,
  };
  ready = true;
}, 240_000);

afterAll(async () => {
  await proxy?.close();
  rec.data.expected = EXPECT;
  const out = rec.write();
  if (out) console.log(`evidence: ${out.md}`);
});

const pageFor = (title: string) => (_path: string) =>
  sitePage({ tracker: tracker as TrackerRef, siteKey: site().site_key, title });

async function waitAccepted(page: import("@playwright/test").Page, n = 1): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    await page.waitForResponse((r) => r.url().endsWith("/v1/e") && r.status() === 202, {
      timeout: 20_000,
    });
    out.push(Date.now());
  }
  return out;
}

describe("e2e web (G2)", () => {
  it("visitor A: Chromium desktop, landing with referrer, query and fragment, then an SPA navigation", async (ctx) => {
    rec.start(ctx, ["metric.pageviews", "metric.referrers", "metric.session-duration"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    expect(ready).toBe(true);
    const b = await launch("chromium", (proxy as IngestProxy).url);
    try {
      const major = b.version().split(".")[0];
      const c = await context(b, {
        userAgent: CHROME_UA(Number(major), "Windows NT 10.0; Win64; x64"),
        viewport: { width: 1366, height: 768 },
      });
      const page = await c.newPage();
      await serveSite(page, site().origin, pageFor("Shop A"));
      const first = waitAccepted(page);
      await page.goto(`${site().origin}/landing?utm_source=wsl#section`, {
        referer: "https://news.example.org/article/42",
      });
      times.A?.push(...(await first));
      await page.waitForTimeout(2500);
      await page.locator("#nav").evaluate((a) => {
        (a as HTMLElement).dataset.to = "/pricing";
      });
      const second = waitAccepted(page);
      await page.click("#nav");
      times.A?.push(...(await second));
    } finally {
      await b.close();
    }
  }, 90_000);

  it("visitor B: Chromium with an Android phone profile, one page view (a bounce)", async (ctx) => {
    rec.start(ctx, ["metric.pageviews", "metric.bounce-rate", "metric.device", "metric.browser"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const { devices } = await import("@playwright/test");
    const b = await launch("chromium", (proxy as IngestProxy).url);
    try {
      const c = await context(b, { ...devices["Pixel 7"] });
      const page = await c.newPage();
      await serveSite(page, site().origin, pageFor("Shop B"));
      const first = waitAccepted(page);
      await page.goto(`${site().origin}/landing`);
      await first;
    } finally {
      await b.close();
    }
  }, 90_000);

  it("visitor C: Chromium macOS, page view, custom event, SPA navigation", async (ctx) => {
    rec.start(ctx, ["metric.pageviews", "metric.session-duration", "metric.bounce-rate"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const b = await launch("chromium", (proxy as IngestProxy).url);
    try {
      const major = b.version().split(".")[0];
      const c = await context(b, {
        userAgent: CHROME_UA(Number(major), "Macintosh; Intel Mac OS X 10_15_7"),
        viewport: { width: 1440, height: 900 },
      });
      const page = await c.newPage();
      await serveSite(page, site().origin, pageFor("Docs C"));
      const first = waitAccepted(page);
      await page.goto(`${site().origin}/docs`);
      times.C?.push(...(await first));
      const ev = waitAccepted(page);
      await page.click("#signup");
      await ev;
      expect(
        await page.evaluate(() => (window as unknown as { __tracked: boolean }).__tracked),
      ).toBe(true);
      await page.waitForTimeout(2000);
      await page.locator("#nav").evaluate((a) => {
        (a as HTMLElement).dataset.to = "/docs/intro";
      });
      const second = waitAccepted(page);
      await page.click("#nav");
      times.C?.push(...(await second));
    } finally {
      await b.close();
    }
  }, 90_000);

  it("scripted S1: POST without a challenge is answered 202 (no oracle) and never counted", async (ctx) => {
    rec.start(ctx, ["web.frontend-origin-only", "bot.js-execution-proof"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const gw = new GatewayClient(gatewayTarget(env), curlHeaders());
    for (const u of ["/landing", "/pricing", "/docs"]) {
      const r = await gw.send({ site: site().site_key, events: [{ k: "pv", u }] });
      expect(r.status).toBe(202);
    }
  });

  it("scripted S2: valid challenge and proof but headers no browser sends → suspect, raw only", async (ctx) => {
    rec.start(ctx, ["web.frontend-origin-only", "bot.js-execution-proof"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const h = browserHeaders(
      site().origin,
      "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    );
    delete h["sec-fetch-mode"];
    delete h["sec-fetch-site"];
    delete h["sec-fetch-dest"];
    delete h["accept-language"];
    const gw = new GatewayClient(gatewayTarget(env), h);
    const ch = await gw.challenge(site().site_key);
    expect(ch.status).toBe(200);
    const c = await solvePow(ch.token as string);
    const r = await gw.send({
      site: site().site_key,
      token: ch.token,
      c,
      sg: { wd: 0, vis: "v", act: 1 },
      events: [{ k: "pv", u: "/landing", w: "l", l: "en" }],
    });
    expect(r.status).toBe(202);
  }, 60_000);

  it("installation check: verdict counters — browsers verified, S1 rejected (challenge_missing), S2 suspect", async (ctx) => {
    const d = rec.start(ctx, [
      "web.frontend-origin-only",
      "bot.js-execution-proof",
      "bot.engine-bot-detection",
      "tracker.intentional-upgrade",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const f = fx as Fixture;
    const chk = await eventually(
      "installation check",
      () => f.cp.installation(f.tenantId, site().site_id),
      (c) =>
        c.verdicts.verified >= EXPECT.events.verified &&
        c.verdicts.rejected >= EXPECT.events.rejected &&
        c.verdicts.suspect >= EXPECT.events.suspect,
      60_000,
      2000,
    );
    rec.data.installation = chk;
    d.detail(`verdicts ${JSON.stringify(chk.verdicts)}`);
    expect(chk.verdicts).toEqual(EXPECT.events);
    expect(reasonCount(chk, "challenge_missing")).toBe(3);
    // curl's POST also has no Origin and a User-Agent on Umami's isbot list: all reasons are counted (§h.1)
    expect(reasonCount(chk, "ua_bot")).toBe(3);
    expect(reasonCount(chk, "origin_missing")).toBe(3);
    expect(reasonCount(chk, "header_inconsistent")).toBe(1);
    // C-129 (tracker.intentional-upgrade): the gateway counts the tracker version of every accepted event; every browser and script here
    // sends tv 1.2.0, the newest active release of the stack (1.0.0 and 1.1.0 stay active and served, tracker.intentional-upgrade)
    expect(chk.tracker_version_seen).toBe("1.2.0");
    expect(chk.outdated_tracker).toBe(false);
  }, 90_000);

  it("API: the seven web metrics equal the scripted values (verified vs raw)", async (ctx) => {
    const d = rec.start(ctx, [
      "metric.pageviews",
      "metric.unique-visitors",
      "metric.referrers",
      "metric.session-duration",
      "metric.bounce-rate",
      "metric.country",
      "metric.device",
      "metric.browser",
      "bot.js-execution-proof",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const f = fx as Fixture;
    const s = site();
    const stats = await eventually(
      "web stats",
      () => f.cp.webStats(f.tenantId, s.site_id, "range=24h&variant=both"),
      (x) => x.raw?.pageviews === EXPECT.raw.pageviews,
      60_000,
      2000,
    );
    rec.data.stats = stats;
    expect(stats.verified).toMatchObject(EXPECT.verified);
    expect(stats.raw).toMatchObject(EXPECT.raw);
    expect(stats.visit_metrics.visits).toBe(EXPECT.visits);
    expect(stats.visit_metrics.bounces).toBe(EXPECT.bounces);
    expect(stats.visit_metrics.bounce_rate_pct).toBeCloseTo(50, 1);
    // Duration: first-to-last page view per visit (C-99), averaged over all visits.
    const span = (t: number[]) => ((t[t.length - 1] ?? 0) - (t[0] ?? 0)) / 1000;
    const expectedAvg = (span(times.A ?? []) + span(times.C ?? [])) / EXPECT.visits;
    expect(stats.visit_metrics.avg_visit_duration_s).not.toBeNull();
    expect(
      Math.abs((stats.visit_metrics.avg_visit_duration_s as number) - expectedAvg),
    ).toBeLessThan(1.5);
    d.detail(
      `verified ${JSON.stringify(stats.verified)}, raw ${JSON.stringify(stats.raw)}, visit metrics ${JSON.stringify(stats.visit_metrics)}, expected avg duration ${expectedAvg.toFixed(2)} s`,
    );

    const bd = async (dim: string, variant = "verified") =>
      (await f.cp.webBreakdown(f.tenantId, s.site_id, dim, `range=24h&variant=${variant}`))[
        variant as "verified"
      ] ?? [];
    const pages = Object.fromEntries((await bd("path")).map((r) => [r.value, r.pageviews]));
    rec.data.pages = pages;
    expect(pages).toEqual({ "/landing": 2, "/pricing": 1, "/docs": 1, "/docs/intro": 1 });
    const refs = (await bd("referrer")).filter((r) => r.value !== "");
    expect(refs.map((r) => [r.value, r.visitors])).toEqual([["news.example.org", 1]]);
    const countries = await bd("country");
    rec.data.countries = countries;
    expect(countries.map((r) => [r.value, r.visitors])).toEqual([["XX", 3]]);
    const devices = await bd("device");
    rec.data.devices = devices;
    expect(devices.find((r) => r.value === "mobile")?.visitors).toBe(1);
    expect(devices.reduce((a, r) => a + (r.visitors ?? 0), 0)).toBe(3);
    const browsers = await bd("browser");
    rec.data.browsers = browsers;
    expect(browsers.map((r) => [r.value, r.visitors])).toEqual([["chrome", 3]]);
    const rawBrowsers = await bd("browser", "raw");
    rec.data.rawBrowsers = rawBrowsers;
    expect(Object.fromEntries(rawBrowsers.map((r) => [r.value, r.visitors]))).toEqual({
      chrome: 3,
      firefox: 1,
    });
    const events = await bd("event");
    rec.data.events = events;
    expect(events.map((r) => [r.value, r.events])).toEqual([["signup", 1]]);
  }, 120_000);

  it("Umami holds no query string, fragment or page title, and no rejected event", async (ctx) => {
    rec.start(ctx, ["privacy.minimal-erasure-scope", "bot.js-execution-proof"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const w = await compose.scalar(
      "scf",
      `SELECT umami_website_id FROM scf.sites WHERE site_id = '${site().site_id}'`,
    );
    const rows = await compose.sql(
      "umami",
      `SELECT url_path, coalesce(url_query,''), coalesce(page_title,''), coalesce(tag,'') FROM website_event
        WHERE website_id = '${w}' AND event_type = 1 ORDER BY created_at`,
    );
    expect(rows.length).toBe(EXPECT.raw.pageviews);
    for (const [, q, t] of rows) {
      expect(q).toBe("");
      expect(t).toBe("");
    }
    expect(rows.filter((r) => r[3] === "v").length).toBe(EXPECT.verified.pageviews);
  });

  it("jobs rollup: today's web_daily_totals equal the live figures", async (ctx) => {
    const d = rec.start(ctx, [
      "metric.pageviews",
      "metric.unique-visitors",
      "metric.session-duration",
      "metric.bounce-rate",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose", "jobs"]);
    await compose.restart("jobs"); // SCF_JOBS_RUN_ON_START: web_rollup runs at start
    const row = await eventually(
      "web_daily_totals",
      () =>
        compose.sql(
          "scf",
          `SELECT pageviews_verified, pageviews_raw, visitors_verified, visitors_raw, visits, bounces, total_duration_s
             FROM scf.web_daily_totals WHERE site_id = '${site().site_id}' AND day = (now() AT TIME ZONE 'UTC')::date`,
        ),
      (r) => r.length === 1 && r[0]?.[1] === String(EXPECT.raw.pageviews),
      120_000,
      3000,
    );
    const [pvV, pvR, vV, vR, visits, bounces] = (row[0] as string[]).map(Number);
    d.detail(`row ${JSON.stringify(row[0])}`);
    expect({ pvV, pvR, vV, vR, visits, bounces }).toEqual({
      pvV: EXPECT.verified.pageviews,
      pvR: EXPECT.raw.pageviews,
      vV: EXPECT.verified.visitors,
      vR: EXPECT.raw.visitors,
      visits: EXPECT.visits,
      bounces: EXPECT.bounces,
    });
  }, 180_000);

  it("portal: the tenant signs in and the dashboard shows the same figures", async (ctx) => {
    rec.start(ctx, [
      "dashboard.web-tenant",
      "metric.pageviews",
      "metric.unique-visitors",
      "metric.bounce-rate",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose", "portal"]);
    const f = fx as Fixture;
    const b = await chromium.launch(); // the portal is a local origin: no ingest proxy
    try {
      const c = await b.newContext({ locale: "en-US" });
      const page = await c.newPage();
      // Project mode lists Freighter as "Soon"; the SEP-53 form ("any wallet" path) stays reachable directly.
      await page.goto(`${env.portalUrl}/signin?method=wallet`);
      await page.getByLabel("Stellar account").fill(f.cp.wallet.account);
      await page.getByRole("button", { name: "Get message to sign" }).click();
      const message = await page.getByTestId("sep53-message").textContent();
      expect(message).toBeTruthy();
      await page
        .getByLabel("Signature (base64 or hex)")
        .fill(f.cp.wallet.signMessage(message as string));
      await page.getByRole("button", { name: /^(Sign in|Confirm)$/ }).click();
      await page.getByRole("heading", { name: "Your Stellar ecosystem projects" }).waitFor();
      await page.goto(`${env.portalUrl}/t/${f.tenantId}/sites/${site().site_id}`);
      const pv = page.getByTestId("tile-pageviews");
      await pv.waitFor({ timeout: 30_000 });
      await expect
        .poll(async () => pv.textContent(), { timeout: 30_000 })
        .toContain(`Verified ${EXPECT.verified.pageviews} · Raw ${EXPECT.raw.pageviews}`);
      expect(await page.getByTestId("tile-visitors").textContent()).toContain(
        `Verified ${EXPECT.verified.visitors} · Raw ${EXPECT.raw.visitors}`,
      );
      expect(await page.getByTestId("tile-visits").textContent()).toContain(String(EXPECT.visits));
      expect(await page.getByTestId("tile-bounce").textContent()).toContain("50");
    } finally {
      await b.close();
    }
  }, 120_000);
});
