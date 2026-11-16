// SPDX-License-Identifier: Apache-2.0
// Job `contract_verification` (daily, plus every 5 minutes for items whose `next_check_at` is due; C-19, C-136, C-137;
// data-model §8.6, §12.1 Registered Footprint; ADR-0015, ADR-0028). Checks the footprint's CONTRACTS only
// (`declared_contracts`); issuing accounts, app accounts and WASM hashes (`footprint_items`) are not
// checked yet and not read here.
//
// Method `deployer_admin_match`: a contract is `verified` when the ledger shows a VERIFIED account of the tenant (valid
// `stellar_account` evidence, L2) as its deployer or its current admin. The deployer is preferred (it never changes):
// a deployer-based verification stands as long as its evidence is valid and is not looked up again; an admin-based
// verification is re-checked every run. Otherwise — once the tenant has at least one verified account to compare
// with — the claim is `rejected` with a closed reason: `not_found_on_ledger` (no live instance; needs the RPC) or
// `not_deployer_or_admin`, but only when the ledger answer is DEFINITE: every deployer look-up
// complete (ledger.ts) and the admin read through the RPC. An incomplete look-up or no RPC is "undetermined": the
// contract keeps its status (a verified contract is never downgraded on "not found within the scan budget"), the run
// counts it and logs `contract_verification_undetermined`. A tenant without any verified account keeps its claims as they are (`declared` =
// the footprint's `claimed`), except that a `verified` contract whose evidence is gone becomes `rejected`. A rejected
// contract is re-checked only on demand (`next_check_at`, set by the control plane's verifyFootprintItem); a rejection
// by an operator (`claimed_by_other_tenant`) is never undone by the job.
//
// Conflicts (C-137): after the per-tenant pass, a cross-tenant read (tenant unset) finds every contract verified for
// two or more tenants on the same network; each such item gets `conflict_since` (all tenants are flagged; nobody wins
// by being first) and an item without a verified twin any more is cleared — each write under its tenant's context.
// A flagged contract keeps its status but is counted nowhere (onchain_correlation, op_cohorts).
//
// Only contracts on this deployment's network (`SCF_STELLAR_NETWORK`, C-114) are checked against the ledger; others
// keep their status and get no `last_checked_at`. Every change is written in one transaction per tenant under that
// tenant's context (F1) with an audit row: `verification.contract_verified` (role, evidence id),
// `verification.contract_unverified` (a verified contract lost its evidence; previous role, reason) or
// `footprint.item_rejected` (a claim was rejected; reason). A ledger outage changes nothing for the affected tenant
// (counted; the job reports failure).

import type { ScfDb } from "../db.ts";
import { errorFields } from "../log.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import type { ContractInstance, ContractLedger, Deployments } from "../stellar/ledger.ts";

const JOB = "contract_verification" as const;

export type ContractStatus = "declared" | "verified" | "rejected";
export type RejectedReason =
  | "not_deployer_or_admin"
  | "not_found_on_ledger"
  | "claimed_by_other_tenant";

interface DeclaredRow {
  tenant_id: string;
  contract_ref: string;
  contract_id: string;
  status: ContractStatus;
  verified_role: "deployer" | "admin" | null;
  verified_by_evidence: string | null;
  rejected_reason: RejectedReason | null;
  operator_rejected: boolean;
}

interface AccountRow {
  tenant_id: string;
  evidence_id: string;
  subject: string;
}

export interface Decision {
  status: ContractStatus;
  role: "deployer" | "admin" | null;
  evidence: string | null;
  reason: RejectedReason | null;
  /** The ledger could not say (incomplete deployer look-up, no RPC): the status is kept. */
  undetermined?: boolean;
}

export interface ContractVerificationResult {
  checked: number;
  verified: number;
  downgraded: number;
  rejected: number;
  failedTenants: number;
  conflictsFlagged: number;
  conflictsCleared: number;
  undetermined: number;
}

export function contractVerificationJob(
  db: ScfDb,
  ledger: ContractLedger,
  opts: {
    network: "public" | "testnet";
    dailyAt: { hour: number; minute: number };
    dueEveryMinutes?: number;
  },
): JobDef {
  return {
    name: JOB,
    triggers: [
      { schedule: { kind: "daily", ...opts.dailyAt }, mode: "daily" },
      { schedule: { kind: "every", minutes: opts.dueEveryMinutes ?? 5 }, mode: "due" },
    ],
    run: async (ctx) => {
      await runContractVerification(
        db,
        ledger,
        opts.network,
        ctx,
        ctx.mode === "due" ? "due" : "all",
      );
    },
  };
}

export async function runContractVerification(
  db: ScfDb,
  ledger: ContractLedger,
  network: "public" | "testnet",
  ctx: JobContext,
  scope: "all" | "due" = "all",
): Promise<ContractVerificationResult> {
  const { contracts, accounts } = await db.tx(JOB, null, async (tx) => ({
    contracts: await tx.query<DeclaredRow>(
      `SELECT c.tenant_id, c.contract_ref, c.contract_id, c.status, c.verified_role, c.verified_by_evidence,
              c.rejected_reason, (c.status = 'rejected' AND c.rejected_reason = 'claimed_by_other_tenant') AS operator_rejected
         FROM scf.declared_contracts c JOIN scf.tenants t USING (tenant_id)
        WHERE c.network = $1 AND c.removed_at IS NULL AND t.status <> 'removed'
          AND (CASE WHEN $2 = 'due' THEN false ELSE c.status IN ('declared', 'verified') END
               OR c.next_check_at <= now())
        ORDER BY c.tenant_id, c.contract_ref`,
      [network, scope],
    ),
    accounts: await tx.query<AccountRow>(
      `SELECT v.tenant_id, v.evidence_id, v.subject FROM scf.verification_evidence v
        WHERE v.kind = 'stellar_account' AND v.status = 'valid' ORDER BY v.verified_at, v.evidence_id`,
    ),
  }));
  const byTenant = new Map<string, DeclaredRow[]>();
  for (const c of contracts) byTenant.set(c.tenant_id, [...(byTenant.get(c.tenant_id) ?? []), c]);
  const deployedCache = new Map<string, Deployments>();
  const instanceCache = new Map<string, ContractInstance | null>();
  const res: ContractVerificationResult = {
    checked: 0,
    verified: 0,
    downgraded: 0,
    rejected: 0,
    failedTenants: 0,
    conflictsFlagged: 0,
    conflictsCleared: 0,
    undetermined: 0,
  };

  for (const [tenantId, rows] of byTenant) {
    checkAborted(ctx.signal);
    const accts = accounts.filter((a) => a.tenant_id === tenantId);
    let decisions: Map<string, Decision>;
    try {
      decisions = new Map();
      for (const c of rows) {
        decisions.set(c.contract_ref, await decide(c, accts, ledger, deployedCache, instanceCache));
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      res.failedTenants += 1;
      ctx.metrics.units.inc({ job: JOB, outcome: "tenant_ledger_unavailable" });
      ctx.log.warn("contract_verification_ledger_unavailable", {
        job: JOB,
        tenant_id: tenantId,
        ...errorFields(err),
      });
      continue;
    }
    await db.tx(JOB, tenantId, async (tx) => {
      for (const c of rows) {
        const d = decisions.get(c.contract_ref) as Decision;
        res.checked += 1;
        if (d.undetermined) {
          res.undetermined += 1;
          await tx.exec(
            `UPDATE scf.declared_contracts SET next_check_at = NULL WHERE tenant_id = $1 AND contract_ref = $2`,
            [tenantId, c.contract_ref],
          );
          continue;
        }
        const same =
          d.status === c.status &&
          d.role === c.verified_role &&
          d.evidence === c.verified_by_evidence &&
          d.reason === c.rejected_reason;
        if (same) {
          await tx.exec(
            `UPDATE scf.declared_contracts SET last_checked_at = now(), next_check_at = NULL
              WHERE tenant_id = $1 AND contract_ref = $2`,
            [tenantId, c.contract_ref],
          );
          continue;
        }
        await tx.exec(
          `UPDATE scf.declared_contracts
              SET status = $3, verified_role = $4, verified_by_evidence = $5,
                  verified_at = CASE WHEN $3 = 'verified' THEN now() END,
                  verification_method = CASE WHEN $3 = 'verified' THEN 'deployer_admin_match' END,
                  rejected_reason = $6, last_checked_at = now(), next_check_at = NULL,
                  conflict_since = CASE WHEN $3 = 'verified' THEN conflict_since END
            WHERE tenant_id = $1 AND contract_ref = $2`,
          [tenantId, c.contract_ref, d.status, d.role, d.evidence, d.reason],
        );
        if (d.status === "verified") {
          res.verified += 1;
          await tx.audit("verification.contract_verified", "declared_contract", c.contract_ref, {
            contract_id: c.contract_id,
            network,
            role: d.role,
            evidence_id: d.evidence,
            method: "deployer_admin_match",
          });
        } else if (c.status === "verified") {
          res.downgraded += 1;
          await tx.audit("verification.contract_unverified", "declared_contract", c.contract_ref, {
            contract_id: c.contract_id,
            network,
            previous_role: c.verified_role,
            reason: d.reason ?? "ledger_no_longer_shows_verified_account",
          });
        } else if (d.status === "rejected") {
          res.rejected += 1;
          await tx.audit("footprint.item_rejected", "declared_contract", c.contract_ref, {
            kind: "contract",
            network: network === "public" ? "mainnet" : network,
            reason: d.reason,
          });
        }
      }
    });
  }

  checkAborted(ctx.signal);
  await reconcileConflicts(db, ctx, res);

  ctx.metrics.rows.inc(
    { job: JOB, relation: "declared_contracts", action: "verified" },
    res.verified,
  );
  ctx.metrics.rows.inc(
    { job: JOB, relation: "declared_contracts", action: "downgraded" },
    res.downgraded,
  );
  ctx.metrics.rows.inc(
    { job: JOB, relation: "declared_contracts", action: "rejected" },
    res.rejected,
  );
  ctx.metrics.rows.inc(
    { job: JOB, relation: "declared_contracts", action: "conflict_flagged" },
    res.conflictsFlagged,
  );
  ctx.metrics.rows.inc(
    { job: JOB, relation: "declared_contracts", action: "undetermined" },
    res.undetermined,
  );
  ctx.log.info("contract_verification_done", {
    job: JOB,
    scope,
    checked: res.checked,
    verified: res.verified,
    downgraded: res.downgraded,
    rejected: res.rejected,
    conflicts_flagged: res.conflictsFlagged,
    conflicts_cleared: res.conflictsCleared,
    failed_tenants: res.failedTenants,
    undetermined: res.undetermined,
  });
  if (res.undetermined > 0)
    ctx.log.warn("contract_verification_undetermined", { job: JOB, contracts: res.undetermined });
  if (res.failedTenants > 0) {
    throw Object.assign(new Error("ledger unavailable for some tenants"), {
      name: "LedgerUnavailable",
    });
  }
  return res;
}

/**
 * C-137 conflict rule: every contract `verified` for two or more (not removed) tenants on the same network is
 * flagged for all of them; a flag without a verified twin any more is cleared. Cross-tenant read, writes per tenant.
 */
async function reconcileConflicts(
  db: ScfDb,
  ctx: JobContext,
  res: ContractVerificationResult,
): Promise<void> {
  const rows = await db.tx(JOB, null, (tx) =>
    tx.query<{ tenant_id: string; contract_ref: string; flagged: boolean; twin: boolean }>(
      `SELECT c.tenant_id, c.contract_ref, c.conflict_since IS NOT NULL AS flagged,
              EXISTS (SELECT 1 FROM scf.declared_contracts o JOIN scf.tenants ot ON ot.tenant_id = o.tenant_id
                       WHERE o.contract_id = c.contract_id AND o.network = c.network AND o.tenant_id <> c.tenant_id
                         AND o.status = 'verified' AND o.removed_at IS NULL AND ot.status <> 'removed') AS twin
         FROM scf.declared_contracts c JOIN scf.tenants t ON t.tenant_id = c.tenant_id
        WHERE c.status = 'verified' AND c.removed_at IS NULL AND t.status <> 'removed'
        ORDER BY c.tenant_id, c.contract_ref`,
    ),
  );
  const changes = new Map<string, { flag: string[]; clear: string[] }>();
  for (const r of rows) {
    if (r.twin === r.flagged) continue;
    const ch = changes.get(r.tenant_id) ?? { flag: [], clear: [] };
    (r.twin ? ch.flag : ch.clear).push(r.contract_ref);
    changes.set(r.tenant_id, ch);
  }
  for (const [tenantId, ch] of changes) {
    checkAborted(ctx.signal);
    await db.tx(JOB, tenantId, async (tx) => {
      if (ch.flag.length > 0) {
        res.conflictsFlagged += await tx.exec(
          `UPDATE scf.declared_contracts SET conflict_since = now()
            WHERE tenant_id = $1 AND contract_ref = ANY ($2::uuid[]) AND status = 'verified' AND conflict_since IS NULL`,
          [tenantId, ch.flag],
        );
      }
      if (ch.clear.length > 0) {
        res.conflictsCleared += await tx.exec(
          `UPDATE scf.declared_contracts SET conflict_since = NULL, next_check_at = NULL
            WHERE tenant_id = $1 AND contract_ref = ANY ($2::uuid[]) AND conflict_since IS NOT NULL`,
          [tenantId, ch.clear],
        );
      }
    });
  }
}

/** The decision for one contract (exported for the unit tests). */
export async function decide(
  c: Pick<
    DeclaredRow,
    "contract_id" | "status" | "verified_role" | "verified_by_evidence" | "rejected_reason"
  > & {
    operator_rejected?: boolean;
  },
  accts: Pick<AccountRow, "evidence_id" | "subject">[],
  ledger: ContractLedger,
  deployedCache: Map<string, Deployments> = new Map(),
  instanceCache: Map<string, ContractInstance | null> = new Map(),
): Promise<Decision> {
  const keep: Decision = {
    status: c.status,
    role: c.verified_role,
    evidence: c.verified_by_evidence,
    reason: c.rejected_reason,
  };
  // An operator's conflict resolution stands (C-137); the due flag is simply cleared.
  if (c.operator_rejected) return keep;
  if (accts.length === 0) {
    // Nothing to compare with: a claim stays as it is; a verification whose evidence is gone is rejected.
    return c.status === "verified"
      ? { status: "rejected", role: null, evidence: null, reason: "not_deployer_or_admin" }
      : keep;
  }
  // The deployer of a contract never changes: a deployer-based verification stands while its evidence is valid.
  if (
    c.status === "verified" &&
    c.verified_role === "deployer" &&
    accts.some((a) => a.evidence_id === c.verified_by_evidence)
  )
    return keep;
  let definite = true;
  for (const a of accts) {
    let dep = deployedCache.get(a.subject);
    if (!dep) {
      dep = await ledger.deployedBy(a.subject);
      deployedCache.set(a.subject, dep);
    }
    if (dep.contracts.has(c.contract_id))
      return { status: "verified", role: "deployer", evidence: a.evidence_id, reason: null };
    if (!dep.complete) definite = false;
  }
  let inst = instanceCache.get(c.contract_id);
  if (inst === undefined) {
    inst = await ledger.instance(c.contract_id);
    instanceCache.set(c.contract_id, inst);
  }
  const a = inst?.admin ? accts.find((x) => x.subject === inst?.admin) : undefined;
  if (a) return { status: "verified", role: "admin", evidence: a.evidence_id, reason: null };
  // No live instance is a definite answer of its own (needs the RPC).
  if (inst && !inst.exists)
    return { status: "rejected", role: null, evidence: null, reason: "not_found_on_ledger" };
  // Without the RPC the admin is unknown; with an incomplete deployer look-up the deployer is unknown.
  if (inst === null || !definite) return { ...keep, undetermined: true };
  return { status: "rejected", role: null, evidence: null, reason: "not_deployer_or_admin" };
}
