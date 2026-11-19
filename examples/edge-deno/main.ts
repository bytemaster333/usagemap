// SPDX-License-Identifier: Apache-2.0
// A Deno HTTP server. `usagemap.wrap(handler)` sends UsageMap the request count, status and duration per route
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
  ...optionsFromEnv(Deno.env.toObject()),
  routes: ["/health", "/accounts/:id"],
  flushTimer: true,
});
Deno.serve(
  { port: Number(Deno.env.get("PORT") ?? 8000), hostname: "127.0.0.1" },
  usagemap.wrap(handler),
);
Deno.addSignalListener("SIGTERM", async () => {
  await usagemap.shutdown();
  Deno.exit(0);
});
