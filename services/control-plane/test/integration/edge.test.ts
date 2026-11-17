// SPDX-License-Identifier: Apache-2.0
// Signed edge snapshot (wire-formats §e) and edge counter delivery (§d.3, §l), through the internal listener.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApps } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { COUNTER_RECORD_SCHEMA } from "../../src/edge/counters.ts";
import {
  SnapshotBuilder,
  type SnapshotPayload,
  SnapshotSigner,
  verifyEnvelope,
} from "../../src/edge/snapshot.ts";
import { loadTrackerRegistry } from "../../src/tracker.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const addFormats = addFormatsModule as unknown as (a: Ajv2020) => Ajv2020;
const wire = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "..", "docs", "contracts", "wire-formats.md"),
  "utf8",
);

/** The JSON Schema block of wire-formats.md whose $id ends with `name`. */
function contractSchema(name: string): Record<string, unknown> {
  for (const block of wire.matchAll(/```json\n([\s\S]*?)```/g)) {
    const text = block[1] as string;
    if (text.includes(`"$id"`) && text.includes(name))
      return JSON.parse(text.replace(/<domain-a>/g, "domain-a.invalid"));
  }
  throw new Error(`schema ${name} not found in wire-formats.md`);
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validatePayload = ajv.compile(contractSchema("edge-snapshot-1.json"));

let h: Harness;
let builder: SnapshotBuilder;
let signer: SnapshotSigner;
const NODE = "edge-a1";

async function asOperator(sql: string, params: unknown[]): Promise<void> {
  const c = await h.su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE scf_op_definer"); // test-only: status changes are op_tenant_transition's job
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function latest(headers: Record<string, string> = { "x-scf-edge-node": NODE }) {
  const res = await h.internal.inject({
    method: "GET",
    url: "/internal/v1/edge/snapshot",
    headers,
  });
  const ct = res.headers["content-type"] as string | undefined;
  const body = res.statusCode === 304 ? undefined : res.json();
  expect(h.openapi.validateResponse("edgeGetSnapshot", res.statusCode, ct, body)).toEqual([]);
  return res;
}

async function payloadNow(): Promise<SnapshotPayload> {
  await builder.build();
  const res = await latest();
  expect(res.statusCode).toBe(200);
  return verifyEnvelope(res.body, { [signer.kid]: signer.publicKey });
}

beforeAll(async () => {
  h = await startHarness();
  const { privateKey } = generateKeyPairSync("ed25519");
  signer = new SnapshotSigner(
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    "edge-test",
  );
  const dir = new URL("../support/fixtures/tracker", import.meta.url).pathname;
  builder = new SnapshotBuilder(h.jobsDb, signer, {
    pathnormRulesVersion: "scf-path-rules/1.0.0",
    tracker: loadTrackerRegistry(dir, join(dir, "releases.json")),
  });
});
afterAll(async () => {
  await h?.close();
});

describe("edge snapshot (§e)", () => {
  it("the counter-record schema in code is the contract's schema", () => {
    const strip = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(strip)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([k]) => k !== "description" && k !== "$id")
                .map(([k, x]) => [k, strip(x)]),
            )
          : v;
    expect(strip(JSON.parse(JSON.stringify(COUNTER_RECORD_SCHEMA)))).toEqual(
      strip(contractSchema("counter-record-1.json")),
    );
  });

  it("issues signed envelopes; the payload matches the §e.3 schema exactly", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const tenant = await createTenant(h, owner);
    const site = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${tenant}/sites`,
        cookie: owner,
        body: { name: "S" },
      })
    ).json();
    await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/sites/${site.site_id}/domains`,
      cookie: owner,
      body: { host: `www.${tenant.slice(0, 8)}.example` },
    });
    const p = await payloadNow();
    expect(validatePayload(p), JSON.stringify(validatePayload.errors)).toBe(true);
    const env = JSON.parse((await latest()).body);
    expect(Object.keys(env).sort()).toEqual(["alg", "format", "kid", "payload", "sig"]);
    expect(env).toMatchObject({ format: "scf-edge-snapshot/1", alg: "Ed25519", kid: "edge-test" });
    expect(p.settings).toMatchObject({
      pow_cost: 512,
      pow_max: 1024,
      pathnorm_rules_version: "scf-path-rules/1.0.0",
    });
    expect(p.tracker_versions).toEqual([{ version: "1.0.0", status: "active" }]);
    expect(p.tenants).toContainEqual({ tenant_id: tenant, status: "active", level: 0 });
    const s = p.sites.find((x) => x.site_id === site.site_id);
    expect(s).toMatchObject({
      tenant_id: tenant,
      site_key: site.site_key,
      status: "active",
      profile: "standard",
      visitor_id: "on",
      umami_twin_website_id: null,
      rate_limit_per_min: 600,
      daily_quota: 50000,
      domains: [
        { host: `www.${tenant.slice(0, 8)}.example`, include_subdomains: false, verified: false },
      ],
    });
  });

  it("carries dev origins, an active debug mode and the counter-record capability flag (C-136, C-137)", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const tenant = await createTenant(h, owner);
    const site = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${tenant}/sites`,
        cookie: owner,
        body: { name: "S", dev_origins: ["localhost", "myapp-*.vercel.app"] },
      })
    ).json().site_id as string;
    let p = await payloadNow();
    expect(validatePayload(p), JSON.stringify(validatePayload.errors)).toBe(true);
    expect(p.settings).toMatchObject({ dev_events_per_min_site: 120, counter_features: [] });
    let s = p.sites.find((x) => x.site_id === site);
    expect(s?.dev_origins).toEqual(["localhost", "myapp-*.vercel.app"]);
    expect(s).not.toHaveProperty("debug_until");
    await call(h, {
      method: "PUT",
      url: `/v1/tenants/${tenant}/sites/${site}/debug-mode`,
      cookie: owner,
      body: { enabled: true, duration_minutes: 15 },
    });
    await h.su.query(
      `UPDATE scf.settings SET value = '["props","dev"]'::jsonb WHERE key = 'edge_counter_features'`,
    );
    try {
      p = await payloadNow();
      expect(validatePayload(p), JSON.stringify(validatePayload.errors)).toBe(true);
      expect(p.settings.counter_features).toEqual(["dev", "props"]);
      s = p.sites.find((x) => x.site_id === site);
      expect(Date.parse(String(s?.debug_until)) - Date.now()).toBeGreaterThan(14 * 60_000);
    } finally {
      await h.su.query(
        `UPDATE scf.settings SET value = '[]'::jsonb WHERE key = 'edge_counter_features'`,
      );
    }
    // a site without dev origins carries neither optional field
    const plain = p.sites.find((x) => x.dev_origins === undefined);
    expect(plain).toBeDefined();
  });

  it("issues a new sequence only when the content changed; ETag / If-None-Match → 304", async () => {
    await builder.build();
    const a = await latest();
    const seqA = verifyEnvelope(a.body, { [signer.kid]: signer.publicKey }).sequence;
    const again = await builder.build();
    expect(again).toEqual({ issued: false, sequence: seqA });
    expect(a.headers.etag).toBe(`"${seqA}"`);
    const notModified = await latest({ "x-scf-edge-node": NODE, "if-none-match": `"${seqA}"` });
    expect(notModified.statusCode).toBe(304);

    const owner = await signInGithub(h, newGithubUser());
    await createTenant(h, owner);
    const b = await builder.build();
    expect(b.issued).toBe(true);
    expect(b.sequence).toBe(seqA + 1);
    // Anti-rollback as a gateway applies it (C-62).
    expect(() => verifyEnvelope(a.body, { [signer.kid]: signer.publicKey }, seqA)).toThrow(
      /rollback/,
    );
  });

  it("omits removed tenants and archived sites, keeps suspended and pending ones, carries the twin once provisioned", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    const s1 = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "A", visitor_id: "off" },
      })
    ).json();
    const s2 = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "B" },
      })
    ).json();
    await call(h, { method: "DELETE", url: `/v1/tenants/${t}/sites/${s2.site_id}`, cookie: owner });
    let p = await payloadNow();
    expect(p.sites.find((x) => x.site_id === s1.site_id)?.umami_twin_website_id).toBeNull();
    expect(p.sites.find((x) => x.site_id === s2.site_id)).toBeUndefined();

    const twin = (
      await h.su.query(`SELECT umami_twin_website_id AS t FROM scf.sites WHERE site_id = $1`, [
        s1.site_id,
      ])
    ).rows[0].t;
    await h.su.query(`UPDATE scf.sites SET twin_provisioned_at = now() WHERE site_id = $1`, [
      s1.site_id,
    ]);
    await asOperator(`UPDATE scf.tenants SET status = 'suspended' WHERE tenant_id = $1`, [t]);
    p = await payloadNow();
    expect(p.sites.find((x) => x.site_id === s1.site_id)?.umami_twin_website_id).toBe(twin);
    expect(p.tenants.find((x) => x.tenant_id === t)?.status).toBe("suspended");

    await asOperator(`UPDATE scf.tenants SET status = 'removed' WHERE tenant_id = $1`, [t]);
    p = await payloadNow();
    expect(p.tenants.find((x) => x.tenant_id === t)).toBeUndefined();
    expect(p.sites.find((x) => x.site_id === s1.site_id)).toBeUndefined();
  });

  it("lists only usable ingest tokens, as base64url HMAC hashes with their pepper version; marks over-quota sites", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    const s = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "Q" },
      })
    ).json();
    const hash = Buffer.alloc(32, 7);
    const rnd = randomUUID().replace(/-/g, "").slice(0, 8);
    const tok = (n: number) => `Tk${n}${rnd}x`;
    const user = (await call(h, { method: "GET", url: "/v1/me", cookie: owner })).json().user_id;
    await h.su.query(
      `INSERT INTO scf.ingest_tokens (tenant_id, token_id, secret_hash, last4, label, created_by, allowed_service_names, revoked_at, expires_at)
       VALUES ($1, $2, $3, 'abcd', 'live', $4, ARRAY['api','web'], NULL, NULL),
              ($1, $5, $3, 'abcd', 'revoked', $4, NULL, now(), NULL),
              ($1, $6, $3, 'abcd', 'expired', $4, NULL, NULL, now() + interval '1 second')`,
      [t, tok(1), hash, user, tok(2), tok(3)],
    );
    await new Promise((r) => setTimeout(r, 1100));
    await h.su.query(
      `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 'verdict', 'verified', 50000)`,
      [t, s.site_id],
    );
    const p = await payloadNow();
    const mine = p.ingest_tokens.filter((x) => x.tenant_id === t);
    expect(mine).toEqual([
      {
        token_id: tok(1),
        tenant_id: t,
        hash: hash.toString("base64url"),
        pepper_version: 1,
        allowed_service_names: ["api", "web"],
        expires_at: null,
      },
    ]);
    expect(p.sites.find((x) => x.site_id === s.site_id)?.status).toBe("over_quota");
  });

  it("is served only on the internal listener, only with a node identity", async () => {
    expect(
      (await h.app.inject({ method: "GET", url: "/internal/v1/edge/snapshot" })).statusCode,
    ).toBe(404);
    expect(
      (await h.app.inject({ method: "POST", url: "/internal/v1/edge/counters", payload: {} }))
        .statusCode,
    ).toBe(404);
    expect((await latest({})).statusCode).toBe(401);
    expect((await latest({ "x-scf-edge-node": "Edge_A1" })).statusCode).toBe(401);
  });
});

describe("edge counters (§d.3, §l)", () => {
  function record(
    node: string,
    tenant: string,
    site: string,
    extra: Partial<Record<string, unknown>> = {},
  ) {
    const day = new Date().toISOString().slice(0, 10);
    return {
      rv: 1,
      type: "counter",
      record_id: randomUUID(),
      node_id: node,
      period_start_ms: Date.now() - 60_000,
      period_end_ms: Date.now(),
      web: [
        {
          tenant_id: tenant,
          site_id: site,
          day,
          counter: "verdict",
          label: "verified",
          count: 412,
        },
        { tenant_id: tenant, site_id: site, day, counter: "verdict", label: "verified", count: 8 },
        {
          tenant_id: tenant,
          site_id: site,
          day,
          counter: "kit_present_pageviews",
          label: "all",
          count: 37,
        },
      ],
      otlp: [{ tenant_id: tenant, day, reason: "rate_limited", count: 3 }],
      tokens: [],
      spool: {
        boot_id: randomUUID(),
        day,
        fsynced: 431,
        acked_stored: 428,
        acked_engine_bot: 1,
        acked_engine_rejected: 0,
        expired_72h: 0,
        queued: 7,
        queued_at_day_start: 2,
      },
      ...extra,
    };
  }

  async function post(body: unknown, node: string) {
    const res = await h.internal.inject({
      method: "POST",
      url: "/internal/v1/edge/counters",
      headers: { "x-scf-edge-node": node, "content-type": "application/json" },
      payload: body as object,
    });
    const ct = res.headers["content-type"] as string | undefined;
    const parsed = res.body.length > 0 ? res.json() : undefined;
    expect(h.openapi.validateResponse("edgePostCounters", res.statusCode, ct, parsed)).toEqual([]);
    return res;
  }

  it("applies a record once (a duplicate answers 200 without applying) and sums spool accounting", async () => {
    const node = `edge-${randomUUID().slice(0, 6)}`;
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    const s = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "C" },
      })
    ).json();
    const rec = record(node, t, s.site_id);
    expect((await post(rec, node)).statusCode).toBe(200);
    expect((await post(rec, node)).statusCode).toBe(200);
    const web = await h.su.query(
      `SELECT counter, label, count::int FROM scf.web_edge_counters WHERE site_id = $1 ORDER BY counter`,
      [s.site_id],
    );
    expect(web.rows).toEqual([
      { counter: "kit_present_pageviews", label: "all", count: 37 },
      { counter: "verdict", label: "verified", count: 420 },
    ]);
    const otlp = await h.su.query(
      `SELECT reason, count::int, service_id FROM scf.api_ingest_counters WHERE tenant_id = $1`,
      [t],
    );
    expect(otlp.rows).toEqual([
      { reason: "rate_limited", count: 3, service_id: "00000000-0000-0000-0000-000000000000" },
    ]);

    const second = record(node, t, s.site_id, { web: [], otlp: [] });
    (second.spool as Record<string, unknown>).boot_id = rec.spool.boot_id;
    delete (second.spool as Record<string, unknown>).queued_at_day_start;
    (second.spool as Record<string, unknown>).queued = 3;
    second.period_end_ms = (rec.period_end_ms as number) + 60_000;
    expect((await post(second, node)).statusCode).toBe(200);
    const acc = await h.su.query(
      `SELECT queued_start::int, fsynced::int, acked_stored::int, acked_engine_bot::int, queued_end::int, restarts FROM scf.edge_spool_accounting WHERE node_id = $1`,
      [node],
    );
    expect(acc.rows).toEqual([
      {
        queued_start: 2,
        fsynced: 862,
        acked_stored: 856,
        acked_engine_bot: 2,
        queued_end: 3,
        restarts: 0,
      },
    ]);

    // A visible site of the tenant shows the counters as today's verified events.
    const view = (
      await call(h, { method: "GET", url: `/v1/tenants/${t}/sites/${s.site_id}`, cookie: owner })
    ).json();
    expect(view.limits.verified_events_today).toBe(420);
  });

  it("counts a new boot_id within a day as a restart", async () => {
    const node = `edge-${randomUUID().slice(0, 6)}`;
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    const s = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "R" },
      })
    ).json();
    await post(record(node, t, s.site_id), node);
    await post(record(node, t, s.site_id), node); // another boot_id
    const acc = await h.su.query(
      `SELECT restarts FROM scf.edge_spool_accounting WHERE node_id = $1`,
      [node],
    );
    expect(acc.rows[0].restarts).toBe(1);
  });

  it("drops rows naming another tenant's site and updates token last-use under the entry's tenant_id (§d.3)", async () => {
    const node = `edge-${randomUUID().slice(0, 6)}`;
    const a = await signInGithub(h, newGithubUser());
    const ta = await createTenant(h, a);
    const b = await signInGithub(h, newGithubUser());
    const tb = await createTenant(h, b);
    const sb = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${tb}/sites`,
        cookie: b,
        body: { name: "B" },
      })
    ).json();
    const user = (await call(h, { method: "GET", url: "/v1/me", cookie: a })).json().user_id;
    const token = `Lu${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await h.su.query(
      `INSERT INTO scf.ingest_tokens (tenant_id, token_id, secret_hash, last4, label, created_by) VALUES ($1, $2, $3, 'abcd', 'x', $4)`,
      [ta, token, Buffer.alloc(32, 1), user],
    );
    const used = Date.now() - 5000;
    const rec = record(node, ta, sb.site_id, {
      otlp: [],
      tokens: [
        { token_id: token, tenant_id: ta, last_used_ms: used },
        // The same token named under another tenant changes nothing (its update runs in tenant B's context).
        { token_id: token, tenant_id: tb, last_used_ms: used + 4000 },
      ],
    });
    expect((await post(rec, node)).statusCode).toBe(200);
    const leaked = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.web_edge_counters WHERE site_id = $1`,
      [sb.site_id],
    );
    expect(leaked.rows[0].n).toBe(0);
    const tok = await h.su.query(`SELECT last_used_at FROM scf.ingest_tokens WHERE token_id = $1`, [
      token,
    ]);
    expect(Math.abs(new Date(tok.rows[0].last_used_at).getTime() - used)).toBeLessThan(1000);
    // A token entry without tenant_id is malformed (§d.3).
    const bad = record(node, ta, sb.site_id, { tokens: [{ token_id: token, last_used_ms: used }] });
    expect((await post(bad, node)).statusCode).toBe(400);
  });

  it("counts restarts from the stored last_boot_id, across control-plane restarts and out-of-order retries (0051)", async () => {
    const node = `edge-${randomUUID().slice(0, 6)}`;
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    const s = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "B" },
      })
    ).json();
    const now = Date.now();
    const a = record(node, t, s.site_id, { period_end_ms: now - 120_000 });
    expect((await post(a, node)).statusCode).toBe(200);
    const stored = await h.su.query(
      `SELECT last_boot_id::text AS b, restarts FROM scf.edge_spool_accounting WHERE node_id = $1`,
      [node],
    );
    expect(stored.rows[0]).toEqual({ b: a.spool.boot_id, restarts: 0 });

    // A second control-plane process (no shared memory) sees the next boot as a restart.
    const other = await buildApps({
      config: h.config,
      db: h.db,
      tracker: loadTrackerRegistry(undefined, undefined),
      horizon: h.horizon,
    });
    await other.internalApp.ready();
    const b = record(node, t, s.site_id, { period_end_ms: now });
    const res = await other.internalApp.inject({
      method: "POST",
      url: "/internal/v1/edge/counters",
      headers: { "x-scf-edge-node": node, "content-type": "application/json" },
      payload: b,
    });
    expect(res.statusCode).toBe(200);
    await other.internalApp.close();
    await other.publicApp.close();

    // A late record of the earlier boot (retry from the spool) is not a restart and does not move last_boot_id.
    const late = record(node, t, s.site_id, { period_end_ms: now - 60_000 });
    (late.spool as Record<string, unknown>).boot_id = a.spool.boot_id;
    expect((await post(late, node)).statusCode).toBe(200);
    const acc = await h.su.query(
      `SELECT last_boot_id::text AS b, restarts FROM scf.edge_spool_accounting WHERE node_id = $1`,
      [node],
    );
    expect(acc.rows[0]).toEqual({ b: b.spool.boot_id, restarts: 1 });
  });

  it("refuses a record from another node (401) and a malformed one (400)", async () => {
    const r = record("edge-b2", randomUUID(), randomUUID());
    expect((await post(r, "edge-a1")).statusCode).toBe(401);
    expect((await post({ ...r, extra: 1 }, "edge-b2")).statusCode).toBe(400);
    expect((await post({ ...r, rv: 2 }, "edge-b2")).statusCode).toBe(400);
    const res = await h.internal.inject({
      method: "POST",
      url: "/internal/v1/edge/counters",
      payload: r,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("internal listener identity (C-60, C-114)", () => {
  it("a plain-HTTP listener trusts the node header only from loopback", async () => {
    const res = await h.internal.inject({
      method: "GET",
      url: "/internal/v1/edge/snapshot",
      headers: { "x-scf-edge-node": NODE },
      remoteAddress: "10.1.2.3",
    });
    expect(res.statusCode).toBe(401);
  });

  it("the node name follows the one pattern ^[a-z0-9][a-z0-9-]{1,31}$", async () => {
    expect((await latest({ "x-scf-edge-node": "-edge" })).statusCode).toBe(401);
    expect((await latest({ "x-scf-edge-node": "e" })).statusCode).toBe(401);
  });

  describe("with mutual TLS", () => {
    let dir: string;
    let base: string;
    let close: () => Promise<void>;
    const pem = (n: string) => readFileSync(join(dir, n), "utf8");

    function openssl(args: string[]): void {
      execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
    }
    function leaf(name: string, cn: string, ca: string, ext: string): void {
      openssl([
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        `${name}.key`,
      ]);
      openssl([
        "req",
        "-new",
        "-key",
        `${name}.key`,
        "-subj",
        `/OU=reader/CN=${cn}`,
        "-out",
        `${name}.csr`,
      ]);
      writeFileSync(join(dir, `${name}.ext`), ext);
      openssl([
        "x509",
        "-req",
        "-in",
        `${name}.csr`,
        "-CA",
        `${ca}.crt`,
        "-CAkey",
        `${ca}.key`,
        "-CAcreateserial",
        "-days",
        "2",
        "-extfile",
        `${name}.ext`,
        "-out",
        `${name}.crt`,
      ]);
    }
    function ca(name: string): void {
      openssl([
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        `${name}.key`,
      ]);
      openssl([
        "req",
        "-x509",
        "-new",
        "-key",
        `${name}.key`,
        "-subj",
        `/CN=${name}`,
        "-days",
        "2",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign",
        "-out",
        `${name}.crt`,
      ]);
    }

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "scf-wsf-pki-"));
      ca("ca");
      ca("rogue-ca");
      const client = "extendedKeyUsage=clientAuth\n";
      leaf(
        "server",
        "control-plane",
        "ca",
        "extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n",
      );
      leaf("proxy", "core-a", "ca", client);
      leaf("stranger", "core-x", "ca", client);
      leaf("rogue", "core-a", "rogue-ca", client);
      const config = loadConfig({
        SCF_PORTAL_ORIGIN: "https://portal.test",
        SCF_DATABASE_URL: "postgres://unused",
        SCF_INTERNAL_LISTEN_HOST: "127.0.0.1",
        SCF_INTERNAL_TLS_CERT: pem("server.crt"),
        SCF_INTERNAL_TLS_KEY: pem("server.key"),
        SCF_INTERNAL_TLS_CA: pem("ca.crt"),
        SCF_INTERNAL_ALLOWED_CLIENTS: "core-a",
      });
      const apps = await buildApps({
        config,
        db: h.db,
        tracker: loadTrackerRegistry(undefined, undefined),
        horizon: h.horizon,
      });
      await apps.internalApp.listen({ host: "127.0.0.1", port: 0 });
      base = `https://127.0.0.1:${(apps.internalApp.server.address() as AddressInfo).port}`;
      close = async () => {
        await apps.internalApp.close();
        await apps.publicApp.close();
      };
    });
    afterAll(async () => {
      await close?.();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function get(client: string | null, node?: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          `${base}/internal/v1/edge/snapshot`,
          {
            ca: pem("ca.crt"),
            ...(client ? { cert: pem(`${client}.crt`), key: pem(`${client}.key`) } : {}),
            headers: node ? { "x-scf-edge-node": node } : {},
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    }

    it("accepts the node header only from an allowed, verified engine-proxy certificate", async () => {
      await builder.build();
      expect(await get("proxy", NODE)).toBe(200);
      expect(await get("proxy")).toBe(401); // no node header
      expect(await get("stranger", NODE)).toBe(401); // verified certificate, CN not allowed
      await expect(get("rogue", NODE)).rejects.toThrow(); // other CA: handshake refused
      await expect(get(null, NODE)).rejects.toThrow(); // no client certificate
    });
  });
});
