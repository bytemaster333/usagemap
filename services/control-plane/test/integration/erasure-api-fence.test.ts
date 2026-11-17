// SPDX-License-Identifier: Apache-2.0
// Regression: a service-scope erasure deadlocked (40P01) against the
// metrics writer's upserts of the same series and only completed with the writer paused (privacy.tenant-erasure, privacy.erasure-workflow).
//
// On the real database (no Umami: the Umami side is a scripted eraser), job `erasure` runs while a writer transaction
// is open. The writer transaction is staged with exactly the writer's lock order (services/metrics-writer
// internal/store/tx.go + upsert.go): the tenant's API fence SHARED first, then row locks on api_metrics_1d, _1h, _1m.
// The pause between the _1d and the _1h upsert is where the live deadlock formed. The erasure must wait for that
// transaction, then delete every row of the range including the writer's — with no 40P01 on either side.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Counts, zeroCounts } from "../../src/erasure/criteria.ts";
import { API_FENCE_KEY_SQL, API_FENCE_SHARED_SQL } from "../../src/erasure/fence.ts";
import type { UmamiEraser } from "../../src/erasure/umami.ts";
import { CONFLICT_ATTEMPTS, ErasureWorker } from "../../src/erasure/worker.ts";
import {
  allResolutions,
  createService,
  ensurePartition,
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

let h: Harness;
let owner = "";
let tenant = "";
const tenants: string[] = [];

/** A fresh tenant per test (L0 allows one service per tenant). */
async function freshTenant(): Promise<void> {
  tenant = await createTenant(h, owner);
  tenants.push(tenant);
}

const DAY = { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" };
const AT = new Date("2026-10-01T10:15:00Z");

const eraser = {
  preview: async (): Promise<Counts> => zeroCounts(),
  erase: async (): Promise<Counts> => zeroCounts(),
} as unknown as UmamiEraser;

function worker(e: UmamiEraser = eraser): ErasureWorker {
  return new ErasureWorker(h.jobsDb, e, {
    intervalMs: 60_000,
    sweepDelayMs: 3_600_000,
    heartbeatMs: 0,
  });
}

async function get(id: string) {
  return (
    await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/erasure-requests/${id}`,
      cookie: owner,
    })
  ).json();
}

async function confirmed(body: unknown): Promise<string> {
  const c = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenant}/erasure-requests`,
    cookie: owner,
    body,
  });
  expect(c.statusCode, c.body).toBe(202);
  const id = c.json().request_id as string;
  await worker().process(tenant, id);
  expect((await get(id)).status).toBe("previewed");
  const conf = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenant}/erasure-requests/${id}/confirm`,
    cookie: owner,
  });
  expect(conf.statusCode, conf.body).toBe(202);
  return id;
}

async function rows(service: string): Promise<number> {
  const r = await h.su.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM scf.api_metrics_1m WHERE service_id = $1)
          + (SELECT count(*) FROM scf.api_metrics_1h WHERE service_id = $1)
          + (SELECT count(*) FROM scf.api_metrics_1d WHERE service_id = $1) AS n`,
    [service],
  );
  return Number(r.rows[0]?.n);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once a session of job `erasure` (scf_jobs) waits for a lock: the erasure has reached a blocking point. */
async function erasureWaits(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const r = await h.su.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND usename = 'scf_jobs'`,
    );
    if (Number(r.rows[0]?.n) > 0) return true;
    await sleep(50);
  }
  return false;
}

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  for (const t of ["api_metrics_1m", "api_metrics_1h", "api_metrics_1d"] as const)
    await ensurePartition(h, t, AT);
});

afterAll(async () => {
  // Leave no work in the shared queue for later files.
  if (h && tenants.length > 0)
    await h.su.query(
      `UPDATE scf.erasure_requests SET status = 'cancelled', finished_at = now()
        WHERE tenant_id = ANY ($1::uuid[]) AND status IN ('previewing', 'previewed', 'confirmed', 'running')`,
      [tenants],
    );
  await h?.close();
});

describe("LD1 service-scope erasure while the metrics writer writes the same series", () => {
  it("the erasure waits for the open writer transaction, then deletes its rows too; no deadlock", async () => {
    await freshTenant();
    const service = await createService(h, owner, tenant);
    const group = await streamGroup(h, tenant, service);
    const r = await route(h, tenant, service, "/orders/{id}");
    await metricRows(
      h,
      tenant,
      service,
      group,
      allResolutions(AT, { routeId: r, status: 200, values: [0.1] }),
    );
    expect(await rows(service)).toBe(3);
    const id = await confirmed({ service_id: service, criteria: DAY });

    const w = await h.su.connect();
    try {
      // The writer's transaction: fence shared first, then the _1d upsert of the series …
      await w.query("BEGIN");
      await w.query(API_FENCE_SHARED_SQL, [tenant]);
      const bump = (table: string) =>
        w.query(
          `UPDATE scf.${table} SET request_count = request_count + 1 WHERE tenant_id = $1 AND service_id = $2`,
          [tenant, service],
        );
      await bump("api_metrics_1d");
      // … the erasure starts now (before the fix it deleted _1m and _1h here and then waited for the _1d row) …
      const run = worker().process(tenant, id);
      expect(await erasureWaits()).toBe(true);
      // … and the writer goes on with _1h and _1m (before the fix: 40P01 on one side, deadlock_timeout later).
      await bump("api_metrics_1h");
      await bump("api_metrics_1m");
      await w.query("COMMIT");
      expect(await run).toBe(true);
    } catch (err) {
      await w.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      w.release();
    }
    const done = await get(id);
    expect(done.status, JSON.stringify(done)).toBe("completed");
    expect(done.result.api_metric_rows).toBe(3);
    expect(await rows(service)).toBe(0);
  });

  it("a path-selector erasure (route dictionary delete) waits for a writer inserting that route's rows", async () => {
    await freshTenant();
    const service = await createService(h, owner, tenant);
    const group = await streamGroup(h, tenant, service);
    const victim = await route(h, tenant, service, "/users/{id}");
    const keep = await route(h, tenant, service, "/health");
    await metricRows(h, tenant, service, group, [
      ...allResolutions(AT, { routeId: victim, status: 200, values: [0.2] }),
      ...allResolutions(AT, { routeId: keep, status: 200, values: [0.3] }),
    ]);
    const id = await confirmed({
      service_id: service,
      criteria: { ...DAY, path_pattern: "/users/*" },
    });
    const w: pg.PoolClient = await h.su.connect();
    try {
      await w.query("BEGIN");
      await w.query(API_FENCE_SHARED_SQL, [tenant]);
      // A new 1d row of the victim route (the INSERT holds a KEY SHARE lock on the api_routes row).
      await w.query(
        `INSERT INTO scf.api_metrics_1d (tenant_id, service_id, route_id, method, status_code, source, stream_group_id,
                                         bucket_start, request_count, duration_sum, hist_kind, hist, hist_quality)
         VALUES ($1, $2, $3, 1, 500, 'sdk_metric', $4, '2026-10-01T00:00:00Z', 1, 0.5, 'exp3',
                 array_fill(0, ARRAY[194])::int4[], 0)`,
        [tenant, service, victim, group.groupId],
      );
      const run = worker().process(tenant, id);
      expect(await erasureWaits()).toBe(true);
      await w.query(
        `UPDATE scf.api_metrics_1h SET request_count = request_count + 1 WHERE service_id = $1 AND route_id = $2`,
        [service, victim],
      );
      await w.query("COMMIT");
      expect(await run).toBe(true);
    } catch (err) {
      await w.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      w.release();
    }
    const done = await get(id);
    expect(done.status, JSON.stringify(done)).toBe("completed");
    expect(done.result).toMatchObject({ api_routes: 1, api_metric_rows: 4 });
    expect(await rows(service)).toBe(3); // /health only
    const left = await h.su.query(`SELECT route FROM scf.api_routes WHERE service_id = $1`, [
      service,
    ]);
    expect(left.rows.map((x) => x.route)).toEqual(["/health"]);
  });

  it("the writer's copy of the fence key is the same text (services/metrics-writer/internal/store/fence.go)", () => {
    const go = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "metrics-writer",
        "internal",
        "store",
        "fence.go",
      ),
      "utf8",
    );
    expect(go).toContain(`apiFenceKeySQL = \`${API_FENCE_KEY_SQL}\``);
  });

  it(`a transaction aborted for a lock conflict is re-run (up to ${CONFLICT_ATTEMPTS} attempts), then fails`, async () => {
    await freshTenant();
    const service = await createService(h, owner, tenant);
    const group = await streamGroup(h, tenant, service);
    const r = await route(h, tenant, service, "/x");
    await metricRows(
      h,
      tenant,
      service,
      group,
      allResolutions(AT, { routeId: r, status: 200, values: [0.1] }),
    );
    const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
    let calls = 0;
    const flaky = {
      preview: async () => zeroCounts(),
      erase: async () => {
        calls++;
        if (calls === 1) throw deadlock();
        return { ...zeroCounts(), website_events: 5 };
      },
    } as unknown as UmamiEraser;
    const id = await confirmed({ service_id: service, criteria: DAY });
    expect(await worker(flaky).process(tenant, id)).toBe(true);
    expect(calls).toBe(2);
    const done = await get(id);
    expect(done.status).toBe("completed");
    expect(done.result).toMatchObject({ website_events: 5, api_metric_rows: 3 });

    let tries = 0;
    const stuck = {
      preview: async () => zeroCounts(),
      erase: async () => {
        tries++;
        throw deadlock();
      },
    } as unknown as UmamiEraser;
    const id2 = await confirmed({ service_id: service, criteria: DAY });
    await worker(stuck).process(tenant, id2);
    expect(tries).toBe(CONFLICT_ATTEMPTS);
    expect((await get(id2)).status).toBe("failed");
  });
});
