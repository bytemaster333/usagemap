// SPDX-License-Identifier: Apache-2.0
// Database access of the jobs service (data-model §4, §6.3, §16).
//
// `scf`: every unit of work is ONE transaction whose first statement is `scf.set_tenant_ctx()` with actor kind `job`,
// actor id and `app.job` = the job name, and the tenant either unset (cross-tenant reads of named jobs) or the target
// tenant (every write and delete, F1/C-103). The context is transaction-local, so this is safe through PgBouncer in
// transaction mode. This module never sets GUCs itself and never uses session state (no SET, PREPARE or session
// advisory locks).
//
// `umami`: read-only queries over the scf_ro views as scf_umami_ro (web_rollup), and DELETE-only maintenance as
// scf_umami_maint (retention). Each read runs in its own short transaction.

import pg from "pg";
import type { JobName } from "./config.ts";
import { FENCE_CHECK_SQL, type FenceRegistry, JobLockLostError } from "./lock.ts";

// int8 and numeric as JavaScript numbers: every count this service handles stays far below 2^53.
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === 20 || oid === 1700) return (v: string) => Number(v);
    return pg.types.getTypeParser(oid, format);
  },
};

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName: string;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: opts.applicationName,
    types,
  });
  // An idle client that loses its connection must not crash the process; the pool replaces it.
  pool.on("error", () => {});
  return pool;
}

export type Row = Record<string, unknown>;

export class Tx {
  readonly #client: pg.PoolClient;
  readonly job: JobName;
  readonly tenantId: string | null;

  constructor(client: pg.PoolClient, job: JobName, tenantId: string | null) {
    this.#client = client;
    this.job = job;
    this.tenantId = tenantId;
  }

  async query<R = Row>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    const res = await this.#client.query(sql, params as unknown[]);
    return res.rows as R[];
  }

  async one<R = Row>(sql: string, params: readonly unknown[] = []): Promise<R> {
    const rows = await this.query<R>(sql, params);
    if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
    return rows[0] as R;
  }

  /** Executes a statement and returns its row count. */
  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    const res = await this.#client.query(sql, params as unknown[]);
    return res.rowCount ?? 0;
  }

  /** Appends an audit row (data-model §5) to the current tenant's chain; the trigger fills chain, seq and hashes. */
  async audit(action: string, targetType: string, targetId: string, details: Row): Promise<void> {
    await this.#client.query(
      `INSERT INTO scf.audit_log (chain_id, seq, tenant_id, actor_kind, actor_id, action, target_type, target_id,
                                  details, prev_hash, row_hash)
       VALUES (COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid), 0, $1::uuid, 'job', $2, $3, $4, $5,
               $6::jsonb, '\\x'::bytea, '\\x'::bytea)`,
      [this.tenantId, this.job, action, targetType, targetId, JSON.stringify(details)],
    );
  }
}

/** Database `scf` as role scf_jobs. */
export class ScfDb {
  readonly pool: pg.Pool;
  readonly #fences: FenceRegistry | null;

  /** With `fences`, every transaction of a job whose run holds a lock is fenced (lock.ts). */
  constructor(pool: pg.Pool, fences: FenceRegistry | null = null) {
    this.pool = pool;
    this.#fences = fences;
  }

  /**
   * Runs `fn` in one transaction under the job context: tenant unset for cross-tenant reads, or the target tenant
   * for writes and deletes. Commits on success, rolls back on any error.
   */
  async tx<T>(job: JobName, tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT scf.set_tenant_ctx(p_tenant => $1::uuid, p_actor_kind => 'job', p_actor_id => $2::text,
                                   p_job => $2::text)`,
        [tenantId, job],
      );
      const fence = this.#fences?.get(job);
      if (fence) {
        const r = await client.query<{ held: boolean }>(FENCE_CHECK_SQL, [job, fence.pid]);
        if (r.rows[0]?.held !== true) throw new JobLockLostError();
      }
      const out = await fn(new Tx(client, job, tenantId));
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}

/** Database `umami`: one role per pool (scf_umami_ro or scf_umami_maint). */
export class UmamiDb {
  readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async query<R = Row>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    const res = await this.pool.query(sql, params as unknown[]);
    return res.rows as R[];
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    const res = await this.pool.query(sql, params as unknown[]);
    return res.rowCount ?? 0;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
