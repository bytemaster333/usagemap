// SPDX-License-Identifier: Apache-2.0
// The operator metrics API (`/op/v1`) must not let an anonymous client
// write one audit row per attacker-chosen key id (global audit chain flood), must rate-limit per client subnet BEFORE
// key authentication, and must refuse a percent-encoded key in the URL like a plain one.

import { describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.ts";
import { RateLimiter } from "../../src/http/ratelimit.ts";
import { createServer } from "../../src/http/server.ts";
import { OpKeyAuth } from "../../src/opmetrics/keyauth.ts";
import { ANON_LIMIT_PER_MIN, registerOperatorMetrics } from "../../src/opmetrics/routes.ts";

const PEPPERS = { op: undefined, ing: undefined, pub: undefined } as never;

/** A database stub counting audit rows and lookups; every lookup finds nothing. */
function stubDb() {
  const audits: Array<{ action: string; targetId?: string | null; details?: unknown }> = [];
  let lookups = 0;
  let revokeLookups = 0;
  const db = {
    tx: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        audit: async (e: { action: string; targetId?: string | null; details?: unknown }) => {
          audits.push(e);
        },
        maybeOne: async (sql: string) => {
          if (sql.includes("pepper_version FROM scf.operator_api_keys")) revokeLookups++;
          else lookups++;
          return null;
        },
        query: async () => [],
      }),
  } as unknown as Database;
  return {
    db,
    audits,
    lookups: () => lookups,
    revokeLookups: () => revokeLookups,
  };
}

/** A bad-checksum key with the given (12-character) id. */
const badKey = (i: number) => `scfa_op_${String(i).padStart(12, "A")}_${"B".repeat(27)}000000`;

describe("#1 bad-checksum keys do not flood the audit chain", () => {
  it("writes at most one aggregated row per minute, never with the attacker-chosen id", async () => {
    let now = 1_000_000;
    const s = stubDb();
    const a = new OpKeyAuth(s.db, PEPPERS, () => now);
    for (let i = 0; i < 500; i++) {
      await expect(a.authenticate(`Bearer ${badKey(i)}`, "r")).rejects.toThrow();
    }
    expect(s.audits).toHaveLength(1);
    const first = s.audits[0];
    expect(first?.action).toBe("api_key.rejected_bad_checksum");
    expect(first?.targetId ?? null).toBeNull();
    expect(JSON.stringify(first?.details)).not.toContain("AAAAAAAAA");
    // A minute later the rows rejected in between are reported as one count.
    now += 61_000;
    await expect(a.authenticate(`Bearer ${badKey(9999)}`, "r")).rejects.toThrow();
    expect(s.audits).toHaveLength(2);
    expect(s.audits[1]?.details).toMatchObject({ count: 500 });
  });
});

function app(s: ReturnType<typeof stubDb>, now: () => number) {
  const server = createServer({
    logLevel: "silent",
    problemBase: "https://problems.test/",
    trustProxy: false,
    bodyLimit: 1024,
  });
  registerOperatorMetrics(server, {
    db: s.db,
    peppers: PEPPERS,
    limiter: new RateLimiter(now),
    keyAuth: new OpKeyAuth(s.db, PEPPERS, now),
    now,
  });
  return server;
}

describe("#1 per-subnet limit before key authentication", () => {
  it("answers 429 to an anonymous subnet past its budget without looking keys up", async () => {
    const now = () => 5_000_000;
    const s = stubDb();
    const server = app(s, now);
    // Well-formed keys with a valid CRC would each force a database lookup: those must stop at the subnet limit too.
    const { mintKey } = await import("../../src/keys/keys.ts");
    const set = { peppers: new Map([[1, Buffer.alloc(32, 2)]]), current: 1 };
    let last = 0;
    for (let i = 0; i < ANON_LIMIT_PER_MIN + 5; i++) {
      const r = await server.inject({
        method: "GET",
        url: "/op/v1/me",
        headers: { authorization: `Bearer ${mintKey("op", set).key}` },
      });
      last = r.statusCode;
      if (i < ANON_LIMIT_PER_MIN) {
        expect(r.statusCode).toBe(401);
        expect(r.headers["www-authenticate"]).toContain("Bearer");
      } else expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    }
    expect(last).toBe(429);
    expect(s.lookups()).toBe(ANON_LIMIT_PER_MIN);
    await server.close();
  });
});

describe("#24 a percent-encoded key in the URL is refused and revoked", () => {
  it("decodes the URL before testing for a key", async () => {
    const s = stubDb();
    const server = app(s, () => 7_000_000);
    const { mintKey } = await import("../../src/keys/keys.ts");
    const key = mintKey("op", { peppers: new Map([[1, Buffer.alloc(32, 2)]]), current: 1 }).key;
    const encoded = key.replace(/_/g, "%5F");
    const r = await server.inject({ method: "GET", url: `/op/v1/me?x=${encoded}` });
    expect(r.statusCode).toBe(401);
    expect(r.json().detail).toMatch(/URL/);
    expect(s.revokeLookups()).toBe(1); // revocation attempted for the decoded key
    await server.close();
  });
});
