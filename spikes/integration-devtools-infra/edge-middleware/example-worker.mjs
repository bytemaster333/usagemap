// SPDX-License-Identifier: Apache-2.0
// A Cloudflare-Workers-style anchor API instrumented with one wrapper. In a real
// Worker, USAGEMAP_TOKEN is a secret (`wrangler secret put USAGEMAP_TOKEN`).
import { withUsageMap } from "./usagemap-edge.mjs";

const app = {
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/.well-known/stellar.toml") return new Response("WEB_AUTH_ENDPOINT=\"/auth\"\n");
		if (pathname === "/auth") return Response.json({ transaction: "AAAA" });
		if (pathname.startsWith("/sep24/transactions/")) return Response.json({ status: "pending_user_transfer_start" });
		if (pathname.startsWith("/boom")) throw new Error("upstream failed");
		return new Response("not found", { status: 404 });
	},
};

export default withUsageMap(app, (env) => ({
	endpoint: env.USAGEMAP_ENDPOINT,
	token: env.USAGEMAP_TOKEN,
	serviceName: "anchor-edge",
	routes: ["/.well-known/stellar.toml", "/auth", "/sep24/transactions/:id", "/sep12/customer/:account"],
	flushIntervalMs: env.FLUSH_MS ?? 10_000,
	now: env.CLOCK,
}));
