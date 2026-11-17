// SPDX-License-Identifier: Apache-2.0
// Passkeys as an added factor: SCF operators complete sign-in and step up with a passkey (C-09); a member with a
// passkey re-authenticates only with it (C-87); operators keep two passkeys (C-20).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/auth/sessions.ts";
import { buildHandler } from "../../src/http/pipeline.ts";
import { RateLimiter } from "../../src/http/ratelimit.ts";
import { createServer } from "../../src/http/server.ts";
import { SoftAuthenticator } from "../support/authenticator.ts";
import {
  ageSession,
  call,
  createTenant,
  type Harness,
  newGithubUser,
  PLATFORM_CHAIN,
  PORTAL,
  sessionCookieOf,
  signInGithub,
  startHarness,
  tokenOf,
  verifyAuditChain,
} from "../support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

async function registerPasskey(cookie: string, auth: SoftAuthenticator, label?: string) {
  const opts = await call(h, {
    method: "POST",
    url: "/v1/auth/passkeys/registration/options",
    cookie,
  });
  expect(opts.statusCode).toBe(200);
  const body = { ...auth.register(opts.json()), ...(label ? { label } : {}) };
  return call(h, { method: "POST", url: "/v1/auth/passkeys/registration/verify", cookie, body });
}

async function assertPasskey(cookie: string, auth: SoftAuthenticator) {
  const opts = await call(h, {
    method: "POST",
    url: "/v1/auth/passkeys/assertion/options",
    cookie,
  });
  expect(opts.statusCode).toBe(200);
  return call(h, {
    method: "POST",
    url: "/v1/auth/passkeys/assertion/verify",
    cookie,
    body: auth.assert(opts.json()),
  });
}

async function makeOperator(
  role: "operator" | "operator_admin",
): Promise<{ cookie: string; user: ReturnType<typeof newGithubUser> }> {
  const user = newGithubUser();
  const cookie = await signInGithub(h, user);
  const id = (await call(h, { method: "GET", url: "/v1/me", cookie })).json().user_id;
  await h.su.query(`INSERT INTO scf.platform_operators (user_id, role) VALUES ($1, $2)`, [
    id,
    role,
  ]);
  return { cookie: await signInGithub(h, user), user };
}

describe("passkeys for members", () => {
  it("registers a passkey (201, audited), lists it, and the assertion makes recent authentication valid", async () => {
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    const auth = new SoftAuthenticator("portal.test", PORTAL);
    const reg = await registerPasskey(cookie, auth, "laptop");
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({
      credential_id: auth.id,
      label: "laptop",
      backup_eligible: false,
    });
    const list = await call(h, { method: "GET", url: "/v1/me/passkeys", cookie });
    expect(list.json().map((p: { credential_id: string }) => p.credential_id)).toEqual([auth.id]);

    // With a passkey, a GitHub sign-in no longer counts as recent authentication (C-87).
    const s1 = (await call(h, { method: "GET", url: "/v1/auth/session", cookie })).json();
    expect(s1.recent_auth_valid_until).toBeNull();
    const again = await signInGithub(h, user, cookie);
    expect(
      (await call(h, { method: "GET", url: "/v1/auth/session", cookie: again })).json()
        .recent_auth_valid_until,
    ).toBeNull();
    const del = await call(h, {
      method: "DELETE",
      url: `/v1/me/passkeys/${auth.id}`,
      cookie: again,
    });
    expect(del.json().code).toBe("recent_auth_required");

    const asserted = await assertPasskey(again, auth);
    expect(asserted.statusCode).toBe(200);
    const fresh = sessionCookieOf(asserted);
    expect(fresh).not.toBe(again);
    expect(new Date(asserted.json().recent_auth_valid_until).getTime()).toBeGreaterThan(
      Date.now() + 9 * 60_000,
    );
    expect(
      (await call(h, { method: "DELETE", url: `/v1/me/passkeys/${auth.id}`, cookie: fresh }))
        .statusCode,
    ).toBe(204);
    expect(
      (await call(h, { method: "GET", url: "/v1/me/passkeys", cookie: fresh })).json(),
    ).toEqual([]);
  });

  it("rejects a replayed assertion, a wrong origin and an unknown credential", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const auth = new SoftAuthenticator("portal.test", PORTAL);
    await registerPasskey(cookie, auth);
    const opts = (
      await call(h, { method: "POST", url: "/v1/auth/passkeys/assertion/options", cookie })
    ).json();
    const response = auth.assert(opts);
    const ok = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/assertion/verify",
      cookie,
      body: response,
    });
    const c2 = sessionCookieOf(ok);
    const replay = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/assertion/verify",
      cookie: c2,
      body: response,
    });
    expect(replay.statusCode).toBe(400); // the challenge was single use

    const evil = new SoftAuthenticator("portal.test", "https://evil.test");
    const opts2 = (
      await call(h, { method: "POST", url: "/v1/auth/passkeys/assertion/options", cookie: c2 })
    ).json();
    const forged = { ...evil.assert(opts2), id: auth.id, rawId: auth.id };
    expect(
      (
        await call(h, {
          method: "POST",
          url: "/v1/auth/passkeys/assertion/verify",
          cookie: c2,
          body: forged,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("SCF operators (C-09, C-20)", () => {
  it("get a partial session after GitHub; only passkey steps are allowed until the assertion", async () => {
    const { cookie } = await makeOperator("operator_admin");
    const s = (await call(h, { method: "GET", url: "/v1/auth/session", cookie })).json();
    expect(s).toMatchObject({
      kind: "operator",
      complete: false,
      platform_role: "operator_admin",
      passkey_verified: false,
    });
    const me = await call(h, { method: "GET", url: "/v1/me", cookie });
    expect(me.statusCode).toBe(401);
    expect(me.json().detail).toBe("passkey assertion required to complete sign-in");
    expect(
      (await call(h, { method: "GET", url: "/v1/operator/settings", cookie })).statusCode,
    ).toBe(401);

    // First passkey enrolment is allowed while the operator has none.
    const a1 = new SoftAuthenticator("portal.test", PORTAL);
    expect((await registerPasskey(cookie, a1)).statusCode).toBe(201);
    // A second one now needs a complete session.
    const a2 = new SoftAuthenticator("portal.test", PORTAL);
    const blocked = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      cookie,
    });
    expect(blocked.statusCode).toBe(401);

    const done = await assertPasskey(cookie, a1);
    expect(done.json()).toMatchObject({ complete: true, passkey_verified: true });
    expect(new Date(done.json().step_up_valid_until).getTime()).toBeGreaterThan(
      Date.now() + 9 * 60_000,
    );
    const full = sessionCookieOf(done);
    expect((await registerPasskey(full, a2)).statusCode).toBe(201);
    expect(
      (await call(h, { method: "GET", url: "/v1/me", cookie: full })).json().platform_role,
    ).toBe("operator_admin");

    // Step-up operations pass authorisation.
    const mode = await call(h, {
      method: "PUT",
      url: "/v1/operator/settings/enrollment-mode",
      cookie: full,
      body: { enrollment_mode: "open" },
    });
    expect(mode.statusCode).toBe(200);
    // Operators keep at least two passkeys (C-20).
    const del = await call(h, { method: "DELETE", url: `/v1/me/passkeys/${a1.id}`, cookie: full });
    expect(del.statusCode).toBe(409);

    // A stale step-up is refused with step_up_required.
    await h.su.query(
      `UPDATE scf.auth_sessions SET step_up_at = now() - interval '11 minutes' WHERE session_hash = sha256(convert_to($1,'UTF8'))`,
      [full.split("=")[1]],
    );
    const stale = await call(h, {
      method: "PUT",
      url: "/v1/operator/settings/enrollment-mode",
      cookie: full,
      body: { enrollment_mode: "open" },
    });
    expect(stale.json().code).toBe("step_up_required");
    const actions = await h.su.query(
      `SELECT action FROM scf.audit_log WHERE chain_id = $1 AND actor_id = $2 ORDER BY seq`,
      [PLATFORM_CHAIN, s.user_id],
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      "auth.signed_in",
      "auth.signed_in",
      "auth.passkey_added",
      "auth.step_up",
      "auth.passkey_added",
      "settings.updated",
    ]);
    expect(await verifyAuditChain(h, PLATFORM_CHAIN)).toBeGreaterThan(5);
  });

  it("platform roles gate the operator routes: member → 403, operator on an operator_admin route → 403", async () => {
    const member = await signInGithub(h, newGithubUser());
    expect(
      (await call(h, { method: "GET", url: "/v1/operator/settings", cookie: member })).json().code,
    ).toBe("forbidden");
    const { cookie } = await makeOperator("operator");
    const a = new SoftAuthenticator("portal.test", PORTAL);
    await registerPasskey(cookie, a);
    const full = sessionCookieOf(await assertPasskey(cookie, a));
    // C-20: one passkey is not enough for operator operations
    expect(
      (await call(h, { method: "GET", url: "/v1/operator/settings", cookie: full })).json().detail,
    ).toBe("register a second passkey before using operator operations (C-20)");
    expect(
      (await registerPasskey(full, new SoftAuthenticator("portal.test", PORTAL))).statusCode,
    ).toBeLessThan(300);
    expect(
      (await call(h, { method: "GET", url: "/v1/operator/settings", cookie: full })).statusCode,
    ).toBe(200);
    const admin = await call(h, {
      method: "PUT",
      url: "/v1/operator/settings/enrollment-mode",
      cookie: full,
      body: { enrollment_mode: "open" },
    });
    expect(admin.json().code).toBe("forbidden");
    // Tenant routes never grant access by platform role (C-87): an operator is a stranger to other tenants.
    const t = await createTenant(h, member);
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${t}`, cookie: full })).statusCode,
    ).toBe(404);
  });
});

describe("G1 review fixes (C-114)", () => {
  async function userId(cookie: string): Promise<string> {
    return (await call(h, { method: "GET", url: "/v1/auth/session", cookie })).json().user_id;
  }

  it("registering a passkey needs recent authentication", async () => {
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    await ageSession(h, cookie, 11);
    const opts = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      cookie,
    });
    expect(opts.statusCode).toBe(403);
    expect(opts.json().code).toBe("recent_auth_required");

    // Options fetched while fresh, verification after the window: refused as well.
    const fresh = await signInGithub(h, user, cookie);
    const auth = new SoftAuthenticator("portal.test", PORTAL);
    const o2 = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      cookie: fresh,
    });
    expect(o2.statusCode).toBe(200);
    await ageSession(h, fresh, 11);
    const v2 = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/verify",
      cookie: fresh,
      body: auth.register(o2.json()),
    });
    expect(v2.statusCode).toBe(403);
    expect(v2.json().code).toBe("recent_auth_required");
    expect(
      (await call(h, { method: "GET", url: "/v1/me/passkeys", cookie: fresh })).json(),
    ).toEqual([]);
  });

  it("a member with a passkey adds another only after a passkey assertion", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const a1 = new SoftAuthenticator("portal.test", PORTAL);
    expect((await registerPasskey(cookie, a1)).statusCode).toBe(201);
    const a2 = new SoftAuthenticator("portal.test", PORTAL);
    const blocked = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      cookie,
    });
    expect(blocked.json().code).toBe("recent_auth_required");
    const asserted = sessionCookieOf(await assertPasskey(cookie, a1));
    expect((await registerPasskey(asserted, a2)).statusCode).toBe(201);
  });

  it("an operator's first passkey from a partial session only within 10 minutes of the first factor", async () => {
    const { cookie } = await makeOperator("operator");
    await ageSession(h, cookie, 11);
    const late = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      cookie,
    });
    expect(late.statusCode).toBe(403);
    expect(late.json().code).toBe("recent_auth_required");
  });

  it("an operator adds a passkey only with a valid step-up", async () => {
    const { cookie } = await makeOperator("operator");
    const a1 = new SoftAuthenticator("portal.test", PORTAL);
    expect((await registerPasskey(cookie, a1)).statusCode).toBe(201);
    const full = sessionCookieOf(await assertPasskey(cookie, a1));
    await ageSession(h, full, 11);
    const stale = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      cookie: full,
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe("step_up_required");
  });

  it("identity linking is refused from a partial operator session", async () => {
    const { cookie } = await makeOperator("operator");
    const res = await call(h, { method: "GET", url: "/v1/auth/github/start?link=true", cookie });
    expect(res.statusCode).toBe(401);
  });

  it("a member promoted to operator loses the passkey-less session at once", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const id = await userId(cookie);
    expect((await call(h, { method: "GET", url: "/v1/me", cookie })).statusCode).toBe(200);
    await h.su.query(
      `INSERT INTO scf.platform_operators (user_id, role) VALUES ($1, 'operator_admin')`,
      [id],
    );
    const me = await call(h, { method: "GET", url: "/v1/me", cookie });
    expect(me.statusCode).toBe(401);
    const row = await h.su.query(
      `SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM scf.auth_sessions WHERE session_hash = sha256(convert_to($1,'UTF8'))`,
      [tokenOf(cookie)],
    );
    expect(row.rows[0]).toEqual({ revoked: true, revoke_reason: "operator_revoked" });
  });

  it("revokeAllForUser ends every live session of the user (the operator-grant path calls it)", async () => {
    const user = newGithubUser();
    const c1 = await signInGithub(h, user);
    const c2 = await signInGithub(h, user);
    const id = await userId(c1);
    const store = new SessionStore(h.db);
    const n = await h.db.tx(
      { tenantId: null, actorKind: "system", actorId: "test", requestId: "t" },
      (tx) => store.revokeAllForUser(tx, id, "operator_revoked"),
    );
    expect(n).toBe(2);
    for (const c of [c1, c2])
      expect((await call(h, { method: "GET", url: "/v1/me", cookie: c })).statusCode).toBe(401);
  });

  it("operator operations run their transaction with the platform role and the step-up time", async () => {
    const { cookie } = await makeOperator("operator_admin");
    const a = new SoftAuthenticator("portal.test", PORTAL);
    await registerPasskey(cookie, a);
    const full = sessionCookieOf(await assertPasskey(cookie, a));
    await registerPasskey(full, new SoftAuthenticator("portal.test", PORTAL)); // C-20: two passkeys
    const app = createServer({
      logLevel: "silent",
      problemBase: "https://portal.test/problems/",
      bodyLimit: 1024,
      trustProxy: false,
    });
    const sessions = new SessionStore(h.db);
    const op = h.openapi.get("operatorGetSettings");
    app.get(
      "/probe",
      buildHandler(
        op,
        async (ctx) => ({
          status: 200,
          body: await ctx.tx((tx) =>
            tx.one(
              `SELECT scf.actor_kind() AS actor_kind, scf.platform_role() AS platform_role,
                      NULLIF(current_setting('app.step_up_at', true), '') IS NOT NULL AS has_step_up`,
            ),
          ),
        }),
        { db: h.db, sessions, limiter: new RateLimiter(), portalOrigin: PORTAL },
      ),
    );
    const res = await app.inject({ method: "GET", url: "/probe", headers: { cookie: full } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      actor_kind: "operator",
      platform_role: "operator_admin",
      has_step_up: true,
    });
    await app.close();
  });
});
