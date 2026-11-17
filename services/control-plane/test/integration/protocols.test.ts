// SPDX-License-Identifier: Apache-2.0
// Protocol interactions against real PostgreSQL (migration 0082): the tenant's own view (its rows only, per protocol
// with the share of its transactions and the daily series, the registry version) and the SCF operator's list (every
// registry project and tenant per protocol, labelled; the protocols' network totals; audited); isolation — another
// tenant sees nothing of it, a tenant cannot call the operator endpoint. The rows are written here as job
// protocol_usage would (the job has its own integration test); every registry row is fake.

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
const P = randomUUID();
const C_MINE = `C${"Q".repeat(54)}A`;
const START = "2026-11-09T00:00:00Z";
const END = "2026-11-12T00:00:00Z";
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"];
let owner = "";
let other = "";
let tenantId = "";
let otherTenant = "";

beforeAll(async () => {
  h = await startHarness();
  await h.su.query(
    `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, contract_ids, scf_awarded,
                                        fetched_at, content_sha256, raw)
     VALUES ($1, 'stellarlight', $2, $3, ARRAY[$4], true, now(), $5, '{}')`,
    [
      P,
      `pu-${run}`,
      `Proto App ${run}`,
      `C${"P".repeat(55)}`,
      createHash("sha256").update(P).digest(),
    ],
  );
  owner = await signInGithub(h, newGithubUser());
  const t = await call(h, {
    method: "POST",
    url: "/v1/tenants",
    cookie: owner,
    body: { slug: `pu-${run}`, name: `PU ${run}` },
  });
  expect(t.statusCode, t.body).toBe(201);
  tenantId = t.json().tenant_id;
  other = await signInGithub(h, newGithubUser());
  const o = await call(h, {
    method: "POST",
    url: "/v1/tenants",
    cookie: other,
    body: { slug: `pu-o-${run}`, name: `PUO ${run}` },
  });
  otherTenant = o.json().tenant_id;
  // One verified contract of the tenant on mainnet (the subject of its figures; listed for the explorer links).
  const users = await h.su.query<{ user_id: string }>(
    "SELECT user_id::text FROM scf.memberships WHERE tenant_id = $1 LIMIT 1",
    [tenantId],
  );
  const ev = await h.su.query<{ evidence_id: string }>(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, status) VALUES ($1, 'stellar_account', $2, 'valid')
     RETURNING evidence_id::text`,
    [tenantId, `G${"Q".repeat(55)}`],
  );
  await h.su.query(
    `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, created_by, status, verified_role,
                                         verified_by_evidence, verified_at)
     VALUES ($1, $2, 'public', $3, 'verified', 'deployer', $4, now())`,
    [tenantId, C_MINE, users.rows[0]?.user_id, ev.rows[0]?.evidence_id],
  );
  for (const [i, day] of DAYS.entries()) {
    await h.su.query(
      `INSERT INTO scf.protocol_usage_days (network, day, ledgers, ledger_first, ledger_last, anchor_ledger, anchor_hash,
                                            anchor_checked, registry_version, projects, tenants)
       VALUES ('mainnet', $1, 17280, $2::bigint, $2::bigint + 17279, $2::bigint + 17280, repeat('ab', 32), true,
               '2026-11-19.1', 1, 1) ON CONFLICT DO NOTHING`,
      [day, 70_000_000 + i * 17_280],
    );
    await h.su.query(
      `INSERT INTO scf.protocol_usage_network_daily (network, day, protocol, transactions, successful_transactions)
       VALUES ('mainnet', $1, 'blend', 1000, 950), ('mainnet', $1, 'reflector', 300, 300) ON CONFLICT DO NOTHING`,
      [day],
    );
    await h.su.query(
      `INSERT INTO scf.protocol_usage_project_daily (registry_project_id, network, day, protocol, transactions,
                                                     successful_transactions)
       VALUES ($1, 'mainnet', $2, 'any', 10, 9), ($1, 'mainnet', $2, 'soroswap', 4, 4)`,
      [P, day],
    );
    await h.su.query(
      `INSERT INTO scf.protocol_usage_tenant_daily (tenant_id, network, day, protocol, transactions,
                                                    successful_transactions, contracts, registry_version)
       VALUES ($1, 'mainnet', $2, 'any', 20, 18, 2, '2026-11-19.1'), ($1, 'mainnet', $2, 'blend', 5, 5, 2, '2026-11-19.1'),
              ($1, 'mainnet', $2, 'reflector', $3, $3, 2, '2026-11-19.1')`,
      [tenantId, day, i === 0 ? 0 : 2],
    );
  }
}, 300_000);

afterAll(async () => {
  if (h) {
    await h.su.query(
      "DELETE FROM scf.protocol_usage_days WHERE day >= '2026-11-09' AND day < '2026-11-12'",
    );
    await h.su.query("DELETE FROM scf.protocol_usage_tenant_daily WHERE tenant_id = $1", [
      tenantId,
    ]);
    await h.su.query("DELETE FROM scf.registry_projects WHERE registry_project_id = $1", [P]);
    expect(h.responseProblems).toEqual([]);
    await h.close();
  }
});

describe("tenant protocols", () => {
  it("returns the tenant's own interactions per protocol, with shares and the daily series", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenantId}/onchain/protocols?start=${START}&end=${END}&network=mainnet`,
      cookie: owner,
    });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({
      network: "mainnet",
      days_covered: 3,
      days_with_data: 3,
      registry_version: "2026-11-19.1",
      transactions: 60,
      successful_transactions: 54,
    });
    const by = Object.fromEntries(b.protocols.map((p: { protocol: string }) => [p.protocol, p]));
    expect(Object.keys(by)).toEqual(["blend", "soroswap", "defindex", "aquarius", "reflector"]);
    expect(by.blend).toMatchObject({
      name: "Blend",
      transactions: 15,
      share: 0.25,
      days_active: 3,
    });
    expect(by.reflector).toMatchObject({ transactions: 4, days_active: 2 });
    expect(by.soroswap).toMatchObject({ transactions: 0, share: 0 });
    expect(b.daily).toHaveLength(6);
    expect(b.contracts).toEqual([C_MINE]); // its own verified contract, for the explorer links
    // Nothing else names a contract or an account.
    expect(JSON.stringify({ ...b, contracts: [] })).not.toMatch(/[CG][A-Z2-7]{55}/);
  });
  it("shows another tenant nothing of it", async () => {
    const res = await call(h, {
      method: "GET",
      url: `/v1/tenants/${otherTenant}/onchain/protocols?start=${START}&end=${END}&network=mainnet`,
      cookie: other,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      transactions: 0,
      days_with_data: 0,
      registry_version: null,
      daily: [],
    });
    const cross = await call(h, {
      method: "GET",
      url: `/v1/tenants/${tenantId}/onchain/protocols?start=${START}&end=${END}`,
      cookie: other,
    });
    expect([403, 404]).toContain(cross.statusCode);
  });
});

describe("operator protocols", () => {
  it("lists registry projects and tenants per protocol with the network totals, audited", async () => {
    const op = await operatorSession(h, "operator");
    const res = await call(h, {
      method: "GET",
      url: `/v1/operator/protocols?start=${START}&end=${END}&network=mainnet`,
      cookie: op.cookie,
    });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b.days_covered).toBe(3);
    expect(
      b.network_totals.find((x: { protocol: string }) => x.protocol === "blend"),
    ).toMatchObject({
      transactions: 3000,
      successful_transactions: 2850,
    });
    type S = {
      kind: string;
      id: string;
      name: string | null;
      label: string;
      transactions: number;
      protocols: { protocol: string; transactions: number; share: number | null }[];
    };
    const proj = b.subjects.find((s: S) => s.id === P) as S;
    expect(proj).toMatchObject({
      kind: "project",
      name: `Proto App ${run}`,
      label: "public chain data — ownership not verified",
      transactions: 30,
    });
    expect(proj.protocols.find((p) => p.protocol === "soroswap")).toMatchObject({
      transactions: 12,
      share: 0.4,
    });
    const ten = b.subjects.find((s: S) => s.id === tenantId) as S;
    expect(ten).toMatchObject({ kind: "tenant", transactions: 60 });
    const audit = await h.su.query(
      "SELECT 1 FROM scf.audit_log WHERE action = 'operator.read.op_protocol_usage'",
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    const tenantCall = await call(h, {
      method: "GET",
      url: `/v1/operator/protocols?start=${START}&end=${END}`,
      cookie: owner,
    });
    expect(tenantCall.statusCode).toBe(403);
  });
});
