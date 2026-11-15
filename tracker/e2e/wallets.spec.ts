// SPDX-License-Identifier: Apache-2.0
// Stellar event schema v1 in a real browser (plan B1, B2; C-136, C-137): a dApp fixture bundles the npm tracker, the
// Wallets Kit adapter, the Freighter wrapper and the RPC submission adapter, with in-page MOCKS of the kit, Freighter
// and an RPC server (test/wallet-mocks.ts — never a real wallet). A user clicks through connect, sign, reject,
// disconnect and submit; the protocol-v1 mock gateway validates every body against the contract's schema (including
// `$defs/stellar`) and the proof, and no StrKey, hash, XDR or wallet text may appear in anything sent.
// Then the debug module (plan E1) in Chromium: a real CSP violation and a refused CORS request, explained on the page.

import { expect, type Page, test } from "@playwright/test";
import { CANARY } from "../test/canary.ts";
import {
  collectErrors,
  type Event,
  expectClean,
  HOST_A,
  HOST_B,
  type MockGateway,
  mockGateway,
} from "./lib/gateway.ts";
import { serveApp } from "./lib/serve.ts";

const ORIGIN = "https://dapp.test";

const stellar = (gw: MockGateway): Record<string, unknown>[] =>
  gw
    .events()
    .filter((e: Event) => e.k === "wl")
    .map(({ id: _id, k: _k, u: _u, sv, ...rest }) => {
      expect(sv).toBe(1);
      return rest;
    });

async function waitStellar(gw: MockGateway, n: number): Promise<Record<string, unknown>[]> {
  await expect.poll(() => stellar(gw).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(n);
  await new Promise((r) => setTimeout(r, 300)); // and nothing more arrives
  return stellar(gw);
}

const click = async (page: Page, id: string): Promise<void> => {
  await page.click(`#${id}`);
  await expect(page.locator("#log")).toHaveText(new RegExp(`^${id}: (ok|failed)$`));
};

function assertNoCanary(gw: MockGateway): void {
  for (const s of gw.seen) {
    if (s.kind === "script") continue;
    const raw = JSON.stringify(s.body);
    for (const v of Object.values(CANARY)) expect(raw).not.toContain(v);
    expect(raw).not.toMatch(
      /[GCMSTXPLBW][A-Z2-7]{55}|[0-9a-f]{64}|AAAA[A-Za-z0-9+/]{16,}|September 2015/,
    );
  }
}

for (const profile of ["standard", "strict"] as const) {
  test.describe(`wallet dApp (${profile})`, () => {
    test("Wallets Kit flow: modal → Freighter → sign → user rejects → disconnect", async ({
      page,
    }) => {
      const errors = collectErrors(page);
      const gw = await mockGateway(page, { cost: 1, max: 64 });
      await serveApp(page, ORIGIN, `wallet-dapp-${profile}`, { spa: false });
      await page.goto(`${ORIGIN}/`);
      await expect.poll(() => gw.pageviews()).toEqual(["/"]);

      await page.click("#kit-connect");
      await page.click("#kit-pick-freighter");
      await expect(page.locator("#log")).toHaveText("kit-connect: ok");
      await click(page, "kit-sign");
      await click(page, "kit-reject");
      await click(page, "kit-disconnect");

      const ev = await waitStellar(gw, 9);
      expect(ev).toEqual([
        { n: "wallet_modal_opened" },
        { n: "wallet_selected", wt: "freighter" },
        { n: "wallet_connect", wt: "freighter", net: "mainnet", ck: "new", wc: "none" },
        { n: "wallet_modal_closed", out: "connected", wt: "freighter" },
        { n: "sign_requested", wt: "freighter", net: "testnet", sk: "tx" },
        { n: "sign_approved", wt: "freighter", net: "testnet", sk: "tx", dur: "lt5s" },
        { n: "sign_requested", wt: "freighter", net: "mainnet", sk: "tx" },
        {
          n: "sign_rejected",
          wt: "freighter",
          net: "mainnet",
          sk: "tx",
          dur: "lt5s",
          ec: "user_rejected",
        },
        { n: "wallet_disconnect", wt: "freighter", net: "mainnet" },
      ]);
      for (const b of gw.batches()) expect(b.p).toBe(profile);
      expectClean(gw);
      assertNoCanary(gw);
      expect(errors).toEqual([]);
    });

    test("Freighter wrapper flow: requestAccess → sign → RPC submit polled to success", async ({
      page,
    }) => {
      const errors = collectErrors(page);
      const gw = await mockGateway(page, { cost: 1, max: 64 });
      await serveApp(page, ORIGIN, `wallet-dapp-${profile}`, { spa: false });
      await page.goto(`${ORIGIN}/`);
      await click(page, "fr-connect");
      await click(page, "fr-sign");
      await click(page, "fr-submit");
      const ev = await waitStellar(gw, 4);
      expect(ev).toEqual([
        { n: "wallet_connect", wt: "freighter", net: "unknown", ck: "new", wc: "none" },
        { n: "sign_requested", wt: "freighter", net: "testnet", sk: "tx" },
        { n: "sign_approved", wt: "freighter", net: "testnet", sk: "tx", dur: "lt5s" },
        { n: "tx_submitted", rc: "success", net: "testnet" },
      ]);
      expectClean(gw);
      assertNoCanary(gw);
      expect(errors).toEqual([]);
    });

    test("1.2.0: connect failure, wallet context of an in-app browser, RPC aggregate on page hide", async ({
      page,
      context,
    }) => {
      // Varial (Freighter) Mobile's in-app browser injects this frozen sentinel (Wallets Kit 2.8.0 varial.module).
      await context.addInitScript(() => {
        Object.defineProperty(window, "stellar", {
          value: Object.freeze({ provider: "freighter", platform: "mobile", version: "9.9.9" }),
        });
      });
      const errors = collectErrors(page);
      const gw = await mockGateway(page, { cost: 1, max: 64 });
      await serveApp(page, ORIGIN, `wallet-dapp-${profile}`, { spa: false });
      await page.goto(`${ORIGIN}/`);
      await click(page, "fr-connect-rejected");
      await click(page, "fr-connect");
      await click(page, "rpc-calls");
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      const ev = await waitStellar(gw, 3);
      expect(ev.slice(0, 2)).toEqual([
        {
          n: "wallet_connect_failed",
          wt: "freighter",
          net: "unknown",
          fr: "user_rejected",
          wc: "varial_inapp",
        },
        { n: "wallet_connect", wt: "freighter", net: "unknown", ck: "new", wc: "varial_inapp" },
      ]);
      expect(ev[2]).toEqual({
        n: "stellar_rpc",
        c: [
          ["rpc", "get_latest_ledger", "testnet", "ok", "lt100ms", 2],
          ["rpc", "get_transaction", "testnet", "ok", "lt100ms", 1],
        ],
      });
      expectClean(gw);
      assertNoCanary(gw);
      for (const s of gw.seen) expect(JSON.stringify(s.body ?? "")).not.toContain("9.9.9");
      expect(errors).toEqual([]);
    });
  });
}

test.describe("debug mode (plan E1) in Chromium", () => {
  const html = (head: string): string =>
    `<!doctype html><html><head><meta charset="utf-8">${head}</head><body><h1>debug</h1>` +
    '<script type="module" src="/app.js"></script></body></html>';

  /** A page that loads the debug module first, then the npm tracker (both from dist/npm/). */
  async function servePage(page: Page, headers: Record<string, string> = {}): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { ROOT } = await import("../scripts/build-config.ts");
    await page.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") {
        return route.fulfill({ status: 200, contentType: "text/html", headers, body: html("") });
      }
      if (path === "/app.js") {
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body:
            'import { debug } from "/npm/debug.js"; import { init } from "/npm/standard.js";\n' +
            'debug(); init({ site: "Q4mZ8bS1pTn0aR7cLx2VwE" });',
        });
      }
      if (path.startsWith("/npm/")) {
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: readFileSync(join(ROOT, "dist", "npm", path.slice(5))),
        });
      }
      return route.fulfill({ status: 404 });
    });
  }

  test("a page origin the gateway does not allow (no CORS headers) is explained on the page", async ({
    page,
  }) => {
    // The gateway sends no CORS headers for an undeclared origin (§a.1), so the browser fails the request with the
    // same opaque TypeError as a network error. Playwright's fulfilled responses are not CORS-checked, so the refusal
    // is simulated by failing the /v1/ requests while the host itself stays reachable (the no-cors /healthz probe).
    for (const host of [HOST_A, HOST_B]) {
      await page.route(`${host}/**`, (route) =>
        new URL(route.request().url()).pathname === "/healthz"
          ? route.fulfill({ status: 200, body: "ok" })
          : route.abort("failed"),
      );
    }
    await servePage(page);
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator("#scf-debug")).toContainText(
      "neither a declared domain nor a dev origin",
      { timeout: 15_000 },
    );
    await expect(page.locator("#scf-debug")).toContainText(ORIGIN);
  });

  test("a Content Security Policy that blocks the ingest hosts is explained on the page", async ({
    page,
  }) => {
    await servePage(page, {
      "content-security-policy": "default-src 'self'; script-src 'self'; connect-src 'self'",
    });
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator("#scf-debug")).toContainText(
      "Content Security Policy (connect-src)",
      {
        timeout: 15_000,
      },
    );
    await expect(page.locator("#scf-debug")).toContainText(HOST_A);
  });
});
