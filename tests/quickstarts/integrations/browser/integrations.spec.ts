// SPDX-License-Identifier: Apache-2.0
// The browser integration examples (examples/<id>, apps.ts), built for production and driven in Chromium. Every
// request to the two ingest hosts goes to the protocol-v1 mock gateway of the tracker's browser suite
// (tracker/e2e/lib/gateway.ts: real challenge tokens, proof of work verified, every body validated against the
// contract's JSON Schemas). Third parties are local stand-ins: an emulated wallet extension (Hana for the kit, the
// Freighter content-script protocol for freighter-api), a JSON-RPC stand-in for Stellar RPC, Chromium's virtual
// WebAuthn authenticator for passkeys, a stub of telegram-web-app.js and of the app-events edge. For each example:
//
//   - the UsageMap call is made: the landing page view, plus the integration's own schema-v1 events (closed names
//     and enum values, compared exactly);
//   - nothing the integration handles leaves the page: canary addresses, XDR, signatures, passphrases, Telegram
//     initData — and only paths, never a query string or fragment;
//   - no request to any other host than the ones the example documents.
//
// What cannot run offline is said per test (WalletConnect's relay, Privy's login service).

import { expect, type Page, type Route, test } from "@playwright/test";
import {
  collectErrors,
  type Event,
  expectClean,
  expectPageviews,
  type MockGateway,
  mockGateway,
  SITE,
} from "../../../../tracker/e2e/lib/gateway.ts";
import { CANARY } from "../../../../tracker/test/canary.ts";
import type { App } from "../../frameworks/apps.ts";
import { proxyOrigin, type Running, serve } from "../../frameworks/server.ts";
import { APP_EVENTS_URL, type BrowserApp, RPC_URL, selected } from "./apps.ts";

const TESTNET = "Test SDF Network ; September 2015";

/** Every request to a host the test does not answer is refused and recorded. */
async function isolate(page: Page): Promise<string[]> {
  const foreign: string[] = [];
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    foreign.push(`${route.request().method()} ${u.origin}${u.pathname}`);
    return route.abort("blockedbyclient");
  });
  // WebSockets (WalletConnect's relay) are not routes: refuse and record them too
  await page.routeWebSocket(/.*/, (ws) => {
    const u = new URL(ws.url());
    foreign.push(`WS ${u.origin}${u.pathname}`);
    ws.close();
  });
  return foreign;
}

/** Schema-v1 wallet events (`k: "wl"`) without id, kind, path and schema version. */
const stellarEvents = (gw: MockGateway) =>
  gw
    .events()
    .filter((e: Event) => e.k === "wl")
    .map(({ id: _id, k: _k, u: _u, sv, ...rest }) => {
      expect(sv).toBe(1);
      return rest;
    });

/** No canary value, StrKey, hash, XDR or passphrase in anything sent to the gateway. */
function expectNoCanary(gw: MockGateway): void {
  for (const s of gw.seen) {
    if (s.kind === "script") continue;
    const raw = JSON.stringify(s.body);
    for (const v of Object.values(CANARY)) expect(raw).not.toContain(v);
    expect(raw).not.toMatch(
      /[GCMSTXPLBW][A-Z2-7]{55}|[0-9a-f]{64}|AAAA[A-Za-z0-9+/]{16,}|September 2015/,
    );
  }
}

/** Serves one built example (its `dist/`) and starts each test with the isolation, mock gateway and origin proxy. */
function describeApp(
  id: string,
  title: string,
  body: (open: (page: Page) => Promise<Opened>) => void,
): void {
  const app = selected(id);
  test.describe(`examples/${id} (${title})`, () => {
    test.describe.configure({ mode: "default" });
    test.skip(!app, "not selected (QS_BROWSER_INTEGRATIONS)");
    let server: Running;
    test.beforeAll(async () => {
      if (app) server = await serve(asStatic(app), SITE);
    });
    test.afterAll(async () => {
      await server?.stop();
    });
    body(async (page) => {
      const origin = `https://${id}.site.test`;
      const foreign = await isolate(page);
      const gw = await mockGateway(page);
      await proxyOrigin(page, origin, server.port);
      const errors = collectErrors(page);
      return { origin, foreign, gw, errors };
    });
  });
}

interface Opened {
  origin: string;
  foreign: string[];
  gw: MockGateway;
  errors: string[];
}

/** The frameworks suite's static server serves `examples/<id>/dist` with an index.html fallback. */
const asStatic = (app: BrowserApp): App => ({
  id: app.id,
  guide: app.guide,
  install: "npm",
  serve: "spa",
  out: "dist",
  clientNav: false,
  about: "/",
});

const log = (page: Page) => page.locator("#log");

// --- Stellar Wallets Kit ---

/** An emulated Hana wallet extension (the object the kit's Hana module calls), returning canary values. */
function hanaExtension(c: typeof CANARY): void {
  const w = window as unknown as { hanaWallet: unknown; qsReject?: boolean };
  const sign = async (signed: string) => {
    await new Promise((r) => setTimeout(r, 50));
    if (w.qsReject) throw { code: -4, message: c.MESSAGE };
    return signed;
  };
  w.hanaWallet = {
    stellar: {
      getPublicKey: async () => c.G,
      signTransaction: () => sign(c.XDR),
      signAuthEntry: () => sign(c.XDR),
      signMessage: () => sign(c.SIGNED_MESSAGE),
    },
  };
}

describeApp("wallets-kit", "vanilla Vite + Stellar Wallets Kit", (open) => {
  test("connect in the kit's modal, sign, reject, disconnect: each event once, no address", async ({
    page,
  }) => {
    const { origin, foreign, gw, errors } = await open(page);
    await page.addInitScript(hanaExtension, CANARY);
    await page.goto(`${origin}/`);
    await expectPageviews(gw, ["/"]);

    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByText("Hana Wallet", { exact: true }).click();
    await expect(log(page)).toHaveText("connect: ok");
    await page.getByRole("button", { name: "Sign message" }).click();
    await expect(log(page)).toHaveText("sign: ok");
    await page.evaluate(() => {
      (window as unknown as { qsReject: boolean }).qsReject = true;
    });
    await page.getByRole("button", { name: "Sign message" }).click();
    await expect(log(page)).toHaveText("sign: failed");
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(log(page)).toHaveText("disconnect: ok");

    await expect
      .poll(() => stellarEvents(gw).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(9);
    await page.waitForTimeout(400);
    // wrapWalletsKitModules + attachWalletsKit together: every moment is counted once
    expect(stellarEvents(gw)).toEqual([
      { n: "wallet_modal_opened" },
      { n: "wallet_selected", wt: "hana" },
      { n: "wallet_connect", wt: "hana", net: "testnet", ck: "new", wc: "none" },
      { n: "wallet_modal_closed", out: "connected", wt: "hana" },
      { n: "sign_requested", wt: "hana", net: "testnet", sk: "message" },
      { n: "sign_approved", wt: "hana", net: "testnet", sk: "message", dur: "lt5s" },
      { n: "sign_requested", wt: "hana", net: "testnet", sk: "message" },
      {
        n: "sign_rejected",
        wt: "hana",
        net: "testnet",
        sk: "message",
        dur: "lt5s",
        ec: "user_rejected",
      },
      { n: "wallet_disconnect", wt: "hana", net: "testnet" },
    ]);
    expectClean(gw);
    expectNoCanary(gw);
    // the kit's modal loads wallet icons from the kit's CDN; refused offline
    expect(foreign.filter((f) => !/\.(png|svg|jpe?g|webp)$/.test(f))).toEqual([]);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });
});

// --- Freighter (freighter-api, no kit) ---

/**
 * The Freighter extension's content script, emulated: freighter-api 6.0.0 posts `FREIGHTER_EXTERNAL_MSG_REQUEST`
 * messages to the page and waits for a `FREIGHTER_EXTERNAL_MSG_RESPONSE` with the same `messagedId`. Answers carry
 * canary values; `window.qsReject` makes the wallet decline (`apiError {code: -4}`).
 */
function freighterExtension(c: typeof CANARY): void {
  const w = window as unknown as { freighter: boolean; qsReject?: boolean };
  w.freighter = true;
  const declined = { code: -4, message: c.MESSAGE };
  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as { source?: string; messageId?: number; type?: string };
    if (e.source !== window || m?.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
    const answers: Record<string, Record<string, unknown>> = {
      REQUEST_ACCESS: { publicKey: c.G },
      REQUEST_PUBLIC_KEY: { publicKey: c.G },
      REQUEST_ALLOWED_STATUS: { isAllowed: true },
      REQUEST_CONNECTION_STATUS: { isConnected: true },
      REQUEST_NETWORK_DETAILS: {
        networkDetails: {
          network: "TESTNET",
          networkUrl: "https://horizon-testnet.stellar.org",
          networkPassphrase: "Test SDF Network ; September 2015",
        },
      },
      SUBMIT_BLOB: w.qsReject
        ? { apiError: declined }
        : { signedBlob: c.SIGNED_MESSAGE, signerAddress: c.G },
    };
    const answer = answers[m.type ?? ""] ?? { apiError: { code: -1, message: "unsupported" } };
    setTimeout(
      () =>
        window.postMessage(
          { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: m.messageId, ...answer },
          window.location.origin,
        ),
      30,
    );
  });
}

describeApp("freighter", "vanilla Vite + freighter-api", (open) => {
  test("connect, sign, a declined signature: wallet events through the wrapper, no address", async ({
    page,
  }) => {
    const { origin, foreign, gw, errors } = await open(page);
    await page.addInitScript(freighterExtension, CANARY);
    await page.goto(`${origin}/`);
    await expectPageviews(gw, ["/"]);

    await page.getByRole("button", { name: "Connect Freighter" }).click();
    await expect(log(page)).toHaveText("connect: ok");
    await page.getByRole("button", { name: "Sign message" }).click();
    await expect(log(page)).toHaveText("sign: ok");
    await page.evaluate(() => {
      (window as unknown as { qsReject: boolean }).qsReject = true;
    });
    await page.getByRole("button", { name: "Sign message" }).click();
    await expect(log(page)).toHaveText("sign: failed");

    await expect
      .poll(() => stellarEvents(gw).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(5);
    await page.waitForTimeout(400);
    expect(stellarEvents(gw)).toEqual([
      { n: "wallet_connect", wt: "freighter", net: "testnet", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "message" },
      { n: "sign_approved", wt: "freighter", net: "testnet", sk: "message", dur: "lt5s" },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "message" },
      {
        n: "sign_rejected",
        wt: "freighter",
        net: "testnet",
        sk: "message",
        dur: "lt5s",
        ec: "user_rejected",
      },
    ]);
    expectClean(gw);
    expectNoCanary(gw);
    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// --- Stellar RPC from the browser ---

/** A JSON-RPC stand-in for Stellar RPC: getHealth and getNetwork answer with fixed testnet values. */
async function rpcStandIn(page: Page): Promise<string[]> {
  const methods: string[] = [];
  await page.route(`${RPC_URL}/**`, (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "POST",
        },
      });
    const body = JSON.parse(req.postData() ?? "{}") as { id?: unknown; method?: string };
    methods.push(String(body.method));
    const results: Record<string, unknown> = {
      getHealth: {
        status: "healthy",
        latestLedger: 100,
        oldestLedger: 1,
        ledgerRetentionWindow: 17280,
      },
      getNetwork: {
        friendbotUrl: "https://friendbot.stellar.org/",
        passphrase: TESTNET,
        protocolVersion: 23,
      },
    };
    const result = results[String(body.method)];
    return route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*" },
      contentType: "application/json",
      body: JSON.stringify(
        result === undefined
          ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }
          : { jsonrpc: "2.0", id: body.id, result },
      ),
    });
  });
  return methods;
}

describeApp("stellar-rpc-browser", "vanilla Vite + js-stellar-sdk rpc.Server", (open) => {
  test("RPC calls become one aggregate on page hide: method, outcome, latency bucket; no URL", async ({
    page,
  }) => {
    const { origin, foreign, gw, errors } = await open(page);
    const methods = await rpcStandIn(page);
    await page.goto(`${origin}/`);
    await expectPageviews(gw, ["/"]);

    await page.getByRole("button", { name: "Check RPC health" }).click();
    await expect(log(page)).toHaveText("health: ok");
    await page.getByRole("button", { name: "Network" }).click();
    await expect(log(page)).toHaveText("network: ok");
    await page.getByRole("button", { name: "Check RPC health" }).click();
    await expect(log(page)).toHaveText("health: ok");
    expect(methods).toEqual(["getHealth", "getNetwork", "getHealth"]);
    expect(stellarEvents(gw)).toEqual([]); // nothing until the page is hidden

    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect.poll(() => stellarEvents(gw).length, { timeout: 15_000 }).toBe(1);
    expect(stellarEvents(gw)).toEqual([
      {
        n: "stellar_rpc",
        c: [
          ["rpc", "get_health", "testnet", "ok", "lt100ms", 2],
          ["rpc", "get_network", "testnet", "ok", "lt100ms", 1],
        ],
      },
    ]);
    expectClean(gw);
    expectNoCanary(gw);
    expect(JSON.stringify(gw.batches())).not.toContain("rpc.stellar.test");
    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// --- Telegram Mini App ---

/** A stub of telegram-web-app.js: `Telegram.WebApp` with a platform and initData that must never be sent. */
const TELEGRAM_STUB = `window.Telegram = { WebApp: {
  platform: "tdesktop",
  initData: "query_id=AAHqsCanaryQueryId&user=%7B%22id%22%3A987654321%7D&hash=${"ab".repeat(32)}",
  initDataUnsafe: { user: { id: 987654321, username: "qs_canary_user" } },
  ready() { window.qsReady = true; },
} };`;

describeApp("telegram-mini-app", "Telegram WebView + tracker + app events", (open) => {
  test("the page view is the path only; app events carry the Telegram client class, never initData", async ({
    page,
  }) => {
    const { origin, foreign, gw, errors } = await open(page);
    await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
      r.fulfill({ status: 200, contentType: "text/javascript", body: TELEGRAM_STUB }),
    );
    const appEvents: unknown[] = [];
    await page.route(APP_EVENTS_URL, (route) => {
      const req = route.request();
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
      };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      appEvents.push(JSON.parse(req.postData() ?? "null"));
      return route.fulfill({
        status: 202,
        headers: cors,
        contentType: "application/json",
        body: '{"accepted":1,"dropped":0}',
      });
    });
    // how Telegram opens a Mini App: start parameter in the query, launch data in the fragment
    await page.goto(
      `${origin}/?startapp=${CANARY.G}#tgWebAppData=user%3D987654321%26hash%3Dcafe&tgWebAppPlatform=tdesktop`,
    );
    await expectPageviews(gw, ["/"]);
    expect(await page.evaluate(() => (window as unknown as { qsReady?: boolean }).qsReady)).toBe(
      true,
    );

    await page.getByRole("button", { name: "Start swap" }).click();
    await expect(log(page)).toHaveText("swap: started");
    await expect.poll(() => appEvents.length, { timeout: 10_000 }).toBe(1);
    const batch = appEvents[0] as {
      events: { ts: number; session: string; name: string; props?: unknown }[];
    } & Record<string, unknown>;
    expect(Object.keys(batch).sort()).toEqual(
      ["app_version", "events", "k", "platform", "sdk_version", "tma_platform", "v"].sort(),
    );
    expect(batch).toMatchObject({
      v: 1,
      k: SITE,
      platform: "web",
      app_version: "1.0.0",
      sdk_version: "mobile-rn/0.1.0",
      tma_platform: "desktop",
    });
    expect(batch.events.map(({ name, props }) => ({ name, props }))).toEqual([
      { name: "mini_app_open", props: undefined },
      { name: "swap_started", props: { tier: "free" } },
    ]);
    expect(batch.events[0]?.session).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(batch.events[1]?.session).toBe(batch.events[0]?.session);

    const sent = JSON.stringify([gw.batches(), appEvents]);
    for (const v of ["987654321", "qs_canary_user", "AAHqsCanaryQueryId", "tgWebApp", "startapp"])
      expect(sent).not.toContain(v);
    expectClean(gw);
    expectNoCanary(gw);
    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// --- WalletConnect (the kit's WalletConnect module) ---

describeApp("walletconnect", "vanilla Vite + Wallets Kit WalletConnect module", (open) => {
  test("picking WalletConnect in the modal proposes a session (testnet); no relay is reachable offline", async ({
    page,
  }) => {
    const { origin, foreign, gw, errors } = await open(page);
    await page.goto(`${origin}/`);
    await expectPageviews(gw, ["/"]);
    await page.getByRole("button", { name: "Connect with WalletConnect" }).click();
    await page.getByText("WalletConnect", { exact: true }).click();
    await expect
      .poll(() => stellarEvents(gw).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(1000);
    // Offline the session proposal is never answered (the relay is refused), so the funnel stops at `proposed` — exactly
    // what UsageMap records for a session proposal nobody approves. Approve/reject and walletconnect_request need a real
    // relay and a phone wallet; the adapter's handling of those is covered by tracker/test/wallets-kit.test.ts.
    expect(stellarEvents(gw)).toEqual([
      { n: "wallet_modal_opened" },
      { n: "wallet_selected", wt: "walletconnect" },
      { n: "walletconnect_session", ws: "proposed", net: "testnet", wc: "none" },
    ]);
    expectClean(gw);
    expectNoCanary(gw);
    // WalletConnect / Reown's own services and the kit's icon CDN: refused offline, and never UsageMap hosts
    const documented =
      /^(GET|POST|WS) (https|wss):\/\/([a-z0-9-]+\.)*(walletconnect\.(org|com)|web3modal\.org|reown\.com|creit\.tech)\//;
    expect(foreign.filter((f) => !documented.test(f))).toEqual([]);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });
});

// --- Passkey smart account (smart-account-kit) ---

describeApp("passkey", "vanilla Vite + smart-account-kit", (open) => {
  test("a real passkey ceremony (virtual authenticator) is counted; the wallet address never leaves", async ({
    page,
  }) => {
    const { origin, foreign, gw, errors } = await open(page);
    // Chromium's virtual WebAuthn authenticator: the real smart-account-kit runs a real registration ceremony
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const rpc = await rpcStandIn(page);
    await page.goto(`${origin}/`);
    await expectPageviews(gw, ["/"]);

    // The passkey is created (credentialCreated); deploying the contract account then needs the testnet's ledger
    // entries, which the offline RPC stand-in does not have, so createWallet fails after the ceremony.
    await page.getByRole("button", { name: "Create wallet" }).click();
    await expect(log(page)).toHaveText("create: failed", { timeout: 20_000 });
    // A prompted connect: the passkey answers, but no deployed account exists → a connect failure.
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(log(page)).toHaveText("connect: failed", { timeout: 20_000 });
    expect(rpc.length, "the kit reached the RPC stand-in").toBeGreaterThan(0);

    await expect
      .poll(() => stellarEvents(gw).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(400);
    expect(stellarEvents(gw)).toEqual([
      { n: "passkey_used", po: "register", net: "testnet" },
      {
        n: "wallet_connect_failed",
        wt: "passkey",
        net: "testnet",
        fr: "error_other",
        wc: "none",
      },
    ]);
    expectClean(gw);
    expectNoCanary(gw); // includes the verifier contract address the kit was configured with
    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// --- Privy (React) ---

describeApp("privy", "Vite + React + @privy-io/react-auth", (open) => {
  test("the app runs with the wrapped Privy hooks: page view sent, only Privy's own hosts contacted", async ({
    page,
  }) => {
    const { origin, foreign, gw, errors } = await open(page);
    await page.goto(`${origin}/`);
    await expect(page.getByRole("heading", { name: /Privy/ })).toBeVisible();
    await expectPageviews(gw, ["/"]);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForTimeout(1500);
    // Privy cannot log in offline: its app configuration (auth.privy.io) is refused, so no Stellar wallet is created
    // and no wallet event is due. The wrapper's events on Privy-shaped hooks are covered by
    // tracker/test/connect-failed.test.ts; here the real app proves it builds, renders and sends nothing else.
    expect(stellarEvents(gw)).toEqual([]);
    expectClean(gw);
    expectNoCanary(gw);
    const documented =
      /^(GET|POST|WS) (https|wss):\/\/([a-z0-9-]+\.)*(privy\.io|walletconnect\.(org|com)|web3modal\.org|reown\.com)\//;
    expect(foreign.filter((f) => !documented.test(f))).toEqual([]);
    expect(foreign.some((f) => f.includes("auth.privy.io"))).toBe(true);
    // what Privy logs when its own service is unreachable
    expect(errors.filter((e) => !/Failed to load resource|Failed to fetch/.test(e))).toEqual([]);
  });
});
