// SPDX-License-Identifier: Apache-2.0
// Acceptance: two runner instances never run the same job concurrently. The lock is a transaction-level advisory lock
// held through PgBouncer in transaction mode (C-103); a lost lock connection aborts the run and frees the lock.
// Also: the service's HTTP listener (/healthz, /readyz, /metrics), graceful shutdown of the real process, and logs
// without personal data.

import { spawn } from "node:child_process";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { createPool, ScfDb } from "../../src/db.ts";
import { AdvisoryLocker, FenceRegistry } from "../../src/lock.ts";
import { createLogger } from "../../src/log.ts";
import { jobMetrics, Registry } from "../../src/metrics.ts";
import { type JobContext, Runner } from "../../src/runner.ts";
import { superClient } from "../support/harness.ts";

let su: pg.Pool;
beforeAll(() => {
  su = superClient();
});
afterAll(async () => {
  await su?.end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRunner(lines: string[], body: (ctx: JobContext) => Promise<void>): Runner {
  const r = new Runner({
    locker: new AdvisoryLocker(inject("jobsUrl"), { keepaliveMs: 200 }),
    log: createLogger({ service: "t" }, (l) => lines.push(l)),
    metrics: jobMetrics(new Registry()),
  });
  r.register({ name: "partitions", triggers: [], run: body });
  return r;
}

describe("single-instance lock across runner instances", () => {
  it("of two instances triggered together exactly one runs; never concurrently (20 rounds)", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const body = async () => {
      active += 1;
      runs += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(60);
      active -= 1;
    };
    const lines: string[] = [];
    const a = makeRunner(lines, body);
    const b = makeRunner(lines, body);
    for (let i = 0; i < 20; i++) {
      const outcomes = await Promise.all([
        a.trigger("partitions", "t"),
        b.trigger("partitions", "t"),
      ]);
      expect(outcomes.sort()).toEqual(["skipped_locked", "success"]);
    }
    expect(maxActive).toBe(1);
    expect(runs).toBe(20);
    await Promise.all([a.stop(1000), b.stop(1000)]);
  });

  it("a trigger arriving while this instance runs the job is queued and runs afterwards, not concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const modes: string[] = [];
    const lines: string[] = [];
    const a = makeRunner(lines, async (ctx) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      modes.push(ctx.mode);
      await sleep(80);
      active -= 1;
    });
    const first = a.trigger("partitions", "hourly");
    await sleep(10);
    const second = a.trigger("partitions", "daily");
    expect(await first).toBe("success");
    expect(await second).toBe("success");
    expect(modes).toEqual(["hourly", "daily"]);
    expect(maxActive).toBe(1);
    await a.stop(1000);
  });

  it("the lock is held for the whole run and released at its end", async () => {
    const locker = new AdvisoryLocker(inject("jobsUrl"));
    const lease = await locker.tryAcquire("web_rollup");
    expect(lease).not.toBeNull();
    // other connections (also through PgBouncer) cannot take it, even after several pooled transactions
    for (let i = 0; i < 3; i++) expect(await locker.tryAcquire("web_rollup")).toBeNull();
    // it shows as a transaction-level advisory lock of an open transaction
    const { rows } = await su.query(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND a.usename = 'scf_jobs' AND a.state LIKE 'idle in transaction%'`,
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    await lease?.release();
    const again = await locker.tryAcquire("web_rollup");
    expect(again).not.toBeNull();
    await again?.release();
  });

  it("a lost lock connection aborts the run and frees the lock for another instance", async () => {
    const locker = new AdvisoryLocker(inject("jobsUrl"), { keepaliveMs: 100 });
    const lease = await locker.tryAcquire("retention");
    expect(lease).not.toBeNull();
    await su.query(
      `SELECT pg_terminate_backend(a.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND a.usename = 'scf_jobs'`,
    );
    for (let i = 0; i < 50 && !lease?.signal.aborted; i++) await sleep(50);
    expect(lease?.signal.aborted).toBe(true);
    const other = await new AdvisoryLocker(inject("jobsUrl")).tryAcquire("retention");
    expect(other).not.toBeNull();
    await other?.release();
    await lease?.release();
  });

  it("fencing: after the lock is lost no transaction of the old run commits once the new run began", async () => {
    const fencesA = new FenceRegistry();
    const dbA = new ScfDb(
      createPool({ connectionString: inject("jobsUrl"), applicationName: "wsg-fence-a" }),
      fencesA,
    );
    const lockerA = new AdvisoryLocker(inject("jobsUrl"), { keepaliveMs: 100, fences: fencesA });
    const leaseA = await lockerA.tryAcquire("stream_gc");
    expect(leaseA?.fence?.pid).toBeGreaterThan(0);
    try {
      // a fenced transaction of the holder works
      await expect(dbA.tx("stream_gc", null, (tx) => tx.one("SELECT 1 AS x"))).resolves.toEqual({
        x: 1,
      });
      // one transaction passes its check and stays in flight
      let inFlightDone = 0;
      const inFlight = dbA.tx("stream_gc", null, async (tx) => {
        await sleep(1500);
        await tx.one("SELECT 1 AS x");
        inFlightDone = Date.now();
      });
      await sleep(200);
      // the lock connection dies (as on a network cut)
      await su.query("SELECT pg_terminate_backend($1)", [leaseA?.fence?.pid]);
      // the next holder takes the lock, then waits in its barrier for the old in-flight transaction
      const lockerB = new AdvisoryLocker(inject("jobsUrl"), { fences: new FenceRegistry() });
      let leaseB: Awaited<ReturnType<AdvisoryLocker["tryAcquire"]>> = null;
      for (let i = 0; i < 40 && !leaseB; i++) {
        leaseB = await lockerB.tryAcquire("stream_gc");
        if (!leaseB) await sleep(50);
      }
      const acquiredAt = Date.now();
      expect(leaseB).not.toBeNull();
      await inFlight;
      expect(inFlightDone).toBeGreaterThan(0);
      expect(acquiredAt).toBeGreaterThanOrEqual(inFlightDone);
      // from now on every transaction of the old run fails before running anything
      await expect(
        dbA.tx("stream_gc", null, (tx) => tx.one("SELECT 1 AS x")),
      ).rejects.toMatchObject({
        name: "JobLockLost",
      });
      await leaseB?.release();
    } finally {
      await leaseA?.release();
      await dbA.pool.end();
    }
  });

  it("stop() aborts a running job at its next unit boundary and waits for it", async () => {
    const lines: string[] = [];
    let sawAbort = false;
    const a = makeRunner(lines, async (ctx) => {
      for (let i = 0; i < 100; i++) {
        if (ctx.signal.aborted) {
          sawAbort = true;
          return;
        }
        await sleep(20);
      }
    });
    const run = a.trigger("partitions", "t");
    await sleep(60);
    expect(await a.stop(5000)).toBe(true);
    expect(await run).toBe("aborted");
    expect(sawAbort).toBe(true);
  });
});

describe("service", () => {
  const env = () => ({
    SCF_JOBS_DATABASE_URL: inject("jobsUrl"),
    SCF_UMAMI_RO_URL: inject("umamiRoUrl"),
    SCF_UMAMI_MAINT_URL: inject("umamiMaintUrl"),
    SCF_JOBS_LISTEN_HOST: "127.0.0.1",
    SCF_JOBS_PORT: "0",
    SCF_JOBS_RUN_ON_START: "false",
  });

  it("serves /healthz, /readyz and /metrics; job runs show up in the metrics", async () => {
    const lines: string[] = [];
    const app = buildApp(loadConfig(env()), {
      log: createLogger({ service: "jobs" }, (l) => lines.push(l)),
    });
    const port = await app.listen();
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(503); // not started yet
    app.runner.start(false);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect(await app.runner.trigger("partitions", "manual")).toBe("success");
    const m = await (await fetch(`${base}/metrics`)).text();
    expect(m).toContain('scf_job_runs_total{job="partitions",outcome="success"} 1');
    expect(m).toMatch(/scf_job_last_success_timestamp_seconds\{job="partitions"\} \d+/);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(405);
    expect(app.runner.jobs().sort()).toEqual([
      "audit_verify",
      "durability_reconcile",
      "partitions",
      "retention",
      "stream_gc",
      "trust_scoring",
      "web_rollup",
    ]);
    await app.stop();
    expect(lines.every((l) => JSON.parse(l).event)).toBe(true);
  });

  it("the real process starts, runs its jobs at start, and exits 0 on SIGTERM with JSON logs only", async () => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "../../src/main.ts")], {
      env: { ...process.env, ...env(), SCF_JOBS_RUN_ON_START: "true", SCF_JOBS_NODE: "core-a" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const finishedCount = () => (out.match(/"event":"job_finished"/g) ?? []).length;
    for (let i = 0; i < 300 && finishedCount() < 7; i++) await sleep(100);
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(err).toBe("");
    expect(code).toBe(0);
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const finished = lines.filter((l) => l.event === "job_finished");
    expect(finished.map((l) => l.job).sort()).toEqual([
      "audit_verify",
      "durability_reconcile",
      "partitions",
      "retention",
      "stream_gc",
      "trust_scoring",
      "web_rollup",
    ]);
    expect(finished.every((l) => l.outcome === "success")).toBe(true);
    expect(lines.some((l) => l.event === "jobs_stopped")).toBe(true);
    expect(lines.every((l) => l.node === "core-a")).toBe(true);
    // Jobs without their configuration are left out by default and say so (tenant_purge, registry_sync, …).
    expect(lines.filter((l) => l.event === "job_disabled").map((l) => l.job)).toEqual([
      "tenant_purge",
      "registry_sync",
      "contract_verification",
      "audit_anchor",
      "daily_seal",
      "onchain_correlation",
      "usage_map",
      "protocol_usage",
    ]);
    // privacy invariant: no IP address, user agent, URL, query string or Stellar key in the logs
    expect(out).not.toMatch(
      /\d+\.\d+\.\d+\.\d+|2001:db8|Mozilla|https?:\/\/|\?[a-z]+=|[GS][A-Z2-7]{55}/,
    );
  }, 60_000);
});

describe("context discipline", () => {
  it("every statement of the jobs role ran under the wrapper (gate G8 runtime half: no context bypass in pg_stat_statements)", async () => {
    const { rows } = await su.query(
      `SELECT count(*)::int AS n FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
        WHERE r.rolname = 'scf_jobs' AND (s.query ~* '^\\s*(SET|RESET)\\s+(LOCAL\\s+)?app\\.' OR s.query ~* '^\\s*SELECT\\s+(pg_catalog\\.)?set_config')`,
    );
    expect(rows[0].n).toBe(0);
  });
});
