// SPDX-License-Identifier: Apache-2.0
// Tenants, memberships and invitations (ADR-0015, C-08, C-19, C-64, C-87, data-model §8.3). Every statement runs under
// the tenant's own context; repositories add an explicit `tenant_id = $1` filter on top of RLS (double filter, §4.1).

import type { Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { newInvitationCode, sha256, uuidv7 } from "../util/ids.ts";

interface TenantRow extends Record<string, unknown> {
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  status_reason: string | null;
  removal_reason_code: string | null;
  level: number;
  created_at: Date;
  removed_at: Date | null;
  purge_after: Date | null;
  onchain_correlation_enabled: boolean;
  public_stats_enabled: boolean;
  seal_enabled: boolean;
  footprint_none_declared: boolean;
  footprint_status: "missing" | "none_declared" | "claimed" | "verified";
}

export async function settingInts(
  tx: Tx,
  keys: readonly string[],
): Promise<Record<string, number>> {
  const rows = await tx.query<{ key: string; v: number }>(
    `SELECT key, (value #>> '{}')::int AS v FROM scf.settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.v]));
}

/**
 * The enrolment step's state (C-135, C-136): `verified` when at least one footprint item (contract or other kind) is
 * verified, `claimed` when items are declared but none is verified yet, else `none_declared` when the tenant declared
 * that it has none, else `missing`. Removed items never count; rejected ones count as not declared.
 */
const FOOTPRINT_STATUS_SQL = `CASE
    WHEN EXISTS (SELECT 1 FROM scf.declared_contracts c
                  WHERE c.tenant_id = t.tenant_id AND c.removed_at IS NULL AND c.status = 'verified')
      OR EXISTS (SELECT 1 FROM scf.footprint_items f
                  WHERE f.tenant_id = t.tenant_id AND f.removed_at IS NULL AND f.status = 'verified') THEN 'verified'
    WHEN EXISTS (SELECT 1 FROM scf.declared_contracts c
                  WHERE c.tenant_id = t.tenant_id AND c.removed_at IS NULL AND c.status = 'declared')
      OR EXISTS (SELECT 1 FROM scf.footprint_items f
                  WHERE f.tenant_id = t.tenant_id AND f.removed_at IS NULL AND f.status = 'claimed') THEN 'claimed'
    WHEN t.footprint_none_declared THEN 'none_declared'
    ELSE 'missing' END`;

export async function tenantView(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
  const t = await tx.maybeOne<TenantRow>(
    `SELECT tenant_id, slug, name, description, status::text AS status, status_reason, removal_reason_code,
            scf.verification_level(tenant_id) AS level,
            created_at, removed_at, purge_after, onchain_correlation_enabled, public_stats_enabled, seal_enabled,
            footprint_none_declared, ${FOOTPRINT_STATUS_SQL} AS footprint_status
       FROM scf.tenants t WHERE tenant_id = $1 AND purged_at IS NULL`,
    [tenantId],
  );
  if (!t) throw new ApiError("not_found");
  const s = await settingInts(tx, [
    "l0_max_sites",
    "l0_max_services",
    "l0_events_per_day",
    "l0_routes_per_day",
    "l1_events_per_day",
    "max_services_per_tenant",
  ]);
  const level = Number(t.level);
  const quotas =
    level === 0
      ? {
          max_sites: s.l0_max_sites,
          max_services: s.l0_max_services,
          web_events_per_day: s.l0_events_per_day,
          routes_per_day: s.l0_routes_per_day,
        }
      : { max_services: s.max_services_per_tenant, web_events_per_day: s.l1_events_per_day };
  return {
    tenant_id: t.tenant_id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    status: t.status,
    status_reason: t.status_reason,
    // K1 (0087): the operator's fixed removal reason, read by members on their next sign-in (no e-mail, ADR-0014)
    removal_reason_code: t.removal_reason_code,
    verification_level: `L${level}`,
    created_at: t.created_at.toISOString(),
    removed_at: t.removed_at?.toISOString() ?? null,
    purge_after: t.purge_after?.toISOString() ?? null,
    onchain_correlation_enabled: t.onchain_correlation_enabled,
    public_stats_enabled: t.public_stats_enabled,
    seal_enabled: t.seal_enabled,
    footprint_none_declared: t.footprint_none_declared,
    footprint_status: t.footprint_status,
    quotas: Object.fromEntries(Object.entries(quotas).filter(([, v]) => typeof v === "number")),
  };
}

function requireUser(ctx: RequestContext) {
  if (!ctx.session) throw new ApiError("unauthenticated");
  return ctx.session;
}

export function tenantHandlers() {
  const createTenant: Handler = async (ctx) => {
    const s = requireUser(ctx);
    const b = ctx.body as { slug: string; name: string; description?: string };
    const tenantId = uuidv7();
    const body = await ctx.tx(
      async (tx) => {
        // C-64: tombstoned identities cannot enroll again.
        const blocked = await tx.maybeOne(
          `SELECT 1 FROM scf.external_identities i
            WHERE i.user_id = $1
              AND scf.is_tombstoned(CASE i.provider WHEN 'github' THEN 'github_user' ELSE 'stellar_account' END, i.subject)
            LIMIT 1`,
          [s.userId],
        );
        if (blocked) throw new ApiError("forbidden", "this account cannot create tenants");
        // One creation per user at a time, so concurrent requests cannot all pass the quota below (C-19);
        // the count is a new statement after the lock and sees every tenant a concurrent creation committed.
        await tx.query(
          `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scf-tenant-create:' || $1::text, 0))`,
          [s.userId],
        );
        const owned = await tx.one<{ n: number; max: number }>(
          `SELECT (SELECT count(*)::int FROM scf.memberships m JOIN scf.tenants t ON t.tenant_id = m.tenant_id
                    WHERE m.user_id = $1 AND m.role = 'owner' AND t.status <> 'removed') AS n,
                  scf.setting_int('max_tenants_per_user') AS max`,
          [s.userId],
        );
        if (owned.n >= owned.max)
          throw new ApiError("quota_exceeded", "tenant limit per user reached");
        // Slug uniqueness is global and invisible under RLS: a duplicate fails the INSERT (23505), which the HTTP layer
        // answers with a generic 409 (no constraint names, no existence detail).
        await tx.query(
          `INSERT INTO scf.tenants (tenant_id, slug, name, description, status, created_by)
           VALUES ($1, $2, $3, $4,
                   (CASE WHEN (SELECT value FROM scf.settings WHERE key = 'enrollment_mode') = '"open"'::jsonb
                         THEN 'active' ELSE 'pending' END)::scf.tenant_status, $5)`,
          [tenantId, b.slug, b.name, b.description ?? null, s.userId],
        );
        await tx.query(
          `INSERT INTO scf.memberships (tenant_id, user_id, role, added_by) VALUES ($1, $2, 'owner', $2)`,
          [tenantId, s.userId],
        );
        await tx.audit({
          action: "tenant.created",
          targetType: "tenant",
          targetId: tenantId,
          details: { slug: b.slug },
        });
        await tx.notify("scf_edge");
        await tx.notify("scf_umami");
        return tenantView(tx, tenantId);
      },
      { tenantId },
    );
    return { status: 201, body };
  };

  const getTenant: Handler = async (ctx) => ({
    status: 200,
    body: await ctx.tx((tx) => tenantView(tx, ctx.params.tenantId as string)),
  });

  const updateTenant: Handler = async (ctx) => {
    const b = ctx.body as {
      name?: string;
      description?: string | null;
      onchain_correlation_enabled?: boolean;
      public_stats_enabled?: boolean;
      seal_enabled?: boolean;
      footprint_none_declared?: boolean;
    };
    const tenantId = ctx.params.tenantId as string;
    const body = await ctx.tx(async (tx) => {
      await tx.query(
        `UPDATE scf.tenants
            SET name = COALESCE($2, name),
                description = CASE WHEN $3 THEN $4 ELSE description END,
                onchain_correlation_enabled = COALESCE($5, onchain_correlation_enabled),
                public_stats_enabled = COALESCE($6, public_stats_enabled),
                seal_enabled = COALESCE($7, seal_enabled),
                footprint_none_declared = COALESCE($8, footprint_none_declared)
          WHERE tenant_id = $1`,
        [
          tenantId,
          b.name ?? null,
          "description" in b,
          b.description ?? null,
          b.onchain_correlation_enabled ?? null,
          b.public_stats_enabled ?? null,
          b.seal_enabled ?? null,
          b.footprint_none_declared ?? null,
        ],
      );
      await tx.audit({
        action: "tenant.updated",
        targetType: "tenant",
        targetId: tenantId,
        details: { fields: Object.keys(b).sort() },
      });
      return tenantView(tx, tenantId);
    });
    return { status: 200, body };
  };

  const removeOwnTenant: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const body = await ctx.tx(async (tx) => {
      // The status before the removal goes into the audit row (`from`, like op_tenant_transition), so the operator
      // overview can tell the tenant's status at the start of the month (0087, K1).
      const before = await tx.maybeOne<{ status: string }>(
        `SELECT status::text AS status FROM scf.tenants WHERE tenant_id = $1`,
        [tenantId],
      );
      // tenants_guard checks owner + fresh sign-in again in the database (C-87) and sets purge_after (+30 days, C-08).
      await tx.query(
        `UPDATE scf.tenants SET status = 'removed', status_reason = $2 WHERE tenant_id = $1`,
        [tenantId, (ctx.body as { reason: string }).reason],
      );
      // C-64 (migration 0057): the same enrollment tombstones as an operator removal — verified hosts, the owners'
      // GitHub ids, valid Stellar accounts — written by the definer function in this transaction, after the UPDATE.
      const { n } = await tx.one<{ n: number }>(`SELECT scf.write_removal_tombstones($1) AS n`, [
        tenantId,
      ]);
      await tx.audit({
        action: "tenant.removed",
        targetType: "tenant",
        targetId: tenantId,
        details: { by: "owner", tombstones: n, from: before?.status ?? null },
      });
      await tx.notify("scf_edge");
      return tenantView(tx, tenantId);
    });
    return { status: 200, body };
  };

  const transferOwnership: Handler = async (ctx) => {
    const s = requireUser(ctx);
    const tenantId = ctx.params.tenantId as string;
    const target = (ctx.body as { new_owner_user_id: string }).new_owner_user_id;
    const body = await ctx.tx(async (tx) => {
      const member = await tx.maybeOne<{ role: string }>(
        `SELECT role::text AS role FROM scf.memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [tenantId, target],
      );
      if (!member) throw new ApiError("not_found");
      if (target === s.userId) throw new ApiError("conflict", "already the owner");
      // One owner at a time (unique partial index): demote first, then promote. Both rows pass the
      // memberships_owner_reauth trigger, which re-checks the fresh sign-in (C-87).
      await tx.query(
        `UPDATE scf.memberships SET role = 'admin' WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, s.userId],
      );
      await tx.query(
        `UPDATE scf.memberships SET role = 'owner' WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, target],
      );
      await tx.audit({
        action: "member.ownership_transferred",
        targetType: "user",
        targetId: target,
        details: { previous_owner: s.userId, previous_role: member.role },
      });
      return tenantView(tx, tenantId);
    });
    return { status: 200, body };
  };

  const listMembers: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) =>
      tx.query<{ user_id: string; display_name: string | null; role: string; added_at: Date }>(
        `SELECT m.user_id, u.display_name, m.role::text AS role, m.added_at
           FROM scf.memberships m JOIN scf.users u ON u.user_id = m.user_id
          WHERE m.tenant_id = $1 ORDER BY m.added_at, m.user_id`,
        [ctx.params.tenantId],
      ),
    );
    return { status: 200, body: rows.map((r) => ({ ...r, added_at: r.added_at.toISOString() })) };
  };

  const updateMember: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const userId = ctx.params.userId as string;
    const role = (ctx.body as { role: "admin" | "member" | "viewer" }).role;
    const row = await ctx.tx(async (tx) => {
      const cur = await tx.maybeOne<{ role: string }>(
        `SELECT role::text AS role FROM scf.memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [tenantId, userId],
      );
      if (!cur) throw new ApiError("not_found");
      if (cur.role === "owner")
        throw new ApiError("forbidden", "use ownership transfer to change the owner");
      const r = await tx.one<{
        user_id: string;
        display_name: string | null;
        role: string;
        added_at: Date;
      }>(
        `UPDATE scf.memberships m SET role = $3 FROM scf.users u
          WHERE m.tenant_id = $1 AND m.user_id = $2 AND u.user_id = m.user_id
          RETURNING m.user_id, u.display_name, m.role::text AS role, m.added_at`,
        [tenantId, userId, role],
      );
      await tx.audit({
        action: "member.role_changed",
        targetType: "user",
        targetId: userId,
        details: { from: cur.role, to: role },
      });
      return r;
    });
    return { status: 200, body: { ...row, added_at: row.added_at.toISOString() } };
  };

  const removeMember: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const userId = ctx.params.userId as string;
    await ctx.tx(async (tx) => {
      const cur = await tx.maybeOne<{ role: string }>(
        `SELECT role::text AS role FROM scf.memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [tenantId, userId],
      );
      if (!cur) throw new ApiError("not_found");
      if (cur.role === "owner") throw new ApiError("conflict", "the owner cannot be removed");
      await tx.query(`DELETE FROM scf.memberships WHERE tenant_id = $1 AND user_id = $2`, [
        tenantId,
        userId,
      ]);
      await tx.audit({
        action: "member.removed",
        targetType: "user",
        targetId: userId,
        details: { role: cur.role },
      });
    });
    return { status: 204 };
  };

  const invitationView = (r: {
    invitation_id: string;
    role: string;
    note: string | null;
    created_at: Date;
    expires_at: Date;
  }) => ({
    invitation_id: r.invitation_id,
    role: r.role,
    note: r.note,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
  });

  const listInvitations: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) =>
      tx.query<{
        invitation_id: string;
        role: string;
        note: string | null;
        created_at: Date;
        expires_at: Date;
      }>(
        `SELECT invitation_id, role::text AS role, note, created_at, expires_at FROM scf.tenant_invitations
          WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          ORDER BY created_at, invitation_id`,
        [ctx.params.tenantId],
      ),
    );
    return { status: 200, body: rows.map(invitationView) };
  };

  const createInvitation: Handler = async (ctx) => {
    const s = requireUser(ctx);
    const b = ctx.body as {
      role: "admin" | "member" | "viewer";
      note?: string;
      expires_in_hours?: number;
    };
    const code = newInvitationCode();
    const row = await ctx.tx(async (tx) => {
      const r = await tx.one<{
        invitation_id: string;
        role: string;
        note: string | null;
        created_at: Date;
        expires_at: Date;
      }>(
        `INSERT INTO scf.tenant_invitations (tenant_id, role, code_hash, note, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
         RETURNING invitation_id, role::text AS role, note, created_at, expires_at`,
        [
          ctx.params.tenantId,
          b.role,
          sha256(code),
          b.note ?? null,
          s.userId,
          b.expires_in_hours ?? 72,
        ],
      );
      await tx.audit({
        action: "invitation.created",
        targetType: "invitation",
        targetId: r.invitation_id,
        details: { role: b.role },
      });
      return r;
    });
    return { status: 201, body: { ...invitationView(row), code } };
  };

  const revokeInvitation: Handler = async (ctx) => {
    await ctx.tx(async (tx) => {
      const r = await tx.maybeOne(
        `UPDATE scf.tenant_invitations SET revoked_at = now()
          WHERE tenant_id = $1 AND invitation_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING invitation_id`,
        [ctx.params.tenantId, ctx.params.invitationId],
      );
      if (!r) throw new ApiError("not_found");
      await tx.audit({
        action: "invitation.revoked",
        targetType: "invitation",
        targetId: ctx.params.invitationId as string,
      });
    });
    return { status: 204 };
  };

  const acceptInvitation: Handler = async (ctx) => {
    const s = requireUser(ctx);
    const code = (ctx.body as { code: string }).code;
    const body = await ctx.tx(
      async (tx) => {
        // The invitee is not a member yet, so the lookup runs in the definer function (data-model §12).
        const r = await tx.one<{ tenant_id: string | null }>(
          `SELECT scf.accept_invitation($1, $2) AS tenant_id`,
          [sha256(code), s.userId],
        );
        if (!r.tenant_id) throw new ApiError("not_found");
        await tx.switchContext({ tenantId: r.tenant_id });
        const m = await tx.one<{
          tenant_id: string;
          slug: string;
          name: string;
          status: string;
          role: string;
        }>(
          `SELECT t.tenant_id, t.slug, t.name, t.status::text AS status, m.role::text AS role
             FROM scf.memberships m JOIN scf.tenants t ON t.tenant_id = m.tenant_id
            WHERE m.tenant_id = $1 AND m.user_id = $2`,
          [r.tenant_id, s.userId],
        );
        await tx.audit({
          action: "invitation.accepted",
          targetType: "user",
          targetId: s.userId,
          details: { role: m.role },
        });
        return m;
      },
      { tenantId: null },
    );
    return { status: 200, body };
  };

  return {
    createTenant,
    getTenant,
    updateTenant,
    removeOwnTenant,
    transferOwnership,
    listMembers,
    updateMember,
    removeMember,
    listInvitations,
    createInvitation,
    revokeInvitation,
    acceptInvitation,
  };
}
