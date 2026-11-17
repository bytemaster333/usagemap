// SPDX-License-Identifier: Apache-2.0
// Wallet adapters through the whole stack (plan B2/B3; review of the D1 contracts §5 item 6; ADR-0029, C-45, C-136,
// C-137). Runs before the data-inventory scan (90-inventory) and feeds it canaries.
//
// A real browser loads the tracker's npm build and EVERY wallet adapter — Stellar Wallets Kit, the direct-wallet
// wrappers (Freighter, an injected provider), the RPC submission hook, passkey-kit and smart-account-kit — against
// stand-in wallet objects that hand the adapters canary values in every place a real wallet would: the user's G-address,
// a smart wallet's C-address, signed XDR, a transaction hash, a passkey key id and an error message carrying the
// address. The adapters must turn all of it into schema-v1 enums only:
//   1. no outgoing request body to the ingest hosts contains any canary (checked here, per adapter);
//   2. the gateway accepts the batches (202);
//   3. the canaries are recorded in <work>/canaries.json, so 90-inventory fails if any of them is stored or logged
//      anywhere in the stack (PostgreSQL, spool, Collector queue, every container log).
// Needs the tracker's adapter release (`tracker/src/wallets-kit.ts` exporting `attachWalletsKit`); before it, the test
// is NOT RUN with that reason (and fails under SCF_REQUIRE_FULL_STACK=1), like any missing dependency.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Request } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { context, launch, startIngestProxy } from "../lib/browser.ts";
import { recordCanaries } from "../lib/canaries.ts";
import { Compose } from "../lib/compose.ts";
import { loadEnv, REPO_ROOT } from "../lib/env.ts";
import { createFixture, waitForGateway } from "../lib/fixture.ts";
import { recordGate, requires } from "../lib/gate.ts";
import { Recorder } from "../lib/recorder.ts";
import { adapterPage, asWalletCanaries, walletCanaries } from "../lib/wallet-adapters.ts";

const env = loadEnv();
const compose = new Compose(env);
const rec = new Recorder(
  env,
  "data-inventory",
  "wallet-adapters",
  "Wallet adapters: canary addresses never leave the browser",
  "Every wallet adapter of the tracker ran in a real browser against stand-in wallets that returned canary addresses, signed XDR, transaction hashes, key ids and error messages; the outgoing bodies were checked for the canaries, and the canaries were handed to the data-inventory scan of every store and log.",
);
afterAll(() => {
  const out = rec.write();
  if (out) console.log(`evidence: ${out.md}`);
});

const TRACKER = join(REPO_ROOT, "tracker");
const NPM = join(TRACKER, "dist/npm");
const ENTRIES = ["standard", "wallets-kit", "wallets", "passkey"] as const;

const CONTENT: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

describe("wallet adapters (whole stack)", () => {
  it("no canary leaves the browser, and every canary is handed to the inventory scan", async (ctx) => {
    const d = rec.start(ctx, [
      "feature.wallets-kit-autocapture",
      "privacy.gdpr-no-consent",
      "privacy.minimal-erasure-scope",
    ]);
    await requires(env, ctx, ["gateway", "control-plane", "compose"]);

    // the adapter release must be in the tree (1.0.0 reserved the subpath empty)
    const wk = readFileSync(join(TRACKER, "src/wallets-kit.ts"), "utf8");
    if (!/export function attachWalletsKit\b/.test(wk)) {
      const missing = [
        {
          cap: "gateway" as const,
          detail: "tracker adapter release not in the tree (attachWalletsKit)",
        },
      ];
      recordGate(env, {
        at: new Date().toISOString(),
        suite: ctx.task.file?.name ?? "",
        test: ctx.task.name,
        missing,
        outcome: env.requireFullStack ? "failed_required" : "not_run",
      });
      if (env.requireFullStack)
        throw new Error(`requires: ${missing[0]?.detail} — SCF_REQUIRE_FULL_STACK=1`);
      ctx.skip(`NOT RUN — requires: ${missing[0]?.detail}`);
    }
    if (!ENTRIES.every((e) => existsSync(join(NPM, `${e}.js`))))
      execFileSync(process.execPath, ["scripts/build.ts"], {
        cwd: TRACKER,
        stdio: ["ignore", "ignore", "inherit"],
      });
    const pkg = JSON.parse(readFileSync(join(TRACKER, "package.json"), "utf8")) as {
      name: string;
      version: string;
      exports: Record<string, { default?: string } | string>;
    };
    const manifest = JSON.parse(
      readFileSync(join(TRACKER, `dist/${pkg.version}/manifest.json`), "utf8"),
    ) as {
      config: { hosts: string[] };
    };
    expect(
      manifest.config.hosts,
      "the npm build talks to the hosts the browser proxy maps",
    ).toEqual(env.ingestHosts.map((h) => `https://${h}`));

    const f = await createFixture(env, compose, `wsl-wad-${Date.now().toString(36)}`, [
      { key: "dapp", host: "dapp.wsl.test", anonymousReports: false },
    ]);
    const s = f.sites.dapp;
    if (!s) throw new Error("fixture");
    await waitForGateway(env, compose, [s]);

    const c = walletCanaries();
    const canaries = asWalletCanaries(c);
    recordCanaries(env.workDir, "inventory/wallet-adapters", canaries);

    const base = "/_scf";
    const importMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.exports)) {
      const file = typeof v === "string" ? v : v.default;
      if (!file?.endsWith(".js")) continue;
      importMap[k === "." ? pkg.name : `${pkg.name}${k.slice(1)}`] =
        `${base}/${normalize(file).replace(/^dist\/npm\//, "")}`;
    }
    const html = adapterPage(s.site_key, c, importMap);

    const gw = new URL(env.gatewayUrl);
    const proxy = await startIngestProxy(env.ingestHosts, gw.hostname, Number(gw.port));
    const b = await launch("chromium", proxy.url);
    const bodies: { url: string; body: string }[] = [];
    const statuses: number[] = [];
    try {
      const page = await (await context(b)).newPage();
      await page.route(`${s.origin}/**`, (r) => {
        const p = new URL(r.request().url()).pathname;
        if (p === "/")
          return r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
        if (!p.startsWith(`${base}/`)) return r.fulfill({ status: 404, body: "" });
        const file = normalize(join(NPM, p.slice(base.length)));
        if (!file.startsWith(NPM) || !statSync(file, { throwIfNoEntry: false })?.isFile())
          return r.fulfill({ status: 404, body: "" });
        return r.fulfill({
          status: 200,
          contentType: CONTENT[extname(file)] ?? "application/octet-stream",
          body: readFileSync(file),
        });
      });
      const onIngest = (req: Request) => env.ingestHosts.includes(new URL(req.url()).hostname);
      page.on("request", (req) => {
        if (onIngest(req)) bodies.push({ url: req.url(), body: req.postData() ?? "" });
      });
      page.on("response", (r) => {
        if (onIngest(r.request()) && r.url().endsWith("/v1/e")) statuses.push(r.status());
      });
      await page.goto(`${s.origin}/`);
      await page.waitForFunction(
        () => (window as unknown as { __done?: boolean }).__done === true,
        null,
        {
          timeout: 60_000,
        },
      );
      const steps = await page.evaluate(
        () => (window as unknown as { __adapters: string[] }).__adapters,
      );
      rec.data.adapterSteps = steps;
      expect(steps, "every adapter ran without throwing").toEqual([
        "wallets-kit",
        "freighter",
        "injected",
        "rpc",
        "passkey-kit",
        "smart-account-kit",
      ]);
      // events wait for the proof of work; give the tracker time to send the last adapter's events, then leave the
      // page (pagehide flushes anything still queued with fetch keepalive) and wait for the answers
      const sentAll = () =>
        ["smart_wallet_created", "tx_submitted"].every((n) =>
          bodies.some((x) => x.url.endsWith("/v1/e") && x.body.includes(`"n":"${n}"`)),
        );
      for (let i = 0; i < 120 && !sentAll(); i++) await new Promise((r) => setTimeout(r, 500));
      await page.goto("about:blank");
      await new Promise((r) => setTimeout(r, 2000));
      expect(statuses.length).toBeGreaterThanOrEqual(1);
    } finally {
      await b.close();
      await proxy.close();
    }

    // 1. no canary in any outgoing body (masked in the message)
    const leaks = bodies.flatMap((x) =>
      canaries
        .filter((k) => x.body.includes(k.value))
        .map((k) => `${k.label} in a request to ${new URL(x.url).pathname}`),
    );
    expect(leaks).toEqual([]);
    // and no StrKey shape at all (the XDR, hash, key id and message canaries are checked exactly above)
    for (const x of bodies) expect(x.body, x.url).not.toMatch(/[GCMSTXPLBW][A-Z2-7]{55}/);
    // 2. the gateway accepted every batch
    expect(
      statuses.every((st) => st === 202),
      `statuses ${statuses.join(",")}`,
    ).toBe(true);
    // 3. the events that left are schema-v1 names only
    const sent = bodies
      .filter((x) => x.url.endsWith("/v1/e"))
      .flatMap((x) => (JSON.parse(x.body) as { e: { k: string; n?: string; sv?: number }[] }).e)
      .filter((e) => e.k === "wl");
    const names = [...new Set(sent.map((e) => e.n))].sort();
    rec.data.walletEventsSent = names;
    for (const e of sent) expect(e.sv).toBe(1);
    expect(names).toEqual(
      expect.arrayContaining([
        "passkey_used",
        "sign_approved",
        "sign_rejected",
        "sign_requested",
        "smart_wallet_created",
        "tx_submitted",
        "wallet_connect",
        "wallet_disconnect",
      ]),
    );
    d.detail(
      `${bodies.length} requests to the ingest hosts, ${sent.length} wallet events (${names.join(", ")}), ${canaries.length} canaries handed to the inventory scan`,
    );
  }, 300_000);
});
