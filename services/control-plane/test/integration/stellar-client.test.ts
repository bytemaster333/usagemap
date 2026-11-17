// SPDX-License-Identifier: Apache-2.0
// Stellar SDK client metrics of a service (C-153, migration 0080) against real PostgreSQL behind PgBouncer: per RPC
// method and Horizon route template volume, errors, merged-histogram p50/p95 and outcome classes; transaction
// submissions, polls and simulations; never mixed into the API figures; another tenant's service is not found.
// Rows are written exactly as the metrics writer stores them (explicit15 histograms, closed-set dimensions).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createService,
  EXPLICIT15_BOUNDS,
  exactQuantile,
  explicit15Hist,
  latencies,
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
let h: Harness;
let owner = "";
let tenant = "";
let svc = "";
let strangerTenant = "";
let strangerSvc = "";
let stranger = "";
let H0 = 0;

const SEND_OK = latencies(400, 0.12, 0.4, 11);
const SEND_ERR = latencies(40, 0.05, 0.3, 12);
const ACCOUNTS = latencies(300, 0.03, 0.3, 13);
const NOT_FOUND = latencies(20, 0.02, 0.2, 14);

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const custom = (start: number, end: number) =>
  `range=custom&start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}`;

type Row = {
  table: "1m" | "1h" | "1d";
  bucket: Date;
  metric: string;
  network?: string;
  op?: string;
  variant?: string;
  outcome?: string;
  values?: number[];
  count?: number;
};

async function rows(t: string, s: string, list: Row[]): Promise<void> {
  for (const r of list) {
    const values = r.values;
    await h.su.query(
      `INSERT INTO scf.stellar_client_${r.table} (tenant_id, service_id, bucket_start, metric, network, operation,
         variant, outcome, count, duration_sum, hist)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::int4[])`,
      [
        t,
        s,
        r.bucket,
        r.metric,
        r.network ?? "testnet",
        r.op ?? "",
        r.variant ?? "",
        r.outcome ?? "",
        values ? values.length : (r.count ?? 0),
        values ? values.reduce((a, b) => a + b, 0) : 0,
        values ? explicit15Hist(values) : null,
      ],
    );
  }
}

/** One row per resolution, like the writer (the 1h and 1d rows hold the same values). */
function every(at: Date, r: Omit<Row, "table" | "bucket">): Row[] {
  const hour = new Date(Math.floor(at.getTime() / HOUR) * HOUR);
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return [
    { ...r, table: "1m", bucket: at },
    { ...r, table: "1h", bucket: hour },
    { ...r, table: "1d", bucket: day },
  ];
}

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  // L1 (a verified domain), so the tenant may register a second service (C-19)
  await h.su.query(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, 'domain', 'stellar-client.example')`,
    [tenant],
  );
  svc = await createService(h, owner, tenant, "dapp-backend");
  await h.su.query(
    `UPDATE scf.api_services SET registered_at = now() - interval '7 days' WHERE service_id = $1`,
    [svc],
  );
  stranger = await signInGithub(h, newGithubUser());
  strangerTenant = await createTenant(h, stranger);
  strangerSvc = await createService(h, stranger, strangerTenant, "other-backend");
  H0 = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const at = (min: number) => new Date(H0 + min * 60_000);
  const RPC = "rpc.client.call.duration";
  const HTTP = "http.client.request.duration";
  await rows(tenant, svc, [
    ...every(at(5), { metric: RPC, op: "sendTransaction", values: SEND_OK }),
    ...every(at(6), { metric: RPC, op: "sendTransaction", outcome: "-32602", values: SEND_ERR }),
    ...every(at(7), { metric: RPC, op: "getHealth", network: "mainnet", values: [0.004, 0.006] }),
    ...every(at(8), {
      metric: HTTP,
      op: "/accounts/{id}",
      variant: "GET",
      outcome: "200",
      values: ACCOUNTS,
    }),
    ...every(at(9), {
      metric: HTTP,
      op: "/accounts/{id}",
      variant: "GET",
      outcome: "404",
      values: NOT_FOUND,
    }),
    ...every(at(9), {
      metric: HTTP,
      op: "/transactions",
      variant: "POST",
      outcome: "timeout",
      values: [9.5],
    }),
    ...every(at(10), {
      metric: "stellar.tx.submissions",
      op: "rpc",
      variant: "ERROR",
      outcome: "bad_seq",
      count: 4,
    }),
    ...every(at(10), {
      metric: "stellar.tx.submissions",
      op: "rpc",
      variant: "PENDING",
      count: 30,
    }),
    ...every(at(11), { metric: "stellar.tx.polls", variant: "SUCCESS", count: 25 }),
    ...every(at(11), {
      metric: "stellar.tx.polls",
      variant: "FAILED",
      outcome: "contract_error",
      count: 2,
    }),
    ...every(at(12), {
      metric: "stellar.tx.simulations",
      variant: "error",
      outcome: "expired_state",
      count: 3,
    }),
    ...every(at(12), { metric: "stellar.tx.simulations", variant: "success", count: 50 }),
  ]);
  await rows(strangerTenant, strangerSvc, [
    ...every(at(5), { metric: RPC, op: "getEvents", values: [0.1, 0.2] }),
  ]);
});
afterAll(async () => {
  await h?.close();
});

const url = (t: string, s: string, q = custom(H0, H0 + 2 * HOUR)) =>
  `/v1/tenants/${t}/services/${s}/stellar-client?${q}`;

describe("Stellar RPC & Horizon from the tenant's backend (C-153)", () => {
  it("reports per RPC method and Horizon route: volume, errors, p50/p95 of the merged histogram, outcomes", async () => {
    const res = await call(h, { method: "GET", url: url(tenant, svc), cookie: owner });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.range).toEqual({
      start: iso(H0),
      end: iso(H0 + 2 * HOUR),
      resolution: "1m",
      label: "self-attested telemetry",
    });
    expect(b.networks).toEqual(["mainnet", "testnet"]);
    const send = b.rpc_methods.find(
      (r: { method: string; network: string }) =>
        r.method === "sendTransaction" && r.network === "testnet",
    );
    expect(send).toMatchObject({
      calls: SEND_OK.length + SEND_ERR.length,
      errors: SEND_ERR.length,
      accuracy_class: "explicit15",
      outcomes: [
        { outcome: "ok", count: SEND_OK.length },
        { outcome: "-32602", count: SEND_ERR.length },
      ],
    });
    expect(send.error_rate).toBeCloseTo(SEND_ERR.length / (SEND_OK.length + SEND_ERR.length), 4);
    // merged before the percentile (C-103): within the explicit15 bucket of the exact quantile
    const all = [...SEND_OK, ...SEND_ERR];
    for (const [q, key] of [
      [0.5, "p50_ms"],
      [0.95, "p95_ms"],
    ] as const) {
      const exact = exactQuantile(all, q);
      const i = EXPLICIT15_BOUNDS.findIndex((b) => exact <= b);
      const lo = i <= 0 ? 0 : (EXPLICIT15_BOUNDS[i - 1] as number);
      const hi = i < 0 ? Number.POSITIVE_INFINITY : (EXPLICIT15_BOUNDS[i] as number);
      expect(send[key] / 1000, `${key} vs exact ${exact}`).toBeGreaterThanOrEqual(lo);
      expect(send[key] / 1000, `${key} vs exact ${exact}`).toBeLessThanOrEqual(hi);
    }
    const health = b.rpc_methods.find((r: { method: string }) => r.method === "getHealth");
    expect(health).toMatchObject({ network: "mainnet", calls: 2, errors: 0, error_rate: 0 });

    const acc = b.horizon_routes.find((r: { route: string }) => r.route === "/accounts/{id}");
    expect(acc).toMatchObject({
      http_method: "GET",
      calls: ACCOUNTS.length + NOT_FOUND.length,
      errors: NOT_FOUND.length,
      outcomes: [
        { outcome: "200", count: ACCOUNTS.length },
        { outcome: "404", count: NOT_FOUND.length },
      ],
    });
    const tx = b.horizon_routes.find((r: { route: string }) => r.route === "/transactions");
    expect(tx).toMatchObject({ http_method: "POST", calls: 1, errors: 1, error_rate: 1 });
    expect(tx.outcomes).toEqual([{ outcome: "timeout", count: 1 }]);

    expect(b.transactions.submissions).toEqual([
      { network: "testnet", via: "rpc", status: "PENDING", result_class: null, count: 30 },
      { network: "testnet", via: "rpc", status: "ERROR", result_class: "bad_seq", count: 4 },
    ]);
    expect(b.transactions.polls).toEqual([
      { network: "testnet", via: null, status: "SUCCESS", result_class: null, count: 25 },
      { network: "testnet", via: null, status: "FAILED", result_class: "contract_error", count: 2 },
    ]);
    expect(b.transactions.simulations).toEqual([
      { network: "testnet", outcome: "success", error_class: null, count: 50 },
      { network: "testnet", outcome: "error", error_class: "expired_state", count: 3 },
    ]);
  });

  it("reads the same totals from the 1h and 1d tables", async () => {
    for (const [q, res] of [
      [custom(H0 - 24 * HOUR, H0 + 2 * HOUR), "1h"],
      [custom(H0 - 40 * 24 * HOUR, H0 + 2 * HOUR), "1d"],
    ] as const) {
      const r = await call(h, { method: "GET", url: url(tenant, svc, q), cookie: owner });
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json();
      expect(b.range.resolution).toBe(res);
      const send = b.rpc_methods.find((x: { method: string }) => x.method === "sendTransaction");
      expect(send.calls).toBe(SEND_OK.length + SEND_ERR.length);
      expect(
        b.transactions.simulations.reduce((a: number, x: { count: number }) => a + x.count, 0),
      ).toBe(53);
    }
  });

  it("never counts Stellar client calls as API traffic", async () => {
    const r = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/services/${svc}/api/summary?${custom(H0, H0 + 2 * HOUR)}`,
      cookie: owner,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().requests).toBe(0);
  });

  it("is empty for a service without Stellar client metrics", async () => {
    const other = await createService(h, owner, tenant, "quiet-backend");
    const r = await call(h, { method: "GET", url: url(tenant, other), cookie: owner });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      networks: [],
      rpc_methods: [],
      horizon_routes: [],
      transactions: { submissions: [], polls: [], simulations: [] },
    });
  });

  it("never shows another tenant's rows: foreign service 404, foreign tenant 403/404", async () => {
    const foreignSvc = await call(h, {
      method: "GET",
      url: url(tenant, strangerSvc),
      cookie: owner,
    });
    expect(foreignSvc.statusCode).toBe(404);
    const foreignTenant = await call(h, {
      method: "GET",
      url: url(strangerTenant, strangerSvc),
      cookie: owner,
    });
    expect([403, 404]).toContain(foreignTenant.statusCode);
    expect(foreignTenant.body).not.toContain("getEvents");
    const anon = await call(h, { method: "GET", url: url(tenant, svc) });
    expect(anon.statusCode).toBe(401);
  });
});
