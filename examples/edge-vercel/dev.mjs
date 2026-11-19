// SPDX-License-Identifier: Apache-2.0
// Runs the edge function locally on Node (no Vercel account needed): http://127.0.0.1:3000/api/accounts/GABC.
// It calls the function the way Vercel's edge runtime does — a Fetch Request and a context with waitUntil. On
// Vercel itself, `vercel deploy` (or `vercel dev`, which needs a linked project) runs the same file.
import { createServer } from "node:http";
import handler from "./api/accounts/[id].ts";

const context = { waitUntil: (p) => p.catch(() => {}) };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (!/^\/api\/accounts\/[^/]+$/.test(url.pathname)) return res.writeHead(404).end("not found");
  const r = await handler(new Request(url, { method: req.method }), context);
  res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
});
server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => {
  console.log(`listening on ${server.address().port}`);
});
