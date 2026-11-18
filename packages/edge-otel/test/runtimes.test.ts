// SPDX-License-Identifier: Apache-2.0
// Each runtime's calling convention, reproduced locally (no deploys):
// Cloudflare Workers (module syntax: fetch(request, env, ctx), ctx.waitUntil),
// Vercel Edge functions (handler(request, context), context.waitUntil),
// Next.js App Router route handlers (GET(request, { params }), waitUntil from
// @vercel/functions passed in), Deno.serve (handler(request, info)) and
// Bun.serve ({ fetch(request, server) } called with this = server).
// Requests carry a User-Agent, IP headers, a cookie, an Authorization header,
// query strings and Stellar addresses in the path; none of them may reach the export.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUsageMap, optionsFromEnv, withUsageMap } from "../src/index.ts";
import {
  ACCOUNT,
  assertNoLeak,
  CONTRACT,
  points,
  type Received,
  req,
  startReceiver,
} from "./helpers.ts";

let rx: Awaited<ReturnType<typeof startReceiver>>;
beforeAll(async () => {
  rx = await startReceiver();
});
afterAll(() => rx.close());

const T0 = 1_794_499_200_000; // 2026-11-12T16:00:00Z

function takeAll(): Received[] {
  return rx.received.splice(0);
}

describe("Cloudflare Workers (module syntax)", () => {
  it("wraps fetch, reads options from env once, exports after the window through ctx.waitUntil", async () => {
    let clock = T0;
    const app = {
      greeting: "hello",
      async fetch(
        this: { greeting: string },
        request: Request,
        _env: unknown,
        _ctx: unknown,
      ): Promise<Response> {
        const { pathname } = new URL(request.url);
        if (pathname === "/.well-known/stellar.toml") return new Response(this.greeting);
        if (pathname === "/auth") return Response.json({ transaction: "AAAA" });
        if (pathname.startsWith("/sep24/transactions/"))
          return Response.json({ status: "pending" });
        if (pathname === "/boom") throw new Error("upstream failed");
        return new Response("not found", { status: 404 });
      },
    };
    const resolver = vi.fn((env: unknown) => ({
      ...optionsFromEnv(env as Record<string, string>),
      routes: ["/.well-known/stellar.toml", "/auth", "/sep24/transactions/:id", "/sep12/customer"],
      now: () => clock,
    }));
    const worker = withUsageMap(app, resolver);
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: rx.base,
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20scfa_ing_workerTEST",
      OTEL_SERVICE_NAME: "anchor-edge",
    };
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        expect(this).toBe(ctx);
        waits.push(p);
      },
      passThroughOnException() {},
    };
    const call = async (method: string, path: string, ms: number) => {
      const p = worker.fetch(req(method, path), env, ctx);
      clock += ms; // Workers' clock advances only across I/O
      return p.catch(() => null);
    };
    expect(await (await call("GET", "/.well-known/stellar.toml", 3))?.text()).toBe("hello");
    await call("POST", "/auth?client_domain=wallet.example", 40);
    await call("GET", "/sep24/transactions/7f8a2c1e?lang=en&token=canary-token", 120);
    await call("GET", "/sep24/transactions/0b1c", 80);
    await call("GET", `/accounts/${ACCOUNT}`, 5);
    await call("GET", `/contracts/${CONTRACT}/u/alice@example.com`, 5);
    expect(await call("GET", "/boom", 2_000)).toBeNull(); // the error reaches the runtime
    expect(waits).toHaveLength(0);
    clock += 10_000;
    await call("GET", "/auth", 10);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(resolver).toHaveBeenCalledTimes(1);

    const [r, ...more] = takeAll();
    expect(more).toHaveLength(0);
    expect(r?.path).toBe("/v1/metrics");
    expect(r?.auth).toBe("Bearer scfa_ing_workerTEST");
    expect(r?.type).toBe("application/json");
    expect(assertNoLeak(r?.body ?? "")).toBeUndefined();
    expect(points(r?.body ?? "")).toEqual({
      "GET /.well-known/stellar.toml 200": 1,
      "POST /auth 200": 1,
      "GET /auth 200": 1,
      "GET /sep24/transactions/{id} 200": 2,
      "GET /accounts/{account} 404": 1,
      "GET /contracts/{contract}/u/{redacted} 404": 1,
      "GET /boom 500": 1,
    });
    const body = JSON.parse(r?.body ?? "{}");
    const metric = body.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.name).toBe("http.server.request.duration");
    expect(metric.unit).toBe("s");
    expect(metric.histogram.aggregationTemporality).toBe(1);
    expect(body.resourceMetrics[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "anchor-edge" } },
    ]);
    const boom = metric.histogram.dataPoints.find(
      (p: { attributes: { value: { stringValue?: string } }[] }) =>
        p.attributes[1]?.value.stringValue === "/boom",
    );
    expect(boom.sum).toBeCloseTo(2, 5);
  });

  it("is a pass-through when the Worker has no UsageMap secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const worker = withUsageMap(
      { fetch: (_r: Request, _e: unknown, _c: unknown) => new Response("ok") },
      (env) => optionsFromEnv(env as never),
    );
    const waits: unknown[] = [];
    const res = await worker.fetch(
      req("GET", "/"),
      {},
      { waitUntil: (p: unknown) => waits.push(p) },
    );
    expect(await res.text()).toBe("ok");
    expect(waits).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/analytics off \(no endpoint/);
  });
});

describe("Vercel Edge function", () => {
  it("uses the request context's waitUntil", async () => {
    let clock = T0;
    const handler = withUsageMap(
      async (request: Request, _context: unknown) =>
        new Response(new URL(request.url).pathname, { status: 201 }),
      {
        endpoint: rx.base,
        token: "scfa_ing_vercelTEST",
        serviceName: "dapp-edge",
        routes: ["/api/orders/[orderId]"],
        flushIntervalMs: 0,
        now: () => clock,
      },
    );
    const waits: Promise<unknown>[] = [];
    const context = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    clock += 1;
    const res = await handler(req("POST", "/api/orders/12345?coupon=canary-token"), context);
    expect(res.status).toBe(201);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    const [r] = takeAll();
    expect(assertNoLeak(r?.body ?? "")).toBeUndefined();
    expect(points(r?.body ?? "")).toEqual({ "POST /api/orders/{orderid} 201": 1 });
  });
});

describe("Next.js App Router route handlers", () => {
  it("one shared instance, a fixed route per handler, waitUntil from @vercel/functions", async () => {
    let clock = T0;
    const waits: Promise<unknown>[] = [];
    const usagemap = createUsageMap({
      endpoint: rx.base,
      token: "scfa_ing_nextTEST",
      serviceName: "dapp-api",
      waitUntil: (p) => waits.push(p), // import { waitUntil } from "@vercel/functions"
      now: () => clock,
    });
    // app/api/items/[id]/route.ts
    const GET = usagemap.wrap(
      async (_request: Request, ctx: { params: Promise<{ id: string }> }) =>
        Response.json({ id: (await ctx.params).id }),
      { route: "/api/items/[id]" },
    );
    // app/api/items/route.ts
    const POST = usagemap.wrap(async (_request: Request) => new Response(null, { status: 204 }), {
      route: "/api/items",
    });
    for (const id of ["1", "2", ACCOUNT]) {
      const res = await GET(req("GET", `/api/items/${id}`), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(200);
    }
    await POST(req("POST", "/api/items?ref=canary-token"));
    expect(waits).toHaveLength(0);
    clock += 10_000;
    await POST(req("POST", "/api/items"));
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    const [r] = takeAll();
    expect(assertNoLeak(r?.body ?? "")).toBeUndefined();
    expect(points(r?.body ?? "")).toEqual({
      "GET /api/items/{id} 200": 3,
      "POST /api/items 204": 2,
    });
  });
});

describe("Deno.serve", () => {
  it("long-lived: the timer exports the last window without a further request; shutdown flushes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const um = createUsageMap({
        ...optionsFromEnv({
          USAGEMAP_ENDPOINT: rx.base,
          USAGEMAP_TOKEN: "scfa_ing_denoTEST",
          OTEL_SERVICE_NAME: "horizon-proxy",
        }),
        routes: ["/accounts/:account_id", "/accounts/:account_id/payments"],
        flushTimer: true,
        flushIntervalMs: 5_000,
      });
      // Deno.serve(handler): handler(request, info) with info.remoteAddr
      const handler = um.wrap(
        async (request: Request, _info: unknown) =>
          new Response(new URL(request.url).pathname.endsWith("payments") ? "[]" : "{}"),
      );
      const info = { remoteAddr: { transport: "tcp", hostname: "203.0.113.9", port: 4711 } };
      await handler(req("GET", `/accounts/${ACCOUNT}`), info);
      await handler(req("GET", `/accounts/${ACCOUNT}/payments?cursor=now&limit=200`), info);
      expect(rx.received).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(rx.received).toHaveLength(1));
      await handler(req("GET", `/accounts/${ACCOUNT}`), info);
      await um.shutdown();
      const [a, b] = takeAll();
      for (const r of [a, b]) expect(assertNoLeak(r?.body ?? "")).toBeUndefined();
      expect(points(a?.body ?? "")).toEqual({
        "GET /accounts/{account_id} 200": 1,
        "GET /accounts/{account_id}/payments 200": 1,
      });
      expect(points(b?.body ?? "")).toEqual({ "GET /accounts/{account_id} 200": 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Bun.serve", () => {
  it("keeps `this` (the server) and the server argument; folds unmatched paths like the Collector", async () => {
    let clock = T0;
    const server = {
      requestIP: (_r: Request) => ({ address: "203.0.113.9" }),
      upgrade: () => false,
    };
    const options = withUsageMap(
      {
        port: 0,
        fetch(this: typeof server, request: Request, srv: typeof server) {
          expect(this).toBe(server);
          srv.requestIP(request); // apps may use it; the wrapper never does
          return new Response("ok");
        },
      },
      {
        endpoint: rx.base,
        token: "scfa_ing_bunTEST",
        serviceName: "bun-api",
        now: () => clock,
      },
    );
    expect(options.port).toBe(0);
    await options.fetch.call(server, req("GET", `/tx/${"ab".repeat(32)}`), server);
    await options.fetch.call(server, req("GET", `/v1/assets/USDC:${ACCOUNT}`), server);
    clock += 10_000;
    await options.fetch.call(server, req("GET", "/orders/987654"), server);
    await vi.waitFor(() => expect(rx.received).toHaveLength(1));
    const [r] = takeAll();
    expect(assertNoLeak(r?.body ?? "")).toBeUndefined();
    expect(points(r?.body ?? "")).toEqual({
      "GET /tx/{hash} 200": 1,
      "GET /v1/assets/{asset} 200": 1,
      "GET /orders/{int} 200": 1,
    });
  });
});
