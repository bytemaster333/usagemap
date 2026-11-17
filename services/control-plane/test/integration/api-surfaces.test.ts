// SPDX-License-Identifier: Apache-2.0
// Tenant API dashboard additions (2026-11-19 product improvements) against real PostgreSQL: requests grouped by Stellar
// surface with merged-histogram percentiles (stellar-surfaces/1.0.0), the per-route CSV (formula-safe, the same rows as
// the route table) and the per-service availability objective (default 99.5 %, bounded, audited as service.updated).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allResolutions,
  createService,
  exactQuantile,
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
/** exp3 relative error bound (data-model §9.2, C-103: 4.33 %). */
const EXP3_BOUND_FOR_TESTS = 0.0433;
let h: Harness;
let owner = "";
let viewer = "";
let tenant = "";
let svc = "";
let H0 = 0;
const ACC = latencies(400, 0.08, 0.5, 11); // /accounts/{account} 200
const ACC5 = latencies(40, 0.5, 0.3, 12); // /accounts/{account} 500
const TX = latencies(100, 0.2, 0.4, 13); // /transactions/{hash} 200
const GLE = latencies(300, 0.03, 0.3, 14); // /rpc getLedgerEntries 200
const SEND = latencies(60, 0.3, 0.3, 15); // /rpc sendTransaction 503
const S24 = latencies(20, 0.6, 0.2, 16); // /sep24/transactions/deposit/interactive 200

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const custom = (start: number, end: number) =>
  `range=custom&start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}`;
const url = (s: string) =>
  `/v1/tenants/${tenant}/services/${svc}/api/${s}?${custom(H0, H0 + 2 * HOUR)}`;

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  svc = await createService(h, owner, tenant, "stellar-gateway");
  await h.su.query(
    `UPDATE scf.api_services SET registered_at = now() - interval '7 days' WHERE service_id = $1`,
    [svc],
  );
  const inv = (
    await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/invitations`,
      cookie: owner,
      body: { role: "viewer" },
    })
  ).json();
  viewer = await signInGithub(h, newGithubUser());
  await call(h, {
    method: "POST",
    url: "/v1/invitations/accept",
    cookie: viewer,
    body: { code: inv.code },
  });
  H0 = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const g = await streamGroup(h, tenant, svc, "sdk_stable");
  const acc = await route(h, tenant, svc, "/accounts/{account}");
  const tx = await route(h, tenant, svc, "/transactions/{hash}");
  const gle = await route(h, tenant, svc, "/rpc", "getLedgerEntries");
  const send = await route(h, tenant, svc, "/rpc", "sendTransaction");
  const s24 = await route(h, tenant, svc, "/sep24/transactions/deposit/interactive");
  // a route name a spreadsheet would read as a formula cannot exist (routes start with "/" or "{"); the CSV still
  // neutralises every text cell — checked in the unit test of toCsv.
  const at = (min: number) => new Date(H0 + min * 60_000);
  await metricRows(h, tenant, svc, g, [
    ...allResolutions(at(10), { routeId: acc, status: 200, values: ACC }),
    ...allResolutions(at(11), { routeId: acc, status: 500, values: ACC5 }),
    ...allResolutions(at(12), { routeId: tx, status: 200, values: TX }),
    ...allResolutions(at(13), { routeId: gle, status: 200, values: GLE }),
    ...allResolutions(at(14), { routeId: send, status: 503, values: SEND }),
    ...allResolutions(at(15), { routeId: s24, status: 200, values: S24 }),
  ]);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("requests by Stellar surface", () => {
  it("groups routes by the versioned mapping with merged percentiles", async () => {
    const res = await call(h, { method: "GET", url: url("surfaces"), cookie: viewer });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.mapping_version).toBe("stellar-surfaces/1.0.0");
    expect(b.range.label).toBe("self-attested telemetry");
    const by = Object.fromEntries(
      b.surfaces.map((s: { surface: string }) => [s.surface, s]),
    ) as Record<
      string,
      {
        requests: number;
        error_rate_5xx: number;
        latency: { p95_ms: number };
        groups: { group: string; requests: number }[];
      }
    >;
    expect(b.surfaces.map((s: { surface: string }) => s.surface)).toEqual([
      "horizon",
      "soroban_rpc",
      "sep24",
    ]);
    expect(by.horizon?.requests).toBe(ACC.length + ACC5.length + TX.length);
    expect(by.horizon?.error_rate_5xx).toBeCloseTo(
      ACC5.length / (ACC.length + ACC5.length + TX.length),
      4,
    );
    expect(by.horizon?.groups).toMatchObject([
      { group: "accounts", requests: ACC.length + ACC5.length },
      { group: "transactions", requests: TX.length },
    ]);
    expect(by.soroban_rpc?.groups).toMatchObject([
      { group: "getLedgerEntries", requests: GLE.length },
      { group: "sendTransaction", requests: SEND.length },
    ]);
    expect(by.sep24?.groups).toMatchObject([
      { group: "/transactions/deposit/interactive", requests: S24.length },
    ]);
    const rpc = [...GLE, ...SEND];
    const p95 = (by.soroban_rpc?.latency.p95_ms as number) / 1000;
    expect(Math.abs(p95 - exactQuantile(rpc, 0.95)) / exactQuantile(rpc, 0.95)).toBeLessThanOrEqual(
      EXP3_BOUND_FOR_TESTS,
    );
  });
});

describe("per-route CSV", () => {
  it("has one row per route, the surface columns and the self-attested label", async () => {
    const res = await call(h, { method: "GET", url: url("routes/export"), cookie: viewer });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["x-scf-label"]).toBe("self-attested telemetry");
    expect(String(res.headers["content-disposition"])).toMatch(
      /^attachment; filename="api-routes-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = res.body.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "route,rpc_method,surface,surface_group,rules_version,requests,requests_5xx,error_rate_5xx,p50_ms,p95_ms,p99_ms,accuracy_class",
    );
    expect(lines).toHaveLength(1 + 5);
    expect(lines[1]).toMatch(
      new RegExp(
        `^/accounts/\\{account\\},,horizon,accounts,scf-path-rules/1\\.0\\.0,${ACC.length + ACC5.length},${ACC5.length},`,
      ),
    );
    expect(
      lines.some((l) =>
        l.startsWith(
          `/rpc,sendTransaction,soroban_rpc,sendTransaction,scf-path-rules/1.0.0,${SEND.length},${SEND.length},1,`,
        ),
      ),
    ).toBe(true);
    // the same totals as the JSON route table
    const table = (await call(h, { method: "GET", url: url("routes"), cookie: viewer })).json();
    const total = table.items.reduce((a: number, r: { requests: number }) => a + r.requests, 0);
    const csvTotal = lines.slice(1).reduce((a, l) => a + Number(l.split(",")[5]), 0);
    expect(csvTotal).toBe(total);
  });
});

describe("availability objective", () => {
  it("defaults to 99.5 %, is set by a member within 90–99.999 % with three decimals at most", async () => {
    const get = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/services/${svc}`,
      cookie: viewer,
    });
    expect(get.json().slo_target_pct).toBe(99.5);
    const patch = (cookie: string, v: number) =>
      call(h, {
        method: "PATCH",
        url: `/v1/tenants/${tenant}/services/${svc}`,
        cookie,
        body: { slo_target_pct: v },
      });
    expect((await patch(viewer, 99.9)).statusCode).toBe(403);
    const ok = await patch(owner, 99.95);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().slo_target_pct).toBe(99.95);
    expect((await patch(owner, 89.9)).statusCode).toBe(400);
    expect((await patch(owner, 100)).statusCode).toBe(400);
    expect((await patch(owner, 99.9999)).statusCode).toBe(400);
  });
});
