// SPDX-License-Identifier: Apache-2.0
// Browser Stellar RPC / Horizon aggregate (tracker 1.2.0; wire-formats §a.3.2, §d.3 `rpc`; migration 0086) against
// the real database: the counter record's optional `rpc` part lands in scf.web_rpc_client_daily exactly once; cells
// outside the closed lists and another tenant's sites are dropped and counted; nothing reaches the web counters;
// the snapshot advertises "rpc" once the operator setting lists it; getSiteBrowserRpc returns the tenant's own daily
// totals, filters network and variant, and answers 404 for a foreign site exactly as for an unknown one (C-87).

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SnapshotBuilder, SnapshotSigner, verifyEnvelope } from "../../src/edge/snapshot.ts";
import { loadTrackerRegistry } from "../../src/tracker.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const NODE = "edge-v1";
const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
const midnight = (d: string) => `${d}T00:00:00Z`;

let h: Harness;
let owner = "";
let tenant = "";
let site = "";
let other = "";
let otherTenant = "";
let otherSite = "";

function counterRecord(extra: Record<string, unknown>) {
  return {
    rv: 1,
    type: "counter",
    record_id: randomUUID(),
    node_id: NODE,
    period_start_ms: Date.now() - 60_000,
    period_end_ms: Date.now(),
    web: [],
    otlp: [],
    tokens: [],
    spool: {
      boot_id: randomUUID(),
      day: today(),
      fsynced: 0,
      acked_stored: 0,
      acked_engine_bot: 0,
      acked_engine_rejected: 0,
      expired_72h: 0,
      queued: 0,
    },
    ...extra,
  };
}

async function postCounters(body: unknown) {
  return h.internal.inject({
    method: "POST",
    url: "/internal/v1/edge/counters",
    headers: { "x-scf-edge-node": NODE, "content-type": "application/json" },
    payload: body as object,
  });
}

async function newSite(cookie: string, t: string): Promise<string> {
  const r = await call(h, {
    method: "POST",
    url: `/v1/tenants/${t}/sites`,
    cookie,
    body: { name: "Dapp" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().site_id;
}

const cell = (
  api: string,
  operation: string,
  outcome: string,
  latency: string,
  count: number,
  extra: Record<string, unknown> = {},
) => ({
  tenant_id: tenant,
  site_id: site,
  day: today(),
  api,
  operation,
  network: "testnet",
  outcome,
  latency,
  verdict: "verified",
  count,
  ...extra,
});

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  site = await newSite(owner, tenant);
  other = await signInGithub(h, newGithubUser());
  otherTenant = await createTenant(h, other);
  otherSite = await newSite(other, otherTenant);
});
afterAll(async () => {
  await h?.close();
});

describe("browser RPC aggregate (§a.3.2, §d.3 rpc)", () => {
  it("applies the rpc part once; drops bad cells and foreign sites; web counters untouched", async () => {
    const rec = counterRecord({
      rpc: [
        cell("rpc", "send_transaction", "ok", "lt100ms", 5),
        cell("rpc", "send_transaction", "ok", "lt100ms", 2), // same cell twice in one record: summed
        cell("rpc", "send_transaction", "http_429", "gt2000ms", 1),
        cell("rpc", "get_events", "ok", "100_500ms", 4, { day: yesterday(), network: "mainnet" }),
        cell("horizon", "accounts_id", "ok", "lt100ms", 3),
        cell("horizon", "other", "timeout", "gt2000ms", 1, { verdict: "suspect" }),
        cell("rpc", "accounts_id", "ok", "lt100ms", 9), // a Horizon route under rpc: dropped
        cell("rpc", "send_transaction", "ok", "lt100ms", 7, { site_id: otherSite }), // foreign site: dropped
      ],
    });
    const r1 = await postCounters(rec);
    expect(r1.statusCode, r1.body).toBe(200);
    const r2 = await postCounters(rec); // duplicate: not applied again
    expect(r2.statusCode, r2.body).toBe(200);
    const rows = await h.su.query<Record<string, string>>(
      `SELECT day::text, api, operation, network, outcome, latency, verdict, count::text FROM scf.web_rpc_client_daily
        WHERE tenant_id = $1 ORDER BY api, operation, outcome, day`,
      [tenant],
    );
    expect(rows.rows).toEqual([
      {
        day: today(),
        api: "horizon",
        operation: "accounts_id",
        network: "testnet",
        outcome: "ok",
        latency: "lt100ms",
        verdict: "verified",
        count: "3",
      },
      {
        day: today(),
        api: "horizon",
        operation: "other",
        network: "testnet",
        outcome: "timeout",
        latency: "gt2000ms",
        verdict: "suspect",
        count: "1",
      },
      {
        day: yesterday(),
        api: "rpc",
        operation: "get_events",
        network: "mainnet",
        outcome: "ok",
        latency: "100_500ms",
        verdict: "verified",
        count: "4",
      },
      {
        day: today(),
        api: "rpc",
        operation: "send_transaction",
        network: "testnet",
        outcome: "http_429",
        latency: "gt2000ms",
        verdict: "verified",
        count: "1",
      },
      {
        day: today(),
        api: "rpc",
        operation: "send_transaction",
        network: "testnet",
        outcome: "ok",
        latency: "lt100ms",
        verdict: "verified",
        count: "7",
      },
    ]);
    const foreign = await h.su.query(`SELECT 1 FROM scf.web_rpc_client_daily WHERE site_id = $1`, [
      otherSite,
    ]);
    expect(foreign.rowCount).toBe(0);
    const web = await h.su.query(`SELECT 1 FROM scf.web_edge_counters WHERE site_id = $1`, [site]);
    expect(web.rowCount).toBe(0);
    // A second record adds to the same cells (count = count + EXCLUDED.count).
    const r3 = await postCounters(
      counterRecord({ rpc: [cell("rpc", "send_transaction", "ok", "lt100ms", 3)] }),
    );
    expect(r3.statusCode, r3.body).toBe(200);
    const sum = await h.su.query<{ n: string }>(
      `SELECT count::text AS n FROM scf.web_rpc_client_daily WHERE tenant_id = $1 AND operation = 'send_transaction'
          AND outcome = 'ok'`,
      [tenant],
    );
    expect(sum.rows[0]?.n).toBe("10");
    // Privacy: the table holds counts per day and closed cells only.
    const cols = await h.su.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'scf' AND table_name = 'web_rpc_client_daily'`,
    );
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual([
      "api",
      "count",
      "day",
      "latency",
      "network",
      "operation",
      "outcome",
      "site_id",
      "tenant_id",
      "verdict",
    ]);
  });

  it("refuses a record whose rpc part breaks the schema (the forwarder then strips optional parts)", async () => {
    const r = await postCounters(
      counterRecord({ rpc: [cell("rpc", "send_transaction", "ok", "17ms", 1)] }),
    );
    expect([400, 422]).toContain(r.statusCode);
  });

  it("getSiteBrowserRpc: the tenant's daily totals, network and variant filters", async () => {
    const start = midnight(yesterday());
    const end = new Date(Date.parse(midnight(today())) + DAY_MS).toISOString().replace(".000", "");
    const url = (q = "") =>
      `/v1/tenants/${tenant}/sites/${site}/web/browser-rpc?start=${start}&end=${end}${q}`;
    const all = await call(h, { method: "GET", url: url(), cookie: owner });
    expect(all.statusCode, all.body).toBe(200);
    const b = all.json();
    expect(b.network).toBe("all");
    expect(b.variant).toBe("verified");
    // verified only: the suspect Horizon cell is left out (send_transaction ok = 7 + 3 from the second record)
    expect(b.totals).toEqual({ calls: 18, errors: 1, rpc: 15, horizon: 3 });
    expect(b.networks).toEqual([
      { network: "testnet", calls: 14 },
      { network: "mainnet", calls: 4 },
    ]);
    expect(b.operations[0]).toMatchObject({
      api: "rpc",
      operation: "send_transaction",
      calls: 11,
      errors: 1,
      outcomes: [
        { outcome: "ok", count: 10 },
        { outcome: "http_429", count: 1 },
      ],
      latency: { lt100ms: 10, "100_500ms": 0, "500_2000ms": 0, gt2000ms: 1 },
    });
    expect(b.daily).toEqual([
      { day: yesterday(), rpc: 4, horizon: 0, errors: 0 },
      { day: today(), rpc: 11, horizon: 3, errors: 1 },
    ]);
    const raw = (await call(h, { method: "GET", url: url("&variant=raw"), cookie: owner })).json();
    expect(raw.totals).toEqual({ calls: 19, errors: 2, rpc: 15, horizon: 4 });
    const main = (
      await call(h, { method: "GET", url: url("&network=mainnet"), cookie: owner })
    ).json();
    expect(main.totals).toEqual({ calls: 4, errors: 0, rpc: 4, horizon: 0 });
    expect(main.operations.map((o: { operation: string }) => o.operation)).toEqual(["get_events"]);
  });

  it("getSiteBrowserRpc: a foreign site is the same 404 as an unknown one; ranges are checked", async () => {
    const q = `start=${midnight(yesterday())}&end=${midnight(today())}`;
    const foreign = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${otherSite}/web/browser-rpc?${q}`,
      cookie: owner,
    });
    const unknown = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${randomUUID()}/web/browser-rpc?${q}`,
      cookie: owner,
    });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect({ ...foreign.json(), request_id: "" }).toEqual({ ...unknown.json(), request_id: "" });
    // another tenant's member cannot read this tenant's site
    const stranger = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/browser-rpc?${q}`,
      cookie: other,
    });
    expect(stranger.statusCode).toBe(404);
    const inverted = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/browser-rpc?start=${midnight(today())}&end=${midnight(yesterday())}`,
      cookie: owner,
    });
    expect(inverted.statusCode).toBe(400);
    const tooLong = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/sites/${site}/web/browser-rpc?start=2024-01-01T00:00:00Z&end=2026-01-01T00:00:00Z`,
      cookie: owner,
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('the snapshot advertises "rpc" once edge_counter_features lists it', async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new SnapshotSigner(
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      "rpc-test",
    );
    const dir = new URL("../support/fixtures/tracker", import.meta.url).pathname;
    const builder = new SnapshotBuilder(h.jobsDb, signer, {
      pathnormRulesVersion: "scf-path-rules/1.0.0",
      tracker: loadTrackerRegistry(dir, join(dir, "releases.json")),
    });
    await h.su.query(
      `UPDATE scf.settings SET value = '["props","dev","app","rpc"]'::jsonb WHERE key = 'edge_counter_features'`,
    );
    try {
      await builder.build();
      const res = await h.internal.inject({
        method: "GET",
        url: "/internal/v1/edge/snapshot",
        headers: { "x-scf-edge-node": NODE },
      });
      expect(res.statusCode).toBe(200);
      const p = verifyEnvelope(res.body, { [signer.kid]: signer.publicKey });
      expect(p.settings.counter_features).toEqual(["app", "dev", "props", "rpc"]);
    } finally {
      await h.su.query(
        `UPDATE scf.settings SET value = '[]'::jsonb WHERE key = 'edge_counter_features'`,
      );
    }
  });
});
