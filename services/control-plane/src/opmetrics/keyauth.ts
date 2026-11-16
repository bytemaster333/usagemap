// SPDX-License-Identifier: Apache-2.0
// Verification of SCF-operator API keys (`scfa_op_…`, wire-formats §k; ADR-0016, C-06, C-81), shared by the operator
// metrics API (`/op/v1`) and the programme `metrics_endpoint`: grammar and CRC offline (a bad CRC is audited), lookup by
// id as scf_metrics_ro (cached ≤ 5 s, so a revocation takes effect within that bound), constant-time HMAC under the
// row's pepper version, then revoked / expired. Key events are audited at most once per key and minute; bad-checksum
// rejections, whose key id is attacker-chosen, are aggregated into at most one row per process and minute (audit
// 2026-11-18 #1: one row per id let an anonymous client flood the platform audit chain).

import type { Database } from "../db/database.ts";
import { ApiError } from "../http/problem.ts";
import { hashSecret, type Peppers, parseKey, verifySecret } from "../keys/keys.ts";
import { cpMetrics } from "../obs/metrics.ts";

/** How long a looked-up key row is trusted (C-06: revocation effective within this bound). */
export const KEY_CACHE_MS = 5_000;

export interface KeyRow extends Record<string, unknown> {
  key_id: string;
  secret_hash: Buffer;
  pepper_version: number;
  label: string;
  scopes: string[];
  tenant_restriction: string[] | null;
  rate_limit_per_min: number;
  expires_at: Date;
  revoked_at: Date | null;
}

export type KeyEvent = "api_key.expired" | "api_key.rate_limited";

/** At most one aggregated bad-checksum audit row per process and this interval. */
export const BAD_CHECKSUM_AUDIT_MS = 60_000;

export class OpKeyAuth {
  readonly #db: Database | undefined;
  readonly #peppers: Peppers;
  readonly #clock: () => number;
  readonly #cache = new Map<string, { row: KeyRow | null; at: number }>();
  readonly #auditedOnce = new Map<string, number>();
  /** Last acceptance per key id, to detect an acceptance after revocation beyond the cache bound. */
  readonly #lastAccepted = new Map<string, number>();
  /** Bad-checksum rejections not yet reported, and when the last aggregated row was written. */
  #badChecksumPending = 0;
  #badChecksumFlushedAt = Number.NEGATIVE_INFINITY;

  constructor(db: Database | undefined, peppers: Peppers, clock: () => number = Date.now) {
    this.#db = db;
    this.#peppers = peppers;
    this.#clock = clock;
  }

  get configured(): boolean {
    return this.#db !== undefined;
  }

  async #lookup(db: Database, id: string, requestId: string): Promise<KeyRow | null> {
    const now = this.#clock();
    const hit = this.#cache.get(id);
    if (hit && now - hit.at < KEY_CACHE_MS) return hit.row;
    const row =
      (await db.tx({ tenantId: null, actorKind: "op_key", actorId: id, requestId }, (tx) =>
        tx.maybeOne<KeyRow>(
          `SELECT key_id, secret_hash, pepper_version, label, scopes, tenant_restriction::text[] AS tenant_restriction,
                  rate_limit_per_min, expires_at, revoked_at
             FROM scf.operator_api_keys WHERE key_id = $1`,
          [id],
        ),
      )) ?? null;
    if (this.#cache.size > 10_000) this.#cache.clear();
    this.#cache.set(id, { row, at: now });
    const accepted = this.#lastAccepted.get(id);
    if (row?.revoked_at && accepted !== undefined) {
      // C-06: a revoked key may be accepted only within KEY_CACHE_MS of its revocation.
      if (accepted > row.revoked_at.getTime() + KEY_CACHE_MS)
        cpMetrics.opKeyAcceptedAfterRevocation();
      this.#lastAccepted.delete(id);
    }
    return row;
  }

  /** Writes a key event at most once per key and minute (api_key.* actions allowed for scf_metrics_ro). */
  async keyEvent(
    db: Database,
    action: KeyEvent,
    id: string,
    requestId: string,
    actorKind: "op_key" | "anonymous",
  ): Promise<void> {
    const k = `${action}:${id}`;
    const now = this.#clock();
    if ((this.#auditedOnce.get(k) ?? 0) > now - 60_000) return;
    this.#auditedOnce.set(k, now);
    if (this.#auditedOnce.size > 10_000) this.#auditedOnce.clear();
    try {
      await db.tx(
        { tenantId: null, actorKind, actorId: actorKind === "op_key" ? id : null, requestId },
        (tx) =>
          tx.audit({
            action,
            targetType: "operator_api_key",
            targetId: id,
            outcome: "denied",
            details: { key_id: id },
          }),
      );
    } catch {
      /* best effort: the request is refused either way */
    }
  }

  /**
   * Counts one bad-checksum rejection and writes at most one aggregated `api_key.rejected_bad_checksum` row per minute
   * (details: the count since the last row). The key id is never recorded: it is chosen by the caller.
   */
  async #badChecksum(db: Database, requestId: string): Promise<void> {
    this.#badChecksumPending++;
    const now = this.#clock();
    if (now - this.#badChecksumFlushedAt < BAD_CHECKSUM_AUDIT_MS) return;
    const count = this.#badChecksumPending;
    this.#badChecksumPending = 0;
    this.#badChecksumFlushedAt = now;
    try {
      await db.tx({ tenantId: null, actorKind: "anonymous", actorId: null, requestId }, (tx) =>
        tx.audit({
          action: "api_key.rejected_bad_checksum",
          targetType: "operator_api_key",
          targetId: null,
          outcome: "denied",
          details: { count, window_s: BAD_CHECKSUM_AUDIT_MS / 1000 },
        }),
      );
    } catch {
      /* best effort: the request is refused either way */
    }
  }

  /**
   * A key seen in a URL is compromised (wire-formats §k, C-119): every well-formed `scfa_op_…` key in `text` is revoked
   * at once through `scf.op_key_url_exposed` (proof of possession: the HMAC under the row's pepper version; audited
   * `api_key.compromised_url`). Returns how many keys were revoked. Never throws.
   */
  async revokeExposed(text: string, requestId: string): Promise<number> {
    const db = this.#db;
    if (!db) return 0;
    let decoded = text;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      /* keep the raw text */
    }
    let n = 0;
    for (const m of decoded.matchAll(/scfa_op_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}/g)) {
      const parsed = parseKey(m[0], "op");
      if (!parsed.ok) continue;
      try {
        const r = await db.tx(
          { tenantId: null, actorKind: "op_key", actorId: parsed.key.id, requestId },
          async (tx) => {
            const row = await tx.maybeOne<{ pepper_version: number }>(
              `SELECT pepper_version FROM scf.operator_api_keys WHERE key_id = $1`,
              [parsed.key.id],
            );
            const pepper = row ? this.#peppers.op?.peppers.get(row.pepper_version) : undefined;
            if (!pepper) return "no_match";
            return (
              await tx.one<{ r: string }>(`SELECT scf.op_key_url_exposed($1, $2) AS r`, [
                parsed.key.id,
                hashSecret(pepper, parsed.key.secret),
              ])
            ).r;
          },
        );
        if (r === "revoked") {
          n++;
          this.#cache.delete(parsed.key.id);
        }
      } catch {
        /* best effort: the request is refused either way */
      }
    }
    return n;
  }

  /** The verified key row for an `Authorization` header value; 401 `unauthenticated` otherwise (503 unconfigured). */
  async authenticate(
    authorization: string | undefined,
    requestId: string,
  ): Promise<{ key: KeyRow }> {
    const db = this.#db;
    if (!db)
      throw new ApiError("unavailable", "the operator metrics API is not configured", {
        retryAfter: 60,
      });
    const m = typeof authorization === "string" ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    if (!m)
      throw new ApiError(
        "unauthenticated",
        "an operator API key is required (Authorization: Bearer)",
      );
    const parsed = parseKey(m[1] as string, "op");
    if (!parsed.ok) {
      cpMetrics.opKey(parsed.reason === "checksum" ? "bad_checksum" : "invalid");
      if (parsed.reason === "checksum") await this.#badChecksum(db, requestId);
      throw new ApiError("unauthenticated", "invalid key");
    }
    const row = await this.#lookup(db, parsed.key.id, requestId);
    if (
      !row ||
      !verifySecret(this.#peppers.op, row.pepper_version, parsed.key.secret, row.secret_hash)
    ) {
      cpMetrics.opKey("invalid");
      throw new ApiError("unauthenticated", "invalid key");
    }
    if (row.revoked_at) {
      cpMetrics.opKey("revoked");
      throw new ApiError("unauthenticated", "the key has been revoked");
    }
    if (row.expires_at.getTime() <= this.#clock()) {
      cpMetrics.opKey("expired");
      await this.keyEvent(db, "api_key.expired", row.key_id, requestId, "op_key");
      throw new ApiError("unauthenticated", "the key has expired");
    }
    if (this.#lastAccepted.size > 10_000) this.#lastAccepted.clear();
    this.#lastAccepted.set(row.key_id, this.#clock());
    return { key: row };
  }
}
