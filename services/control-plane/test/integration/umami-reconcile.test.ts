// SPDX-License-Identifier: Apache-2.0
// Job umami_reconcile against the real database (scf_jobs through PgBouncer) and the real engine: our Umami 3.5.0
// image behind the real engine proxy with mutual TLS (wire-formats §j.2; C-73, C-85, C-112(9), C-113).

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  HttpClient,
  type UmamiHttpError,
  UmamiProvisioner,
  UmamiReader,
  visitTokenPurgeOnEveryCore,
} from "@usagemap/umami-adapter";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { parseCredsKeys } from "../../src/config.ts";
import { createPool, Database } from "../../src/db/database.ts";
import { cpMetrics } from "../../src/obs/metrics.ts";
import { tenantApiKey } from "../../src/umami/credentials.ts";
import { type ReconcileOptions, UmamiReconciler } from "../../src/umami/reconcile.ts";
import {
  type EngineStackInfo,
  type EngineTools,
  engineTools,
  startControlPlaneEngine,
} from "../support/engine/index.ts";

const FAKE_CORE_PORT = Number(process.env.SCF_WSF_ENG_FAKE_CORE_PORT ?? 56150);
const keys = parseCredsKeys(`1:${randomBytes(32).toString("base64")}`, undefined);
if (!keys) throw new Error("keys");

let info: EngineStackInfo;
let stopEngine: () => Promise<void>;
let tools: EngineTools;
let su: pg.Pool;
let jobsDb: Database;
let fakeCore: Server;
let fakeCoreStatus = 204;
const fakeCorePurged: string[] = [];
const logs: string[] = [];
let ownerId = "";
/** Other files' live tenants, parked while this file runs (see parkForeignTenants). */
let parked: Record<string, unknown>[] = [];

const log = {
  info: (o: object, m: string) => logs.push(JSON.stringify({ ...o, m })),
  warn: (o: object, m: string) => logs.push(JSON.stringify({ ...o, m })),
  error: (o: object, m: string) => logs.push(JSON.stringify({ ...o, m })),
};

function reconciler(extra: Partial<ReconcileOptions> = {}): UmamiReconciler {
  const prov = tools.client("provisioner");
  return new UmamiReconciler({
    jobsDb,
    provisioner: new UmamiProvisioner(prov),
    // Two cores: the real proxy and a fake one whose answer the test controls.
    purge: visitTokenPurgeOnEveryCore([
      prov,
      new HttpClient({ baseUrl: `http://127.0.0.1:${FAKE_CORE_PORT}`, timeoutMs: 2000 }),
    ]),
    reader: new UmamiReader(tools.client("reader")),
    credsKeys: keys as NonNullable<typeof keys>,
    admin: { username: info.provisionerUser, password: info.provisionerPassword },
    log,
    rotateAfterDays: 0,
    ...extra,
  });
}

/** Superuser fixture writes (triggers off so any status can be set directly). */
async function fixture(sql: string, params: unknown[]): Promise<void> {
  const c = await su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

async function newTenant(status: "active" | "pending" | "suspended" | "removed"): Promise<string> {
  const id = randomUUID();
  await fixture(
    `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by, removed_at, purge_after)
     VALUES ($1, $2, 'T', $3::text::scf.tenant_status, $4, CASE WHEN $3::text = 'removed' THEN now() END,
             CASE WHEN $3::text = 'removed' THEN now() + interval '30 days' END)`,
    [id, `t-${id.slice(0, 8)}`, status, ownerId],
  );
  return id;
}

async function newSite(
  tenantId: string,
  twin: boolean,
): Promise<{ siteId: string; main: string; twin: string | null }> {
  const s = { siteId: randomUUID(), main: randomUUID(), twin: twin ? randomUUID() : null };
  await fixture(
    `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id, visitor_id,
                            created_by)
     VALUES ($1, $2, 'S', $3, $4, $5, $6, $7)`,
    [
      tenantId,
      s.siteId,
      randomBytes(16).toString("hex").slice(0, 22),
      s.main,
      s.twin,
      twin ? "off" : "on",
      ownerId,
    ],
  );
  return s;
}

async function creds(tenantId: string) {
  return (await su.query(`SELECT * FROM scf.umami_credentials WHERE tenant_id = $1`, [tenantId]))
    .rows[0] as Record<string, unknown> | undefined;
}

async function apiKeyOf(tenantId: string): Promise<string | null> {
  return jobsDb.tx(
    { tenantId, actorKind: "job", actorId: "umami_reconcile", job: "umami_reconcile" },
    (tx) => tenantApiKey(tx, keys, tenantId),
  );
}

const prov = () => new UmamiProvisioner(tools.client("provisioner"));

/**
 * umami_reconcile is a global job: every pass reads every live tenant, site and credential row, and its result
 * counters, drift gauge and re-wrap step are global. The integration files share one database and run in an order
 * that vitest picks (duration cache, else file size), so tenants left by earlier files (web.test.ts and
 * web-engine.test.ts store credentials under their own key and sites whose websites lived in their own engine) used
 * to show up here as `missing` drift and re-wrap errors. Their live tenants are parked as purged (the state the job
 * ignores) for the duration of this file and restored exactly afterwards, so this file sees only its own tenants
 * whatever ran before it, and files after it see the database as they left it.
 */
async function parkForeignTenants(): Promise<void> {
  const c = await su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    parked = (
      await c.query(
        `SELECT tenant_id, status::text AS status, removed_at, purge_after FROM scf.tenants
          WHERE purged_at IS NULL FOR UPDATE`,
      )
    ).rows;
    await c.query(
      `UPDATE scf.tenants SET status = 'removed', removed_at = COALESCE(removed_at, now()),
              purge_after = COALESCE(purge_after, now()), purged_at = now()
        WHERE tenant_id = ANY ($1::uuid[])`,
      [parked.map((t) => t.tenant_id)],
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

async function restoreForeignTenants(): Promise<void> {
  if (parked.length === 0) return;
  await fixture(
    `UPDATE scf.tenants t SET status = p.status::scf.tenant_status, removed_at = p.removed_at,
            purge_after = p.purge_after, purged_at = NULL
       FROM jsonb_to_recordset($1::jsonb) AS p(tenant_id uuid, status text, removed_at timestamptz,
                                              purge_after timestamptz)
      WHERE t.tenant_id = p.tenant_id`,
    [JSON.stringify(parked)],
  );
  parked = [];
}

beforeAll(async () => {
  ({ info, stop: stopEngine } = await startControlPlaneEngine());
  tools = engineTools(info);
  su = new pg.Pool({ connectionString: inject("pgSuperUrl"), max: 2 });
  jobsDb = new Database(createPool({ connectionString: inject("pgJobsUrl"), max: 4 }));
  ownerId = (
    await su.query<{ user_id: string }>(
      `INSERT INTO scf.users (display_name) VALUES ('owner') RETURNING user_id`,
    )
  ).rows[0]?.user_id as string;
  await parkForeignTenants();
  fakeCore = createServer((req, res) => {
    const m = /^\/internal\/v1\/visit-tokens\/websites\/([0-9a-f-]{36})$/.exec(req.url ?? "");
    if (req.method === "DELETE" && m && fakeCoreStatus === 204) fakeCorePurged.push(m[1] as string);
    res.statusCode = m ? fakeCoreStatus : 404;
    res.end();
  });
  await new Promise<void>((r) => fakeCore.listen(FAKE_CORE_PORT, "127.0.0.1", r));
}, 300_000);

afterAll(async () => {
  await new Promise((r) => fakeCore?.close(r));
  if (su) await restoreForeignTenants();
  await jobsDb?.close();
  await su?.end();
  await stopEngine?.();
});

describe("umami_reconcile", () => {
  let t1 = "";
  let s1: Awaited<ReturnType<typeof newSite>>;
  let s2: Awaited<ReturnType<typeof newSite>>;

  it("recovers from a crash after P2 and then provisions team, user, key, main and twin websites", async () => {
    t1 = await newTenant("active");
    s1 = await newSite(t1, false);
    s2 = await newSite(t1, true);
    const crashing = reconciler({
      step: (name, tenant) => {
        if (name === "P2" && tenant === t1) throw new Error("simulated crash after P2");
      },
    });
    const first = await crashing.pass();
    expect(first.ran).toBe(true);
    expect(first.provisioned).not.toContain(t1);
    expect(first.errors).toBeGreaterThan(0);
    expect(await creds(t1)).toBeUndefined();

    const second = await reconciler().pass();
    expect(second.provisioned).toContain(t1);
    const c = await creds(t1);
    expect(c?.umami_username).toBe(`scf-t-${t1.replace(/-/g, "")}`);
    const p = prov();
    const token = await tools.adminToken();
    for (const id of [s1.main, s2.main, s2.twin as string])
      expect(await p.exists(token, "website", id)).toBe(true);
    const site2 = (
      await su.query(`SELECT twin_provisioned_at FROM scf.sites WHERE site_id = $1`, [s2.siteId])
    ).rows[0];
    expect(site2?.twin_provisioned_at).toBeInstanceOf(Date);
    // The engine user is the one P2 created before the crash (no second user was needed).
    expect(await p.exists(token, "user", String(c?.umami_user_id))).toBe(true);
  });

  it("a second pass changes nothing", async () => {
    const before = await creds(t1);
    const again = await reconciler().pass();
    expect(again).toMatchObject({
      ran: true,
      provisioned: [],
      websitesCreated: 0,
      twinsProvisioned: 0,
      orphansDeleted: 0,
      rotated: [],
      errors: 0,
    });
    expect((await creds(t1))?.api_key_ciphertext).toEqual(before?.api_key_ciphertext);
  });

  it("the stored key decrypts and reads the tenant's websites, and only those", async () => {
    const key = await apiKeyOf(t1);
    expect(key).toMatch(/^umami_[A-Za-z0-9]{32}$/);
    const now = Date.now();
    expect(
      await tools.sendEvent(s1.main, { tag: "v", ts: now - 1000, surrogate: "2001:db8:aa::1" }),
    ).toBe(200);
    const reader = new UmamiReader(tools.client("reader"));
    const range = { start: now - 3_600_000, end: now + 60_000 };
    expect((await reader.stats(key as string, s1.main, range, "raw")).pageviews).toBe(1);
    // Another tenant's key is refused on t1's website (C-99 isolation).
    const t2 = await newTenant("pending");
    await reconciler().pass();
    const key2 = await apiKeyOf(t2);
    expect(key2).toMatch(/^umami_/);
    const err = await reader.stats(key2 as string, s1.main, range, "raw").catch((e: unknown) => e);
    expect((err as UmamiHttpError).status).toBe(401);
  });

  it("does not provision removed tenants", async () => {
    const t3 = await newTenant("removed");
    await newSite(t3, false);
    const r = await reconciler().pass();
    expect(r.provisioned).not.toContain(t3);
    expect(await creds(t3)).toBeUndefined();
  });

  it("reports a site's website that exists outside the tenant's team: the tenant key cannot read it (2026-11-13 journey regression)", async () => {
    // The monitoring fixture created its websites as the provisioning admin before the tenant had a team, so every
    // live read answered 401 and fell back to the rollups, silently. The pass must say so (never move it itself).
    const t5 = await newTenant("active");
    const s5 = await newSite(t5, false);
    const token = await tools.adminToken();
    await prov().createWebsite(token, {
      id: s5.main,
      name: "outside",
      domain: "invalid.example",
    } as never);
    logs.length = 0;
    const r = await reconciler().pass();
    expect(r.provisioned).toContain(t5);
    expect(r.misplaced).toBe(1);
    expect(r.websitesCreated).toBe(0);
    expect(logs.join("\n")).toContain("umami website outside the tenant team");
    const listed = await prov().listWebsites(token);
    const team = String((await creds(t5))?.umami_team_id);
    expect(listed.find((w) => w.id === s5.main)?.teamId).not.toBe(team);
    const now = Date.now();
    const err = await new UmamiReader(tools.client("reader"))
      .stats((await apiKeyOf(t5)) as string, s5.main, { start: now - 3_600_000, end: now }, "raw")
      .catch((e: unknown) => e);
    expect((err as UmamiHttpError).status).toBe(401);
    // A website created by the pass itself is in the tenant's team: nothing to report there.
    expect(listed.find((w) => w.id === s1.main)?.teamId).toBe(
      String((await creds(t1))?.umami_team_id),
    );
  });

  it("deletes an orphan website only after the visit-token purge succeeded on every core (C-112(9))", async () => {
    const p = prov();
    const token = await tools.adminToken();
    const orphan = randomUUID();
    await p.createWebsite(token, {
      id: orphan,
      name: "orphan",
      domain: "invalid.example",
      teamId: String((await creds(t1))?.umami_team_id),
    });
    fakeCoreStatus = 500;
    const failed = await reconciler().pass();
    expect(failed.orphansDeleted).toBe(0);
    expect(failed.errors).toBeGreaterThan(0);
    expect(await p.exists(token, "website", orphan)).toBe(true);

    fakeCoreStatus = 204;
    const ok = await reconciler().pass();
    expect(ok.orphansDeleted).toBe(1);
    expect(fakeCorePurged).toEqual([orphan]);
    expect(await p.exists(token, "website", orphan)).toBe(false);
    // Websites that sites reference were never touched.
    for (const id of [s1.main, s2.main, s2.twin as string])
      expect(await p.exists(token, "website", id)).toBe(true);
  });

  it("refuses mass deletion (circuit breaker)", async () => {
    const p = prov();
    const token = await tools.adminToken();
    const team = String((await creds(t1))?.umami_team_id);
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids)
      await p.createWebsite(token, { id, name: "o", domain: "invalid.example", teamId: team });
    const r = await reconciler({ maxOrphanDeletes: 1 }).pass();
    expect(r.orphansDeleted).toBe(0);
    for (const id of ids) expect(await p.exists(token, "website", id)).toBe(true);
    expect((await reconciler().pass()).orphansDeleted).toBe(2);
  });

  it("runs one instance at a time", async () => {
    const [a, b] = await Promise.all([reconciler().pass(), reconciler().pass()]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
  });

  it("rotates the key: new key stored and readable, old key refused, audited (C-85)", async () => {
    const oldKey = (await apiKeyOf(t1)) as string;
    const r = await reconciler({ rotateAfterDays: 0.000001 }).pass();
    expect(r.rotated).toContain(t1);
    const newKey = (await apiKeyOf(t1)) as string;
    expect(newKey).not.toBe(oldKey);
    const reader = new UmamiReader(tools.client("reader"));
    const now = Date.now();
    const range = { start: now - 3_600_000, end: now + 60_000 };
    expect((await reader.stats(newKey, s1.main, range, "raw")).pageviews).toBe(1);
    const err = await reader.stats(oldKey, s1.main, range, "raw").catch((e: unknown) => e);
    expect((err as UmamiHttpError).status).toBe(401);
    const audit = await su.query(
      `SELECT actor_kind FROM scf.audit_log WHERE tenant_id = $1 AND action = 'umami.key_rotated'`,
      [t1],
    );
    expect(audit.rows.map((x) => x.actor_kind)).toContain("job");
    expect((await creds(t1))?.rotated_at).toBeInstanceOf(Date);
  });

  it("logs nothing secret", async () => {
    const secrets: string[] = [info.provisionerPassword];
    for (const t of [t1]) {
      const k = await apiKeyOf(t);
      if (k) secrets.push(k);
    }
    const text = logs.join("\n");
    expect(text.length).toBeGreaterThan(0);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toMatch(/umami_[A-Za-z0-9]{32}/);
    expect(text).not.toMatch(/Bearer|password"|token"/);
  });

  it("reports sites and engine websites that no longer match, as a gauge for operators (plan C1 #12)", async () => {
    const p = prov();
    const token = await tools.adminToken();
    // A removed tenant whose website disappeared from the engine (restoration would find nothing).
    const tD = await newTenant("active");
    const sD = await newSite(tD, false);
    expect((await reconciler().pass()).provisioned).toContain(tD);
    await fixture(
      `UPDATE scf.tenants SET status = 'removed', removed_at = now(), purge_after = now() + interval '30 days'
        WHERE tenant_id = $1`,
      [tD],
    );
    await p.deleteWebsite(token, sD.main, async () => {});
    // Two orphans the circuit breaker refuses to delete in one pass.
    const team = String((await creds(t1))?.umami_team_id);
    const orphans = [randomUUID(), randomUUID()];
    for (const id of orphans)
      await p.createWebsite(token, { id, name: "o", domain: "invalid.example", teamId: team });
    logs.length = 0;
    const r = await reconciler({ maxOrphanDeletes: 1 }).pass();
    expect(r.drift.orphan).toBe(2);
    expect(r.drift.missing).toBe(1);
    expect(r.drift.misplaced).toBe(r.misplaced);
    expect(r.misplaced).toBeGreaterThanOrEqual(1); // t5's website from the journey-regression test
    const gauge = (kind: string) => cpMetrics.registry.value("scf_cp_umami_site_drift", { kind });
    expect(gauge("orphan")).toBe(2);
    expect(gauge("missing")).toBe(1);
    expect(gauge("misplaced")).toBe(r.misplaced);
    expect(await cpMetrics.registry.render()).toMatch(
      /scf_cp_umami_site_drift\{kind="missing"\} 1/,
    );
    expect(logs.join("\n")).toContain("umami sites and engine websites do not match");
    // The removed tenant's website is never re-created (removed tenants get nothing new) and stays reported.
    const next = await reconciler().pass();
    expect(next.orphansDeleted).toBe(2);
    expect(next.drift).toMatchObject({ orphan: 0, missing: 1 });
    expect(gauge("orphan")).toBe(0);
    expect(await p.exists(token, "website", sD.main)).toBe(false);
  });

  it("re-wraps every tenant's credentials under the current key version, whatever the status", async () => {
    // A suspended tenant and a removed one, both provisioned under key version 1.
    const tS = await newTenant("active");
    const tR = await newTenant("active");
    await reconciler().pass();
    const before = { s: await apiKeyOf(tS), r: await apiKeyOf(tR), one: await apiKeyOf(t1) };
    expect(before.s).toMatch(/^umami_/);
    await fixture(`UPDATE scf.tenants SET status = 'suspended' WHERE tenant_id = $1`, [tS]);
    await fixture(
      `UPDATE scf.tenants SET status = 'removed', removed_at = now(), purge_after = now() + interval '30 days'
        WHERE tenant_id = $1`,
      [tR],
    );
    // The operator adds key version 2 and makes it current (runbook key-and-cert-rotation.md); rotation is off.
    const v1 = keys?.keys.get(1) as Buffer;
    const both = parseCredsKeys(
      `1:${v1.toString("base64")},2:${randomBytes(32).toString("base64")}`,
      "2",
    ) as NonNullable<typeof keys>;
    const r = await reconciler({ credsKeys: both, rotateAfterDays: 0 }).pass();
    expect(r.errors).toBe(0);
    expect(r.rewrapped).toBeGreaterThanOrEqual(3);
    const left = await su.query(
      `SELECT count(*)::int AS n FROM scf.umami_credentials c JOIN scf.tenants t USING (tenant_id)
        WHERE t.purged_at IS NULL AND c.key_version <> 2`,
    );
    expect(left.rows[0]?.n).toBe(0);
    // Version 1 retired: every tenant's key still decrypts, the same key as before.
    const onlyV2 = { keys: new Map([[2, both.keys.get(2) as Buffer]]), current: 2 };
    const keyUnder = (tenantId: string) =>
      jobsDb.tx(
        { tenantId, actorKind: "job", actorId: "umami_reconcile", job: "umami_reconcile" },
        (tx) => tenantApiKey(tx, onlyV2, tenantId),
      );
    expect(await keyUnder(tS)).toBe(before.s);
    expect(await keyUnder(tR)).toBe(before.r);
    expect(await keyUnder(t1)).toBe(before.one);
    // A second pass has nothing left to re-wrap.
    expect((await reconciler({ credsKeys: both, rotateAfterDays: 0 }).pass()).rewrapped).toBe(0);
  });
});
