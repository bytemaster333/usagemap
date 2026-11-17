// SPDX-License-Identifier: Apache-2.0
// Runner semantics with an in-memory lock (skip when locked, queue within an instance, failure isolation, graceful
// stop), configuration, the metrics registry and the privacy guard of the logger.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";
import type { Lease, Locker } from "../../src/lock.ts";
import { createLogger, errorFields, safeValue } from "../../src/log.ts";
import { jobMetrics, Registry } from "../../src/metrics.ts";
import { Runner } from "../../src/runner.ts";

class MemoryLocker implements Locker {
  readonly held = new Set<string>();
  async tryAcquire(job: string): Promise<Lease | null> {
    if (this.held.has(job)) return null;
    this.held.add(job);
    const ctl = new AbortController();
    return { signal: ctl.signal, release: async () => void this.held.delete(job) };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function runner(locker: Locker, lines: string[] = []) {
  const reg = new Registry();
  return {
    reg,
    r: new Runner({
      locker,
      log: createLogger({}, (l) => lines.push(l)),
      metrics: jobMetrics(reg),
    }),
  };
}

describe("Runner", () => {
  it("skips when another instance holds the lock and records it", async () => {
    const locker = new MemoryLocker();
    const a = runner(locker);
    const b = runner(locker);
    for (const x of [a, b]) {
      x.r.register({
        name: "retention",
        triggers: [],
        run: async () => {
          await sleep(30);
        },
      });
    }
    const out = await Promise.all([a.r.trigger("retention", "t"), b.r.trigger("retention", "t")]);
    expect(out.sort()).toEqual(["skipped_locked", "success"]);
    expect(a.reg.render() + b.reg.render()).toContain('outcome="skipped_locked"} 1');
  });

  it("a failing job is reported as failure and does not stop the runner", async () => {
    const lines: string[] = [];
    const { r, reg } = runner(new MemoryLocker(), lines);
    let n = 0;
    r.register({
      name: "web_rollup",
      triggers: [],
      run: async () => {
        n += 1;
        if (n === 1)
          throw Object.assign(new Error("duplicate key value (secret=1.2.3.4)"), { code: "23505" });
      },
    });
    expect(await r.trigger("web_rollup", "t")).toBe("failure");
    expect(await r.trigger("web_rollup", "t")).toBe("success");
    expect(reg.render()).toContain('scf_job_runs_total{job="web_rollup",outcome="failure"} 1');
    const failed = lines.map((l) => JSON.parse(l)).find((l) => l.event === "job_failed");
    expect(failed).toMatchObject({ error_class: "postgres", sqlstate: "23505" });
    expect(lines.join("\n")).not.toContain("1.2.3.4");
  });

  it("queues one trigger per mode while running", async () => {
    const { r } = runner(new MemoryLocker());
    const modes: string[] = [];
    r.register({
      name: "partitions",
      triggers: [],
      run: async (ctx) => {
        modes.push(ctx.mode);
        await sleep(20);
      },
    });
    const all = [
      r.trigger("partitions", "a"),
      r.trigger("partitions", "b"),
      r.trigger("partitions", "b"),
    ];
    await Promise.all(all);
    expect(modes).toEqual(["a", "b"]);
  });

  it("arms schedules with the injected clock and stops cleanly", async () => {
    const { r } = runner(new MemoryLocker());
    r.register({
      name: "partitions",
      triggers: [{ schedule: { kind: "hourly", minute: 0 }, mode: "hourly" }],
      run: async () => {},
    });
    r.start(false);
    expect(r.started).toBe(true);
    expect(await r.stop(100)).toBe(true);
    expect(r.stopping).toBe(true);
    expect(await r.trigger("partitions", "x")).toBe("aborted");
  });
});

describe("config", () => {
  const base = { SCF_JOBS_DATABASE_URL: "postgres://scf_jobs@pgbouncer:6432/scf" };
  it("requires the umami URLs of enabled jobs only", () => {
    expect(() => loadConfig(base)).toThrow(ConfigError);
    const c = loadConfig({ ...base, SCF_JOBS_ENABLED: "partitions,stream_gc" });
    expect(c.enabled).toEqual(["partitions", "stream_gc"]);
    expect(c.rollupDailyAt).toEqual({ hour: 1, minute: 30 });
  });
  it("reads passwords from files and never needs them in the URL", () => {
    const f = join(tmpdir(), `wsg-pw-${process.pid}`);
    writeFileSync(f, "p@ss/word\n");
    const c = loadConfig({
      ...base,
      SCF_JOBS_DB_PASSWORD_FILE: f,
      SCF_UMAMI_RO_URL: "postgres://scf_umami_ro@pgbouncer:6432/umami",
      SCF_UMAMI_RO_PASSWORD_FILE: f,
      SCF_UMAMI_MAINT_URL: "postgres://scf_umami_maint@postgres:5432/umami",
      SCF_UMAMI_MAINT_PASSWORD_FILE: f,
    });
    expect(decodeURIComponent(new URL(c.scfUrl).password)).toBe("p@ss/word");
    expect(decodeURIComponent(new URL(c.umamiMaintUrl).password)).toBe("p@ss/word");
  });
  it("rejects unknown jobs and malformed values", () => {
    expect(() => loadConfig({ ...base, SCF_JOBS_ENABLED: "nope" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, SCF_JOBS_ENABLED: "partitions", SCF_WEB_ROLLUP_DAILY_AT: "25:00" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, SCF_JOBS_ENABLED: "partitions", SCF_JOBS_PORT: "x" }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ SCF_JOBS_DATABASE_URL: "mysql://x" })).toThrow(ConfigError);
  });
});

describe("logger privacy guard", () => {
  it("redacts IPs, URLs, query strings, user agents, e-mail addresses and Stellar keys", () => {
    for (const v of [
      "203.0.113.7",
      "2001:db8::1",
      "https://example.org/a?b=c",
      "/path?q=1",
      "Mozilla/5.0 (X11; Linux x86_64)",
      "someone@example.org",
      `G${"A".repeat(55)}`,
      `S${"B".repeat(55)}`,
      "duplicate key value violates unique constraint",
    ]) {
      expect(safeValue(v), v).toBe("{redacted}");
    }
    for (const v of [
      "web_rollup",
      "2026-11-12",
      "2026-11-12T01:30:00.000Z",
      "0195f0b2-1c3d-7e4f-8a9b-0c1d2e3f4a5b",
      "23505",
      17,
      true,
    ]) {
      expect(safeValue(v)).toBe(v);
    }
  });
  it("logs errors by class and code, never by message or detail", () => {
    const f = errorFields(
      Object.assign(new Error("Key (url_path)=(/secret) exists"), {
        code: "23505",
        detail: "x",
        constraint: "pk",
      }),
    );
    expect(f).toEqual({ error_class: "postgres", sqlstate: "23505", constraint: "pk" });
    expect(
      errorFields(
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }),
      ),
    ).toEqual({
      error_class: "network",
      errno: "ECONNREFUSED",
    });
  });
});

describe("metrics", () => {
  it("renders the Prometheus text format and refuses free-text labels", () => {
    const reg = new Registry();
    const m = jobMetrics(reg);
    m.runs.inc({ job: "partitions", outcome: "success" });
    m.lastDuration.set({ job: "partitions" }, 0.5);
    const text = reg.render();
    expect(text).toContain("# TYPE scf_job_runs_total counter");
    expect(text).toContain('scf_job_runs_total{job="partitions",outcome="success"} 1');
    expect(text).toContain('scf_job_last_duration_seconds{job="partitions"} 0.5');
    expect(() => m.runs.inc({ job: "/path?x=1" })).toThrow();
  });
});
