// SPDX-License-Identifier: Apache-2.0
// What happens after a first factor (GitHub or Stellar) succeeded: find or create the user, refuse tombstoned
// identities on sign-up (C-64), then either re-authenticate the current session (same user: C-87 fresh sign-in, unless
// the user has a passkey) or start a new session (rotated cookie). SCF operators get a partial session until their
// passkey assertion (C-09).

import type { Tx } from "../db/database.ts";
import { ApiError } from "../http/problem.ts";
import { cpMetrics } from "../obs/metrics.ts";
import { uuidv7 } from "../util/ids.ts";
import type { FirstFactor, Session, SessionStore } from "./sessions.ts";

export interface VerifiedIdentity {
  provider: "github" | "stellar";
  /** GitHub numeric id or the member's own G-account. */
  subject: string;
  /** GitHub login; null for Stellar. */
  handle: string | null;
  /** GitHub account creation time (abuse heuristics); null for Stellar. */
  providerCreatedAt: Date | null;
  displayName: string;
}

export interface SignInOutcome {
  userId: string;
  token: string;
  session: Session;
  action: "auth.signed_in" | "auth.reauthenticated";
}

const TOMBSTONE_KIND = { github: "github_user", stellar: "stellar_account" } as const;

/**
 * Resolves the identity to a user inside `tx` (whose context must be global). Creates the user on first sign-in.
 * Returns the user id; throws `validation_failed` when a new sign-up is blocked by a tombstone.
 */
export async function resolveUser(
  tx: Tx,
  id: VerifiedIdentity,
): Promise<{ userId: string; created: boolean }> {
  const existing = await tx.maybeOne<{
    user_id: string;
    identity_id: string;
    disabled: boolean;
    deleted: boolean;
  }>(
    `SELECT i.user_id, i.identity_id, u.disabled_at IS NOT NULL AS disabled, u.deleted_at IS NOT NULL AS deleted
       FROM scf.external_identities i JOIN scf.users u ON u.user_id = i.user_id
      WHERE i.provider = $1 AND i.subject = $2`,
    [id.provider, id.subject],
  );
  // The identity belongs to an account that may not sign in: say so (403), never fall through to a sign-up that would
  // collide with the existing identity (a 409 that explains nothing).
  if (existing?.disabled) throw new ApiError("forbidden", "this account is disabled");
  if (existing?.deleted) throw new ApiError("forbidden", "this account has been deleted");
  if (existing) {
    await tx.query(
      `UPDATE scf.external_identities SET last_used_at = now(), display_handle = COALESCE($2, display_handle)
        WHERE identity_id = $1`,
      [existing.identity_id, id.handle],
    );
    return { userId: existing.user_id, created: false };
  }
  const blocked = await tx.one<{ t: boolean }>(`SELECT scf.is_tombstoned($1, $2) AS t`, [
    TOMBSTONE_KIND[id.provider],
    id.subject,
  ]);
  if (blocked.t) throw new ApiError("validation_failed", "this identity cannot sign up");
  const userId = uuidv7();
  await tx.query(`INSERT INTO scf.users (user_id, display_name) VALUES ($1, $2)`, [
    userId,
    id.displayName,
  ]);
  await tx.query(
    `INSERT INTO scf.external_identities (user_id, provider, subject, display_handle, provider_created_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [userId, id.provider, id.subject, id.handle, id.providerCreatedAt],
  );
  cpMetrics.signup();
  return { userId, created: true };
}

/** Completes a first-factor sign-in in `tx`; the caller sets the returned cookie. */
export async function completeSignIn(
  tx: Tx,
  sessions: SessionStore,
  userId: string,
  factor: FirstFactor,
  current: Session | null,
  details: Record<string, unknown>,
): Promise<SignInOutcome> {
  await tx.switchContext({ actorKind: "user", actorId: userId });
  if (current && current.userId === userId) {
    // Same account while signed in: a fresh sign-in for x-requires-recent-auth (C-87) — unless the member has a
    // passkey, in which case only a passkey assertion counts (the session still rotates).
    const counts = current.passkeyCount === 0;
    const { token, session } = await sessions.rotate(
      tx,
      current,
      counts ? { reauthenticatedAt: new Date(), reauthMethod: factor } : {},
    );
    await tx.audit({
      action: "auth.reauthenticated",
      targetType: "user",
      targetId: userId,
      details: { method: factor, counts },
    });
    return { userId, token, session, action: "auth.reauthenticated" };
  }
  if (current) await sessions.revoke(tx, current.hash, "rotated");
  const { token, session } = await sessions.create(tx, {
    userId,
    firstFactor: factor,
    reauthMethod: factor,
  });
  await tx.audit({
    action: "auth.signed_in",
    targetType: "user",
    targetId: userId,
    details: { method: factor, kind: session.kind, ...details },
  });
  return { userId, token, session, action: "auth.signed_in" };
}
