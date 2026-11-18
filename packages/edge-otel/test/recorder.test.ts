// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRecorder, invalidReason as invalidReasonForTest } from "../src/recorder.ts";
import { createUsageMap } from "../src/wrap.ts";
import { points, req, startReceiver } from "./helpers.ts";

let rx: Awaited<ReturnType<typeof startReceiver>>;
beforeAll(async () => {
  rx = await startReceiver();
});
afterAll(() => rx.close());

const base = () => ({ endpoint: rx.base, token: "scfa_ing_recTEST", serviceName: "svc" });

describe("options", () => {
  it.each([
    [{}, /no endpoint/],
    [{ endpoint: "https://e1.usagemap.dev" }, /no ingest token/],
    [{ endpoint: "https://e1.usagemap.dev", token: "scfa_ing_x1234567" }, /no service name/],
    [{ endpoint: "http://e1.usagemap.dev", token: "scfa_ing_x1234567", serviceName: "s" }, /https/],
    [
      { endpoint: "https://u:p@e1.usagemap.dev", token: "scfa_ing_x1234567", serviceName: "s" },
      /credentials/,
    ],
    [{ endpoint: "https://e1.usagemap.dev", token: "bad token", serviceName: "s" }, /token/],
    [
      { endpoint: "https://e1.usagemap.dev", token: "scfa_ing_x1234567", serviceName: "a\nb" },
      /service name/,
    ],
  ])("%j is refused", (o, why) => {
    expect(invalidReasonForTest(o)).toMatch(why);
    expect(() => createRecorder(o)).toThrow(TypeError);
  });

  it("accepts https and local http", () => {
    expect(
      invalidReasonForTest({ ...base(), endpoint: "https://e1.usagemap.dev/" }),
    ).toBeUndefined();
    expect(invalidReasonForTest(base())).toBeUndefined();
  });

  it("createUsageMap never throws: invalid options give a disabled pass-through", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const um = createUsageMap({ endpoint: "ftp://x", token: "t", serviceName: "s" });
    expect(um.enabled).toBe(false);
    expect(um.disabledReason).toMatch(/https/);
    const h = async () => new Response("x");
    expect(um.wrap(h)).toBe(h);
    expect(warn).toHaveBeenCalledOnce();
    const off = createUsageMap({ ...base(), enabled: false });
    expect(off.enabled).toBe(false);
  });
});

describe("batching and export", () => {
  it("exports early when the series cap is reached", async () => {
    let clock = 0;
    const rec = createRecorder({ ...base(), maxSeries: 3, now: () => clock });
    for (const s of [200, 201]) rec.record("GET", "/a", s, 0.01);
    expect(rec.due()).toBe(false);
    rec.record("GET", "/a", 500, 0.01);
    expect(rec.due()).toBe(true);
    clock = 1;
    await rec.flush();
    const [r] = rx.received.splice(0);
    expect(points(r?.body ?? "")).toEqual({ "GET /a 200": 1, "GET /a 201": 1, "GET /a 500": 1 });
    expect(rec.stats.exportedBatches).toBe(1);
  });

  it("histogram buckets, sum, min, max and window timestamps", () => {
    let clock = 1_000;
    const rec = createRecorder({ ...base(), now: () => clock });
    for (const v of [0.004, 0.005, 0.2, 11, -1, Number.NaN]) rec.record("GET", "/x", 200, v);
    clock = 3_500;
    const body = rec.drain() as {
      resourceMetrics: [
        { scopeMetrics: [{ metrics: [{ histogram: { dataPoints: Record<string, unknown>[] } }] }] },
      ];
    };
    const p = body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0] as Record<
      string,
      unknown
    >;
    expect(p.count).toBe("6");
    expect(p.sum).toBeCloseTo(11.209, 6);
    expect(p.min).toBe(0);
    expect(p.max).toBe(11);
    expect(p.startTimeUnixNano).toBe("1000000000");
    expect(p.timeUnixNano).toBe("3500000000");
    // ≤0.005: 0.004, 0.005, -1→0, NaN→0 ; ≤0.25: 0.2 ; >10: 11
    expect(p.bucketCounts).toEqual([
      "4",
      "0",
      "0",
      "0",
      "0",
      "0",
      "1",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "1",
    ]);
    expect(rec.drain()).toBeNull();
  });

  it("unknown methods become _OTHER, impossible status codes 500; unmatched: unknown sends no route", () => {
    const rec = createRecorder({ ...base(), unmatched: "unknown", routes: ["/known"] });
    expect(rec.routeFor("/known")).toBe("/known");
    expect(rec.routeFor("/other/123")).toBeUndefined();
    rec.record("BREW", undefined, 42, 0.1);
    const body = JSON.stringify(rec.drain());
    expect(points(body)).toEqual({ "_OTHER 500": 1 });
  });

  it("retries a failed batch at the next flush, bounded; 4xx is not retried", async () => {
    const errors: string[] = [];
    const rec = createRecorder({
      ...base(),
      maxPendingBatches: 1,
      onExportError: (e) => errors.push(e),
    });
    rx.setStatus(503);
    rec.record("GET", "/a", 200, 0.01);
    await rec.flush();
    rec.record("GET", "/b", 200, 0.01);
    await rec.flush(); // resends /a, sends /b: both fail, only one is kept
    expect(rec.stats.droppedBatches).toBe(1);
    rx.setStatus(200);
    await rec.flush();
    expect(rec.stats.exportedBatches).toBe(1);
    rx.setStatus(401);
    rec.record("GET", "/c", 200, 0.01);
    await rec.flush();
    rx.setStatus(200);
    await rec.flush(); // nothing pending
    const bodies = rx.received.splice(0).map((r) => Object.keys(points(r.body)).join(","));
    expect(bodies).toEqual(["GET /a 200", "GET /a 200", "GET /b 200", "GET /b 200", "GET /c 200"]);
    expect(errors).toEqual(["HTTP 503", "HTTP 503", "HTTP 503", "HTTP 401"]);
  });

  it("a network failure or timeout is counted and swallowed", async () => {
    const errors: string[] = [];
    const rec = createRecorder({
      ...base(),
      fetch: () => Promise.reject(new TypeError("fetch failed")),
      onExportError: (e) => errors.push(e),
    });
    rec.record("GET", "/", 200, 0.01);
    await expect(rec.flush()).resolves.toBeUndefined();
    expect(rec.stats.failedExports).toBe(1);
    const slow = createRecorder({
      ...base(),
      exportTimeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_res, rej) =>
          init?.signal?.addEventListener("abort", () => rej(init.signal?.reason)),
        ),
      onExportError: (e) => errors.push(e),
    });
    slow.record("GET", "/", 200, 0.01);
    await slow.flush();
    expect(errors).toEqual(["network error", "timeout"]);
  });

  it("the response is never delayed by the export", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const um = createUsageMap({
      ...base(),
      flushIntervalMs: 0,
      fetch: async () => {
        await gate;
        return new Response("{}");
      },
    });
    const h = um.wrap(async (_r: Request) => new Response("fast"));
    const res = await h(req("GET", "/"));
    expect(await res.text()).toBe("fast");
    release();
    await um.flush();
  });
});
