// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeTotals,
  HttpClient,
  monthlyFromDaily,
  rangeParams,
  tenantUsername,
  toNumber,
  UmamiConflictError,
  UmamiError,
  UmamiHttpError,
  UmamiProvisioner,
  UmamiReader,
  UmamiUnavailableError,
  visitTokenPurgeOnEveryCore,
} from "../../src/index.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const KEY = `umami_${"a".repeat(32)}`;
const SITE = "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a43";

describe("toNumber (C-99: numbers may arrive as strings)", () => {
  it("parses numbers and numeric strings", () => {
    expect(toNumber(4, "x")).toBe(4);
    expect(toNumber("4", "x")).toBe(4);
    expect(toNumber(" 60 ", "x")).toBe(60);
    expect(toNumber("1.5", "x")).toBe(1.5);
    expect(toNumber(null, "x")).toBe(0);
  });
  it("rejects anything else", () => {
    expect(() => toNumber("4a", "x")).toThrow(/not numeric/);
    expect(() => toNumber({}, "x")).toThrow(/not numeric/);
    expect(() => toNumber(Number.NaN, "x")).toThrow(/not numeric/);
  });
});

describe("rangeParams (C-86, C-99)", () => {
  it("sends endAt = end − 1 ms, timezone UTC, tag=v only for verified, never period", () => {
    expect(rangeParams({ start: 1000, end: 2000 }, "raw")).toEqual({
      startAt: 1000,
      endAt: 1999,
      timezone: "UTC",
    });
    expect(rangeParams({ start: 1000, end: 2000 }, "verified")).toEqual({
      startAt: 1000,
      endAt: 1999,
      timezone: "UTC",
      tag: "v",
    });
  });
  it("refuses empty or non-integer ranges", () => {
    expect(() => rangeParams({ start: 5, end: 5 }, "raw")).toThrow(RangeError);
    expect(() => rangeParams({ start: 1.5, end: 5 }, "raw")).toThrow(RangeError);
  });
});

describe("composeTotals (§j.3 table, C-73)", () => {
  const s = (
    pageviews: number,
    visitors: number,
    visits: number,
    bounces: number,
    totaltime: number,
  ) => ({
    pageviews,
    visitors,
    visits,
    bounces,
    totaltime,
  });
  it("adds twin page views, takes visit metrics from the unfiltered main call only", () => {
    const t = composeTotals(
      s(6, 4, 99, 99, 999),
      s(8, 5, 5, 2, 360),
      s(2, 9, 9, 9, 9),
      s(3, 9, 9, 9, 9),
    );
    expect(t).toEqual({
      pageviews: { verified: 8, raw: 11 },
      pageviewsUnidentified: { verified: 2, raw: 3 },
      visitors: { verified: 4, raw: 5 },
      visits: 5,
      bounces: 2,
      totaltimeSeconds: 360,
      suspectPageviewShare: 1 - 8 / 11,
    });
  });
  it("has no suspect share without page views and works without a twin", () => {
    const t = composeTotals(s(0, 0, 0, 0, 0), s(0, 0, 0, 0, 0), null, null);
    expect(t.suspectPageviewShare).toBeNull();
    expect(t.pageviewsUnidentified).toEqual({ verified: 0, raw: 0 });
  });
});

describe("UmamiReader over HTTP", () => {
  it("builds the exact request: path, query, bearer; parses string numbers", async () => {
    const seen: { url?: string | undefined; auth?: string | undefined } = {};
    const base = await stub((req, res) => {
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { name: "DE", pageviews: "4", visitors: 3, visits: 3, bounces: 2, totaltime: "60" },
        ]),
      );
    });
    const r = new UmamiReader({ baseUrl: base });
    const rows = await r.expanded(
      KEY,
      SITE,
      { start: 1_700_000_000_000, end: 1_700_086_400_000 },
      "country",
      "verified",
    );
    expect(rows).toEqual([
      { name: "DE", pageviews: 4, visitors: 3, visits: 3, bounces: 2, totaltime: 60 },
    ]);
    const u = new URL(seen.url ?? "", base);
    expect(u.pathname).toBe(`/api/websites/${SITE}/metrics/expanded`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      startAt: "1700000000000",
      endAt: "1700086399999",
      timezone: "UTC",
      tag: "v",
      type: "country",
      limit: "500",
    });
    expect(seen.auth).toBe(`Bearer ${KEY}`);
  });

  it("refuses a website id that is not a UUID (no path injection)", async () => {
    const r = new UmamiReader({ baseUrl: "http://127.0.0.1:9" });
    await expect(r.stats(KEY, "../admin", { start: 0, end: 1 }, "raw")).rejects.toThrow(RangeError);
  });

  it("times out after the configured limit and signals the rollup fallback (C-112(6))", async () => {
    const base = await stub(() => {
      /* never answers */
    });
    const r = new UmamiReader({ baseUrl: base, timeoutMs: 150 });
    const t0 = Date.now();
    const err = await r.stats(KEY, SITE, { start: 0, end: 1000 }, "raw").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmamiUnavailableError);
    expect((err as UmamiUnavailableError).reason).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("defaults to a 5 s timeout", async () => {
    const base = await stub(() => {});
    const client = new HttpClient({ baseUrl: base });
    const t0 = Date.now();
    const err = await client
      .call({ method: "GET", path: "/x", template: "/x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmamiUnavailableError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900);
  }, 10_000);

  it("maps connection failures to UmamiUnavailableError", async () => {
    const r = new UmamiReader({ baseUrl: "http://127.0.0.1:1", timeoutMs: 1000 });
    const err = await r.stats(KEY, SITE, { start: 0, end: 1 }, "raw").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmamiUnavailableError);
    expect((err as UmamiUnavailableError).reason).toBe("connection");
  });

  it("errors carry the path template and status, never the query, key or body", async () => {
    const base = await stub((_req, res) => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "secret-detail team_abcdef" } }));
    });
    const r = new UmamiReader({ baseUrl: base });
    const err = (await r
      .stats(KEY, SITE, { start: 0, end: 1 }, "raw")
      .catch((e: unknown) => e)) as UmamiHttpError;
    expect(err).toBeInstanceOf(UmamiHttpError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("umami GET /api/websites/{websiteId}/stats answered 401");
    expect(err.engineMessage).toBeUndefined();
    expect(JSON.stringify({ ...err, m: err.message })).not.toMatch(
      /umami_a|startAt|secret-detail|team_/,
    );
  });

  it("caps response size", async () => {
    const base = await stub((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(`[${"1,".repeat(2000)}1]`);
    });
    const client = new HttpClient({ baseUrl: base, maxResponseBytes: 1000 });
    const err = await client
      .call({ method: "GET", path: "/", template: "/" })
      .catch((e: unknown) => e);
    expect((err as UmamiUnavailableError).reason).toBe("too_large");
  });

  it("requires https for mutual TLS", () => {
    expect(
      () => new HttpClient({ baseUrl: "http://x", tls: { cert: "c", key: "k", ca: "a" } }),
    ).toThrow(/https/);
    expect(() => new HttpClient({ baseUrl: "ftp://x" })).toThrow(/http/);
  });
});

describe("UmamiReader report reads R6–R8 (Umami 3.5.0 ad-hoc GET routes)", () => {
  const RANGE = { start: 1_700_000_000_000, end: 1_700_086_400_000 };
  async function capture(answer: unknown) {
    const seen: { url: string } = { url: "" };
    const base = await stub((req, res) => {
      seen.url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer));
    });
    return { r: new UmamiReader({ baseUrl: base }), seen, base };
  }
  const query = (seen: { url: string }, base: string) => {
    const u = new URL(seen.url, base);
    return { path: u.pathname, q: Object.fromEntries(u.searchParams) };
  };

  it("R6 funnel: steps as JSON, window in minutes, range rules; visitors per step (strings parsed)", async () => {
    const { r, seen, base } = await capture([
      { type: "path", value: "/", visitors: "5", previous: 0, dropped: 0, dropoff: null },
      { type: "event", value: "signup", visitors: 2, previous: 5, dropped: 3, dropoff: 0.6 },
    ]);
    const steps = [
      { type: "path" as const, value: "/" },
      { type: "event" as const, value: "signup" },
    ];
    expect(await r.funnel(KEY, SITE, RANGE, steps, 30, "verified")).toEqual([
      { type: "path", value: "/", visitors: 5 },
      { type: "event", value: "signup", visitors: 2 },
    ]);
    const { path, q } = query(seen, base);
    expect(path).toBe(`/api/websites/${SITE}/funnels/stats`);
    expect(q).toEqual({
      startAt: "1700000000000",
      endAt: "1700086399999",
      timezone: "UTC",
      tag: "v",
      window: "30",
      steps: JSON.stringify(steps),
    });
  });

  it("R6 funnel: refuses bad steps and windows before calling, and an answer of the wrong length", async () => {
    const { r } = await capture([{ type: "path", value: "/", visitors: 1 }]);
    const one = [{ type: "path" as const, value: "/" }];
    await expect(r.funnel(KEY, SITE, RANGE, one, 30, "raw")).rejects.toThrow(RangeError);
    const nine = Array.from({ length: 9 }, () => ({ type: "path" as const, value: "/" }));
    await expect(r.funnel(KEY, SITE, RANGE, nine, 30, "raw")).rejects.toThrow(RangeError);
    const two = [...one, { type: "path" as const, value: "/a" }];
    await expect(r.funnel(KEY, SITE, RANGE, two, 0, "raw")).rejects.toThrow(RangeError);
    await expect(r.funnel(KEY, SITE, RANGE, two, 1441, "raw")).rejects.toThrow(RangeError);
    await expect(
      r.funnel(KEY, SITE, RANGE, [...one, { type: "path", value: "/a\nb" }], 30, "raw"),
    ).rejects.toThrow(RangeError);
    await expect(
      r.funnel(KEY, SITE, RANGE, [...one, { type: "url" as "path", value: "/a" }], 30, "raw"),
    ).rejects.toThrow(RangeError);
    await expect(r.funnel(KEY, SITE, RANGE, two, 30, "raw")).rejects.toBeInstanceOf(UmamiError);
  });

  it("R7 goal: type and value, raw without tag; num and total parsed", async () => {
    const { r, seen, base } = await capture({ num: "3", total: 10 });
    expect(await r.goal(KEY, SITE, RANGE, { type: "path", value: "/docs/*" }, "raw")).toEqual({
      visitors: 3,
      total: 10,
    });
    const { path, q } = query(seen, base);
    expect(path).toBe(`/api/websites/${SITE}/goals/stats`);
    expect(q).toEqual({
      startAt: "1700000000000",
      endAt: "1700086399999",
      timezone: "UTC",
      type: "path",
      value: "/docs/*",
    });
  });

  it("R8 journey: steps and optional start/end step; trailing nulls dropped", async () => {
    const { r, seen, base } = await capture([
      { items: ["/", "/pricing", "signup", null], count: "12" },
      { items: ["/", null, null, null], count: 4 },
    ]);
    expect(await r.journey(KEY, SITE, RANGE, { steps: 3, startStep: "/" }, "verified")).toEqual([
      { items: ["/", "/pricing", "signup"], count: 12 },
      { items: ["/"], count: 4 },
    ]);
    const { path, q } = query(seen, base);
    expect(path).toBe(`/api/websites/${SITE}/journeys`);
    expect(q).toEqual({
      startAt: "1700000000000",
      endAt: "1700086399999",
      timezone: "UTC",
      tag: "v",
      steps: "3",
      startStep: "/",
    });
    await expect(r.journey(KEY, SITE, RANGE, { steps: 1 }, "raw")).rejects.toThrow(RangeError);
    await expect(r.journey(KEY, SITE, RANGE, { steps: 8 }, "raw")).rejects.toThrow(RangeError);
    await expect(
      r.journey(KEY, SITE, RANGE, { steps: 3, endStep: "x".repeat(501) }, "raw"),
    ).rejects.toThrow(RangeError);
  });
});

describe("provisioning helpers", () => {
  it("derives the engine username from the tenant id", () => {
    expect(tenantUsername("0193B7E2-0000-7000-8000-00000000000A")).toBe(
      "scf-t-0193b7e200007000800000000000000a",
    );
    expect(() => tenantUsername("nope")).toThrow();
  });

  it("purges visit tokens on every core and fails if one core does not answer 204 (C-112(9))", async () => {
    const hits: string[] = [];
    const ok = await stub((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.statusCode = 204;
      res.end();
    });
    const bad = await stub((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    await visitTokenPurgeOnEveryCore([
      new HttpClient({ baseUrl: ok }),
      new HttpClient({ baseUrl: ok }),
    ])(SITE);
    expect(hits).toEqual([
      `DELETE /internal/v1/visit-tokens/websites/${SITE}`,
      `DELETE /internal/v1/visit-tokens/websites/${SITE}`,
    ]);
    await expect(
      visitTokenPurgeOnEveryCore([
        new HttpClient({ baseUrl: ok }),
        new HttpClient({ baseUrl: bad }),
      ])(SITE),
    ).rejects.toThrow(/1 of 2 cores/);
    await expect(visitTokenPurgeOnEveryCore([])(SITE)).rejects.toThrow(/no engine proxies/);
  });

  it("refuses short bootstrap passwords before calling the engine", async () => {
    const p = new UmamiProvisioner({ baseUrl: "http://127.0.0.1:1" });
    await expect(
      p.ensureBootstrap({
        seedInterimPassword: "short",
        provisioningUsername: "p",
        provisioningPassword: "x".repeat(20),
      }),
    ).rejects.toThrow(/at least 8/);
  });

  it("never sends the P7 request twice and maps 'ID already in use.' in our own team to exists", async () => {
    let posts = 0;
    const seen: string[] = [];
    const base = await stub((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        posts++;
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "ID already in use." } }));
        return;
      }
      res.end(JSON.stringify({ id: SITE, name: "s", teamId: SITE }));
    });
    const p = new UmamiProvisioner({ baseUrl: base });
    expect(
      await p.createWebsite("t", { id: SITE, name: "s", domain: "invalid.example", teamId: SITE }),
    ).toBe("exists");
    expect(posts).toBe(1);
    expect(seen).toEqual(["POST /api/websites", `GET /api/websites/${SITE}`]);
  });

  it("refuses 'ID already in use.' when the website belongs to another team or to no team", async () => {
    let owner: string | null = "0e0e0e0e-0000-4000-8000-000000000000";
    const base = await stub((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "ID already in use." } }));
        return;
      }
      res.end(JSON.stringify({ id: SITE, name: "s", teamId: owner, userId: owner ? null : "u" }));
    });
    const p = new UmamiProvisioner({ baseUrl: base });
    const spec = { id: SITE, name: "s", domain: "invalid.example", teamId: SITE };
    const err = await p.createWebsite("t", spec).catch((e) => e);
    expect(err).toBeInstanceOf(UmamiConflictError);
    expect(String(err.message)).toMatch(/another owner/);
    owner = null;
    await expect(p.createWebsite("t", spec)).rejects.toBeInstanceOf(UmamiConflictError);
  });
});

describe("monthlyFromDaily", () => {
  it("sums day buckets into UTC months", () => {
    expect(
      monthlyFromDaily([
        { x: "2026-10-31T00:00:00Z", y: 2 },
        { x: "2026-11-01T00:00:00Z", y: 3 },
        { x: "2026-11-12T00:00:00.000Z", y: 4 },
      ]),
    ).toEqual([
      { x: "2026-10-01T00:00:00.000Z", y: 2 },
      { x: "2026-11-01T00:00:00.000Z", y: 7 },
    ]);
    expect(() => monthlyFromDaily([{ x: "nope", y: 1 }])).toThrow();
  });
});
