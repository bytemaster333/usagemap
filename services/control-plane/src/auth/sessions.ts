// SPDX-License-Identifier: Apache-2.0
// Server-side sessions in PostgreSQL (ADR-0014, C-20, data-model §8.1). The cookie carries 256 random bits; only
// SHA-256(value) is stored. No IP address and no User-Agent are stored.

import { randomUUID } from "node:crypto";
import type { Database, Tx } from "../db/database.ts";
import { newOpaqueToken, sha256 } from "../util/ids.ts";

export const SESSION_COOKIE = "__Host-scf_session";
export const OAUTH_COOKIE = "__Host-scf_oauth";

export type SessionKind = "tenant_user" | "operator";
export type FirstFactor = "github" | "stellar_sep53" | "stellar_sep10";
export type ReauthMethod = "passkey" | FirstFactor;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** C-20 timeouts. */
export const TIMEOUTS: Record<SessionKind, { idle: number; absolute: number }> = {
  tenant_user: { idle: 12 * HOUR, absolute: 14 * DAY },
  operator: { idle: 30 * MIN, absolute: 12 * HOUR },
};
/** C-09 / C-87: a step-up or a fresh sign-in is valid for 10 minutes. */
export const FRESH_MS = 10 * MIN;

export interface Session {
  hash: Buffer;
  userId: string;
  kind: SessionKind;
  firstFactor: FirstFactor;
  passkeyVerifiedAt: Date | null;
  stepUpAt: Date | null;
  reauthenticatedAt: Date;
  reauthMethod: ReauthMethod;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  /** Active platform role, read at every request (a revoked grant takes effect at once). */
  platformRole: "operator" | "operator_admin" | null;
  /** Number of the user's non-revoked passkeys. */
  passkeyCount: number;
}

/**
 * SCF operators need a passkey assertion at every sign-in before the session is complete (C-09). Follows the user's
 * CURRENT platform role (C-114), not the kind recorded when the session was created.
 */
export function isComplete(s: Session): boolean {
  return s.platformRole === null || s.passkeyVerifiedAt !== null;
}

/** Step-up (C-09) exists only for a user who is an SCF operator now. */
export function stepUpValidUntil(s: Session): Date | null {
  return s.platformRole !== null && s.stepUpAt ? new Date(s.stepUpAt.getTime() + FRESH_MS) : null;
}

/**
 * C-87: for a member with a passkey only a passkey assertion counts as recent authentication; for an SCF operator
 * with a passkey only a step-up does (C-114). Without a passkey the last first-factor sign-in counts — which is also
 * the 10-minute window in which an operator's first passkey may be enrolled from a partial session.
 */
export function recentAuthValidUntil(s: Session): Date | null {
  if (s.passkeyCount > 0 && s.platformRole !== null) return stepUpValidUntil(s);
  if (s.passkeyCount > 0 && s.reauthMethod !== "passkey") return null;
  return new Date(s.reauthenticatedAt.getTime() + FRESH_MS);
}

export function sessionView(s: Session): Record<string, unknown> {
  return {
    user_id: s.userId,
    kind: s.kind,
    first_factor: s.firstFactor,
    passkey_verified: s.passkeyVerifiedAt !== null,
    complete: isComplete(s),
    platform_role: s.platformRole,
    step_up_valid_until: stepUpValidUntil(s)?.toISOString() ?? null,
    recent_auth_valid_until: recentAuthValidUntil(s)?.toISOString() ?? null,
    idle_expires_at: s.idleExpiresAt.toISOString(),
    absolute_expires_at: s.absoluteExpiresAt.toISOString(),
  };
}

interface SessionRow extends Record<string, unknown> {
  session_hash: Buffer;
  user_id: string;
  kind: SessionKind;
  first_factor: FirstFactor;
  passkey_verified_at: Date | null;
  step_up_at: Date | null;
  reauthenticated_at: Date;
  reauth_method: ReauthMethod;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  platform_role: "operator" | "operator_admin" | null;
  passkey_count: number;
}

function fromRow(r: SessionRow): Session {
  return {
    hash: r.session_hash,
    userId: r.user_id,
    kind: r.kind,
    firstFactor: r.first_factor,
    passkeyVerifiedAt: r.passkey_verified_at,
    stepUpAt: r.step_up_at,
    reauthenticatedAt: r.reauthenticated_at,
    reauthMethod: r.reauth_method,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    idleExpiresAt: r.idle_expires_at,
    absoluteExpiresAt: r.absolute_expires_at,
    platformRole: r.platform_role,
    passkeyCount: Number(r.passkey_count),
  };
}

const SELECT_SESSION = `
  SELECT s.session_hash, s.user_id, s.kind, s.first_factor, s.passkey_verified_at, s.step_up_at,
         s.reauthenticated_at, s.reauth_method, s.created_at, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
         (SELECT o.role::text FROM scf.platform_operators o WHERE o.user_id = s.user_id AND o.revoked_at IS NULL) AS platform_role,
         (SELECT count(*)::int FROM scf.passkey_credentials p WHERE p.user_id = s.user_id AND p.revoked_at IS NULL) AS passkey_count
    FROM scf.auth_sessions s JOIN scf.users u ON u.user_id = s.user_id
   WHERE s.session_hash = $1 AND s.revoked_at IS NULL AND u.disabled_at IS NULL AND u.deleted_at IS NULL
     AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`;

export type RevokeReason =
  | "logout"
  | "rotated"
  | "user_disabled"
  | "operator_revoked"
  | "account_deleted";

export interface NewSession {
  userId: string;
  firstFactor: FirstFactor;
  reauthMethod: ReauthMethod;
  passkeyVerifiedAt?: Date | null;
  stepUpAt?: Date | null;
  reauthenticatedAt?: Date;
  /** Keep the absolute expiry of the session being rotated. */
  absoluteExpiresAt?: Date;
  createdAt?: Date;
}

/** Upper bound of the in-memory deny list (entries expire with their session; expired ones are dropped first). */
const MAX_DENIED = 50_000;
/** Retry schedule of a sign-out whose revocation could not be written (ms; the last value repeats). */
const REVOKE_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 60_000];

export interface SessionStoreOptions {
  /** Called when a sign-out could not be written to the database (it is retried) or its audit row failed. */
  onError?: (what: "revoke_failed" | "audit_failed", err: unknown) => void;
}

export class SessionStore {
  readonly #db: Database;
  readonly #onError: SessionStoreOptions["onError"];
  /**
   * Sessions signed out on this process whose revocation is not (yet) known to be committed: hex(SHA-256) → time after
   * which the entry is useless (the session's absolute expiry). `lookup` refuses them before asking the database, so a
   * sign-out fails closed even while the database is unreachable or the pool is exhausted.
   */
  readonly #denied = new Map<string, number>();

  constructor(db: Database, opts: SessionStoreOptions = {}) {
    this.#db = db;
    this.#onError = opts.onError;
  }

  /** Resolves a cookie value; slides the idle expiry (at most once a minute). Returns null for anything invalid. */
  async lookup(token: string | undefined, requestId: string): Promise<Session | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = sha256(token);
    if (this.isDenied(hash)) return null;
    return this.#db.tx(
      { tenantId: null, actorKind: "anonymous", actorId: null, requestId },
      async (tx) => {
        const row = await tx.maybeOne<SessionRow>(SELECT_SESSION, [hash]);
        if (!row) return null;
        const s = fromRow(row);
        // Granted an SCF-operator role after this session began (C-114): the session ends; the user signs in again and
        // gets an operator session (passkey assertion, operator timeouts). Covers grants made outside the API too.
        if (s.kind === "tenant_user" && s.platformRole !== null) {
          await this.revoke(tx, hash, "operator_revoked");
          return null;
        }
        if (Date.now() - s.lastSeenAt.getTime() > MIN) {
          const idle = new Date(
            Math.min(Date.now() + TIMEOUTS[s.kind].idle, s.absoluteExpiresAt.getTime()),
          );
          await tx.query(
            `UPDATE scf.auth_sessions SET last_seen_at = now(), idle_expires_at = $2 WHERE session_hash = $1`,
            [hash, idle],
          );
          s.idleExpiresAt = idle;
        }
        return s;
      },
    );
  }

  /** Creates a session inside the caller's transaction; returns the cookie value (shown once, never stored). */
  async create(tx: Tx, n: NewSession): Promise<{ token: string; session: Session }> {
    const op = await tx.maybeOne<{ role: string }>(
      `SELECT role::text AS role FROM scf.platform_operators WHERE user_id = $1 AND revoked_at IS NULL`,
      [n.userId],
    );
    const kind: SessionKind = op ? "operator" : "tenant_user";
    const now = Date.now();
    const absolute = n.absoluteExpiresAt ?? new Date(now + TIMEOUTS[kind].absolute);
    const idle = new Date(Math.min(now + TIMEOUTS[kind].idle, absolute.getTime()));
    const token = newOpaqueToken();
    await tx.query(
      `INSERT INTO scf.auth_sessions (session_hash, user_id, kind, first_factor, passkey_verified_at, step_up_at,
                                      reauthenticated_at, reauth_method, created_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        sha256(token),
        n.userId,
        kind,
        n.firstFactor,
        n.passkeyVerifiedAt ?? null,
        n.stepUpAt ?? null,
        n.reauthenticatedAt ?? new Date(now),
        n.reauthMethod,
        n.createdAt ?? new Date(now),
        idle,
        absolute,
      ],
    );
    const row = await tx.one<SessionRow>(SELECT_SESSION, [sha256(token)]);
    return { token, session: fromRow(row) };
  }

  /** Revokes `old` (reason `rotated`) and issues a new cookie carrying the given changes (C-20: rotate on step-up). */
  async rotate(
    tx: Tx,
    old: Session,
    changes: Partial<NewSession>,
  ): Promise<{ token: string; session: Session }> {
    await this.revoke(tx, old.hash, "rotated");
    return this.create(tx, {
      userId: old.userId,
      firstFactor: old.firstFactor,
      reauthMethod: changes.reauthMethod ?? old.reauthMethod,
      passkeyVerifiedAt:
        changes.passkeyVerifiedAt !== undefined ? changes.passkeyVerifiedAt : old.passkeyVerifiedAt,
      stepUpAt: changes.stepUpAt !== undefined ? changes.stepUpAt : old.stepUpAt,
      reauthenticatedAt: changes.reauthenticatedAt ?? old.reauthenticatedAt,
      absoluteExpiresAt: old.absoluteExpiresAt,
      createdAt: old.createdAt,
    });
  }

  /**
   * Revokes every live session of a user. The operator-grant path (`operatorGrant`, and any future grant path) MUST
   * call this in the granting transaction (C-114); `lookup` also ends a member session of a user who has become an
   * operator, so a grant made directly in the database (bootstrap seeds, runbook SQL) takes effect at the next request.
   */
  async revokeAllForUser(tx: Tx, userId: string, reason: RevokeReason): Promise<number> {
    const rows = await tx.query(
      `UPDATE scf.auth_sessions SET revoked_at = now(), revoke_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL RETURNING 1`,
      [userId, reason],
    );
    return rows.length;
  }

  /** True when this process has signed the session out (its revocation may still be pending in the database). */
  isDenied(hash: Buffer): boolean {
    const until = this.#denied.get(hash.toString("hex"));
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.#denied.delete(hash.toString("hex"));
    return false;
  }

  /**
   * Sign-out, fail-closed (C-20). The session is refused by this process at once, then its revocation is committed in a
   * transaction of its own — before, and independent of, the audit row, which waits on the platform audit chain. If the
   * revocation cannot be written (no connection, timeout) the session stays refused here and the revocation is retried
   * in the background until it is written or the session expires. The audit row `auth.signed_out` follows the
   * revocation; its failure never undoes the sign-out. Returns whether the revocation is committed.
   *
   * `userId` null: the cookie could not be resolved (database unreachable during the lookup); the hash is revoked as
   * presented — whoever holds that cookie can only end that session — and no audit row is written for it.
   */
  async signOut(
    hash: Buffer,
    who: { userId: string | null; absoluteExpiresAt?: Date | null },
    requestId: string,
  ): Promise<boolean> {
    const key = hash.toString("hex");
    const until = who.absoluteExpiresAt?.getTime() ?? Date.now() + TIMEOUTS.tenant_user.absolute;
    this.#deny(key, until);
    const done = await this.#revokeLogout(hash, requestId);
    if (done) {
      this.#denied.delete(key);
      if (who.userId) await this.#auditSignedOut(who.userId, requestId);
    } else {
      this.#retry(hash, until, who.userId, 0);
    }
    return done;
  }

  #deny(key: string, until: number): void {
    if (this.#denied.size >= MAX_DENIED) {
      const now = Date.now();
      for (const [k, u] of this.#denied) if (u <= now) this.#denied.delete(k);
      // Still full: the oldest entry goes (a Map iterates in insertion order); its revocation is still being retried.
      if (this.#denied.size >= MAX_DENIED) {
        const first = this.#denied.keys().next().value;
        if (first !== undefined) this.#denied.delete(first);
      }
    }
    this.#denied.set(key, until);
  }

  async #revokeLogout(hash: Buffer, requestId: string): Promise<boolean> {
    try {
      await this.#db.tx(
        { tenantId: null, actorKind: "anonymous", actorId: null, requestId },
        (tx) => this.revoke(tx, hash, "logout"),
      );
      return true;
    } catch (err) {
      this.#onError?.("revoke_failed", err);
      return false;
    }
  }

  async #auditSignedOut(userId: string, requestId: string): Promise<void> {
    try {
      await this.#db.tx({ tenantId: null, actorKind: "user", actorId: userId, requestId }, (tx) =>
        tx.audit({ action: "auth.signed_out", targetType: "user", targetId: userId }),
      );
    } catch (err) {
      this.#onError?.("audit_failed", err);
    }
  }

  #retry(hash: Buffer, until: number, userId: string | null, attempt: number): void {
    if (Date.now() >= until) return;
    const delay = REVOKE_RETRY_MS[Math.min(attempt, REVOKE_RETRY_MS.length - 1)] as number;
    const timer = setTimeout(() => {
      void (async () => {
        const requestId = randomUUID();
        if (await this.#revokeLogout(hash, requestId)) {
          this.#denied.delete(hash.toString("hex"));
          if (userId) await this.#auditSignedOut(userId, requestId);
        } else {
          this.#retry(hash, until, userId, attempt + 1);
        }
      })();
    }, delay);
    timer.unref();
  }

  async revoke(tx: Tx, hash: Buffer, reason: RevokeReason): Promise<void> {
    await tx.query(
      `UPDATE scf.auth_sessions SET revoked_at = now(), revoke_reason = $2 WHERE session_hash = $1 AND revoked_at IS NULL`,
      [hash, reason],
    );
  }
}

/** `Set-Cookie` for the session (C-20): `__Host-` prefix, Secure, HttpOnly, SameSite=Lax, Path=/. */
export function sessionCookie(token: string, s: Session): string {
  const maxAge = Math.max(0, Math.floor((s.absoluteExpiresAt.getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Parses a Cookie header into a map; tolerant of malformed parts. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}
