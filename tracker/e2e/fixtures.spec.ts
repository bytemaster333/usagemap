// SPDX-License-Identifier: Apache-2.0
// Page-view counting on the four fixture kinds (tracker.static-html, tracker.spa, tracker.ssr-frameworks, metric.pageviews):
// static HTML (script tag + SRI), a React Router SPA (npm package in a StrictMode effect), a Vue Router SPA (script
// tag + command queue) and a server-rendered, hydrated React Router app (script tag and npm init() on the same page,
// and npm only). Every request goes to the protocol-v1 mock gateway, which validates it against the §a JSON Schemas
// and verifies the proof (e2e/lib/gateway.ts). The rule under test (README "What it does"): a page view on load
// and on each History-API navigation to a different path; never for hydration, same-path replaceState, query-only
// or fragment-only changes; back/forward to a different path is a navigation and counts.

import { expect, type Page, test } from "@playwright/test";
import {
  collectErrors,
  expectClean,
  expectPageviews,
  type MockGateway,
  mockGateway,
  SITE,
  scriptTag,
} from "./lib/gateway.ts";
import { serveApp, serveSsr, ssrModule } from "./lib/serve.ts";

const REFERRER = "https://search.example/results?q=stellar+analytics";

const pvRefs = (gw: MockGateway) =>
  gw
    .events()
    .filter((e) => e.k === "pv")
    .map((e) => e.r ?? null);

const go = async (page: Page, sel: string): Promise<void> => {
  await page.click(sel);
  await page.waitForTimeout(150);
};

test.describe("static HTML (script tag with SRI)", () => {
  test("one page view per page load; fragment links and query strings never count", async ({
    page,
  }) => {
    const origin = "https://static.site.test";
    const gw = await mockGateway(page);
    const errors = collectErrors(page);
    await serveApp(page, origin, "static", { tracker: scriptTag("standard", SITE), spa: false });

    await page.goto(`${origin}/`, { referer: REFERRER });
    await expectPageviews(gw, ["/"]);
    await go(page, "#to-section"); // fragment only
    await expectPageviews(gw, ["/"]);

    await go(page, "#to-about-query"); // full page load, path + query
    await expectPageviews(gw, ["/", "/about/"]);
    await go(page, "#to-team");
    await go(page, "#to-home");
    await expectPageviews(gw, ["/", "/about/", "/"]);

    // Every full page load fetches its own challenge (the token is memory-only, C-37).
    expect(gw.challenges()).toHaveLength(3);
    // The referrer is sent once, on the landing page view; later loads are same-site (self-referral dropped).
    expect(pvRefs(gw)).toEqual(["search.example", null, null]);
    expectClean(gw);
    expect(errors).toEqual([]);
  });

  // Playwright's Chromium reloads documents on back/forward (navigation type "back_forward", no bfcache restore);
  // a document restored from the back/forward cache runs no script and is not counted again (README).
  test("back/forward between documents: each document load is counted once", async ({ page }) => {
    const origin = "https://static-bf.site.test";
    const gw = await mockGateway(page);
    await serveApp(page, origin, "static", { tracker: scriptTag("standard", SITE), spa: false });

    await page.goto(`${origin}/`);
    await expectPageviews(gw, ["/"]);
    await go(page, "#to-about");
    await expectPageviews(gw, ["/", "/about/"]);
    await page.goBack();
    await expectPageviews(gw, ["/", "/about/", "/"]);
    await page.goForward();
    await expectPageviews(gw, ["/", "/about/", "/", "/about/"]);
    expectClean(gw);
  });
});

test.describe("History-API SPA: React Router (npm package, StrictMode)", () => {
  test("init() twice under StrictMode, client navigation, replace, fragment, query, back/forward", async ({
    page,
  }) => {
    const origin = "https://react.site.test";
    const gw = await mockGateway(page);
    const errors = collectErrors(page);
    await serveApp(page, origin, "react-spa");

    await page.goto(`${origin}/`, { referer: REFERRER });
    await page.waitForFunction(() => window.fixture?.ready);
    // StrictMode ran the layout effect twice; the second init() returned the running instance.
    expect(
      await page.evaluate(() => {
        const t = window.fixture.trackers;
        return [t.length, t[0] !== undefined && t[0] === t[1]];
      }),
    ).toEqual([2, true]);
    await expectPageviews(gw, ["/"]);

    await go(page, "#nav-products");
    await go(page, "#to-reviews"); // fragment only
    await go(page, "#replace-to-7"); // navigate(..., { replace: true }) to a new path counts
    await go(page, "#nav-product-2");
    await go(page, "#add-to-cart");
    await go(page, "#nav-search"); // /search?q=wallet → path /search
    await go(page, "#refine"); // query-only change
    await expectPageviews(gw, ["/", "/products", "/products/7", "/products/2", "/search"]);

    await page.goBack(); // /search?q=wallet — same path
    await page.goBack(); // /products/2
    await page.goBack(); // /products/7
    await page.goForward(); // /products/2
    await expectPageviews(gw, [
      "/",
      "/products",
      "/products/7",
      "/products/2",
      "/search",
      "/products/2",
      "/products/7",
      "/products/2",
    ]);

    const custom = gw.events().filter((e) => e.k === "ev");
    expect(custom).toEqual([
      {
        id: expect.any(String),
        k: "ev",
        u: "/products/2",
        n: "add_to_cart",
        d: { sku: "P-2", qty: 1 },
      },
    ]);
    expect(pvRefs(gw)).toEqual(["search.example", null, null, null, null, null, null, null]);
    expect(gw.challenges()).toHaveLength(1); // one page load, one challenge, proof reused
    for (const b of gw.batches()) expect(typeof b.c).toBe("number");
    expectClean(gw);
    expect(errors).toEqual([]);
  });
});

test.describe("History-API SPA: Vue Router (script tag, command queue)", () => {
  test("router start-up replaceState, client navigation, fragment, query, back/forward", async ({
    page,
  }) => {
    const origin = "https://vue.site.test";
    const gw = await mockGateway(page);
    const errors = collectErrors(page);
    await serveApp(page, origin, "vue-spa", { tracker: scriptTag("standard", SITE) });

    await page.goto(`${origin}/docs/getting-started?ref=newsletter#install`, { referer: REFERRER });
    await page.waitForSelector("text=Doc getting-started");
    await expectPageviews(gw, ["/docs/getting-started"]);
    // The queued call ran before the first page view was considered (README "Consent-gated mode" queue).
    expect(gw.events()[0]).toMatchObject({ k: "ev", n: "app_boot", d: { mode: "spa" } });

    await go(page, "#to-anchor"); // fragment only
    await go(page, "#tab-api"); // router.push({ query }) — same path
    await go(page, "#copy");
    await go(page, "#nav-doc-api");
    await go(page, "#nav-settings");
    await page.goBack(); // /docs/api
    await page.goBack(); // /docs/getting-started?tab=api
    await page.goForward(); // /docs/api
    await expectPageviews(gw, [
      "/docs/getting-started",
      "/docs/api",
      "/settings",
      "/docs/api",
      "/docs/getting-started",
      "/docs/api",
    ]);
    expect(
      gw
        .events()
        .filter((e) => e.k === "ev")
        .map((e) => [e.n, e.u]),
    ).toEqual([
      ["app_boot", "/docs/getting-started"],
      ["copy_snippet", "/docs/getting-started"],
    ]);
    expect(pvRefs(gw)[0]).toBe("search.example");
    expect(
      pvRefs(gw)
        .slice(1)
        .every((r) => r === null),
    ).toBe(true);
    expect(gw.challenges()).toHaveLength(1);
    expectClean(gw);
    expect(errors).toEqual([]);
  });
});

test.describe("hydrated SSR (React Router data router, react-dom/server + hydrateRoot)", () => {
  test("init() is a no-op during server rendering", async () => {
    expect((await ssrModule()).serverInit(SITE)).toBeUndefined();
  });

  test("script tag in <head> and npm init() after hydration: one page view, one instance", async ({
    page,
  }) => {
    const origin = "https://ssr.site.test";
    const gw = await mockGateway(page);
    const errors = collectErrors(page);
    await serveSsr(page, origin, scriptTag("standard", SITE));

    const res = await page.goto(`${origin}/articles/hello?utm_source=x`, { referer: REFERRER });
    // Server-rendered markup (loader data included) before any client code ran.
    expect(await res?.text()).toContain("Article <!-- -->hello");
    await page.waitForFunction(() => window.fixture?.hydrated);
    expect(
      await page.evaluate(
        () => window.fixture.trackers[0] === (window as unknown as { scf: unknown }).scf,
      ),
    ).toBe(true);
    await expectPageviews(gw, ["/articles/hello"]);

    await go(page, "#nav-world"); // client navigation, loader runs in the browser
    await page.waitForSelector("text=Article world");
    await go(page, "#to-comments"); // fragment only
    await page.goBack(); // /articles/world (fragment entry → same path)
    await page.goBack(); // /articles/hello
    await go(page, "#nav-home");
    await expectPageviews(gw, ["/articles/hello", "/articles/world", "/articles/hello", "/"]);
    expect(pvRefs(gw)).toEqual(["search.example", null, null, null]);
    expect(gw.challenges()).toHaveLength(1);
    expectClean(gw);
    expect(errors, "no hydration mismatch or other error").toEqual([]);
  });

  test("npm only: the hydration effect counts the server-rendered page once", async ({ page }) => {
    const origin = "https://ssr-npm.site.test";
    const gw = await mockGateway(page);
    const errors = collectErrors(page);
    await serveSsr(page, origin, "");

    await page.goto(`${origin}/articles/hello`);
    await page.waitForFunction(() => window.fixture?.hydrated);
    await expectPageviews(gw, ["/articles/hello"]);
    // The npm entry does not create the classic build's window.scf global.
    expect(await page.evaluate(() => "scf" in window)).toBe(false);
    await page.reload(); // a new document: counted again, with a new challenge
    await page.waitForFunction(() => window.fixture?.hydrated);
    await expectPageviews(gw, ["/articles/hello", "/articles/hello"]);
    expect(gw.challenges()).toHaveLength(2);
    expectClean(gw);
    expect(errors).toEqual([]);
  });
});
