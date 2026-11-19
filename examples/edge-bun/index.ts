// SPDX-License-Identifier: Apache-2.0
// A Bun HTTP server. `usagemap.wrap(handler)` sends UsageMap the request count, status and duration per route
// template (`/accounts/{id}`); `flushTimer` exports every 10 s on a long-lived server, and SIGTERM exports what is
// left. Query, headers, client address and body are never read.
import { createUsageMap, optionsFromEnv } from "@usagemap/edge-otel";

function handler(req: Request): Response {
  const { pathname } = new URL(req.url);
  if (pathname === "/health") return Response.json({ ok: true });
  const m = /^\/accounts\/([^/]+)$/.exec(pathname);
  if (m)
    return m[1] === "GMISSING"
      ? new Response("not found", { status: 404 })
      : Response.json({ id: m[1] });
  return new Response("not found", { status: 404 });
}

const usagemap = createUsageMap({
  ...optionsFromEnv(Bun.env),
  routes: ["/health", "/accounts/:id"],
  flushTimer: true,
});
const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  hostname: "127.0.0.1",
  fetch: usagemap.wrap(handler),
});
console.log(`listening on ${server.port}`);
process.on("SIGTERM", async () => {
  await usagemap.shutdown();
  process.exit(0);
});
