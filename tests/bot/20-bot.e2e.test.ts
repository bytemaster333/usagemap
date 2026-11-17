// SPDX-License-Identifier: Apache-2.0
// Bot and inflation simulations (ADR-0008, ADR-0026; web.frontend-origin-only, bot.*). Scripted clients against the real gateway;
// each scenario's verdict and reason codes are read back from the tenant's installation-check API
// (getInstallationCheck: the counters the gateway uploads, C-39) and compared with exact expected counts.
// The simulations also keep the documented limits visible. Every scripted client here runs on Node's TLS stack
// (OpenSSL) and claims Chrome or Firefox, so since C-124 each of its events also carries `transport_mismatch`
// (suspect): a script that solves the proof and copies a browser's headers ("control" scenario) is no longer
// `verified`. The honest boundary moves, it does not disappear: a script on an imitated browser TLS/HTTP-2 stack
// (curl-impersonate, uTLS) or a driven real browser still passes the request layer and is left to multiplicity (L6)
// and the daily trust score (L7). Real browsers are `verified` (e2e web suite).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Compose, NODE_IMAGE } from "../lib/compose.ts";
import { type InstallationCheck, reasonCount } from "../lib/cp-client.ts";
import { loadEnv, TESTS_DIR } from "../lib/env.ts";
import {
  createFixture,
  eventually,
  type Fixture,
  type FixtureSite,
  gatewayTarget,
  setMultiplicityMode,
  waitForGateway,
} from "../lib/fixture.ts";
import { requires } from "../lib/gate.ts";
import {
  type Batch,
  browserHeaders,
  CHROME_UA,
  eventId,
  GatewayClient,
  tamperToken,
} from "../lib/gateway-client.ts";
import { insecureGet } from "../lib/http.ts";
import { Recorder } from "../lib/recorder.ts";

const run = promisify(execFile);
const env = loadEnv();
const compose = new Compose(env);
const rec = new Recorder(
  env,
  "bot",
  "simulations",
  "Bot and inflation simulations against the real gateway",
  "Scripted clients (no challenge, invalid/missing/tampered/foreign proofs, token replay and flood, moved context, automation flags, headless and known-bot User-Agents, origin mismatch, impossible fetch metadata, unverified domain, datacenter addresses, multiplicity over threshold on identified and identifier-free sites, forged site key) send traffic through the gateway's public front door; verdicts and reason codes are read back from the control plane's installation-check API.",
);

const fx: Fixture[] = [];
const sites: Record<string, { f: Fixture; s: FixtureSite }> = {};
let ready = false;

beforeAll(async () => {
  try {
    if ((await insecureGet(`${env.gatewayMetricsUrl}/healthz`, 3000)).status !== 200) return;
    if ((await insecureGet(`${env.controlPlaneUrl}/healthz`, 3000)).status !== 200) return;
  } catch {
    return;
  }
  const id = Date.now().toString(36);
  // L0 tenants may have two sites each (l0_max_sites); a user may create three tenants.
  const groups = [
    [
      { key: "challenge", host: "chal.wsl.test" },
      { key: "headers", host: "hdr.wsl.test" },
    ],
    [
      { key: "unverified", host: "unv.wsl.test", verified: false },
      { key: "multiplicity", host: "mult.wsl.test" },
    ],
    [
      { key: "datacenter", host: "dc.wsl.test" },
      { key: "mult_off", host: "multoff.wsl.test", opts: { visitor_id: "off" } },
    ],
    [{ key: "mult_shadow", host: "multsh.wsl.test" }],
  ];
  for (const [i, g] of groups.entries()) {
    const f = await createFixture(env, compose, `wsl-bot${i}-${id}`, g);
    fx.push(f);
    for (const s of Object.values(f.sites)) sites[s.name as string] = { f, s };
  }
  await waitForGateway(
    env,
    compose,
    Object.values(sites).map((x) => x.s),
  );
  ready = true;
}, 300_000);

afterAll(() => {
  const out = rec.write();
  if (out) console.log(`evidence: ${out.md}`);
});

function site(key: string): FixtureSite {
  const x = sites[key];
  if (!x) throw new Error(`no site ${key}`);
  return x.s;
}

function client(key: string, headers = browserHeaders(site(key).origin)): GatewayClient {
  return new GatewayClient(gatewayTarget(env), headers);
}

async function check(
  key: string,
  done: (c: InstallationCheck) => boolean,
): Promise<InstallationCheck> {
  const x = sites[key];
  if (!x) throw new Error(`no site ${key}`);
  return eventually(
    `installation check ${key}`,
    () => x.f.cp.installation(x.f.tenantId, x.s.site_id),
    done,
    60_000,
    2000,
  );
}

/**
 * Number of identified page loads that met multiplicity_high out of 44 distinct visitors against the threshold 40. The
 * cell's sketch is exact up to 32 surrogates and a HyperLogLog (p = 10, standard error ≈ 3.3 %, ±1.4 at 40) above
 * (wire-formats §b.4), so loads 1–32 can never be high and the 41st–44th are high only as estimated: 4 is expected,
 * and an estimate off by one moves it to 3 or 5 (measured: 5 in a run of 13 Nov 2026). Hard bounds: at least 1, at
 * most the 12 estimated loads.
 */
function expectHighCount(n: number): void {
  expect(n).toBeGreaterThanOrEqual(1);
  expect(n).toBeLessThanOrEqual(12);
}

const pv = (u: string) => ({ k: "pv" as const, u, w: "l" as const, l: "en" });
const SG: Batch["sg"] = { wd: 0, vis: "v", act: 1 };

describe("bot and inflation simulations", () => {
  it("challenge layer: missing, invalid, missing proof, tampered, foreign, moved, replayed and flooded tokens", async (ctx) => {
    const d = rec.start(ctx, [
      "web.frontend-origin-only",
      "bot.anti-inflation-strategy",
      "bot.js-execution-proof",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    expect(ready).toBe(true);
    const k = site("challenge").site_key;
    const gw = client("challenge");
    // no token at all (a curl-style POST that copies a browser's headers)
    expect((await gw.send({ site: k, events: [pv("/a"), pv("/b")] })).status).toBe(202);
    // wrong counter
    const s1 = await gw.solved(k);
    expect(
      (
        await gw.send({
          site: k,
          token: s1.token,
          c: (s1.c + 1) % 1024,
          sg: SG,
          events: [pv("/c"), pv("/d")],
        })
      ).status,
    ).toBe(202);
    // no counter (page hidden before the proof) → suspect
    const s2 = await gw.solved(k);
    expect(
      (await gw.send({ site: k, token: s2.token, sg: SG, events: [pv("/e"), pv("/f")] })).status,
    ).toBe(202);
    // tampered MAC
    const s3 = await gw.solved(k);
    expect(
      (
        await gw.send({
          site: k,
          token: tamperToken(s3.token),
          c: s3.c,
          sg: SG,
          events: [pv("/g"), pv("/h")],
        })
      ).status,
    ).toBe(202);
    // token and proof solved for another site, replayed here
    const other = client("headers");
    const s4 = await other.solved(site("headers").site_key);
    expect(
      (await gw.send({ site: k, token: s4.token, c: s4.c, sg: SG, events: [pv("/i"), pv("/j")] }))
        .status,
    ).toBe(202);
    // token obtained as Chrome on Windows, used as Firefox on Linux → ctx_moved (soft)
    const s5 = await gw.solved(k);
    const moved = client(
      "challenge",
      browserHeaders(
        site("challenge").origin,
        "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      ),
    );
    expect(
      (
        await moved.send({
          site: k,
          token: s5.token,
          c: s5.c,
          sg: SG,
          events: [pv("/k"), pv("/l")],
        })
      ).status,
    ).toBe(202);
    // the same batch (same event ids) replayed: counted once, the copy dropped as duplicate_event_id
    const s6 = await gw.solved(k);
    const replay = {
      site: k,
      token: s6.token,
      c: s6.c,
      sg: SG,
      events: [
        { ...pv("/m"), id: eventId() },
        { ...pv("/n"), id: eventId() },
      ],
    };
    expect((await gw.send(replay)).status).toBe(202);
    expect((await gw.send(replay)).status).toBe(202);
    // one token + proof replayed for 310 events: 300 accepted (web_events_per_token), 10 rejected token_flood
    const s7 = await gw.solved(k);
    for (let b = 0; b < 31; b++) {
      const r = await gw.send({
        site: k,
        token: s7.token,
        c: s7.c,
        sg: SG,
        events: Array.from({ length: 10 }, (_, i) => ({
          k: "ev" as const,
          u: "/flood",
          n: `flood_${b}_${i}`,
        })),
      });
      expect(r.status).toBe(202);
    }
    // Every event that is not rejected is suspect: the scripted client's TLS stack does not match its UA (C-124).
    const want = { verified: 0, suspect: 2 + 2 + 2 + 300, rejected: 2 + 2 + 2 + 2 + 10 };
    const c = await check(
      "challenge",
      (x) => x.verdicts.verified + x.verdicts.suspect + x.verdicts.rejected >= 324,
    );
    rec.data.challenge = c;
    d.detail(`verdicts ${JSON.stringify(c.verdicts)}; reasons ${JSON.stringify(c.reasons)}`);
    expect(c.verdicts).toEqual(want);
    expect(reasonCount(c, "challenge_missing")).toBe(2);
    expect(reasonCount(c, "proof_invalid")).toBe(2);
    expect(reasonCount(c, "proof_missing")).toBe(2);
    expect(reasonCount(c, "challenge_invalid")).toBe(4);
    expect(reasonCount(c, "ctx_moved")).toBe(2);
    expect(reasonCount(c, "token_flood")).toBe(10);
    expect(c.drops?.find((x) => x.label === "duplicate_event_id")?.count).toBe(2);
    // all 324 events with a verdict claim Chrome (or Firefox, "moved") on Node's TLS stack
    expect(reasonCount(c, "transport_mismatch")).toBe(324);
  }, 240_000);

  it("request layer: automation flag, hidden page, headless and known-bot UAs, origin mismatch/missing, impossible fetch; a header-perfect script is suspect (transport_mismatch)", async (ctx) => {
    const d = rec.start(ctx, [
      "web.frontend-origin-only",
      "bot.anti-inflation-strategy",
      "bot.js-execution-proof",
      "bot.engine-bot-detection",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const s = site("headers");
    const k = s.site_key;
    const send = async (
      headers: Record<string, string>,
      sg: Batch["sg"] = SG,
      events = [pv("/x"), pv("/y")],
    ) => {
      const gw = client("headers", headers);
      const { token, c } = await gw.solved(k);
      expect((await gw.send({ site: k, token, c, sg, events })).status).toBe(202);
    };
    const h = (ua = CHROME_UA()) => browserHeaders(s.origin, ua);
    await send(h(CHROME_UA(131, "Macintosh; Intel Mac OS X 10_15_7"))); // control: header-perfect, suspect only for transport
    await send(h(CHROME_UA(130)), { wd: 1, vis: "v", act: 1 }); // navigator.webdriver
    await send(h(CHROME_UA(129)), { wd: 0, vis: "h", act: 0 }); // hidden page view
    await send(
      h(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
      ),
    );
    await send(h("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"));
    await send({
      ...h(CHROME_UA(128)),
      origin: "https://evil.example",
      referer: "https://evil.example/",
    });
    await send({
      ...h(CHROME_UA(127)),
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    const noOrigin = h(CHROME_UA(126));
    delete (noOrigin as Record<string, string | undefined>).origin;
    delete (noOrigin as Record<string, string | undefined>).referer;
    await send(noOrigin);
    // The control batch (header-perfect, valid proof) is suspect with transport_mismatch as its only reason (C-124;
    // it was `verified` before before).
    const want = { verified: 0, suspect: 2 + 2 + 2 + 2, rejected: 2 + 2 + 2 + 2 };
    const c = await check(
      "headers",
      (x) => x.verdicts.verified + x.verdicts.suspect + x.verdicts.rejected >= 16,
    );
    rec.data.headers = c;
    d.detail(`verdicts ${JSON.stringify(c.verdicts)}; reasons ${JSON.stringify(c.reasons)}`);
    expect(c.verdicts).toEqual(want);
    expect(reasonCount(c, "automation_flag")).toBe(4); // webdriver ×2 + headless UA ×2
    expect(reasonCount(c, "hidden_or_prerender")).toBe(2);
    expect(reasonCount(c, "ua_bot")).toBe(4); // HeadlessChrome and Googlebot are both on Umami's isbot list
    expect(reasonCount(c, "origin_mismatch")).toBe(2);
    expect(reasonCount(c, "fetch_impossible")).toBe(2);
    expect(reasonCount(c, "origin_missing")).toBe(2);
    // Every UA here claims Chrome except Googlebot (no browser family: not checked) → 7 × 2 events.
    expect(reasonCount(c, "transport_mismatch")).toBe(14);
    // Eight distinct visitors from one address within 10 minutes stay below the `unknown` exact-IP threshold, which
    // is the eyeball_mobile one (40) since C-124 (F19: carrier-NAT audiences) — no multiplicity_high here any more.
    expect(reasonCount(c, "multiplicity_high")).toBe(0);
  }, 120_000);

  it("domain declared but not verified (L0) → suspect domain_unverified", async (ctx) => {
    rec.start(ctx, ["bot.anti-inflation-strategy"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const gw = client("unverified");
    const { token, c } = await gw.solved(site("unverified").site_key);
    await gw.send({
      site: site("unverified").site_key,
      token,
      c,
      sg: SG,
      events: [pv("/u1"), pv("/u2")],
    });
    const r = await check("unverified", (x) => x.verdicts.suspect >= 2);
    rec.data.unverified = r;
    expect(r.verdicts).toEqual({ verified: 0, suspect: 2, rejected: 0 });
    expect(reasonCount(r, "domain_unverified")).toBe(2);
  });

  it("multiplicity: 44 distinct visitors from one address in 10 minutes without activation → loads above 40 (estimated) multiplicity_high", async (ctx) => {
    const d = rec.start(ctx, ["bot.ip-multiplicity"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const s = site("multiplicity");
    for (let i = 0; i < 44; i++) {
      const gw = client("multiplicity", browserHeaders(s.origin, CHROME_UA(90 + i)));
      const { token, c } = await gw.solved(s.site_key);
      await gw.send({
        site: s.site_key,
        token,
        c,
        sg: { wd: 0, vis: "v", act: 0 },
        events: [pv(`/m/${i}`)],
      });
    }
    // The exact_ip threshold for the `unknown` class is max(unknown 6, eyeball_mobile 40) = 40 (C-124): once the cell
    // holds more than 40 distinct surrogates it is `high`, and zero activation (44/44 > 0.7) makes it low engagement.
    // All 44 are suspect anyway (transport_mismatch: a Node client claiming Chrome).
    const r = await check("multiplicity", (x) => x.verdicts.verified + x.verdicts.suspect >= 44);
    rec.data.multiplicity = r;
    d.detail(`verdicts ${JSON.stringify(r.verdicts)}; reasons ${JSON.stringify(r.reasons)}`);
    expect(r.verdicts).toEqual({ verified: 0, suspect: 44, rejected: 0 });
    expectHighCount(reasonCount(r, "multiplicity_high"));
    expect(reasonCount(r, "transport_mismatch")).toBe(44);
  }, 300_000);

  it("multiplicity in shadow mode (C-124): the same 44 visitors leave no multiplicity_high; the high loads are counted as high_shadow", async (ctx) => {
    const d = rec.start(ctx, ["bot.ip-multiplicity"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const s = site("mult_shadow");
    await setMultiplicityMode(compose, s, "shadow");
    for (let i = 0; i < 44; i++) {
      const gw = client("mult_shadow", browserHeaders(s.origin, CHROME_UA(90 + i)));
      const { token, c } = await gw.solved(s.site_key);
      await gw.send({
        site: s.site_key,
        token,
        c,
        sg: { wd: 0, vis: "v", act: 0 },
        events: [pv(`/ms/${i}`)],
      });
    }
    // Same traffic as the enforce case above: the 41st–44th distinct surrogates meet multiplicity_high, but in shadow
    // mode the reason is not added — the events are counted in multiplicity/high_shadow and their verdict is decided
    // by the other reasons only (here transport_mismatch: a Node client claiming Chrome).
    const r = await check(
      "mult_shadow",
      (x) => x.verdicts.verified + x.verdicts.suspect >= 44 && x.multiplicity.high_shadow >= 1,
    );
    rec.data.multiplicityShadow = r;
    d.detail(
      `verdicts ${JSON.stringify(r.verdicts)}; reasons ${JSON.stringify(r.reasons)}; multiplicity ${JSON.stringify(r.multiplicity)}`,
    );
    expect(r.multiplicity).toMatchObject({ mode: "shadow", source: "site" });
    expectHighCount(r.multiplicity.high_shadow);
    expect(reasonCount(r, "multiplicity_high")).toBe(0);
    expect(reasonCount(r, "transport_mismatch")).toBe(44);
    expect(r.verdicts).toEqual({ verified: 0, suspect: 44, rejected: 0 });
  }, 300_000);

  it("multiplicity on a site without visitor identifier (C-80b): 404 page loads from one address → loads 401–404 multiplicity_high", async (ctx) => {
    const d = rec.start(ctx, ["bot.ip-multiplicity"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const s = site("mult_off");
    // Paced under the rate limits a single address meets (wire-formats §a.6 step 2, C-140(2)): per site, subnet and
    // route, `min(web_requests_per_min_subnet, max(⌊share ÷ 4⌋, 10))` per node, share = the L0 site limit ÷ live
    // edge nodes (this stack runs one). With the defaults that is 150 challenges and 150 event batches a minute; one
    // load per 0.45 s (≈ 133/min) stays below it and still puts the 404 loads inside the 10-minute window. A real
    // visitor behind one address reaching 400 loads in 10 minutes needs only 40/min.
    const setting = async (key: string) =>
      Number(
        await compose.scalar("scf", `SELECT value::text FROM scf.settings WHERE key = '${key}'`),
      );
    const share = await setting("l0_web_requests_per_min_site");
    const perSubnet = Math.min(
      await setting("web_requests_per_min_subnet"),
      Math.max(Math.floor(share / 4), 10),
    );
    const paceMs = Math.max(450, Math.ceil(60_000 / (perSubnet * 0.9)));
    expect(
      paceMs * 404,
      `404 loads at the rate limit (${perSubnet}/min) fit in 10 minutes`,
    ).toBeLessThan(540_000);
    for (let i = 0; i < 404; i++) {
      const t0 = Date.now();
      const gw = client("mult_off");
      const { token, c } = await gw.solved(s.site_key);
      await new Promise((ok) => setTimeout(ok, Math.max(0, paceMs - (Date.now() - t0))));
      await gw.send({
        site: s.site_key,
        token,
        c,
        sg: { wd: 0, vis: "v", act: 0 },
        events: [pv(`/o/${i}`)],
      });
    }
    // multiplicity_event_thresholds.exact_ip: max(unknown 60, eyeball_mobile 400) = 400 page loads per 10 minutes.
    const r = await check("mult_off", (x) => x.verdicts.verified + x.verdicts.suspect >= 404);
    rec.data.multiplicityOff = r;
    d.detail(
      `per-subnet limit ${perSubnet}/min, one load every ${paceMs} ms; verdicts ${JSON.stringify(r.verdicts)}; reasons ${JSON.stringify(r.reasons)}`,
    );
    expect(r.verdicts).toEqual({ verified: 0, suspect: 404, rejected: 0 });
    expect(reasonCount(r, "multiplicity_high")).toBe(4);
  }, 900_000);

  it("datacenter address (range list class `datacenter`) → suspect net_datacenter", async (ctx) => {
    const d = rec.start(ctx, ["bot.anti-inflation-strategy", "bot.ip-multiplicity"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose", "docker"]);
    const s = site("datacenter");
    const arg = JSON.stringify({
      gateway: "https://10.213.47.2:8443",
      servername: env.ingestHosts[0],
      site: s.site_key,
      origin: s.origin,
      loads: 2,
      act: 1,
    });
    const { stdout } = await run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        `${env.project}_botnet`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "1000:1000",
        "-v",
        `${TESTS_DIR}/lib:/t/lib:ro`,
        "-v",
        `${TESTS_DIR}/bot:/t/bot:ro`,
        NODE_IMAGE,
        "node",
        "/t/bot/dc-client.ts",
        arg,
      ],
      { timeout: 120_000 },
    );
    expect(JSON.parse(stdout).statuses).toEqual([202, 202]);
    const r = await check("datacenter", (x) => x.verdicts.suspect >= 2);
    rec.data.datacenter = r;
    d.detail(`verdicts ${JSON.stringify(r.verdicts)}`);
    expect(r.verdicts).toEqual({ verified: 0, suspect: 2, rejected: 0 });
    expect(reasonCount(r, "net_datacenter")).toBe(2);
    expect(reasonCount(r, "transport_mismatch")).toBe(2);
  }, 180_000);

  it("forged site key → 404 on challenge and events, nothing counted for any site", async (ctx) => {
    rec.start(ctx, ["bot.anti-inflation-strategy"]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const gw = client("challenge");
    const forged = "Zz9Zz9Zz9Zz9Zz9Zz9Zz9Z";
    expect((await gw.challenge(forged)).status).toBe(404);
    expect((await gw.send({ site: forged, events: [pv("/forged")] })).status).toBe(404);
  });
});
