// SPDX-License-Identifier: Apache-2.0
// "Verify this number" against real PostgreSQL (migration 0077): the verifier keys and stellar.toml name the live
// snapshot key and the accounts that sealed days; a sealed audit-anchor document is served exactly as stored and is
// immutable; badges exist only for projects with public stats, with floors, caching and the same 404 otherwise.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeAccountId } from "../../src/auth/stellar.ts";
import { canonicalize } from "../../src/programme/jcs.ts";
import { call, type Harness, startHarness, stellarKey } from "../support/harness.ts";
import { type SeededProject, seedProject } from "../support/op-seed.ts";

let h: Harness;
let p: SeededProject;
let priv: SeededProject;
const DAY = "2030-06-01";
const sealer = stellarKey().account;

async function asReplica(sql: string, params: unknown[]): Promise<void> {
  const c = await h.su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica"); // test only: no chain/guard triggers
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

function anchorDoc() {
  const body = {
    schema: "scf-analytics/audit-anchor/1",
    date: DAY,
    generated_at: "2030-06-02T00:00:00Z",
    chains: [
      { chain_id: "00000000-0000-0000-0000-000000000000", seq: 7, row_hash: "ab".repeat(32) },
    ],
  };
  return { ...body, sha256: createHash("sha256").update(canonicalize(body)).digest("hex") };
}

function metricsDoc(slug: string, visitors: number, requests: number) {
  return {
    schema: "scf-analytics/metrics-endpoint/1",
    project: { slug, name: "Badge <Test>", verification_level: "L1" },
    generated_at: "2026-11-19T01:00:00Z",
    window: { start: "2026-10-20T00:00:00Z", end: "2026-11-19T00:00:00Z", days: 30 },
    web: {
      verified: { pageviews: 1, visitors_sum: visitors },
      raw: {},
      visit_metrics: {},
      daily: [],
    },
    api: { label: "self-attested telemetry", requests, assurance_level: requests ? "A1" : null },
    links: { definitions: "x" },
  };
}

beforeAll(async () => {
  h = await startHarness();
  p = await seedProject(h, { level: 1 });
  priv = await seedProject(h, { level: 1 });
  for (const [t, v] of [
    [p, 48_178],
    [priv, 5000],
  ] as const)
    await h.su.query(
      `INSERT INTO scf.public_metrics_documents (tenant_id, document) VALUES ($1, $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET document = EXCLUDED.document`,
      [t.tenantId, JSON.stringify(metricsDoc(t.slug, v, 50_000))],
    );
  await h.su.query(`UPDATE scf.tenants SET public_stats_enabled = true WHERE tenant_id = $1`, [
    p.tenantId,
  ]);
  const doc = anchorDoc();
  await asReplica(
    `INSERT INTO scf.seal_days (network, day, segment, prev_root, audit_anchor_sha256, leaf_count, head_path, root,
                                status, source_account, tx_hash, ledger, confirmed_at)
     VALUES ('testnet', $1, 1, $2, $3, 2, ARRAY[]::bytea[], $4, 'confirmed', $5, $6, 999999999, now())`,
    [
      DAY,
      Buffer.alloc(32),
      Buffer.from(doc.sha256, "hex"),
      Buffer.alloc(32, 1),
      sealer,
      Buffer.alloc(32, 2),
    ],
  );
  await h.su.query(
    `INSERT INTO scf.sealed_audit_anchors (day, sha256, document) VALUES ($1, $2, $3::jsonb)`,
    [DAY, Buffer.from(doc.sha256, "hex"), JSON.stringify(doc)],
  );
});

afterAll(async () => {
  if (h) {
    await asReplica("DELETE FROM scf.sealed_audit_anchors WHERE day = $1", [DAY]);
    await asReplica("DELETE FROM scf.seal_days WHERE network = 'testnet' AND day = $1", [DAY]);
  }
  await h?.close();
});

describe("verifier keys", () => {
  it("names the snapshot key (JWK and strkey of the same bytes), the sealing account and the latest confirmed day", async () => {
    const r = await call(h, { method: "GET", url: "/public/v1/verifier-keys" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    const k = r.json();
    const jwks = (
      await call(h, { method: "GET", url: "/.well-known/scf-snapshot-keys.json" })
    ).json();
    expect(k.snapshot_signing.keys.map((x: { kid: string }) => x.kid)).toEqual(
      jwks.keys.map((x: { kid: string }) => x.kid),
    );
    for (const key of k.snapshot_signing.keys)
      expect(decodeAccountId(key.stellar_public_key)).toEqual(Buffer.from(key.x, "base64url"));
    expect(k.seal.accounts).toContain(sealer);
    expect(k.seal.latest_confirmed).toMatchObject({ day: DAY, ledger: 999999999 });
    expect(k.seal.network.name).toBe("testnet");
    const again = await call(h, {
      method: "GET",
      url: "/public/v1/verifier-keys",
      headers: { "if-none-match": r.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
  });

  it("renders the same keys as a SEP-1 stellar.toml", async () => {
    const r = await call(h, { method: "GET", url: "/public/v1/stellar.toml" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.body).toContain('VERSION = "2.7.0"');
    expect(r.body).toContain(sealer);
    expect(r.body).toContain("[USAGEMAP_VERIFY]");
  });
});

describe("sealed audit anchors", () => {
  it("serves the stored document; its hash recomputes to the seal day's audit_anchor_sha256", async () => {
    const r = await call(h, { method: "GET", url: `/public/v1/audit-anchors/${DAY}` });
    expect(r.statusCode, r.body).toBe(200);
    const { sha256, ...body } = r.json();
    expect(createHash("sha256").update(canonicalize(body)).digest("hex")).toBe(sha256);
    const day = (await call(h, { method: "GET", url: `/public/v1/seals/${DAY}` })).json();
    expect(day.seal.audit_anchor_sha256).toBe(sha256);
    expect(
      (await call(h, { method: "GET", url: "/public/v1/audit-anchors/2030-06-02" })).statusCode,
    ).toBe(404);
    expect(
      (await call(h, { method: "GET", url: "/public/v1/audit-anchors/nonsense" })).statusCode,
    ).toBe(404);
  });

  it("is immutable and writable only by daily_seal", async () => {
    await expect(
      h.su.query("UPDATE scf.sealed_audit_anchors SET stored_at = now() WHERE day = $1", [DAY]),
    ).rejects.toThrow(/never changed/);
    await expect(
      h.su.query("DELETE FROM scf.sealed_audit_anchors WHERE day = $1", [DAY]),
    ).rejects.toThrow(/never changed/);
    // a document whose own sha256 field is not the row's hash is refused
    await expect(
      h.su.query(
        `INSERT INTO scf.sealed_audit_anchors (day, sha256, document) VALUES ('2030-06-03', $1, $2::jsonb)`,
        [Buffer.alloc(32), JSON.stringify({ ...anchorDoc(), date: "2030-06-03" })],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      h.db.tx({ tenantId: null, actorKind: "anonymous", actorId: null, requestId: "x" }, (tx) =>
        tx.query(
          "INSERT INTO scf.sealed_audit_anchors (day, sha256, document) VALUES ('2030-06-04', $1, '{}')",
          [Buffer.alloc(32)],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("badges", () => {
  it("serves SVG and Shields JSON for public stats only, cached, with the C4 wording", async () => {
    const svg = await call(h, { method: "GET", url: `/public/v1/projects/${p.slug}/badge.svg` });
    expect(svg.statusCode, svg.body).toBe(200);
    expect(svg.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(svg.headers["cache-control"]).toBe("public, max-age=3600");
    expect(svg.body).toContain("measured by UsageMap");
    expect(svg.body).toContain("48.1k verified visitors / 30d");
    expect(svg.body).toContain("Badge &lt;Test&gt;");
    const etag = svg.headers.etag as string;
    expect(
      (
        await call(h, {
          method: "GET",
          url: `/public/v1/projects/${p.slug}/badge.svg`,
          headers: { "if-none-match": etag },
        })
      ).statusCode,
    ).toBe(304);
    const api = await call(h, {
      method: "GET",
      url: `/public/v1/projects/${p.slug}/badge.json?metric=api`,
    });
    expect(api.statusCode, api.body).toBe(200);
    expect(api.json()).toEqual({
      schemaVersion: 1,
      label: "measured by UsageMap",
      message: "50k API requests (self-attested) / 30d",
      color: "6b5a1f",
      cacheSeconds: 3600,
    });
    // a private project and an unknown slug look the same
    for (const slug of [priv.slug, "no-such-project-x"]) {
      expect(
        (await call(h, { method: "GET", url: `/public/v1/projects/${slug}/badge.svg` })).statusCode,
      ).toBe(404);
      expect(
        (await call(h, { method: "GET", url: `/public/v1/projects/${slug}/badge.json` }))
          .statusCode,
      ).toBe(404);
    }
    expect(
      (
        await call(h, {
          method: "GET",
          url: `/public/v1/projects/${p.slug}/badge.json?metric=bogus`,
        })
      ).statusCode,
    ).toBe(400);
  });
});
