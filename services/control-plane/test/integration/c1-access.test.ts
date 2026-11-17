// SPDX-License-Identifier: Apache-2.0
// Access regressions: a removed tenant's data is hidden from every tenant read (C-08); the platform never loses its
// last operator_admin — demotion, concurrent mutual revokes, account deletion (operator.global-view-credentials); the
// operator list counts live passkeys only (C-20); privacy-floor settings are validated (ADR-0027); and the platform
// read-only mode (ops.end-of-window-read-only): writes refused, data-subject rights kept, ingest paused at
// the edge through the signed snapshot, the switch visible in the published settings.

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SnapshotBuilder,
  type SnapshotPayload,
  SnapshotSigner,
  verifyEnvelope,
} from "../../src/edge/snapshot.ts";
import {
  READ_ONLY_DETAIL,
  REMOVED_TENANT_READABLE,
  SECOND_PASSKEY_DETAIL,
} from "../../src/http/pipeline.ts";
import { loadTrackerRegistry } from "../../src/tracker.ts";
import { SoftAuthenticator } from "../support/authenticator.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  operatorSession,
  PORTAL,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

let h: Harness;
let builder: SnapshotBuilder;
let signer: SnapshotSigner;
let admin = "";

const DAY = "2026-11-01T00:00:00Z";
const DAY2 = "2026-11-08T00:00:00Z";
/** Required query parameters of the tenant reads (everything else is optional). */
const QUERY: Record<string, string> = {
  listSiteTrustScores: `start=${DAY}&end=${DAY2}`,
  getSiteWalletFunnel: `start=${DAY}&end=${DAY2}`,
  getSiteBrowserRpc: `start=${DAY}&end=${DAY2}`,
  getApiAssurance: `start=${DAY}&end=${DAY2}`,
  getOnchainDaily: `start=${DAY}&end=${DAY2}`,
  getTenantUsageMap: `start=${DAY}&end=${DAY2}`,
  getTenantProtocols: `start=${DAY}&end=${DAY2}`,
  getWebBreakdown: "dimension=path",
  getOtelConfig: "stack=node",
  getWebFunnelReport: "step=path:/&step=path:/pricing",
  getWebGoalsReport: "goal=path:/pricing",
};

async function payloadNow(): Promise<SnapshotPayload> {
  await builder.build();
  const res = await h.internal.inject({
    method: "GET",
    url: "/internal/v1/edge/snapshot",
    headers: { "x-scf-edge-node": "edge-a1" },
  });
  expect(res.statusCode).toBe(200);
  return verifyEnvelope(res.body, { [signer.kid]: signer.publicKey });
}

const setReadOnly = (value: unknown, cookie = admin) =>
  call(h, {
    method: "PATCH",
    url: "/v1/operator/settings/read_only_mode",
    cookie,
    body: { value },
  });

beforeAll(async () => {
  h = await startHarness();
  const { privateKey } = generateKeyPairSync("ed25519");
  signer = new SnapshotSigner(
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    "c1-test",
  );
  const dir = new URL("../support/fixtures/tracker", import.meta.url).pathname;
  builder = new SnapshotBuilder(h.jobsDb, signer, {
    pathnormRulesVersion: "scf-path-rules/1.0.0",
    tracker: loadTrackerRegistry(dir, join(dir, "releases.json")),
  });
  // read_only_mode setting row (identical text to the migration): absent = read-only mode off.
  await h.su.query(
    `INSERT INTO scf.settings (key, value, public, description) VALUES
       ('read_only_mode', '{"enabled": false, "ingest": "accept"}', true,
        'Platform read-only mode (OPS-17): enabled refuses writes except data-subject rights, removals and revocations; ingest accept | pause')
     ON CONFLICT (key) DO NOTHING`,
  );
  admin = (await operatorSession(h, "operator_admin")).cookie;
});
afterAll(async () => {
  if (h && admin) await setReadOnly({ enabled: false, ingest: "accept" });
  await h?.close();
});

describe("a removed tenant's data is hidden from every tenant read (C-08)", () => {
  it("every tenant-scoped GET of the document answers 404 once the tenant is removed, except the allow-list", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    const site = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/sites`,
      cookie: owner,
      body: { name: "Main" },
    });
    expect(site.statusCode, site.body).toBe(201);
    const svc = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/services`,
      cookie: owner,
      body: {
        service_name: "removed-api",
        display_name: "Removed API",
        declared_base_url: "https://api.example.org/v1",
        read_only_api: true,
      },
    });
    expect(svc.statusCode, svc.body).toBe(201);
    const ids: Record<string, string> = {
      tenantId: t,
      siteId: site.json().site_id,
      serviceId: svc.json().service_id,
    };
    const reads = h.openapi.operations.filter(
      (o) => o.method === "get" && !o.internal && o.roles.some((r) => r.startsWith("tenant:")),
    );
    expect(reads.length).toBeGreaterThanOrEqual(36);
    const urlOf = (o: (typeof reads)[number]) => {
      const path = o.path.replace(/\{(\w+)\}/g, (_m, p: string) => ids[p] ?? randomUUID());
      const q = QUERY[o.operationId];
      return q ? `${path}?${q}` : path;
    };
    const known = (o: (typeof reads)[number]) => o.pathParams.every((p) => p in ids);

    // Before: every read naming only existing objects answers something other than 404 / 400.
    for (const o of reads.filter(known)) {
      const res = await call(h, { method: "GET", url: urlOf(o), cookie: owner });
      expect([400, 404], `${o.operationId} before removal: ${res.body}`).not.toContain(
        res.statusCode,
      );
    }

    const removed = await call(h, {
      method: "POST",
      url: `/v1/operator/tenants/${t}/removal`,
      cookie: admin,
      body: { reason: "c1 hidden-data test" },
    });
    expect(removed.statusCode, removed.body).toBe(200);

    for (const o of reads) {
      const res = await call(h, { method: "GET", url: urlOf(o), cookie: owner });
      if (REMOVED_TENANT_READABLE.has(o.operationId) && known(o))
        expect(res.statusCode, `${o.operationId} stays readable`).toBe(200);
      else if (!REMOVED_TENANT_READABLE.has(o.operationId))
        expect(res.statusCode, `${o.operationId} after removal: ${res.body}`).toBe(404);
    }
    const tenant = await call(h, { method: "GET", url: `/v1/tenants/${t}`, cookie: owner });
    expect(tenant.json().status).toBe("removed");
  });
});

describe("the last operator_admin never disappears (operator.global-view-credentials, C-20)", () => {
  it("concurrent mutual revokes, self-demotion and account deletion all keep one admin", async () => {
    const a = await operatorSession(h, "operator_admin");
    const b = await operatorSession(h, "operator_admin");
    // Only A and B are admins from here on (other files' admins are retired as superuser; the database allows it,
    // since A and B remain).
    await h.su.query(
      `UPDATE scf.platform_operators SET revoked_at = now()
        WHERE role = 'operator_admin' AND revoked_at IS NULL AND user_id <> ALL($1::uuid[])`,
      [[a.userId, b.userId]],
    );
    // Both requests pass authentication and then wait on the admin-set lock, held here, so they really overlap.
    const holder = await h.su.connect();
    let ra: Awaited<ReturnType<typeof call>>;
    let rb: Awaited<ReturnType<typeof call>>;
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT pg_advisory_xact_lock(hashtext('scf.platform_operators.admin_set'))`,
      );
      const both = Promise.all([
        call(h, { method: "DELETE", url: `/v1/operator/operators/${b.userId}`, cookie: a.cookie }),
        call(h, { method: "DELETE", url: `/v1/operator/operators/${a.userId}`, cookie: b.cookie }),
      ]);
      for (let i = 0; i < 100; i++) {
        const w = await h.su.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        if (w.rows[0].n >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query("COMMIT");
      [ra, rb] = await both;
    } finally {
      holder.release();
    }
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes, `${ra.body} ${rb.body}`).toEqual([204, 409]);
    const n = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.platform_operators WHERE role = 'operator_admin' AND revoked_at IS NULL`,
    );
    expect(n.rows[0].n).toBe(1);
    const last = ra.statusCode === 204 ? a : b;

    // (a) granting `operator` to the last operator_admin (here: oneself) is a demotion and refused
    const demote = await call(h, {
      method: "POST",
      url: "/v1/operator/operators",
      cookie: last.cookie,
      body: { user_id: last.userId, role: "operator" },
    });
    expect(demote.statusCode, demote.body).toBe(409);
    // (c) the last operator_admin cannot delete the account (nor any operator: the grant goes first)
    const del = await call(h, { method: "DELETE", url: "/v1/me", cookie: last.cookie });
    expect(del.statusCode, del.body).toBe(409);
    const still = await h.su.query(
      `SELECT role::text AS role FROM scf.platform_operators o JOIN scf.users u USING (user_id)
        WHERE o.user_id = $1 AND o.revoked_at IS NULL AND u.deleted_at IS NULL`,
      [last.userId],
    );
    expect(still.rows).toEqual([{ role: "operator_admin" }]);

    // With a second admin again, a demotion of the first is allowed.
    const c = await operatorSession(h, "operator_admin");
    const ok = await call(h, {
      method: "POST",
      url: "/v1/operator/operators",
      cookie: c.cookie,
      body: { user_id: last.userId, role: "operator" },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    admin = c.cookie;
  });

  it("a plain operator cannot delete the account while the grant is active", async () => {
    const op = await operatorSession(h, "operator");
    const del = await call(h, { method: "DELETE", url: "/v1/me", cookie: op.cookie });
    expect(del.statusCode, del.body).toBe(409);
  });
});

describe("operator passkeys (C-20)", () => {
  it("revoked passkeys are not counted", async () => {
    const op = await operatorSession(h, "operator");
    const before = (await call(h, { method: "GET", url: "/v1/operator/operators", cookie: admin }))
      .json()
      .find((o: { user_id: string }) => o.user_id === op.userId);
    expect(before.passkey_count).toBe(2);
    await h.su.query(
      `UPDATE scf.passkey_credentials SET revoked_at = now()
        WHERE credential_id = (SELECT credential_id FROM scf.passkey_credentials
                                WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1)`,
      [op.userId],
    );
    const after = (await call(h, { method: "GET", url: "/v1/operator/operators", cookie: admin }))
      .json()
      .find((o: { user_id: string }) => o.user_id === op.userId);
    expect(after.passkey_count).toBe(1);
  });

  it("an operator with one live passkey is refused operator operations until a second one is registered", async () => {
    const op = await operatorSession(h, "operator", { passkeys: 1 });
    const refused = await call(h, {
      method: "GET",
      url: "/v1/operator/settings",
      cookie: op.cookie,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().detail).toBe(SECOND_PASSKEY_DETAIL);
    // registering the second passkey stays open (the assertion that completed sign-in is a fresh step-up)
    const auth = new SoftAuthenticator("portal.test", PORTAL);
    const o = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      cookie: op.cookie,
    });
    const v = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/verify",
      cookie: op.cookie,
      body: auth.register(o.json()),
    });
    expect(v.statusCode, v.body).toBeLessThan(300);
    const ok = await call(h, { method: "GET", url: "/v1/operator/settings", cookie: op.cookie });
    expect(ok.statusCode).toBe(200);
  });
});

describe("privacy-floor settings are validated (ADR-0027)", () => {
  it.each([
    ["op_min_count", 0],
    ["op_min_count", 4],
    ["op_min_count", "10"],
    ["op_min_count", 10.5],
    ["op_round_to", 0],
    ["op_round_to", 101],
    ["tenant_min_count", 1],
    ["tenant_round_to", null],
  ])("%s = %j is refused with 422", async (key, value) => {
    const res = await call(h, {
      method: "PATCH",
      url: `/v1/operator/settings/${key}`,
      cookie: admin,
      body: { value },
    });
    expect(res.statusCode, res.body).toBe(422);
  });

  it("a value in range is accepted", async () => {
    const res = await call(h, {
      method: "PATCH",
      url: "/v1/operator/settings/op_min_count",
      cookie: admin,
      body: { value: 10 },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("platform read-only mode (ops.end-of-window-read-only)", () => {
  it("refuses writes, keeps data-subject rights, pauses ingest at the edge, and is published", async () => {
    const owner = await signInGithub(h, newGithubUser());
    const t = await createTenant(h, owner);
    expect((await setReadOnly({ enabled: true })).statusCode).toBe(422);
    expect((await setReadOnly({ enabled: "yes", ingest: "accept" })).statusCode).toBe(422);
    const on = await setReadOnly({ enabled: true, ingest: "pause" });
    expect(on.statusCode, on.body).toBe(200);

    const published = (await call(h, { method: "GET", url: "/public/v1/thresholds" }))
      .json()
      .find((s: { key: string }) => s.key === "read_only_mode");
    expect(published.value).toEqual({ enabled: true, ingest: "pause" });

    const write = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/sites`,
      cookie: owner,
      body: { name: "Refused" },
    });
    expect(write.statusCode, write.body).toBe(403);
    expect(write.json().detail).toBe(READ_ONLY_DETAIL);
    const create = await call(h, {
      method: "POST",
      url: "/v1/tenants",
      cookie: owner,
      body: { slug: `ro-${randomUUID().slice(0, 8)}`, name: "Refused" },
    });
    expect(create.statusCode).toBe(403);
    // data-subject rights stay available
    const profile = await call(h, {
      method: "PATCH",
      url: "/v1/me",
      cookie: owner,
      body: { display_name: "Still editable" },
    });
    expect(profile.statusCode, profile.body).toBe(200);
    // reads keep working
    expect(
      (await call(h, { method: "GET", url: `/v1/tenants/${t}`, cookie: owner })).statusCode,
    ).toBe(200);
    // ingest paused: every tenant is published as suspended (gateway counts tenant_suspended, OTLP answers 403)
    const paused = await payloadNow();
    expect(paused.tenants.length).toBeGreaterThan(0);
    expect(paused.tenants.every((x) => x.status === "suspended")).toBe(true);

    // ingest accepted while read-only: the edge keeps the real statuses
    expect((await setReadOnly({ enabled: true, ingest: "accept" })).statusCode).toBe(200);
    expect((await payloadNow()).tenants.find((x) => x.tenant_id === t)?.status).toBe("active");

    const off = await setReadOnly({ enabled: false, ingest: "accept" });
    expect(off.statusCode, off.body).toBe(200);
    const again = await call(h, {
      method: "POST",
      url: `/v1/tenants/${t}/sites`,
      cookie: owner,
      body: { name: "Allowed" },
    });
    expect(again.statusCode, again.body).toBe(201);
  });
});
