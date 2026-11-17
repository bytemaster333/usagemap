// SPDX-License-Identifier: Apache-2.0
// Tenants, memberships, invitations (ADR-0015, C-08, C-19, C-64, C-87): roles, foreign ids → 404, fresh sign-in for
// sensitive actions, audit rows in the tenant's chain, enrollment mode.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
  uniqueSlug,
  verifyAuditChain,
} from "../support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

async function auditActions(tenantId: string): Promise<string[]> {
  const r = await h.su.query<{ action: string }>(
    `SELECT action FROM scf.audit_log WHERE chain_id = $1 ORDER BY seq`,
    [tenantId],
  );
  return r.rows.map((x) => x.action);
}

/** Ages the session's last sign-in so x-requires-recent-auth fails (as 11 minutes later). */
async function ageSignIn(cookie: string): Promise<void> {
  await h.su.query(
    `UPDATE scf.auth_sessions SET reauthenticated_at = now() - interval '11 minutes'
      WHERE session_hash = sha256(convert_to($1, 'UTF8'))`,
    [cookie.split("=")[1]],
  );
}

describe("tenant lifecycle", () => {
  it("creates an active L0 tenant in open mode with the creator as owner, audited in the tenant chain", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const slug = uniqueSlug();
    const res = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie,
      body: { slug, name: "Proj", description: "d" },
    });
    expect(res.statusCode).toBe(201);
    const t = res.json();
    expect(t).toMatchObject({
      slug,
      name: "Proj",
      status: "active",
      verification_level: "L0",
      public_stats_enabled: false,
    });
    expect(t.quotas).toEqual({
      max_sites: 2,
      max_services: 1,
      web_events_per_day: 50000,
      routes_per_day: 100,
    });
    const mine = await call(h, { method: "GET", url: "/v1/me/tenants", cookie });
    expect(mine.json()).toEqual([
      { tenant_id: t.tenant_id, slug, name: "Proj", status: "active", role: "owner" },
    ]);
    expect(await auditActions(t.tenant_id)).toEqual(["tenant.created"]);
  });

  it("refuses a duplicate slug with a generic 409 and an extra field with 400", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const slug = uniqueSlug();
    await createTenant(h, cookie, slug);
    const other = await signInGithub(h, newGithubUser());
    const dup = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie: other,
      body: { slug, name: "x" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).not.toMatch(/tenants_slug|constraint|duplicate key/i);
    const extra = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie,
      body: { slug: uniqueSlug(), name: "x", tenant_id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().errors[0].pointer).toBe("/tenant_id");
  });

  it("limits tenants per user (max_tenants_per_user = 3)", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    for (let i = 0; i < 3; i++) await createTenant(h, cookie);
    const fourth = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie,
      body: { slug: uniqueSlug(), name: "x" },
    });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe("quota_exceeded");
  });

  it("creates pending tenants in approval_required mode (C-08)", async () => {
    await h.su.query(
      `UPDATE scf.settings SET value = '"approval_required"' WHERE key = 'enrollment_mode'`,
    );
    try {
      const cookie = await signInGithub(h, newGithubUser());
      const res = await call(h, {
        method: "POST",
        url: "/v1/tenants",
        cookie,
        body: { slug: uniqueSlug(), name: "x" },
      });
      expect(res.json().status).toBe("pending");
    } finally {
      await h.su.query(`UPDATE scf.settings SET value = '"open"' WHERE key = 'enrollment_mode'`);
    }
  });

  it("refuses tenant creation for a tombstoned GitHub identity (C-64)", async () => {
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    const tenantId = await createTenant(h, cookie);
    await h.su.query(
      `INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id, reason) VALUES ('github_user', $1, $2, 'test')`,
      [String(user.id), tenantId],
    );
    const res = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie,
      body: { slug: uniqueSlug(), name: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("updates settings as admin+, audits field names only", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const id = await createTenant(h, cookie);
    const res = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${id}`,
      cookie,
      body: { name: "Renamed", description: null, public_stats_enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: "Renamed",
      description: null,
      public_stats_enabled: true,
    });
    const d = await h.su.query(
      `SELECT details FROM scf.audit_log WHERE chain_id = $1 AND action = 'tenant.updated'`,
      [id],
    );
    expect(d.rows[0].details).toEqual({ fields: ["description", "name", "public_stats_enabled"] });
  });

  it("removal by the owner needs a fresh sign-in (C-87), then hides writes and sets purge_after +30 d", async () => {
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    const id = await createTenant(h, cookie);
    await ageSignIn(cookie);
    const stale = await call(h, {
      method: "POST",
      url: `/v1/tenants/${id}/removal`,
      cookie,
      body: { reason: "done" },
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe("recent_auth_required");
    const fresh = await signInGithub(h, user, cookie);
    const ok = await call(h, {
      method: "POST",
      url: `/v1/tenants/${id}/removal`,
      cookie: fresh,
      body: { reason: "done" },
    });
    expect(ok.statusCode).toBe(200);
    const t = ok.json();
    expect(t.status).toBe("removed");
    const days =
      (new Date(t.purge_after).getTime() - new Date(t.removed_at).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 3);
    const write = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${id}`,
      cookie: fresh,
      body: { name: "x" },
    });
    expect(write.statusCode).toBe(403);
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${id}`, cookie: fresh })).json().status,
    ).toBe("removed");
    expect(await auditActions(id)).toEqual(["tenant.created", "tenant.removed"]);
    // C-64 (migration 0057): owner self-removal leaves the owner's GitHub tombstone in the same transaction, and the
    // audit row records how many tombstones were written.
    const tomb = await h.su.query<{ kind: string; subject: string; reason: string }>(
      `SELECT kind, subject, reason FROM scf.enrollment_tombstones WHERE tenant_id = $1`,
      [id],
    );
    expect(tomb.rows).toEqual([{ kind: "github_user", subject: String(user.id), reason: "done" }]);
    const det = await h.su.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM scf.audit_log WHERE chain_id = $1 AND action = 'tenant.removed'`,
      [id],
    );
    expect(det.rows[0]?.details).toEqual({ by: "owner", tombstones: 1, from: "active" });
    // the same identity cannot enrol a new tenant afterwards
    const again = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie: fresh,
      body: { slug: uniqueSlug(), name: "x" },
    });
    expect(again.statusCode).toBe(403);
  });
});

describe("members and invitations", () => {
  it("invites (code shown once, stored hashed), accepts, lists, changes roles and enforces role order", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const id = await createTenant(h, owner);
    const inv = await call(h, {
      method: "POST",
      url: `/v1/tenants/${id}/invitations`,
      cookie: owner,
      body: { role: "viewer", note: "hello", expires_in_hours: 24 },
    });
    expect(inv.statusCode).toBe(201);
    const { code, invitation_id } = inv.json();
    expect(code).toMatch(/^scfi_[0-9A-Za-z]{22}$/);
    const stored = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.tenant_invitations WHERE code_hash = sha256(convert_to($1,'UTF8'))`,
      [code],
    );
    expect(stored.rows[0].n).toBe(1);
    const list = await call(h, {
      method: "GET",
      url: `/v1/tenants/${id}/invitations`,
      cookie: owner,
    });
    expect(list.json().map((i: { invitation_id: string }) => i.invitation_id)).toEqual([
      invitation_id,
    ]);

    const viewerUser = newGithubUser();
    const viewer = await signInGithub(h, viewerUser);
    const acc = await call(h, {
      method: "POST",
      url: "/v1/invitations/accept",
      cookie: viewer,
      body: { code },
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ tenant_id: id, role: "viewer" });
    const again = await call(h, {
      method: "POST",
      url: "/v1/invitations/accept",
      cookie: viewer,
      body: { code },
    });
    expect(again.statusCode).toBe(404);

    // A viewer reads but cannot administer.
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${id}`, cookie: viewer })).statusCode,
    ).toBe(200);
    const forbidden = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${id}`,
      cookie: viewer,
      body: { name: "x" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("forbidden");
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${id}/invitations`, cookie: viewer }))
        .statusCode,
    ).toBe(403);

    const members = (
      await call(h, { method: "GET", url: `/v1/tenants/${id}/members`, cookie: viewer })
    ).json();
    expect(members.map((m: { role: string }) => m.role).sort()).toEqual(["owner", "viewer"]);
    const viewerId = members.find((m: { role: string }) => m.role === "viewer").user_id;
    const ownerId = members.find((m: { role: string }) => m.role === "owner").user_id;

    const promote = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${id}/members/${viewerId}`,
      cookie: owner,
      body: { role: "admin" },
    });
    expect(promote.json()).toMatchObject({ user_id: viewerId, role: "admin" });
    // An admin cannot change or remove the owner.
    const admin = viewer;
    expect(
      (
        await call(h, {
          method: "PATCH",
          url: `/v1/tenants/${id}/members/${ownerId}`,
          cookie: admin,
          body: { role: "viewer" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/tenants/${id}/members/${ownerId}`,
          cookie: admin,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call(h, {
          method: "PATCH",
          url: `/v1/tenants/${id}/members/${viewerId}`,
          cookie: owner,
          body: { role: "owner" },
        })
      ).statusCode,
    ).toBe(400);

    const actions = await auditActions(id);
    expect(actions).toEqual([
      "tenant.created",
      "invitation.created",
      "invitation.accepted",
      "member.role_changed",
    ]);
    expect(await verifyAuditChain(h, id)).toBe(4);
  });

  it("revokes invitations; a revoked or foreign code is 404", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const id = await createTenant(h, owner);
    const inv = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${id}/invitations`,
        cookie: owner,
        body: { role: "member" },
      })
    ).json();
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/tenants/${id}/invitations/${inv.invitation_id}`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/tenants/${id}/invitations/${inv.invitation_id}`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(404);
    const u = await signInGithub(h, newGithubUser());
    expect(
      (
        await call(h, {
          method: "POST",
          url: "/v1/invitations/accept",
          cookie: u,
          body: { code: inv.code },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("transfers ownership only with a fresh sign-in and only to a member of this tenant (C-87)", async () => {
    const ownerUser = newGithubUser();
    let owner = await signInGithub(h, ownerUser);
    const id = await createTenant(h, owner);
    const other = await createTenant(h, await signInGithub(h, newGithubUser()));
    const inv = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${id}/invitations`,
        cookie: owner,
        body: { role: "member" },
      })
    ).json();
    const memberCookie = await signInGithub(h, newGithubUser());
    await call(h, {
      method: "POST",
      url: "/v1/invitations/accept",
      cookie: memberCookie,
      body: { code: inv.code },
    });
    const memberId = (await call(h, { method: "GET", url: "/v1/me", cookie: memberCookie })).json()
      .user_id;
    const outsiderId = (
      await call(h, { method: "GET", url: `/v1/tenants/${other}/members`, cookie: memberCookie })
    ).statusCode;
    expect(outsiderId).toBe(404); // not a member of the other tenant

    await ageSignIn(owner);
    const stale = await call(h, {
      method: "POST",
      url: `/v1/tenants/${id}/ownership-transfer`,
      cookie: owner,
      body: { new_owner_user_id: memberId },
    });
    expect(stale.json().code).toBe("recent_auth_required");
    owner = await signInGithub(h, ownerUser, owner);
    const unknown = await call(h, {
      method: "POST",
      url: `/v1/tenants/${id}/ownership-transfer`,
      cookie: owner,
      body: { new_owner_user_id: "0193b7e2-0000-7000-8000-00000000000a" },
    });
    expect(unknown.statusCode).toBe(404);
    const ok = await call(h, {
      method: "POST",
      url: `/v1/tenants/${id}/ownership-transfer`,
      cookie: owner,
      body: { new_owner_user_id: memberId },
    });
    expect(ok.statusCode).toBe(200);
    const roles = (
      await call(h, { method: "GET", url: `/v1/tenants/${id}/members`, cookie: owner })
    ).json();
    expect(
      Object.fromEntries(roles.map((m: { user_id: string; role: string }) => [m.user_id, m.role]))[
        memberId
      ],
    ).toBe("owner");
    // The former owner is now admin: owner-only operations are forbidden.
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/tenants/${id}/removal`,
          cookie: owner,
          body: { reason: "x" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("account deletion is refused while owning a tenant and works otherwise (C-57, C-87)", async () => {
    const owner = await signInGithub(h, newGithubUser());
    await createTenant(h, owner);
    expect((await call(h, { method: "DELETE", url: "/v1/me", cookie: owner })).statusCode).toBe(
      409,
    );
    const plain = await signInGithub(h, newGithubUser());
    const userId = (await call(h, { method: "GET", url: "/v1/me", cookie: plain })).json().user_id;
    expect((await call(h, { method: "DELETE", url: "/v1/me", cookie: plain })).statusCode).toBe(
      204,
    );
    const row = await h.su.query(
      `SELECT display_name, deleted_at FROM scf.users WHERE user_id = $1`,
      [userId],
    );
    expect(row.rows[0].display_name).toBeNull();
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect((await call(h, { method: "GET", url: "/v1/me", cookie: plain })).statusCode).toBe(401);
  });

  it("the last identity cannot be unlinked", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const ids = (await call(h, { method: "GET", url: "/v1/me/identities", cookie })).json();
    const res = await call(h, {
      method: "DELETE",
      url: `/v1/me/identities/${ids[0].identity_id}`,
      cookie,
    });
    expect(res.statusCode).toBe(409);
  });
});
