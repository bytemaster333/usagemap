// SPDX-License-Identifier: Apache-2.0
// Polite registry access (src/registry/polite.ts; PG Atlas has answered 429 to every per-project
// request of job registry_sync). Against a fake HTTP server: one request at a time with a minimum interval, 429/503
// retried after Retry-After (seconds or HTTP date) or an exponential backoff with full jitter, a breaker once the
// source keeps limiting, a per-run request cap, and a PG Atlas run that defers what it could not fetch and resumes on
// the next run without re-asking what it already has.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BudgetExhaustedError,
  HttpStatusError,
  PoliteClient,
  type PoliteOptions,
  RateLimitedError,
  retryAfterMs,
} from "../../src/registry/polite.ts";
import { PgAtlasSource, type PreviousRow } from "../../src/registry/sources.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;

let server: Server;
let base = "";
let handler: Handler = (_q, res) => res.end("{}");
let hits: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    hits.push(req.url ?? "");
    res.on("close", () => {
      inFlight--;
    });
    // A little server time, so overlapping requests would be visible.
    setTimeout(() => handler(req, res, hits.length), 5);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  hits = [];
  inFlight = 0;
  maxInFlight = 0;
});

const json = (res: ServerResponse, code: number, body: unknown, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** A client whose waits are recorded and only nominally slept (the timing is checked on the record). */
function client(opts: PoliteOptions = {}) {
  const waits: number[] = [];
  let clock = 1_000_000;
  const c = new PoliteClient({
    minIntervalMs: 1000,
    random: () => 1,
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      if (ms > 0) {
        waits.push(ms);
        clock += ms;
      }
    },
    ...opts,
  });
  return { c, waits };
}

const signal = () => new AbortController().signal;

describe("retryAfterMs", () => {
  it("reads delta-seconds and HTTP dates; ignores junk", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect(retryAfterMs("120", now)).toBe(120_000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
    expect(retryAfterMs("Thu, 19 Nov 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Thu, 19 Nov 2026 09:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(retryAfterMs("-5", now)).toBeNull();
  });
});

describe("PoliteClient against a fake server", () => {
  it("sends one request at a time, at least minIntervalMs apart", async () => {
    handler = (_q, res) => json(res, 200, { ok: true });
    const { c, waits } = client({ minIntervalMs: 1000 });
    const s = signal();
    const all = await Promise.all([1, 2, 3, 4].map((i) => c.get(`${base}/p/${i}`, s)));
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    await Promise.all(all.map((r) => r.body?.cancel()));
    expect(maxInFlight).toBe(1);
    expect(hits).toEqual(["/p/1", "/p/2", "/p/3", "/p/4"]); // in call order
    expect(waits).toEqual([1000, 1000, 1000]); // none before the first
    expect(c.requests).toBe(4);
  });

  it("serialises for real (no fake sleep): concurrency 1 with wall-clock spacing", async () => {
    handler = (_q, res) => json(res, 200, {});
    const c = new PoliteClient({ minIntervalMs: 30 });
    const s = signal();
    const t0 = Date.now();
    const all = await Promise.all([1, 2, 3].map((i) => c.get(`${base}/r/${i}`, s)));
    await Promise.all(all.map((r) => r.body?.cancel()));
    expect(maxInFlight).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
  });

  it("waits the server's Retry-After on 429, then succeeds", async () => {
    handler = (_q, res, n) =>
      n === 1 ? json(res, 429, {}, { "retry-after": "7" }) : json(res, 200, { ok: 1 });
    const { c, waits } = client({ minIntervalMs: 0 });
    const r = await c.get(`${base}/x`, signal());
    expect(await r.json()).toEqual({ ok: 1 });
    expect(waits).toEqual([7000]);
    expect(hits).toHaveLength(2);
  });

  it("honours Retry-After as an HTTP date on 503", async () => {
    const { c, waits } = client({
      minIntervalMs: 0,
      now: () => Date.parse("2026-11-19T10:00:00Z"),
    });
    handler = (_q, res, n) =>
      n === 1
        ? json(res, 503, {}, { "retry-after": "Thu, 19 Nov 2026 10:00:12 GMT" })
        : json(res, 200, {});
    await (await c.get(`${base}/y`, signal())).body?.cancel();
    expect(waits).toEqual([12_000]);
  });

  it("without Retry-After backs off exponentially with full jitter, capped", async () => {
    handler = (_q, res, n) => (n < 5 ? json(res, 429, {}) : json(res, 200, {}));
    const rnd = [1, 0.5, 1, 1];
    const { c, waits } = client({
      minIntervalMs: 0,
      maxAttempts: 5,
      backoffBaseMs: 1000,
      backoffCapMs: 5000,
      random: () => rnd.shift() ?? 1,
    });
    await (await c.get(`${base}/z`, signal())).body?.cancel();
    // attempt 1: U[0,1000]·1 → 1000; 2: U[0,2000]·0.5 → 1000; 3: U[0,4000] → 4000; 4: min(8000, cap 5000) → 5000
    expect(waits).toEqual([1000, 1000, 4000, 5000]);
  });

  it("opens its breaker after the last attempt: no further request this run", async () => {
    handler = (_q, res) => json(res, 429, {});
    const { c } = client({ minIntervalMs: 0, maxAttempts: 3, backoffBaseMs: 10 });
    await expect(c.get(`${base}/a`, signal())).rejects.toBeInstanceOf(RateLimitedError);
    expect(hits).toHaveLength(3);
    await expect(c.get(`${base}/b`, signal())).rejects.toBeInstanceOf(RateLimitedError);
    expect(hits).toHaveLength(3);
  });

  it("names the breaker by cause: 429 rate-limited, 503 unavailable (the run's error code)", async () => {
    handler = (_q, res) => json(res, 429, {});
    const a = await client({ minIntervalMs: 0, maxAttempts: 1 })
      .c.get(`${base}/a`, signal())
      .catch((e) => e);
    expect(a).toMatchObject({ name: "RegistryRateLimited", status: 429 });
    handler = (_q, res) => json(res, 503, {});
    const b = await client({ minIntervalMs: 0, maxAttempts: 1 })
      .c.get(`${base}/b`, signal())
      .catch((e) => e);
    expect(b).toBeInstanceOf(RateLimitedError);
    expect(b).toMatchObject({ name: "RegistryUnavailable", status: 503 });
  });

  it("does not wait a Retry-After longer than one run waits: stops at once", async () => {
    handler = (_q, res) => json(res, 429, {}, { "retry-after": "3600" });
    const { c, waits } = client({ minIntervalMs: 0, maxRetryAfterMs: 300_000 });
    await expect(c.get(`${base}/a`, signal())).rejects.toBeInstanceOf(RateLimitedError);
    expect(waits).toEqual([]);
    expect(hits).toHaveLength(1);
  });

  it("caps the requests of a run (every attempt counts)", async () => {
    handler = (_q, res, n) => (n === 1 ? json(res, 429, {}) : json(res, 200, {}));
    const { c } = client({ minIntervalMs: 0, maxRequests: 3, backoffBaseMs: 1 });
    await (await c.get(`${base}/1`, signal())).body?.cancel(); // 2 requests
    await (await c.get(`${base}/2`, signal())).body?.cancel(); // 3
    await expect(c.get(`${base}/3`, signal())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(hits).toHaveLength(3);
  });

  it("does not retry other errors (404 of one project)", async () => {
    handler = (_q, res) => json(res, 404, {});
    const { c } = client({ minIntervalMs: 0 });
    const err = await c.get(`${base}/missing`, signal()).catch((e) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.status).toBe(404);
    expect(err.name).toBe("RegistrySourceError");
    expect(hits).toHaveLength(1);
  });

  it("an abort ends a backoff wait", async () => {
    handler = (_q, res) => json(res, 429, {}, { "retry-after": "60" });
    const ac = new AbortController();
    const c = new PoliteClient({ minIntervalMs: 0 });
    const p = c.get(`${base}/slow`, ac.signal);
    setTimeout(() => ac.abort(new Error("run aborted")), 50);
    await expect(p).rejects.toThrow("run aborted");
  });
});

describe("PgAtlasSource: deferral and resumable progress", () => {
  const ids = Array.from({ length: 6 }, (_, i) => `daoip-5:stellar:project:p${i}`);
  let limitAfter = Number.POSITIVE_INFINITY;
  let details = 0;

  beforeEach(() => {
    details = 0;
    limitAfter = Number.POSITIVE_INFINITY;
    handler = (req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/pga/projects") {
        const items = ids.map((id) => ({
          canonical_id: id,
          display_name: id.slice(-2),
          updated_at: "2026-11-19T00:00:00Z",
        }));
        return json(res, 200, { items, total: items.length });
      }
      const id = decodeURIComponent(u.pathname.replace("/pga/projects/", ""));
      details++;
      if (details > limitAfter) return json(res, 429, {}, { "retry-after": "1" });
      json(res, 200, {
        canonical_id: id,
        display_name: id.slice(-2),
        updated_at: "2026-11-19T00:00:00Z",
        metadata: { website: null, scf_submissions: [], scf_tranche_completion: null },
      });
    };
  });

  const fast = (o: PoliteOptions = {}): PoliteOptions => ({
    minIntervalMs: 0,
    maxAttempts: 2,
    sleep: async () => {},
    ...o,
  });

  it("a rate-limited run keeps known rows, defers the rest, and the next run fetches only those", async () => {
    // Run 1: the source allows 2 detail answers, then limits; 4 projects are deferred (all new: not returned).
    limitAfter = 2;
    const src = new PgAtlasSource(`${base}/pga`, { polite: fast() });
    const r1 = await src.fetchAll(signal(), new Map());
    expect(r1.map((r) => r.sourceId)).toEqual(ids.slice(0, 2));
    expect(src.lastRun).toEqual({ requests: 1 + 2 + 2, deferred: 4, rateLimited: true });

    // Run 2: limits again after 1; the 2 stored projects are not asked again (unchanged), 1 new fetched, 3 deferred.
    const prev = new Map<string, PreviousRow>(r1.map((r) => [r.sourceId, { raw: r.raw }]));
    details = 0;
    limitAfter = 1;
    const r2 = await src.fetchAll(signal(), prev);
    expect(r2.map((r) => r.sourceId).sort()).toEqual(ids.slice(0, 3));
    expect(src.lastRun).toMatchObject({ deferred: 3, rateLimited: true });

    // Run 3: no limit: only the 3 still missing are fetched; everything is there.
    for (const r of r2) prev.set(r.sourceId, { raw: r.raw });
    details = 0;
    limitAfter = Number.POSITIVE_INFINITY;
    hits = [];
    const r3 = await src.fetchAll(signal(), prev);
    expect(r3.map((r) => r.sourceId).sort()).toEqual(ids);
    expect(hits.filter((h) => h.startsWith("/pga/projects/"))).toHaveLength(3);
    expect(src.lastRun).toEqual({ requests: 4, deferred: 0, rateLimited: false });
  });

  it("a changed known project whose detail is deferred keeps its stored statement (not marked missing)", async () => {
    const src = new PgAtlasSource(`${base}/pga`, { polite: fast() });
    const first = await src.fetchAll(signal(), new Map());
    const prev = new Map<string, PreviousRow>(
      first.map((r) => [r.sourceId, { raw: { ...r.raw, updated_at: "2026-01-01T00:00:00Z" } }]),
    );
    details = 0;
    limitAfter = 0;
    const r = await src.fetchAll(signal(), prev);
    expect(r).toHaveLength(ids.length);
    expect(r.every((x) => x.raw.updated_at === "2026-01-01T00:00:00Z")).toBe(true); // asked again next run
    expect(src.lastRun).toMatchObject({ deferred: ids.length, rateLimited: true });
  });

  it("the per-run cap bounds a run; the rest follows on the next runs", async () => {
    const src = new PgAtlasSource(`${base}/pga`, { polite: fast({ maxRequests: 3 }) });
    const r1 = await src.fetchAll(signal(), new Map());
    expect(r1).toHaveLength(2); // list + 2 details
    expect(src.lastRun).toEqual({ requests: 3, deferred: 4, rateLimited: false });
  });

  it("a 404 of one project defers only that project", async () => {
    const h = handler;
    handler = (req, res, n) =>
      req.url?.endsWith("p1") ? json(res, 404, { detail: "not found" }) : h(req, res, n);
    const src = new PgAtlasSource(`${base}/pga`, { polite: fast() });
    const r = await src.fetchAll(signal(), new Map());
    expect(r).toHaveLength(5);
    expect(src.lastRun).toMatchObject({ deferred: 1, rateLimited: false });
  });

  it("details that stay 503 are deferred without counting as rate-limited", async () => {
    const h = handler;
    handler = (req, res, n) =>
      req.url?.includes("/pga/projects/") ? json(res, 503, {}) : h(req, res, n);
    const src = new PgAtlasSource(`${base}/pga`, { polite: fast() });
    expect(await src.fetchAll(signal(), new Map())).toEqual([]);
    expect(src.lastRun).toMatchObject({ deferred: ids.length, rateLimited: false });
    expect(hits.filter((x) => x.startsWith("/pga/projects/"))).toHaveLength(2); // one project, 2 attempts, breaker
  });

  it("a rate-limited list fails the source for this run", async () => {
    handler = (_q, res) => json(res, 429, {});
    const src = new PgAtlasSource(`${base}/pga`, { polite: fast() });
    await expect(src.fetchAll(signal(), new Map())).rejects.toBeInstanceOf(RateLimitedError);
  });
});
