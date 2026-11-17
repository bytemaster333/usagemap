// SPDX-License-Identifier: Apache-2.0
// Integration client metrics (migration 0085) and self-attested app events (migration 0084) against real PostgreSQL
// behind PgBouncer: partner calls per route with merged-histogram percentiles, payments per stage / rail / failure,
// the anchor funnel (wallet and anchor side, all services of the tenant), app events per event / platform / version;
// hourly vs daily rows by span; another tenant's service or site is not found and its rows never appear; the API
// figures stay untouched. Rows are written exactly as the metrics writer and the counter endpoint store them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createService, exactQuantile, explicit15Hist, latencies } from "../support/api-seed.ts";
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
let h: Harness;
let owner = "";
let tenant = "";
let svc = "";
let svc2 = "";
let site = "";
let strangerTenant = "";
let strangerSvc = "";
let strangerSite = "";
let stranger = "";
let H0 = 0;

const QUOTE = latencies(300, 0.2, 0.4, 21);

type Row = {
  metric: string;
  network?: string;
  d?: string[];
  values?: number[];
  count?: number;
  sum?: number;
};

/** One row per table, like the writer (the 1h and 1d rows of one event hold the same values). */
async function rows(t: string, s: string, at: Date, list: Row[]): Promise<void> {
  const hour = new Date(Math.floor(at.getTime() / HOUR) * HOUR);
  const day = new Date(Math.floor(at.getTime() / DAY) * DAY);
  for (const [table, bucket] of [
    ["1h", hour],
    ["1d", day],
  ] as const)
    for (const r of list) {
      const d = [...(r.d ?? []), "", "", "", "", "", "", ""].slice(0, 7);
      const v = r.values;
      await h.su.query(
        `INSERT INTO scf.integration_metrics_${table} (tenant_id, service_id, bucket_start, metric, network,
           d1, d2, d3, d4, d5, d6, d7, count, duration_sum, hist)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::int4[])`,
        [
          t,
          s,
          bucket,
          r.metric,
          r.network ?? "mainnet",
          ...d,
          v ? v.length : (r.count ?? 0),
          v ? v.reduce((a, b) => a + b, 0) : (r.sum ?? 0),
          v ? explicit15Hist(v) : null,
        ],
      );
    }
}

const PARTNER = "stellar.partner.call.duration";
const PAY = "payment.server.events";
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const custom = (start: number, end: number) =>
  `range=custom&start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}`;

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  await h.su.query(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, 'domain', 'integration.example')`,
    [tenant],
  );
  svc = await createService(h, owner, tenant, "wallet-backend");
  svc2 = await createService(h, owner, tenant, "anchor-listener");
  await h.su.query(
    `UPDATE scf.api_services SET registered_at = now() - interval '7 days' WHERE tenant_id = $1`,
    [tenant],
  );
  site = await createSite(h, owner, tenant);
  stranger = await signInGithub(h, newGithubUser());
  strangerTenant = await createTenant(h, stranger);
  strangerSvc = await createService(h, stranger, strangerTenant, "other-backend");
  strangerSite = await createSite(h, stranger, strangerTenant);
  H0 = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const at = new Date(H0 + 5 * 60_000);
  await rows(tenant, svc, at, [
    { metric: PARTNER, d: ["soroswap", "/quote", "success"], values: QUOTE },
    { metric: PARTNER, d: ["soroswap", "/quote", "rate_limited"], values: [0.05, 0.06] },
    {
      metric: PARTNER,
      d: ["bridge", "/transfers", "server_error"],
      network: "testnet",
      values: [1.2],
    },
    // payments
    { metric: PAY, network: "stellar:pubnet", d: ["x402", "required"], count: 10 },
    {
      metric: PAY,
      network: "stellar:pubnet",
      d: ["x402", "verified", "exact", "", "USDC"],
      count: 7,
    },
    {
      metric: PAY,
      network: "stellar:pubnet",
      d: ["x402", "settled", "exact", "", "USDC", "0.01_0.1"],
      count: 6,
    },
    {
      metric: PAY,
      network: "stellar:testnet",
      d: ["mpp", "paid", "stellar", "charge", "XLM", "lt_0.001"],
      count: 2,
    },
    {
      metric: PAY,
      network: "stellar:pubnet",
      d: [
        "x402",
        "failed",
        "exact",
        "",
        "USDC",
        "verification_failed",
        "invalid_exact_stellar_payload_wrong_amount",
      ],
      count: 1,
    },
    {
      metric: PAY,
      network: "stellar:testnet",
      d: ["mpp", "canceled", "stellar", "session", "", "expired"],
      count: 1,
    },
    // wallet side of the anchor funnel
    {
      metric: "stellar.anchor.request.duration",
      network: "testnet",
      d: ["24", "deposit_interactive", "ok", "testanchor.stellar.org"],
      values: [0.3, 0.4, 0.5],
    },
    {
      metric: "stellar.anchor.request.duration",
      network: "testnet",
      d: ["10", "token", "unauthorized", "testanchor.stellar.org"],
      values: [0.1],
    },
    ...(
      [
        ["authenticated", "10", 5],
        ["deposit_interactive_started", "24", 4],
        ["deposit_requested", "6", 1],
        ["deposit_started", "24", 3],
        ["deposit_completed", "24", 2],
        ["deposit_failed", "24", 1],
        ["customer_needs_info", "12", 2],
      ] as const
    ).map(([e, sep, n]) => ({
      metric: "stellar.anchor.events",
      network: "testnet",
      d: [e, sep, "testanchor.stellar.org"],
      count: n,
    })),
  ]);
  // anchor side, from another service of the same tenant
  await rows(tenant, svc2, at, [
    {
      metric: "stellar.anchor.transfer.created",
      d: ["24", "deposit", "", "", "wallet.example.org"],
      count: 8,
    },
    { metric: "stellar.anchor.transfer.created", d: ["31", "receive", "", "", "_none"], count: 2 },
    {
      metric: "stellar.anchor.transfer.transitions",
      d: ["24", "deposit", "_new", "incomplete"],
      count: 8,
    },
    {
      metric: "stellar.anchor.transfer.transitions",
      d: ["24", "deposit", "pending_anchor", "completed"],
      count: 5,
    },
    {
      metric: "stellar.anchor.transfer.status.duration",
      d: ["24", "deposit", "", "pending_anchor"],
      count: 5,
      sum: 1500,
    },
    {
      metric: "stellar.anchor.transfer.duration",
      d: ["24", "deposit", "", "completed"],
      count: 5,
      sum: 27000,
    },
    {
      metric: "stellar.anchor.customer.updates",
      d: ["", "", "", "ACCEPTED", "wallet.example.org"],
      count: 3,
    },
    {
      metric: "stellar.anchor.quotes.created",
      d: ["", "", "", "", "wallet.example.org"],
      count: 4,
    },
  ]);
  await rows(strangerTenant, strangerSvc, at, [
    { metric: PARTNER, d: ["soroswap", "/quote", "success"], values: [9.9] },
    { metric: PAY, network: "stellar:pubnet", d: ["x402", "settled"], count: 999 },
    { metric: "stellar.anchor.events", network: "testnet", d: ["authenticated", "10"], count: 999 },
  ]);
  // app events (as the counter endpoint stores them)
  const today = new Date().toISOString().slice(0, 10);
  const app = async (
    t: string,
    s: string,
    platform: string,
    e: string,
    k: string,
    v: string,
    n: number,
  ) =>
    h.su.query(
      `INSERT INTO scf.app_event_daily (tenant_id, site_id, day, platform, event_name, prop_key, prop_value, count)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)`,
      [t, s, today, platform, e, k, v, n],
    );
  await app(tenant, site, "ios", "app_open", "_total", "all", 12);
  await app(tenant, site, "android", "app_open", "_total", "all", 8);
  await app(tenant, site, "ios", "swap_done", "_total", "all", 3);
  await app(tenant, site, "ios", "swap_done", "pair", "xlm_usdc", 3);
  await app(tenant, site, "ios", "_session", "_total", "all", 6);
  await app(tenant, site, "android", "_session", "_total", "all", 4);
  await app(tenant, site, "ios", "_session", "app_version", "1.4.0", 6);
  await app(tenant, site, "ios", "_session", "sdk_version", "react-native/0.1.0", 6);
  await app(tenant, site, "ios", "_dropped", "reason", "cardinality", 2);
  await app(strangerTenant, strangerSite, "ios", "app_open", "_total", "all", 999);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

async function createSite(_h: Harness, cookie: string, t: string): Promise<string> {
  const r = await call(h, {
    method: "POST",
    url: `/v1/tenants/${t}/sites`,
    cookie,
    body: { name: "App" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().site_id;
}

const get = (url: string, cookie = owner) => call(h, { method: "GET", url, cookie });

describe("GET …/services/{serviceId}/partner-calls", () => {
  it("reports calls, errors, p50/p95 per partner route, hourly within a day", async () => {
    const r = await get(`/v1/tenants/${tenant}/services/${svc}/partner-calls?range=24h`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.range.resolution).toBe("1h");
    expect(b.range.label).toBe("self-attested telemetry");
    expect(b.networks).toEqual(["mainnet", "testnet"]);
    expect(b.partners).toEqual([
      { partner: "soroswap", calls: 302, errors: 2, error_rate: 0.0066 },
      { partner: "bridge", calls: 1, errors: 1, error_rate: 1 },
    ]);
    const q = b.operations.find(
      (o: { partner: string; network: string }) =>
        o.partner === "soroswap" && o.network === "mainnet",
    );
    expect(q.operation).toBe("/quote");
    expect(q.outcomes).toEqual([
      { outcome: "success", count: 300 },
      { outcome: "rate_limited", count: 2 },
    ]);
    // explicit15: the p50 lies in the bucket holding the exact p50, (0.1 s, 0.25 s]
    const exact = exactQuantile([...QUOTE, 0.05, 0.06], 0.5);
    expect(exact).toBeGreaterThan(0.1);
    expect(exact).toBeLessThanOrEqual(0.25);
    expect(q.p50_ms).toBeGreaterThan(100);
    expect(q.p50_ms).toBeLessThanOrEqual(250);
    expect(q.accuracy_class).toBe("explicit15");
    // the series has one point per hour of the span; the calls sit in H0's hour
    expect(b.series.length).toBeGreaterThanOrEqual(24);
    const hit = b.series.find((p: { t: string }) => p.t === iso(H0));
    expect(hit).toEqual({ t: iso(H0), calls: 303, errors: 3 });
    // another tenant's figures never appear
    expect(r.body).not.toContain("9900");
  });

  it("switches to daily rows for a span longer than 31 days", async () => {
    const r = await get(`/v1/tenants/${tenant}/services/${svc}/partner-calls?range=90d`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.range.resolution).toBe("1d");
    expect(b.partners[0]).toMatchObject({ partner: "soroswap", calls: 302 });
    expect(b.series.length).toBe(90);
  });

  it("uses daily rows for a short window older than the hour table's retention", async () => {
    const end = Date.now() - 40 * DAY;
    const r = await get(
      `/v1/tenants/${tenant}/services/${svc}/partner-calls?${custom(end - 7 * DAY, end)}`,
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().range.resolution).toBe("1d");
    expect(r.json().operations).toEqual([]);
  });

  it("does not find another tenant's service", async () => {
    const r = await get(`/v1/tenants/${tenant}/services/${strangerSvc}/partner-calls?range=24h`);
    expect(r.statusCode).toBe(404);
  });
});

describe("GET …/services/{serviceId}/payments", () => {
  it("reports stages, completed payments per rail / asset / amount class and failures", async () => {
    const r = await get(`/v1/tenants/${tenant}/services/${svc}/payments?range=7d`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.totals).toEqual({
      events: 27,
      required: 10,
      completed: 8,
      failed: 2,
      success_rate: 0.8,
    });
    expect(b.stages).toEqual({
      required: 10,
      verified: 7,
      settled: 6,
      paid: 2,
      failed: 1,
      canceled: 1,
      other: 0,
    });
    expect(
      b.protocols.map((p: { protocol: string; events: number }) => [p.protocol, p.events]),
    ).toEqual([
      ["x402", 24],
      ["mpp", 3],
    ]);
    expect(b.rails).toEqual([
      { protocol: "x402", rail: "exact", intent: null, network: "stellar:pubnet", count: 6 },
      { protocol: "mpp", rail: "stellar", intent: "charge", network: "stellar:testnet", count: 2 },
    ]);
    expect(b.assets).toEqual([
      { asset: "USDC", count: 6 },
      { asset: "XLM", count: 2 },
    ]);
    expect(b.amount_buckets).toEqual([
      { bucket: "lt_0.001", count: 2 },
      { bucket: "0.01_0.1", count: 6 },
    ]);
    expect(b.failures).toContainEqual({
      protocol: "x402",
      stage: "failed",
      reason_class: "verification_failed",
      error_type: "invalid_exact_stellar_payload_wrong_amount",
      count: 1,
    });
    expect(b.failures).toContainEqual({
      protocol: "mpp",
      stage: "canceled",
      reason_class: "expired",
      error_type: null,
      count: 1,
    });
    expect(b.series.reduce((a: number, p: { events: number }) => a + p.events, 0)).toBe(27);
    expect(r.body).not.toContain("999");
  });

  it("is empty, not an error, for a service without payments", async () => {
    const r = await get(`/v1/tenants/${tenant}/services/${svc2}/payments?range=7d`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().totals).toEqual({
      events: 0,
      required: 0,
      completed: 0,
      failed: 0,
      success_rate: null,
    });
  });
});

describe("GET …/anchor-funnel", () => {
  it("joins the wallet side and the anchor side over all services of the tenant", async () => {
    const r = await get(`/v1/tenants/${tenant}/anchor-funnel?range=7d`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.wallet.reported).toBe(true);
    expect(b.anchor.reported).toBe(true);
    const dep = b.wallet.funnels.find((f: { flow: string }) => f.flow === "deposit");
    expect(dep.steps).toEqual([
      { step: "authenticated", count: 5 },
      { step: "requested", count: 5 },
      { step: "started", count: 3 },
      { step: "completed", count: 2 },
    ]);
    expect(dep.failed).toBe(1);
    expect(b.wallet.kyc).toEqual([{ event: "customer_needs_info", count: 2 }]);
    expect(b.wallet.anchors).toEqual([
      {
        home_domain: "testanchor.stellar.org",
        events: 18,
        requests: 4,
        errors: 1,
        error_rate: 0.25,
      },
    ]);
    const token = b.wallet.requests.find((x: { step: string }) => x.step === "token");
    expect(token).toMatchObject({ sep: "10", calls: 1, errors: 1 });
    expect(b.anchor.transfers_created).toBe(10);
    expect(b.anchor.statuses).toEqual([
      { status: "incomplete", entered: 8 },
      { status: "completed", entered: 5 },
    ]);
    expect(b.anchor.time_in_status).toEqual([{ status: "pending_anchor", count: 5, mean_s: 300 }]);
    expect(b.anchor.durations).toEqual([
      { kind: "deposit", final_status: "completed", count: 5, mean_s: 5400 },
    ]);
    expect(b.anchor.customers).toEqual([{ status: "ACCEPTED", count: 3 }]);
    expect(b.anchor.quotes_created).toBe(4);
    expect(b.anchor.clients[0]).toEqual({
      client: "wallet.example.org",
      transfers: 8,
      quotes: 4,
      customer_updates: 3,
    });
    expect(b.anchor.clients).toContainEqual({
      client: null,
      transfers: 2,
      quotes: 0,
      customer_updates: 0,
    });
    expect(r.body).not.toContain("999");
  });

  it("is not visible to another tenant's user", async () => {
    const r = await get(`/v1/tenants/${tenant}/anchor-funnel?range=7d`, stranger);
    expect([403, 404]).toContain(r.statusCode);
  });
});

describe("GET …/app-events", () => {
  it("reports events, platforms, sessions, versions and drops, labelled self-attested", async () => {
    const r = await get(`/v1/tenants/${tenant}/app-events?range=7d`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.attestation).toBe("self_attested");
    expect(b.totals).toEqual({ events: 23, sessions: 10, dropped: 2 });
    expect(b.platforms).toEqual([
      { platform: "ios", events: 15, sessions: 6 },
      { platform: "android", events: 8, sessions: 4 },
      { platform: "web", events: 0, sessions: 0 },
    ]);
    expect(b.events[0]).toEqual({
      event: "app_open",
      count: 20,
      platforms: { ios: 12, android: 8, web: 0 },
    });
    expect(b.properties).toEqual([
      { event: "swap_done", key: "pair", value: "xlm_usdc", count: 3 },
    ]);
    expect(b.app_versions).toEqual([{ version: "1.4.0", count: 6 }]);
    expect(b.sdk_versions).toEqual([{ sdk: "react-native/0.1.0", count: 6 }]);
    expect(b.dropped).toEqual([{ reason: "cardinality", count: 2 }]);
    expect(b.daily.length).toBe(7);
    expect(b.daily.at(-1)).toMatchObject({ events: 23, sessions: 10 });
    expect(b.sites).toEqual([{ site_id: site, events: 23, sessions: 10 }]);
  });

  it("filters to one own site and refuses another tenant's site", async () => {
    const own = await get(`/v1/tenants/${tenant}/app-events?range=7d&site_id=${site}`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().site_id).toBe(site);
    const foreign = await get(`/v1/tenants/${tenant}/app-events?range=7d&site_id=${strangerSite}`);
    expect(foreign.statusCode).toBe(404);
  });
});

describe("isolation from the API figures", () => {
  it("leaves the API summary at zero", async () => {
    const r = await get(`/v1/tenants/${tenant}/services/${svc}/api/summary?range=24h`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().requests).toBe(0);
  });
});
