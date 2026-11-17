// SPDX-License-Identifier: Apache-2.0
// Acceptance (data-model §8.5, ADR-0015, C-19, C-20; enrol.self-service-open L3, operator.real-usage-ranking): job registry_sync fetches the SCF-awarded
// registries (Stellarlight and PG Atlas — a fake HTTP server serving their documented, live-checked response shapes
// with synthetic projects), records provenance per row and per run, is idempotent, refuses to lapse anything after a
// suspicious (shrunken) or failed fetch, links tenants by verified host or verified contract only (never by name or
// GitHub org), confirms domain matches automatically, respects SCF-operator decisions, and creates and lapses
// registry_match evidence (→ verification level L3) under each tenant's own context.

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb } from "../../src/db.ts";
import { PgAtlasSource, StellarlightSource } from "../../src/registry/sources.ts";
import { hostMatches, runRegistrySync } from "../../src/registry/sync.ts";
import { capture, jobsDb, seedSite, superClient } from "../support/harness.ts";

let su: pg.Pool;
let db: ScfDb;
let server: Server;
let base: string;
let requests: string[] = [];

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const strkey = (p: "C" | "G") =>
  `${p}${Array.from(randomBytes(55), (b) => alphabet[b % 32]).join("")}`;
const CONTRACT = strkey("C");

// Synthetic projects in the sources' shapes (wire format checked live on 2026-11-13; see src/registry/sources.ts).
interface SlProject {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  github?: string;
  contracts?: string[];
  rounds: number[];
  category?: string;
}
let slProjects: SlProject[] = [];
let slFail = false;
let pgaLimited = false; // PG Atlas answers 429 to every project detail
let pgaProjects: Array<{
  id: string;
  name: string;
  website: string | null;
  awarded: number;
  updated: string;
  category?: string | null;
  trancheLabel?: string | null;
}> = [];

function slJson(p: SlProject) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: "Live",
    scfAwarded: true,
    scfBasis: "official-record",
    scfConfidence: { score: 0.9, label: "high", ageDays: Math.floor(Math.random() * 90) }, // volatile: not hashed
    scfAsOf: "2026-11-12",
    scfSourceUrl: `https://communityfund.stellar.org/project/${p.slug}`,
    scfTotalAwardedUSD: 1000 * p.rounds.length,
    scfAwardedRounds: p.rounds,
    scfRoundAwards: p.rounds.map((round) => ({
      round,
      awardName: null,
      amountUSD: 1000,
      awardType: "Build",
    })),
    links: { website: p.website, github: p.github ?? null },
    onchain: p.contracts
      ? { contracts: p.contracts.map((address) => ({ address, label: "x" })) }
      : null,
    score: Math.random(), // volatile ranking field: not hashed
    repos: [],
    ...(p.category ? { category: p.category } : {}),
  };
}

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  // Registry rows are global: start from an empty registry (a reused stack keeps earlier runs' rows).
  await su.query("DELETE FROM scf.tenant_registry_links");
  await su.query("DELETE FROM scf.verification_evidence WHERE kind = 'registry_match'");
  await su.query("DELETE FROM scf.registry_projects");
  await su.query("DELETE FROM scf.registry_sync_runs");
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    requests.push(u.pathname);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === "/sl/api/projects/search") {
      if (slFail) return json(503, { error: "down" });
      const limit = Math.min(Number(u.searchParams.get("limit")), 100);
      const offset = Number(u.searchParams.get("offset"));
      expect(u.searchParams.get("scfAwarded")).toBe("true");
      const page = slProjects.slice(offset, offset + limit).map(slJson);
      return json(200, {
        meta: {
          counts: { returned: page.length, total: slProjects.length, semantic: 0 },
          partial: false,
        },
        projects: page,
        codeReferences: [],
      });
    }
    if (u.pathname === "/pga/projects") {
      const limit = Number(u.searchParams.get("limit"));
      const offset = Number(u.searchParams.get("offset"));
      const items = pgaProjects.slice(offset, offset + limit).map((p) => ({
        canonical_id: p.id,
        display_name: p.name,
        project_type: "scf-project",
        git_owner_url: null,
        category: p.category ?? null,
        updated_at: p.updated,
      }));
      return json(200, { items, total: pgaProjects.length, limit, offset });
    }
    const m = /^\/pga\/projects\/(.+)$/.exec(u.pathname);
    if (m && pgaLimited) return json(429, { detail: "Too Many Requests" });
    if (m) {
      const p = pgaProjects.find((x) => x.id === decodeURIComponent(m[1] as string));
      if (!p) return json(404, { detail: "not found" });
      return json(200, {
        canonical_id: p.id,
        display_name: p.name,
        project_type: "scf-project",
        git_owner_url: "https://github.com/someone",
        category: p.category ?? null,
        updated_at: p.updated,
        metadata: {
          website: p.website,
          scf_submissions: [{ round: "SCF #30", title: p.name }],
          total_awarded_usd: p.awarded,
          scf_tranche_completion: p.trancheLabel ?? null,
        },
      });
    }
    json(404, {});
  });
  await new Promise<void>((r) =>
    server.listen(Number(process.env.SCF_WSG_REG_PORT ?? 56270), "127.0.0.1", r),
  );
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await su?.end();
  await db?.pool.end();
  await new Promise((r) => server?.close(r));
});

// The fake server is local: no pacing, and a 503 is retried once without waiting (polite.ts has its own unit tests).
const polite = { minIntervalMs: 0, maxAttempts: 2, backoffBaseMs: 1 };

function sources() {
  return [
    new StellarlightSource(`${base}/sl`, { pageSize: 2, polite }),
    new PgAtlasSource(`${base}/pga`, { pageSize: 2, polite }),
  ];
}

async function verifiedHost(tenantId: string, siteId: string, host: string) {
  await su.query(
    `INSERT INTO scf.site_domains (tenant_id, site_id, host, state, verified_at) VALUES ($1, $2, $3, 'verified', now())`,
    [tenantId, siteId, host],
  );
  await su.query(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, 'domain', $2)`,
    [tenantId, host],
  );
}

const level = async (tenantId: string) =>
  Number((await su.query("SELECT scf.verification_level($1) AS l", [tenantId])).rows[0]?.l);

const tag = randomUUID().slice(0, 6);
const H = (s: string) => `${s}-${tag}.example.org`;

describe("registry_sync", () => {
  it("hostMatches: equal hosts and subdomains at a label boundary only", () => {
    expect(hostMatches("app.blend.example", "blend.example")).toBe(true);
    expect(hostMatches("blend.example", "app.blend.example")).toBe(true);
    expect(hostMatches("xblend.example", "blend.example")).toBe(false);
    expect(hostMatches("a.github.io", "b.github.io")).toBe(false);
  });

  it("syncs both sources with provenance, links by verified host and contract, reaches L3; idempotent", async () => {
    // Tenant A: verified app.<alpha>; registry website www.<alpha> → registrable_domain, auto-confirmed → L3.
    // Tenant B: only a verified declared contract listed by a project → candidate (operator decides), no evidence.
    // Tenant C: a project with the same NAME as C and C's GitHub org, but no host/contract match → no link (C-20).
    const A = await seedSite(su);
    const B = await seedSite(su);
    const Cx = await seedSite(su);
    await verifiedHost(A.tenantId, A.siteId, `app.${H("alpha")}`);
    await verifiedHost(B.tenantId, B.siteId, H("beta-own"));
    await verifiedHost(Cx.tenantId, Cx.siteId, H("gamma-own"));
    const acct = strkey("G");
    const ev = await su.query<{ evidence_id: string }>(
      `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, 'stellar_account', $2)
       RETURNING evidence_id`,
      [B.tenantId, acct],
    );
    await su.query(
      `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, status, verified_role, verified_by_evidence,
                                           verified_at, created_by)
       VALUES ($1, $2, 'public', 'verified', 'deployer', $3, now(), $4)`,
      [B.tenantId, CONTRACT, ev.rows[0]?.evidence_id, B.userId],
    );
    slProjects = [
      {
        id: `sl-a-${tag}`,
        name: "Alpha",
        slug: `alpha-${tag}`,
        website: `https://www.${H("alpha")}/`,
        rounds: [29, 31],
        category: "Financial Protocols",
      },
      {
        id: `sl-b-${tag}`,
        name: "Beta",
        slug: `beta-${tag}`,
        website: `https://${H("beta-site")}`,
        contracts: [CONTRACT],
        rounds: [40],
      },
      {
        id: `sl-c-${tag}`,
        name: "WSG test tenant",
        slug: `c-${tag}`,
        website: `https://${H("other")}`,
        github: "https://github.com/wsg",
        rounds: [12],
      },
    ];
    pgaProjects = [
      {
        id: `daoip-5:scf:project:alpha_${tag}`,
        name: "Alpha",
        website: `https://${H("alpha")}`,
        awarded: 5000,
        updated: "2026-11-13T02:00:00Z",
        category: "Infrastructure & Services",
        trancheLabel: "Pre-Launch #3 - Mainnet",
      },
      {
        id: `daoip-5:scf:project:z_${tag}`,
        name: "Z",
        website: null,
        awarded: 0,
        updated: "2026-11-13T02:00:00Z",
        category: "Education & Community", // not one of the five SCF categories (§i.4): not stored
        trancheLabel: "something else",
      },
    ];
    const cap = capture();
    const r1 = await runRegistrySync(db, { sources: sources(), maxDropShare: 0.2 }, cap.ctx());
    expect(r1.sources.stellarlight).toMatchObject({
      status: "succeeded",
      seen: 3,
      changed: 3,
      missing: 0,
    });
    expect(r1.sources.pg_atlas).toMatchObject({ status: "succeeded", seen: 2, changed: 2 });

    // §i.4 cohort vocabularies (C-136): slugs from the sources' labels; nothing inferred.
    const cohorts = await su.query<{
      source: string;
      source_id: string;
      scf_categories: string[];
      award_round: number | null;
      award_stage: string | null;
    }>(
      `SELECT source, source_id, scf_categories, award_round, award_stage
         FROM scf.registry_projects WHERE source_id LIKE '%' || $1 ORDER BY source, source_id`,
      [tag],
    );
    expect(
      cohorts.rows.map((x) => [x.source, x.scf_categories, x.award_round, x.award_stage]),
    ).toEqual([
      ["pg_atlas", ["infrastructure_services"], null, "t3_mainnet"],
      ["pg_atlas", [], null, null],
      ["stellarlight", ["financial_protocols"], 31, null],
      ["stellarlight", [], 40, null],
      ["stellarlight", [], 12, null],
    ]);

    const rows = await su.query(
      `SELECT source, source_id, registrable_domains, contract_ids, scf_awarded, source_url, source_basis,
              source_as_of::text, octet_length(content_sha256) AS h, scf_awards
         FROM scf.registry_projects WHERE source_id LIKE '%' || $1 ORDER BY source, source_id`,
      [tag],
    );
    const a = rows.rows.find((x) => x.source_id === `sl-a-${tag}`);
    expect(a).toMatchObject({
      registrable_domains: [H("alpha")],
      scf_awarded: true,
      source_url: `https://communityfund.stellar.org/project/alpha-${tag}`,
      source_basis: "official-record",
      source_as_of: "2026-11-12",
      h: 32,
    });
    expect(a?.scf_awards).toHaveLength(2);
    expect(rows.rows.find((x) => x.source_id === `daoip-5:scf:project:z_${tag}`)?.scf_awarded).toBe(
      false,
    );
    const run = await su.query(
      "SELECT status, rows_seen, per_round_counts FROM scf.registry_sync_runs WHERE source = 'stellarlight' ORDER BY started_at DESC LIMIT 1",
    );
    expect(run.rows[0]).toMatchObject({ status: "succeeded", rows_seen: 3 });
    expect(run.rows[0]?.per_round_counts).toMatchObject({ "29": 1, "40": 1 });

    const links = await su.query<{
      tenant_id: string;
      status: string;
      match_basis: string[];
      source: string;
    }>(
      `SELECT l.tenant_id, l.status, l.match_basis, r.source FROM scf.tenant_registry_links l
         JOIN scf.registry_projects r USING (registry_project_id)
        WHERE l.tenant_id = ANY ($1::uuid[]) ORDER BY l.tenant_id, r.source`,
      [[A.tenantId, B.tenantId, Cx.tenantId]],
    );
    const forA = links.rows.filter((l) => l.tenant_id === A.tenantId);
    expect(forA.map((l) => [l.source, l.status, l.match_basis])).toEqual([
      ["pg_atlas", "confirmed", ["registrable_domain"]],
      ["stellarlight", "confirmed", ["registrable_domain"]],
    ]);
    expect(
      links.rows.filter((l) => l.tenant_id === B.tenantId).map((l) => [l.status, l.match_basis]),
    ).toEqual([["candidate", ["verified_contract"]]]);
    expect(links.rows.filter((l) => l.tenant_id === Cx.tenantId)).toHaveLength(0);
    expect(await level(A.tenantId)).toBe(3);
    expect(await level(B.tenantId)).toBe(2);

    // Idempotent: same data (volatile fields differ) → no row changed, no new link, no new evidence, no tenant audit.
    const auditBefore = await su.query(
      "SELECT count(*) AS n FROM scf.audit_log WHERE tenant_id = $1",
      [A.tenantId],
    );
    const r2 = await runRegistrySync(db, { sources: sources(), maxDropShare: 0.2 }, cap.ctx());
    expect(r2.sources.stellarlight).toMatchObject({ status: "succeeded", seen: 3, changed: 0 });
    expect(r2.sources.pg_atlas).toMatchObject({ changed: 0 });
    expect(
      [...r2.tenants.values()].every(
        (t) => t.linksCreated + t.evidenceCreated + t.evidenceLapsed === 0,
      ),
    ).toBe(true);
    const auditAfter = await su.query(
      "SELECT count(*) AS n FROM scf.audit_log WHERE tenant_id = $1",
      [A.tenantId],
    );
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n);
    // PG Atlas details were not fetched again: updated_at did not change.
    requests = [];
    await runRegistrySync(db, { sources: sources(), maxDropShare: 0.2 }, cap.ctx());
    expect(requests.filter((p) => p.startsWith("/pga/projects/"))).toHaveLength(0);

    // PG Atlas changes both projects but rate-limits every detail: the source does not fail, both stored rows stay as
    // they are (nothing missing, links and evidence unchanged), the deferral is logged and counted; one request per
    // detail attempt only (concurrency 1, breaker after the first project's attempts).
    for (const p of pgaProjects) p.updated = "2026-11-19T02:00:00Z";
    const alphaWebsite = pgaProjects[0]?.website;
    if (pgaProjects[0]) pgaProjects[0].awarded = 7000;
    pgaLimited = true;
    requests = [];
    const lines = capture();
    const r3 = await runRegistrySync(db, { sources: sources(), maxDropShare: 0.2 }, lines.ctx());
    expect(r3.sources.pg_atlas).toMatchObject({
      status: "succeeded",
      seen: 2,
      changed: 0,
      missing: 0,
    });
    expect(requests.filter((p) => p.startsWith("/pga/projects/"))).toHaveLength(2);
    const synced = lines.lines
      .map((l) => JSON.parse(l))
      .find((l) => l.event === "registry_source_synced" && l.source === "pg_atlas");
    expect(synced).toMatchObject({ deferred: 2, rate_limited: true });
    const kept = await su.query(
      `SELECT raw ->> 'updated_at' AS u, missing_since FROM scf.registry_projects
        WHERE source = 'pg_atlas' AND source_id LIKE '%' || $1`,
      [tag],
    );
    expect(kept.rows.map((x) => [x.u, x.missing_since])).toEqual([
      ["2026-11-13T02:00:00Z", null],
      ["2026-11-13T02:00:00Z", null],
    ]);
    expect(await level(A.tenantId)).toBe(3);

    // The limit lifts: the next run fetches exactly the deferred details and stores the change.
    pgaLimited = false;
    requests = [];
    const r4 = await runRegistrySync(db, { sources: sources(), maxDropShare: 0.2 }, cap.ctx());
    expect(requests.filter((p) => p.startsWith("/pga/projects/"))).toHaveLength(2);
    expect(r4.sources.pg_atlas).toMatchObject({ status: "succeeded", seen: 2 });
    expect(r4.sources.pg_atlas?.changed).toBeGreaterThanOrEqual(1);
    expect(pgaProjects[0]?.website).toBe(alphaWebsite);
  });

  it("keeps operator decisions, lapses evidence only after a successful run, never after a failed or shrunken one", async () => {
    const A = await seedSite(su);
    await verifiedHost(A.tenantId, A.siteId, H("delta"));
    slProjects = [
      {
        id: `sl-d-${tag}`,
        name: "Delta",
        slug: `delta-${tag}`,
        website: `https://${H("delta")}`,
        rounds: [33],
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `sl-f${i}-${tag}`,
        name: `Filler ${i}`,
        slug: `f${i}-${tag}`,
        website: null,
        rounds: [1],
      })),
    ];
    pgaProjects = [];
    const cap = capture();
    await runRegistrySync(
      db,
      { sources: [sources()[0] as StellarlightSource], maxDropShare: 0.2 },
      cap.ctx(),
    );
    expect(await level(A.tenantId)).toBe(3);

    // Failed fetch: run recorded as failed, the job reports failure, nothing lapses.
    slFail = true;
    await expect(
      runRegistrySync(
        db,
        { sources: [sources()[0] as StellarlightSource], maxDropShare: 0.2 },
        cap.ctx(),
      ),
    ).rejects.toThrow(/registry sources failed/);
    slFail = false;
    const failed = await su.query(
      "SELECT status, error_code FROM scf.registry_sync_runs WHERE source = 'stellarlight' ORDER BY started_at DESC LIMIT 1",
    );
    // A source that stays 503 through the retries (polite.ts) is recorded as unavailable.
    expect(failed.rows[0]).toMatchObject({ status: "failed", error_code: "RegistryUnavailable" });

    // Shrunken answer (Delta and most fillers gone): suspicious, nothing marked missing, evidence stays.
    const all = slProjects;
    slProjects = all.slice(8);
    const r = await runRegistrySync(
      db,
      { sources: [sources()[0] as StellarlightSource], maxDropShare: 0.2 },
      cap.ctx(),
    );
    expect(r.sources.stellarlight?.status).toBe("suspicious");
    const miss = await su.query(
      "SELECT missing_since FROM scf.registry_projects WHERE source_id = $1",
      [`sl-d-${tag}`],
    );
    expect(miss.rows[0]?.missing_since).toBeNull();
    expect(await level(A.tenantId)).toBe(3);

    // A genuine removal of one row: marked missing; evidence lapses only after 14 days missing.
    slProjects = all.filter((p) => p.id !== `sl-d-${tag}`);
    await runRegistrySync(
      db,
      { sources: [sources()[0] as StellarlightSource], maxDropShare: 0.2 },
      cap.ctx(),
    );
    expect(await level(A.tenantId)).toBe(3);
    await su.query(
      "UPDATE scf.registry_projects SET missing_since = now() - interval '15 days' WHERE source_id = $1",
      [`sl-d-${tag}`],
    );
    await runRegistrySync(
      db,
      { sources: [sources()[0] as StellarlightSource], maxDropShare: 0.2 },
      cap.ctx(),
    );
    expect(await level(A.tenantId)).toBe(1);
    const lapsedAudit = await su.query(
      "SELECT details FROM scf.audit_log WHERE tenant_id = $1 AND action = 'verification.evidence_lapsed'",
      [A.tenantId],
    );
    expect(lapsedAudit.rowCount).toBe(1);

    // It comes back: the evidence is revalidated (same row), L3 again.
    slProjects = all;
    const back = await runRegistrySync(
      db,
      { sources: [sources()[0] as StellarlightSource], maxDropShare: 0.2 },
      cap.ctx(),
    );
    expect(back.tenants.get(A.tenantId)?.evidenceRevalidated).toBe(1);
    expect(await level(A.tenantId)).toBe(3);

    // An SCF operator rejects the link: the sync never re-confirms it, and the evidence lapses.
    await su.query(
      `UPDATE scf.tenant_registry_links SET status = 'rejected', decided_by = $2, decided_at = now()
        WHERE tenant_id = $1`,
      [A.tenantId, A.userId],
    );
    await runRegistrySync(
      db,
      { sources: [sources()[0] as StellarlightSource], maxDropShare: 0.2 },
      cap.ctx(),
    );
    const l = await su.query("SELECT status FROM scf.tenant_registry_links WHERE tenant_id = $1", [
      A.tenantId,
    ]);
    expect(l.rows.map((x) => x.status)).toEqual(["rejected"]);
    expect(await level(A.tenantId)).toBe(1);
    expect(cap.lines.join("\n")).not.toContain(H("delta"));
  });
});
