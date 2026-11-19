// SPDX-License-Identifier: Apache-2.0
// A Cloudflare Worker with two routes. Wrapping the export with `withUsageMap` sends UsageMap the request count,
// status and duration per route template (`/accounts/{id}`), exported after the response via ctx.waitUntil. The
// query string, headers, client address and body are never read.
import { optionsFromEnv, withUsageMap } from "@usagemap/edge-otel";

const app = {
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return Response.json({ ok: true });
    const m = /^\/accounts\/([^/]+)$/.exec(pathname);
    if (m)
      return m[1] === "GMISSING"
        ? new Response("not found", { status: 404 })
        : Response.json({ id: m[1] });
    return new Response("not found", { status: 404 });
  },
};

export default withUsageMap(app, (env: Record<string, unknown>) => ({
  ...optionsFromEnv(env),
  routes: ["/health", "/accounts/:id"],
}));
