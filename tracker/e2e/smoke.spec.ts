// SPDX-License-Identifier: Apache-2.0
// Chromium smoke test of the released bytes: a static page embeds dist/<semver>/<profile>.js with SRI; all requests
// are captured by route interception and answered by a protocol-v1 mock that issues real challenges and verifies
// the proof the browser computed with WebCrypto. Confirms challenge → proof → event, SPA navigation, the strict
// profile's payload, SRI enforcement and operation under a strict CSP with Trusted Types and no worker-src.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { DEFAULT_HOSTS, ROOT } from "../scripts/build-config.ts";
import {
  type Issued,
  issue,
  SITE,
  validateChallengeRequest,
  validateEventBatch,
  verifyProof,
} from "../test/protocol.ts";

const PAGE = "https://site.test";
const [HOST_A, HOST_B] = DEFAULT_HOSTS;
const version = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;
const manifest = JSON.parse(readFileSync(join(ROOT, "dist", version, "manifest.json"), "utf8")) as {
  files: { path: string; integrity: string }[];
};
const integrity = (p: string): string =>
  manifest.files.find((f) => f.path === `${p}.js`)?.integrity ?? "";

interface Seen {
  kind: "script" | "challenge" | "event";
  host: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

async function setup(
  page: Page,
  opts: {
    profile?: "standard" | "strict";
    integrity?: string;
    csp?: string;
    consent?: boolean;
    queue?: string;
  } = {},
): Promise<{ seen: Seen[]; issued: Issued[]; violations: string[] }> {
  const profile = opts.profile ?? "standard";
  const seen: Seen[] = [];
  const issued: Issued[] = [];
  const html = readFileSync(join(ROOT, "e2e", "fixture", "index.html.tmpl"), "utf8")
    .replace("{{SRC}}", `${HOST_A}/lib/${version}/${profile}.js`)
    .replace("{{INTEGRITY}}", opts.integrity ?? integrity(profile))
    .replace("{{SITE}}", SITE)
    .replace("{{CONSENT}}", opts.consent ? 'data-consent="required"' : "")
    .replace("{{QUEUE}}", opts.queue ?? "");
  const cors = { "access-control-allow-origin": PAGE, vary: "Origin" };

  await page.route(`${PAGE}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: opts.csp ? { "content-security-policy": opts.csp } : {},
      body: html,
    }),
  );
  for (const host of [HOST_A, HOST_B]) {
    await page.route(`${host}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const headers = await req.allHeaders();
      if (req.method() === "GET" && url.pathname.startsWith("/lib/")) {
        seen.push({ kind: "script", host, headers });
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=31536000, immutable",
          },
          body: readFileSync(join(ROOT, "dist", version, url.pathname.split("/").pop() ?? "")),
        });
      }
      const body = JSON.parse(req.postData() ?? "null") as Record<string, unknown>;
      if (url.pathname === "/v1/c") {
        seen.push({ kind: "challenge", host, body, headers });
        const iss = issue(512, 1024); // the contract's default difficulty
        issued.push(iss);
        return route.fulfill({
          status: 200,
          headers: { ...cors, "cache-control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify({
            v: 1,
            t: iss.token,
            pow: { alg: "pbkdf2-sha256", cost: iss.cost, max: iss.max, pfx: iss.pfx },
            ttl: 1800,
          }),
        });
      }
      seen.push({ kind: "event", host, body, headers });
      return route.fulfill({ status: 202, headers: cors, body: "" });
    });
  }
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") violations.push(m.text());
  });
  page.on("pageerror", (e) => violations.push(String(e)));
  return { seen, issued, violations };
}

const events = (seen: Seen[]) => seen.filter((s) => s.kind === "event");

test("standard: script → challenge → proof → page view, then SPA navigation and a custom event", async ({
  page,
}) => {
  const { seen, issued, violations } = await setup(page);
  await page.goto(`${PAGE}/docs/start?utm_source=x&email=a%40b.io#frag`, {
    referer: "https://news.example/thread?id=7",
  });
  await expect.poll(() => events(seen).length, { timeout: 15_000 }).toBe(1);

  expect(seen.map((s) => s.kind)).toEqual(["script", "challenge", "event"]);
  const [, chal, ev] = seen;
  expect(validateChallengeRequest(chal?.body)).toBe(true);
  expect(chal?.body).toEqual({ v: 1, s: SITE, p: "standard", tv: version });
  expect(validateEventBatch(ev?.body), JSON.stringify(validateEventBatch.errors)).toBe(true);
  expect(ev?.body?.t).toBe(issued[0]?.token);
  expect(verifyProof(issued[0] as Issued, ev?.body?.c as number)).toBe(true);
  const pv = (ev?.body?.e as Record<string, unknown>[] | undefined)?.[0];
  expect(pv).toMatchObject({ k: "pv", u: "/docs/start", r: "news.example", l: "en", w: "l" });
  expect(ev?.body?.sg).toMatchObject({ vis: "v" });
  // no query string, fragment or title; no cookies; referrer header reduced to the origin
  const raw = JSON.stringify(seen.map((s) => s.body ?? null));
  expect(raw).not.toMatch(/utm_|email|frag|\?|Fixture page title/);
  expect(ev?.headers.cookie).toBeUndefined();
  expect(ev?.headers.referer).toBe(`${PAGE}/`);
  expect(ev?.headers.origin).toBe(PAGE);
  expect(ev?.headers["content-type"]).toBe("text/plain;charset=UTF-8");

  await page.evaluate(() => {
    history.pushState({}, "", "/spa/next?tab=1");
    history.replaceState({}, "", "/spa/next#x"); // same path: not counted
    (window as unknown as { scf: { track(n: string, p?: object): boolean } }).scf.track(
      "cta_click",
      {
        where: "hero",
      },
    );
  });
  await expect.poll(() => events(seen).flatMap((s) => s.body?.e as unknown[]).length).toBe(3);
  const all = events(seen).flatMap((s) => s.body?.e as Record<string, unknown>[]);
  expect(all.map((e) => [e.k, e.u])).toEqual([
    ["pv", "/docs/start"],
    ["pv", "/spa/next"],
    ["ev", "/spa/next"],
  ]);
  expect(new Set(all.map((e) => e.id)).size).toBe(3);
  expect(seen.filter((s) => s.kind === "challenge")).toHaveLength(1);
  for (const e of events(seen)) expect(validateEventBatch(e.body)).toBe(true);
  expect(violations).toEqual([]);
});

test("strict: same challenge and proof, no referrer and no client signals", async ({ page }) => {
  const { seen, issued } = await setup(page, { profile: "strict" });
  await page.goto(`${PAGE}/app`, { referer: "https://news.example/" });
  await expect.poll(() => events(seen).length, { timeout: 15_000 }).toBe(1);
  expect(seen.map((s) => s.kind)).toEqual(["script", "challenge", "event"]);
  const body = events(seen)[0]?.body as Record<string, unknown>;
  expect(validateEventBatch(body)).toBe(true);
  expect(body.p).toBe("strict");
  expect(body).not.toHaveProperty("sg");
  expect(verifyProof(issued[0] as Issued, body.c as number)).toBe(true);
  expect((body.e as unknown[])[0]).toEqual({ id: expect.any(String), k: "pv", u: "/app" });
});

test("SRI: a file whose hash does not match is not executed and sends nothing", async ({
  page,
}) => {
  const { seen } = await setup(page, {
    integrity:
      "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  await page.goto(`${PAGE}/`);
  await page.waitForTimeout(1500);
  expect(seen.map((s) => s.kind)).toEqual(["script"]);
});

test("works under a strict CSP with Trusted Types and no worker-src / blob:", async ({ page }) => {
  const csp = [
    "default-src 'none'",
    `script-src ${HOST_A}`,
    `connect-src ${HOST_A} ${HOST_B}`,
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
  const { seen, violations } = await setup(page, { csp });
  await page.goto(`${PAGE}/csp`);
  await expect.poll(() => events(seen).length, { timeout: 15_000 }).toBe(1);
  expect(typeof events(seen)[0]?.body?.c).toBe("number");
  expect(violations).toEqual([]);
});

test("consent-gated: no challenge and no event until grantConsent()", async ({ page }) => {
  const { seen } = await setup(page, { consent: true });
  await page.goto(`${PAGE}/consent`);
  await page.waitForTimeout(1000);
  expect(seen.map((s) => s.kind)).toEqual(["script"]);
  await page.evaluate(() =>
    (window as unknown as { scf: { grantConsent(): void } }).scf.grantConsent(),
  );
  await expect.poll(() => events(seen).length, { timeout: 15_000 }).toBe(1);
  expect(seen.map((s) => s.kind)).toEqual(["script", "challenge", "event"]);
});

test("Global Privacy Control: nothing is sent", async ({ page, context }) => {
  await context.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true }),
  );
  const { seen } = await setup(page);
  await page.goto(`${PAGE}/gpc`);
  await page.waitForTimeout(1500);
  expect(seen.map((s) => s.kind)).toEqual(["script"]);
});

test("page hidden before the proof completes: sent at once (keepalive fetch) with token and no proof", async ({
  page,
  context,
}) => {
  // Make the solver unable to finish so the hide path is deterministic.
  await context.addInitScript(() => {
    SubtleCrypto.prototype.deriveBits = () => new Promise(() => {});
  });
  const { seen } = await setup(page);
  await page.goto(`${PAGE}/hide`);
  await expect.poll(() => seen.filter((s) => s.kind === "challenge").length).toBe(1);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => events(seen).length, { timeout: 10_000 }).toBe(1);
  const body = events(seen)[0]?.body as Record<string, unknown>;
  expect(validateEventBatch(body)).toBe(true);
  expect(typeof body.t).toBe("string");
  expect(body).not.toHaveProperty("c");
});
