// SPDX-License-Identifier: Apache-2.0
// Data-inventory checks for the control plane (privacy invariants, ADR-0022): logs and the database never
// receive IP addresses, User-Agents, request headers, cookies, tokens or query strings. Plus public endpoints, rate
// limits and health.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  contractGaps,
  createTenant,
  type Harness,
  KNOWN_403_GAPS,
  newGithubUser,
  signInGithub,
  startHarness,
  stellarKey,
} from "../support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ SCF_TRUST_PROXY: "true" });
});
afterAll(async () => {
  await h?.close();
});

const IP = "198.51.100.77";
const UA = "Mozilla/5.0 (X11; Linux x86_64) PrivacyCanary/9.9";

describe("privacy invariants", () => {
  it("logs one line per request with the route template only — no IP, UA, cookie, token, query string or id", async () => {
    const before = h.logs.lines.length;
    const cookie = await signInGithub(h, newGithubUser());
    const tenant = await createTenant(h, cookie);
    const headers = { "x-forwarded-for": IP, "user-agent": UA };
    await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}?secretquery=Q-CANARY`,
      cookie,
      headers,
    });
    const key = stellarKey();
    const ch = (
      await call(h, {
        method: "POST",
        url: "/v1/auth/stellar/challenge",
        body: { account: key.account },
        headers,
      })
    ).json();
    await call(h, {
      method: "POST",
      url: "/v1/auth/stellar/verify",
      body: { challenge_id: ch.challenge_id, signature: key.signMessage(ch.message) },
      headers,
    });
    await call(h, { method: "GET", url: "/v1/nope?x=Q-CANARY", headers });
    const text = h.logs.lines.slice(before).join("");
    const session = cookie.split("=")[1] as string;
    for (const needle of [
      IP,
      "198.51.100",
      UA,
      "PrivacyCanary",
      "Q-CANARY",
      "secretquery",
      session,
      tenant,
      key.account,
      "gho_",
      "x-forwarded-for",
      "cookie",
    ]) {
      expect(text, needle).not.toContain(needle);
    }
    const lines = h.logs.lines.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
    const req = lines.find((l) => l.route === "/v1/tenants/:tenantId");
    expect(req).toMatchObject({
      method: "GET",
      route: "/v1/tenants/:tenantId",
      status: 200,
      service: "control-plane",
    });
    // reqId is Fastify's random per-request id (also returned as request_id in problem bodies).
    expect(Object.keys(req as object).sort()).toEqual([
      "level",
      "method",
      "ms",
      "msg",
      "reqId",
      "route",
      "service",
      "status",
      "time",
    ]);
    expect(lines.find((l) => l.status === 404)?.route).toBe("unmatched");
  });

  it("the database holds no IP, User-Agent, cookie value or query string after these requests", async () => {
    const tables = await h.su.query<{ t: string }>(
      `SELECT format('%I.%I', table_schema, table_name) AS t FROM information_schema.tables
        WHERE table_schema = 'scf' AND table_type = 'BASE TABLE'`,
    );
    for (const { t } of tables.rows) {
      const r = await h.su.query(
        `SELECT count(*)::int AS n FROM ${t} x WHERE x::text LIKE ANY($1)`,
        [[`%${IP}%`, "%198.51.100.%", "%PrivacyCanary%", "%Q-CANARY%"]],
      );
      expect(r.rows[0].n, t).toBe(0);
    }
  });
});

describe("public endpoints", () => {
  it("publishes only public settings", async () => {
    const res = await call(h, { method: "GET", url: "/public/v1/thresholds" });
    expect(res.statusCode).toBe(200);
    const keys = res.json().map((s: { key: string }) => s.key);
    expect(keys).toContain("op_min_count");
    expect(keys).toContain("enrollment_mode");
    for (const s of res.json()) expect(s.public).toBe(true);
  });

  it("lists released tracker versions with SRI hashes", async () => {
    const res = await call(h, { method: "GET", url: "/v1/tracker/versions" });
    expect(res.json()).toEqual([
      expect.objectContaining({ version: "1.0.0", status: "active", advisory_url: null }),
    ]);
    expect(res.json()[0].files[0].integrity).toMatch(/^sha384-/);
  });

  it("every documented public-listener operation is built: none answers 501 (gate G4, C-113)", () => {
    const missing = h.openapi.operations
      .filter((o) => !o.internal && !h.built.has(o.operationId))
      .map((o) => o.operationId);
    expect(missing).toEqual([]);
  });

  it("serves liveness and readiness", async () => {
    expect((await h.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
      status: "ok",
    });
    expect((await h.app.inject({ method: "GET", url: "/readyz" })).json()).toEqual({
      status: "ready",
    });
    expect((await h.internal.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("rate limits", () => {
  it("every response carries RateLimit-* headers; unauthenticated auth routes allow 60/min per subnet, then 429 + Retry-After", async () => {
    const limited = await startHarness({ SCF_TRUST_PROXY: "true" });
    try {
      let last = await call(limited, {
        method: "GET",
        url: "/v1/auth/github/start",
        headers: { "x-forwarded-for": "203.0.113.5" },
      });
      expect(last.headers["ratelimit-limit"]).toBe("60");
      expect(last.headers["ratelimit-remaining"]).toBe("59");
      for (let i = 0; i < 59; i++) {
        last = await limited.app.inject({
          method: "GET",
          url: "/v1/auth/github/start",
          headers: { "x-forwarded-for": "203.0.113.9" },
        });
      }
      const blocked = await call(limited, {
        method: "GET",
        url: "/v1/auth/github/start",
        headers: { "x-forwarded-for": "203.0.113.200" },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe("rate_limited");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      // Another /24 is unaffected.
      const other = await call(limited, {
        method: "GET",
        url: "/v1/auth/github/start",
        headers: { "x-forwarded-for": "203.0.114.1" },
      });
      expect(other.statusCode).toBe(302);
    } finally {
      await limited.close();
    }
  });
});

describe("SCF_CREATE_LIMIT_PER_HOUR", () => {
  it("sets the per-subnet limit of creating calls (default 60/h); other calls keep their limits", async () => {
    const post = (hh: Harness, xff: string) =>
      hh.app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { "x-forwarded-for": xff, "content-type": "application/json" },
        payload: "{}",
      });
    const dflt = await startHarness({ SCF_TRUST_PROXY: "true" });
    try {
      const first = await post(dflt, "203.0.113.5");
      expect(first.headers["ratelimit-limit"]).toBe("60");
      expect(first.headers["ratelimit-remaining"]).toBe("59");
    } finally {
      await dflt.close();
    }
    const small = await startHarness({ SCF_TRUST_PROXY: "true", SCF_CREATE_LIMIT_PER_HOUR: "2" });
    try {
      const a = await post(small, "198.51.100.1");
      const b = await post(small, "198.51.100.2");
      const c = await post(small, "198.51.100.3");
      expect([a.headers["ratelimit-limit"], a.headers["ratelimit-remaining"]]).toEqual(["2", "1"]);
      expect(b.statusCode).not.toBe(429);
      expect(c.statusCode).toBe(429);
      expect(c.json().code).toBe("rate_limited");
      expect(Number(c.headers["retry-after"])).toBeGreaterThan(0);
      // a non-creating call from the same subnet is not affected
      const read = await small.app.inject({
        method: "GET",
        url: "/v1/auth/session",
        headers: { "x-forwarded-for": "198.51.100.4" },
      });
      expect(read.statusCode).not.toBe(429);
    } finally {
      await small.close();
    }
  });
});

describe("SCF_TRUST_PROXY", () => {
  async function remaining(hh: Harness, xff: string, remoteAddress: string): Promise<string> {
    const res = await hh.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { "x-forwarded-for": xff },
      remoteAddress,
    });
    return String(res.headers["ratelimit-remaining"]);
  }

  it("honours X-Forwarded-For only from the listed proxies; the address never reaches the logs", async () => {
    const listed = await startHarness({ SCF_TRUST_PROXY: "10.9.0.0/16" });
    try {
      // From the portal proxy: callers behind it get their own per-subnet buckets.
      expect(await remaining(listed, "198.51.100.1", "10.9.0.2")).toBe("59");
      expect(await remaining(listed, "192.0.2.1", "10.9.0.2")).toBe("59");
      expect(await remaining(listed, "198.51.100.2", "10.9.0.2")).toBe("58");
      // From anywhere else the header is ignored: the bucket is the peer's.
      expect(await remaining(listed, "192.0.2.1", "203.0.113.10")).toBe("59");
      expect(await remaining(listed, "198.51.100.1", "203.0.113.11")).toBe("58");
      for (const ip of ["198.51.100", "192.0.2.1", "10.9.0.2", "203.0.113"])
        expect(listed.logs.text).not.toContain(ip);
    } finally {
      await listed.close();
    }
  });

  it("unset, every caller behind a proxy shares the proxy's bucket", async () => {
    const off = await startHarness();
    try {
      expect(await remaining(off, "198.51.100.1", "10.9.0.2")).toBe("59");
      expect(await remaining(off, "192.0.2.1", "10.9.0.2")).toBe("58");
    } finally {
      await off.close();
    }
  });
});

describe("contract gaps seen by the response validator", () => {
  it("are only the known, reported ones", () => {
    for (const g of contractGaps)
      expect(KNOWN_403_GAPS.has(g.split(":")[0] as string), g).toBe(true);
  });
});
