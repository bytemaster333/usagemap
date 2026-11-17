// SPDX-License-Identifier: Apache-2.0
// Self-attested app events (wire-formats §a.9, migration 0084) against the real database: the counter record's
// optional `app` part (§d.3) lands in scf.app_event_daily exactly once, labelled self_attested; cells outside the
// table's rule and another tenant's sites are dropped and counted; nothing reaches the web counters; the snapshot
// operator setting edge_counter_features (which the snapshot copies) accepts "app".

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCellOk } from "../../src/edge/counters.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const NODE = "edge-m1";
const today = () => new Date().toISOString().slice(0, 10);

let h: Harness;
let tenant = "";
let site = "";
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
    body: { name: "App" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().site_id;
}

beforeAll(async () => {
  h = await startHarness();
  const owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  site = await newSite(owner, tenant);
  const other = await signInGithub(h, newGithubUser());
  otherSite = await newSite(other, await createTenant(h, other));
});
afterAll(async () => {
  await h?.close();
});

describe("app events (§a.9, §d.3 app)", () => {
  it("checks cells like the table does", () => {
    expect(appCellOk({ event: "swap_started", key: "_total", value: "all" })).toBe(true);
    expect(appCellOk({ event: "swap_started", key: "tier", value: "pro" })).toBe(true);
    expect(appCellOk({ event: "swap_started", key: "tier", value: "Pro Plan" })).toBe(false);
    expect(appCellOk({ event: "_session", key: "app_version", value: "1.4.2" })).toBe(true);
    expect(appCellOk({ event: "_session", key: "app_version", value: "1.4.2-beta" })).toBe(false);
    expect(appCellOk({ event: "_session", key: "sdk_version", value: "mobile-rn/0.1.0" })).toBe(
      true,
    );
    expect(appCellOk({ event: "_session", key: "tma_platform", value: "tdesktop" })).toBe(false);
    expect(appCellOk({ event: "_session", key: "device", value: "x" })).toBe(false);
    expect(appCellOk({ event: "_dropped", key: "reason", value: "stale" })).toBe(true);
    expect(appCellOk({ event: "_dropped", key: "reason", value: "other" })).toBe(false);
  });

  it("applies the app part once, self-attested; drops bad cells and foreign sites; web counters untouched", async () => {
    const day = today();
    const a = (event: string, key: string, value: string, count: number, extra = {}) => ({
      tenant_id: tenant,
      site_id: site,
      day,
      platform: "ios",
      event,
      key,
      value,
      count,
      ...extra,
    });
    const rec = counterRecord({
      app: [
        a("swap_started", "_total", "all", 5),
        a("swap_started", "tier", "pro", 3),
        a("swap_started", "_total", "all", 2, { platform: "android" }),
        a("_session", "_total", "all", 4),
        a("_session", "app_version", "1.4.2", 4),
        a("_session", "sdk_version", "mobile-rn/0.1.0", 4),
        a("_session", "tma_platform", "desktop", 1, { platform: "web" }),
        a("_dropped", "reason", "unsafe", 1),
        a("swap_started", "tier", "NOT_A_TOKEN", 9), // outside the rule: dropped
        a("swap_started", "_total", "all", 7, { site_id: otherSite }), // another tenant's site: dropped
      ],
    });
    const r1 = await postCounters(rec);
    expect(r1.statusCode, r1.body).toBe(200);
    const r2 = await postCounters(rec); // duplicate: not applied again
    expect(r2.statusCode, r2.body).toBe(200);
    const rows = await h.su.query<{
      platform: string;
      event_name: string;
      prop_key: string;
      prop_value: string;
      attestation: string;
      count: string;
    }>(
      `SELECT platform, event_name, prop_key, prop_value, attestation, count::text FROM scf.app_event_daily
        WHERE tenant_id = $1 ORDER BY 1, 2, 3, 4`,
      [tenant],
    );
    expect(rows.rows).toEqual([
      {
        platform: "android",
        event_name: "swap_started",
        prop_key: "_total",
        prop_value: "all",
        attestation: "self_attested",
        count: "2",
      },
      {
        platform: "ios",
        event_name: "_dropped",
        prop_key: "reason",
        prop_value: "unsafe",
        attestation: "self_attested",
        count: "1",
      },
      {
        platform: "ios",
        event_name: "_session",
        prop_key: "_total",
        prop_value: "all",
        attestation: "self_attested",
        count: "4",
      },
      {
        platform: "ios",
        event_name: "_session",
        prop_key: "app_version",
        prop_value: "1.4.2",
        attestation: "self_attested",
        count: "4",
      },
      {
        platform: "ios",
        event_name: "_session",
        prop_key: "sdk_version",
        prop_value: "mobile-rn/0.1.0",
        attestation: "self_attested",
        count: "4",
      },
      {
        platform: "ios",
        event_name: "swap_started",
        prop_key: "_total",
        prop_value: "all",
        attestation: "self_attested",
        count: "5",
      },
      {
        platform: "ios",
        event_name: "swap_started",
        prop_key: "tier",
        prop_value: "pro",
        attestation: "self_attested",
        count: "3",
      },
      {
        platform: "web",
        event_name: "_session",
        prop_key: "tma_platform",
        prop_value: "desktop",
        attestation: "self_attested",
        count: "1",
      },
    ]);
    const foreign = await h.su.query(`SELECT 1 FROM scf.app_event_daily WHERE site_id = $1`, [
      otherSite,
    ]);
    expect(foreign.rowCount).toBe(0);
    const web = await h.su.query(`SELECT 1 FROM scf.web_edge_counters WHERE site_id = $1`, [site]);
    expect(web.rowCount).toBe(0);
    // Privacy: the table holds counts per day and closed cells only.
    const cols = await h.su.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'scf' AND table_name = 'app_event_daily'`,
    );
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual([
      "attestation",
      "count",
      "day",
      "event_name",
      "platform",
      "prop_key",
      "prop_value",
      "site_id",
      "tenant_id",
    ]);
  });

  it("refuses a record whose app part breaks the schema (the forwarder then strips optional parts)", async () => {
    const bad = counterRecord({
      app: [
        {
          tenant_id: tenant,
          site_id: site,
          day: today(),
          platform: "windows",
          event: "x",
          key: "_total",
          value: "all",
          count: 1,
        },
      ],
    });
    const r = await postCounters(bad);
    expect([400, 422]).toContain(r.statusCode);
  });

  it("the table refuses a cell outside its rule and anything but self_attested", async () => {
    await expect(
      h.su.query(
        `INSERT INTO scf.app_event_daily (tenant_id, site_id, day, platform, event_name, prop_key, prop_value, count)
         VALUES ($1, $2, current_date, 'ios', '_session', 'device_id', 'abc', 1)`,
        [tenant, site],
      ),
    ).rejects.toThrow(/app_event_daily_cell/);
    await expect(
      h.su.query(
        `INSERT INTO scf.app_event_daily (tenant_id, site_id, day, platform, event_name, prop_key, prop_value, attestation, count)
         VALUES ($1, $2, current_date, 'ios', 'a', '_total', 'all', 'verified', 1)`,
        [tenant, site],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('the operator setting edge_counter_features accepts "app" and nothing unknown', async () => {
    await h.su.query(
      `UPDATE scf.settings SET value = '["props","dev","app"]'::jsonb WHERE key = 'edge_counter_features'`,
    );
    try {
      const { rows } = await h.su.query<{ value: unknown }>(
        `SELECT value FROM scf.settings WHERE key = 'edge_counter_features'`,
      );
      expect(rows[0]?.value).toEqual(["props", "dev", "app"]);
      await expect(
        h.su.query(
          `UPDATE scf.settings SET value = '["props","bogus"]'::jsonb WHERE key = 'edge_counter_features'`,
        ),
      ).rejects.toThrow(/settings_edge_counter_features/);
    } finally {
      await h.su.query(
        `UPDATE scf.settings SET value = '[]'::jsonb WHERE key = 'edge_counter_features'`,
      );
    }
  });
});
