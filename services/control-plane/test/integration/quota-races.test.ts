// SPDX-License-Identifier: Apache-2.0
// Quotas under concurrency and sticky operator decisions:
// concurrent site creations cannot exceed the L0 site limit and concurrent tenant creations cannot exceed the per-user
// tenant quota (C-19); a contract an operator rejected as `claimed_by_other_tenant` stays rejected when the tenant
// removes and declares it again (C-137 (5)).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  startHarness,
  uniqueSlug,
} from "../support/harness.ts";

let h: Harness;
const contractId = () =>
  `C${Array.from({ length: 55 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)]).join("")}`;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("quotas under concurrency (#21)", () => {
  it("parallel site creations at L0 stop at l0_max_sites", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const tenant = await createTenant(h, cookie);
    const max = Number(
      (
        await h.su.query(
          `SELECT (value #>> '{}')::int AS n FROM scf.settings WHERE key = 'l0_max_sites'`,
        )
      ).rows[0]?.n,
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.app.inject({
          method: "POST",
          url: `/v1/tenants/${tenant}/sites`,
          headers: {
            cookie,
            "x-scf-request": "1",
            origin: "https://portal.test",
            "content-type": "application/json",
          },
          payload: JSON.stringify({ name: `S${i}` }),
        }),
      ),
    );
    const created = results.filter((r) => r.statusCode === 201).length;
    expect(results.map((r) => r.statusCode).every((s) => s === 201 || s === 409)).toBe(true);
    expect(created).toBe(max);
    const n = await h.su.query(
      `SELECT count(*)::int AS n FROM scf.sites WHERE tenant_id = $1 AND status <> 'archived'`,
      [tenant],
    );
    expect(n.rows[0]?.n).toBe(max);
  });

  it("parallel tenant creations stop at max_tenants_per_user", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const max = Number(
      (
        await h.su.query(
          `SELECT (value #>> '{}')::int AS n FROM scf.settings WHERE key = 'max_tenants_per_user'`,
        )
      ).rows[0]?.n,
    );
    const results = await Promise.all(
      Array.from({ length: max + 5 }, () =>
        h.app.inject({
          method: "POST",
          url: "/v1/tenants",
          headers: {
            cookie,
            "x-scf-request": "1",
            origin: "https://portal.test",
            "content-type": "application/json",
          },
          payload: JSON.stringify({ slug: uniqueSlug("q"), name: "Q" }),
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).every((s) => s === 201 || s === 409)).toBe(true);
    expect(results.filter((r) => r.statusCode === 201).length).toBe(max);
  });
});

describe("an operator's claimed_by_other_tenant rejection (#23)", () => {
  it("sticks when the tenant removes the contract and declares it again", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const tenant = await createTenant(h, cookie);
    const cid = contractId();
    const add = async () => {
      const r = await call(h, {
        method: "POST",
        url: `/v1/tenants/${tenant}/footprint`,
        cookie,
        body: { kind: "contract", subject: cid, network: "mainnet" },
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json() as { item_id: string; status: string; rejected_reason: string | null };
    };
    const first = await add();
    // what scf.op_footprint_reject leaves behind (operator_admin, step-up; covered by the differentiation suite)
    await h.su.query(
      `UPDATE scf.declared_contracts SET status = 'rejected', rejected_reason = 'claimed_by_other_tenant',
              next_check_at = NULL, conflict_since = NULL WHERE tenant_id = $1 AND contract_ref = $2`,
      [tenant, first.item_id],
    );
    const rm = await call(h, {
      method: "DELETE",
      url: `/v1/tenants/${tenant}/footprint/${first.item_id}`,
      cookie,
    });
    expect(rm.statusCode, rm.body).toBe(204);

    const again = await add();
    expect(again.item_id).toBe(first.item_id);
    expect(again).toMatchObject({ status: "rejected", rejected_reason: "claimed_by_other_tenant" });
    // and the verification job is not asked to re-check it
    const row = await h.su.query(
      `SELECT status, rejected_reason, next_check_at FROM scf.declared_contracts WHERE tenant_id = $1 AND contract_ref = $2`,
      [tenant, first.item_id],
    );
    expect(row.rows[0]).toEqual({
      status: "rejected",
      rejected_reason: "claimed_by_other_tenant",
      next_check_at: null,
    });
    // a verification request on it is refused (it stays with the other tenant until an operator decides otherwise)
    const ver = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint/${first.item_id}/verify`,
      cookie,
      body: { method: "deployer_admin_match" },
    });
    expect(ver.statusCode, ver.body).toBe(400);
  });

  it("other rejections are still dropped on re-declaration (a fresh check)", async () => {
    const cookie = await signInGithub(h, newGithubUser());
    const tenant = await createTenant(h, cookie);
    const cid = contractId();
    const r1 = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie,
      body: { kind: "contract", subject: cid, network: "mainnet" },
    });
    const id = r1.json().item_id as string;
    await h.su.query(
      `UPDATE scf.declared_contracts SET status = 'rejected', rejected_reason = 'not_deployer_or_admin'
        WHERE tenant_id = $1 AND contract_ref = $2`,
      [tenant, id],
    );
    await call(h, { method: "DELETE", url: `/v1/tenants/${tenant}/footprint/${id}`, cookie });
    const r2 = await call(h, {
      method: "POST",
      url: `/v1/tenants/${tenant}/footprint`,
      cookie,
      body: { kind: "contract", subject: cid, network: "mainnet" },
    });
    expect(r2.json()).toMatchObject({ item_id: id, status: "claimed", rejected_reason: null });
  });
});
