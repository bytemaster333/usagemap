// SPDX-License-Identifier: Apache-2.0
// Real browsers for the e2e web suite. The tracker's two ingest hosts are compiled into the file (ADR-0004); the
// browsers reach the test gateway through a local CONNECT proxy that maps exactly those two host names to the
// gateway's address and refuses everything else (no egress). TLS stays end to end, so the gateway sees the browser's
// own headers (Sec-Fetch-*, client hints, Accept-Language). Tenant pages are served by request interception on
// their own https:// origin; nothing is fetched from the internet.

import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import { chromium, webkit } from "@playwright/test";

export interface IngestProxy {
  url: string;
  connects: Map<string, number>;
  refused: string[];
  close(): Promise<void>;
}

/** CONNECT proxy: `<ingest host>:443` → gatewayHost:gatewayPort; any other target → 403. */
export async function startIngestProxy(
  ingestHosts: string[],
  gatewayHost: string,
  gatewayPort: number,
): Promise<IngestProxy> {
  const connects = new Map<string, number>();
  const refused: string[] = [];
  const server: Server = createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  server.on("connect", (req, client: Socket, head: Buffer) => {
    const [host, port] = (req.url ?? "").split(":");
    if (!host || port !== "443" || !ingestHosts.includes(host)) {
      refused.push(req.url ?? "");
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    connects.set(host, (connects.get(host) ?? 0) + 1);
    const upstream = connect(gatewayPort, gatewayHost, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    connects,
    refused,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export type Engine = "chromium" | "webkit";

export async function launch(engine: Engine, proxyUrl: string): Promise<Browser> {
  if (engine === "chromium") {
    return chromium.launch({
      proxy: { server: proxyUrl },
      // Without this flag Chromium under automation exposes navigator.webdriver = true, which the tracker reports
      // (sg.wd = 1 → suspect/automation_flag). Masking it is exactly what a stealth-patched browser does — the
      // documented limit of the client-signal layer (ADR-0026 "Honesty in assertions").
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
  return webkit.launch({ proxy: { server: proxyUrl } });
}

/** A browser context whose navigator.webdriver is false (see `launch`), with HTTPS errors ignored for the test CA. */
export async function context(
  browser: Browser,
  opts: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "en-US", ...opts });
  await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
  });
  return ctx;
}

/** Serves `html` for every request under `origin` (the tenant's site). */
export async function serveSite(page: Page, origin: string, html: (path: string) => string) {
  await page.route(`${origin}/**`, (r) => {
    const u = new URL(r.request().url());
    return r.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: html(u.pathname),
    });
  });
}

export interface TrackerRef {
  version: string;
  integrity: string;
  src: string;
}

/** The tenant snippet (classic build, SRI-pinned), as the portal hands it out. */
export function sitePage(opts: {
  tracker: TrackerRef;
  siteKey: string;
  title: string;
  body?: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${opts.title}</title>
<script src="${opts.tracker.src}" integrity="${opts.tracker.integrity}" crossorigin="anonymous" data-site="${opts.siteKey}" defer></script>
</head><body><h1>${opts.title}</h1>
<a id="nav" href="#">next</a> <button id="signup" type="button">Sign up</button>
<script>
document.getElementById("nav").onclick = (e) => { e.preventDefault(); history.pushState({}, "", e.currentTarget.dataset.to || "/next"); };
document.getElementById("signup").onclick = () => { window.__tracked = window.scf.track("signup", { plan: "free" }); };
</script>${opts.body ?? ""}</body></html>`;
}
