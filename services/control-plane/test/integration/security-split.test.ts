// SPDX-License-Identifier: Apache-2.0
// Against the real database (migrations incl. 0060, PgBouncer in transaction mode):
//   F21 — rate limits shared by every control-plane instance and kept across a restart (PgRateLimiter);
//   F16 — traction snapshots are recorded by the control plane and signed by the jobs service's worker: 202 while
//         pending, the signed copy afterwards; scf_app can write neither a document nor a signature;
//   F12 — the edge snapshot carries `expires_at` and an unchanged snapshot is re-issued before it nears expiry.

import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, Database } from "../../src/db/database.ts";
import { SnapshotBuilder, SnapshotSigner, verifyEnvelope } from "../../src/edge/snapshot.ts";
import { PgRateLimiter } from "../../src/http/ratelimit.ts";
import { verifySnapshot } from "../../src/programme/keys.ts";
import { TractionSigner, TractionSigningKey } from "../../src/programme/signer.ts";
import { loadTrackerRegistry } from "../../src/tracker.ts";
import { call, type Harness, SNAPSHOT_KEY_PEM, startHarness } from "../support/harness.ts";
import { type SeededProject, seedProject, seedWebDay } from "../support/op-seed.ts";

const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;
const midnight = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");
let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("F21: shared rate limits (PostgreSQL)", () => {
  it("two instances count against one window; a restarted instance continues it; no key is stored", async () => {
    const secret = Buffer.alloc(32, 42);
    const db2 = new Database(createPool({ connectionString: inject("pgAppUrl"), max: 2 }));
    try {
      const a = new PgRateLimiter(h.db, secret);
      const b = new PgRateLimiter(db2, secret);
      const key = `cs:203.0.113.0/24:${Date.now()}`;
      const limit = [{ key, limit: 3, windowMs: 60_000 }];
      expect((await a.hit(limit)).remaining).toBe(2);
      expect((await b.hit(limit)).remaining).toBe(1);
      // "restart": a new limiter object (no memory) with the same secret
      const restarted = new PgRateLimiter(h.db, secret);
      expect(await restarted.hit(limit)).toMatchObject({ allowed: true, remaining: 0 });
      const refused = await a.hit(limit);
      expect(refused.allowed).toBe(false);
      expect(refused.reset).toBeGreaterThanOrEqual(1);
      expect(refused.reset).toBeLessThanOrEqual(60);
      // Several limits in one call: the most restrictive wins; concurrent calls do not lose counts.
      const k2 = `p:${Date.now()}`;
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? a : b).hit([{ key: k2, limit: 100, windowMs: 60_000 }]),
        ),
      );
      expect((await a.hit([{ key: k2, limit: 100, windowMs: 60_000 }])).remaining).toBe(89);
      // Only HMACs reach the table.
      const dump = await h.su.query(`SELECT bucket, hits FROM scf.rate_limit_buckets`);
      expect(dump.rows.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(dump.rows)).not.toContain("203.0.113");
      expect(dump.rows.every((r) => (r.bucket as Buffer).length === 32)).toBe(true);
    } finally {
      await db2.close();
    }
  });

  it("an expired window starts again at 1", async () => {
    const l = new PgRateLimiter(h.db, Buffer.alloc(32, 7));
    const key = [{ key: `x:${Date.now()}`, limit: 1, windowMs: 300 }];
    expect((await l.hit(key)).allowed).toBe(true);
    expect((await l.hit(key)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect((await l.hit(key)).allowed).toBe(true);
  });

  it("the public API uses it when SCF_RATE_LIMIT_STORE=postgres: a second app instance sees the first one's hits", async () => {
    const env = { SCF_RATE_LIMIT_STORE: "postgres" };
    const h1 = await startHarness(env, { limiter: undefined });
    const h2 = await startHarness(env, { limiter: undefined });
    try {
      const r1 = await call(h1, { method: "GET", url: "/v1/tracker/versions" });
      const r2 = await call(h2, { method: "GET", url: "/v1/tracker/versions" });
      expect(r1.statusCode).toBe(200);
      expect(Number(r2.headers["ratelimit-remaining"])).toBeLessThan(
        Number(r1.headers["ratelimit-remaining"]),
      );
    } finally {
      await h1.close();
      await h2.close();
    }
  });
});

describe("F16: traction snapshots are signed by the jobs service", () => {
  let p: SeededProject;
  const period = { period_start: midnight(today - 2 * DAY), period_end: midnight(today) };

  beforeAll(async () => {
    p = await seedProject(h, { level: 1 });
    await seedWebDay(h, p, new Date(today - DAY).toISOString().slice(0, 10), {
      pvVerified: 7,
      pvRaw: 9,
    });
  });

  it("without a running signer: 202 pending, 404 publicly; the worker then signs exactly once", async () => {
    const h2 = await startHarness({ SCF_SNAPSHOT_WAIT_MS: "300" }, { wakeSigner: () => {} });
    try {
      const r = await call(h2, {
        method: "POST",
        url: `/v1/tenants/${p.tenantId}/traction-snapshots`,
        cookie: p.cookie,
        body: period,
      });
      expect(r.statusCode, r.body).toBe(202);
      const { snapshot_id: id, status, verify_url } = r.json();
      expect(status).toBe("pending");
      expect(r.headers.location).toBe(verify_url);
      expect(
        (await call(h2, { method: "GET", url: `/public/v1/snapshots/${id}` })).statusCode,
      ).toBe(404);
      const listed = (
        await call(h2, {
          method: "GET",
          url: `/v1/tenants/${p.tenantId}/traction-snapshots`,
          cookie: p.cookie,
        })
      ).json();
      expect(listed.find((x: { snapshot_id: string }) => x.snapshot_id === id)?.status).toBe(
        "pending",
      );

      // The jobs service's worker (scf_jobs, job public_metrics) computes the figures and signs.
      const signer = new TractionSigner(
        h.jobsDb,
        new TractionSigningKey(SNAPSHOT_KEY_PEM, "snap-test"),
        {
          portalOrigin: h.config.portalOrigin,
          intervalMs: 3_600_000,
          log: { info: () => {}, error: () => {} },
        },
      );
      expect(await signer.runOnce()).toBeGreaterThanOrEqual(1);
      expect(await signer.runOnce()).toBe(0); // signed once
      const pub = await call(h2, { method: "GET", url: `/public/v1/snapshots/${id}` });
      expect(pub.statusCode).toBe(200);
      const jwks = (
        await call(h2, { method: "GET", url: "/.well-known/scf-snapshot-keys.json" })
      ).json();
      expect(verifySnapshot(jwks, pub.json())).toBe(true);
      expect(pub.json().snapshot.web.raw.pageviews).toBe(9);
    } finally {
      await h2.close();
    }
  });

  it("scf_app cannot write a document or a signature, nor insert a signed row (migration 0060)", async () => {
    const r = await call(h, {
      method: "POST",
      url: `/v1/tenants/${p.tenantId}/traction-snapshots`,
      cookie: p.cookie,
      body: period,
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().snapshot.snapshot_id as string;
    const uid = (
      await h.su.query(`SELECT created_by FROM scf.tenants WHERE tenant_id = $1`, [p.tenantId])
    ).rows[0].created_by as string;
    const ctx = { tenantId: p.tenantId, actorKind: "user" as const, actorId: uid };
    await expect(
      h.db.tx(ctx, (tx) =>
        tx.query(
          `UPDATE scf.traction_snapshots SET document = '{"forged":true}' WHERE tenant_id = $1 AND snapshot_id = $2`,
          [p.tenantId, id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      h.db.tx(ctx, (tx) =>
        tx.query(
          `INSERT INTO scf.traction_snapshots (tenant_id, created_by, period_start, period_end, document,
                                               canonical_sha256, signature, kid)
           VALUES ($1, $2, $3, $4, '{}', sha256('x'), decode(repeat('00', 64), 'hex'), 'k')`,
          [p.tenantId, uid, new Date(today - DAY), new Date(today)],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // A job other than public_metrics cannot sign; nor can public_metrics re-sign a signed row.
    const other = await h.jobsDb.tx(
      { tenantId: p.tenantId, actorKind: "job", actorId: "erasure", job: "erasure" },
      (tx) =>
        tx
          .query(`UPDATE scf.traction_snapshots SET kid = 'x' WHERE tenant_id = $1 RETURNING 1`, [
            p.tenantId,
          ])
          .catch((e: { code?: string }) => e.code),
    );
    expect(Array.isArray(other) ? other.length : other).toSatisfy(
      (v: unknown) => v === 0 || v === "42501",
    );
    const resign = await h.jobsDb.tx(
      { tenantId: p.tenantId, actorKind: "job", actorId: "public_metrics", job: "public_metrics" },
      (tx) =>
        tx.query(
          `UPDATE scf.traction_snapshots SET kid = 'x' WHERE tenant_id = $1 AND snapshot_id = $2 RETURNING 1`,
          [p.tenantId, id],
        ),
    );
    expect(resign).toHaveLength(0);
  });
});

describe("F12: edge snapshot hard expiry", () => {
  it("carries expires_at = issued_at + max age, and re-issues an unchanged snapshot after a quarter of it", async () => {
    const pem = generateKeyPairSync("ed25519")
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    const signer = new SnapshotSigner(pem, "edge-exp");
    const dir = new URL("../support/fixtures/tracker", import.meta.url).pathname;
    const builder = new SnapshotBuilder(h.jobsDb, signer, {
      pathnormRulesVersion: "scf-path-rules/1.0.0",
      tracker: loadTrackerRegistry(dir, join(dir, "releases.json")),
      maxAgeS: 3600,
    });
    const t0 = new Date();
    const first = await builder.build(t0);
    const seq0 = first.sequence;
    const latest = async () => {
      const r = await h.su.query(
        `SELECT envelope FROM scf.edge_snapshots ORDER BY sequence DESC LIMIT 1`,
      );
      return verifyEnvelope(r.rows[0].envelope, { "edge-exp": signer.publicKey });
    };
    const p0 = await latest();
    expect(p0.expires_at).toBeDefined();
    expect(Date.parse(p0.expires_at as string) - Date.parse(p0.issued_at)).toBe(3_600_000);
    // Unchanged content, 10 minutes later: still fresh → nothing new.
    expect((await builder.build(new Date(Date.parse(p0.issued_at) + 600_000))).issued).toBe(false);
    // 16 minutes after issue (> 1/4 of an hour): re-issued with a new sequence and a later expiry.
    const later = new Date(Date.parse(p0.issued_at) + 16 * 60_000);
    const r = await builder.build(later);
    expect(r.issued).toBe(true);
    expect(r.sequence).toBeGreaterThan(seq0);
    const p1 = await latest();
    expect(Date.parse(p1.expires_at as string)).toBe(later.getTime() + 3_600_000);
    // Without a maximum age the next build drops expires_at (setting switched off) and then stays quiet.
    const plain = new SnapshotBuilder(h.jobsDb, signer, {
      pathnormRulesVersion: "scf-path-rules/1.0.0",
      tracker: loadTrackerRegistry(dir, join(dir, "releases.json")),
    });
    expect((await plain.build(new Date(later.getTime() + 1000))).issued).toBe(true);
    expect((await latest()).expires_at).toBeUndefined();
    expect((await plain.build(new Date(later.getTime() + 2000))).issued).toBe(false);
  });
});
