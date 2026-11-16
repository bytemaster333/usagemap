// SPDX-License-Identifier: Apache-2.0
// The signed-in user's own account: session, sign-out, profile, identities, passkeys, memberships, deletion (C-57).

import { passkeyView } from "../auth/passkeys.ts";
import { clearCookie, SESSION_COOKIE, type SessionStore, sessionView } from "../auth/sessions.ts";
import type { Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";

function me(ctx: RequestContext) {
  if (!ctx.session) throw new ApiError("unauthenticated");
  return ctx.session;
}

async function meView(tx: Tx, userId: string): Promise<Record<string, unknown>> {
  const r = await tx.one<{
    user_id: string;
    display_name: string;
    contact_email: string | null;
    created_at: Date;
    platform_role: string | null;
    passkey_count: number;
  }>(
    `SELECT u.user_id, u.display_name, u.contact_email, u.created_at,
            (SELECT o.role::text FROM scf.platform_operators o WHERE o.user_id = u.user_id AND o.revoked_at IS NULL) AS platform_role,
            (SELECT count(*)::int FROM scf.passkey_credentials p WHERE p.user_id = u.user_id AND p.revoked_at IS NULL) AS passkey_count
       FROM scf.users u WHERE u.user_id = $1`,
    [userId],
  );
  return {
    user_id: r.user_id,
    display_name: r.display_name,
    contact_email: r.contact_email,
    created_at: r.created_at.toISOString(),
    platform_role: r.platform_role,
    passkey_count: r.passkey_count,
  };
}

/**
 * The answer to a sign-out whose revocation could not be written yet: 503 with Retry-After, and the cookie is cleared all
 * the same. The session is already refused by this process and its revocation is being retried.
 */
export function signOutPending(headers: Record<string, string>): ApiError {
  return new ApiError(
    "unavailable",
    "signed out; the database could not confirm it yet and the revocation is being retried",
    { retryAfter: 5, headers },
  );
}

export function accountHandlers(deps: { sessions: SessionStore }) {
  const authGetSession: Handler = async (ctx) => ({ status: 200, body: sessionView(me(ctx)) });

  // Fail-closed (C-20): the session is refused at once, its revocation is committed before (and apart from) the audit
  // row, and the cookie is cleared whatever happens. If the revocation cannot be written now it is retried in the
  // background and the answer is 503 — still clearing the cookie (SessionStore.signOut).
  const authLogout: Handler = async (ctx) => {
    const s = me(ctx);
    const clear = { "set-cookie": clearCookie(SESSION_COOKIE) };
    const committed = await deps.sessions.signOut(
      s.hash,
      { userId: s.userId, absoluteExpiresAt: s.absoluteExpiresAt },
      ctx.requestId,
    );
    if (!committed) throw signOutPending(clear);
    return { status: 204, headers: clear };
  };

  const getMe: Handler = async (ctx) => ({
    status: 200,
    body: await ctx.tx((tx) => meView(tx, me(ctx).userId)),
  });

  const updateMe: Handler = async (ctx) => {
    const s = me(ctx);
    const b = ctx.body as { display_name?: string; contact_email?: string | null };
    const body = await ctx.tx(async (tx) => {
      await tx.query(
        `UPDATE scf.users SET display_name = COALESCE($2, display_name),
                              contact_email = CASE WHEN $3 THEN $4 ELSE contact_email END
          WHERE user_id = $1`,
        [s.userId, b.display_name ?? null, "contact_email" in b, b.contact_email ?? null],
      );
      // Field names only: profile values are personal data and never go into the audit log.
      await tx.audit({
        action: "account.updated",
        targetType: "user",
        targetId: s.userId,
        details: { fields: Object.keys(b).sort() },
      });
      return meView(tx, s.userId);
    });
    return { status: 200, body };
  };

  const deleteMe: Handler = async (ctx) => {
    const s = me(ctx);
    // operator.global-view-credentials / C-20: an SCF operator's grant must be revoked by an operator_admin first (audited, and never the last
    // operator_admin, operatorRevoke); a deleted account must not stay counted as a platform operator.
    if (s.platformRole)
      throw new ApiError(
        "conflict",
        "an SCF operator's role must be revoked by an operator_admin before the account is deleted",
      );
    await ctx.tx(async (tx) => {
      const owns = await tx.maybeOne(
        `SELECT 1 FROM scf.memberships WHERE user_id = $1 AND role = 'owner'`,
        [s.userId],
      );
      if (owns) throw new ApiError("conflict", "transfer or remove the tenants you own first");
      // Leave every tenant: a membership row is deleted only under its tenant's context (F1, C-103).
      const memberOf = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM scf.memberships WHERE user_id = $1`,
        [s.userId],
      );
      for (const m of memberOf) {
        await tx.switchContext({ tenantId: m.tenant_id });
        await tx.query(`DELETE FROM scf.memberships WHERE tenant_id = $1 AND user_id = $2`, [
          m.tenant_id,
          s.userId,
        ]);
        await tx.audit({
          action: "member.removed",
          targetType: "user",
          targetId: s.userId,
          details: { reason: "account_deleted" },
        });
      }
      await tx.switchContext({ tenantId: null });
      await tx.query(`DELETE FROM scf.external_identities WHERE user_id = $1`, [s.userId]);
      await tx.query(`DELETE FROM scf.passkey_credentials WHERE user_id = $1`, [s.userId]);
      await tx.query(
        `UPDATE scf.auth_sessions SET revoked_at = now(), revoke_reason = 'account_deleted' WHERE user_id = $1 AND revoked_at IS NULL`,
        [s.userId],
      );
      // C-57 tombstone: the id stays (audit chains remain valid), the profile is cleared. The trigger
      // users_delete_reauth re-checks the fresh sign-in in the database (C-87).
      await tx.query(
        `UPDATE scf.users SET display_name = NULL, contact_email = NULL, deleted_at = now() WHERE user_id = $1`,
        [s.userId],
      );
      await tx.audit({ action: "account.deleted", targetType: "user", targetId: s.userId });
    });
    return { status: 204, headers: { "set-cookie": clearCookie(SESSION_COOKIE) } };
  };

  const listMyTenants: Handler = async (ctx) => {
    const s = me(ctx);
    const rows = await ctx.tx((tx) =>
      tx.query<{ tenant_id: string; slug: string; name: string; status: string; role: string }>(
        `SELECT t.tenant_id, t.slug, t.name, t.status::text AS status, m.role::text AS role
           FROM scf.memberships m JOIN scf.tenants t ON t.tenant_id = m.tenant_id
          WHERE m.user_id = $1 AND t.purged_at IS NULL ORDER BY t.name, t.tenant_id`,
        [s.userId],
      ),
    );
    return { status: 200, body: rows };
  };

  const listMyIdentities: Handler = async (ctx) => {
    const s = me(ctx);
    const rows = await ctx.tx((tx) =>
      tx.query<{
        identity_id: string;
        provider: "github" | "stellar";
        subject: string;
        display_handle: string | null;
        created_at: Date;
        last_used_at: Date | null;
      }>(
        `SELECT identity_id, provider::text AS provider, subject, display_handle, created_at, last_used_at
           FROM scf.external_identities WHERE user_id = $1 ORDER BY created_at`,
        [s.userId],
      ),
    );
    return {
      status: 200,
      body: rows.map((r) => ({
        identity_id: r.identity_id,
        provider: r.provider,
        display: r.provider === "github" ? (r.display_handle ?? r.subject) : r.subject,
        created_at: r.created_at.toISOString(),
        last_used_at: r.last_used_at?.toISOString() ?? null,
      })),
    };
  };

  const unlinkIdentity: Handler = async (ctx) => {
    const s = me(ctx);
    await ctx.tx(async (tx) => {
      const rows = await tx.query<{ identity_id: string; provider: string }>(
        `SELECT identity_id, provider::text AS provider FROM scf.external_identities WHERE user_id = $1 FOR UPDATE`,
        [s.userId],
      );
      const target = rows.find((r) => r.identity_id === ctx.params.identityId);
      if (!target) throw new ApiError("not_found");
      if (rows.length <= 1)
        throw new ApiError("conflict", "the last sign-in identity cannot be unlinked");
      await tx.query(
        `DELETE FROM scf.external_identities WHERE identity_id = $1 AND user_id = $2`,
        [target.identity_id, s.userId],
      );
      await tx.audit({
        action: "auth.identity_unlinked",
        targetType: "user",
        targetId: s.userId,
        details: { provider: target.provider },
      });
    });
    return { status: 204 };
  };

  const listMyPasskeys: Handler = async (ctx) => {
    const s = me(ctx);
    const rows = await ctx.tx((tx) =>
      tx.query<{
        credential_id: Buffer;
        label: string | null;
        created_at: Date;
        last_used_at: Date | null;
        backup_eligible: boolean;
      }>(
        `SELECT credential_id, label, created_at, last_used_at, backup_eligible FROM scf.passkey_credentials
          WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
        [s.userId],
      ),
    );
    return { status: 200, body: rows.map(passkeyView) };
  };

  const deletePasskey: Handler = async (ctx) => {
    const s = me(ctx);
    const id = Buffer.from(ctx.params.credentialId ?? "", "base64url");
    await ctx.tx(async (tx) => {
      const rows = await tx.query<{ credential_id: Buffer }>(
        `SELECT credential_id FROM scf.passkey_credentials WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE`,
        [s.userId],
      );
      if (!rows.some((r) => r.credential_id.equals(id))) throw new ApiError("not_found");
      // C-20: SCF operators keep at least two passkeys.
      if (s.platformRole && rows.length <= 2)
        throw new ApiError("conflict", "SCF operators keep at least two passkeys");
      await tx.query(
        `UPDATE scf.passkey_credentials SET revoked_at = now() WHERE credential_id = $1 AND user_id = $2`,
        [id, s.userId],
      );
      await tx.audit({ action: "auth.passkey_removed", targetType: "user", targetId: s.userId });
    });
    return { status: 204 };
  };

  return {
    authGetSession,
    authLogout,
    getMe,
    updateMe,
    deleteMe,
    listMyTenants,
    listMyIdentities,
    unlinkIdentity,
    listMyPasskeys,
    deletePasskey,
  };
}
