// SPDX-License-Identifier: Apache-2.0
// Serving a built example app on 127.0.0.1 (a free port): static output through a small file server (with an
// index.html fallback for single-page apps), server-rendered apps through their own production server
// (`pnpm run start`, i.e. `next start`, the Nuxt/Nitro server, SvelteKit's adapter-node, react-router-serve).
// The browser reaches the app at a public-looking https origin that Playwright routes to the local server
// (`proxyOrigin`), so the page runs in a secure context at a real-looking host, as in production.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import type { Page } from "@playwright/test";
import { type App, appEnv, EXAMPLES } from "./apps.ts";

export interface Running {
  port: number;
  /** stdout/stderr of a server process (diagnostics on failure) */
  log: () => string;
  stop: () => Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/** The documented placeholder a tenant replaces with the site key from the portal. */
export const SITE_PLACEHOLDER = "YOUR_22_CHAR_SITE_KEY";

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Static file server for `dir`; `spa` falls back to /index.html; HTML files get the site key pasted in. */
async function serveStatic(dir: string, spa: boolean, site: string): Promise<Running> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(dir, rel);
    if (!file.startsWith(dir)) file = dir;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      if (!spa || extname(rel) !== "") {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      file = join(dir, "index.html");
    }
    let body: Buffer | string = readFileSync(file);
    if (file.endsWith(".html")) body = body.toString("utf8").split(SITE_PLACEHOLDER).join(site);
    res
      .writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      })
      .end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    log: () => "",
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

async function waitReady(port: number, child: ChildProcess, log: () => string): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}):\n${log()}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
      await r.arrayBuffer();
      if (r.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} not ready after 60 s:\n${log()}`);
}

/** `pnpm run start` in the app's directory with PORT/HOST; the whole process group is stopped afterwards. */
async function serveProcess(app: App, site: string): Promise<Running> {
  const port = await freePort();
  const out: string[] = [];
  const child = spawn("pnpm", ["run", "--silent", "start", ...(app.startArgs ?? [])], {
    cwd: join(EXAMPLES, app.id),
    env: { ...appEnv(app, site, "run"), PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const keep = (b: Buffer) => {
    out.push(b.toString("utf8"));
    if (out.length > 200) out.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const log = () => out.join("");
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    const exited = new Promise((r) => child.once("exit", r));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return;
    }
    const t = setTimeout(() => {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {}
    }, 5000);
    await exited;
    clearTimeout(t);
  };
  try {
    await waitReady(port, child, log);
  } catch (e) {
    await stop();
    throw e;
  }
  return { port, log, stop };
}

export function serve(app: App, site: string): Promise<Running> {
  if (app.serve === "ssr") return serveProcess(app, site);
  return serveStatic(join(EXAMPLES, app.id, app.out ?? "."), app.serve === "spa", site);
}

/**
 * Routes every request for `origin` to the local server. Redirects are passed to the browser with their Location
 * rewritten to `origin`, so the page never leaves it.
 */
export async function proxyOrigin(page: Page, origin: string, port: number): Promise<void> {
  const local = `http://127.0.0.1:${port}`;
  await page.route(`${origin}/**`, async (route) => {
    const u = new URL(route.request().url());
    const res = await route.fetch({ url: `${local}${u.pathname}${u.search}`, maxRedirects: 0 });
    const headers = res.headers();
    if (headers.location) headers.location = headers.location.replace(local, origin);
    await route.fulfill({ response: res, headers });
  });
}
