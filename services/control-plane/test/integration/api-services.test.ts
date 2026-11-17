// SPDX-License-Identifier: Apache-2.0
// API services, declared contracts and ingest tokens against real PostgreSQL behind PgBouncer (data-model §8.6, §8.7;
// wire-formats §k, §e; C-06, C-19, C-21, C-87). Every response is validated against the OpenAPI document by `call()`,
// which also checks the audit row of each successful audited call.

import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  readSnapshotContent,
  SnapshotBuilder,
  SnapshotSigner,
  verifyEnvelope,
} from "../../src/edge/snapshot.ts";
import { parseKey } from "../../src/keys/keys.ts";
import { loadTrackerRegistry } from "../../src/tracker.ts";
import { contractId, createService } from "../support/api-seed.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
  TEST_PEPPERS,
} from "../support/harness.ts";

let h: Harness;
let owner = "";

async function makeL1(t: string): Promise<void> {
  await h.su.query(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, 'domain', $2)`,
    [t, `${randomUUID().slice(0, 8)}.example`],
  );
}

beforeAll(async () => {
  h = await startHarness();
});
// A fresh user per test: creations are rate-limited per user (C-64: 20 per hour).
beforeEach(async () => {
  owner = await signInGithub(h, newGithubUser());
});
afterAll(async () => {
  await h?.close();
});

describe("API services (data-model §8.6, C-21)", () => {
  it("registers, lists, reads, updates and archives a service; audit rows per change", async () => {
    const tenant = await createTenant(h, owner);
    const created = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/services`,
      cookie: owner,
      body: {
        service_name: "horizon-proxy",
        display_name: "Horizon proxy",
        declared_base_url: "https://api.example.org/v1",
        read_only_api: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const s = created.json();
    expect(s).toMatchObject({
      service_name: "horizon-proxy",
      display_name: "Horizon proxy",
      declared_base_url: "https://api.example.org/v1",
      read_only_api: true,
      rpc_method_dimension: false,
      registration: "portal",
      status: "active",
      stream_groups: [],
      multiple_groups_warning: false,
    });
    const list = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/services`,
      cookie: owner,
    });
    expect(list.json().map((x: { service_id: string }) => x.service_id)).toContain(s.service_id);
    const got = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/services/${s.service_id}`,
      cookie: owner,
    });
    expect(got.json()).toEqual(s);

    const upd = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${tenant}/services/${s.service_id}`,
      cookie: owner,
      body: { display_name: null, declared_base_url: null, rpc_method_dimension: true },
    });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json()).toMatchObject({
      display_name: null,
      declared_base_url: null,
      rpc_method_dimension: true,
      read_only_api: true,
    });
    const arch = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${tenant}/services/${s.service_id}`,
      cookie: owner,
      body: { status: "archived" },
    });
    expect(arch.json().status).toBe("archived");
    const actions = (
      await h.su.query<{ action: string }>(
        `SELECT action FROM scf.audit_log WHERE tenant_id = $1 AND target_id = $2 ORDER BY seq`,
        [tenant, s.service_id],
      )
    ).rows.map((r) => r.action);
    expect(actions).toEqual(["service.created", "service.updated", "service.archived"]);
    const back = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${tenant}/services/${s.service_id}`,
      cookie: owner,
      body: { status: "active" },
    });
    expect(back.json().status).toBe("active");
    const row = await h.su.query(`SELECT archived_at FROM scf.api_services WHERE service_id = $1`, [
      s.service_id,
    ]);
    expect(row.rows[0].archived_at).toBeNull();
  });

  it("refuses a duplicate service_name (409), a non-https base URL (400) and a malformed name (400)", async () => {
    const t = await createTenant(h, owner);
    await makeL1(t);
    await createService(h, owner, t, "dup");
    const dup = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/services`,
      cookie: owner,
      body: { service_name: "dup" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("conflict");
    for (const body of [
      { service_name: "x", declared_base_url: "http://api.example.org" },
      { service_name: "x", declared_base_url: "https://api.example.org/?q=1" },
      { service_name: "has space" },
      { service_name: "" },
    ]) {
      const r = await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/services`,
        cookie: owner,
        body,
      });
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    const sid = await createService(h, owner, t, "patchme");
    const bad = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${t}/services/${sid}`,
      cookie: owner,
      body: { declared_base_url: "ftp://x" },
    });
    expect(bad.statusCode).toBe(400);
    const empty = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${t}/services/${sid}`,
      cookie: owner,
      body: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it("caps services at 1 for L0 and 20 at L1+, counting auto-registered services too (C-19, C-21)", async () => {
    const t = await createTenant(h, owner);
    await createService(h, owner, t, "first");
    const second = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/services`,
      cookie: owner,
      body: { service_name: "second" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("quota_exceeded");
    await makeL1(t);
    // an auto-registered service (writer) counts against the same quota
    await h.su.query(
      `INSERT INTO scf.api_services (tenant_id, service_name, registration) VALUES ($1, 'auto-one', 'auto')`,
      [t],
    );
    // 2…19 directly (the creation rate limit allows 20 per user and hour), the 20th through the API
    for (let i = 2; i < 19; i++)
      await h.su.query(
        `INSERT INTO scf.api_services (tenant_id, service_name, registration, created_by)
         SELECT $1, $2, 'portal', user_id FROM scf.memberships WHERE tenant_id = $1 AND role = 'owner'`,
        [t, `svc-${i}`],
      );
    await createService(h, owner, t, "svc-19");
    const over = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/services`,
      cookie: owner,
      body: { service_name: "twenty-first" },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe("quota_exceeded");
    const list = await call(h, { method: "GET", url: `/v1/tenants/${t}/services`, cookie: owner });
    expect(list.json()).toHaveLength(20);
    expect(
      list.json().find((x: { service_name: string }) => x.service_name === "auto-one").registration,
    ).toBe("auto");
  });

  it("shows stream groups with today's preferred group and the multiple-groups warning (C-22)", async () => {
    const t = await createTenant(h, owner);
    const sid = await createService(h, owner, t, "groups");
    const g = async (kind: string, metric: string, scope: string, rank: string) =>
      (
        await h.su.query<{ id: string }>(
          `INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING group_id::text AS id`,
          [t, sid, kind, metric, scope, rank],
        )
      ).rows[0]?.id as string;
    const legacy = await g(
      "sdk_legacy",
      "http.server.duration",
      "opentelemetry.instrumentation.fastapi",
      "2|010|x",
    );
    const stable = await g(
      "sdk_stable",
      "http.server.request.duration",
      "@opentelemetry/instrumentation-http",
      "1|050|y",
    );
    for (const id of [legacy, stable])
      await h.su.query(
        `INSERT INTO scf.api_service_day_groups (tenant_id, service_id, day, stream_group_id)
         VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, $3)`,
        [t, sid, id],
      );
    const s = (
      await call(h, { method: "GET", url: `/v1/tenants/${t}/services/${sid}`, cookie: owner })
    ).json();
    expect(s.multiple_groups_warning).toBe(true);
    expect(s.stream_groups).toEqual([
      {
        kind: "sdk_stable",
        metric_name: "http.server.request.duration",
        scope_name: "@opentelemetry/instrumentation-http",
        preferred_today: true,
      },
      {
        kind: "sdk_legacy",
        metric_name: "http.server.duration",
        scope_name: "opentelemetry.instrumentation.fastapi",
        preferred_today: false,
      },
    ]);
  });
});

describe("declared contracts (C-19, C-87)", () => {
  it("declares, lists and removes; a duplicate is 409; re-declaring after removal starts as declared", async () => {
    const t = await createTenant(h, owner);
    const sid = await createService(h, owner, t, "contracts");
    const cid = contractId();
    const res = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/contracts`,
      cookie: owner,
      body: { contract_id: cid, network: "public", label: "router", service_id: sid },
    });
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({
      contract_id: cid,
      network: "public",
      label: "router",
      service_id: sid,
      status: "declared",
      verified_role: null,
    });
    const dup = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/contracts`,
      cookie: owner,
      body: { contract_id: cid, network: "public" },
    });
    expect(dup.statusCode).toBe(409);
    // the same contract on the other network is a different declaration
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/tenants/${t}/contracts`,
          cookie: owner,
          body: { contract_id: cid, network: "testnet" },
        })
      ).statusCode,
    ).toBe(201);
    const list = await call(h, { method: "GET", url: `/v1/tenants/${t}/contracts`, cookie: owner });
    expect(list.json()).toHaveLength(2);

    // pretend the ledger check verified it, then remove and re-declare: verification does not survive (C-19)
    const ev = await h.su.query<{ id: string }>(
      `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, 'stellar_account', $2)
       RETURNING evidence_id::text AS id`,
      [t, `G${contractId().slice(1)}`],
    );
    await h.su.query(
      `UPDATE scf.declared_contracts SET status = 'verified', verified_role = 'deployer', verified_by_evidence = $2,
              verified_at = now() WHERE contract_ref = $1`,
      [c.contract_ref, ev.rows[0]?.id],
    );
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/tenants/${t}/contracts/${c.contract_ref}`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(204);
    const again = await call(h, {
      method: "DELETE",
      url: `/v1/tenants/${t}/contracts/${c.contract_ref}`,
      cookie: owner,
    });
    expect(again.statusCode).toBe(404);
    const list2 = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t}/contracts`,
      cookie: owner,
    });
    expect(list2.json().map((x: { network: string }) => x.network)).toEqual(["testnet"]);
    const re = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/contracts`,
      cookie: owner,
      body: { contract_id: cid, network: "public" },
    });
    expect(re.statusCode).toBe(201);
    expect(re.json()).toMatchObject({
      contract_ref: c.contract_ref,
      status: "declared",
      verified_role: null,
      service_id: null,
    });
  });

  it("a service_id of another tenant or an unknown one is the same 404 (C-87)", async () => {
    const strangerCookie = await signInGithub(h, newGithubUser());
    const other = await createTenant(h, strangerCookie);
    const foreignService = await createService(h, strangerCookie, other, "theirs");
    const t = await createTenant(h, owner);
    const a = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/contracts`,
      cookie: owner,
      body: { contract_id: contractId(), network: "public", service_id: foreignService },
    });
    const b = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/contracts`,
      cookie: owner,
      body: { contract_id: contractId(), network: "public", service_id: randomUUID() },
    });
    expect(a.statusCode).toBe(404);
    expect({ ...a.json(), request_id: "" }).toEqual({ ...b.json(), request_id: "" });
    const bad = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/contracts`,
      cookie: owner,
      body: { contract_id: "GABC", network: "public" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("ingest tokens (wire-formats §k, C-06, C-21, C-81)", () => {
  it("shows the token once, stores only id, last4 and the HMAC under the pepper version; lists metadata only", async () => {
    const t = await createTenant(h, owner);
    await createService(h, owner, t, "horizon-proxy");
    const res = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/ingest-tokens`,
      cookie: owner,
      body: { label: "production collector", allowed_service_names: ["horizon-proxy"] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const tok = res.json();
    const parsed = parseKey(tok.token, "ing");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(tok.token_id).toBe(parsed.key.id);
    expect(tok.display).toBe(`scfa_ing_${parsed.key.id}_…${parsed.key.secret.slice(-4)}`);
    expect(tok).toMatchObject({
      label: "production collector",
      allowed_service_names: ["horizon-proxy"],
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
      rotation_reminder: false,
    });
    const row = (
      await h.su.query(`SELECT * FROM scf.ingest_tokens WHERE token_id = $1`, [tok.token_id])
    ).rows[0];
    expect(row.pepper_version).toBe(1);
    expect(row.last4).toBe(parsed.key.secret.slice(-4));
    expect(
      (row.secret_hash as Buffer).equals(
        createHmac("sha256", TEST_PEPPERS.ing).update(parsed.key.secret).digest(),
      ),
    ).toBe(true);
    // the full token is nowhere in the database, the audit log or the logs
    const dump = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.audit_log WHERE details::text LIKE '%' || $1 || '%'`,
      [parsed.key.secret],
    );
    expect(dump.rows[0].n).toBe(0);
    expect(h.logs.text).not.toContain(parsed.key.secret);
    const list = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t}/ingest-tokens`,
      cookie: owner,
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).not.toHaveProperty("token");
    expect(JSON.stringify(list.json())).not.toContain(parsed.key.secret);
  });

  it("allows at most 5 active tokens (409), refuses unknown service names (404) and past expiry (400)", async () => {
    const t = await createTenant(h, owner);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/ingest-tokens`,
        cookie: owner,
        body: { label: `t${i}` },
      });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(r.json().token_id);
    }
    const sixth = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/ingest-tokens`,
      cookie: owner,
      body: { label: "t6" },
    });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().code).toBe("quota_exceeded");
    await call(h, {
      method: "DELETE",
      url: `/v1/tenants/${t}/ingest-tokens/${ids[0]}`,
      cookie: owner,
    });
    expect(
      (
        await call(h, {
          method: "POST",
          url: `/v1/tenants/${t}/ingest-tokens`,
          cookie: owner,
          body: { label: "t6" },
        })
      ).statusCode,
    ).toBe(201);
    const t2 = await createTenant(h, owner);
    const unknown = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t2}/ingest-tokens`,
      cookie: owner,
      body: { label: "x", allowed_service_names: ["nope"] },
    });
    expect(unknown.statusCode).toBe(404);
    const past = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t2}/ingest-tokens`,
      cookie: owner,
      body: { label: "x", expires_at: "2020-01-01T00:00:00Z" },
    });
    expect(past.statusCode).toBe(400);
    const future = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t2}/ingest-tokens`,
      cookie: owner,
      body: { label: "x", expires_at: "2099-01-01T00:00:00Z" },
    });
    expect(future.json().expires_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("flags tokens older than 12 months for rotation (C-21)", async () => {
    const t = await createTenant(h, owner);
    const r = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/ingest-tokens`,
      cookie: owner,
      body: { label: "old" },
    });
    await h.su.query(
      `UPDATE scf.ingest_tokens SET created_at = now() - interval '13 months' WHERE token_id = $1`,
      [r.json().token_id],
    );
    const list = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t}/ingest-tokens`,
      cookie: owner,
    });
    expect(list.json()[0].rotation_reminder).toBe(true);
  });

  it("a created token reaches the signed edge snapshot verifiably; a revoked one leaves it (C-06)", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new SnapshotSigner(
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      "api-test",
    );
    const dir = new URL("../support/fixtures/tracker", import.meta.url).pathname;
    const opts = {
      pathnormRulesVersion: "scf-path-rules/1.0.0",
      tracker: loadTrackerRegistry(dir, join(dir, "releases.json")),
    };
    const builder = new SnapshotBuilder(h.jobsDb, signer, opts);
    const t = await createTenant(h, owner);
    const created = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/ingest-tokens`,
      cookie: owner,
      body: { label: "edge" },
    });
    const tok = created.json();
    const parsed = parseKey(tok.token, "ing");
    if (!parsed.ok) throw new Error("bad token");
    await builder.build();
    const env = await h.su.query<{ envelope: Buffer }>(
      `SELECT envelope FROM scf.edge_snapshots ORDER BY sequence DESC LIMIT 1`,
    );
    const payload = verifyEnvelope(env.rows[0]?.envelope as Buffer, {
      [signer.kid]: signer.publicKey,
    });
    const entry = payload.ingest_tokens.find((x) => x.token_id === tok.token_id);
    expect(entry).toBeDefined();
    // what the gateway does (TokenFor): HMAC-SHA-256(pepper_ing[pepper_version], secret) == hash
    expect(
      createHmac("sha256", TEST_PEPPERS.ing).update(parsed.key.secret).digest("base64url"),
    ).toBe(entry?.hash);

    // the revocation notifies the builder (NOTIFY scf_edge) and the next snapshot no longer carries the token
    const listen = await h.su.connect();
    const notified = new Promise<string>((resolve) =>
      listen.on("notification", (n) => resolve(n.channel)),
    );
    await listen.query("LISTEN scf_edge");
    const rev = await call(h, {
      method: "DELETE",
      url: `/v1/tenants/${t}/ingest-tokens/${tok.token_id}`,
      cookie: owner,
    });
    expect(rev.statusCode).toBe(204);
    expect(await notified).toBe("scf_edge");
    listen.release();
    const content = await h.jobsDb.tx(
      { tenantId: null, actorKind: "job", actorId: "edge_snapshot", job: "edge_snapshot" },
      (tx) => readSnapshotContent(tx, opts),
    );
    expect(content.ingest_tokens.find((x) => x.token_id === tok.token_id)).toBeUndefined();
    const r = await h.su.query(
      `SELECT revoked_at, revoked_by FROM scf.ingest_tokens WHERE token_id = $1`,
      [tok.token_id],
    );
    expect(r.rows[0].revoked_at).not.toBeNull();
    expect(r.rows[0].revoked_by).not.toBeNull();
    // revoking again is idempotent and audited; an unknown token is 404
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/tenants/${t}/ingest-tokens/${tok.token_id}`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/tenants/${t}/ingest-tokens/Abcdefghijk1`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("answers 503 when no ingest pepper is configured", async () => {
    const h2 = await startHarness({ SCF_PEPPER_ING: "" });
    try {
      const c = await signInGithub(h2, newGithubUser());
      const t = await createTenant(h2, c);
      const r = await call(h2, {
        method: "POST",
        url: `/v1/tenants/${t}/ingest-tokens`,
        cookie: c,
        body: { label: "x" },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().code).toBe("unavailable");
    } finally {
      await h2.close();
    }
  });
});
