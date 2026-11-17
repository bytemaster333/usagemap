// SPDX-License-Identifier: Apache-2.0
// Tenant API analytics against real PostgreSQL behind PgBouncer: volume, status classes and codes, p50/p95/p99 with
// the accuracy class, per-route table with {overflow}/{unknown}, time series at 1m/1h/1d, data-quality counters and
// assurance (dashboard.api-*, isolation.api-dashboard; data-model §8.11, §9; C-22, C-103). Rows are written exactly as the metrics writer stores
// them; percentiles are checked against the exact sample quantiles within the documented error bounds.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allResolutions,
  createService,
  EXPLICIT15_BOUNDS,
  exactQuantile,
  explicit15Index,
  latencies,
  metricRows,
  route,
  streamGroup,
} from "../support/api-seed.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** exp3 relative error bound (data-model §9.2, C-103: 4.33 %). */
const EXP3_BOUND = 0.0433;

let h: Harness;
let owner = "";
let tenant = "";
let svc = "";
let H0 = 0; // a whole hour, two hours before the current one
const A = latencies(5000, 0.08, 0.6, 1); // /accounts/{id} 200
const B = latencies(200, 0.5, 0.3, 2); // /accounts/{id} 500
const C = latencies(300, 0.004, 0.2, 3); // /health 404
const O = latencies(50, 0.02, 0.2, 4); // {overflow} 200
const U = latencies(10, 0.03, 0.2, 5); // {unknown}, no status (0)
const L = latencies(400, 2, 0.1, 6); // a non-preferred stream group: must never be counted (C-22)

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const base = (s: string) => `/v1/tenants/${tenant}/services/${svc}/api/${s}`;
const custom = (start: number, end: number) =>
  `range=custom&start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}`;

function expectWithin(actualMs: number | null, exactS: number, bound: number, what: string) {
  expect(actualMs, what).not.toBeNull();
  const rel = Math.abs((actualMs as number) / 1000 - exactS) / exactS;
  expect(rel, `${what}: ${actualMs} ms vs exact ${exactS * 1000} ms`).toBeLessThanOrEqual(bound);
}

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  // L1 (a verified domain), so the tenant may register more than one service (C-19)
  await h.su.query(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, 'domain', 'api-metrics.example')`,
    [tenant],
  );
  svc = await createService(h, owner, tenant, "payments-api");
  // the service exists "since" a week ago (preset `all` starts at registration)
  await h.su.query(
    `UPDATE scf.api_services SET registered_at = now() - interval '7 days' WHERE service_id = $1`,
    [svc],
  );
  H0 = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const g = await streamGroup(h, tenant, svc, "sdk_stable");
  const legacy = await streamGroup(
    h,
    tenant,
    svc,
    "sdk_legacy",
    "opentelemetry.instrumentation.fastapi",
  );
  const r1 = await route(h, tenant, svc, "/accounts/{id}");
  const r2 = await route(h, tenant, svc, "/health");
  const ro = await route(h, tenant, svc, "{overflow}");
  const ru = await route(h, tenant, svc, "{unknown}");
  const at = (min: number) => new Date(H0 + min * 60_000);
  await metricRows(h, tenant, svc, g, [
    ...allResolutions(at(10), { routeId: r1, status: 200, values: A }),
    ...allResolutions(at(70), { routeId: r1, status: 500, values: B }),
    ...allResolutions(at(10), { routeId: r2, status: 404, values: C }),
    ...allResolutions(at(20), { routeId: ro, status: 200, values: O }),
    ...allResolutions(at(30), { routeId: ru, status: 0, values: U }),
  ]);
  await metricRows(h, tenant, svc, legacy, [
    ...allResolutions(at(15), { routeId: r1, status: 200, values: L }),
  ]);
});
afterAll(async () => {
  await h?.close();
});

describe("API summary (dashboard.api-volume, dashboard.api-status-codes, dashboard.api-latency-percentiles)", () => {
  it("counts volume and status classes of the preferred stream group only and merges histograms first", async () => {
    const res = await call(h, {
      method: "GET",
      url: `${base("summary")}?${custom(H0, H0 + 2 * HOUR)}`,
      cookie: owner,
    });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json();
    const all = [...A, ...B, ...C, ...O, ...U];
    expect(s.requests).toBe(all.length);
    expect(s.status).toEqual({
      s2xx: A.length + O.length,
      s3xx: 0,
      s4xx: C.length,
      s5xx: B.length,
      unknown: U.length,
    });
    expect(s.error_rate_5xx).toBeCloseTo(B.length / all.length, 4);
    expect(s.error_rate_4xx).toBeCloseTo(C.length / all.length, 4);
    expect(s.range).toMatchObject({
      start: iso(H0),
      end: iso(H0 + 2 * HOUR),
      resolution: "1m",
      label: "self-attested telemetry",
      stream_group: { kind: "sdk_stable" },
      sampled_lower_bound: false,
    });
    expect(s.range.stream_group.warning).toMatch(/More than one instrumentation/);
    expect(s.latency.accuracy_class).toBe("exp3");
    // merge-first: the percentile of the merged histogram equals the exact quantile of all samples within 4.33 %
    for (const [q, k] of [
      [0.5, "p50_ms"],
      [0.95, "p95_ms"],
      [0.99, "p99_ms"],
    ] as const)
      expectWithin(s.latency[k], exactQuantile(all, q), EXP3_BOUND, k);
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    expect(s.latency.mean_ms).toBeCloseTo(mean * 1000, 2);
    expect(s.assurance_level).toBeNull();
  });

  it("filters by exact normalised route", async () => {
    const res = await call(h, {
      method: "GET",
      url: `${base("summary")}?${custom(H0, H0 + 2 * HOUR)}&route=${encodeURIComponent("/accounts/{id}")}`,
      cookie: owner,
    });
    const s = res.json();
    expect(s.requests).toBe(A.length + B.length);
    expectWithin(s.latency.p95_ms, exactQuantile([...A, ...B], 0.95), EXP3_BOUND, "route p95");
    const none = await call(h, {
      method: "GET",
      url: `${base("summary")}?${custom(H0, H0 + 2 * HOUR)}&route=/nope`,
      cookie: owner,
    });
    expect(none.json()).toMatchObject({
      requests: 0,
      error_rate_5xx: null,
      latency: { p50_ms: null, p95_ms: null, p99_ms: null, accuracy_class: null },
    });
  });

  it("gives the same figures from the 1h and 1d rollups (resolution auto by range length)", async () => {
    const all = [...A, ...B, ...C, ...O, ...U];
    const day0 = Math.floor(H0 / DAY) * DAY;
    // H0 .. H0+2h lies within one UTC day unless H0 is 22:00 — then the 24 h window still covers both hours
    const hourly = (
      await call(h, {
        method: "GET",
        url: `${base("summary")}?${custom(H0 - 20 * HOUR, H0 + 4 * HOUR)}`,
        cookie: owner,
      })
    ).json();
    expect(hourly.range.resolution).toBe("1h");
    expect(hourly.requests).toBe(all.length);
    expect(hourly.latency.p95_ms).toBeCloseTo(
      (
        await call(h, {
          method: "GET",
          url: `${base("summary")}?${custom(H0, H0 + 2 * HOUR)}`,
          cookie: owner,
        })
      ).json().latency.p95_ms,
      6,
    );
    const daily = (
      await call(h, {
        method: "GET",
        url: `${base("summary")}?${custom(day0 - 39 * DAY, day0 + 2 * DAY)}`,
        cookie: owner,
      })
    ).json();
    expect(daily.range.resolution).toBe("1d");
    expect(daily.requests).toBe(all.length);
    for (const k of ["p50_ms", "p95_ms", "p99_ms"] as const)
      expect(daily.latency[k]).toBeCloseTo(hourly.latency[k], 6);
    // presets resolve too
    const preset = await call(h, {
      method: "GET",
      url: `${base("summary")}?range=30d`,
      cookie: owner,
    });
    expect(preset.json().requests).toBe(all.length);
    const allRange = await call(h, {
      method: "GET",
      url: `${base("summary")}?range=all`,
      cookie: owner,
    });
    expect(allRange.json().requests).toBe(all.length);
  });

  it("aligns a range to the resolution grid and echoes what it answered (C-86)", async () => {
    const res = await call(h, {
      method: "GET",
      url: `${base("summary")}?${custom(H0 + 5 * 60_000 + 30_000, H0 + 50 * 60_000 + 1)}`,
      cookie: owner,
    });
    expect(res.json().range).toMatchObject({
      start: iso(H0 + 5 * 60_000),
      end: iso(H0 + 51 * 60_000),
      resolution: "1m",
    });
    expect(res.json().requests).toBe(A.length + C.length + O.length + U.length);
  });
});

describe("API time series (dashboard.api-volume, dashboard.api-time-ranges)", () => {
  it("returns one point per minute with gaps filled and per-point percentiles", async () => {
    const res = await call(h, {
      method: "GET",
      url: `${base("timeseries")}?${custom(H0, H0 + 2 * HOUR)}`,
      cookie: owner,
    });
    const s = res.json();
    expect(s.range.resolution).toBe("1m");
    expect(s.points).toHaveLength(120);
    expect(s.accuracy_class).toBe("exp3");
    const p10 = s.points[10];
    expect(p10).toMatchObject({
      t: iso(H0 + 10 * 60_000),
      requests: A.length + C.length,
      s4xx: C.length,
      s5xx: 0,
    });
    expectWithin(p10.p95_ms, exactQuantile([...A, ...C], 0.95), EXP3_BOUND, "minute p95");
    expect(s.points[70]).toMatchObject({ requests: B.length, s5xx: B.length });
    expect(s.points[0]).toEqual({
      t: iso(H0),
      requests: 0,
      s4xx: 0,
      s5xx: 0,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
    });
    const total = s.points.reduce((a: number, p: { requests: number }) => a + p.requests, 0);
    expect(total).toBe(A.length + B.length + C.length + O.length + U.length);
  });

  it("honours an explicit resolution and refuses 1m outside its 35-day retention or beyond 10 000 points", async () => {
    const hourly = (
      await call(h, {
        method: "GET",
        url: `${base("timeseries")}?${custom(H0, H0 + 2 * HOUR)}&resolution=1h`,
        cookie: owner,
      })
    ).json();
    expect(hourly.points.map((p: { requests: number }) => p.requests)).toEqual([
      A.length + C.length + O.length + U.length,
      B.length,
    ]);
    const old = await call(h, {
      method: "GET",
      url: `${base("timeseries")}?range=90d&resolution=1m`,
      cookie: owner,
    });
    expect(old.statusCode).toBe(400);
    expect(old.json().errors[0].pointer).toBe("/resolution");
    const many = await call(h, {
      method: "GET",
      url: `${base("timeseries")}?range=all&resolution=1m`,
      cookie: owner,
    });
    expect(many.statusCode).toBe(400);
    const bad = await call(h, {
      method: "GET",
      url: `${base("timeseries")}?range=custom&start=2026-01-02T00:00:00Z`,
      cookie: owner,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("status codes and routes (dashboard.api-tenant, dashboard.api-status-codes)", () => {
  it("lists every status code (0 = absent) and the classes", async () => {
    const s = (
      await call(h, {
        method: "GET",
        url: `${base("status-codes")}?${custom(H0, H0 + 2 * HOUR)}`,
        cookie: owner,
      })
    ).json();
    expect(s.codes).toEqual([
      { status_code: 0, requests: U.length },
      { status_code: 200, requests: A.length + O.length },
      { status_code: 404, requests: C.length },
      { status_code: 500, requests: B.length },
    ]);
    expect(s.classes.unknown).toBe(U.length);
  });

  it("returns the per-route table with {overflow} and {unknown}, sorting and cursor paging", async () => {
    const url = (q: string) => `${base("routes")}?${custom(H0, H0 + 2 * HOUR)}&${q}`;
    const all = (await call(h, { method: "GET", url: url(""), cookie: owner })).json();
    expect(all.items.map((r: { route: string }) => r.route)).toEqual([
      "/accounts/{id}",
      "/health",
      "{overflow}",
      "{unknown}",
    ]);
    expect(all.next_cursor).toBeNull();
    const acc = all.items[0];
    expect(acc).toMatchObject({
      rpc_method: null,
      rules_version: "scf-path-rules/1.0.0",
      requests: A.length + B.length,
    });
    expect(acc.error_rate_5xx).toBeCloseTo(B.length / (A.length + B.length), 4);
    expect(acc.latency.accuracy_class).toBe("exp3");
    expectWithin(acc.latency.p99_ms, exactQuantile([...A, ...B], 0.99), EXP3_BOUND, "route p99");
    const health = all.items[1];
    expectWithin(health.latency.p50_ms, exactQuantile(C, 0.5), EXP3_BOUND, "fast route p50");

    const byP95 = (await call(h, { method: "GET", url: url("sort=p95_ms"), cookie: owner })).json();
    expect(byP95.items[0].route).toBe("/health");
    const byRoute = (
      await call(h, { method: "GET", url: url("sort=-error_rate_5xx"), cookie: owner })
    ).json();
    expect(byRoute.items[0].route).toBe("/accounts/{id}");

    const p1 = (
      await call(h, { method: "GET", url: url("sort=route&limit=3"), cookie: owner })
    ).json();
    expect(p1.items).toHaveLength(3);
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = (
      await call(h, {
        method: "GET",
        url: url(`sort=route&limit=3&cursor=${p1.next_cursor}`),
        cookie: owner,
      })
    ).json();
    expect(p2.items.map((r: { route: string }) => r.route)).toEqual(["{unknown}"]);
    expect(p2.next_cursor).toBeNull();
    // a cursor is bound to the sort it was issued for
    const mismatch = await call(h, {
      method: "GET",
      url: url(`sort=-requests&limit=3&cursor=${p1.next_cursor}`),
      cookie: owner,
    });
    expect(mismatch.statusCode).toBe(400);
    expect(
      (await call(h, { method: "GET", url: url("cursor=garbage"), cookie: owner })).statusCode,
    ).toBe(400);
  });
});

describe("accuracy classes (C-103)", () => {
  it("explicit15 percentiles stay within the bucket; a sub-5 ms API reports ≤ 5 ms; approximations are labelled", async () => {
    const s2 = await createService(h, owner, tenant, "legacy-api");
    const g = await streamGroup(h, tenant, s2, "sdk_stable", "Microsoft.AspNetCore.Hosting");
    const r = await route(h, tenant, s2, "/orders/{id}");
    const fast = await route(h, tenant, s2, "/ping");
    const D = latencies(2000, 0.12, 0.5, 7);
    const F = latencies(500, 0.002, 0.2, 8).map((v) => Math.min(v, 0.0049));
    const t = new Date(H0 + 5 * 60_000);
    await metricRows(h, tenant, s2, g, [
      ...allResolutions(t, { routeId: r, status: 200, values: D, kind: "explicit15" }),
      ...allResolutions(t, { routeId: fast, status: 200, values: F, kind: "explicit15" }),
    ]);
    const q = `${custom(H0, H0 + 2 * HOUR)}`;
    const rows = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${s2}/api/routes?${q}`,
        cookie: owner,
      })
    ).json().items;
    const orders = rows.find((x: { route: string }) => x.route === "/orders/{id}");
    expect(orders.latency.accuracy_class).toBe("explicit15");
    for (const [qq, k] of [
      [0.5, "p50_ms"],
      [0.95, "p95_ms"],
    ] as const) {
      const exact = exactQuantile(D, qq);
      // within the bucket width: same explicit15 bucket as the exact value
      expect(explicit15Index((orders.latency[k] as number) / 1000 - 1e-12), k).toBe(
        explicit15Index(exact),
      );
    }
    const ping = rows.find((x: { route: string }) => x.route === "/ping");
    // min/max are known here, so the first bucket interpolates from the true minimum; without them it reports 5 ms
    expect(ping.latency.p50_ms).toBeLessThanOrEqual((EXPLICIT15_BOUNDS[0] as number) * 1000);
    await h.su.query(
      `UPDATE scf.api_metrics_1m SET duration_min = NULL, duration_max = NULL WHERE service_id = $1 AND route_id = $2`,
      [s2, fast],
    );
    const ping2 = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${s2}/api/summary?${q}&route=/ping`,
        cookie: owner,
      })
    ).json();
    expect(ping2.latency.p50_ms).toBe(5);
    expect(ping2.latency.p99_ms).toBe(5);

    // an interpolated (approximate) explicit15 row and a coarse exp row change the label (C-23)
    await h.su.query(
      `UPDATE scf.api_metrics_1m SET hist_quality = 1 WHERE service_id = $1 AND route_id = $2`,
      [s2, r],
    );
    const approx = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${s2}/api/summary?${q}`,
        cookie: owner,
      })
    ).json();
    expect(approx.latency.accuracy_class).toBe("explicit15_approx");
    await h.su.query(
      `UPDATE scf.api_metrics_1m SET hist_quality = 2 WHERE service_id = $1 AND route_id = $2`,
      [s2, r],
    );
    const coarse = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${s2}/api/summary?${q}`,
        cookie: owner,
      })
    ).json();
    expect(coarse.latency.accuracy_class).toBe("coarse");
  });

  it("a span-derived service is labelled a lower bound", async () => {
    const s3 = await createService(h, owner, tenant, "next-app");
    const g = await streamGroup(h, tenant, s3, "span_derived", "scf/signal_to_metrics");
    const r = await route(h, tenant, s3, "/");
    await metricRows(
      h,
      tenant,
      s3,
      g,
      allResolutions(new Date(H0 + 60_000), { routeId: r, status: 200, values: [0.1, 0.2] }),
    );
    const s = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${s3}/api/summary?${custom(H0, H0 + 2 * HOUR)}`,
        cookie: owner,
      })
    ).json();
    expect(s.range.stream_group).toEqual({ kind: "span_derived", warning: null });
    expect(s.range.sampled_lower_bound).toBe(true);
  });
});

describe("data quality and assurance", () => {
  it("lists dropped-point reasons of the service and the tenant's unattributed front-door drops", async () => {
    const today = new Date(Math.floor(Date.now() / DAY) * DAY);
    const old = new Date(today.getTime() - 10 * DAY);
    const rows: Array<[Date, string, string, number]> = [
      [today, svc, "route_overflow", 12],
      [today, svc, "before_registration", 3],
      [old, svc, "malformed_point", 99],
      [today, "00000000-0000-0000-0000-000000000000", "rate_limited", 40],
      [today, "00000000-0000-0000-0000-000000000000", "service_not_allowed", 2],
    ];
    for (const [d, s, reason, n] of rows)
      await h.su.query(
        `INSERT INTO scf.api_ingest_counters (tenant_id, day, service_id, reason, count) VALUES ($1, $2, $3, $4, $5)`,
        [tenant, d, s, reason, n],
      );
    const dq = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${svc}/data-quality`,
        cookie: owner,
      })
    ).json();
    expect(dq.end).toBe(iso(today.getTime() + DAY));
    expect(dq.start).toBe(iso(today.getTime() - 6 * DAY));
    expect(dq.reasons).toEqual([
      { reason: "route_overflow", count: 12 },
      { reason: "before_registration", count: 3 },
    ]);
    expect(dq.unattributed).toEqual([
      { reason: "rate_limited", count: 40 },
      { reason: "service_not_allowed", count: 2 },
    ]);
    const month = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${svc}/data-quality?range=30d`,
        cookie: owner,
      })
    ).json();
    expect(month.reasons).toContainEqual({ reason: "malformed_point", count: 99 });
  });

  it("returns assurance history and the latest level in the summary", async () => {
    const d = (n: number) => new Date(Math.floor(Date.now() / DAY) * DAY - n * DAY);
    await h.su.query(
      `INSERT INTO scf.api_service_assurance (tenant_id, service_id, day, level, onchain_badge, checks, reason_codes)
       VALUES ($1, $2, $3, 0, 'unavailable', '{}', '{a2_no_base_url}'),
              ($1, $2, $4, 1, 'not_applicable', '{}', '{a3_not_applicable}')`,
      [tenant, svc, d(2), d(1)],
    );
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/services/${svc}/api/assurance?start=${iso(d(5).getTime())}&end=${iso(d(-1).getTime())}`,
      cookie: owner,
    });
    expect(res.json()).toEqual([
      {
        day: iso(d(2).getTime()).slice(0, 10),
        level: "A0",
        onchain_badge: "unavailable",
        reason_codes: ["a2_no_base_url"],
      },
      {
        day: iso(d(1).getTime()).slice(0, 10),
        level: "A1",
        onchain_badge: "not_applicable",
        reason_codes: ["a3_not_applicable"],
      },
    ]);
    const s = (
      await call(h, { method: "GET", url: `${base("summary")}?range=7d`, cookie: owner })
    ).json();
    expect(s.assurance_level).toBe("A1");
    expect(s.onchain_badge).toBe("not_applicable");
    const bad = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/services/${svc}/api/assurance?start=${iso(d(1).getTime())}&end=${iso(d(2).getTime())}`,
      cookie: owner,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("isolation (isolation.api-dashboard)", () => {
  it("another tenant's member cannot read this service's metrics: 404 like an unknown service", async () => {
    const stranger = await signInGithub(h, newGithubUser());
    const theirs = await createTenant(h, stranger);
    for (const op of ["summary", "timeseries", "status-codes", "routes"]) {
      const viaOwn = await call(h, {
        method: "GET",
        url: `/v1/tenants/${theirs}/services/${svc}/api/${op}`,
        cookie: stranger,
      });
      expect(viaOwn.statusCode, op).toBe(404);
      const direct = await call(h, { method: "GET", url: base(op), cookie: stranger });
      expect(direct.statusCode, op).toBe(404);
    }
  });
});

describe("onboarding configuration", () => {
  it("generates dual-export configuration for every stack with the token placeholder only", async () => {
    const stacks = [
      "collector",
      "node",
      "nextjs",
      "python",
      "fastapi",
      "go",
      "rust",
      "java",
      "dotnet",
      "lambda",
      "vercel",
      "cloudflare_workers",
      "env_only",
    ];
    for (const stack of stacks) {
      const res = await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${svc}/otel-config?stack=${stack}`,
        cookie: owner,
      });
      expect(res.statusCode, stack).toBe(200);
      const text = JSON.stringify(res.json());
      expect(text, stack).toContain("<INGEST_TOKEN>");
      expect(text, stack).not.toMatch(/scfa_ing_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}/);
      expect(res.json().stack).toBe(stack);
    }
    const node = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${tenant}/services/${svc}/otel-config?stack=node`,
        cookie: owner,
      })
    ).json();
    expect(node.files[0].content).toContain("serviceName: 'payments-api'");
  });
});
