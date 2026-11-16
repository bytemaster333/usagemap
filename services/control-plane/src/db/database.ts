// SPDX-License-Identifier: Apache-2.0
// The only path to the database (data-model §4). Every unit of work is one transaction whose first statement is
// `scf.set_tenant_ctx(...)` — transaction-local, so it is safe under PgBouncer transaction pooling (C-103). This module
// never calls set_config itself and never issues session `SET`, `PREPARE` or session advisory locks; a source lint test
// enforces that for the whole service.

import pg from "pg";

export type ActorKind =
  | "user"
  | "operator"
  | "op_key"
  | "pub_key"
  | "job"
  | "writer"
  | "system"
  | "anonymous";

export interface TxContext {
  /** Tenant the transaction acts in; null for global work (identity tables, platform chain). */
  tenantId: string | null;
  actorKind: ActorKind;
  actorId: string | null;
  platformRole?: "operator" | "operator_admin" | null;
  stepUpAt?: Date | null;
  reauthenticatedAt?: Date | null;
  /** Operator API key context (actor_kind `op_key`): the key's scopes and tenant restriction (data-model §11). */
  keyScopes?: string[] | null;
  keyTenants?: string[] | null;
  job?: string | null;
  requestId?: string | null;
}

export interface AuditEntry {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: "success" | "denied" | "failure";
  details?: Record<string, unknown>;
  subjectTenantIds?: string[] | null;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export class Tx {
  readonly #client: pg.PoolClient;
  readonly ctx: TxContext;

  constructor(client: pg.PoolClient, ctx: TxContext) {
    this.#client = client;
    this.ctx = ctx;
  }

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    const res = await this.#client.query(sql, params as unknown[]);
    return res.rows as R[];
  }

  async one<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R> {
    const rows = await this.query<R>(sql, params);
    if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
    return rows[0] as R;
  }

  async maybeOne<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R | undefined> {
    const rows = await this.query<R>(sql, params);
    return rows[0];
  }

  /**
   * Switches the context inside the same transaction, again only through the wrapper. Used where one atomic unit acts
   * first globally and then for the tenant it has just learned (invitation acceptance, data-model §12).
   */
  async switchContext(ctx: Partial<TxContext>): Promise<void> {
    Object.assign(this.ctx, ctx);
    await setContext(this.#client, this.ctx);
  }

  /**
   * Appends one row to the hash-chained audit log (data-model §5). The BEFORE INSERT trigger
   * `scf.audit_chain_append()` assigns chain, sequence, time and hashes; the values passed for those columns are
   * placeholders it overwrites. The row lands in the tenant chain of the current context, or the platform chain.
   */
  async audit(entry: AuditEntry): Promise<void> {
    const tenantId = this.ctx.tenantId;
    await this.#client.query(
      `INSERT INTO scf.audit_log (chain_id, seq, tenant_id, actor_kind, actor_id, action, target_type, target_id,
                                  subject_tenant_ids, outcome, details, request_id, prev_hash, row_hash)
       VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '\\x'::bytea, '\\x'::bytea)`,
      [
        tenantId ?? ZERO_UUID,
        tenantId,
        this.ctx.actorKind,
        this.ctx.actorId,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.subjectTenantIds ?? null,
        entry.outcome ?? "success",
        JSON.stringify(entry.details ?? {}),
        this.ctx.requestId ?? null,
      ],
    );
  }

  /** `NOTIFY` is delivered at commit, so it is safe in transaction pooling mode. */
  async notify(
    channel: "scf_edge" | "scf_umami" | "scf_verify" | "scf_erasure" | "scf_snapshot",
  ): Promise<void> {
    await this.#client.query(`SELECT pg_notify($1, '')`, [channel]);
  }
}

async function setContext(client: pg.PoolClient, ctx: TxContext): Promise<void> {
  await client.query(
    `SELECT scf.set_tenant_ctx($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz, $6::timestamptz,
                               $7::text, $8::uuid[], $9::text, $10::text)`,
    [
      ctx.tenantId,
      ctx.actorKind,
      ctx.actorId,
      ctx.platformRole ?? null,
      ctx.stepUpAt ?? null,
      ctx.reauthenticatedAt ?? null,
      ctx.keyScopes ? ctx.keyScopes.join(",") : null,
      ctx.keyTenants ?? null,
      ctx.job ?? null,
      ctx.requestId ?? null,
    ],
  );
}

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: opts.applicationName ?? "scf-control-plane",
  });
  // An idle client that loses its connection must not crash the process; the pool replaces it.
  pool.on("error", () => {});
  return pool;
}

/** `code` of {@link DbUnavailableError}; the HTTP layer answers it with 503 and Retry-After. */
export const DB_UNAVAILABLE = "SCF_DB_UNAVAILABLE";

/**
 * No database connection could be obtained: the pool wait (`connectionTimeoutMillis`) ran out because every connection
 * is busy, or the server is unreachable. node-postgres raises a plain `Error` without SQLSTATE for both, which would
 * otherwise surface as a bare 500.
 */
export class DbUnavailableError extends Error {
  readonly code = DB_UNAVAILABLE;
  constructor(cause: unknown) {
    super("database connection unavailable", { cause });
    this.name = "DbUnavailableError";
  }
}

export class Database {
  readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Runs `fn` in one transaction under `ctx`; commits on success, rolls back on any error. */
  async tx<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw new DbUnavailableError(err);
    }
    let broken = false;
    try {
      await client.query("BEGIN");
      await setContext(client, ctx);
      const out = await fn(new Tx(client, { ...ctx }));
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** PostgreSQL error with SQLSTATE, as raised by the driver. */
export function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}
