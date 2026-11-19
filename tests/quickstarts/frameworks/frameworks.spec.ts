// SPDX-License-Identifier: Apache-2.0
// tracker.ssr-frameworks, docs.quickstarts-run: "low-friction for a wide variety of sites (static HTML, SPAs, SSR frameworks)", proven per
// framework. Each example app under examples/ is installed from its own frozen lockfile, built in production mode
// and served by its own production server (global-setup.ts, server.ts), then driven in Chromium. Every request to
// the two ingest hosts goes to the protocol-v1 mock gateway of the tracker's browser suite
// (tracker/e2e/lib/gateway.ts): tracker files from the build, real challenge tokens, proof of work verified, every
// body validated against the contract's JSON Schemas. What each app must show:
//
//   - the landing page is counted exactly once (hydration of a server-rendered page adds nothing);
//   - the "Sign up" button sends the custom event `signup {plan: "free"}` exactly once;
//   - every route change is counted exactly once: client-side navigations (and back) in SPAs, SSR frameworks and
//     Astro's view transitions — without a new document (one challenge per page load) —, full page loads on static
//     sites;
//   - a deep link with a query string and a fragment is counted once, as its path only;
//   - nothing else leaves the page: no request to any other host, no console error.
//
// The Next.js + Wallets Kit example additionally runs the real Stellar Wallets Kit against an emulated Hana wallet
// extension (the kit's Hana module talks to `window.hanaWallet.stellar`): connect through the kit's own modal, sign,
// a user rejection and disconnect arrive as schema-v1 wallet events, and no address, signature or wallet text ever
// leaves the page. The app signs and disconnects through method references copied off the kit when its `wallet.ts`
// loads, before the adapter attaches (Scaffold Stellar's pattern) — tracker 1.1.0's first adapter missed those.

import { expect, type Page, test } from "@playwright/test";
import {
  collectErrors,
  type Event,
  expectClean,
  expectPageviews,
  HOST_A,
  HOST_B,
  type MockGateway,
  mockGateway,
  SITE,
} from "../../../tracker/e2e/lib/gateway.ts";
import { CANARY } from "../../../tracker/test/canary.ts";
import { type App, selectedApps } from "./apps.ts";
import { proxyOrigin, type Running, serve } from "./server.ts";

/** Every request to a host other than the app's origin and the two ingest hosts is refused and recorded. */
async function isolate(page: Page): Promise<string[]> {
  const foreign: string[] = [];
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    foreign.push(`${route.request().method()} ${u.origin}${u.pathname}`);
    return route.abort("blockedbyclient");
  });
  return foreign;
}

const customEvents = (gw: MockGateway) =>
  gw
    .events()
    .filter((e: Event) => e.k === "ev")
    .map((e) => ({ u: e.u, n: e.n, d: e.d }));

async function open(page: Page, app: App, port: number) {
  const origin = `https://${app.id}.site.test`;
  const foreign = await isolate(page);
  const gw = await mockGateway(page);
  await proxyOrigin(page, origin, port);
  const errors = collectErrors(page);
  return { origin, foreign, gw, errors };
}

const signupButton = (page: Page) => page.getByRole("button", { name: "Sign up" });

for (const app of selectedApps().filter((a) => a.id !== "nextjs-wallets-kit")) {
  test.describe(`examples/${app.id} (${app.install}, ${app.serve})`, () => {
    test.describe.configure({ mode: "default" });
    let server: Running;
    test.beforeAll(async () => {
      server = await serve(app, SITE);
    });
    test.afterAll(async () => {
      await server?.stop();
    });

    test("one page view per route, one custom event, no reload on client-side navigation", async ({
      page,
    }, info) => {
      const { origin, foreign, gw, errors } = await open(page, app, server.port);
      await page.goto(`${origin}/`);
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      await expectPageviews(gw, ["/"]);
      // a marker on the document: it survives client-side navigations, a new document drops it
      await page.evaluate(() => {
        (window as unknown as { qsDoc: number }).qsDoc = 1;
      });

      // the button is wired once the app has hydrated (server-rendered markup is inert before)
      await expect(async () => {
        await signupButton(page).click();
        expect(customEvents(gw)).toHaveLength(1);
      }).toPass({ timeout: 15_000 });
      await page.waitForTimeout(400);
      expect(customEvents(gw)).toEqual([{ u: "/", n: "signup", d: { plan: "free" } }]);

      await page.getByRole("link", { name: "About", exact: true }).click();
      await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
      await expectPageviews(gw, ["/", app.about]);
      await page.getByRole("link", { name: "Home", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
      await expectPageviews(gw, ["/", app.about, "/"]);
      await page.goBack();
      await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
      await expectPageviews(gw, ["/", app.about, "/", app.about]);

      const sameDocument = await page.evaluate(
        () => (window as unknown as { qsDoc?: number }).qsDoc === 1,
      );
      if (app.clientNav) {
        expect(sameDocument, "navigations stayed in the same document").toBe(true);
        expect(gw.challenges(), "one challenge: one page load").toHaveLength(1);
      } else {
        expect(sameDocument, "each link loaded a new document").toBe(false);
        expect(gw.challenges(), "one challenge per page load").toHaveLength(4);
      }
      expectClean(gw);
      expect(foreign, "no request to any other host").toEqual([]);
      expect(errors).toEqual([]);
      await info.attach("events.json", {
        body: JSON.stringify(gw.events(), null, 2),
        contentType: "application/json",
      });
    });

    test("a deep link with query and fragment: counted once, as its path", async ({ page }) => {
      const { origin, foreign, gw, errors } = await open(page, app, server.port);
      await page.goto(`${origin}${app.about}?utm_source=newsletter&ref=${CANARY.G}#team`);
      await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
      await expectPageviews(gw, [app.about]);
      expect(gw.challenges()).toHaveLength(1);
      expectClean(gw);
      expect(JSON.stringify(gw.batches())).not.toContain(CANARY.G);
      expect(foreign).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

// --- Next.js + Stellar Wallets Kit (examples/nextjs-wallets-kit) ---

/**
 * An emulated Hana wallet extension: the object the kit's Hana module calls. It returns canary values (an account
 * StrKey, a signature) that must never appear in anything the tracker sends, and rejects a signature the way a
 * wallet does when the user declines (SEP-43 code -4) while `window.qsReject` is set.
 */
function hanaExtension(c: typeof CANARY): void {
  const w = window as unknown as {
    hanaWallet: unknown;
    qsReject?: boolean;
  };
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

const stellarEvents = (gw: MockGateway) =>
  gw
    .events()
    .filter((e: Event) => e.k === "wl")
    .map(({ id: _id, k: _k, u: _u, sv, ...rest }) => {
      expect(sv).toBe(1);
      return rest;
    });

const walletsApp = selectedApps().find((a) => a.id === "nextjs-wallets-kit");

test.describe("examples/nextjs-wallets-kit (Next.js + Stellar Wallets Kit)", () => {
  test.describe.configure({ mode: "default" });
  test.skip(!walletsApp, "not selected (QS_FRAMEWORKS)");
  let server: Running;
  test.beforeAll(async () => {
    if (walletsApp) server = await serve(walletsApp, SITE);
  });
  test.afterAll(async () => {
    await server?.stop();
  });

  test("connect in the kit's modal, sign via copied references, reject, disconnect: schema-v1 events, no address", async ({
    page,
  }) => {
    const app = walletsApp as App;
    const { origin, foreign, gw, errors } = await open(page, app, server.port);
    await page.addInitScript(hanaExtension, CANARY);
    await page.goto(`${origin}/`);
    await expectPageviews(gw, ["/"]);
    const log = page.locator("#log");

    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByText("Hana Wallet", { exact: true }).click();
    await expect(log).toHaveText("connect: ok");
    await expect(page.locator("#wallet-state")).toHaveText("Wallet connected");

    await page.getByRole("button", { name: "Sign message" }).click();
    await expect(log).toHaveText("sign: ok");
    await page.evaluate(() => {
      (window as unknown as { qsReject: boolean }).qsReject = true;
    });
    await page.getByRole("button", { name: "Sign message" }).click();
    await expect(log).toHaveText("sign: failed");
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(log).toHaveText("disconnect: ok");

    // client-side navigation in the dApp: still one page view per route
    await page.getByRole("link", { name: "About", exact: true }).click();
    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await expectPageviews(gw, ["/", "/about"]);

    await expect
      .poll(() => stellarEvents(gw).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(9);
    await page.waitForTimeout(400);
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
    expect(gw.challenges()).toHaveLength(1);
    expectClean(gw);
    const sent = JSON.stringify(gw.seen.filter((s) => s.kind !== "script").map((s) => s.body));
    for (const v of Object.values(CANARY)) expect(sent).not.toContain(v);
    // The kit's modal loads wallet icons from the kit's CDN; the test refuses them (offline), so only those may
    // appear as foreign requests and as failed-resource console errors.
    expect(foreign.filter((f) => !/\.(png|svg|jpe?g|webp)$/.test(f))).toEqual([]);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
    for (const h of [HOST_A, HOST_B]) expect(foreign.join("\n")).not.toContain(h);
  });
});
