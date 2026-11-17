// SPDX-License-Identifier: Apache-2.0
// Ecosystem Usage Map against real PostgreSQL (migration 0075): the SCF operator's list (every registry project with
// contracts, unclaimed ones labelled "public chain data — ownership not verified", the claim and verified badges, the
// distinct-account floor, filters, CSV) and detail; the tenant's own view (claimed projects only, exact, the tenant's
// footprint state per contract); isolation — a tenant never reads an unclaimed project, through the API or around it.
// The usage rows are written here as the job would (job usage_map has its own integration test); all registry rows
// are fake.

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  type Harness,
  newGithubUser,
  operatorSession,
  signInGithub,
  startHarness,
} from "../support/harness.ts";

let h: Harness;
const run = randomUUID().slice(0, 6);
const P_CLAIMED = randomUUID();
const P_ATLAS = randomUUID(); // the same project from the second source: categories
const P_OPEN = randomUUID();
const C_MINE = `C${"K".repeat(54)}A`;
const C_ALSO = `C${"K".repeat(54)}B`;
const C_OPEN = `C${"K".repeat(54)}C`;
const DOMAIN = `usagemap-${run}.example`;
const sha = (s: string) => createHash("sha256").update(s).digest();
const START = "2026-11-09T00:00:00Z";
const END = "2026-11-16T00:00:00Z";
let owner = "";
let other = "";
let tenantId = "";
let otherTenant = "";

async function row(
  id: string,
  source: string,
  name: string,
  contracts: string[],
  extra: { cats?: string[]; round?: number } = {},
) {
  await h.su.query(
    `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, registrable_domains, contract_ids,
       scf_categories, award_round, scf_awarded, fetched_at, content_sha256, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now(), $9, '{}')`,
    [
      id,
      source,
      `um-${id}`,
      name,
      id === P_OPEN ? [] : [DOMAIN],
      contracts,
      extra.cats ?? [],
      extra.round ?? null,
      sha(id),
    ],
  );
}

beforeAll(async () => {
  h = await startHarness();
  await row(P_CLAIMED, "stellarlight", `Usage Dex ${run}`, [C_MINE, C_ALSO], { round: 37 });
  await row(P_ATLAS, "pg_atlas", `Usage Dex ${run}`, [], { cats: ["financial_protocols"] });
  await row(P_OPEN, "stellarlight", `Usage Open ${run}`, [C_OPEN], { round: 38 });

  owner = await signInGithub(h, newGithubUser());
  const t = await call(h, {
    method: "POST",
    url: "/v1/tenants",
    cookie: owner,
    body: { slug: `um-${run}`, name: `UM ${run}` },
  });
  expect(t.statusCode, t.body).toBe(201);
  tenantId = t.json().tenant_id;
  other = await signInGithub(h, newGithubUser());
  const o = await call(h, {
    method: "POST",
    url: "/v1/tenants",
    cookie: other,
    body: { slug: `um-o-${run}`, name: `UMO ${run}` },
  });
  otherTenant = o.json().tenant_id;
  // The claim (/onboard → a verified domain confirms the link) and a verified footprint item for one contract.
  await h.su.query(
    `INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status)
     VALUES ($1, $2, ARRAY['registrable_domain'], 'confirmed'), ($3, $4, ARRAY['verified_contract'], 'candidate')`,
    [tenantId, P_CLAIMED, otherTenant, P_OPEN],
  );
  const users = await h.su.query<{ user_id: string }>(
    "SELECT user_id::text FROM scf.memberships WHERE tenant_id = $1 LIMIT 1",
    [tenantId],
  );
  const ev = await h.su.query<{ evidence_id: string }>(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, status) VALUES ($1, 'stellar_account', $2, 'valid')
     RETURNING evidence_id::text`,
    [tenantId, `G${"K".repeat(55)}`],
  );
  await h.su.query(
    `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, created_by, status, verified_role,
                                         verified_by_evidence, verified_at)
     VALUES ($1, $2, 'public', $3, 'verified', 'deployer', $4, now()), ($1, $5, 'public', $3, 'declared', NULL, NULL, NULL)`,
    [tenantId, C_MINE, users.rows[0]?.user_id, ev.rows[0]?.evidence_id, C_ALSO],
  );
  // What job usage_map stores for the week (mainnet).
  for (let i = 0; i < 7; i++) {
    const day = `2026-11-${String(9 + i).padStart(2, "0")}`;
    await h.su.query(
      `INSERT INTO scf.usage_map_days (network, day, ledgers, ledger_first, ledger_last, anchor_ledger, anchor_hash,
                                       anchor_checked, projects, contracts)
       VALUES ('mainnet', $1, 17280, $2::bigint, $2::bigint + 17279, $2::bigint + 17280, repeat('ab', 32), true, 2, 3)
       ON CONFLICT DO NOTHING`,
      [day, 60_000_000 + i * 17_280],
    );
    await h.su.query(
      `INSERT INTO scf.usage_map_project_daily (registry_project_id, network, day, invocations, successful_invocations,
                     distinct_invokers, contract_calls, contracts_listed, contracts_invoked)
       VALUES ($1, 'mainnet', $3, 100, 90, 30, 5, 2, 2), ($2, 'mainnet', $3, 4, 4, 2, 0, 1, 1)`,
      [P_CLAIMED, P_OPEN, day],
    );
    await h.su.query(
      `INSERT INTO scf.usage_map_contract_daily (network, day, contract_id, invocations, successful_invocations,
                     distinct_invokers, contract_calls, successful_contract_calls)
       VALUES ('mainnet', $1, $2, 80, 75, 25, 5, 5), ('mainnet', $1, $3, 20, 15, 8, 0, 0), ('mainnet', $1, $4, 4, 4, 2, 0, 0)`,
      [day, C_MINE, C_ALSO, C_OPEN],
    );
    await h.su.query(
      `INSERT INTO scf.usage_map_function_daily (network, day, contract_id, function_name, caller_kind, calls, successful_calls)
       VALUES ('mainnet', $1, $2, 'swap', 'account', 80, 75), ('mainnet', $1, $2, 'swap', 'contract', 5, 5),
              ('mainnet', $1, $3, 'deposit', 'account', 20, 15), ('mainnet', $1, $4, 'mint', 'account', 4, 4)`,
      [day, C_MINE, C_ALSO, C_OPEN],
    );
  }
  await h.su.query(
    `INSERT INTO scf.usage_map_project_weekly (registry_project_id, network, week_start, active_accounts,
                   active_accounts_successful, invocations, successful_invocations, contract_calls)
     VALUES ($1, 'mainnet', '2026-11-09', 120, 110, 700, 630, 35), ($2, 'mainnet', '2026-11-09', 3, 3, 28, 28, 0)`,
    [P_CLAIMED, P_OPEN],
  );
}, 300_000);

afterAll(async () => {
  if (h) {
    await h.su.query(
      "DELETE FROM scf.usage_map_project_weekly WHERE registry_project_id = ANY($1::uuid[])",
      [[P_CLAIMED, P_OPEN]],
    );
    await h.su.query(
      "DELETE FROM scf.usage_map_days WHERE day >= '2026-11-09' AND day < '2026-11-16'",
    );
    expect(h.responseProblems).toEqual([]);
    await h.close();
  }
});

describe("operator usage map", () => {
  it("lists every project with contracts, labelled, badged and floored; filters and CSV", async () => {
    const op = await operatorSession(h, "operator");
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/usage-map?start=${START}&end=${END}&network=mainnet`,
      cookie: op.cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    type Item = Record<string, unknown> & { registry_project_id: string };
    const byId = new Map<string, Item>(b.items.map((i: Item) => [i.registry_project_id, i]));
    expect(b.days).toHaveLength(7);
    expect(byId.get(P_CLAIMED)).toMatchObject({
      name: `Usage Dex ${run}`,
      categories: ["financial_protocols"], // from the PG Atlas row of the same project
      award_round: 37,
      status: "verified",
      contracts_listed: 2,
      contracts_verified: 1,
      invocations: 700,
      success_rate: 0.9,
      contract_calls: 35,
      peak_daily_invokers: 30,
      week_start: "2026-11-09",
      weekly_active_accounts: 120,
      weekly_active_accounts_successful: 110,
    });
    expect(byId.get(P_CLAIMED)?.daily_invocations).toEqual([100, 100, 100, 100, 100, 100, 100]);
    expect(byId.get(P_OPEN)).toMatchObject({
      status: "unclaimed", // a candidate link is not a claim
      label: "public chain data — ownership not verified",
      invocations: 28, // public ledger counts, exact
      peak_daily_invokers: null, // below op_min_count
      weekly_active_accounts: null,
    });
    expect(byId.has(P_ATLAS)).toBe(false); // lists no contracts itself

    const f = await call(h, {
      method: "GET",
      url: `/v1/operator/usage-map?start=${START}&end=${END}&network=mainnet&round=38&status=unclaimed&q=${run}`,
      cookie: op.cookie,
    });
    expect(f.json().items.map((i: Item) => i.registry_project_id)).toEqual([P_OPEN]);
    const csv = await call(h, {
      method: "GET",
      url: `/v1/operator/usage-map?start=${START}&end=${END}&network=mainnet&category=financial_protocols`,
      cookie: op.cookie,
      headers: { accept: "text/csv" },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toContain("registry_project_id,name,status,label");
    expect(lines.filter((l) => l.includes(P_CLAIMED))).toHaveLength(1);
    expect(lines.some((l) => l.includes(P_OPEN))).toBe(false);
    const audit = await h.su.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM scf.audit_log WHERE action = 'operator.read.op_usage_map' AND actor_id = $1",
      [op.userId],
    );
    expect(audit.rows[0]?.n).toBe(3);
  });

  it("shows one project's detail; unknown or contract-less projects are 404; tenants get 403", async () => {
    const op = await operatorSession(h, "operator");
    const d = await call(h, {
      method: "GET",
      url: `/v1/operator/usage-map/${P_CLAIMED}?start=${START}&end=${END}&network=mainnet`,
      cookie: op.cookie,
    });
    expect(d.statusCode, d.body).toBe(200);
    const b = d.json();
    expect(b).toMatchObject({
      status: "verified",
      claimed: true,
      days_covered: 7,
      success_rate: 0.9,
    });
    expect(b.daily).toHaveLength(7);
    expect(b.weekly).toEqual([
      expect.objectContaining({ week_start: "2026-11-09", active_accounts: 120 }),
    ]);
    expect(b.contracts).toEqual([
      expect.objectContaining({ contract_id: C_MINE, invocations: 560, footprint_verified: true }),
      expect.objectContaining({ contract_id: C_ALSO, invocations: 140, footprint_verified: false }),
    ]);
    expect(b.functions[0]).toEqual({
      contract_id: C_MINE,
      function: "swap",
      caller_kind: "account",
      calls: 560,
      successful_calls: 525,
    });
    for (const id of [randomUUID(), P_ATLAS]) {
      const r = await call(h, {
        method: "GET",
        url: `/v1/operator/usage-map/${id}?start=${START}&end=${END}&network=mainnet`,
        cookie: op.cookie,
      });
      expect(r.statusCode, id).toBe(404);
    }
    for (const url of [
      `/v1/operator/usage-map?start=${START}&end=${END}`,
      `/v1/operator/usage-map/${P_OPEN}?start=${START}&end=${END}`,
    ]) {
      expect((await call(h, { method: "GET", url, cookie: owner })).statusCode).toBe(403);
    }
  });
});

describe("tenant usage map (claimed projects only)", () => {
  it("shows the claimed project's series exactly, with the tenant's footprint state per contract", async () => {
    const r = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenantId}/onchain/usage-map?start=${START}&end=${END}&network=mainnet`,
      cookie: owner,
    });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.projects).toHaveLength(1);
    const p = b.projects[0];
    expect(p).toMatchObject({
      registry_project_id: P_CLAIMED,
      status: "verified",
      contracts_verified: 1,
    });
    expect(p.contracts.map((c: { footprint: string }) => c.footprint)).toEqual([
      "verified",
      "declared",
    ]);
    expect(p.daily[0]).toMatchObject({
      day: "2026-11-09",
      invocations: 100,
      distinct_invokers: 30,
    });
    expect(p.weekly[0]).toMatchObject({ active_accounts: 120 });
    expect(p.functions.map((f: { contract_id: string }) => f.contract_id)).not.toContain(C_OPEN);
    expect(JSON.stringify(b)).not.toContain(P_OPEN);
  });

  it("a tenant with only a candidate link sees nothing, and cannot read another tenant's view", async () => {
    const r = await call(h, {
      method: "GET",
      url: `/v1/tenants/${otherTenant}/onchain/usage-map?start=${START}&end=${END}&network=mainnet`,
      cookie: other,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().projects).toEqual([]);
    const cross = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenantId}/onchain/usage-map?start=${START}&end=${END}`,
      cookie: other,
    });
    expect([403, 404]).toContain(cross.statusCode);
  });

  it("RLS: the database itself hides unclaimed rows from a tenant context (no API in between)", async () => {
    const c = await h.su.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE scf_app");
      await c.query(
        "SELECT scf.set_tenant_ctx(p_tenant => $1::uuid, p_actor_kind => 'user', p_actor_id => gen_random_uuid()::text)",
        [otherTenant],
      );
      const q = async (sql: string) => (await c.query<{ n: number }>(sql)).rows[0]?.n;
      expect(await q("SELECT count(*)::int AS n FROM scf.usage_map_project_daily")).toBe(0);
      expect(await q("SELECT count(*)::int AS n FROM scf.usage_map_contract_daily")).toBe(0);
      expect(await q("SELECT count(*)::int AS n FROM scf.usage_map_function_daily")).toBe(0);
      expect(await q("SELECT count(*)::int AS n FROM scf.usage_map_project_weekly")).toBe(0);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
