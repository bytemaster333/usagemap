// SPDX-License-Identifier: Apache-2.0
// A Vercel Edge Function (no framework): GET /api/accounts/<id>. Wrapping the default export with `withUsageMap`
// sends UsageMap the request count, status and duration under the route template `/api/accounts/{id}`; the export
// runs after the response through the request context's waitUntil. Query, headers, client address and body are never
// read.
import { optionsFromEnv, withUsageMap } from "@usagemap/edge-otel";

export const config = { runtime: "edge" };

async function handler(req: Request): Promise<Response> {
  const id = new URL(req.url).pathname.split("/").pop() ?? "";
  if (id === "GMISSING") return new Response("not found", { status: 404 });
  return Response.json({ id });
}

export default withUsageMap(handler, {
  ...optionsFromEnv(process.env),
  routes: ["/api/accounts/[id]"],
});
