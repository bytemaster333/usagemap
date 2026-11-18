// SPDX-License-Identifier: Apache-2.0
// Step (d): one real page view from a real browser engine (Chromium via Playwright, if installed in this checkout).
// The tenant's page is served by request interception on the site's own declared origin (so the browser sends that
// Origin, exactly as on the real site); the SRI-pinned tracker is loaded from the ingest host and runs unmodified:
// challenge, proof of work in WebCrypto, one page view. For a local stack a CONNECT proxy sends the tracker's compiled
// ingest hosts to the stack's gateway (TLS stays end to end).
//
// Stated limit (ADR-0008): Playwright's Chromium reports itself as automated unless told not to; like the repo's own
// e2e suite this run masks `navigator.webdriver` and uses a desktop Chrome User-Agent of the same major version —
// what a stealth-patched browser farm can also do. It is counted because it is a real browser engine running the
// real tracker; telling a driven real browser from a person is left to multiplicity (L6) and the daily trust score
// (L7), not to the request layer.

import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHROME_UA } from "./protocol.ts";

export interface BrowserVisit {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The tracker's batch as the browser sent it (token, proof, event): the material for the replay step. */
  requestBody: string;
  requestHeaders: Record<string, string>;
  userAgent: string;
  browserVersion: string;
}

interface PwModule {
  chromium: {
    launch(o: Record<string, unknown>): Promise<PwBrowser>;
  };
}
interface PwBrowser {
  version(): string;
  newContext(o: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwContext {
  addInitScript(fn: () => void): Promise<void>;
  newPage(): Promise<PwPage>;
}
interface PwRoute {
  request(): { url(): string };
  fulfill(o: Record<string, unknown>): Promise<void>;
}
interface PwPage {
  route(url: string, h: (r: PwRoute) => Promise<void> | void): Promise<void>;
  waitForResponse(pred: (r: PwResponse) => boolean, o: { timeout: number }): Promise<PwResponse>;
  goto(url: string): Promise<unknown>;
}
interface PwResponse {
  url(): string;
  status(): number;
  allHeaders(): Promise<Record<string, string>>;
  text(): Promise<string>;
  request(): {
    method(): string;
    postData(): string | null;
    allHeaders(): Promise<Record<string, string>>;
  };
}

/** Finds Playwright in this checkout (the tests workspace) or next to the current directory; undefined when absent. */
export async function findPlaywright(repoRoot: string): Promise<PwModule | undefined> {
  for (const base of [
    join(repoRoot, "tests", "package.json"),
    join(process.cwd(), "package.json"),
  ]) {
    try {
      const p = createRequire(base).resolve("@playwright/test");
      const m = (await import(pathToFileURL(p).href)) as PwModule & { default?: PwModule };
      const pw = m.chromium ? m : m.default;
      if (pw?.chromium) return pw;
    } catch {
      // not here
    }
  }
  return undefined;
}

export const PLAYWRIGHT_HINT =
  "Playwright is not installed in this checkout. Install it once with\n" +
  "  pnpm install --frozen-lockfile && pnpm --filter tests exec playwright install chromium\n" +
  "and run again with --browser; or visit the site in your own browser and re-run with --skip-browser to see the\n" +
  "verified count rise in the operator API.";

/** CONNECT proxy: `<allowed host>:443` → target; anything else is refused (no other egress). */
async function startProxy(
  allowed: string[],
  target: { host: string; port: number },
): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_q, s) => {
    s.writeHead(403);
    s.end();
  });
  server.on("connect", (req, client: Socket, head: Buffer) => {
    const [host, port] = (req.url ?? "").split(":");
    if (!host || port !== "443" || !allowed.includes(host)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const up = connect(target.port, target.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  return {
    url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export async function browserVisit(
  pw: PwModule,
  o: {
    origin: string;
    path: string;
    siteKey: string;
    trackerSrc: string;
    integrity: string;
    ingestHosts: string[];
    connect?: { host: string; port: number } | undefined;
    ignoreHttpsErrors: boolean;
    timeoutMs?: number;
  },
): Promise<BrowserVisit> {
  const proxy = o.connect ? await startProxy(o.ingestHosts, o.connect) : undefined;
  const browser = await pw.chromium.launch({
    ...(proxy ? { proxy: { server: proxy.url } } : {}),
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const version = browser.version();
    const ua = CHROME_UA(Number(version.split(".")[0]));
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: o.ignoreHttpsErrors,
      locale: "en-US",
      userAgent: ua,
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    });
    const page = await ctx.newPage();
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>forge check</title>
<script src="${o.trackerSrc}" integrity="${o.integrity}" crossorigin="anonymous" data-site="${o.siteKey}" defer></script>
</head><body><h1>UsageMap forge check</h1><p>A real browser running the real tracker.</p></body></html>`;
    await page.route(`${o.origin}/**`, (r) =>
      r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    const resp = page.waitForResponse(
      (r) => r.url().endsWith("/v1/e") && r.request().method() === "POST",
      { timeout: o.timeoutMs ?? 30_000 },
    );
    await page.goto(`${o.origin}${o.path}`);
    const r = await resp;
    return {
      status: r.status(),
      headers: await r.allHeaders(),
      body: await r.text(),
      requestBody: r.request().postData() ?? "",
      requestHeaders: await r.request().allHeaders(),
      userAgent: ua,
      browserVersion: version,
    };
  } finally {
    await browser.close();
    await proxy?.close();
  }
}
