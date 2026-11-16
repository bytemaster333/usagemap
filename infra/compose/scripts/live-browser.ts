// SPDX-License-Identifier: Apache-2.0
// Real-browser check of a DEPLOYED stack (live evidence; no interception, no stubs): headless Chromium loads a page of
// the operator's own site that carries the pinned tracker from the ingest names, the tracker solves the challenge and
// sends the page view (the gateway must answer 202), and the page view then appears in the site's dashboard API — the
// same endpoint the portal's dashboard reads — signed in as the site's owner (SEP-53, live-onboard.ts's key).
//
//   node infra/compose/scripts/live-browser.ts --page https://usagemap.dev/docs/ --portal https://app.usagemap.dev \
//     --phrase-file <owner phrase> --onboard <dir with onboard.json> [--site usagemap.dev]
//
// Playwright from the workspace (apps/landing's dev dependency) and its Chromium. Prints one JSON line per step.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiClient } from "../../../tools/demo-seed/src/api.ts";
import { demoKey } from "../../../tools/demo-seed/src/stellar.ts";

const { values } = parseArgs({
  options: {
    page: { type: "string" },
    portal: { type: "string" },
    "phrase-file": { type: "string" },
    onboard: { type: "string" },
    site: { type: "string", default: "usagemap.dev" },
    "headed-ua": { type: "boolean", default: false },
  },
});
const page = values.page ?? "https://usagemap.dev/docs/";
const portal = values.portal ?? "https://app.usagemap.dev";
const onboard = JSON.parse(readFileSync(join(values.onboard ?? ".", "onboard.json"), "utf8")) as {
  tenant_id: string;
  sites: Record<string, { site_id: string; site_key: string }>;
};
const site = onboard.sites[values.site as string];
if (!site) throw new Error(`no site ${values.site} in onboard.json`);
const req = createRequire(join(import.meta.dirname, "../../../apps/landing/package.json"));
const { chromium } = req("@playwright/test") as typeof import("@playwright/test");
const out = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`);

const api = new ApiClient(portal);
await api.signIn(
  demoKey(readFileSync(values["phrase-file"] as string, "utf8").trim(), "usagemap-owner"),
);
type Stats = Record<string, unknown>;
const statsPath = `/v1/tenants/${onboard.tenant_id}/sites/${site.site_id}/web/stats?range=24h&variant=both`;
const before = await api.call<Stats>("GET", statsPath);
out({ step: "dashboard before", stats: before });

// Chromium's new headless mode (the full browser). Its default User-Agent says "HeadlessChrome", which the gateway
// rightly rejects as a bot (reason ua_bot, verified on the live stack); --headed-ua presents the User-Agent and client
// hints of the same Chromium build in headed mode, so the gateway judges the browser on everything else (TLS
// fingerprint, header consistency, proof of work).
const browser = await chromium.launch({ channel: "chromium" });
const probeCtx = await browser.newContext();
const probe = await probeCtx.newPage();
const headlessUA = await probe.evaluate(() => navigator.userAgent);
await probeCtx.close();
const ua = values["headed-ua"] ? headlessUA.replace("HeadlessChrome", "Chrome") : headlessUA;
const major = /Chrome\/(\d+)/.exec(ua)?.[1] ?? "0";
const ctx = await browser.newContext({
  userAgent: ua,
  ...(values["headed-ua"]
    ? {
        extraHTTPHeaders: {
          "sec-ch-ua": `"Chromium";v="${major}", "Not_A Brand";v="24"`,
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Linux"',
        },
      }
    : {}),
}); // a clean profile: no GPC/DNT, no stored opt-out
out({ step: "browser", userAgent: ua });
const tab = await ctx.newPage();
const sent: { url: string; status: number; headers: string[]; body?: string }[] = [];
tab.on("response", async (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/v1/")) return;
  // Header NAMES only (GHSA-3xx8-742v-m4mq: no engine cache token may reach the browser), and the event answer body.
  const entry = {
    url: `${u.origin}${u.pathname}`,
    status: r.status(),
    headers: Object.keys(r.headers()).sort(),
  } as (typeof sent)[number];
  if (u.pathname === "/v1/e") entry.body = (await r.text().catch(() => "")).slice(0, 200);
  sent.push(entry);
});
const t0 = Date.now();
const resp = await tab.goto(page, { waitUntil: "load" });
const script = await tab.evaluate(() =>
  [...document.querySelectorAll("script[src]")].map((s) => ({
    src: (s as HTMLScriptElement).src,
    integrity: (s as HTMLScriptElement).integrity,
  })),
);
out({ step: "page loaded", url: page, status: resp?.status(), scripts: script });
// The tracker sends the page view after its proof of work; wait for the event's answer.
const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !sent.some((s) => s.url.endsWith("/v1/e")))
  await tab.waitForTimeout(500);
out({ step: "tracker requests", ms: Date.now() - t0, requests: sent });
await browser.close();
const event = sent.find((s) => s.url.endsWith("/v1/e"));
if (
  event &&
  (event.headers.some((h) => /umami|cache-token/i.test(h)) || /eyJ|token/i.test(event.body ?? ""))
) {
  out({ step: "FAIL", reason: "the event answer carries an engine token (GHSA-3xx8-742v-m4mq)" });
  process.exit(1);
}
if (event?.status !== 202) {
  out({ step: "FAIL", reason: "no 202 for the page view" });
  process.exit(1);
}

const counts = (s: Stats) => JSON.stringify({ v: s.verified, r: s.raw });
let after: Stats = before;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 15_000));
  after = await api.call<Stats>("GET", statsPath);
  if (counts(after) !== counts(before)) break;
}
out({ step: "dashboard after", stats: after });
if (counts(after) === counts(before)) {
  out({ step: "FAIL", reason: "the dashboard did not change within 10 minutes" });
  process.exit(1);
}
out({ step: "PASS" });
