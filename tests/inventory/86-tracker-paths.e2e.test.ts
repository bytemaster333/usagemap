// SPDX-License-Identifier: Apache-2.0
// Tracker 1.2.0 paths through the whole stack (integration verification 2026-11-19, gap 4; wire-formats §a.3.1,
// §a.3.2, §a.9, §d.3). Runs after the wallet adapters (85) and before the data-inventory scan (90), which it feeds
// with canaries.
//
// A real Chromium loads the tracker's npm build and drives, against stand-ins that hand canary values to the adapters
// wherever the real libraries would:
//   - browser RPC / Horizon telemetry (`/stellar-rpc`) on js-stellar-sdk 17.4.0's own browser bundle, against stand-in
//     providers whose URLs carry API keys — totals per method and outcome in `getSiteBrowserRpc`;
//   - `wallet_connect_failed`, the wallet context `wc` and the WalletConnect funnel (Freighter wrapper and the kit's
//     WalletConnect module);
//   - the Privy wrapper (`/privy`) with stand-in Privy hooks;
//   - the Wallets Kit module wrapper `wrapWalletsKitModules`;
// and the React Native helper (`packages/mobile-rn`) runs in Node and posts to `/v1/app-events`. Everything goes
// through the real gateway (proof of work, verdict, counter records), the real control plane and PostgreSQL. Each
// test asserts exact counts in the tenant API (`getSiteBrowserRpc`, `getSiteWalletFunnel`, `getAppEvents`) or, for the
// three 1.2.0 wallet events that no tenant API returns yet, in the rollup the dashboard reads
// (`scf.web_event_property_daily`), and the privacy invariants: no canary leaves the browser, none is stored or
// logged anywhere in the stack, the RPC aggregate and the counted-only events never reach the event engine, and the
// RPC table has no visitor, session, page or time column.
//
// The counter-record parts `app` and `rpc` are an operator setting (`edge_counter_features`, C-137 upgrade rule);
// the local stack enables `props` and `dev` only, so the suite adds both as the database superuser for its run and
// restores the setting afterwards (the operator path needs a passkey step-up and is covered by the control plane's
// own tests).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import type { Page, Request } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { createUsageMapApp } from "../../packages/mobile-rn/src/index.ts";
import { context, launch, startIngestProxy } from "../lib/browser.ts";
import { recordCanaries, tag } from "../lib/canaries.ts";
import { Compose } from "../lib/compose.ts";
import { loadEnv, REPO_ROOT } from "../lib/env.ts";
import {
  createFixture,
  eventually,
  type Fixture,
  type FixtureSite,
  waitForGateway,
} from "../lib/fixture.ts";
import { requires } from "../lib/gate.ts";
import { CHROME_UA } from "../lib/gateway-client.ts";
import { request } from "../lib/http.ts";
import { type Canary, scan } from "../lib/privacy-scan.ts";
import { Recorder } from "../lib/recorder.ts";
import {
  asPathCanaries,
  eventKey,
  expectedRollup,
  HORIZON_ORIGIN,
  modulesPage,
  type PathCanaries,
  pathCanaries,
  privyPage,
  RPC_ORIGIN,
  rpcPage,
  type SentEvent,
  TESTNET,
  walletsPage,
} from "../lib/tracker-paths.ts";

const env = loadEnv();
const compose = new Compose(env);
const rec = new Recorder(
  env,
  "data-inventory",
  "tracker-paths",
  "Tracker 1.2.0 paths: browser and app to the tenant's counts",
  "Browser RPC/Horizon aggregates, connect failures with the wallet context, the WalletConnect funnel, the Privy wrapper and the Wallets Kit module wrapper ran in a real Chromium, and the React Native helper ran in Node, all through the real gateway into the control plane; the tenant API and the rollups were compared with exactly what was sent, and the canaries were searched for in both databases and every container log.",
);

const TRACKER = join(REPO_ROOT, "tracker");
const NPM = join(TRACKER, "dist/npm");
// js-stellar-sdk 17.4.0, pinned by packages/stellar-otel (its package.json is not an export: resolve the main entry
// and walk up to the package root)
const SDK_DIR = (() => {
  let d = dirname(
    createRequire(join(REPO_ROOT, "packages/stellar-otel/package.json")).resolve(
      "@stellar/stellar-sdk",
    ),
  );
  while (!existsSync(join(d, "package.json")) || !existsSync(join(d, "dist"))) d = dirname(d);
  return d;
})();
const SDK_BUNDLE = join(SDK_DIR, "dist/stellar-sdk.min.js");
const ENTRIES = ["standard", "wallets-kit", "wallets", "privy", "stellar-rpc"] as const;
const NPM_BASE = "/_scf";
const SDK_PATH = "/_sdk/stellar-sdk.min.js";
const CONTENT: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};
const FEATURES = ["props", "dev", "app", "rpc"];
const COUNTED_ONLY = [
  "sign_requested",
  "sign_approved",
  "sign_rejected",
  "tx_submitted",
  "smart_wallet_created",
  "passkey_used",
  "walletconnect_request",
];
/** getSiteWalletFunnel's steps (services/control-plane/src/web/stellar.ts FUNNEL_EVENTS). */
const FUNNEL = [
  "wallet_modal_opened",
  "wallet_modal_closed",
  "wallet_selected",
  "wallet_connect",
  "wallet_disconnect",
  "sign_requested",
  "sign_approved",
  "sign_rejected",
  "tx_submitted",
  "smart_wallet_created",
  "passkey_used",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const midnight = (t: number) =>
  new Date(Math.floor(t / DAY) * DAY).toISOString().replace(".000", "");

// ---- shared state of the suite ----
let previousFeatures: string | undefined;
const c: PathCanaries = pathCanaries();
const appCanaries: Canary[] = [];

afterAll(async () => {
  if (previousFeatures !== undefined) {
    await compose
      .sql(
        "scf",
        `UPDATE scf.settings SET value = '${previousFeatures}'::jsonb, updated_at = now()
          WHERE key = 'edge_counter_features'; NOTIFY scf_edge;`,
      )
      .catch(() => undefined);
  }
  const out = rec.write();
  if (out) console.log(`evidence: ${out.md}`);
});

/** The gateway's stored snapshot settings (volume `gwstate`). */
async function snapshotFeatures(): Promise<string[]> {
  try {
    const s = JSON.parse(await compose.volumeFile("gwstate", "snapshot.json")) as {
      payload: string;
    };
    const p = JSON.parse(Buffer.from(s.payload, "base64url").toString("utf8")) as {
      settings?: { counter_features?: string[] };
    };
    return p.settings?.counter_features ?? [];
  } catch {
    return [];
  }
}

const RUN = Date.now().toString(36);
const ready = { done: false };
const fixtures = new Map<string, Fixture>();

/**
 * A fixture tenant with one site for the path `key` (a new tenant is level L0, whose site limit is below five, so
 * each path has its own); on first use also the tracker build and the `app` and `rpc` counter parts, on until the
 * suite ends.
 */
async function setup(key: string): Promise<{ f: Fixture; s: FixtureSite }> {
  if (!ready.done) {
    // the npm build of the tracker (git-ignored; 85 builds it too when it runs first)
    if (!ENTRIES.every((e) => existsSync(join(NPM, `${e}.js`))))
      execFileSync(process.execPath, ["scripts/build.ts"], {
        cwd: TRACKER,
        stdio: ["ignore", "ignore", "inherit"],
      });
    previousFeatures ??= (
      await compose.scalar(
        "scf",
        `SELECT value::text FROM scf.settings WHERE key = 'edge_counter_features'`,
      )
    ).trim();
    await compose.sql(
      "scf",
      `UPDATE scf.settings SET value = '${JSON.stringify(FEATURES)}'::jsonb, updated_at = now()
        WHERE key = 'edge_counter_features'; NOTIFY scf_edge;`,
    );
    await eventually(
      "the gateway snapshot advertises the app and rpc counter parts",
      snapshotFeatures,
      (x) => FEATURES.every((k) => x.includes(k)),
      90_000,
    );
    recordCanaries(env.workDir, "inventory/tracker-paths", asPathCanaries(c));
    ready.done = true;
  }
  let f = fixtures.get(key);
  if (!f) {
    f = await createFixture(env, compose, `wsl-t12-${key}-${Date.now().toString(36)}`, [
      // a host per run: a verified host has one owner (host_owner_check), and the stack outlives a run
      { key, host: `${key}-${RUN}.t12.wsl.test`, anonymousReports: false },
    ]);
    fixtures.set(key, f);
  }
  const s = f.sites[key];
  if (!s) throw new Error(`fixture site ${key}`);
  await waitForGateway(env, compose, [s]);
  return { f, s };
}

function importMap(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(TRACKER, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, { default?: string } | string>;
  };
  const m: Record<string, string> = {};
  for (const [k, v] of Object.entries(pkg.exports)) {
    const file = typeof v === "string" ? v : v.default;
    if (!file?.endsWith(".js")) continue;
    m[k === "." ? pkg.name : `${pkg.name}${k.slice(1)}`] =
      `${NPM_BASE}/${normalize(file).replace(/^dist\/npm\//, "")}`;
  }
  return m;
}

const CORS = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-expose-headers": "*",
});

/** Stand-in Stellar RPC: answers per JSON-RPC method (ok, a JSON-RPC error, HTTP 429, HTTP 503). */
function rpcAnswer(body: string): { status: number; json: unknown } {
  let m: { id?: unknown; method?: unknown } = {};
  try {
    m = JSON.parse(body);
  } catch {}
  const ok = (result: unknown) => ({ status: 200, json: { jsonrpc: "2.0", id: m.id, result } });
  switch (m.method) {
    case "getHealth":
      return ok({
        status: "healthy",
        latestLedger: 100,
        oldestLedger: 1,
        ledgerRetentionWindow: 17280,
      });
    case "getNetwork":
      return ok({ passphrase: TESTNET, protocolVersion: 23 });
    case "getTransaction":
      return {
        status: 200,
        json: { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: c.message } },
      };
    case "getFeeStats":
      return { status: 429, json: { message: c.message } };
    case "getVersionInfo":
      return { status: 503, json: { message: c.message } };
    default:
      return { status: 404, json: {} };
  }
}

/** Stand-in Horizon behind a key-carrying base path. */
function horizonAnswer(path: string): { status: number; json: unknown } {
  const links = { self: { href: "" }, next: { href: "" }, prev: { href: "" } };
  const rest = path.replace(`/${c.horizonKey}`, "");
  if (rest === "/ledgers")
    return { status: 200, json: { _links: links, _embedded: { records: [] } } };
  if (rest.startsWith("/accounts/"))
    return {
      status: 200,
      json: { _links: links, id: c.account, account_id: c.account, sequence: "1", balances: [] },
    };
  return {
    status: 404,
    json: {
      type: "https://stellar.org/horizon-errors/not_found",
      title: "Resource Missing",
      status: 404,
    },
  };
}

interface BrowserRun {
  bodies: { url: string; body: string }[];
  statuses: number[];
  refused: string[];
  page: Record<string, unknown>;
}

/**
 * Loads `html` on the site's origin in a real Chromium (tracker npm build and the SDK bundle served from the same
 * origin; the stand-in providers by interception; the ingest hosts through the CONNECT proxy to the gateway), waits
 * for `__done`, then until `sent(events)` holds; with `hidden`, then makes the page hidden (see below) and waits until
 * `hidden(events)` holds; finally waits until every event batch has its answer.
 *
 * The page is made hidden by giving `document.visibilityState` the value `hidden` and dispatching `visibilitychange`,
 * which runs the tracker's and `/stellar-rpc`'s own hide handlers unchanged. Leaving the page instead does not work
 * here: while request interception (`page.route`) is on, Playwright's Chromium drops the keepalive requests a page
 * sends from `pagehide` (checked 2026-11-19 with a bare page: delivered without interception, lost with it).
 */
async function runPage(
  origin: string,
  html: string,
  sent: (events: Record<string, unknown>[]) => boolean,
  readBack: string[] = [],
  hidden?: (events: Record<string, unknown>[]) => boolean,
): Promise<BrowserRun> {
  const gw = new URL(env.gatewayUrl);
  const proxy = await startIngestProxy(env.ingestHosts, gw.hostname, Number(gw.port));
  const b = await launch("chromium", proxy.url);
  const bodies: BrowserRun["bodies"] = [];
  const statuses: number[] = [];
  const page: Record<string, unknown> = {};
  try {
    // a desktop Chrome User-Agent of the running major: headless Chromium's own (`HeadlessChrome`) is a bot UA, and
    // its events would be rejected (ua_bot) and never counted
    const major = Number(b.version().split(".")[0]);
    const p: Page = await (
      await context(b, { userAgent: CHROME_UA(major, "Windows NT 10.0; Win64; x64") })
    ).newPage();
    await p.route(`${origin}/**`, (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path === "/")
        return r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      if (path === SDK_PATH)
        return r.fulfill({
          status: 200,
          contentType: "text/javascript; charset=utf-8",
          body: readFileSync(SDK_BUNDLE),
        });
      if (!path.startsWith(`${NPM_BASE}/`)) return r.fulfill({ status: 404, body: "" });
      const file = normalize(join(NPM, path.slice(NPM_BASE.length)));
      if (!file.startsWith(NPM) || !statSync(file, { throwIfNoEntry: false })?.isFile())
        return r.fulfill({ status: 404, body: "" });
      return r.fulfill({
        status: 200,
        contentType: CONTENT[extname(file)] ?? "application/octet-stream",
        body: readFileSync(file),
      });
    });
    for (const [o, answer] of [
      [RPC_ORIGIN, (q: Request) => rpcAnswer(q.postData() ?? "")],
      [HORIZON_ORIGIN, (q: Request) => horizonAnswer(new URL(q.url()).pathname)],
    ] as const) {
      await p.route(`${o}/**`, (r) => {
        const q = r.request();
        if (q.method() === "OPTIONS")
          return r.fulfill({ status: 204, headers: CORS(origin), body: "" });
        const a = answer(q);
        return r.fulfill({
          status: a.status,
          headers: { ...CORS(origin), "content-type": "application/json" },
          body: JSON.stringify(a.json),
        });
      });
    }
    const onIngest = (q: Request) => env.ingestHosts.includes(new URL(q.url()).hostname);
    p.on("request", (q) => {
      if (onIngest(q)) bodies.push({ url: q.url(), body: q.postData() ?? "" });
    });
    p.on("response", (r) => {
      if (onIngest(r.request()) && r.url().endsWith("/v1/e")) statuses.push(r.status());
    });
    await p.goto(`${origin}/`);
    await p.waitForFunction(
      () => (window as unknown as { __done?: boolean }).__done === true,
      null,
      {
        timeout: 60_000,
      },
    );
    for (const k of ["__steps", ...readBack])
      page[k] = await p.evaluate((n) => (window as unknown as Record<string, unknown>)[n], k);
    for (let i = 0; i < 120 && !sent(sentEvents(bodies)); i++) await sleep(500);
    if (hidden) {
      await p.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      for (let i = 0; i < 120 && !hidden(sentEvents(bodies)); i++) await sleep(500);
    }
    const batches = () => bodies.filter((x) => x.url.endsWith("/v1/e")).length;
    for (let i = 0; i < 60 && statuses.length < batches(); i++) await sleep(250);
  } finally {
    await b.close();
    await proxy.close();
  }
  return { bodies, statuses, refused: proxy.refused, page };
}

/** The `wl` events that left the browser, de-duplicated by event id (a retried batch repeats them). */
function sentEvents(bodies: BrowserRun["bodies"]): Record<string, unknown>[] {
  const seen = new Map<string, Record<string, unknown>>();
  for (const x of bodies) {
    if (!x.url.endsWith("/v1/e")) continue;
    let batch: { e?: Record<string, unknown>[] };
    try {
      batch = JSON.parse(x.body);
    } catch {
      continue;
    }
    for (const e of batch.e ?? []) if (e.k === "wl") seen.set(String(e.id), e);
  }
  return [...seen.values()];
}

/** v1 wallet events without the transport fields (`id`, `k`, `sv`, `u`); every one must carry `sv: 1`. */
function walletEvents(bodies: BrowserRun["bodies"]): SentEvent[] {
  return sentEvents(bodies)
    .filter((e) => e.n !== "stellar_rpc")
    .map((e) => {
      expect(e.sv, `schema version of ${String(e.n)}`).toBe(1);
      const { id: _i, k: _k, sv: _s, u: _u, ...rest } = e;
      return rest as SentEvent;
    });
}

/** Privacy checks on what left the browser: no canary, no StrKey, every batch accepted, no other egress. */
function assertBrowserPrivacy(run: BrowserRun, label: string): void {
  const canaries = asPathCanaries(c);
  const leaks = run.bodies.flatMap((x) =>
    canaries
      .filter((k) => x.body.includes(k.value))
      .map((k) => `${k.label} in a request to ${new URL(x.url).pathname}`),
  );
  expect(leaks, label).toEqual([]);
  for (const x of run.bodies) expect(x.body, x.url).not.toMatch(/[GCMSTXPLBW][A-Z2-7]{55}/);
  expect(run.statuses.length, `${label}: answered batches`).toBeGreaterThanOrEqual(1);
  expect(
    run.statuses.every((s) => s === 202),
    `${label}: statuses ${run.statuses.join(",")}`,
  ).toBe(true);
  expect(run.refused, `${label}: requests the proxy refused (no egress)`).toEqual([]);
}

/** The site's rows of the wallet-event rollup, `event|network|key|value` → count, and the verdicts seen. */
async function rollup(
  siteId: string,
): Promise<{ rows: Record<string, number>; verdicts: string[] }> {
  const r = await compose.sql(
    "scf",
    `SELECT event_name, network, prop_key, prop_value, verdict, sum(count)::bigint FROM scf.web_event_property_daily
      WHERE site_id = '${siteId}' GROUP BY 1, 2, 3, 4, 5`,
  );
  const rows: Record<string, number> = {};
  const verdicts = new Set<string>();
  for (const [e, n, k, v, verdict, count] of r) {
    const key = `${e}|${n}|${k}|${v}`;
    rows[key] = (rows[key] ?? 0) + Number(count);
    verdicts.add(verdict as string);
  }
  return { rows, verdicts: [...verdicts].sort() };
}

const sortedEntries = (o: Record<string, number>) =>
  Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1));

/** Waits until the rollup equals `want` exactly, then one more counter period to catch a double count. */
async function expectRollup(siteId: string, want: Record<string, number>): Promise<void> {
  await eventually(
    "the rollup equals what was sent",
    async () => sortedEntries((await rollup(siteId)).rows),
    (got) => JSON.stringify(got) === JSON.stringify(sortedEntries(want)),
    90_000,
    2000,
  );
  await sleep(7000);
  const r = await rollup(siteId);
  expect(sortedEntries(r.rows)).toEqual(sortedEntries(want));
  expect(r.verdicts, "real Chromium after the proof of work: verified only").toEqual(["verified"]);
}

/** getSiteWalletFunnel (today, all networks) must equal the rollup the sent events produce, step by step. */
async function expectFunnel(f: Fixture, siteId: string, want: Record<string, number>) {
  const now = Date.now();
  const q = `start=${midnight(now)}&end=${midnight(now + DAY)}&network=all`;
  const steps = FUNNEL.map((event) => {
    let count = 0;
    const by_wallet: Record<string, number> = {};
    const by_property: Record<string, Record<string, number>> = {};
    for (const [k, n] of Object.entries(want)) {
      const [e, , key, value] = k.split("|") as [string, string, string, string];
      if (e !== event) continue;
      if (key === "_total") count += n;
      else if (key === "wallet") by_wallet[value] = (by_wallet[value] ?? 0) + n;
      else {
        const m = by_property[key] ?? {};
        m[value] = (m[value] ?? 0) + n;
        by_property[key] = m;
      }
    }
    return { event, count, by_wallet, by_property };
  });
  for (const variant of ["verified", "raw"]) {
    const body = await f.cp.json<{
      schema: string;
      steps: { event: string; count: number; by_wallet: object; by_property: object }[];
    }>(
      "GET",
      `/v1/tenants/${f.tenantId}/sites/${siteId}/web/wallet-funnel?${q}&variant=${variant}`,
    );
    expect(body.schema).toBe("scf-stellar-events/1");
    expect(body.steps, `wallet funnel (${variant})`).toEqual(steps);
  }
  return steps.filter((s) => s.count > 0).map((s) => `${s.event} ${s.count}`);
}

/** No counted-only event and no RPC aggregate ever reaches the event engine for this site. */
async function expectNotInEngine(siteId: string, names: string[]): Promise<void> {
  const ids = (
    await compose.sql(
      "scf",
      `SELECT umami_website_id, umami_twin_website_id FROM scf.sites WHERE site_id = '${siteId}'`,
    )
  )
    .flat()
    .filter((x): x is string => !!x);
  const n = await compose.scalar(
    "umami",
    `SELECT count(*) FROM website_event WHERE website_id IN (${ids.map((i) => `'${i}'`).join(",")})
       AND event_name IN (${names.map((x) => `'${x}'`).join(",")})`,
  );
  expect(n, `events ${names.join(", ")} in the event engine`).toBe("0");
}

describe("tracker 1.2.0 paths (whole stack)", () => {
  it("browser RPC/Horizon aggregates: exact totals per method and outcome in the tenant API, no visitor link", async (ctx) => {
    const d = rec.start(ctx, [
      "feature.wallets-kit-autocapture",
      "privacy.gdpr-no-consent",
      "privacy.minimal-erasure-scope",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const { f, s } = await setup("rpc");
    const html = rpcPage(s.site_key, c, importMap(), SDK_PATH);
    const aggregates = (ev: Record<string, unknown>[]) =>
      ev.filter((e) => e.n === "stellar_rpc").length;
    const run = await runPage(
      s.origin,
      html,
      (ev) => aggregates(ev) >= 1,
      ["__results", "__flushed", "__cells1", "__cells2"],
      (ev) => aggregates(ev) >= 2,
    );
    rec.data.rpcSteps = run.page.__steps;
    rec.data.rpcResults = run.page.__results;
    expect(run.page.__steps, "both phases ran").toEqual(["phase1", "phase2"]);
    expect(run.page.__flushed, "the running tracker took the phase-1 aggregate").toBe(true);
    // the SDK's own outcome of each call (the stand-ins answer ok, a JSON-RPC error, 429, 503 and 404)
    expect(run.page.__results).toEqual([
      ["getHealth", "ok"],
      ["getHealth", "ok"],
      ["getHealth", "ok"],
      ["getNetwork", "ok"],
      ["getNetwork", "ok"],
      ["getTransaction", "failed"],
      ["getFeeStats", "failed"],
      ["getVersionInfo", "failed"],
      ["ledgers", "ok"],
      ["ledgers", "ok"],
      ["account", "ok"],
      ["transaction", "failed"],
      ["getHealth", "ok"],
      ["ledgers", "ok"],
    ]);
    assertBrowserPrivacy(run, "rpc");

    // exactly two aggregates left the browser: the explicit flush and the hide flush
    const sent = sentEvents(run.bodies).filter((e) => e.n === "stellar_rpc");
    expect(sent.length, "aggregates sent").toBe(2);
    const cells = sent.flatMap((e) => e.c as [string, string, string, string, string, number][]);
    for (const e of sent)
      expect(Object.keys(e).sort(), "aggregate fields").toEqual(["c", "id", "k", "n", "sv", "u"]);
    const want = new Map<string, { calls: number; outcomes: Record<string, number> }>();
    for (const [api, op, net, outcome, , n] of cells) {
      expect(net).toBe("testnet");
      const w = want.get(`${api}|${op}`) ?? { calls: 0, outcomes: {} };
      w.calls += n;
      w.outcomes[outcome] = (w.outcomes[outcome] ?? 0) + n;
      want.set(`${api}|${op}`, w);
    }
    expect(Object.fromEntries(want)).toEqual({
      "rpc|get_health": { calls: 4, outcomes: { ok: 4 } },
      "rpc|get_network": { calls: 2, outcomes: { ok: 2 } },
      "rpc|get_transaction": { calls: 1, outcomes: { rpc_error: 1 } },
      "rpc|get_fee_stats": { calls: 1, outcomes: { http_429: 1 } },
      "rpc|get_version_info": { calls: 1, outcomes: { http_5xx: 1 } },
      "horizon|ledgers": { calls: 3, outcomes: { ok: 3 } },
      "horizon|accounts_id": { calls: 1, outcomes: { ok: 1 } },
      "horizon|transactions_id": { calls: 1, outcomes: { http_4xx: 1 } },
    });

    // the tenant API: exact totals, per-operation calls and outcomes, one network, today's daily point
    const now = Date.now();
    const q = `start=${midnight(now)}&end=${midnight(now + DAY)}`;
    type Report = {
      totals: { calls: number; errors: number; rpc: number; horizon: number };
      networks: { network: string; calls: number }[];
      operations: {
        api: string;
        operation: string;
        calls: number;
        errors: number;
        outcomes: { outcome: string; count: number }[];
        latency: Record<string, number>;
      }[];
      daily: { day: string; rpc: number; horizon: number; errors: number }[];
    };
    const path = `/v1/tenants/${f.tenantId}/sites/${s.site_id}/web/browser-rpc?${q}`;
    const totals = { calls: 14, errors: 4, rpc: 9, horizon: 5 };
    await eventually(
      "browser RPC totals in the tenant API",
      async () => (await f.cp.json<Report>("GET", `${path}&variant=verified`)).totals,
      (t) => JSON.stringify(t) === JSON.stringify(totals),
      90_000,
      2000,
    );
    await sleep(7000); // one more counter period: nothing is counted twice
    for (const variant of ["verified", "raw"]) {
      const r = await f.cp.json<Report>("GET", `${path}&variant=${variant}`);
      expect(r.totals, variant).toEqual(totals);
      expect(r.networks).toEqual([{ network: "testnet", calls: 14 }]);
      const ops = Object.fromEntries(
        r.operations.map((o) => [
          `${o.api}|${o.operation}`,
          {
            calls: o.calls,
            outcomes: Object.fromEntries(o.outcomes.map((x) => [x.outcome, x.count])),
          },
        ]),
      );
      expect(ops).toEqual(Object.fromEntries(want));
      for (const o of r.operations) {
        expect(o.errors).toBe(
          o.outcomes.filter((x) => x.outcome !== "ok").reduce((a, x) => a + x.count, 0),
        );
        expect(Object.values(o.latency).reduce((a, n) => a + n, 0)).toBe(o.calls);
      }
      expect(r.daily.filter((x) => x.rpc + x.horizon > 0)).toEqual([
        { day: midnight(now).slice(0, 10), rpc: 9, horizon: 5, errors: 4 },
      ]);
    }
    rec.data.rpcTotals = totals;

    // no link to a visitor or session: the table has no such column, the aggregate never reaches the event engine
    // (where visitors and sessions live), and no wallet event was made of it
    const cols = (
      await compose.sql(
        "scf",
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'scf' AND table_name = 'web_rpc_client_daily' ORDER BY column_name`,
      )
    ).map((x) => x[0]);
    expect(cols).toEqual([
      "api",
      "count",
      "day",
      "latency",
      "network",
      "operation",
      "outcome",
      "site_id",
      "tenant_id",
      "verdict",
    ]);
    await expectNotInEngine(s.site_id, ["stellar_rpc"]);
    expect(
      await compose.scalar(
        "scf",
        `SELECT count(*) FROM scf.web_event_property_daily WHERE site_id = '${s.site_id}'`,
      ),
    ).toBe("0");
    d.detail(
      `${run.bodies.length} requests to the ingest hosts, 2 aggregates (${cells.length} cells); tenant API: ${totals.calls} calls (${totals.rpc} RPC, ${totals.horizon} Horizon), ${totals.errors} errors, ${want.size} operations, exact for verified and raw; nothing in the event engine`,
    );
  }, 300_000);

  it("wallet_connect_failed, the wallet context and the WalletConnect funnel: exact rollup and funnel counts", async (ctx) => {
    const d = rec.start(ctx, [
      "feature.wallets-kit-autocapture",
      "privacy.gdpr-no-consent",
      "privacy.minimal-erasure-scope",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const { f, s } = await setup("wallets");
    const expected: SentEvent[] = [
      // Freighter: rejected, locked, then connected inside Varial Mobile's in-app browser
      {
        n: "wallet_connect_failed",
        wt: "freighter",
        net: "testnet",
        fr: "user_rejected",
        wc: "none",
      },
      {
        n: "wallet_connect_failed",
        wt: "freighter",
        net: "testnet",
        fr: "wallet_locked",
        wc: "none",
      },
      { n: "wallet_connect", wt: "freighter", net: "testnet", ck: "new", wc: "varial_inapp" },
      // WalletConnect: a rejected session proposal, an approved one inside D'CENT, two requests, a disconnect
      { n: "walletconnect_session", ws: "proposed", net: "testnet", wc: "none" },
      { n: "walletconnect_session", ws: "rejected", net: "testnet", wc: "none" },
      {
        n: "wallet_connect_failed",
        wt: "walletconnect",
        net: "testnet",
        fr: "user_rejected",
        wc: "none",
      },
      { n: "walletconnect_session", ws: "proposed", net: "testnet", wc: "dcent_inapp" },
      { n: "walletconnect_session", ws: "approved", net: "testnet", wc: "dcent_inapp" },
      { n: "wallet_connect", wt: "walletconnect", net: "testnet", ck: "new", wc: "dcent_inapp" },
      { n: "sign_requested", wt: "walletconnect", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "walletconnect", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "walletconnect_request", wm: "sign_xdr", net: "testnet", ws: "approved" },
      { n: "sign_requested", wt: "walletconnect", net: "testnet", sk: "message" },
      {
        n: "sign_rejected",
        wt: "walletconnect",
        net: "testnet",
        sk: "message",
        dur: "lt5s",
        ec: "user_rejected",
      },
      { n: "walletconnect_request", wm: "sign_message", net: "testnet", ws: "rejected" },
      { n: "wallet_disconnect", wt: "walletconnect", net: "testnet" },
    ];
    const run = await runPage(
      s.origin,
      walletsPage(s.site_key, c, importMap()),
      (ev) => ev.filter((e) => e.k === "wl").length >= expected.length,
    );
    expect(run.page.__steps).toEqual(["freighter", "walletconnect"]);
    assertBrowserPrivacy(run, "wallets");
    const sent = walletEvents(run.bodies);
    expect(sent.map(eventKey).sort()).toEqual(expected.map(eventKey).sort());

    const want = expectedRollup(sent);
    await expectRollup(s.site_id, want);
    const steps = await expectFunnel(f, s.site_id, want);
    await expectNotInEngine(s.site_id, COUNTED_ONLY);
    rec.data.walletsRollup = want;
    d.detail(
      `${sent.length} wallet events sent; rollup exact (${Object.keys(want).length} cells: wallet_connect_failed 3 — freighter 2, walletconnect 1; walletconnect_session 4; walletconnect_request 2; wallet_context varial_inapp 1, dcent_inapp 3); funnel API exact: ${steps.join(", ")}`,
    );
  }, 300_000);

  it("Privy wrapper (stand-in hooks): exact funnel counts for wt privy", async (ctx) => {
    const d = rec.start(ctx, [
      "feature.wallets-kit-autocapture",
      "privacy.gdpr-no-consent",
      "privacy.minimal-erasure-scope",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const { f, s } = await setup("privy");
    const expected: SentEvent[] = [
      { n: "wallet_connect_failed", wt: "privy", net: "testnet", fr: "user_rejected", wc: "none" },
      { n: "wallet_connect", wt: "privy", net: "testnet", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "privy", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "privy", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "privy", net: "testnet", sk: "tx" },
      {
        n: "sign_rejected",
        wt: "privy",
        net: "testnet",
        sk: "tx",
        dur: "lt5s",
        ec: "user_rejected",
      },
      { n: "wallet_disconnect", wt: "privy", net: "testnet" },
      { n: "wallet_connect", wt: "privy", net: "testnet", ck: "restored", wc: "none" },
    ];
    const run = await runPage(
      s.origin,
      privyPage(s.site_key, c, importMap()),
      (ev) => ev.filter((e) => e.k === "wl").length >= expected.length,
    );
    expect(run.page.__steps).toEqual(["privy"]);
    assertBrowserPrivacy(run, "privy");
    const sent = walletEvents(run.bodies);
    expect(sent.map(eventKey).sort()).toEqual(expected.map(eventKey).sort());
    const want = expectedRollup(sent);
    await expectRollup(s.site_id, want);
    const steps = await expectFunnel(f, s.site_id, want);
    await expectNotInEngine(s.site_id, COUNTED_ONLY);
    d.detail(`${sent.length} Privy events sent; rollup and funnel API exact: ${steps.join(", ")}`);
  }, 300_000);

  it("Wallets Kit module wrapper wrapWalletsKitModules: exact funnel counts per wallet module", async (ctx) => {
    const d = rec.start(ctx, [
      "feature.wallets-kit-autocapture",
      "privacy.gdpr-no-consent",
      "privacy.minimal-erasure-scope",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const { f, s } = await setup("modules");
    const expected: SentEvent[] = [
      {
        n: "wallet_connect_failed",
        wt: "xbull",
        net: "testnet",
        fr: "wallet_not_installed",
        wc: "none",
      },
      { n: "wallet_connect", wt: "lobstr", net: "testnet", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "lobstr", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "lobstr", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "lobstr", net: "testnet", sk: "auth_entry" },
      {
        n: "sign_rejected",
        wt: "lobstr",
        net: "testnet",
        sk: "auth_entry",
        dur: "lt5s",
        ec: "user_rejected",
      },
      { n: "sign_requested", wt: "lobstr", net: "testnet", sk: "tx_submit" },
      { n: "sign_approved", wt: "lobstr", net: "testnet", sk: "tx_submit", dur: "lt5s" },
      { n: "tx_submitted", wt: "lobstr", net: "testnet", rc: "success" },
      { n: "wallet_disconnect", wt: "lobstr", net: "testnet" },
      { n: "wallet_connect", wt: "freighter", net: "testnet", ck: "new", wc: "none" },
    ];
    const run = await runPage(
      s.origin,
      modulesPage(s.site_key, c, importMap()),
      (ev) => ev.filter((e) => e.k === "wl").length >= expected.length,
    );
    expect(run.page.__steps).toEqual(["modules"]);
    assertBrowserPrivacy(run, "modules");
    const sent = walletEvents(run.bodies);
    expect(sent.map(eventKey).sort()).toEqual(expected.map(eventKey).sort());
    const want = expectedRollup(sent);
    await expectRollup(s.site_id, want);
    const steps = await expectFunnel(f, s.site_id, want);
    await expectNotInEngine(s.site_id, COUNTED_ONLY);
    d.detail(`${sent.length} module events sent; rollup and funnel API exact: ${steps.join(", ")}`);
  }, 300_000);

  it("React Native helper in Node → /v1/app-events: exact counters in getAppEvents, drops counted, nothing kept", async (ctx) => {
    const d = rec.start(ctx, [
      "feature.wallets-kit-autocapture",
      "privacy.gdpr-no-consent",
      "privacy.minimal-erasure-scope",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);
    const { f, s } = await setup("app");
    // values the helper's own checks let through but the edge must drop: a run of ≥ 6 digits (`unsafe`) and a
    // hex-like token (`value_shape`, §a.9) — both look like user ids and must never be stored
    const digits = `u${String(Math.floor(Math.random() * 1e12)).padStart(12, "7")}`;
    const hexish = `a${tag()}${tag()}`
      .slice(0, 24)
      .replace(/[0-9]/g, (x) => "abcdef"[Number(x) % 6] as string);
    const posted: { status: number; body: string; answer: string }[] = [];
    // the helper's `fetch` option: the same request over node:https to the gateway, with the ingest host as SNI
    const fetchVia = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const body = String(init?.body ?? "");
      const r = await request(`${env.gatewayUrl}${u.pathname}`, {
        method: init?.method ?? "POST",
        headers: { "content-type": "application/json" },
        body,
        servername: u.hostname,
        caFile: env.gatewayCaFile,
      });
      posted.push({ status: r.status, body, answer: r.body });
      return new Response(r.body, { status: r.status });
    }) as typeof fetch;
    const app = createUsageMapApp({
      siteKey: s.site_key,
      platform: "ios",
      appVersion: "1.4.2-beta+77",
      endpoint: `https://${env.ingestHosts[0]}/v1/app-events`,
      batchSize: 20,
      fetch: fetchVia,
    });
    const tracked = [
      app.track("app_open"),
      app.track("app_open"),
      app.track("app_open"),
      app.track("swap_started", { pair_class: "stable" }),
      app.track("swap_started", { pair_class: "stable" }),
      app.track("screen_view", { screen: "home" }),
      app.track("login", { user: digits }),
      app.track("login", { user: hexish }),
      // refused by the helper itself (never sent): a G-address and an e-mail address
      app.track("login", { user: c.account }),
      app.track(c.privyEmail),
    ];
    expect(tracked).toEqual([true, true, true, true, true, true, true, true, false, false]);
    await app.flush();
    expect(app.pending()).toBe(0);
    expect(posted.map((p) => [p.status, JSON.parse(p.answer)])).toEqual([
      [202, { accepted: 6, dropped: 2 }],
    ]);
    const batch = JSON.parse(posted[0]?.body ?? "{}") as { events: { session: string }[] };
    const session = batch.events[0]?.session ?? "";
    expect(session).toMatch(/^[A-Za-z0-9_-]{16}$/);
    for (const v of [digits, hexish]) expect(posted[0]?.body).toContain(v);
    appCanaries.push(
      { label: "app events: session id", value: session },
      { label: "app events: digit-run user id (dropped unsafe)", value: digits },
      { label: "app events: hex-like user id (dropped value_shape)", value: hexish },
    );
    recordCanaries(env.workDir, "inventory/tracker-paths-app", appCanaries);

    type AppEvents = {
      attestation: string;
      range: { label: string };
      totals: { events: number; sessions: number; dropped: number };
      sites: { site_id: string; events: number; sessions: number }[];
      platforms: { platform: string; events: number; sessions: number }[];
      events: { event: string; count: number; platforms: Record<string, number> }[];
      properties: { event: string; key: string; value: string; count: number }[];
      app_versions: { version: string; count: number }[];
      sdk_versions: { sdk: string; count: number }[];
      tma_platforms: unknown[];
      dropped: { reason: string; count: number }[];
    };
    const path = `/v1/tenants/${f.tenantId}/app-events?range=24h&site_id=${s.site_id}`;
    const totals = { events: 6, sessions: 1, dropped: 2 };
    await eventually(
      "app-event totals in the tenant API",
      async () => (await f.cp.json<AppEvents>("GET", path)).totals,
      (t) => JSON.stringify(t) === JSON.stringify(totals),
      90_000,
      2000,
    );
    await sleep(7000);
    const r = await f.cp.json<AppEvents>("GET", path);
    expect(r.attestation).toBe("self_attested");
    expect(r.range.label).toBe("self-attested (app events are not verified)");
    expect(r.totals).toEqual(totals);
    expect(r.sites).toEqual([{ site_id: s.site_id, events: 6, sessions: 1 }]);
    expect(r.platforms.filter((p) => p.events + p.sessions > 0)).toEqual([
      { platform: "ios", events: 6, sessions: 1 },
    ]);
    const byName = Object.fromEntries(r.events.map((e) => [e.event, [e.count, e.platforms]]));
    expect(byName).toEqual({
      app_open: [3, { ios: 3, android: 0, web: 0 }],
      swap_started: [2, { ios: 2, android: 0, web: 0 }],
      screen_view: [1, { ios: 1, android: 0, web: 0 }],
    });
    expect(r.properties.map((p) => `${p.event}/${p.key}/${p.value}=${p.count}`).sort()).toEqual([
      "screen_view/screen/home=1",
      "swap_started/pair_class/stable=2",
    ]);
    expect(r.app_versions).toEqual([{ version: "1.4.2", count: 1 }]);
    expect(r.sdk_versions).toEqual([{ sdk: "mobile-rn/0.1.0", count: 1 }]);
    expect(r.tma_platforms).toEqual([]);
    expect(r.dropped.map((x) => `${x.reason}=${x.count}`).sort()).toEqual([
      "unsafe=1",
      "value_shape=1",
    ]);
    // self-attested counts never reach the web side
    expect(
      await compose.scalar(
        "scf",
        `SELECT count(*) FROM scf.web_event_property_daily WHERE site_id = '${s.site_id}'`,
      ),
    ).toBe("0");
    await expectNotInEngine(s.site_id, ["app_open", "swap_started", "screen_view", "login"]);
    d.detail(
      `helper accepted 8 of 10 events locally; gateway 202 {accepted 6, dropped 2}; tenant API: ${totals.events} events, ${totals.sessions} session, dropped unsafe 1 + value_shape 1, app 1.4.2, sdk mobile-rn/0.1.0, platform ios`,
    );
  }, 300_000);

  it("no canary of these paths in either database or any container log", async (ctx) => {
    const d = rec.start(ctx, [
      "privacy.gdpr-no-consent",
      "privacy.minimal-erasure-scope",
      "isolation.tenant-rls",
    ]);
    await requires(env, ctx, ["compose", "docker"]);
    const canaries = [...asPathCanaries(c), ...appCanaries];
    const inputs = [];
    for (const db of ["scf", "umami"] as const)
      inputs.push({ source: `pg_dump:${db}`, text: await compose.pgDump(db) });
    for (const svc of await compose.services(true))
      inputs.push({ source: `log:${svc}`, text: await compose.logs(svc) });
    // canaries only here; the generic shapes (addresses, User-Agents, …) are the full scan's job (90-inventory)
    const res = scan(inputs, canaries, []);
    const found = res.findings.filter((x) => x.kind === "canary");
    d.detail(
      `${inputs.length} sources, ${res.bytesScanned} bytes, ${canaries.length} canaries, ${found.length} canary findings`,
    );
    expect(found.map((x) => `${x.source} ${x.label} ${x.masked} ${x.context}`)).toEqual([]);
  }, 600_000);
});
