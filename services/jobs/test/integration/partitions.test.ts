// SPDX-License-Identifier: Apache-2.0
// Acceptance: job `partitions` creates partitions ahead of time with RLS enabled and forced, every parent policy
// copied (including the F1 delete backstop) and no grants; it drops expired partitions by their retention
// (api_metrics_1m after 35 days — retention.raw-metrics; api_metrics_1h and web_hourly_totals after 25 months) and never drops the
// daily rollups (api_metrics_1d kept indefinitely — retention.aggregates-24m). It runs as scf_jobs through PgBouncer.

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb } from "../../src/db.ts";
import { runPartitions } from "../../src/jobs/partitions.ts";
import { capture, jobsDb, superClient } from "../support/harness.ts";

let su: pg.Pool;
let db: ScfDb;

beforeAll(() => {
  su = superClient();
  db = jobsDb();
});
afterAll(async () => {
  await su?.end();
  await db?.pool.end();
});

const ym = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const addMonths = (d: Date, n: number) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

async function partitionsOf(parent: string): Promise<string[]> {
  const { rows } = await su.query<{ relname: string }>(
    `SELECT c.relname FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid
      WHERE h.inhparent = $1::regclass ORDER BY 1`,
    [`scf.${parent}`],
  );
  return rows.map((r) => r.relname);
}

async function policies(rel: string): Promise<string[]> {
  const { rows } = await su.query<{ p: string }>(
    `SELECT policyname || '|' || permissive || '|' || cmd || '|' || array_to_string(roles, ',') || '|' ||
            coalesce(qual, '') || '|' || coalesce(with_check, '') AS p
       FROM pg_policies WHERE schemaname || '.' || tablename = $1 ORDER BY 1`,
    [rel],
  );
  return rows.map((r) => r.p);
}

describe("job partitions", () => {
  it("re-creates missing future partitions with RLS forced, the parent's policies and no grants", async () => {
    const now = new Date();
    const ahead = [
      `web_hourly_totals_${ym(addMonths(now, 2))}`,
      `api_metrics_1h_${ym(addMonths(now, 1))}`,
      `api_metrics_1m_${ymd(new Date(now.getTime() + 7 * 86_400_000))}`,
    ];
    for (const p of ahead) await su.query(`DROP TABLE IF EXISTS scf_part.${p}`);

    const cap = capture();
    const res = await runPartitions(db, cap.ctx());
    expect(res.created).toBe(3);

    for (const p of ahead) {
      const parent = p.replace(/_\d+$/, "");
      const { rows } = await su.query(
        `SELECT c.relrowsecurity, c.relforcerowsecurity, c.relacl IS NULL OR NOT EXISTS (
                  SELECT 1 FROM aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
                   WHERE r.rolname IN ('scf_app','scf_writer','scf_jobs','scf_metrics_ro','scf_definer','scf_op_definer')
                      OR a.grantee = 0) AS no_grants,
                (SELECT reloptions FROM pg_class WHERE oid = c.oid) AS opts
           FROM pg_class c WHERE c.oid = $1::regclass`,
        [`scf_part.${p}`],
      );
      expect(rows[0], p).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        no_grants: true,
      });
      expect(rows[0].opts).toContain("fillfactor=80");
      const parentPolicies = await policies(`scf.${parent}`);
      expect(
        parentPolicies.some((x) => x.startsWith("tenant_backstop_delete|RESTRICTIVE|DELETE")),
      ).toBe(true);
      expect(await policies(`scf_part.${p}`), p).toEqual(parentPolicies);
    }

    // second run: nothing to create (idempotent)
    expect((await runPartitions(db, cap.ctx())).created).toBe(0);
  });

  it("drops expired partitions by retention and never the daily rollups", async () => {
    const now = new Date();
    const old1h = `api_metrics_1h_${ym(addMonths(now, -27))}`;
    const oldWeb = `web_hourly_totals_${ym(addMonths(now, -27))}`;
    const keptWeb = `web_hourly_totals_${ym(addMonths(now, -23))}`;
    const old1m = `api_metrics_1m_${ymd(new Date(now.getTime() - 40 * 86_400_000))}`;
    const kept1m = `api_metrics_1m_${ymd(new Date(now.getTime() - 20 * 86_400_000))}`;
    const old1d = `api_metrics_1d_${now.getUTCFullYear() - 5}`;
    const range = (tbl: string, from: string, to: string) =>
      `CREATE TABLE IF NOT EXISTS scf_part.${tbl} PARTITION OF scf.${tbl.replace(/_\d+$/, "")}
         FOR VALUES FROM ('${from}+00') TO ('${to}+00')`;
    const month = (d: Date) => d.toISOString().slice(0, 10);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const d40 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 40));
    const d20 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 20));
    // created as the owner of the parents, as scf.ensure_partitions() would have done at the time
    const c = await su.connect();
    try {
      await c.query("SET ROLE scf_migrator");
      await c.query(range(old1h, month(addMonths(now, -27)), month(addMonths(now, -26))));
      await c.query(range(oldWeb, month(addMonths(now, -27)), month(addMonths(now, -26))));
      await c.query(range(keptWeb, month(addMonths(now, -23)), month(addMonths(now, -22))));
      await c.query(range(old1m, day(d40), day(new Date(d40.getTime() + 86_400_000))));
      await c.query(range(kept1m, day(d20), day(new Date(d20.getTime() + 86_400_000))));
      await c.query(
        range(old1d, `${now.getUTCFullYear() - 5}-01-01`, `${now.getUTCFullYear() - 4}-01-01`),
      );
    } finally {
      await c.query("RESET ROLE");
      c.release();
    }

    const cap = capture();
    const res = await runPartitions(db, cap.ctx());
    expect(res.dropped).toBe(3);
    expect(await partitionsOf("api_metrics_1h")).not.toContain(old1h);
    expect(await partitionsOf("web_hourly_totals")).not.toContain(oldWeb);
    expect(await partitionsOf("web_hourly_totals")).toContain(keptWeb);
    expect(await partitionsOf("api_metrics_1m")).not.toContain(old1m);
    expect(await partitionsOf("api_metrics_1m")).toContain(kept1m);
    expect(await partitionsOf("api_metrics_1d")).toContain(old1d);
    expect(cap.lines.some((l) => /"event":"partitions_done".*"dropped":3/.test(l))).toBe(true);
  });
});
