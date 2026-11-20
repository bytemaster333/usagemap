// SPDX-License-Identifier: Apache-2.0
// The built page in a real browser, served as https://usagemap.dev by route interception (no ports, no network):
// it loads nothing but its own hashed assets and its pinned tracker, everything runs under the page's
// Content-Security-Policy with Trusted Types (no violation reaches the console), a tampered tracker or stylesheet is
// refused, the self-hosted fonts load, the layout holds on iPhone-sized screens with the compact menu, and the
// interactive parts (integrations filter and detail, project-check inputs) work.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";

const LANDING = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES = join(LANDING, "..", "..", "tracker", "releases");
const VERSION = "1.0.0";
const SITE_KEY = "LandingE2eKey000000000";
const ORIGIN = "https://usagemap.dev";
const PAGE = `${ORIGIN}/`;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".toml": "text/plain; charset=utf-8",
};

let out = "";
let ingest = "";
let trackerPath = "";

test.beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "landing-e2e-"));
  execFileSync(process.execPath, ["build.ts"], {
    cwd: LANDING,
    env: {
      ...process.env,
      LANDING_TRACKER_DIST: RELEASES,
      LANDING_TRACKER_VERSION: VERSION,
      LANDING_SITE_KEY: SITE_KEY,
      LANDING_OUT: out,
    },
    stdio: "pipe",
  });
  const facts = JSON.parse(readFileSync(join(out, "facts.json"), "utf8")) as {
    tracker: { hosts: string[] };
  };
  ingest = facts.tracker.hosts[0] as string;
  trackerPath = `/lib/${VERSION}/strict.js`;
});

interface Seen {
  requests: string[];
  challenge: { body: string; contentType: string } | undefined;
  errors: string[];
}

interface Serve {
  tracker?: Buffer;
  /** replaces the bytes of a built file, by published path */
  tamper?: Record<string, (b: Buffer) => Buffer>;
}

const released = (): Buffer => readFileSync(join(RELEASES, VERSION, "strict.js"));
const isNetworkNoise = (e: string): boolean => e.startsWith("Failed to load resource");

async function open(page: Page, serve: Serve = {}): Promise<Seen> {
  const seen: Seen = { requests: [], challenge: undefined, errors: [] };
  page.on("console", (m) => {
    if (m.type() === "error") seen.errors.push(m.text());
  });
  page.on("pageerror", (e) => seen.errors.push(e.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    seen.requests.push(`${req.method()} ${url.origin}${url.pathname}`);
    if (url.origin === ORIGIN) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = join(out, rel);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
      let body: Buffer = readFileSync(file);
      const t = serve.tamper?.[url.pathname];
      if (t) body = t(body);
      return route.fulfill({
        status: 200,
        contentType: TYPES[extname(file)] ?? "application/octet-stream",
        body,
      });
    }
    if (url.origin === ingest && url.pathname === trackerPath) {
      return route.fulfill({
        status: 200,
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: serve.tracker ?? released(),
      });
    }
    if (url.origin === ingest && url.pathname === "/v1/c" && req.method() === "POST") {
      seen.challenge = {
        body: req.postData() ?? "",
        contentType: req.headers()["content-type"] ?? "",
      };
      // an unknown site: the tracker stops here (wire-formats §a.5)
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        headers: { "access-control-allow-origin": ORIGIN },
        body: '{"error":"unknown_site"}',
      });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(PAGE);
  return seen;
}

const builtPath = (re: RegExp): string => {
  const html = readFileSync(join(out, "index.html"), "utf8");
  const m = re.exec(html);
  if (!m?.[1]) throw new Error(`no match for ${re}`);
  return m[1];
};

test("loads only its own assets and pinned tracker, all under the page's CSP and Trusted Types", async ({
  page,
}) => {
  const seen = await open(page);
  await expect.poll(() => seen.challenge !== undefined, { timeout: 10_000 }).toBe(true);
  await expect(page.locator("h1")).toHaveText("Real usage, proven.");
  for (const r of seen.requests) {
    const origin = new URL(r.split(" ")[1] as string).origin;
    expect([ORIGIN, ingest]).toContain(origin);
  }
  expect(seen.requests).toContain(`GET ${ingest}${trackerPath}`);
  expect(seen.requests.some((r) => /\/assets\/site\.[0-9a-f]{12}\.css$/.test(r))).toBe(true);
  expect(seen.requests.some((r) => /\/assets\/site\.[0-9a-f]{12}\.js$/.test(r))).toBe(true);
  expect(seen.challenge?.contentType).toMatch(/^text\/plain/);
  expect(seen.challenge?.body).toContain(SITE_KEY);
  // the page script ran: the verification field was drawn with the DOM API under Trusted Types
  await expect(page.locator("#field circle.dot")).toHaveCount(48);
  // the self-hosted fonts are in use
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
      ),
    )
    .toEqual(expect.arrayContaining(["Manrope", "Geist"]));
  expect(seen.errors.filter((e) => !isNetworkNoise(e))).toEqual([]);
});

test("a tracker that differs by one byte is refused and the page still works", async ({ page }) => {
  const bad = Buffer.from(released());
  bad[bad.length - 2] = 0x20;
  const seen = await open(page, { tracker: bad });
  await expect(
    page.getByRole("heading", { level: 2, name: "Connect your tools from day one." }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(seen.challenge).toBeUndefined();
  expect(seen.errors.some((e) => /integrity/i.test(e))).toBe(true);
});

test("a stylesheet that differs from its SRI value is refused", async ({ page }) => {
  const css = builtPath(/<link rel="stylesheet" href="([^"]+)"/);
  const seen = await open(page, {
    tamper: { [css]: (b) => Buffer.concat([b, Buffer.from("body{background:red}")]) },
  });
  await page.waitForTimeout(300);
  expect(seen.errors.some((e) => /integrity/i.test(e))).toBe(true);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(255, 0, 0)");
});

// iPhone-class screens (SE/mini, 15/16, 17, Pro Max) at their CSS sizes, and a 360 px Android phone
for (const [width, height] of [
  [360, 740],
  [375, 812],
  [393, 852],
  [402, 874],
  [440, 956],
] as const) {
  test(`fits a ${width} px phone: no horizontal scroll, compact menu with every link`, async ({
    browser,
  }) => {
    const page = await phone(browser, width, height);
    await open(page);
    await expect(page.locator("h1")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(255, 255, 255)",
    );
    await expect(page.locator(".nav-links")).toBeHidden();
    const menu = page.getByRole("button", { name: "Menu" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await menu.click();
    const mnav = page.locator("#mnav");
    await expect(mnav).toBeVisible();
    for (const name of ["How it works", "For operators", "Integrations", "Proof pages", "Docs"]) {
      await expect(mnav.getByRole("link", { name })).toBeVisible();
    }
    await mnav.getByRole("link", { name: "Integrations" }).click();
    await expect(mnav).toBeHidden();
    await expect(page.locator("#integrations")).toBeInViewport();
    await page.context().close();
  });
}

async function phone(browser: Browser, width: number, height: number): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  return ctx.newPage();
}

test("desktop shows the nav links, not the menu button", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await expect(page.locator(".nav-links")).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
});

test("integrations: every filter shows as many tiles as it counts, and a tile opens its guide", async ({
  page,
}) => {
  await open(page);
  const intg = page.locator("#integrations");
  const visibleTiles = () =>
    intg
      .locator(".ig-tile")
      .evaluateAll((n) => n.filter((x) => (x as HTMLElement).offsetParent !== null).length);
  const filters = intg.locator(".ig-filters button");
  expect(await filters.count()).toBe(8);
  for (const f of await filters.all()) {
    await f.click();
    await expect(f).toHaveAttribute("aria-pressed", "true");
    const want = Number(await f.locator(".ct").textContent());
    await expect.poll(visibleTiles).toBe(want);
  }
  await intg.locator('[data-f="all"]').click();
  await expect.poll(visibleTiles).toBe(49);
  await intg.locator(".ig-tile", { hasText: "Contract registration" }).click();
  const detail = page.getByRole("region", { name: "Contract registration details" });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("link", { name: /Read the guide/ })).toHaveAttribute(
    "href",
    "https://docs.usagemap.dev/onchain/",
  );
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
});

test("the rendered page shows no release-status label", async ({ page }) => {
  await open(page);
  const visible = await page.evaluate(() => document.body.textContent ?? "");
  expect(visible).not.toMatch(/\b(?:coming|available|pending|beta|soon)\b/i);
});

test("the project-check inputs build the project and snapshot links", async ({ page }) => {
  await open(page);
  await page.locator("#slug").fill("My Project");
  await expect(page.locator("#slug-go")).toHaveAttribute(
    "href",
    "https://app.usagemap.dev/p/my-project",
  );
  await expect(page.locator("#slug-go")).toHaveAttribute("aria-disabled", "false");
  await page.locator("#snap").fill("abc123");
  await expect(page.locator("#snap-go")).toHaveAttribute(
    "href",
    "https://app.usagemap.dev/verify?snapshot=abc123",
  );
});

test("the skip link and every section are reachable from the keyboard", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  for (const id of [
    "hero",
    "problem",
    "journey",
    "operators",
    "integrations",
    "trust",
    "index",
    "privacy",
    "run",
  ]) {
    await expect(page.locator(`#${id}`)).toBeAttached();
  }
  expect(await page.locator('a[href*="/evidence"]').count()).toBe(0);
});
