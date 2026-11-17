// SPDX-License-Identifier: Apache-2.0
// Sign-out fails closed (C-20, review 2026-11-20): under load a sign-out once answered 500 and the cookie kept working.
// The session is refused at once, revoked before (and apart from) the audit row, the cookie is cleared whatever
// happens, and a database that is busy or unreachable gives problem+json 503 with Retry-After — never a bare 500.
// Against the real database through PgBouncer; database errors are forced at the statement level.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  type Harness,
  newGithubUser,
  PORTAL,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("sign-out fails closed (C-20)", () => {
  type TxFn = Harness["db"]["tx"];
  const REVOKE_SQL =
    /UPDATE scf\.auth_sessions SET revoked_at = now\(\), revoke_reason = \$2 WHERE session_hash/;

  /**
   * Makes every statement matching `sql` (and, with `audit`, every audit append) fail like a lost connection until the
   * returned restore() is called; `null` fails every transaction before it starts.
   */
  function failStatements(sql: RegExp | null, audit = false): () => void {
    const original: TxFn = h.db.tx.bind(h.db);
    h.db.tx = (async (ctx, fn) => {
      if (sql === null) throw Object.assign(new Error("connection terminated"), { code: "08006" });
      return original(ctx, async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = (async (text: string, params?: readonly unknown[]) => {
          if (sql.test(text)) throw Object.assign(new Error("forced"), { code: "08006" });
          return query(text, params);
        }) as typeof tx.query;
        if (audit)
          tx.audit = async () => {
            throw Object.assign(new Error("forced"), { code: "08006" });
          };
        return fn(tx);
      });
    }) as TxFn;
    return () => {
      h.db.tx = original;
    };
  }

  async function sessionRow(cookie: string) {
    const r = await h.su.query<{ revoked_at: Date | null; revoke_reason: string | null }>(
      `SELECT revoked_at, revoke_reason FROM scf.auth_sessions WHERE session_hash = sha256(convert_to($1, 'UTF8'))`,
      [cookie.split("=")[1]],
    );
    return r.rows[0];
  }

  async function signedOutAudits(userId: string): Promise<number> {
    const r = await h.su.query(
      `SELECT 1 FROM scf.audit_log WHERE action = 'auth.signed_out' AND target_id = $1`,
      [userId],
    );
    return r.rowCount ?? 0;
  }

  async function eventually(check: () => Promise<boolean>, ms = 8_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("condition not reached");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("a database error while revoking: 503, cookie cleared, session refused at once and revoked by the retry", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const userId = (await call(h, { method: "GET", url: "/v1/me", cookie })).json().user_id;
    const restore = failStatements(REVOKE_SQL);
    let out: Awaited<ReturnType<typeof call>>;
    try {
      out = await call(h, { method: "POST", url: "/v1/auth/logout", cookie });
      expect(out.statusCode).toBe(503);
      expect(out.headers["content-type"]).toContain("application/problem+json");
      expect(out.headers["retry-after"]).toBe("5");
      expect(out.json().code).toBe("unavailable");
      expect(String(out.headers["set-cookie"])).toContain(
        "__Host-scf_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
      );
      // Not revoked in the database yet — and still unusable.
      expect((await sessionRow(cookie))?.revoked_at).toBeNull();
      expect((await call(h, { method: "GET", url: "/v1/me", cookie })).statusCode).toBe(401);
      expect((await call(h, { method: "GET", url: "/v1/auth/session", cookie })).statusCode).toBe(
        401,
      );
    } finally {
      restore();
    }
    // The background retry writes the revocation (and then the audit row) once the database answers again.
    await eventually(async () => (await sessionRow(cookie))?.revoke_reason === "logout");
    await eventually(async () => (await signedOutAudits(userId)) === 1);
    expect((await call(h, { method: "GET", url: "/v1/me", cookie })).statusCode).toBe(401);
  });

  it("the database unreachable even for the session lookup: 503, cookie cleared, revoked once it is back", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const other = await signInGithub(h, newGithubUser());
    const restore = failStatements(null);
    try {
      const out = await call(h, { method: "POST", url: "/v1/auth/logout", cookie });
      expect(out.statusCode).toBe(503);
      expect(String(out.headers["set-cookie"])).toContain("__Host-scf_session=; Path=/");
      // Without the CSRF headers nothing is revoked (no cross-site sign-out), and the error stays a plain 503.
      const forged = await call(h, {
        method: "POST",
        url: "/v1/auth/logout",
        cookie: other,
        noCsrf: true,
      });
      expect(forged.statusCode).toBe(503);
      expect(forged.headers["set-cookie"]).toBeUndefined();
    } finally {
      restore();
    }
    expect((await call(h, { method: "GET", url: "/v1/me", cookie })).statusCode).toBe(401);
    await eventually(async () => (await sessionRow(cookie))?.revoke_reason === "logout");
    // The forged request ended nothing.
    expect((await call(h, { method: "GET", url: "/v1/me", cookie: other })).statusCode).toBe(200);
  });

  it("an audit failure never undoes the sign-out: 204 and revoked", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const userId = (await call(h, { method: "GET", url: "/v1/me", cookie })).json().user_id;
    const restore = failStatements(/^$/, true);
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { cookie, origin: PORTAL, "x-scf-request": "1" },
      });
      expect(res.statusCode).toBe(204);
      expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
    } finally {
      restore();
    }
    expect((await sessionRow(cookie))?.revoke_reason).toBe("logout");
    expect(await signedOutAudits(userId)).toBe(0);
    expect((await call(h, { method: "GET", url: "/v1/me", cookie })).statusCode).toBe(401);
  });

  it("no pooled connection within the pool wait: problem+json 503 with Retry-After, never a bare 500", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const held = await Promise.all(Array.from({ length: 4 }, () => h.db.pool.connect()));
    try {
      const res = await call(h, { method: "GET", url: "/v1/auth/session", cookie });
      expect(res.statusCode).toBe(503);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.headers["retry-after"]).toBe("5");
      expect(res.json().code).toBe("unavailable");
    } finally {
      for (const c of held) c.release();
    }
    expect((await call(h, { method: "GET", url: "/v1/auth/session", cookie })).statusCode).toBe(
      200,
    );
  }, 15_000);
});
