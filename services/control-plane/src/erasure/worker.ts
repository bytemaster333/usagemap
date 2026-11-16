// SPDX-License-Identifier: Apache-2.0
// Job `erasure` (data-model §6.3, §8.8, §16.2; docs/privacy/erasure.md §3). Runs in the control-plane process as
// scf_jobs (`scf`) and scf_umami_maint (`umami`). It never reads across tenants: work comes only from
// `scf.job_queue('erasure')` (tenant id + request id, §12), and everything after that runs under THAT tenant's
// context (C-87). Per request, by status:
//   previewing → count-only preview in `umami` and `scf` → previewed (nothing is changed);
//   confirmed  → claimed as running (one core wins) → Umami rows deleted in batches → `scf` rows deleted and the
//                request completed in one transaction (audit `erasure.completed`, counts only — never the selector,
//                C-88); any error → failed with a failure code (audit `erasure.failed`);
//   completed  → spool sweep (§3 step 8): the same selectors re-applied once `sweepDelayMs` (72 h, the spool's maximum
//                life, C-18) after completion, while the literal selector is still kept, so events that were on an
//                edge spool during the run are erased too. Recorded in `result.spool_sweep`. The queue itself returns a
//                completed request once its sweep is due (migration 0056, C-119), so a restart loses no sweep;
//   running    → a run whose claim has not been renewed for RECLAIM_AFTER (a crashed worker) is claimed again and
//                re-run (idempotent). The claim is `started_at`, renewed on every Umami batch (heartbeat) and used as
//                the owner token: a worker whose claim was taken over completes, fails and audits nothing.
// The run and the spool sweep hold the tenant's erasure fence (fence.ts) in one scf transaction from before the first
// Umami delete until the scf delete commits, so job web_rollup cannot write back a site-day it read before the Umami
// deletes finished. A preview that fails
// PREVIEW_MAX_ATTEMPTS times in a row, or is still failing an hour after the request, ends `failed`.
// Deletions are idempotent, so a request can be re-run or re-applied after a restore from backup.

import pg from "pg";
import type { Database, Tx, TxContext } from "../db/database.ts";
import { addCounts, type Counts, type Selector } from "./criteria.ts";
import { FENCE_LOCK_SQL } from "./fence.ts";
import { loadRequest, type RequestRow, resolveTarget, type Target } from "./requests.ts";
import { scfCounts, scfErase } from "./scf.ts";
import type { UmamiEraser } from "./umami.ts";

export const JOB = "erasure";

export interface WorkerLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const silent: WorkerLogger = { info: () => {}, error: () => {} };

function jobCtx(tenantId: string | null): TxContext {
  return { tenantId, actorKind: "job", actorId: JOB, job: JOB };
}

/** A run whose claim was not renewed for this long is claimed again (minutes, as a SQL interval). */
export const RECLAIM_AFTER = "15 minutes";
/** Consecutive failed previews before a request ends `failed`. */
export const PREVIEW_MAX_ATTEMPTS = 3;
/** A preview still failing this long after the request was made ends `failed` whatever the attempt count (restarts). */
export const PREVIEW_MAX_AGE_MS = 3_600_000;
/** Attempts of the fenced execute transaction when PostgreSQL aborts it for a lock conflict (40P01, 40001). */
export const CONFLICT_ATTEMPTS = 3;

/** This worker's claim of a running request was taken over by another core: it stops without writing anything. */
export class ClaimLostError extends Error {
  constructor() {
    super("erasure claim lost to another worker");
    this.name = "ClaimLostError";
  }
}

export type FailureCode = "UMAMI_UNAVAILABLE" | "TIMEOUT" | "CRITERIA_INVALID" | "INTERNAL";

/** SQLSTATE / network error → the stored failure code (never the message, which could carry data). */
export function failureCodeOf(err: unknown, phase: "umami" | "scf"): FailureCode {
  const code =
    typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
  if (code === "57014") return "TIMEOUT";
  if (code === "22023" || code === "22P02") return "CRITERIA_INVALID";
  if (
    phase === "umami" &&
    (code === undefined ||
      code.startsWith("08") ||
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "57P01", "57P03"].includes(code))
  )
    return "UMAMI_UNAVAILABLE";
  return "INTERNAL";
}

function audit(r: RequestRow, selector: Selector | null, counts: Counts | null, extra = {}) {
  return {
    targetType: "erasure_request",
    targetId: r.request_id,
    details: {
      request_id: r.request_id,
      scope: r.scope,
      selector_type: selector?.type ?? null,
      counts,
      ...extra,
    },
  };
}

export interface ErasureWorkerOptions {
  intervalMs: number;
  sweepDelayMs: number;
  /** Direct (non-pooled) connection for LISTEN scf_erasure (requests and confirmations); polling alone without it. */
  listenUrl?: string | undefined;
  onOutcome?: (o: "success" | "failure") => void;
  /** Minimum time between two claim renewals while erasing (default 30 s; 0 = every batch). */
  heartbeatMs?: number;
  log?: WorkerLogger;
  now?: () => number;
}

export class ErasureWorker {
  readonly #db: Database;
  readonly #umami: UmamiEraser;
  readonly #opts: ErasureWorkerOptions;
  readonly #log: WorkerLogger;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;
  /** Consecutive failed previews per request (this process). */
  readonly #previewFailures = new Map<string, number>();
  constructor(db: Database, umami: UmamiEraser, opts: ErasureWorkerOptions) {
    this.#db = db;
    this.#umami = umami;
    this.#opts = opts;
    this.#log = opts.log ?? silent;
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  async start(): Promise<void> {
    this.wake();
    this.#timer = setInterval(() => this.wake(), this.#opts.intervalMs);
    if (this.#opts.listenUrl) await this.#listen(this.#opts.listenUrl).catch(() => {});
  }

  #listener: pg.Client | undefined;

  async #listen(url: string): Promise<void> {
    const client = new pg.Client({ connectionString: url, application_name: "scf-erasure-listen" });
    client.on("error", () => {
      this.#listener = undefined;
      if (!this.#stopped) setTimeout(() => void this.#listen(url).catch(() => {}), 5000);
    });
    client.on("notification", () => this.wake());
    await client.connect();
    await client.query("LISTEN scf_erasure");
    this.#listener = client;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#running;
    await this.#listener?.end().catch(() => {});
  }

  /** Schedules a pass; concurrent wakes coalesce into one extra pass. */
  wake(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.runOnce();
        } while (this.#again && !this.#stopped);
        this.#opts.onOutcome?.("success");
      } catch (err) {
        this.#opts.onOutcome?.("failure");
        this.#log.error({ job: JOB, code: errCode(err) }, "erasure pass failed");
      } finally {
        this.#running = undefined;
      }
    })();
  }

  /** One pass over the queue; returns the number of requests acted on. */
  async runOnce(): Promise<number> {
    const queue = await this.#db.tx(jobCtx(null), (tx) =>
      tx.query<{ tenant_id: string; item_id: string }>(
        `SELECT tenant_id::text AS tenant_id, item_id::text AS item_id FROM scf.job_queue('erasure')`,
      ),
    );
    let n = 0;
    for (const q of queue) {
      if (this.#stopped) break;
      if (await this.process(q.tenant_id, q.item_id)) n++;
    }
    return n;
  }

  /** Acts on one request according to its status; false when there was nothing to do. */
  async process(tenantId: string, requestId: string): Promise<boolean> {
    const r = await this.#db.tx(jobCtx(tenantId), (tx) => loadRequest(tx, tenantId, requestId));
    if (!r) return false;
    if (r.status === "previewing") return this.#preview(r);
    if (r.status === "confirmed" || r.status === "running") return this.#execute(r);
    if (r.status === "completed") return this.#sweep(r);
    return false;
  }

  async #preview(r: RequestRow): Promise<boolean> {
    const target = await this.#db.tx(jobCtx(r.tenant_id), (tx) => resolveTarget(tx, r));
    let umami: Counts;
    try {
      umami = await this.#umami.preview(target);
    } catch (err) {
      this.#log.error({ job: JOB, phase: "preview", code: errCode(err) }, "erasure preview failed");
      const n = (this.#previewFailures.get(r.request_id) ?? 0) + 1;
      if (n < PREVIEW_MAX_ATTEMPTS && r.created_at.getTime() > this.#now() - PREVIEW_MAX_AGE_MS) {
        // Stays `previewing`; the next pass retries.
        if (this.#previewFailures.size > 10_000) this.#previewFailures.clear();
        this.#previewFailures.set(r.request_id, n);
        return false;
      }
      this.#previewFailures.delete(r.request_id);
      return this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
        const code = failureCodeOf(err, "umami");
        const u = await tx.query(
          `UPDATE scf.erasure_requests SET status = 'failed', finished_at = now(), failure_code = $3
            WHERE tenant_id = $1 AND request_id = $2 AND status = 'previewing' RETURNING 1`,
          [r.tenant_id, r.request_id, code],
        );
        if (u.length !== 1) return false;
        await tx.audit({
          action: "erasure.failed",
          outcome: "failure",
          ...audit(r, target.selector, null, { failure_code: code, phase: "preview" }),
        });
        return true;
      });
    }
    this.#previewFailures.delete(r.request_id);
    return this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
      const counts = addCounts(umami, await scfCounts(tx, target));
      const u = await tx.query(
        `UPDATE scf.erasure_requests SET status = 'previewed', preview = $3, previewed_at = now()
          WHERE tenant_id = $1 AND request_id = $2 AND status = 'previewing' RETURNING 1`,
        [r.tenant_id, r.request_id, JSON.stringify(counts)],
      );
      return u.length === 1;
    });
  }

  async #execute(r: RequestRow): Promise<boolean> {
    // Claim: only one core moves the request from confirmed to running — or re-claims a run whose claim was not renewed
    // for RECLAIM_AFTER (a crashed worker, C-119); every step below is idempotent. `started_at` (exact text, µs) is the
    // owner token: every later write of this run requires it unchanged.
    const claimed = await this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
      const u = await tx.maybeOne<{ token: string }>(
        `UPDATE scf.erasure_requests SET status = 'running', started_at = clock_timestamp()
          WHERE tenant_id = $1 AND request_id = $2
            AND (status = 'confirmed'
                 OR (status = 'running' AND started_at < now() - interval '${RECLAIM_AFTER}'))
          RETURNING started_at::text AS token`,
        [r.tenant_id, r.request_id],
      );
      return u ? { token: u.token, target: await resolveTarget(tx, r) } : null;
    });
    if (!claimed) return false;
    const { target } = claimed;
    let token = claimed.token;
    const heartbeatMs = this.#opts.heartbeatMs ?? 30_000;
    let lastBeat = Date.now();
    const onBatch = async () => {
      if (Date.now() - lastBeat < heartbeatMs) return;
      lastBeat = Date.now();
      token = await this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
        const u = await tx.maybeOne<{ token: string }>(
          `UPDATE scf.erasure_requests SET started_at = clock_timestamp()
            WHERE tenant_id = $1 AND request_id = $2 AND status = 'running' AND started_at = $3::timestamptz
            RETURNING started_at::text AS token`,
          [r.tenant_id, r.request_id, token],
        );
        if (!u) throw new ClaimLostError();
        return u.token;
      });
    };
    // One scf transaction holds the tenant's erasure fence (fence.ts) from before the first Umami delete until
    // the scf delete and the completion commit: running rollups of the tenant finish first (their rows are deleted
    // below), rollups starting meanwhile defer. Heartbeats renew the claim in their own short transactions.
    // A lock conflict PostgreSQL resolved by aborting a transaction (40P01, 40001 — in `scf`, or in `umami` against
    // the engine's own writes) re-runs the whole step, up to CONFLICT_ATTEMPTS times: every step is idempotent, and
    // the Umami rows a rolled-back attempt deleted stay deleted (Umami commits per batch), so their counts carry over.
    let umami: Counts | undefined;
    let carried: Counts | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
          await tx.query(FENCE_LOCK_SQL, [r.tenant_id]);
          const erased = await this.#umami.erase(target, { onBatch });
          umami = carried ? addCounts(carried, erased) : erased;
          const counts = addCounts(umami, await scfErase(tx, target));
          const dueAt = new Date(this.#now() + this.#opts.sweepDelayMs).toISOString();
          const u = await tx.query(
            `UPDATE scf.erasure_requests
                SET status = 'completed', completed_at = now(), finished_at = now(), result = $3
              WHERE tenant_id = $1 AND request_id = $2 AND status = 'running' AND started_at = $4::timestamptz
              RETURNING 1`,
            [
              r.tenant_id,
              r.request_id,
              JSON.stringify({ ...counts, spool_sweep: { due_at: dueAt } }),
              token,
            ],
          );
          // Another core owns the run now: roll back (its own run deletes and reports).
          if (u.length !== 1) throw new ClaimLostError();
          await tx.audit({ action: "erasure.completed", ...audit(r, target.selector, counts) });
        });
        break;
      } catch (err) {
        if (err instanceof ClaimLostError) return this.#lost();
        if (isLockConflict(err) && attempt < CONFLICT_ATTEMPTS) {
          this.#log.info(
            { job: JOB, phase: "execute", code: errCode(err), attempt },
            "erasure retried",
          );
          carried = umami ?? carried;
          umami = undefined;
          continue;
        }
        // Rolled back; the failure is recorded in its own transaction (Umami phase when the Umami delete did not finish).
        await this.#fail(
          r,
          target,
          token,
          failureCodeOf(err, umami ? "scf" : "umami"),
          umami ?? carried,
        );
        return true;
      }
    }
    this.#log.info({ job: JOB, phase: "execute", outcome: "completed" }, "erasure completed");
    return true;
  }

  #lost(): boolean {
    this.#log.info({ job: JOB, phase: "execute", outcome: "claim_lost" }, "erasure claim lost");
    return false;
  }

  /** Marks the run failed — only while this worker still owns it; the audit row only when it did. */
  async #fail(
    r: RequestRow,
    target: Target,
    token: string,
    code: FailureCode,
    partial?: Counts,
  ): Promise<void> {
    await this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
      const u = await tx.query(
        `UPDATE scf.erasure_requests
            SET status = 'failed', finished_at = now(), failure_code = $3, result = $4
          WHERE tenant_id = $1 AND request_id = $2 AND status = 'running' AND started_at = $5::timestamptz
          RETURNING 1`,
        [r.tenant_id, r.request_id, code, partial ? JSON.stringify(partial) : null, token],
      );
      if (u.length !== 1) return;
      this.#log.error({ job: JOB, phase: "execute", failure_code: code }, "erasure failed");
      await tx.audit({
        action: "erasure.failed",
        outcome: "failure",
        ...audit(r, target.selector, partial ?? null, { failure_code: code }),
      });
    });
  }

  async #sweep(r: RequestRow): Promise<boolean> {
    const sweep = r.result?.spool_sweep;
    if (!sweep || sweep.done_at || Date.parse(sweep.due_at) > this.#now()) return false;
    const target = await this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
      const cur = await loadRequest(tx, r.tenant_id, r.request_id, true);
      const s = cur?.result?.spool_sweep;
      if (cur?.status !== "completed" || !s || s.done_at) return null;
      // Claimed by another core within the last hour: leave it.
      if (s.started_at && Date.parse(s.started_at) > this.#now() - 3_600_000) return null;
      if (cur.selector_redacted_at) {
        await this.#setSweep(tx, cur, {
          ...s,
          done_at: iso(this.#now()),
          skipped: "selector_redacted",
        });
        return null;
      }
      await this.#setSweep(tx, cur, { ...s, started_at: iso(this.#now()) });
      return resolveTarget(tx, cur);
    });
    if (!target) return false;
    try {
      // The tenant's erasure fence from before the Umami delete until the scf delete commits.
      await this.#db.tx(jobCtx(r.tenant_id), async (tx) => {
        await tx.query(FENCE_LOCK_SQL, [r.tenant_id]);
        const umami = await this.#umami.erase(target);
        const cur = await loadRequest(tx, r.tenant_id, r.request_id, true);
        if (!cur?.result?.spool_sweep) return;
        const counts = addCounts(umami, await scfErase(tx, target));
        await this.#setSweep(tx, cur, {
          ...cur.result.spool_sweep,
          done_at: iso(this.#now()),
          counts,
        });
        await tx.audit({
          action: "erasure.completed",
          ...audit(cur, target.selector, counts, { phase: "spool_sweep" }),
        });
      });
    } catch (err) {
      this.#log.error({ job: JOB, phase: "sweep", code: errCode(err) }, "spool sweep failed");
      return false; // retried after the claim expires
    }
    return true;
  }

  async #setSweep(tx: Tx, r: RequestRow, sweep: NonNullable<RequestRow["result"]>["spool_sweep"]) {
    await tx.query(
      `UPDATE scf.erasure_requests SET result = $3 WHERE tenant_id = $1 AND request_id = $2`,
      [r.tenant_id, r.request_id, JSON.stringify({ ...r.result, spool_sweep: sweep })],
    );
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Deadlock (40P01) or serialisation failure (40001): the transaction was aborted and may be re-run. */
function isLockConflict(err: unknown): boolean {
  const code = errCode(err);
  return code === "40P01" || code === "40001";
}

function errCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : "error";
}
