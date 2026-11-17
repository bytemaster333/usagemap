// SPDX-License-Identifier: Apache-2.0
// Sign-in by GitHub (OAuth code flow + PKCE) and by Stellar SEP-53 signature; sessions, CSRF, logout (ADR-0014, C-20,
// C-87), against the real database through PgBouncer.

import { Keypair, WebAuth } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageSession,
  call,
  type Harness,
  newGithubUser,
  PLATFORM_CHAIN,
  PORTAL,
  sessionCookieOf,
  signInGithub,
  signSep10,
  startHarness,
  stellarKey,
  verifyAuditChain,
} from "../support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("GitHub sign-in", () => {
  it("redirects to GitHub with read:user, PKCE S256 and a state bound to a __Host- cookie", async () => {
    const res = await call(h, { method: "GET", url: "/v1/auth/github/start?return_to=/x" });
    expect(res.statusCode).toBe(302);
    const loc = new URL(String(res.headers.location));
    expect(loc.searchParams.get("client_id")).toBe("gh-client");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${PORTAL}/v1/auth/github/callback`);
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = String(([] as string[]).concat(res.headers["set-cookie"] ?? [])[0]);
    expect(cookie).toMatch(
      /^__Host-scf_oauth=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
  });

  it("signs a new user in, sets the session cookie and audits auth.signed_in", async () => {
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    expect(cookie).toMatch(/^__Host-scf_session=[A-Za-z0-9_-]{43}$/);
    const s = await call(h, { method: "GET", url: "/v1/auth/session", cookie });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({
      kind: "tenant_user",
      first_factor: "github",
      complete: true,
      platform_role: null,
    });
    const me = await call(h, { method: "GET", url: "/v1/me", cookie });
    expect(me.json()).toMatchObject({
      display_name: user.login,
      passkey_count: 0,
      platform_role: null,
    });
    const ids = await call(h, { method: "GET", url: "/v1/me/identities", cookie });
    expect(ids.json()).toEqual([
      expect.objectContaining({ provider: "github", display: user.login }),
    ]);
    // The GitHub access token is used once and never stored (the fake saw the PKCE verifier, not a client secret leak).
    const stored = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.auth_challenges WHERE payload::text LIKE '%gho_%'`,
    );
    expect(stored.rows[0].n).toBe(0);
    const audit = await h.su.query(
      `SELECT action, actor_kind FROM scf.audit_log WHERE chain_id = $1 AND actor_id = $2 ORDER BY seq`,
      [PLATFORM_CHAIN, s.json().user_id],
    );
    expect(audit.rows).toEqual([{ action: "auth.signed_in", actor_kind: "user" }]);
  });

  it("the same GitHub account signs in to the same user; the session row stores only a hash", async () => {
    const user = newGithubUser();
    const a = await signInGithub(h, user);
    const b = await signInGithub(h, user);
    const ua = (await call(h, { method: "GET", url: "/v1/me", cookie: a })).json().user_id;
    const ub = (await call(h, { method: "GET", url: "/v1/me", cookie: b })).json().user_id;
    expect(ua).toBe(ub);
    const token = a.split("=")[1] as string;
    const raw = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.auth_sessions WHERE encode(session_hash, 'base64') LIKE $1`,
      [`%${token.slice(0, 20)}%`],
    );
    expect(raw.rows[0].n).toBe(0);
  });

  it("refuses a replayed state, a missing binder cookie and a wrong PKCE verifier", async () => {
    const start = await call(h, { method: "GET", url: "/v1/auth/github/start" });
    const oauth = String(([] as string[]).concat(start.headers["set-cookie"] ?? [])[0]).split(
      ";",
    )[0];
    const { code, state } = h.github.approve(String(start.headers.location), newGithubUser());
    const noCookie = await call(h, {
      method: "GET",
      url: `/v1/auth/github/callback?code=${code}&state=${state}`,
    });
    expect(noCookie.statusCode).toBe(400);
    // The state was consumed by that attempt: even with the right cookie it is gone now.
    const replay = await call(h, {
      method: "GET",
      url: `/v1/auth/github/callback?code=${code}&state=${state}`,
      cookie: oauth,
    });
    expect(replay.statusCode).toBe(400);

    const s2 = await call(h, { method: "GET", url: "/v1/auth/github/start" });
    const oauth2 = String(([] as string[]).concat(s2.headers["set-cookie"] ?? [])[0]).split(";")[0];
    const loc = new URL(String(s2.headers.location));
    loc.searchParams.set("code_challenge", "A".repeat(43)); // an authorisation bound to another verifier
    const forged = h.github.approve(loc.toString(), newGithubUser());
    const bad = await call(h, {
      method: "GET",
      url: `/v1/auth/github/callback?code=${forged.code}&state=${forged.state}`,
      cookie: oauth2,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("signing in again as the same user while signed in counts as a fresh sign-in (C-87) and rotates the cookie", async () => {
    const user = newGithubUser();
    const a = await signInGithub(h, user);
    await h.su.query(
      `UPDATE scf.auth_sessions SET reauthenticated_at = now() - interval '1 hour', created_at = now() - interval '1 hour'
        WHERE session_hash = sha256(convert_to($1, 'UTF8'))`,
      [a.split("=")[1]],
    );
    const stale = (await call(h, { method: "GET", url: "/v1/auth/session", cookie: a })).json();
    expect(new Date(stale.recent_auth_valid_until).getTime()).toBeLessThan(Date.now());
    const b = await signInGithub(h, user, a);
    expect(b).not.toBe(a);
    const fresh = (await call(h, { method: "GET", url: "/v1/auth/session", cookie: b })).json();
    expect(new Date(fresh.recent_auth_valid_until).getTime()).toBeGreaterThan(
      Date.now() + 9 * 60_000,
    );
    expect((await call(h, { method: "GET", url: "/v1/auth/session", cookie: a })).statusCode).toBe(
      401,
    );
  });

  it("logs out (204, cookie cleared, session revoked) and needs CSRF headers to do so", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const noCsrf = await call(h, { method: "POST", url: "/v1/auth/logout", cookie, noCsrf: true });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe("csrf_failed");
    const wrongOrigin = await call(h, {
      method: "POST",
      url: "/v1/auth/logout",
      cookie,
      headers: { origin: "https://evil.test", "x-scf-request": "1" },
    });
    expect(wrongOrigin.json().code).toBe("csrf_failed");
    const out = await call(h, { method: "POST", url: "/v1/auth/logout", cookie });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toContain(
      "__Host-scf_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    expect((await call(h, { method: "GET", url: "/v1/me", cookie })).statusCode).toBe(401);
  });

  it("answers 401 without a session and for garbage cookies", async () => {
    expect((await call(h, { method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    expect(
      (await call(h, { method: "GET", url: "/v1/me", cookie: "__Host-scf_session=nope" }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await call(h, {
          method: "GET",
          url: "/v1/me",
          cookie: `__Host-scf_session=${"A".repeat(43)}`,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("Stellar SEP-53 sign-in", () => {
  it("issues a challenge and signs in with a valid signature", async () => {
    const key = stellarKey();
    const ch = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/challenge",
      body: { account: key.account },
    });
    expect(ch.statusCode).toBe(201);
    const { challenge_id, message } = ch.json();
    expect(message).toContain(key.account);
    expect(message).toContain("portal.test wants you to sign in");
    const v = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: { challenge_id, signature: key.signMessage(message) },
    });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ first_factor: "stellar_sep53", complete: true });
    const cookie = sessionCookieOf(v);
    const ids = await call(h, { method: "GET", url: "/v1/me/identities", cookie });
    expect(ids.json()).toEqual([
      expect.objectContaining({ provider: "stellar", display: key.account }),
    ]);
  });

  it("rejects a wrong signature, a replay and a key below the medium threshold", async () => {
    const key = stellarKey();
    const other = stellarKey();
    const ch = (
      await call(h, {
        method: "POST",
        url: "/v1/auth/stellar/challenge",
        body: { account: key.account },
      })
    ).json();
    const wrong = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: { challenge_id: ch.challenge_id, signature: other.signMessage(ch.message) },
    });
    expect(wrong.statusCode).toBe(401);
    const replay = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: { challenge_id: ch.challenge_id, signature: key.signMessage(ch.message) },
    });
    expect(replay.statusCode).toBe(401); // single use: consumed by the failed attempt

    h.horizon.accounts.set(key.account, { weight: 1, mediumThreshold: 2 });
    const ch2 = (
      await call(h, {
        method: "POST",
        url: "/v1/auth/stellar/challenge",
        body: { account: key.account },
      })
    ).json();
    const low = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: { challenge_id: ch2.challenge_id, signature: key.signMessage(ch2.message) },
    });
    expect(low.statusCode).toBe(401);
  });

  it("validates the account", async () => {
    const bad = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/challenge",
      body: { account: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHG" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("SEP-10: a server-signed challenge transaction, signed to the medium threshold (multisig), single-use (C-19)", async () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const challenge = async (account: string) => {
      const r = await call(h, {
        method: "POST",
        url: "/v1/auth/stellar/challenge",
        body: { account, method: "sep10" },
      });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({
        method: "sep10",
        network_passphrase: "Public Global Stellar Network ; September 2015",
      });
      return r.json() as {
        challenge_id: string;
        transaction_xdr: string;
        network_passphrase: string;
      };
    };
    const verify = (c: { challenge_id: string }, signed: string) =>
      call(h, {
        method: "POST",
        url: "/v1/auth/stellar/verify",
        body: { challenge_id: c.challenge_id, signed_transaction_xdr: signed },
      });
    // an account that does not exist yet: its master key alone
    const solo = await challenge(a.publicKey());
    const ok = await verify(solo, signSep10(solo.transaction_xdr, solo.network_passphrase, a));
    expect(ok.statusCode, ok.body).toBe(200);
    // replay of the same signed challenge
    expect(
      (await verify(solo, signSep10(solo.transaction_xdr, solo.network_passphrase, a))).statusCode,
    ).toBe(401);
    // multisig: medium threshold 2 needs both keys
    h.horizon.accounts.set(a.publicKey(), {
      weight: 1,
      mediumThreshold: 2,
      signers: [
        { key: a.publicKey(), weight: 1 },
        { key: b.publicKey(), weight: 1 },
      ],
    });
    const one = await challenge(a.publicKey());
    expect(
      (await verify(one, signSep10(one.transaction_xdr, one.network_passphrase, a))).statusCode,
    ).toBe(401);
    const both = await challenge(a.publicKey());
    expect(
      (await verify(both, signSep10(both.transaction_xdr, both.network_passphrase, a, b)))
        .statusCode,
    ).toBe(200);
    // a transaction we did not issue (another server key) is refused
    const forged = await challenge(a.publicKey());
    const other = WebAuth.buildChallengeTx(
      Keypair.random(),
      a.publicKey(),
      "portal.test",
      600,
      forged.network_passphrase,
      "portal.test",
    );
    expect(
      (await verify(forged, signSep10(other, forged.network_passphrase, a, b))).statusCode,
    ).toBe(401);
  });

  it("SEP-10 without a configured signing key answers 503, never 501", async () => {
    const h2 = await startHarness({ SCF_SEP10_SIGNING_SEED: "" });
    try {
      const r = await call(h2, {
        method: "POST",
        url: "/v1/auth/stellar/challenge",
        body: { account: Keypair.random().publicKey(), method: "sep10" },
      });
      expect(r.statusCode).toBe(503);
    } finally {
      await h2.close();
    }
  });
});

describe("G1 review fixes (C-114)", () => {
  it("the Stellar network is the deployment's: the client cannot choose it", async () => {
    const key = stellarKey();
    const chosen = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/challenge",
      body: { account: key.account, network: "testnet" },
    });
    expect(chosen.statusCode).toBe(400);
    const ch = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/challenge",
      body: { account: key.account },
    });
    expect(ch.statusCode).toBe(201);
    expect(ch.json().message).toContain("\nNetwork: public\n");
    const v = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: { challenge_id: ch.json().challenge_id, signature: key.signMessage(ch.json().message) },
    });
    expect(v.statusCode).toBe(200);
    expect(h.horizon.networks.get(key.account)).toBe("public");
  });

  it("a challenge issued for another network is refused after a configuration change", async () => {
    const key = stellarKey();
    const ch = (
      await call(h, {
        method: "POST",
        url: "/v1/auth/stellar/challenge",
        body: { account: key.account },
      })
    ).json();
    await h.su.query(
      `UPDATE scf.auth_challenges SET payload = jsonb_set(payload, '{network}', '"testnet"') WHERE challenge_id = $1`,
      [ch.challenge_id],
    );
    const v = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: { challenge_id: ch.challenge_id, signature: key.signMessage(ch.message) },
    });
    expect(v.statusCode).toBe(401);
  });

  it("refuses a return_to that is not a clean same-origin path", async () => {
    for (const rt of ["/%09/evil.example", "//evil.example", "/%5Cevil.example", "/a%0d%0ab"]) {
      const res = await call(h, { method: "GET", url: `/v1/auth/github/start?return_to=${rt}` });
      expect(res.statusCode, rt).toBe(400);
      expect(res.headers.location, rt).toBeUndefined();
    }
  });

  it("a disabled user signing in gets a clear 403, not a 409", async () => {
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    const id = (await call(h, { method: "GET", url: "/v1/me", cookie })).json().user_id;
    await h.su.query(`UPDATE scf.users SET disabled_at = now() WHERE user_id = $1`, [id]);
    const start = await call(h, { method: "GET", url: "/v1/auth/github/start?return_to=/x" });
    const oauth = String(([] as string[]).concat(start.headers["set-cookie"] ?? [])[0]).split(
      ";",
    )[0];
    const { code, state } = h.github.approve(String(start.headers.location), user);
    const cb = await call(h, {
      method: "GET",
      url: `/v1/auth/github/callback?code=${code}&state=${state}`,
      cookie: oauth,
    });
    expect(cb.statusCode).toBe(403);
    expect(cb.json()).toMatchObject({ code: "forbidden", detail: "this account is disabled" });
    const users = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.external_identities WHERE provider = 'github' AND subject = $1`,
      [String(user.id)],
    );
    expect(users.rows[0].n).toBe(1);

    const key = stellarKey();
    const sc = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/challenge",
      body: { account: key.account },
    });
    const sv = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: { challenge_id: sc.json().challenge_id, signature: key.signMessage(sc.json().message) },
    });
    const sid = (
      await call(h, { method: "GET", url: "/v1/me", cookie: sessionCookieOf(sv) })
    ).json().user_id;
    await h.su.query(`UPDATE scf.users SET disabled_at = now() WHERE user_id = $1`, [sid]);
    const sc2 = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/challenge",
      body: { account: key.account },
    });
    const sv2 = await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: {
        challenge_id: sc2.json().challenge_id,
        signature: key.signMessage(sc2.json().message),
      },
    });
    expect(sv2.statusCode).toBe(403);
    expect(sv2.json().code).toBe("forbidden");
  });

  it("linking an identity needs recent authentication", async () => {
    const user = newGithubUser();
    const cookie = await signInGithub(h, user);
    await ageSession(h, cookie, 11);
    const stale = await call(h, { method: "GET", url: "/v1/auth/github/start?link=true", cookie });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe("recent_auth_required");
    const noSession = await call(h, { method: "GET", url: "/v1/auth/github/start?link=true" });
    expect(noSession.statusCode).toBe(401);

    const fresh = await signInGithub(h, user, cookie); // same account again: a fresh sign-in (C-87)
    const start = await call(h, {
      method: "GET",
      url: "/v1/auth/github/start?link=true&return_to=/me",
      cookie: fresh,
    });
    expect(start.statusCode).toBe(302);
    const oauth = String(([] as string[]).concat(start.headers["set-cookie"] ?? [])[0]).split(
      ";",
    )[0];
    const second = newGithubUser();
    const { code, state } = h.github.approve(String(start.headers.location), second);
    const cb = await call(h, {
      method: "GET",
      url: `/v1/auth/github/callback?code=${code}&state=${state}`,
      cookie: `${oauth}; ${fresh}`,
    });
    expect(cb.statusCode).toBe(303);
    expect(cb.headers.location).toBe("/me");
    const ids = (await call(h, { method: "GET", url: "/v1/me/identities", cookie: fresh })).json();
    expect(ids).toHaveLength(2);
  });
});

describe("audit chain", () => {
  it("the platform chain verifies after the sign-ins above", async () => {
    expect(await verifyAuditChain(h, PLATFORM_CHAIN)).toBeGreaterThan(3);
  });
});
