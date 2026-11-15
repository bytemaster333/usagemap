// SPDX-License-Identifier: Apache-2.0
// Serves a fixture app to the browser by route interception (no ports): files from e2e/.build/<app>/, with an SPA
// fallback to index.html, the tenant's tracker snippet inserted at <!--TRACKER--> and the site key at <!--SITE-->.
// The SSR fixture instead renders every document request on the server side (in this Node process) per request.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Page } from "@playwright/test";
import { OUT } from "../apps/build.ts";
import { SITE } from "./gateway.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
};
const type = (p: string): string =>
  TYPES[p.slice(p.lastIndexOf("."))] ?? "application/octet-stream";

export interface ServeOptions {
  /** HTML inserted at `<!--TRACKER-->` (the tenant's snippet); default none. */
  tracker?: string;
  /** Extra response headers for documents (e.g. a CSP). */
  headers?: Record<string, string>;
  /** Fall back to index.html for unknown paths (History-API SPAs); default true. */
  spa?: boolean;
}

/** Serve e2e/.build/<app>/ at `origin`. */
export async function serveApp(
  page: Page,
  origin: string,
  app: string,
  opts: ServeOptions = {},
): Promise<void> {
  const dir = join(OUT, app);
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(dir, rel);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      if (opts.spa === false) return route.fulfill({ status: 404, body: "not found" });
      file = join(dir, "index.html");
    }
    let body: string | Buffer = readFileSync(file);
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (file.endsWith(".html")) {
      body = body
        .toString("utf8")
        .replace("<!--TRACKER-->", opts.tracker ?? "")
        .replace("<!--SITE-->", SITE);
      Object.assign(headers, opts.headers);
    }
    return route.fulfill({ status: 200, contentType: type(file), headers, body });
  });
}

interface SsrModule {
  render(
    url: string,
    o: { site: string; trackerTag: string },
  ): Promise<{ status: number; html: string; location?: string }>;
  serverInit(site: string): unknown;
}

let ssr: SsrModule | undefined;
/** The SSR fixture's server bundle (CommonJS, built by e2e/apps/build.ts). */
export async function ssrModule(): Promise<SsrModule> {
  ssr ??= (await import(join(OUT, "ssr", "server.cjs"))).default as SsrModule;
  return ssr;
}

/** Serve the SSR fixture at `origin`: /client.js from disk, every other GET rendered on the server per request. */
export async function serveSsr(page: Page, origin: string, trackerTag: string): Promise<void> {
  const mod = await ssrModule();
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/client.js") {
      return route.fulfill({
        status: 200,
        contentType: type(".js"),
        body: readFileSync(join(OUT, "ssr", "public", "client.js")),
      });
    }
    const res = await mod.render(url.href, { site: SITE, trackerTag });
    if (res.location)
      return route.fulfill({ status: res.status, headers: { location: res.location } });
    return route.fulfill({ status: res.status, contentType: type(".html"), body: res.html });
  });
}
