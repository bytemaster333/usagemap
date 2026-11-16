// SPDX-License-Identifier: Apache-2.0
// Single-instance lock per job (data-model §6.3, C-07, C-103): a TRANSACTION-level advisory lock,
// `pg_try_advisory_xact_lock`, taken in a transaction that stays open for the whole run on a dedicated connection.
// Through PgBouncer in transaction mode the server connection stays assigned to this client while its transaction is
// open, so the lock is held exactly as long as the run and is released by COMMIT — or by PostgreSQL when the
// connection dies, which cannot leave a stale lock behind (unlike a lease row). Session advisory locks are never used:
// through a transaction pooler they would stay on a server connection that other clients then reuse (S-03).
//
// The lock transaction takes no snapshot after its single statement and writes nothing, so it holds back neither
// vacuum nor replication. If its connection is lost, the lease's signal aborts the run: another instance may take the
// lock from that moment, and the job stops at its next unit boundary.
//
// Fencing: the abort comes only at the next unit boundary, so without more a transaction already
// in flight could still commit after another instance took the lock. Therefore:
//   - every scf transaction of a fenced run (db.ts, FenceRegistry) first takes the job's FENCE key SHARED and then
//     checks in pg_locks that the run's lock is still granted to the lock connection's backend; if not, it fails
//     (JobLockLost) before it writes anything;
//   - a new holder of the lock, before its run starts, takes the fence key EXCLUSIVE once (a barrier): it waits for
//     every transaction that passed the check while the previous holder still had the lock. A transaction that takes
//     the fence after the barrier finds the lock granted to the new holder's backend and fails.
// So no write of an old holder can commit after the new holder's run has begun.

import pg from "pg";

/** Key space of job locks: hashtextextended('scf.jobs/<job>', 0), distinct from db/migrate.sh's 7426010411. */
export const LOCK_KEY_SQL = "hashtextextended('scf.jobs/' || $1::text, 0)";
export const LOCK_SQL = `SELECT pg_try_advisory_xact_lock(${LOCK_KEY_SQL}) AS ok`;
/** The fence key of a job (see the header). */
export const FENCE_KEY_SQL = "hashtextextended('scf.jobs-fence/' || $1::text, 0)";
/** How long the barrier may wait for the previous holder's in-flight transactions. */
export const BARRIER_TIMEOUT = "60s";

/**
 * Taken first in every transaction of a fenced run: the fence key shared, then whether the run's lock is still
 * granted to backend `$2` (the lock connection). $1 = job name.
 */
export const FENCE_CHECK_SQL = `SELECT pg_advisory_xact_lock_shared(${FENCE_KEY_SQL}),
       EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
                WHERE l.locktype = 'advisory' AND l.granted AND l.pid = $2 AND l.objsubid = 1
                  AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = current_database())
                  AND ((l.classid::bigint << 32) | l.objid::bigint) = ${LOCK_KEY_SQL}) AS held`;

/** The lock a run holds, as the database sees it: the job and the lock connection's backend. */
export interface Fence {
  job: string;
  pid: number;
}

/** Fences of the runs this process holds now, by job name (consulted by ScfDb.tx). */
export class FenceRegistry {
  readonly #fences = new Map<string, Fence>();
  set(f: Fence): void {
    this.#fences.set(f.job, f);
  }
  get(job: string): Fence | undefined {
    return this.#fences.get(job);
  }
  delete(f: Fence): void {
    if (this.#fences.get(f.job) === f) this.#fences.delete(f.job);
  }
}

export class JobLockLostError extends Error {
  constructor() {
    super("the job's lock is no longer held by this run");
    this.name = "JobLockLost";
  }
}

export interface Lease {
  readonly signal: AbortSignal;
  /** The lock as the database sees it (null for lockers without one, e.g. tests). */
  readonly fence?: Fence | null;
  release(): Promise<void>;
}

export interface Locker {
  tryAcquire(job: string): Promise<Lease | null>;
}

export class AdvisoryLocker implements Locker {
  readonly #url: string;
  readonly #keepaliveMs: number;
  readonly #appName: string;
  readonly #fences: FenceRegistry | null;

  constructor(
    url: string,
    opts: { keepaliveMs?: number; applicationName?: string; fences?: FenceRegistry } = {},
  ) {
    this.#url = url;
    this.#keepaliveMs = opts.keepaliveMs ?? 15_000;
    this.#appName = opts.applicationName ?? "scf-jobs-lock";
    this.#fences = opts.fences ?? null;
  }

  #client(): pg.Client {
    return new pg.Client({
      connectionString: this.#url,
      application_name: this.#appName,
      connectionTimeoutMillis: 10_000,
    });
  }

  /** Waits until no transaction of a previous holder that passed its fence check is still open (see the header). */
  async #barrier(job: string): Promise<void> {
    const c = this.#client();
    c.on("error", () => {});
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL lock_timeout = '${BARRIER_TIMEOUT}'`);
      await c.query(`SELECT pg_advisory_xact_lock(${FENCE_KEY_SQL})`, [job]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      await c.end().catch(() => {});
    }
  }

  async tryAcquire(job: string): Promise<Lease | null> {
    const client = this.#client();
    const ctl = new AbortController();
    client.on("error", () => ctl.abort());
    client.on("end", () => ctl.abort());
    await client.connect();
    let held = false;
    let fence: Fence | null = null;
    try {
      await client.query("BEGIN");
      const res = await client.query<{ ok: boolean }>(LOCK_SQL, [job]);
      held = res.rows[0]?.ok === true;
      if (held) {
        const p = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        fence = { job, pid: Number(p.rows[0]?.pid) };
        await this.#barrier(job);
      }
    } catch (err) {
      held = false;
      throw err;
    } finally {
      if (!held) {
        await client.query("ROLLBACK").catch(() => {});
        await client.end().catch(() => {});
      }
    }
    if (!held || !fence) return null;
    this.#fences?.set(fence);

    let released = false;
    // Keep-alive inside the open transaction: detects a lost connection while the job is between statements.
    const timer = setInterval(() => {
      client.query("SELECT 1").catch(() => ctl.abort());
    }, this.#keepaliveMs);
    timer.unref();
    const f = fence;
    return {
      signal: ctl.signal,
      fence: f,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        this.#fences?.delete(f);
        await client.query("COMMIT").catch(() => {});
        await client.end().catch(() => {});
      },
    };
  }
}
