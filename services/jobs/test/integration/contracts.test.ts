// SPDX-License-Identifier: Apache-2.0
// Acceptance (C-19, C-136, C-137; data-model §12.1 Registered Footprint, contracts only): job
// contract_verification marks a declared contract `verified` (method deployer_admin_match) only when the ledger shows a
// verified account of the tenant (valid stellar_account evidence) as its deployer (Horizon operations + CAP-46 id) or
// current admin (RPC instance storage); a tenant with verified accounts whose claim the ledger does not support gets
// `rejected` with a closed reason (not_deployer_or_admin, not_found_on_ledger). A verification is lost when the admin
// changes or the evidence is revoked; accounts of other tenants never count; only the deployment's network is checked;
// writes are under the tenant's context with audit rows; nothing changes while the ledger is unavailable. Negative
// tests of the conflict rule: the same contract verified for two tenants flags both (conflict_since), an operator's
// claimed_by_other_tenant rejection stands, the due re-check (next_check_at) clears the other flag, and an on-demand
// re-check verifies a rejected claim once the tenant can prove it.

import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb } from "../../src/db.ts";
import { runContractVerification } from "../../src/jobs/contract-verification.ts";
import { HorizonRpcLedger } from "../../src/stellar/ledger.ts";
import { contractIdFromAccount, parseSalt, strkeyEncode, VERSION } from "../../src/stellar/xdr.ts";
import { capture, jobsDb, seedSite, superClient } from "../support/harness.ts";
import { startFakeLedger } from "../support/stellar-fakes.ts";

let su: pg.Pool;
let db: ScfDb;
let fake: Awaited<ReturnType<typeof startFakeLedger>>;

const account = () => strkeyEncode(randomBytes(32), VERSION.account);
const contract = () => strkeyEncode(randomBytes(32), VERSION.contract);

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  fake = await startFakeLedger(Number(process.env.SCF_WSG_LEDGER_PORT ?? 56271));
  // Contracts of earlier runs on a reused stack would be checked against this fake ledger too: start clean.
  await su.query("DELETE FROM scf.declared_contracts");
});

afterAll(async () => {
  await su?.end();
  await db?.pool.end();
  await fake?.close();
});

const ledger = () =>
  new HorizonRpcLedger({
    horizonUrl: `${fake.url}/horizon`,
    rpcUrl: `${fake.url}/rpc`,
    network: "testnet",
  });

async function evidence(tenantId: string, g: string, status = "valid"): Promise<string> {
  const r = await su.query<{ evidence_id: string }>(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, status) VALUES ($1, 'stellar_account', $2, $3)
     RETURNING evidence_id`,
    [tenantId, g, status],
  );
  return r.rows[0]?.evidence_id as string;
}

async function declare(
  tenantId: string,
  userId: string,
  c: string,
  network = "testnet",
): Promise<string> {
  const r = await su.query<{ contract_ref: string }>(
    `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, created_by) VALUES ($1, $2, $3, $4)
     RETURNING contract_ref`,
    [tenantId, c, network, userId],
  );
  return r.rows[0]?.contract_ref as string;
}

async function state(ref: string) {
  const r = await su.query(
    `SELECT status, verified_role, verified_by_evidence, last_checked_at IS NOT NULL AS checked, rejected_reason,
            verification_method, conflict_since IS NOT NULL AS conflict, next_check_at IS NOT NULL AS due
       FROM scf.declared_contracts WHERE contract_ref = $1`,
    [ref],
  );
  return r.rows[0];
}

describe("contract_verification", () => {
  it("verifies by deployer and by admin, rejects unsupported claims, and loses a changed admin", async () => {
    const A = await seedSite(su);
    const B = await seedSite(su);
    const gA = account();
    const gB = account();
    const gRevoked = account();
    const evA = await evidence(A.tenantId, gA);
    await evidence(B.tenantId, gB);
    await evidence(A.tenantId, gRevoked, "revoked");
    const salt = BigInt(`0x${randomBytes(32).toString("hex")}`).toString();
    const deployed = contractIdFromAccount("testnet", gA, parseSalt(salt));
    fake.state.creations.set(gA, [{ salt }]);
    fake.state.creations.set(gB, []);
    const administered = contract();
    const othersAdmin = contract(); // admin is B's account: A must not get it verified
    const revokedAdmin = contract();
    const plain = contract();
    const missing = contract(); // no instance on the ledger
    fake.state.admins.set(administered, gA);
    fake.state.admins.set(othersAdmin, gB);
    fake.state.admins.set(revokedAdmin, gRevoked);
    fake.state.admins.set(plain, null);
    const rDeployed = await declare(A.tenantId, A.userId, deployed);
    const rAdmin = await declare(A.tenantId, A.userId, administered);
    const rOthers = await declare(A.tenantId, A.userId, othersAdmin);
    const rRevoked = await declare(A.tenantId, A.userId, revokedAdmin);
    const rPlain = await declare(A.tenantId, A.userId, plain);
    const rMissing = await declare(A.tenantId, A.userId, missing);
    const rPublic = await declare(A.tenantId, A.userId, deployed, "public"); // other network: not checked

    const cap = capture();
    const res = await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(res).toMatchObject({ verified: 2, downgraded: 0, rejected: 4, failedTenants: 0 });
    expect(await state(rDeployed)).toMatchObject({
      status: "verified",
      verified_role: "deployer",
      verified_by_evidence: evA,
      verification_method: "deployer_admin_match",
      rejected_reason: null,
    });
    expect(await state(rAdmin)).toMatchObject({
      status: "verified",
      verified_role: "admin",
      verified_by_evidence: evA,
    });
    for (const r of [rOthers, rRevoked, rPlain]) {
      expect(await state(r)).toMatchObject({
        status: "rejected",
        rejected_reason: "not_deployer_or_admin",
        verified_role: null,
        verification_method: null,
        checked: true,
      });
    }
    expect(await state(rMissing)).toMatchObject({
      status: "rejected",
      rejected_reason: "not_found_on_ledger",
    });
    expect(await state(rPublic)).toMatchObject({ status: "declared", checked: false });
    const rejections = await su.query<{
      target_id: string;
      details: { reason: string; kind: string };
    }>(
      "SELECT target_id, details FROM scf.audit_log WHERE tenant_id = $1 AND action = 'footprint.item_rejected'",
      [A.tenantId],
    );
    expect(rejections.rows.map((x) => x.details.reason).sort()).toEqual([
      "not_deployer_or_admin",
      "not_deployer_or_admin",
      "not_deployer_or_admin",
      "not_found_on_ledger",
    ]);
    // The audit rows carry no account or contract of anyone else.
    expect(JSON.stringify(rejections.rows)).not.toContain(gB);
    const audit = await su.query<{ action: string; target_id: string; details: { role: string } }>(
      `SELECT action, target_id, details FROM scf.audit_log WHERE tenant_id = $1 AND action LIKE 'verification.%'
        ORDER BY seq`,
      [A.tenantId],
    );
    expect(audit.rows.map((a) => [a.action, a.target_id, a.details.role])).toEqual([
      ["verification.contract_verified", rDeployed, "deployer"],
      ["verification.contract_verified", rAdmin, "admin"],
    ]);

    // Idempotent: nothing changes, no new audit rows.
    const again = await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(again).toMatchObject({ verified: 0, downgraded: 0, rejected: 0 });

    // The admin moves to someone else: the admin-based verification is lost (rejected); the deployer stays.
    fake.state.admins.set(administered, gB);
    const moved = await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(moved).toMatchObject({ verified: 0, downgraded: 1 });
    expect(await state(rAdmin)).toMatchObject({
      status: "rejected",
      verified_role: null,
      rejected_reason: "not_deployer_or_admin",
    });
    expect(await state(rDeployed)).toMatchObject({ status: "verified", verified_role: "deployer" });
    const down = await su.query(
      "SELECT details FROM scf.audit_log WHERE tenant_id = $1 AND action = 'verification.contract_unverified'",
      [A.tenantId],
    );
    expect(down.rows[0]?.details).toMatchObject({ previous_role: "admin" });
    // evidence_lapsed stays for evidence itself (registry, domains), not for declared contracts (migration 0057)
    const lapsed = await su.query(
      "SELECT 1 FROM scf.audit_log WHERE tenant_id = $1 AND action = 'verification.evidence_lapsed'",
      [A.tenantId],
    );
    expect(lapsed.rowCount).toBe(0);

    // The account's evidence is revoked: even the deployer-based verification goes.
    await su.query(
      "UPDATE scf.verification_evidence SET status = 'revoked', revoked_at = now() WHERE evidence_id = $1",
      [evA],
    );
    await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(await state(rDeployed)).toMatchObject({
      status: "rejected",
      rejected_reason: "not_deployer_or_admin",
    });
  });

  it("flags a contract verified for two tenants for both, keeps an operator's rejection, clears the other flag", async () => {
    const X = await seedSite(su);
    const Y = await seedSite(su);
    const Z = await seedSite(su);
    const gX = account();
    const gY = account();
    await evidence(X.tenantId, gX);
    await evidence(Y.tenantId, gY);
    await evidence(Z.tenantId, account());
    const salt = BigInt(`0x${randomBytes(32).toString("hex")}`).toString();
    const K = contractIdFromAccount("testnet", gX, parseSalt(salt));
    fake.state.creations.set(gX, [{ salt }]); // X deployed it
    fake.state.creations.set(gY, []);
    fake.state.admins.set(K, gY); // Y is its admin
    const kx = await declare(X.tenantId, X.userId, K);
    const ky = await declare(Y.tenantId, Y.userId, K);
    const kz = await declare(Z.tenantId, Z.userId, K); // Z claims it too but cannot prove anything

    const cap = capture();
    const r = await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(r).toMatchObject({ conflictsFlagged: 2 });
    expect(await state(kx)).toMatchObject({
      status: "verified",
      verified_role: "deployer",
      conflict: true,
    });
    expect(await state(ky)).toMatchObject({
      status: "verified",
      verified_role: "admin",
      conflict: true,
    });
    expect(await state(kz)).toMatchObject({
      status: "rejected",
      rejected_reason: "not_deployer_or_admin",
      conflict: false,
    });
    // Flagged items are not counted: onchain_correlation's target query excludes them.
    const targets = await su.query(
      "SELECT 1 FROM scf.declared_contracts WHERE contract_id = $1 AND status = 'verified' AND conflict_since IS NULL",
      [K],
    );
    expect(targets.rowCount).toBe(0);
    // Idempotent: the flags stay with their first timestamp.
    expect(await runContractVerification(db, ledger(), "testnet", cap.ctx())).toMatchObject({
      conflictsFlagged: 0,
      conflictsCleared: 0,
    });

    // An operator_admin rejects Y's claim (scf.op_footprint_reject's effect) and marks X's item due.
    await su.query(
      `UPDATE scf.declared_contracts SET status = 'rejected', rejected_reason = 'claimed_by_other_tenant',
              verified_role = NULL, verified_by_evidence = NULL, verified_at = NULL, verification_method = NULL,
              conflict_since = NULL, next_check_at = NULL WHERE contract_ref = $1`,
      [ky],
    );
    await su.query(
      "UPDATE scf.declared_contracts SET next_check_at = now() WHERE contract_ref = $1",
      [kx],
    );
    // Y asks for a re-check: the operator's decision stands.
    await su.query(
      "UPDATE scf.declared_contracts SET next_check_at = now() WHERE contract_ref = $1",
      [ky],
    );
    const due = await runContractVerification(db, ledger(), "testnet", cap.ctx(), "due");
    expect(due).toMatchObject({ checked: 2, conflictsCleared: 1 });
    expect(await state(kx)).toMatchObject({ status: "verified", conflict: false, due: false });
    expect(await state(ky)).toMatchObject({
      status: "rejected",
      rejected_reason: "claimed_by_other_tenant",
      due: false,
    });
    // The due scope reads nothing else (Z's rejected claim is not due).
    expect(await state(kz)).toMatchObject({ status: "rejected", due: false });
  });

  it("re-checks a rejected claim on demand and verifies it once the tenant can prove it", async () => {
    const T = await seedSite(su);
    await evidence(T.tenantId, account());
    const gNew = account();
    const c = contract();
    fake.state.admins.set(c, gNew);
    const ref = await declare(T.tenantId, T.userId, c);
    const cap = capture();
    await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(await state(ref)).toMatchObject({
      status: "rejected",
      rejected_reason: "not_deployer_or_admin",
    });
    // The daily run does not re-check a rejected claim by itself.
    await evidence(T.tenantId, gNew);
    await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(await state(ref)).toMatchObject({ status: "rejected" });
    // verifyFootprintItem queues it (next_check_at); the 5-minute due run decides it.
    await su.query(
      "UPDATE scf.declared_contracts SET next_check_at = now() WHERE contract_ref = $1",
      [ref],
    );
    const due = await runContractVerification(db, ledger(), "testnet", cap.ctx(), "due");
    expect(due).toMatchObject({ checked: 1, verified: 1 });
    expect(await state(ref)).toMatchObject({
      status: "verified",
      verified_role: "admin",
      rejected_reason: null,
      verification_method: "deployer_admin_match",
      due: false,
    });
    expect(cap.lines.join("\n")).not.toMatch(/[GC][A-Z2-7]{55}/);
  });

  it("never rejects or downgrades on an incomplete ledger answer", async () => {
    const T = await seedSite(su);
    const g = account();
    const ev = await evidence(T.tenantId, g);
    const salt = BigInt(`0x${randomBytes(32).toString("hex")}`).toString();
    const deployed = contractIdFromAccount("testnet", g, parseSalt(salt));
    const other = contract();
    fake.state.creations.set(g, [{ salt }]);
    fake.state.admins.set(deployed, null);
    fake.state.admins.set(other, null);
    const rDeployed = await declare(T.tenantId, T.userId, deployed);
    const rOther = await declare(T.tenantId, T.userId, other);
    const cap = capture();
    // the full walk verifies the deployed contract and rejects the other
    await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(await state(rDeployed)).toMatchObject({ status: "verified", verified_role: "deployer" });
    expect(await state(rOther)).toMatchObject({ status: "rejected" });
    // a busy account: its creation lies beyond the walk's bound (2 pages of 200 here)
    fake.state.filler = 450;
    await su.query(
      "UPDATE scf.declared_contracts SET status = 'declared', rejected_reason = NULL, last_checked_at = NULL WHERE contract_ref = $1",
      [rOther],
    );
    const short = new HorizonRpcLedger({
      horizonUrl: `${fake.url}/horizon`,
      rpcUrl: `${fake.url}/rpc`,
      network: "testnet",
      maxPages: 2,
    });
    try {
      const r = await runContractVerification(db, short, "testnet", cap.ctx());
      expect(r).toMatchObject({ downgraded: 0, rejected: 0 });
      expect(r.undetermined).toBeGreaterThanOrEqual(1);
      // the deployer-based verification stands (the deployer never changes) …
      expect(await state(rDeployed)).toMatchObject({
        status: "verified",
        verified_role: "deployer",
        verified_by_evidence: ev,
      });
      // … and a claim the walk could not decide stays declared, not rejected
      expect(await state(rOther)).toMatchObject({ status: "declared", rejected_reason: null });
      expect(
        cap.lines.some((l) => l.includes('"event":"contract_verification_undetermined"')),
      ).toBe(true);
      // bounded history: a complete walk proves nothing unless it starts with the account's creation
      fake.state.filler = 10;
      fake.state.elder = 5_000_000;
      const bounded = () =>
        new HorizonRpcLedger({
          horizonUrl: `${fake.url}/horizon`,
          rpcUrl: `${fake.url}/rpc`,
          network: "testnet",
        });
      await runContractVerification(db, bounded(), "testnet", cap.ctx());
      expect(await state(rOther)).toMatchObject({ status: "declared" });
      fake.state.created.add(g);
      await runContractVerification(db, bounded(), "testnet", cap.ctx());
      expect(await state(rOther)).toMatchObject({
        status: "rejected",
        rejected_reason: "not_deployer_or_admin",
      });
      // without an RPC the admin cannot be read: undetermined, nothing changes
      await su.query(
        "UPDATE scf.declared_contracts SET status = 'declared', rejected_reason = NULL WHERE contract_ref = $1",
        [rOther],
      );
      const noRpc = new HorizonRpcLedger({
        horizonUrl: `${fake.url}/horizon`,
        rpcUrl: null,
        network: "testnet",
      });
      await runContractVerification(db, noRpc, "testnet", cap.ctx());
      expect(await state(rOther)).toMatchObject({ status: "declared" });
    } finally {
      fake.state.filler = 250;
      fake.state.elder = 2;
      fake.state.created.clear();
    }
  });

  it("changes nothing while the ledger is unavailable and reports failure", async () => {
    const A = await seedSite(su);
    const g = account();
    await evidence(A.tenantId, g);
    const c = contract();
    fake.state.admins.set(c, g);
    const ref = await declare(A.tenantId, A.userId, c);
    fake.state.down = true;
    const cap = capture();
    await expect(runContractVerification(db, ledger(), "testnet", cap.ctx())).rejects.toThrow(
      /ledger unavailable/,
    );
    expect(await state(ref)).toMatchObject({ status: "declared", checked: false });
    fake.state.down = false;
    await runContractVerification(db, ledger(), "testnet", cap.ctx());
    expect(await state(ref)).toMatchObject({ status: "verified", verified_role: "admin" });
    expect(cap.lines.join("\n")).not.toContain(g);
  });
});
