// SPDX-License-Identifier: Apache-2.0
// Job `domain_verification` (data-model §6.3, §8.4; ADR-0015 L1). Connects as scf_jobs. One pass:
//   1. in a short transaction under a transaction-level advisory lock (one reader at a time across cores, C-103), a
//      cross-tenant read of the due verifications (pending or verified, `next_check_at <= now()`, or pending and past
//      `expires_at`); the transaction ends before any network check (no transaction or pinned connection
//      is held for the pass);
//   2. per item, a short transaction under that tenant's context takes the item: `next_check_at` moves to a lease
//      (now + 10 min) only while the item is still due (compare-and-set), so a concurrent pass of another instance
//      never checks the same item; a crashed pass leaves the item due again when the lease ends;
//   3. per item, the network check (verifier.ts) outside any transaction;
//   4. per item, one transaction under that tenant's context (job = domain_verification) that re-reads the row, applies
//      the outcome and writes the audit rows; host claims only through `scf.claim_host` (§12).
// Schedule: every interval and on wake / `NOTIFY scf_verify`. Outcome rules:
//   - pending + OK + claim 'claimed'/'already_yours' → verified (domain verified, `domain` evidence valid,
//     audit domain.verified); re-checked daily for the first week after verification, then weekly;
//   - claim 'disputed' → HOST_CLAIMED_ELSEWHERE, verification failed, domain disputed (audit domain.disputed); the
//     database marks the claim holder's domain disputed too (data-model §8.4: both disputed); a disputed domain
//     stays disputed on its own successful re-checks until an SCF operator resolves the dispute;
//   - claim 'tombstoned' → HOST_TOMBSTONED, verification failed;
//   - pending + failure → retried with back-off until `expires_at`, then expired;
//   - verified + failure → 14-day grace (`grace_until`), re-checked daily; after the grace the verification and the
//     domain lapse and the host's evidence lapses when no other verified declaration of the host remains
//     (audit domain.lapsed, verification.evidence_lapsed), and the host claim is released then too (a
//     domain that changed hands must be claimable by its new owner; it moves to the tenant's other verified
//     declaration of the host when there is one); a success during the grace clears it.
// Every change of a domain's state sends NOTIFY scf_edge (snapshot).

import pg from "pg";
import type { Database, Tx, TxContext } from "../db/database.ts";
import { releaseClaim } from "./claims.ts";
import type { ResultCode, Verifier, VerifyMethod } from "./verifier.ts";

export const JOB = "domain_verification";
const LOCK_KEY = 0x5c_f0_d0_01; // advisory lock id of this job (int4)
const GRACE_DAYS = 14;
const BATCH = 100;
/** How long a taken item is reserved for the pass that took it. */
const LEASE_MINUTES = 10;
/** Due: verified/pending and its time has come, or pending and expired (and not reserved by a running pass). */
const DUE = `v.status IN ('pending', 'verified')
            AND (v.next_check_at <= now()
                 OR (v.status = 'pending' AND v.expires_at <= now() AND v.next_check_at IS NULL))`;

export type Outcome =
  | ResultCode
  | "HOST_CLAIMED_ELSEWHERE"
  | "HOST_TOMBSTONED"
  | "EXPIRED"
  | "SKIPPED";

interface Due extends Record<string, unknown> {
  tenant_id: string;
  verification_id: string;
  domain_id: string;
  method: VerifyMethod;
  token: string;
  host: string;
  status: "pending" | "verified";
  expired: boolean;
}

export interface WorkerLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const silent: WorkerLogger = { info: () => {}, error: () => {} };

function jobCtx(tenantId: string | null): TxContext {
  return { tenantId, actorKind: "job", actorId: JOB, job: JOB };
}

/** Back-off of a pending verification: 5 min × 2^failures, at most 6 h. */
function pendingRetryMinutes(failures: number): number {
  return Math.min(5 * 2 ** Math.min(failures, 10), 360);
}

export class DomainVerificationWorker {
  readonly #db: Database;
  readonly #verifier: Verifier;
  readonly #intervalMs: number;
  readonly #listenUrl: string | undefined;
  readonly #log: WorkerLogger;
  readonly #onOutcome: ((o: "success" | "failure") => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #listener: pg.Client | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(
    db: Database,
    verifier: Verifier,
    opts: {
      intervalMs: number;
      listenUrl?: string | undefined;
      log?: WorkerLogger;
      onOutcome?: (o: "success" | "failure") => void;
    } = {
      intervalMs: 300_000,
    },
  ) {
    this.#db = db;
    this.#verifier = verifier;
    this.#intervalMs = opts.intervalMs;
    this.#listenUrl = opts.listenUrl;
    this.#log = opts.log ?? silent;
    this.#onOutcome = opts.onOutcome;
  }

  async start(): Promise<void> {
    this.wake();
    this.#timer = setInterval(() => this.wake(), this.#intervalMs);
    if (this.#listenUrl) await this.#listen(this.#listenUrl).catch(() => {});
  }

  async #listen(url: string): Promise<void> {
    const client = new pg.Client({
      connectionString: url,
      application_name: "scf-domain-verification",
    });
    client.on("error", () => {
      this.#listener = undefined;
      if (!this.#stopped) setTimeout(() => void this.#listen(url).catch(() => {}), 5000);
    });
    client.on("notification", () => this.wake());
    await client.connect();
    await client.query("LISTEN scf_verify");
    this.#listener = client;
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
        this.#onOutcome?.("success");
      } catch (err) {
        this.#onOutcome?.("failure");
        this.#log.error(
          { err: err instanceof Error ? err.name : "error" },
          "domain verification pass failed",
        );
      } finally {
        this.#running = undefined;
      }
    })();
  }

  /** Waits for a running pass (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /**
   * One pass. Returns the outcome per verification id, or null when another instance holds the job lock.
   */
  async runOnce(): Promise<Map<string, Outcome> | null> {
    const due = await this.#db.tx(jobCtx(null), async (lockTx) => {
      const got = await lockTx.one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [
        LOCK_KEY,
      ]);
      if (!got.ok) return null;
      return lockTx.query<Due>(
        `SELECT v.tenant_id, v.verification_id, v.domain_id, v.method::text AS method, v.token, d.host,
                v.status::text AS status, (v.status = 'pending' AND v.expires_at <= now()) AS expired
           FROM scf.domain_verifications v
           JOIN scf.site_domains d ON d.tenant_id = v.tenant_id AND d.domain_id = v.domain_id
          WHERE ${DUE}
          ORDER BY v.next_check_at NULLS FIRST, v.verification_id
          LIMIT ${BATCH}`,
      );
    });
    if (due === null) return null;
    const out = new Map<string, Outcome>();
    for (const item of due) {
      if (this.#stopped) break;
      try {
        if (!(await this.#take(item))) continue; // taken by a concurrent pass, or no longer due
        out.set(item.verification_id, await this.#process(item));
      } catch (err) {
        this.#log.error(
          {
            verification_id: item.verification_id,
            err: err instanceof Error ? err.name : "error",
          },
          "domain verification item failed",
        );
      }
    }
    if (out.size > 0) this.#log.info({ checked: out.size }, "domain verification pass");
    return out;
  }

  /** Reserves a due item for this pass (compare-and-set on `next_check_at`); false when it is no longer due. */
  async #take(item: Due): Promise<boolean> {
    const r = await this.#db.tx(jobCtx(item.tenant_id), (tx) =>
      tx.maybeOne(
        `UPDATE scf.domain_verifications v SET next_check_at = now() + make_interval(mins => $3)
          WHERE v.tenant_id = $1 AND v.verification_id = $2 AND v.status = $4::scf.domain_verification_status
            AND ${DUE}
          RETURNING 1`,
        [item.tenant_id, item.verification_id, LEASE_MINUTES, item.status],
      ),
    );
    return r !== undefined;
  }

  async #process(item: Due): Promise<Outcome> {
    const result: ResultCode | "EXPIRED" = item.expired
      ? "EXPIRED"
      : await this.#verifier.verify(item.method, item.host, item.token);
    return this.#db.tx(jobCtx(item.tenant_id), async (tx) => {
      // Re-read under the tenant's context: the row may have been superseded or removed meanwhile.
      const cur = await tx.maybeOne<{
        status: string;
        consecutive_failures: number;
        verified_at: Date | null;
      }>(
        `SELECT status::text AS status, consecutive_failures, verified_at FROM scf.domain_verifications
          WHERE tenant_id = $1 AND verification_id = $2 AND status IN ('pending', 'verified') FOR UPDATE`,
        [item.tenant_id, item.verification_id],
      );
      if (!cur || cur.status !== item.status) return "SKIPPED";
      if (result === "EXPIRED") {
        await tx.query(
          `UPDATE scf.domain_verifications SET status = 'expired', next_check_at = NULL
            WHERE tenant_id = $1 AND verification_id = $2`,
          [item.tenant_id, item.verification_id],
        );
        return "EXPIRED";
      }
      if (result === "OK") return this.#success(tx, item, cur.status === "verified");
      return this.#failure(tx, item, result, Number(cur.consecutive_failures));
    });
  }

  async #success(tx: Tx, item: Due, wasVerified: boolean): Promise<Outcome> {
    const domain = await tx.one<{ state: string }>(
      `SELECT state FROM scf.site_domains WHERE tenant_id = $1 AND domain_id = $2 FOR UPDATE`,
      [item.tenant_id, item.domain_id],
    );
    const claim = await tx.one<{ r: string }>(
      `SELECT scf.claim_host($1, $2::uuid, $3::uuid) AS r`,
      [item.host, item.tenant_id, item.domain_id],
    );
    if (claim.r === "tombstoned" || claim.r === "disputed") {
      const code = claim.r === "tombstoned" ? "HOST_TOMBSTONED" : "HOST_CLAIMED_ELSEWHERE";
      await tx.query(
        `UPDATE scf.domain_verifications
            SET status = 'failed', last_checked_at = now(), last_result_code = $3, next_check_at = NULL,
                consecutive_failures = consecutive_failures + 1
          WHERE tenant_id = $1 AND verification_id = $2`,
        [item.tenant_id, item.verification_id, code],
      );
      if (claim.r === "disputed") {
        await tx.query(
          `UPDATE scf.site_domains SET state = 'disputed' WHERE tenant_id = $1 AND domain_id = $2`,
          [item.tenant_id, item.domain_id],
        );
        await tx.audit({
          action: "domain.disputed",
          targetType: "domain",
          targetId: item.domain_id,
          details: { verification_id: item.verification_id },
        });
        await tx.notify("scf_edge");
      }
      return code;
    }
    // Daily re-checks during the first week after verification, weekly afterwards.
    const recheck = `UPDATE scf.domain_verifications
          SET status = 'verified', verified_at = COALESCE(verified_at, now()), last_checked_at = now(),
              last_result_code = 'OK', consecutive_failures = 0,
              next_check_at = now() + CASE WHEN COALESCE(verified_at, now()) > now() - interval '7 days'
                                           THEN interval '1 day' ELSE interval '7 days' END
        WHERE tenant_id = $1 AND verification_id = $2`;
    if (domain.state === "disputed") {
      // Under SCF-operator review (data-model §8.4): the proof still holds, but neither side becomes `verified` again
      // on its own — only the operator's decision (scf.op_resolve_domain_dispute) ends the dispute.
      await tx.query(recheck, [item.tenant_id, item.verification_id]);
      return "OK";
    }
    await tx.query(
      `UPDATE scf.domain_verifications
          SET status = 'verified', verified_at = COALESCE(verified_at, now()), last_checked_at = now(),
              last_result_code = 'OK', consecutive_failures = 0,
              next_check_at = now() + CASE WHEN COALESCE(verified_at, now()) > now() - interval '7 days'
                                           THEN interval '1 day' ELSE interval '7 days' END
        WHERE tenant_id = $1 AND verification_id = $2`,
      [item.tenant_id, item.verification_id],
    );
    const before = domain;
    await tx.query(
      `UPDATE scf.site_domains
          SET state = 'verified', verified_at = COALESCE(CASE WHEN state = 'verified' THEN verified_at END, now()),
              lapsed_at = NULL, grace_until = NULL
        WHERE tenant_id = $1 AND domain_id = $2`,
      [item.tenant_id, item.domain_id],
    );
    await tx.query(
      `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, last_checked_at)
       VALUES ($1, 'domain', $2, jsonb_build_object('method', $3::text, 'domain_id', $4::text), now())
       ON CONFLICT (tenant_id, kind, subject) DO UPDATE
         SET status = 'valid', lapsed_at = NULL, last_checked_at = now(),
             verified_at = CASE WHEN verification_evidence.status = 'valid' THEN verification_evidence.verified_at
                                ELSE now() END,
             details = EXCLUDED.details`,
      [item.tenant_id, item.host, item.method, item.domain_id],
    );
    if (!wasVerified || before.state !== "verified") {
      await tx.audit({
        action: "domain.verified",
        targetType: "domain",
        targetId: item.domain_id,
        details: { verification_id: item.verification_id, method: item.method },
      });
      await tx.notify("scf_edge");
    }
    return "OK";
  }

  async #failure(tx: Tx, item: Due, code: ResultCode, failures: number): Promise<Outcome> {
    if (item.status === "pending") {
      await tx.query(
        `UPDATE scf.domain_verifications
            SET last_checked_at = now(), last_result_code = $3, consecutive_failures = consecutive_failures + 1,
                next_check_at = LEAST(expires_at, now() + make_interval(mins => $4))
          WHERE tenant_id = $1 AND verification_id = $2`,
        [item.tenant_id, item.verification_id, code, pendingRetryMinutes(failures)],
      );
      return code;
    }
    // A verified domain that fails: 14 days of grace, re-checked daily; then it lapses.
    const d = await tx.one<{ grace_until: Date | null; lapsed: boolean }>(
      `SELECT grace_until, (grace_until IS NOT NULL AND grace_until <= now()) AS lapsed
         FROM scf.site_domains WHERE tenant_id = $1 AND domain_id = $2 FOR UPDATE`,
      [item.tenant_id, item.domain_id],
    );
    if (!d.lapsed) {
      await tx.query(
        `UPDATE scf.site_domains SET grace_until = COALESCE(grace_until, now() + make_interval(days => $3))
          WHERE tenant_id = $1 AND domain_id = $2`,
        [item.tenant_id, item.domain_id, GRACE_DAYS],
      );
      await tx.query(
        `UPDATE scf.domain_verifications
            SET last_checked_at = now(), last_result_code = $3, consecutive_failures = consecutive_failures + 1,
                next_check_at = LEAST(now() + interval '1 day',
                                      (SELECT grace_until FROM scf.site_domains
                                        WHERE tenant_id = $1 AND domain_id = $4))
          WHERE tenant_id = $1 AND verification_id = $2`,
        [item.tenant_id, item.verification_id, code, item.domain_id],
      );
      if (d.grace_until === null) await tx.notify("scf_edge"); // the snapshot shows the grace period
      return code;
    }
    await tx.query(
      `UPDATE scf.domain_verifications
          SET status = 'lapsed', last_checked_at = now(), last_result_code = $3, next_check_at = NULL,
              consecutive_failures = consecutive_failures + 1
        WHERE tenant_id = $1 AND verification_id = $2`,
      [item.tenant_id, item.verification_id, code],
    );
    await tx.query(
      `UPDATE scf.site_domains SET state = 'lapsed', lapsed_at = now() WHERE tenant_id = $1 AND domain_id = $2`,
      [item.tenant_id, item.domain_id],
    );
    await tx.audit({
      action: "domain.lapsed",
      targetType: "domain",
      targetId: item.domain_id,
      details: { verification_id: item.verification_id, result: code },
    });
    // The host claim goes with the lapse: to the tenant's other verified declaration of the host, or
    // released, so the domain's new owner can prove it.
    await releaseClaim(tx, item.tenant_id, item.domain_id, item.host);
    // The host's evidence lapses unless another declaration of the same host is still verified.
    const lapsed = await tx.maybeOne<{ evidence_id: string }>(
      `UPDATE scf.verification_evidence e SET status = 'lapsed', lapsed_at = now()
        WHERE e.tenant_id = $1 AND e.kind = 'domain' AND e.subject = $2 AND e.status = 'valid'
          AND NOT EXISTS (SELECT 1 FROM scf.site_domains d
                           WHERE d.tenant_id = $1 AND d.host = $2 AND d.state = 'verified')
        RETURNING e.evidence_id`,
      [item.tenant_id, item.host],
    );
    if (lapsed) {
      await tx.audit({
        action: "verification.evidence_lapsed",
        targetType: "evidence",
        targetId: lapsed.evidence_id,
        details: { kind: "domain" },
      });
    }
    await tx.notify("scf_edge");
    return code;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#listener?.end().catch(() => {});
    await this.idle();
  }
}
