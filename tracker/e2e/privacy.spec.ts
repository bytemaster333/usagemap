// SPDX-License-Identifier: Apache-2.0
// Privacy behaviour of the released files in a real browser (tracker.static-html/tracker.version-pinned delivery, C-33, C-55, C-65, C-93):
// consent-gated mode sends nothing — not even the challenge — before grantConsent() and stops on revokeConsent();
// Global Privacy Control, Do Not Track and optOut() send nothing; the strict profile reads no client signal, no
// referrer, no screen, no language and no Wallets Kit marker (every property read by the tracker's own code is
// recorded through instrumented prototypes, attributed by stack trace), and its payload carries only the path.

import { expect, type Page, test } from "@playwright/test";
import {
  expectClean,
  expectPageviews,
  type MockGateway,
  mockGateway,
  SITE,
  scriptTag,
} from "./lib/gateway.ts";

type Profile = "standard" | "strict";
interface Api {
  track(n: string, p?: object): boolean;
  grantConsent(): void;
  revokeConsent(): void;
  optOut(): void;
  optIn(): void;
}

const ORIGIN = "https://privacy.site.test";

/** Serve one HTML page (any path) carrying the tenant snippet. */
async function servePage(
  page: Page,
  opts: { profile?: Profile; consent?: boolean; head?: string; body?: string } = {},
): Promise<void> {
  const tag = scriptTag(
    opts.profile ?? "standard",
    SITE,
    opts.consent ? 'data-consent="required"' : "",
  );
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture title</title>
${opts.head ?? ""}${tag}</head><body><h1>privacy fixture</h1>${opts.body ?? ""}</body></html>`;
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );
}

const api = (page: Page) =>
  page.waitForFunction(() => !Array.isArray((window as { scf?: unknown }).scf));
const call = <K extends keyof Api>(page: Page, m: K, ...a: Parameters<Api[K]>) =>
  page.evaluate(
    ([m, a]) =>
      (window as unknown as { scf: Record<string, (...x: unknown[]) => unknown> }).scf[m]?.(...a),
    [m, a] as const,
  );
const push = (page: Page, path: string) => page.evaluate((p) => history.pushState({}, "", p), path);

/** Only the GET of the script itself — no challenge, no event. */
const onlyScript = (gw: MockGateway) => expect(gw.seen.map((s) => s.kind)).toEqual(["script"]);

for (const profile of ["standard", "strict"] as const) {
  test.describe(`consent-gated mode (C-55), ${profile}`, () => {
    test("nothing at all before grantConsent(); counts the current page on grant; stops on revoke", async ({
      page,
    }) => {
      const gw = await mockGateway(page);
      await servePage(page, { profile, consent: true });
      await page.goto(`${ORIGIN}/landing`, { referer: "https://news.example/" });
      await api(page);

      // Before consent: navigation and custom events are dropped, not queued (C-100).
      await push(page, "/pricing");
      expect(await call(page, "track", "cta_click")).toBe(false);
      await page.waitForTimeout(1200);
      onlyScript(gw);

      await call(page, "grantConsent");
      await expectPageviews(gw, ["/pricing"]);
      expect(gw.challenges()).toHaveLength(1);
      expect(await call(page, "track", "cta_click")).toBe(true);
      await expect.poll(() => gw.events().length).toBe(2);

      await call(page, "revokeConsent");
      const sent = gw.seen.length;
      await push(page, "/after-revoke");
      expect(await call(page, "track", "after_revoke")).toBe(false);
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await page.waitForTimeout(1200);
      expect(gw.seen.length, "nothing sent after revokeConsent()").toBe(sent);

      // Granting again counts the page the visitor is on now.
      await call(page, "grantConsent");
      await expectPageviews(gw, ["/pricing", "/after-revoke"]);
      expectClean(gw);
    });

    test("grantConsent() queued before the script loads is replayed", async ({ page }) => {
      const gw = await mockGateway(page);
      await servePage(page, {
        profile,
        consent: true,
        head: `<script>window.scf = window.scf || []; window.scf.push(["grantConsent"]);</script>`,
      });
      await page.goto(`${ORIGIN}/queued`);
      await expectPageviews(gw, ["/queued"]);
      expectClean(gw);
    });
  });

  test.describe(`visitor choices, ${profile}`, () => {
    test("Global Privacy Control: nothing is sent, even on navigation and track()", async ({
      page,
      context,
    }) => {
      await context.addInitScript(() =>
        Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true }),
      );
      const gw = await mockGateway(page);
      await servePage(page, { profile });
      await page.goto(`${ORIGIN}/gpc`);
      await api(page);
      await push(page, "/gpc/next");
      expect(await call(page, "track", "x")).toBe(false);
      await page.waitForTimeout(1200);
      onlyScript(gw);
    });

    test("Do Not Track: nothing is sent", async ({ page, context }) => {
      await context.addInitScript(() =>
        Object.defineProperty(Navigator.prototype, "doNotTrack", { get: () => "1" }),
      );
      const gw = await mockGateway(page);
      await servePage(page, { profile });
      await page.goto(`${ORIGIN}/dnt`);
      await api(page);
      await push(page, "/dnt/next");
      expect(await call(page, "track", "x")).toBe(false);
      await page.waitForTimeout(1200);
      onlyScript(gw);
    });

    test("optOut(): stops at once, persists across loads (nothing, not even a challenge); optIn() undoes it", async ({
      page,
    }) => {
      const gw = await mockGateway(page);
      await servePage(page, { profile });
      await page.goto(`${ORIGIN}/a`);
      await expectPageviews(gw, ["/a"]);

      await call(page, "optOut");
      expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ scf_optout: "1" });
      const sent = gw.seen.length;
      await push(page, "/b");
      expect(await call(page, "track", "x")).toBe(false);
      await page.reload();
      await api(page);
      await page.waitForTimeout(1200);
      expect(
        gw.seen.slice(sent).map((s) => s.kind),
        "after optOut() and a reload only the script is fetched",
      ).toEqual(["script"]);

      await call(page, "optIn");
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      await page.reload();
      await expectPageviews(gw, ["/a", "/b"]);
      expect(await page.evaluate(() => document.cookie)).toBe("");
      expectClean(gw);
    });
  });
}

/** Records every read of a client-signal / fingerprinting surface made by the tracker file's own code. */
async function instrumentReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const reads: string[] = [];
    (window as unknown as { __reads: string[] }).__reads = reads;
    const fromTracker = (): boolean =>
      /\/lib\/\d+\.\d+\.\d+\/(standard|strict)\.js/.test(new Error().stack ?? "");
    const wrap = (proto: object | undefined, key: string, label: string): void => {
      if (!proto) return;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d) return;
      if (d.get) {
        const get = d.get;
        Object.defineProperty(proto, key, {
          ...d,
          get(this: unknown) {
            if (fromTracker()) reads.push(label);
            return get.call(this);
          },
        });
      } else if (typeof d.value === "function") {
        const fn = d.value as (...a: unknown[]) => unknown;
        Object.defineProperty(proto, key, {
          ...d,
          value(this: unknown, ...a: unknown[]) {
            if (fromTracker()) reads.push(label);
            return fn.apply(this, a);
          },
        });
      }
    };
    const N = Navigator.prototype;
    for (const k of [
      "webdriver",
      "userActivation",
      "language",
      "languages",
      "userAgent",
      "userAgentData",
      "platform",
      "plugins",
      "hardwareConcurrency",
      "deviceMemory",
      "maxTouchPoints",
      "connection",
      "globalPrivacyControl",
      "doNotTrack",
    ]) {
      wrap(N, k, `navigator.${k}`);
    }
    const D = Document.prototype;
    for (const k of [
      "referrer",
      "prerendering",
      "visibilityState",
      "cookie",
      "title",
      "querySelector",
      "querySelectorAll",
    ]) {
      wrap(D, k, `document.${k}`);
    }
    for (const k of ["width", "height", "availWidth", "availHeight", "colorDepth"]) {
      wrap(Screen.prototype, k, `screen.${k}`);
    }
    wrap(CSSStyleDeclaration.prototype, "getPropertyValue", "style.getPropertyValue");
    wrap(Storage.prototype, "getItem", "storage.getItem");
    wrap(HTMLCanvasElement.prototype, "getContext", "canvas.getContext");
    wrap(Intl.DateTimeFormat.prototype, "resolvedOptions", "Intl.resolvedOptions");
  });
}

const reads = (page: Page) =>
  page.evaluate(() => [...new Set((window as unknown as { __reads: string[] }).__reads)].sort());

test.describe("what each profile reads and sends (C-33)", () => {
  test("strict: reads only the visitor's choices and visibility; sends only id, kind and path", async ({
    page,
  }) => {
    await instrumentReads(page);
    const gw = await mockGateway(page);
    await servePage(page, {
      profile: "strict",
      body: "<stellar-wallets-button></stellar-wallets-button>",
    });
    await page.goto(`${ORIGIN}/docs?x=1`, { referer: "https://news.example/thread" });
    await expectPageviews(gw, ["/docs"]);
    await call(page, "track", "signup", { plan: "free" });
    await push(page, "/docs/next");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expectPageviews(gw, ["/docs", "/docs/next"]);

    // Allowed in strict (README "Privacy behaviour"): GPC/DNT flags, the opt-out flag, the visibility state.
    const allowed = [
      "document.visibilityState",
      "navigator.doNotTrack",
      "navigator.globalPrivacyControl",
      "storage.getItem",
    ];
    expect((await reads(page)).filter((r) => !allowed.includes(r))).toEqual([]);
    for (const b of gw.batches()) {
      expect(b.p).toBe("strict");
      expect(b).not.toHaveProperty("sg");
      expect(typeof b.c).toBe("number"); // the challenge and proof still run (C-33)
    }
    for (const e of gw.events()) {
      expect(Object.keys(e).sort()).toEqual(
        e.k === "pv" ? ["id", "k", "u"] : ["d", "id", "k", "n", "u"],
      );
    }
    expectClean(gw);
  });

  test("standard (positive control): the same instrumentation sees the standard-only reads", async ({
    page,
  }) => {
    await instrumentReads(page);
    const gw = await mockGateway(page);
    await servePage(page, { body: "<stellar-wallets-button></stellar-wallets-button>" });
    await page.goto(`${ORIGIN}/docs`, { referer: "https://news.example/thread" });
    await expectPageviews(gw, ["/docs"]);
    const r = await reads(page);
    for (const k of [
      "document.referrer",
      "document.querySelector",
      "navigator.language",
      "navigator.userActivation",
      "navigator.webdriver",
      "screen.width",
    ]) {
      expect(r).toContain(k);
    }
    // never: fingerprinting surfaces, cookies, title
    for (const k of [
      "navigator.userAgent",
      "navigator.platform",
      "navigator.plugins",
      "navigator.hardwareConcurrency",
      "document.cookie",
      "document.title",
      "canvas.getContext",
      "Intl.resolvedOptions",
    ]) {
      expect(r).not.toContain(k);
    }
    // Wallets Kit presence (C-93, feature.wallets-kit-autocapture Tier 0) from the DOM marker, plus the referrer host.
    expect(gw.events()[0]).toMatchObject({ k: "pv", u: "/docs", r: "news.example", wk: true });
    expectClean(gw);
  });
});
