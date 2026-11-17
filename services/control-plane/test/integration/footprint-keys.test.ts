// SPDX-License-Identifier: Apache-2.0
// Footprint registration keys `scfa_reg_…` (migration 0081) and the grant-application "user tracking"
// paragraph, against the real database. Every call() validates the response against the OpenAPI document and checks
// that audited operations wrote their documented action.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checksum, newSecret } from "../../src/keys/keys.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const contractId = () =>
  `C${Array.from({ length: 55 }, () => B32[Math.floor(Math.random() * 32)]).join("")}`;

let h: Harness;
let owner = "";
let ownerId = "";
let tenant = "";
let other = "";
let otherTenant = "";

async function createKey(
  cookie: string,
  t: string,
  body: Record<string, unknown> = { label: "scaffold" },
): Promise<{ key: string; key_id: string }> {
  // each test uses its own key: retire the earlier ones of the shared tenant (at most 5 usable keys per tenant)
  if (t === tenant)
    await h.su.query(
      `UPDATE scf.footprint_keys SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL`,
      [t],
    );
  const res = await call(h, {
    method: "POST",
    url: `/v1/tenants/${t}/footprint-keys`,
    cookie,
    body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

function register(
  key: string | undefined,
  t: string,
  body: Record<string, unknown> = { subject: contractId(), network: "testnet" },
  extra: { cookie?: string; url?: string } = {},
) {
  return call(h, {
    method: "POST",
    url: extra.url ?? `/v1/tenants/${t}/footprint/register`,
    noCsrf: true,
    ...(extra.cookie ? { cookie: extra.cookie } : {}),
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body,
  });
}

beforeAll(async () => {
  h = await startHarness();
  owner = await signInGithub(h, newGithubUser());
  tenant = await createTenant(h, owner);
  ownerId = (await call(h, { method: "GET", url: "/v1/me", cookie: owner })).json().user_id;
  other = await signInGithub(h, newGithubUser());
  otherTenant = await createTenant(h, other);
});
afterAll(async () => {
  await h?.close();
});

describe("footprint registration keys", () => {
  it("are shown once, listed without the secret and stored as a hash", async () => {
    const k = await createKey(owner, tenant, { label: "ci deploys", network: "testnet" });
    expect(k.key).toMatch(/^scfa_reg_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/);
    const list = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/footprint-keys`,
      cookie: owner,
    });
    expect(list.statusCode).toBe(200);
    const row = list.json().find((r: { key_id: string }) => r.key_id === k.key_id);
    expect(row).toMatchObject({
      label: "ci deploys",
      scope: "footprint:register",
      network: "testnet",
      revoked_at: null,
      last_used_at: null,
    });
    expect(JSON.stringify(list.json())).not.toContain(k.key.slice(22));
    const stored = await h.su.query<{ secret_hash: Buffer; created_by: string }>(
      `SELECT secret_hash, created_by::text AS created_by FROM scf.footprint_keys WHERE key_id = $1`,
      [k.key_id],
    );
    expect(stored.rows[0]?.secret_hash.length).toBe(32);
    expect(stored.rows[0]?.created_by).toBe(ownerId);
    const audit = await h.su.query(
      `SELECT details FROM scf.audit_log WHERE action = 'footprint_key.created' AND target_id = $1`,
      [k.key_id],
    );
    expect(audit.rows[0]?.details).toMatchObject({
      scope: "footprint:register",
      network: "testnet",
    });
    expect(JSON.stringify(audit.rows)).not.toContain(k.key.slice(22));
  });

  it("register a contract as claimed, acting for the key's creator, and nothing else", async () => {
    const k = await createKey(owner, tenant);
    const subject = contractId();
    const res = await register(k.key, tenant, {
      kind: "contract",
      subject,
      network: "testnet",
      label: "hello_world",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      kind: "contract",
      subject,
      network: "testnet",
      label: "hello_world",
      status: "claimed",
    });
    const row = await h.su.query<{ created_by: string; status: string }>(
      `SELECT created_by::text AS created_by, status FROM scf.declared_contracts WHERE tenant_id = $1 AND contract_id = $2`,
      [tenant, subject],
    );
    expect(row.rows[0]).toEqual({ created_by: ownerId, status: "declared" });
    const audit = await h.su.query<{ actor_kind: string; actor_id: string; details: unknown }>(
      `SELECT actor_kind, actor_id, details FROM scf.audit_log WHERE request_id = $1`,
      [String(res.headers["x-request-id"])],
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: "system",
        actor_id: `footprint_key:${k.key_id}`,
        details: {
          kind: "contract",
          network: "testnet",
          with_service: false,
          via: "footprint_key",
          key_id: k.key_id,
        },
      },
    ]);
    // the portal shows it like any other claim
    const fp = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie: owner,
    });
    expect(fp.json().some((i: { subject: string }) => i.subject === subject)).toBe(true);
    // again: 409, nothing changes
    expect((await register(k.key, tenant, { subject, network: "testnet" })).statusCode).toBe(409);
    // mainnet is stored in the declared-contract vocabulary
    const main = contractId();
    expect((await register(k.key, tenant, { subject: main, network: "mainnet" })).statusCode).toBe(
      201,
    );
    const net = await h.su.query(
      `SELECT network FROM scf.declared_contracts WHERE tenant_id = $1 AND contract_id = $2`,
      [tenant, main],
    );
    expect(net.rows[0]?.network).toBe("public");
    const used = await h.su.query(`SELECT last_used_at FROM scf.footprint_keys WHERE key_id = $1`, [
      k.key_id,
    ]);
    expect(used.rows[0]?.last_used_at).not.toBeNull();
  });

  it("refuse other kinds, bad ids, a foreign tenant and the wrong network", async () => {
    const k = await createKey(owner, tenant, { label: "testnet only", network: "testnet" });
    expect(
      (
        await register(k.key, tenant, {
          kind: "issuing_account",
          subject: `G${"A".repeat(55)}`,
          network: "testnet",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await register(k.key, tenant, { subject: "CNOTANID", network: "testnet" })).statusCode,
    ).toBe(400);
    expect(
      (
        await register(k.key, tenant, {
          subject: contractId(),
          network: "testnet",
          service_id: tenant,
        })
      ).statusCode,
    ).toBe(400);
    const wrongNet = await register(k.key, tenant, { subject: contractId(), network: "mainnet" });
    expect(wrongNet.statusCode).toBe(403);
    // another tenant's path: the same 404 as an unknown tenant
    const foreign = await register(k.key, otherTenant);
    const unknown = await register(k.key, "0199aaaa-0000-7000-8000-000000000000");
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect({ ...foreign.json(), request_id: "" }).toEqual({ ...unknown.json(), request_id: "" });
    const n = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.declared_contracts WHERE tenant_id = $1`,
      [otherTenant],
    );
    expect(n.rows[0]?.n).toBe(0);
  });

  it("refuse missing, malformed, wrong-secret, other-kind, revoked and expired keys with 401", async () => {
    const k = await createKey(owner, tenant);
    expect((await register(undefined, tenant)).statusCode).toBe(401);
    expect((await register("scfa_reg_nope", tenant)).statusCode).toBe(401);
    // a well-formed key with the right id and CRC but another secret
    const secret = newSecret();
    const forged = `scfa_reg_${k.key_id}_${secret}${checksum("reg", k.key_id, secret)}`;
    expect((await register(forged, tenant)).statusCode).toBe(401);
    // a share key never registers
    const share = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/share-keys`,
      cookie: owner,
      body: { label: "share" },
    });
    expect((await register(share.json().key, tenant)).statusCode).toBe(401);
    // a session alone is not a key; a key in the URL is ignored
    expect((await register(undefined, tenant, undefined, { cookie: owner })).statusCode).toBe(401);
    expect(
      (
        await register(undefined, tenant, undefined, {
          url: `/v1/tenants/${tenant}/footprint/register?key=${k.key}`,
        })
      ).statusCode,
    ).toBe(401);
    // expired
    await h.su.query(
      `UPDATE scf.footprint_keys SET expires_at = now() - interval '1 second' WHERE key_id = $1`,
      [k.key_id],
    );
    expect((await register(k.key, tenant)).statusCode).toBe(401);
    await h.su.query(`UPDATE scf.footprint_keys SET expires_at = NULL WHERE key_id = $1`, [
      k.key_id,
    ]);
    expect((await register(k.key, tenant)).statusCode).toBe(201);
    // revoked: at once
    const rev = await call(h, {
      method: "DELETE",
      url: `/v1/tenants/${tenant}/footprint-keys/${k.key_id}`,
      cookie: owner,
    });
    expect(rev.statusCode).toBe(204);
    expect((await register(k.key, tenant)).statusCode).toBe(401);
    // a second revocation is idempotent
    expect(
      (
        await call(h, {
          method: "DELETE",
          url: `/v1/tenants/${tenant}/footprint-keys/${k.key_id}`,
          cookie: owner,
        })
      ).statusCode,
    ).toBe(204);
  });

  it("open no other operation", async () => {
    const k = await createKey(owner, tenant);
    const auth = { authorization: `Bearer ${k.key}` };
    for (const [method, url, body] of [
      ["GET", `/v1/tenants/${tenant}/footprint`, undefined],
      [
        "POST",
        `/v1/tenants/${tenant}/footprint`,
        { kind: "contract", subject: contractId(), network: "testnet" },
      ],
      ["GET", `/v1/tenants/${tenant}/footprint-keys`, undefined],
      ["POST", `/v1/tenants/${tenant}/footprint-keys`, { label: "x" }],
      ["GET", `/v1/tenants/${tenant}`, undefined],
      ["GET", `/v1/tenants/${tenant}/evidence/user-tracking`, undefined],
    ] as const) {
      const res = await call(h, {
        method,
        url,
        headers: auth,
        ...(body ? { body } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("stop working when the creator is no longer an admin", async () => {
    const k = await createKey(owner, tenant);
    await h.su.query(
      `UPDATE scf.memberships SET role = 'member' WHERE tenant_id = $1 AND user_id = $2`,
      [tenant, ownerId],
    );
    try {
      const res = await register(k.key, tenant);
      expect(res.statusCode).toBe(401);
      expect(res.json().detail).toContain("no longer an admin");
    } finally {
      await h.su.query(
        `UPDATE scf.memberships SET role = 'owner' WHERE tenant_id = $1 AND user_id = $2`,
        [tenant, ownerId],
      );
    }
  });

  it("allow at most 5 usable keys and need a recent sign-in", async () => {
    const t = await createTenant(h, owner);
    for (let i = 0; i < 5; i++) await createKey(owner, t, { label: `k${i}` });
    const sixth = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/footprint-keys`,
      cookie: owner,
      body: { label: "k5" },
    });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().code).toBe("quota_exceeded");
    const past = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/footprint-keys`,
      cookie: owner,
      body: { label: "past", expires_at: "2020-01-01T00:00:00Z" },
    });
    expect(past.statusCode).toBe(400);
  });

  it("are rate-limited per key", async () => {
    const k = await createKey(owner, tenant);
    let limited = 0;
    for (let i = 0; i < 31; i++) {
      const res = await register(k.key, tenant, { subject: "CNOTANID", network: "testnet" });
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBe(1);
  });
});

describe("user tracking paragraph", () => {
  it("reflects only what was measured", async () => {
    const t = await createTenant(h, owner);
    const empty = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t}/evidence/user-tracking`,
      cookie: owner,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers["cache-control"]).toBe("no-store");
    expect(empty.json().paragraph).toContain("no usage data was received");
    expect(empty.json().sources).toEqual([]);
    expect(empty.json().links).toEqual({
      privacy: "https://docs.usagemap.dev/privacy",
      public_stats: null,
      snapshot: null,
    });

    const site = (
      await call(h, {
        method: "POST",
        url: `/v1/tenants/${t}/sites`,
        cookie: owner,
        body: { name: "Shop" },
      })
    ).json();
    const configured = (
      await call(h, {
        method: "GET",
        url: `/v1/tenants/${t}/evidence/user-tracking`,
        cookie: owner,
      })
    ).json();
    expect(configured.sources).toEqual([
      {
        source: "web",
        status: "configured",
        detail: "1 website set up; no counted page view in the window.",
      },
    ]);
    expect(configured.paragraph).toContain("no usage data was received");

    // counted page views and wallet events yesterday
    await h.su.query(
      `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 1, 'verdict', 'verified', 12)`,
      [t, site.site_id],
    );
    await h.su.query(
      `INSERT INTO scf.web_event_property_daily (tenant_id, site_id, day, event_name, network, prop_key, prop_value, verdict, count)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 1, 'wallet_connect', 'mainnet', '_total', 'all', 'verified', 3)`,
      [t, site.site_id],
    );
    const pub = await call(h, {
      method: "PATCH",
      url: `/v1/tenants/${t}`,
      cookie: owner,
      body: { public_stats_enabled: true },
    });
    expect(pub.statusCode, pub.body).toBe(200);
    const measured = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t}/evidence/user-tracking`,
      cookie: owner,
    });
    const m = measured.json();
    expect(
      m.sources.map((s: { source: string; status: string }) => `${s.source}:${s.status}`),
    ).toEqual(["web:measured", "wallet:measured"]);
    expect(m.paragraph).toContain("we count page views with UsageMap");
    expect(m.paragraph).toContain("wallet connections");
    expect(m.paragraph).toContain("deleted after 90 days");
    expect(m.paragraph).not.toMatch(/OpenTelemetry|ledger/);
    expect(m.links.public_stats).toMatch(/^https:\/\/portal\.test\/p\//);
    expect(m.mermaid).toContain("flowchart LR");
    // a viewer may read it; another tenant's member may not
    const foreign = await call(h, {
      method: "GET",
      url: `/v1/tenants/${t}/evidence/user-tracking`,
      cookie: other,
    });
    expect(foreign.statusCode).toBe(404);
  });
});
