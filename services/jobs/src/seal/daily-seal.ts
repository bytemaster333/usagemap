// SPDX-License-Identifier: Apache-2.0
// Job `daily_seal` (wire-formats §m.2; data-model §6.3, §12.1; C-135, C-136, C-137; plan A2). Tamper-evidence of
// published numbers — never proof that the numbers are genuine.
//
// Per run (daily 00:30 UTC after `audit_anchor`, and hourly until every missing day is built and submitted):
//  1. Ledger check (with a sealing key): the Horizon must serve the configured network; then the sealing account and
//     whether the newest confirmed day's ledger still belongs to this network instance (networkInstanceOf). A testnet reset is acted on only on PROOF — a ledger numbered below ours that closed after our
//     confirmation, or our own ledger closing at another time — seen again by a run ≥ 50 minutes later
//     (ResetConfirmations); a lagging, catching-up or bounded Horizon proves nothing and changes nothing. Then every
//     confirmed day becomes `network_reset`, the same key is funded again through friendbot, and the first day built
//     afterwards starts segment + 1 (C-137). A mark the network later contradicts (the newest marked day's ledger is
//     still on this network) is reverted day by day where the day's own transaction is found unchanged. A missing
//     account without any confirmed day is simply funded (first run on testnet).
//  2. Build every missing day in ascending order, from the day after the network's last `seal_days` row (the first run
//     starts at D−1) up to D−1. Per day: the day's audit-anchor document (`audit-anchors/<day>.json`, §m.1; missing →
//     stop at that day), the previous day's root (32 zero bytes for the chain's first day), every signed snapshot of a
//     tenant with `seal_enabled` signed before the day's end without a FINAL leaf on this network, fresh 32-byte salts;
//     then delete the day's provisional leaves (tenant by tenant, under each tenant's context), write each tenant's
//     leaves in one transaction under its context, and finally the global `seal_days` row (`built`, head path,
//     segment) with audit `seal.published` — the row makes the leaves final.
//  3. Submit the days in day order (with a key): one BUMP_SEQUENCE(0) transaction with MEMO_HASH(root), base fee,
//     5-minute time bounds; the hash is stored (`submitted`) before the POST, so a crash never loses it; confirmed
//     days get `ledger`, `confirmed_at` and audit `seal.published`; a transaction that expired unconfirmed is rebuilt
//     with a fresh sequence; a day still unconfirmed 24 hours after it was built becomes `failed` (testnet: final;
//     mainnet: resubmitted until confirmed). A day whose outcome is still unknown blocks later days.
//  4. Daily and at start (not on hourly retries): the seal history walk (seal/verify.ts) — the full
//     transaction history of the sealing account against every stored day; any mismatch fails the run.
//
// The secret seed is read from a file at start and lives only inside the key pair object; it is never logged.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AnchorDocument, anchorSelfConsistent } from "../audit/anchor.ts";
import type { ScfDb } from "../db.ts";
import { errorFields } from "../log.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import { addDays, utcDay } from "../schedule.ts";
import {
  type Keypair,
  keypairFromSeed,
  networkIdOf,
  sealTransaction,
  signEnvelope,
  transactionHash,
} from "../stellar/tx.ts";
import { type AnchorPublishResult, publishSealedAnchors } from "./anchors.ts";
import type { NetworkRoot, SealLedger } from "./horizon.ts";
import {
  buildDayTree,
  type DayTree,
  type SealNetwork,
  type SnapshotInput,
  ZERO_ROOT,
} from "./merkle.ts";
import { type SealHistoryReport, verifySealHistory } from "./verify.ts";

const JOB = "daily_seal" as const;
const HOUR_MS = 3_600_000;
/** Time bounds of a seal transaction (§m.2: 5 minutes). */
export const TX_VALIDITY_S = 300;
/** A built day still unconfirmed after this long becomes `failed` (§m.2). */
export const FAIL_AFTER_MS = 24 * HOUR_MS;
/** Upper bound of days built in one run (an outage of more than a year is an operator matter). */
export const MAX_DAYS_PER_RUN = 400;
const SUBMIT_ATTEMPTS = 3;
/** Rejections after which a fresh sequence number and fresh time bounds may succeed. */
const RETRYABLE = new Set(["tx_bad_seq", "tx_too_late", "tx_too_early", "tx_insufficient_fee"]);

export interface SealOptions {
  network: SealNetwork;
  passphrase: string;
  /** Directory holding `audit-anchors/<day>.json` (SCF_AUDIT_ANCHOR_DIR). */
  anchorDir: string;
  /** Sealing key (S…), read from SCF_SEAL_SECRET_FILE; null: build and store days, submit nothing. */
  secretSeed: string | null;
  feeStroops: number;
  /** Whether friendbot may be used (testnet with SCF_SEAL_FRIENDBOT_URL). */
  friendbot: boolean;
  dailyAt: { hour: number; minute: number };
  hourlyMinute: number;
}

/** Failure injection for tests: each hook may throw to simulate a crash at that point. */
export interface SealHooks {
  afterTenantLeaves?(day: string, tenantId: string, index: number): Promise<void>;
  afterDayRow?(day: string): Promise<void>;
  /** Salt source (tests reproduce known-answer vectors); default crypto.randomBytes(32). */
  salt?(): Buffer;
}

export interface SealRunResult {
  built: string[];
  confirmed: string[];
  failed: string[];
  resetDays: string[];
  /** Days whose earlier `network_reset` mark the network contradicted, confirmed again. */
  resetReverted: string[];
  /**
   * A reset is proven but not yet confirmed by a later run: no day is built in this run, so the first day built after
   * the reset is detected gets segment + 1 (C-137).
   */
  resetSuspected: boolean;
  /** The history walk of this run, when it ran. */
  history?: SealHistoryReport;
  funded: boolean;
  waitingForAnchor: string | null;
  tenantsSkipped: number;
  /** The sealed audit-anchor documents copied to the public table in this run (migration 0077). */
  anchors?: AnchorPublishResult;
}

interface DayRow {
  day: string;
  segment: number;
  root: Buffer;
  status: "built" | "submitted" | "confirmed" | "failed" | "network_reset";
  tx_hash: Buffer | null;
  ledger: number | null;
  submitted_expired: boolean;
  built_expired: boolean;
}

export function dailySealJob(
  db: ScfDb,
  ledger: SealLedger,
  opts: SealOptions,
  hooks: SealHooks = {},
): JobDef {
  const kp = opts.secretSeed ? keypairFromSeed(opts.secretSeed) : null;
  const confirmations = new ResetConfirmations();
  return {
    name: JOB,
    triggers: [
      { schedule: { kind: "daily", ...opts.dailyAt }, mode: "daily" },
      { schedule: { kind: "hourly", minute: opts.hourlyMinute }, mode: "hourly" },
    ],
    run: async (ctx) => {
      await runDailySeal(db, ledger, opts, ctx, hooks, kp, confirmations);
    },
  };
}

/** Reads and checks the anchor document of a day; null when it has not been written yet. */
export async function readAnchor(dir: string, day: string): Promise<AnchorDocument | null> {
  let text: string;
  try {
    text = await readFile(join(dir, "audit-anchors", `${day}.json`), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const doc = JSON.parse(text) as AnchorDocument;
  if (doc.date !== day || !/^[0-9a-f]{64}$/.test(doc.sha256) || !anchorSelfConsistent(doc)) {
    throw Object.assign(new Error("audit anchor document is inconsistent"), {
      name: "AnchorCorrupt",
    });
  }
  return doc;
}

export async function runDailySeal(
  db: ScfDb,
  ledger: SealLedger,
  opts: SealOptions,
  ctx: JobContext,
  hooks: SealHooks = {},
  keypair?: Keypair | null,
  confirmations: ResetConfirmations = new ResetConfirmations(),
): Promise<SealRunResult> {
  const kp =
    keypair !== undefined ? keypair : opts.secretSeed ? keypairFromSeed(opts.secretSeed) : null;
  const res: SealRunResult = {
    built: [],
    confirmed: [],
    failed: [],
    resetDays: [],
    resetReverted: [],
    resetSuspected: false,
    funded: false,
    waitingForAnchor: null,
    tenantsSkipped: 0,
  };
  let ledgerError: unknown = null;

  // 1. Ledger and reset check (only with a key: without one nothing was ever submitted).
  let accountReady = false;
  if (kp) {
    try {
      accountReady = await checkNetwork(db, ledger, opts, kp, ctx, res, confirmations);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ledgerError = err;
      ctx.log.warn("seal_ledger_unavailable", {
        job: JOB,
        network: opts.network,
        ...errorFields(err),
      });
    }
  }

  // 2. Build every missing day, ascending (not while a reset is suspected: see SealRunResult.resetSuspected).
  if (!res.resetSuspected) await buildMissingDays(db, opts, ctx, hooks, kp, res);

  // 2b. Publish the exact audit-anchor document each built day committed to (migration 0077), never a rewritten one.
  res.anchors = await publishSealedAnchors(
    db,
    opts.network,
    (day) => readAnchor(opts.anchorDir, day),
    ctx,
  );

  // 3. Submit and confirm in day order.
  if (kp && accountReady && ledgerError === null) {
    try {
      await submitDays(db, ledger, opts, kp, ctx, res);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ledgerError = err;
      ctx.log.warn("seal_submit_unavailable", {
        job: JOB,
        network: opts.network,
        ...errorFields(err),
      });
    }
  }

  // 4. Walk the sealing account's whole history and compare it with every stored day: daily and at
  //    start, not on the hourly retries.
  if (kp && accountReady && ledgerError === null && ctx.mode !== "hourly") {
    try {
      const report = await verifySealHistory(db, ledger, opts.network, ctx, [kp.account]);
      res.history = report;
      ctx.metrics.seal.historyProblems.set({ network: opts.network }, report.problems.length);
      ctx.metrics.seal.historyDays.set({ network: opts.network }, report.daysChecked);
      const log = report.problems.length > 0 ? ctx.log.error : ctx.log.info;
      log.call(ctx.log, "seal_history_verified", {
        job: JOB,
        network: opts.network,
        accounts: report.accounts,
        transactions: report.transactions,
        days_checked: report.daysChecked,
        not_checkable: report.notCheckable,
        problems: report.problems.length,
      });
      for (const p of report.problems.slice(0, 20))
        ctx.log.error("seal_history_problem", {
          job: JOB,
          network: opts.network,
          problem: p.problem,
          day: p.day,
          tx_hash: p.tx_hash,
        });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ledgerError = err;
      ctx.log.warn("seal_history_unavailable", {
        job: JOB,
        network: opts.network,
        ...errorFields(err),
      });
    }
  }

  ctx.metrics.units.inc({ job: JOB, outcome: "day_built" }, res.built.length);
  ctx.metrics.units.inc({ job: JOB, outcome: "day_confirmed" }, res.confirmed.length);
  ctx.metrics.units.inc({ job: JOB, outcome: "day_failed" }, res.failed.length);
  ctx.metrics.units.inc({ job: JOB, outcome: "day_network_reset" }, res.resetDays.length);
  ctx.log.info("daily_seal_done", {
    job: JOB,
    network: opts.network,
    built: res.built.length,
    confirmed: res.confirmed.length,
    failed: res.failed.length,
    reset_days: res.resetDays.length,
    funded: res.funded,
    waiting_for_anchor: res.waitingForAnchor,
    tenants_skipped: res.tenantsSkipped,
    submitting: kp !== null,
  });
  if (ledgerError !== null) {
    throw Object.assign(new Error("sealing network unavailable"), {
      name: "SealLedgerUnavailable",
    });
  }
  if (res.anchors && res.anchors.mismatched.length > 0) {
    throw Object.assign(new Error("an audit anchor file no longer matches its seal"), {
      name: "SealAnchorMismatch",
    });
  }
  if (res.history && res.history.problems.length > 0) {
    throw Object.assign(new Error("seal history does not match the stored days"), {
      name: "SealHistoryMismatch",
    });
  }
  // A missing anchor for D−1 is a normal wait (audit_anchor may not have run yet); an older one is stuck.
  if (res.waitingForAnchor !== null && res.waitingForAnchor < addDays(utcDay(ctx.now), -1)) {
    throw Object.assign(new Error("audit anchor missing for a past day"), {
      name: "SealAnchorMissing",
    });
  }
  return res;
}

/** Tolerance between a ledger's close time and the confirmation time stored for a transaction in it. */
export const SAME_LEDGER_TOLERANCE_MS = 60_000;
/** A suspected testnet reset is acted on only when a run at least this much later still proves it. */
export const RESET_CONFIRM_AFTER_MS = 50 * 60_000;

/**
 * Pending testnet-reset suspicions of this process, per network: the first run that proves a reset only records it;
 * a later run (≥ RESET_CONFIRM_AFTER_MS) that proves it again acts. A restart or the other core starts over, which
 * only delays the re-funding (nothing can be submitted to a reset network before it anyway).
 */
export class ResetConfirmations {
  readonly #first = new Map<string, number>();
  readonly afterMs: number;
  constructor(afterMs: number = RESET_CONFIRM_AFTER_MS) {
    this.afterMs = afterMs;
  }
  /** Records a proof at `now`; true when an earlier proof is old enough to act. */
  confirm(network: string, now: Date): boolean {
    const first = this.#first.get(network);
    if (first === undefined) {
      this.#first.set(network, now.getTime());
      return this.afterMs <= 0;
    }
    return now.getTime() - first >= this.afterMs;
  }
  clear(network: string): void {
    this.#first.delete(network);
  }
}

/**
 * Whether ledger `sequence`, in which a transaction of ours was confirmed at `confirmedAt`, still belongs to the
 * network instance this Horizon serves. Ledger numbers only grow with time on one network, so:
 * - a ledger with a LOWER number than ours that closed AFTER our confirmation proves a restarted network (a reset);
 * - our ledger, present, closed at our confirmation time → the same network; closed at another time → a reset;
 * - anything else (Horizon behind, history bounded, no close time) proves nothing: "unknown".
 */
export async function networkInstanceOf(
  ledger: SealLedger,
  root: NetworkRoot,
  sequence: number,
  confirmedAt: Date,
): Promise<"same" | "different" | "unknown"> {
  if (root.latestLedger < sequence) {
    const latestClosed = root.latestClosedAt ?? (await ledger.ledgerClosedAt(root.latestLedger));
    if (latestClosed === null) return "unknown";
    return latestClosed.getTime() > confirmedAt.getTime() + SAME_LEDGER_TOLERANCE_MS
      ? "different"
      : "unknown";
  }
  if (root.elderLedger !== null && sequence < root.elderLedger) return "unknown";
  const closed = await ledger.ledgerClosedAt(sequence);
  if (closed === null) return "unknown";
  return Math.abs(closed.getTime() - confirmedAt.getTime()) <= SAME_LEDGER_TOLERANCE_MS
    ? "same"
    : "different";
}

/**
 * Checks the sealing network; detects and handles a testnet reset (C-137) — only on proof, confirmed by a later run,
 * and reversibly. Returns whether the sealing account exists (submission possible).
 */
async function checkNetwork(
  db: ScfDb,
  ledger: SealLedger,
  opts: SealOptions,
  kp: Keypair,
  ctx: JobContext,
  res: SealRunResult,
  confirmations: ResetConfirmations,
): Promise<boolean> {
  const root = await ledger.root();
  // The Horizon must name the configured network (a missing passphrase is not accepted either).
  if (root.passphrase !== opts.passphrase) {
    throw Object.assign(new Error("horizon serves another network"), {
      name: "SealNetworkMismatch",
    });
  }
  const rows = await db.tx(JOB, null, (tx) =>
    tx.query<{
      day: string;
      ledger: number;
      tx_hash: Buffer;
      root: Buffer;
      confirmed_at: Date;
      status: "confirmed" | "network_reset";
    }>(
      `SELECT d.day::text AS day, d.ledger, d.tx_hash, d.root, d.confirmed_at, d.status FROM scf.seal_days d
        WHERE d.network = $1 AND d.status IN ('confirmed', 'network_reset') ORDER BY d.day`,
      [opts.network],
    ),
  );
  const confirmed = rows.filter((r) => r.status === "confirmed");
  const newest = confirmed.at(-1);
  const account = await ledger.account(kp.account);
  const instance = newest
    ? await networkInstanceOf(ledger, root, Number(newest.ledger), newest.confirmed_at)
    : "unknown";
  let reset = false;
  if (instance === "different") {
    if (opts.network === "mainnet") {
      // §m.2 step 5: mainnet is never reset; this is an inconsistency an operator has to look at.
      throw Object.assign(new Error("sealing network history changed on mainnet"), {
        name: "SealNetworkInconsistent",
      });
    }
    if (!confirmations.confirm(opts.network, ctx.now)) {
      ctx.log.warn("seal_network_reset_suspected", {
        job: JOB,
        network: opts.network,
        latest_ledger: root.latestLedger,
        newest_confirmed_ledger: Number(newest?.ledger),
      });
      res.resetSuspected = true;
      return false; // nothing is marked, funded, built or submitted until a later run proves it again
    }
    confirmations.clear(opts.network);
    reset = true;
    // Every confirmed day precedes the newest one, so every one of them was on the network that is gone.
    const gone = confirmed.map((d) => d.day);
    await db.tx(JOB, null, (tx) =>
      tx.exec(
        `UPDATE scf.seal_days SET status = 'network_reset', last_checked_at = now()
          WHERE network = $1 AND day = ANY ($2::date[]) AND status = 'confirmed'`,
        [opts.network, gone],
      ),
    );
    res.resetDays = gone;
    ctx.log.warn("seal_network_reset_detected", {
      job: JOB,
      network: opts.network,
      days_marked: gone.length,
      latest_ledger: root.latestLedger,
    });
  } else {
    confirmations.clear(opts.network);
    await revertFalseReset(db, ledger, opts, root, rows, ctx, res);
    if (account === null && newest !== undefined) {
      // The account of a seal confirmed on this very network cannot vanish (we never merge it): a Horizon that has
      // not ingested its state yet, or a broken one. Never treat it as a reset; submit nothing this run.
      throw Object.assign(new Error("sealing account not found on the network of its last seal"), {
        name: "SealLedgerUnavailable",
      });
    }
  }
  if (account !== null) return true;
  if (opts.network !== "testnet" || !opts.friendbot) {
    ctx.log.warn("seal_account_missing", { job: JOB, network: opts.network });
    return false;
  }
  await ledger.fund(kp.account);
  res.funded = true;
  ctx.log.info("seal_account_funded", { job: JOB, network: opts.network, after_reset: reset });
  return (await ledger.account(kp.account)) !== null;
}

/**
 * Reverses a reset mark that the network contradicts: when the newest `network_reset` day's ledger
 * still belongs to this network instance, every `network_reset` day whose own transaction is still found — successful,
 * in the stored ledger, with the day's root as memo — is `confirmed` again. One ledger look-up per run otherwise.
 */
async function revertFalseReset(
  db: ScfDb,
  ledger: SealLedger,
  opts: SealOptions,
  root: NetworkRoot,
  rows: {
    day: string;
    ledger: number;
    tx_hash: Buffer;
    root: Buffer;
    confirmed_at: Date;
    status: string;
  }[],
  ctx: JobContext,
  res: SealRunResult,
): Promise<void> {
  const marked = rows.filter((r) => r.status === "network_reset");
  const last = marked.at(-1);
  if (!last) return;
  if ((await networkInstanceOf(ledger, root, Number(last.ledger), last.confirmed_at)) !== "same")
    return;
  const back: string[] = [];
  for (const d of marked) {
    checkAborted(ctx.signal);
    const found = await ledger.transaction(d.tx_hash.toString("hex"));
    if (
      found?.successful &&
      found.ledger === Number(d.ledger) &&
      found.memoHashHex === d.root.toString("hex")
    )
      back.push(d.day);
  }
  if (back.length === 0) return;
  await db.tx(JOB, null, (tx) =>
    tx.exec(
      `UPDATE scf.seal_days SET status = 'confirmed', last_checked_at = now()
        WHERE network = $1 AND day = ANY ($2::date[]) AND status = 'network_reset'`,
      [opts.network, back],
    ),
  );
  res.resetReverted = back;
  ctx.log.warn("seal_network_reset_reverted", {
    job: JOB,
    network: opts.network,
    days: back.length,
  });
}

async function buildMissingDays(
  db: ScfDb,
  opts: SealOptions,
  ctx: JobContext,
  hooks: SealHooks,
  kp: Keypair | null,
  res: SealRunResult,
): Promise<void> {
  const last = await db.tx(JOB, null, async (tx) => {
    const rows = await tx.query<{ day: string; segment: number; root: Buffer; reset: boolean }>(
      `SELECT d.day::text AS day, d.segment, d.root,
              EXISTS (SELECT 1 FROM scf.seal_days r
                       WHERE r.network = d.network AND r.segment = d.segment AND r.status = 'network_reset') AS reset
         FROM scf.seal_days d WHERE d.network = $1 ORDER BY d.day DESC LIMIT 1`,
      [opts.network],
    );
    return rows[0] ?? null;
  });
  const end = addDays(utcDay(ctx.now), -1);
  let day = last ? addDays(last.day, 1) : end;
  let prevRoot = last ? last.root : ZERO_ROOT;
  const segment = last ? last.segment + (last.reset ? 1 : 0) : 1;
  for (let n = 0; day <= end && n < MAX_DAYS_PER_RUN; n++) {
    checkAborted(ctx.signal);
    const anchor = await readAnchor(opts.anchorDir, day);
    if (!anchor) {
      res.waitingForAnchor = day;
      ctx.log.info("seal_waiting_for_anchor", { job: JOB, network: opts.network, day });
      return;
    }
    const tree = await buildDay(db, opts, ctx, hooks, kp, res, {
      day,
      prevRoot,
      segment,
      anchorSha256: Buffer.from(anchor.sha256, "hex"),
    });
    res.built.push(day);
    prevRoot = tree.root;
    day = addDays(day, 1);
    // Later days of this run continue the (possibly new) segment: a reset mark moves only the first day built after it.
  }
}

async function buildDay(
  db: ScfDb,
  opts: SealOptions,
  ctx: JobContext,
  hooks: SealHooks,
  kp: Keypair | null,
  res: SealRunResult,
  d: { day: string; prevRoot: Buffer; segment: number; anchorSha256: Buffer },
): Promise<DayTree> {
  const dayEnd = new Date(`${addDays(d.day, 1)}T00:00:00Z`);
  // Cross-tenant reads (tenant unset): the day's snapshots, and the tenants holding provisional leaves from an
  // interrupted build of this day (or later — none can exist, the chain grows one day at a time).
  const { snaps, provisional } = await db.tx(JOB, null, async (tx) => ({
    snaps: await tx.query<{ tenant_id: string; snapshot_id: string; canonical_sha256: Buffer }>(
      `SELECT s.tenant_id, s.snapshot_id, s.canonical_sha256
         FROM scf.traction_snapshots s JOIN scf.tenants t ON t.tenant_id = s.tenant_id
        WHERE t.seal_enabled AND t.status <> 'removed'
          AND s.signature IS NOT NULL AND s.signed_at < $2
          AND NOT EXISTS (SELECT 1 FROM scf.seal_leaves l
                            JOIN scf.seal_days x ON x.network = l.network AND x.day = l.day
                           WHERE l.tenant_id = s.tenant_id AND l.snapshot_id = s.snapshot_id AND l.network = $1)
        ORDER BY s.tenant_id, s.snapshot_id`,
      [opts.network, dayEnd],
    ),
    provisional: await tx.query<{ tenant_id: string }>(
      `SELECT DISTINCT l.tenant_id FROM scf.seal_leaves l
        WHERE l.network = $1 AND l.day >= $2::date
          AND NOT EXISTS (SELECT 1 FROM scf.seal_days x WHERE x.network = l.network AND x.day = l.day)`,
      [opts.network, d.day],
    ),
  }));
  const salt = hooks.salt ?? (() => randomBytes(32));
  const inputs: SnapshotInput[] = snaps.map((s) => ({
    tenantId: s.tenant_id,
    snapshotId: s.snapshot_id,
    snapshotSha256: s.canonical_sha256,
    salt: salt(),
  }));
  const tree = buildDayTree({
    network: opts.network,
    day: d.day,
    prevRoot: d.prevRoot,
    auditAnchorSha256: d.anchorSha256,
    snapshots: inputs,
  });

  // Provisional leaves of an interrupted build go first (C-137: job daily_seal may delete only those).
  for (const { tenant_id } of provisional) {
    checkAborted(ctx.signal);
    await db.tx(JOB, tenant_id, (tx) =>
      tx.exec(
        `DELETE FROM scf.seal_leaves l WHERE l.tenant_id = $1 AND l.network = $2 AND l.day >= $3::date
            AND NOT EXISTS (SELECT 1 FROM scf.seal_days x WHERE x.network = l.network AND x.day = l.day)`,
        [tenant_id, opts.network, d.day],
      ),
    );
  }

  // One transaction per tenant, under its context.
  const byTenant = new Map<string, DayTree["snapshots"]>();
  for (const s of tree.snapshots)
    byTenant.set(s.tenantId, [...(byTenant.get(s.tenantId) ?? []), s]);
  let i = 0;
  for (const [tenantId, leaves] of byTenant) {
    checkAborted(ctx.signal);
    try {
      await db.tx(JOB, tenantId, (tx) =>
        tx.exec(
          `INSERT INTO scf.seal_leaves (tenant_id, snapshot_id, network, day, leaf_index, salt, leaf_hash, audit_path)
           SELECT $1::uuid, x.snapshot_id, $2, $3::date, x.leaf_index, decode(x.salt, 'hex'), decode(x.leaf_hash, 'hex'),
                  ARRAY(SELECT decode(p.h, 'hex') FROM unnest(x.audit_path) WITH ORDINALITY AS p(h, o) ORDER BY p.o)
             FROM jsonb_to_recordset($4::jsonb)
                  AS x(snapshot_id uuid, leaf_index integer, salt text, leaf_hash text, audit_path text[])`,
          [
            tenantId,
            opts.network,
            d.day,
            JSON.stringify(
              leaves.map((l) => ({
                snapshot_id: l.snapshotId,
                leaf_index: l.leafIndex,
                salt: l.salt.toString("hex"),
                leaf_hash: l.leafHash.toString("hex"),
                audit_path: l.auditPath.map((p) => p.toString("hex")),
              })),
            ),
          ],
        ),
      );
    } catch (err) {
      // The tenant (or the snapshot) was purged between the read and the write: its leaves are simply absent; the
      // other leaves' paths stay valid (the tree is unchanged).
      if ((err as { code?: string }).code !== "23503") throw err;
      res.tenantsSkipped += 1;
      ctx.metrics.units.inc({ job: JOB, outcome: "tenant_gone_mid_build" });
      ctx.log.info("seal_tenant_gone_mid_build", { job: JOB, day: d.day, tenant_id: tenantId });
    }
    await hooks.afterTenantLeaves?.(d.day, tenantId, i++);
  }

  // The day row makes the leaves final.
  await db.tx(JOB, null, async (tx) => {
    await tx.exec(
      `INSERT INTO scf.seal_days (network, day, segment, prev_root, audit_anchor_sha256, leaf_count, head_path, root,
                                  status, source_account)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7::bytea[], $8, 'built', $9)`,
      [
        opts.network,
        d.day,
        d.segment,
        tree.prevRoot,
        tree.auditAnchorSha256,
        tree.leafCount,
        tree.headPath,
        tree.root,
        kp?.account ?? null,
      ],
    );
    await tx.audit("seal.published", "seal_day", `${opts.network}:${d.day}`, {
      network: opts.network,
      day: d.day,
      segment: d.segment,
      status: "built",
      root: tree.root.toString("hex"),
      leaf_count: tree.leafCount,
    });
  });
  ctx.log.info("seal_day_built", {
    job: JOB,
    network: opts.network,
    day: d.day,
    segment: d.segment,
    leaf_count: tree.leafCount,
    root: tree.root.toString("hex"),
  });
  await hooks.afterDayRow?.(d.day);
  return tree;
}

/** What to do with a day that is not yet confirmed (pure; exported for unit tests). */
export function submissionAction(
  row: Pick<DayRow, "status" | "tx_hash" | "submitted_expired" | "built_expired">,
  network: SealNetwork,
): "lookup" | "submit" | "fail" | "skip" {
  if (row.status === "confirmed" || row.status === "network_reset") return "skip";
  if (row.status === "failed") {
    if (network !== "mainnet") return "skip";
    return row.tx_hash ? "lookup" : "submit";
  }
  if (row.built_expired) return row.tx_hash ? "lookup" : "fail";
  return row.tx_hash ? "lookup" : "submit";
}

async function submitDays(
  db: ScfDb,
  ledger: SealLedger,
  opts: SealOptions,
  kp: Keypair,
  ctx: JobContext,
  res: SealRunResult,
): Promise<void> {
  const rows = await db.tx(JOB, null, (tx) =>
    tx.query<DayRow>(
      `SELECT d.day::text AS day, d.segment, d.root, d.status, d.tx_hash, d.ledger,
              (d.submitted_at IS NULL OR d.submitted_at < now() - make_interval(secs => $2)) AS submitted_expired,
              d.built_at < now() - make_interval(secs => $3) AS built_expired
         FROM scf.seal_days d
        WHERE d.network = $1 AND d.status IN ('built', 'submitted', 'failed')
        ORDER BY d.day`,
      [opts.network, TX_VALIDITY_S + 60, FAIL_AFTER_MS / 1000],
    ),
  );
  const netId = networkIdOf(opts.passphrase);
  for (const row of rows) {
    checkAborted(ctx.signal);
    let action = submissionAction(row, opts.network);
    if (action === "skip") continue;
    if (action === "lookup" && row.tx_hash) {
      const found = await ledger.transaction(row.tx_hash.toString("hex"));
      if (found?.successful) {
        await confirmDay(db, opts, kp, row, found.ledger, found.createdAt, ctx, res);
        continue;
      }
      // Not (yet) on the ledger: still inside its time bounds → wait (blocks later days); expired → rebuild.
      if (!found && !row.submitted_expired) {
        await touch(db, opts, row.day);
        return;
      }
      action = row.built_expired && row.status !== "failed" ? "fail" : "submit";
    }
    if (action === "fail") {
      await db.tx(JOB, null, (tx) =>
        tx.exec(
          `UPDATE scf.seal_days SET status = 'failed', last_checked_at = now()
            WHERE network = $1 AND day = $2::date AND status IN ('built', 'submitted')`,
          [opts.network, row.day],
        ),
      );
      res.failed.push(row.day);
      ctx.log.warn("seal_day_failed", { job: JOB, network: opts.network, day: row.day });
      if (opts.network !== "mainnet") continue;
    }
    const outcome = await submitOne(db, ledger, opts, kp, netId, row, ctx, res);
    if (outcome !== "confirmed") return; // keep day order: later days wait
  }
}

async function touch(db: ScfDb, opts: SealOptions, day: string): Promise<void> {
  await db.tx(JOB, null, (tx) =>
    tx.exec(
      "UPDATE scf.seal_days SET last_checked_at = now() WHERE network = $1 AND day = $2::date",
      [opts.network, day],
    ),
  );
}

async function submitOne(
  db: ScfDb,
  ledger: SealLedger,
  opts: SealOptions,
  kp: Keypair,
  netId: Buffer,
  row: DayRow,
  ctx: JobContext,
  res: SealRunResult,
): Promise<"confirmed" | "pending" | "rejected"> {
  for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt++) {
    checkAborted(ctx.signal);
    const acct = await ledger.account(kp.account);
    if (!acct) {
      ctx.log.warn("seal_account_missing", { job: JOB, network: opts.network });
      return "rejected";
    }
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    const tx = sealTransaction({
      source: kp.publicKey,
      sequence: acct.sequence + 1n,
      fee: opts.feeStroops,
      memoHash: row.root,
      minTime: 0n,
      maxTime: nowS + BigInt(TX_VALIDITY_S),
    });
    const hash = transactionHash(netId, tx);
    // Store the hash before the POST: a crash between the two leaves a hash that the next run looks up.
    await db.tx(JOB, null, (t) =>
      t.exec(
        `UPDATE scf.seal_days SET status = CASE WHEN status = 'failed' THEN 'failed' ELSE 'submitted' END,
                tx_hash = $3, submitted_at = now(), source_account = $4, last_checked_at = now()
          WHERE network = $1 AND day = $2::date`,
        [opts.network, row.day, hash, kp.account],
      ),
    );
    const r = await ledger.submit(signEnvelope(netId, tx, kp));
    if (r.kind === "confirmed") {
      await confirmDay(db, opts, kp, { ...row, tx_hash: hash }, r.ledger, r.createdAt, ctx, res);
      return "confirmed";
    }
    if (r.kind === "pending") {
      ctx.log.info("seal_submit_pending", { job: JOB, network: opts.network, day: row.day });
      return "pending";
    }
    ctx.log.warn("seal_submit_rejected", {
      job: JOB,
      network: opts.network,
      day: row.day,
      code: r.code,
      attempt,
    });
    if (!RETRYABLE.has(r.code)) return "rejected";
  }
  return "rejected";
}

async function confirmDay(
  db: ScfDb,
  opts: SealOptions,
  kp: Keypair,
  row: Pick<DayRow, "day" | "segment" | "root" | "tx_hash">,
  ledgerSeq: number,
  createdAt: Date,
  ctx: JobContext,
  res: SealRunResult,
): Promise<void> {
  await db.tx(JOB, null, async (tx) => {
    await tx.exec(
      `UPDATE scf.seal_days SET status = 'confirmed', tx_hash = $3, ledger = $4, confirmed_at = $5,
              source_account = $6, last_checked_at = now()
        WHERE network = $1 AND day = $2::date`,
      [opts.network, row.day, row.tx_hash, ledgerSeq, createdAt, kp.account],
    );
    await tx.audit("seal.published", "seal_day", `${opts.network}:${row.day}`, {
      network: opts.network,
      day: row.day,
      segment: row.segment,
      status: "confirmed",
      root: row.root.toString("hex"),
      tx_hash: row.tx_hash?.toString("hex") ?? null,
      ledger: ledgerSeq,
    });
  });
  res.confirmed.push(row.day);
  ctx.log.info("seal_day_confirmed", {
    job: JOB,
    network: opts.network,
    day: row.day,
    ledger: ledgerSeq,
  });
}
