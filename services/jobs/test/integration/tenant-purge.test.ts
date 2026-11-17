// SPDX-License-Identifier: Apache-2.0
// Acceptance (C-08, C-64, C-114, enrol.operator-removal purge part): job tenant_purge removes every row of a removed tenant whose
// purge_after has passed — under that tenant's context only (F1), found through scf.job_queue (no cross-tenant read) —
// and its Umami identity and websites through packages/umami-adapter via the REAL engine proxy with the provisioner
// certificate (visit-token purge on every core first, P13 + P9, P13 + P11). It keeps the tenant row, the audit chain
// and the tombstones, never touches another tenant, leaves a tenant that is not due (or restored) alone, rolls back
// completely when the engine purge fails, and is idempotent and restartable.

import { randomBytes, randomUUID } from "node:crypto";
import { UmamiProvisioner } from "@usagemap/umami-adapter";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EngineStackInfo,
  engineTools,
  startEngineStack,
} from "../../../../packages/umami-adapter/test/support/engine-stack.ts";
import type { ScfDb } from "../../src/db.ts";
import { AdapterEnginePurger, type EngineConfig } from "../../src/engine.ts";
import { PURGE_TABLES, purgeTenant, runTenantPurge } from "../../src/jobs/tenant-purge.ts";
import { capture, jobsDb, superClient } from "../support/harness.ts";

let su: pg.Pool;
let db: ScfDb;
let info: EngineStackInfo;
let stopEngine: () => Promise<void>;
let prov: UmamiProvisioner;
let admin: string;

const PROXY_PORT = Number(process.env.SCF_WSG_ENG_PROXY_PORT ?? 56265);
const METRICS_PORT = Number(process.env.SCF_WSG_ENG_METRICS_PORT ?? 56266);
// A port in the jobs test range where nothing listens: a "second core" that is down.
const DEAD_CORE = `https://127.0.0.1:${Number(process.env.SCF_WSG_DEAD_PORT ?? 56267)}`;

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  ({ info, stop: stopEngine } = await startEngineStack({
    project: process.env.SCF_WSG_ENG_PROJECT ?? "scf-wsg-eng",
    proxyPort: PROXY_PORT,
    metricsPort: METRICS_PORT,
  }));
  const t = engineTools(info);
  prov = new UmamiProvisioner(t.client("provisioner"));
  admin = await t.adminToken();
}, 300_000);

afterAll(async () => {
  await su?.end();
  await db?.pool.end();
  await stopEngine?.();
});

function engineCfg(purgeUrls?: string[]): EngineConfig {
  return {
    url: info.proxyUrl,
    purgeUrls: purgeUrls ?? [info.proxyUrl, info.proxyUrl],
    ca: info.ca,
    cert: info.provisioner.cert,
    key: info.provisioner.key,
    user: info.provisionerUser,
    password: info.provisionerPassword,
  };
}

interface Seeded {
  tenantId: string;
  ownerId: string;
  websites: string[];
  engineUser: string;
  engineTeam: string;
  host: string;
  account: string;
  github: string;
}

const G = () => {
  // A syntactically valid G… StrKey shape is enough for the evidence CHECK (the job never decodes it).
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return `G${Array.from(randomBytes(55), (b) => alphabet[b % 32]).join("")}`;
};
const C = () => `C${G().slice(1)}`;

/** A fully provisioned tenant: engine user, team, two sites (one with a twin) with events, and rows in many tables. */
async function seedTenant(): Promise<Seeded> {
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const memberId = randomUUID();
  await su.query(
    `INSERT INTO scf.users (user_id, display_name) VALUES ($1, 'wsg purge owner'), ($2, 'wsg purge member')`,
    [ownerId, memberId],
  );
  await su.query(
    `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES ($1, $2, 'WSG purge', 'active', $3)`,
    [tenantId, `wsgp-${tenantId.slice(0, 8)}`, ownerId],
  );
  await su.query(
    `INSERT INTO scf.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [tenantId, ownerId, memberId],
  );
  // The owner's GitHub identity: C-64 tombstones it (scf.write_removal_tombstones, migration 0057).
  const github = String(1_000_000_000 + (randomBytes(4).readUInt32BE(0) % 1_000_000_000));
  await su.query(
    `INSERT INTO scf.external_identities (user_id, provider, subject, display_handle) VALUES ($1, 'github', $2, 'wsg')`,
    [ownerId, github],
  );
  await su.query(
    `INSERT INTO scf.tenant_invitations (tenant_id, role, code_hash, created_by, expires_at)
     VALUES ($1, 'viewer', $2, $3, now() + interval '1 day')`,
    [tenantId, randomBytes(32), ownerId],
  );
  // Engine identity and websites, through the proxy as the control plane provisions them (P2–P4, P7, P7t).
  const ident = await prov.provisionTenant(admin, tenantId);
  const sites = [
    { siteId: randomUUID(), main: randomUUID(), twin: randomUUID() },
    { siteId: randomUUID(), main: randomUUID(), twin: null as string | null },
  ];
  const t = engineTools(info);
  for (const s of sites) {
    for (const w of [s.main, s.twin]) {
      if (!w) continue;
      await prov.createWebsite(admin, {
        id: w,
        name: s.siteId,
        domain: "app.example.org",
        teamId: ident.teamId,
      });
      const st = await t.sendEvent(w, {
        tag: "v",
        ts: Date.now(),
        surrogate: "2001:db8::7",
        url: "/x",
      });
      expect(st).toBe(200);
    }
    await su.query(
      `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id, visitor_id,
                              created_by)
       VALUES ($1, $2, 'wsg purge site', $3, $4, $5, $6, $7)`,
      [
        tenantId,
        s.siteId,
        randomBytes(16).toString("hex").slice(0, 22),
        s.main,
        s.twin,
        s.twin ? "off" : "on",
        ownerId,
      ],
    );
  }
  await su.query(
    `INSERT INTO scf.umami_credentials (tenant_id, umami_team_id, umami_user_id, umami_username, umami_api_key_id,
                                        api_key_ciphertext, password_ciphertext, key_version)
     VALUES ($1, $2, $3, $4, $5, '\\x00', '\\x00', 1)`,
    [tenantId, ident.teamId, ident.userId, `scf-t-${tenantId.replaceAll("-", "")}`, randomUUID()],
  );
  const host = `wsg-${tenantId.slice(0, 8)}.example.org`;
  const dom = await su.query<{ domain_id: string }>(
    `INSERT INTO scf.site_domains (tenant_id, site_id, host, state, verified_at)
     VALUES ($1, $2, $3, 'verified', now()) RETURNING domain_id`,
    [tenantId, sites[0]?.siteId, host],
  );
  // (since 0069 a verified domain row claims its host itself; the explicit claim covers databases before it)
  await su.query(
    `INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES ($1, $2, $3) ON CONFLICT (host) DO NOTHING`,
    [host, tenantId, dom.rows[0]?.domain_id],
  );
  const account = G();
  const ev = await su.query<{ evidence_id: string }>(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details)
     VALUES ($1, 'domain', $2, '{}'), ($1, 'stellar_account', $3, '{"method":"sep53"}') RETURNING evidence_id`,
    [tenantId, host, account],
  );
  const svc = await su.query<{ service_id: string }>(
    `INSERT INTO scf.api_services (tenant_id, service_name, created_by) VALUES ($1, 'checkout-api', $2)
     RETURNING service_id`,
    [tenantId, ownerId],
  );
  await su.query(
    `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, service_id, status, verified_role,
                                         verified_by_evidence, verified_at, created_by)
     VALUES ($1, $2, 'public', $3, 'verified', 'deployer', $4, now(), $5)`,
    [tenantId, C(), svc.rows[0]?.service_id, ev.rows[1]?.evidence_id, ownerId],
  );
  await su.query(
    `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
       pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces,
       total_duration_s, events_raw, is_final, engine_version)
     VALUES ($1, $2, current_date - 2, 3, 4, 0, 0, 1, 1, 1, 0, 10, 4, true, 'umami/3.5.0')`,
    [tenantId, sites[0]?.siteId],
  );
  await su.query(
    `INSERT INTO scf.web_hourly_totals (tenant_id, site_id, hour_start, pageviews_verified, pageviews_raw,
       pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, events_raw)
     VALUES ($1, $2, date_trunc('hour', now()) - interval '1 hour', 1, 1, 0, 0, 1, 1, 1)`,
    [tenantId, sites[1]?.siteId],
  );
  await su.query(
    `INSERT INTO scf.trust_annotations (tenant_id, site_id, range_start, range_end, author_kind, author_user_id, body)
     VALUES ($1, $2, date_trunc('day', now(), 'UTC') - interval '1 day', date_trunc('day', now(), 'UTC'), 'tenant',
             $3, 'launch day')`,
    [tenantId, sites[0]?.siteId, ownerId],
  );
  await su.query(
    `INSERT INTO scf.public_metrics_documents (tenant_id, document) VALUES ($1, '{"schema":"x"}')`,
    [tenantId],
  );
  // tables (C-136): dev events, the Stellar event property rollup, a signed snapshot with a seal leaf, and a
  // footprint item — tenant_purge removes them all (a signed snapshot only by tenant_purge, trigger 0065).
  await su.query(
    `INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict)
     VALUES ($1, $2, now(), 'pageview', 'pageview', '/', 'verified')`,
    [tenantId, sites[0]?.siteId],
  );
  await su.query(
    `INSERT INTO scf.web_event_property_daily (tenant_id, site_id, day, event_name, network, prop_key, prop_value,
                                               verdict, count)
     VALUES ($1, $2, current_date, 'wallet_connect', 'mainnet', 'wallet', 'freighter', 'verified', 3)`,
    [tenantId, sites[0]?.siteId],
  );
  const snap = await su.query<{ snapshot_id: string }>(
    `INSERT INTO scf.traction_snapshots (tenant_id, created_by, period_start, period_end, document, canonical_sha256,
                                         signature, kid)
     VALUES ($1, $2, '2026-01-01', '2026-02-01', '{"schema":"x"}', sha256('x'::bytea), $3, 'snap-test')
     RETURNING snapshot_id`,
    [tenantId, ownerId, randomBytes(64)],
  );
  await su.query(
    `INSERT INTO scf.seal_leaves (tenant_id, snapshot_id, network, day, leaf_index, salt, leaf_hash, audit_path)
     VALUES ($1, $2, 'testnet', '2099-12-31', $3, $4, $5, ARRAY[$6::bytea])`,
    [
      tenantId,
      snap.rows[0]?.snapshot_id,
      2 + (randomBytes(3).readUIntBE(0, 3) % 1_000_000),
      randomBytes(32),
      randomBytes(32),
      randomBytes(32),
    ],
  );
  await su.query(
    `INSERT INTO scf.footprint_items (tenant_id, kind, subject, network, created_by)
     VALUES ($1, 'app_account', $2, 'mainnet', $3)`,
    [tenantId, account, ownerId],
  );
  return {
    tenantId,
    ownerId,
    websites: sites.flatMap((s) => (s.twin ? [s.main, s.twin] : [s.main])),
    engineUser: ident.userId,
    engineTeam: ident.teamId,
    host,
    account,
    github,
  };
}

/** Marks the tenant removed (as op_tenant_transition does) with purge_after at the given offset from now. */
async function remove(tenantId: string, purgeAfterSeconds: number): Promise<void> {
  const c = await su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica"); // the guard trigger is for runtime roles
    await c.query(
      `UPDATE scf.tenants SET status = 'removed', removed_at = now() - interval '30 days',
              purge_after = now() + make_interval(secs => $2), status_changed_at = now()
        WHERE tenant_id = $1`,
      [tenantId, purgeAfterSeconds],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

async function counts(tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const rel of PURGE_TABLES) {
    const r = await su.query<{ n: string }>(
      `SELECT count(*) AS n FROM scf.${rel} WHERE tenant_id = $1`,
      [tenantId],
    );
    out[rel] = Number(r.rows[0]?.n);
  }
  return out;
}

const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

describe("tenant_purge", () => {
  it("purges exactly the tables whose jobs_delete policy names tenant_purge", async () => {
    const r = await su.query<{ t: string }>(
      `SELECT DISTINCT tablename AS t FROM pg_policies
        WHERE schemaname = 'scf' AND policyname = 'jobs_delete' AND qual LIKE '%tenant_purge%'
          AND tablename !~ '_p[0-9]{8}$'`,
    );
    expect(new Set([...PURGE_TABLES])).toEqual(new Set(r.rows.map((x) => x.t)));
  });

  it("leaves a removed tenant alone until purge_after, and never touches active tenants", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await remove(a.tenantId, 3600);
    const before = await counts(a.tenantId);
    const cap = capture();
    const res = await runTenantPurge(db, new AdapterEnginePurger(engineCfg()), cap.ctx());
    expect(res.has(a.tenantId)).toBe(false);
    expect(res.has(b.tenantId)).toBe(false);
    // Called directly (e.g. by a stale queue entry), the job re-checks inside the locked transaction.
    const direct = await purgeTenant(
      db,
      new AdapterEnginePurger(engineCfg()),
      a.tenantId,
      cap.ctx(),
    );
    expect(direct.outcome).toBe("not_due");
    expect(await counts(a.tenantId)).toEqual(before);
    expect(await prov.exists(admin, "website", a.websites[0] as string)).toBe(true);
  });

  it("rolls back completely when a core's visit-token purge fails, then completes on the next run", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await remove(a.tenantId, -60);
    const beforeA = await counts(a.tenantId);
    const beforeB = await counts(b.tenantId);
    const cap = capture();
    await expect(
      runTenantPurge(db, new AdapterEnginePurger(engineCfg([info.proxyUrl, DEAD_CORE])), cap.ctx()),
    ).rejects.toThrow(/tenant purges failed/);
    expect(await counts(a.tenantId)).toEqual(beforeA);
    // Nothing was deleted in the engine either: the token purge runs before P9 and failed on the dead core.
    for (const w of a.websites) expect(await prov.exists(admin, "website", w)).toBe(true);
    const failed = cap.lines
      .map((l) => JSON.parse(l))
      .find((l) => l.event === "tenant_purge_failed");
    expect(failed).toMatchObject({ tenant_id: a.tenantId, job: "tenant_purge" });
    // The failure is audited in the tenant's chain, in its own transaction after the purge transaction rolled back.
    const pf = await su.query<{ actor_id: string; details: Record<string, unknown> }>(
      "SELECT actor_id, details FROM scf.audit_log WHERE chain_id = $1 AND action = 'tenant.purge_failed'",
      [a.tenantId],
    );
    expect(pf.rows).toHaveLength(1);
    expect(pf.rows[0]?.actor_id).toBe("tenant_purge");
    expect(pf.rows[0]?.details).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(pf.rows[0]?.details)).not.toContain("127.0.0.1");
    expect(
      (
        await su.query(
          "SELECT 1 FROM scf.audit_log WHERE chain_id = $1 AND action = 'tenant.purge_failed'",
          [b.tenantId],
        )
      ).rowCount,
    ).toBe(0);

    const res = await runTenantPurge(db, new AdapterEnginePurger(engineCfg()), cap.ctx());
    const r = res.get(a.tenantId);
    expect(r).not.toBe("failed");
    expect(r && r !== "failed" && r.outcome).toBe("purged");
    expect(total(await counts(a.tenantId))).toBe(0);
    expect(await counts(b.tenantId)).toEqual(beforeB);
    expect(total(beforeA)).toBeGreaterThanOrEqual(15);
  });

  it("removes the engine websites, user and team, keeps tenant row, audit chain and tombstones; idempotent", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await remove(a.tenantId, -1);
    const cap = capture();
    const purger = new AdapterEnginePurger(engineCfg());
    const res = await runTenantPurge(db, purger, cap.ctx());
    const r = res.get(a.tenantId);
    if (!r || r === "failed") throw new Error("tenant not purged");
    expect(r.websites).toBe(3);
    expect(r.hostClaims).toBe(1);
    expect(r.tombstones).toBe(3);

    for (const w of a.websites) expect(await prov.exists(admin, "website", w)).toBe(false);
    expect(await prov.exists(admin, "user", a.engineUser)).toBe(false);
    expect(await prov.exists(admin, "team", a.engineTeam)).toBe(false);
    for (const w of b.websites) expect(await prov.exists(admin, "website", w)).toBe(true);
    expect(await prov.exists(admin, "user", b.engineUser)).toBe(true);

    const t = await su.query(
      "SELECT status::text AS status, purged_at IS NOT NULL AS purged, slug FROM scf.tenants WHERE tenant_id = $1",
      [a.tenantId],
    );
    expect(t.rows[0]).toMatchObject({ status: "removed", purged: true });
    expect(
      await su.query("SELECT 1 FROM scf.host_claims WHERE tenant_id = $1", [a.tenantId]),
    ).toHaveProperty("rowCount", 0);
    const tomb = await su.query<{ kind: string; subject: string }>(
      "SELECT kind, subject FROM scf.enrollment_tombstones WHERE tenant_id = $1 ORDER BY kind",
      [a.tenantId],
    );
    expect(tomb.rows).toEqual([
      { kind: "github_user", subject: a.github },
      { kind: "host", subject: a.host },
      { kind: "stellar_account", subject: a.account },
    ]);
    const audit = await su.query<{
      action: string;
      actor_kind: string;
      actor_id: string;
      details: unknown;
    }>(
      `SELECT action, actor_kind, actor_id, details FROM scf.audit_log WHERE chain_id = $1 ORDER BY seq`,
      [a.tenantId],
    );
    const purged = audit.rows.filter((x) => x.action === "tenant.purged");
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({ actor_kind: "job", actor_id: "tenant_purge" });
    const details = purged[0]?.details as { rows: Record<string, number>; engine_websites: number };
    expect(details.engine_websites).toBe(3);
    expect(details.rows.sites).toBe(2);
    expect(JSON.stringify(details)).not.toContain(a.host); // counts only

    // Idempotent: a second pass finds nothing (job_queue excludes purged tenants); a direct call is "not_due".
    const again = await runTenantPurge(db, purger, cap.ctx());
    expect(again.size).toBe(0);
    expect((await purgeTenant(db, purger, a.tenantId, cap.ctx())).outcome).toBe("not_due");
    const audit2 = await su.query(
      "SELECT 1 FROM scf.audit_log WHERE chain_id = $1 AND action = 'tenant.purged'",
      [a.tenantId],
    );
    expect(audit2.rowCount).toBe(1);
    // Irreversible: the guard now refuses every change to the purged tenant (also by the job's own role).
    await expect(
      db.tx("tenant_purge", a.tenantId, (tx) =>
        tx.exec("UPDATE scf.tenants SET purged_at = now() WHERE tenant_id = $1", [a.tenantId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(cap.lines.join("\n")).not.toContain(a.host);
  });

  it("respects a lifted tombstone and refuses tenants with engine data when the engine is not configured", async () => {
    const a = await seedTenant();
    await su.query(
      `INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id, reason, lifted_at, lifted_by)
       VALUES ('host', $1, $2, 'removed', now(), $3)`,
      [a.host, a.tenantId, a.ownerId],
    );
    await remove(a.tenantId, -1);
    const cap = capture();
    await expect(runTenantPurge(db, null, cap.ctx())).rejects.toThrow(/failed/);
    expect(total(await counts(a.tenantId))).toBeGreaterThan(0);
    const res = await runTenantPurge(db, new AdapterEnginePurger(engineCfg()), cap.ctx());
    const r = res.get(a.tenantId);
    if (!r || r === "failed") throw new Error("tenant not purged");
    expect(r.tombstones).toBe(2); // GitHub id + stellar account: the host's tombstone was lifted by an operator
    const active = await su.query(
      "SELECT 1 FROM scf.enrollment_tombstones WHERE subject = $1 AND lifted_at IS NULL",
      [a.host],
    );
    expect(active.rowCount).toBe(0);
  });
});
