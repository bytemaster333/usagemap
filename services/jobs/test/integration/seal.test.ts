// SPDX-License-Identifier: Apache-2.0
// Acceptance (C-136, C-137; wire-formats §m.2; data-model §12.1; plan A2): job daily_seal against real PostgreSQL
// (scf_jobs through PgBouncer, every policy, trigger and check of 0065) and a fake sealing network that checks every
// envelope like stellar-core would for a seal. Covered: the first run starts the chain at D−1 and funds the sealing
// account through friendbot; only signed snapshots of opted-in tenants become leaves; one BUMP_SEQUENCE(0) +
// MEMO_HASH(root) transaction per day; every proof served by scf.public_seal_proof verifies (leaf, inclusion path,
// root, and the root again from prev_root + anchor hash + head_path alone); idempotent reruns; late opt-in; failure
// injection — a kill between tenant transactions (provisional leaves are never served and are rebuilt), a kill after
// the day row (the next run submits), a lost submission answer (the stored hash is looked up), a three-day outage with
// a missing anchor, a mocked testnet reset (network_reset, re-funding of the same key, segment + 1) and a tenant
// purged mid-build; a key-less mainnet run builds but submits nothing. The seed never appears in a log line.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AnchorDocument, buildAnchor, FilePublisher } from "../../src/audit/anchor.ts";
import type { ScfDb } from "../../src/db.ts";
import { canonicalJson } from "../../src/registry/sources.ts";
import { addDays } from "../../src/schedule.ts";
import {
  ResetConfirmations,
  runDailySeal,
  type SealHooks,
  type SealOptions,
} from "../../src/seal/daily-seal.ts";
import { HorizonSealLedger } from "../../src/seal/horizon.ts";
import {
  leafHash,
  rootFromHead,
  snapshotLeafData,
  uuidBytes,
  verifyInclusion,
} from "../../src/seal/merkle.ts";
import { keypairFromSeed } from "../../src/stellar/tx.ts";
import { strkeyEncode, VERSION } from "../../src/stellar/xdr.ts";
import { type FakeNetwork, startFakeNetwork } from "../support/fake-horizon.ts";
import { capture, jobsDb, seedSite, superClient } from "../support/harness.ts";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

let su: pg.Pool;
let db: ScfDb;
let net: FakeNetwork;
let dir: string;
let anchors: FilePublisher;
let seed: string;
let opts: SealOptions;
let ledger: HorizonSealLedger;
/** The day the next run treats as "today" (D); the run builds up to D−1. */
let today: string;
const logs: string[] = [];
/** The testnet chain's last day before this run (a reused stack), or null. */
let prevChain: { root: Buffer; segment: number } | null = null;

async function nextFreeDay(network: string, fallback: string): Promise<string> {
  const r = await su.query<{ day: string | null }>(
    "SELECT max(day)::text AS day FROM scf.seal_days WHERE network = $1",
    [network],
  );
  const last = r.rows[0]?.day;
  return last ? addDays(last, 2) : fallback;
}

/**
 * The day's anchor document with the REAL chain heads (migration 0077: daily_seal publishes the sealed document and
 * audit_verify checks the live chains against it, so a fake head would break later audit_verify runs on this stack).
 * A day a previous run on a reused stack already sealed gets that exact document back.
 */
async function writeAnchor(day: string): Promise<string> {
  const stored = await su.query<{ document: AnchorDocument }>(
    "SELECT document FROM scf.sealed_audit_anchors WHERE day = $1",
    [day],
  );
  const heads = await su.query<{ chain_id: string; seq: number; row_hash: string }>(
    `SELECT chain_id::text AS chain_id, last_seq::int AS seq, encode(last_hash, 'hex') AS row_hash
       FROM scf.audit_chain_heads WHERE last_seq > 0`,
  );
  const doc =
    stored.rows[0]?.document ??
    buildAnchor(day, new Date(`${addDays(day, 1)}T00:00:00Z`), heads.rows);
  await anchors.publish(doc);
  return doc.sha256;
}

async function optIn(tenantId: string, on = true): Promise<void> {
  await su.query("UPDATE scf.tenants SET seal_enabled = $2 WHERE tenant_id = $1", [tenantId, on]);
}

/** A signed snapshot (as the signing job leaves it); canonical_sha256 = sha256(JCS(document)). */
async function signedSnapshot(
  t: { tenantId: string; userId: string },
  signedAt: Date,
): Promise<string> {
  const doc = { schema: "scf-analytics/traction-snapshot/1", n: randomBytes(4).toString("hex") };
  const r = await su.query<{ snapshot_id: string }>(
    `INSERT INTO scf.traction_snapshots (tenant_id, created_by, period_start, period_end, document, canonical_sha256,
                                         signature, kid, signed_at)
     VALUES ($1, $2, '2026-01-01', '2026-02-01', $3::jsonb, $4, $5, 'snap-test', $6) RETURNING snapshot_id`,
    [
      t.tenantId,
      t.userId,
      JSON.stringify(doc),
      createHash("sha256").update(canonicalJson(doc)).digest(),
      randomBytes(64),
      signedAt,
    ],
  );
  return r.rows[0]?.snapshot_id as string;
}

async function pendingSnapshot(t: { tenantId: string; userId: string }): Promise<string> {
  const r = await su.query<{ snapshot_id: string }>(
    `INSERT INTO scf.traction_snapshots (tenant_id, created_by, period_start, period_end)
     VALUES ($1, $2, '2026-01-01', '2026-02-01') RETURNING snapshot_id`,
    [t.tenantId, t.userId],
  );
  return r.rows[0]?.snapshot_id as string;
}

interface Proof {
  snapshot_id: string;
  snapshot_sha256: string;
  network: string;
  day: string;
  segment: number;
  leaf_index: number;
  leaf_count: number;
  salt: string;
  leaf_hash: string;
  audit_path: string[];
  head_path: string[];
  root: string;
  prev_root: string;
  audit_anchor_sha256: string;
  status: string;
  source_account: string | null;
  tx_hash: string | null;
  ledger: number | null;
}

async function proofs(snapshotId: string): Promise<Proof[] | null> {
  const r = await su.query<{ p: Proof[] | null }>("SELECT scf.public_seal_proof($1) AS p", [
    snapshotId,
  ]);
  return r.rows[0]?.p ?? null;
}

/** Verification steps 2, 3 and 5 of §m.2, from the served proof alone. */
function verifyProof(p: Proof): void {
  const b = (h: string) => Buffer.from(h, "hex");
  const leaf = leafHash(snapshotLeafData(b(p.salt), p.snapshot_id, b(p.snapshot_sha256)));
  expect(leaf.toString("hex")).toBe(p.leaf_hash);
  expect(verifyInclusion(p.leaf_index, p.leaf_count, leaf, p.audit_path.map(b), b(p.root))).toBe(
    true,
  );
  const fromHead = rootFromHead(
    p.network as "testnet",
    p.day,
    b(p.prev_root),
    b(p.audit_anchor_sha256),
    p.head_path.map(b),
  );
  expect(fromHead.toString("hex")).toBe(p.root);
  expect(uuidBytes(p.snapshot_id)).toHaveLength(16);
}

async function dayRow(network: string, day: string) {
  const r = await su.query<{
    status: string;
    segment: number;
    root: Buffer;
    prev_root: Buffer;
    leaf_count: number;
    tx_hash: Buffer | null;
    ledger: string | null;
    source_account: string | null;
  }>("SELECT * FROM scf.seal_days WHERE network = $1 AND day = $2", [network, day]);
  return r.rows[0];
}

function ctxAt(day: string, hour = 1, cap = capture()) {
  return {
    cap,
    ctx: cap.ctx({ now: new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`) }),
  };
}

/** One process's pending reset suspicions, shared by every run of this suite (like the job's own). */
const confirmations = new ResetConfirmations();

async function run(
  day: string,
  hooks: SealHooks = {},
  o: Partial<SealOptions> = {},
  hour = 1,
  lines?: string[],
) {
  const { cap, ctx } = ctxAt(day, hour);
  try {
    return await runDailySeal(db, ledger, { ...opts, ...o }, ctx, hooks, undefined, confirmations);
  } finally {
    logs.push(...cap.lines);
    lines?.push(...cap.lines);
  }
}

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  net = await startFakeNetwork(Number(process.env.SCF_WSG_SEAL_PORT ?? 56274), TESTNET);
  dir = mkdtempSync(join(tmpdir(), "wsg-seal-"));
  anchors = new FilePublisher(dir);
  seed = strkeyEncode(randomBytes(32), VERSION.seed);
  ledger = new HorizonSealLedger({
    horizonUrl: net.horizonUrl,
    friendbotUrl: net.friendbotUrl,
    timeoutMs: 5000,
  });
  opts = {
    network: "testnet",
    passphrase: TESTNET,
    anchorDir: dir,
    secretSeed: seed,
    feeStroops: 100,
    friendbot: true,
    dailyAt: { hour: 0, minute: 30 },
    hourlyMinute: 30,
  };
  // Seal opt-ins of other suites' tenants would add leaves: start from none (purged tenants are immutable).
  await su.query(
    "UPDATE scf.tenants SET seal_enabled = false WHERE seal_enabled AND purged_at IS NULL",
  );
  today = await nextFreeDay("testnet", "2031-01-10");
  const last = await su.query<{ root: Buffer; segment: number; day: string }>(
    "SELECT root, segment, day::text AS day FROM scf.seal_days WHERE network = 'testnet' ORDER BY day DESC LIMIT 1",
  );
  if (last.rows[0]) {
    prevChain = last.rows[0];
    today = addDays(last.rows[0].day, 2); // the first run builds exactly D−1 = the next day
  }
});

afterAll(async () => {
  await su?.end();
  await db?.pool.end();
  await net?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("daily_seal", () => {
  let A: Awaited<ReturnType<typeof seedSite>>;
  let B: Awaited<ReturnType<typeof seedSite>>;
  let a1: string;
  let b1: string;

  it("starts the chain at D−1, seals only opted-in signed snapshots, submits one seal transaction", async () => {
    A = await seedSite(su);
    B = await seedSite(su);
    await optIn(A.tenantId);
    const d = addDays(today, -1);
    a1 = await signedSnapshot(A, new Date(`${addDays(d, -5)}T10:00:00Z`)); // signed long before: sealed now
    const a2 = await signedSnapshot(A, new Date(`${d}T23:59:59Z`));
    const aLate = await signedSnapshot(A, new Date(`${today}T00:30:00Z`)); // after D−1 ended: next day
    const aPending = await pendingSnapshot(A);
    b1 = await signedSnapshot(B, new Date(`${d}T08:00:00Z`)); // B has not opted in
    const anchorSha = await writeAnchor(d);

    let r = await run(today);
    // A reused stack: the fresh fake network is a proven reset, acted on by a run at least 50 minutes later.
    if (prevChain) r = await run(today, {}, {}, 2);
    expect(r).toMatchObject({ built: [d], confirmed: [d], funded: true, waitingForAnchor: null });
    const kp = keypairFromSeed(seed);
    expect(net.state.friendbotCalls).toEqual([kp.account]);

    const row = await dayRow("testnet", d);
    expect(row).toMatchObject({ status: "confirmed", leaf_count: 4, source_account: kp.account });
    if (prevChain) {
      // A reused stack: the chain continues; the fresh fake network looks like a reset (new segment).
      expect(row?.prev_root.equals(prevChain.root)).toBe(true);
      expect(row?.segment).toBe(prevChain.segment + 1);
    } else {
      expect(row).toMatchObject({ segment: 1 });
      expect(row?.prev_root.equals(Buffer.alloc(32))).toBe(true);
    }
    // The transaction: BUMP_SEQUENCE to 0, memo = root, from the sealing account.
    const tx = net.state.txs.get(row?.tx_hash?.toString("hex") as string);
    expect(tx).toMatchObject({
      source: kp.account,
      memoHex: row?.root.toString("hex"),
      bumpTo: 0n,
    });
    expect(Number(row?.ledger)).toBe(tx?.ledger);

    for (const id of [a1, a2]) {
      const p = await proofs(id);
      expect(p).toHaveLength(1);
      const proof = (p as Proof[])[0] as Proof;
      expect(proof).toMatchObject({
        network: "testnet",
        day: d,
        segment: row?.segment,
        status: "confirmed",
        audit_anchor_sha256: anchorSha,
        root: row?.root.toString("hex"),
      });
      verifyProof(proof);
    }
    expect(await proofs(aLate)).toBeNull();
    expect(await proofs(aPending)).toBeNull();
    expect(await proofs(b1)).toBeNull();
    const leaves = await su.query("SELECT 1 FROM scf.seal_leaves WHERE tenant_id = $1", [
      B.tenantId,
    ]);
    expect(leaves.rowCount).toBe(0);

    const audit = await su.query<{ details: { status: string; day: string } }>(
      `SELECT details FROM scf.audit_log WHERE action = 'seal.published' AND target_id = $1 ORDER BY seq`,
      [`testnet:${d}`],
    );
    expect(audit.rows.map((x) => x.details.status)).toEqual(["built", "confirmed"]);
  });

  it("is idempotent, and seals a late opt-in's earlier snapshots in the next day built", async () => {
    const again = await run(today);
    expect(again).toMatchObject({ built: [], confirmed: [] });
    expect(net.state.submissions).toBe(1);

    await optIn(B.tenantId);
    today = addDays(today, 1);
    const d = addDays(today, -1);
    await writeAnchor(d);
    const r = await run(today);
    expect(r).toMatchObject({ built: [d], confirmed: [d], funded: false });
    const p = (await proofs(b1)) as Proof[];
    expect(p.map((x) => x.day)).toEqual([d]);
    verifyProof(p[0] as Proof);
    // a1 stays in its first day only (once per network).
    expect(((await proofs(a1)) as Proof[]).map((x) => x.day)).toEqual([addDays(d, -1)]);
    // The chain continues: prev_root = the previous day's root.
    const prev = await dayRow("testnet", addDays(d, -1));
    expect((await dayRow("testnet", d))?.prev_root.equals(prev?.root as Buffer)).toBe(true);
  });

  it("publishes the exact audit-anchor document each sealed day committed to (0077), never a rewritten one", async () => {
    const sealed = await su.query<{ day: string; sha: string; document: AnchorDocument }>(
      `SELECT a.day::text AS day, encode(a.sha256, 'hex') AS sha, a.document FROM scf.sealed_audit_anchors a
         JOIN scf.seal_days d ON d.day = a.day AND d.network = 'testnet'
        WHERE d.audit_anchor_sha256 = a.sha256 AND a.day >= $1::date ORDER BY a.day`,
      [addDays(today, -2)],
    );
    expect(sealed.rows.map((r) => r.day)).toEqual([addDays(today, -2), addDays(today, -1)]);
    for (const r of sealed.rows) {
      expect(r.document.sha256).toBe(r.sha);
      const onDisk = JSON.parse(
        readFileSync(join(dir, "audit-anchors", `${r.day}.json`), "utf8"),
      ) as AnchorDocument;
      expect(r.document).toEqual(onDisk);
    }
    // The stored copy is immutable, even for the job.
    await expect(
      db.tx("daily_seal", null, (tx) =>
        tx.exec("UPDATE scf.sealed_audit_anchors SET stored_at = now() WHERE day = $1", [
          addDays(today, -1),
        ]),
      ),
    ).rejects.toThrow();
    // Another job may not write it.
    await expect(
      db.tx("audit_anchor", null, (tx) =>
        tx.exec(
          "INSERT INTO scf.sealed_audit_anchors (day, sha256, document) VALUES ('2030-01-01', $1, $2::jsonb)",
          [
            Buffer.alloc(32),
            JSON.stringify({ schema: "scf-analytics/audit-anchor/1", date: "2030-01-01" }),
          ],
        ),
      ),
    ).rejects.toThrow();

    // The next day's anchor file is rewritten (hashes recomputed, so it passes its own check) right after the day was
    // built: never published, and the run fails with seal_anchor_mismatch; the sealed file back → published.
    today = addDays(today, 1);
    const d = addDays(today, -1);
    const real = await writeAnchor(d);
    const file = join(dir, "audit-anchors", `${d}.json`);
    const realText = readFileSync(file, "utf8");
    const forged = buildAnchor(d, new Date(`${today}T00:00:00Z`), [
      { chain_id: "00000000-0000-0000-0000-000000000000", seq: 1, row_hash: "ab".repeat(32) },
    ]);
    expect(forged.sha256).not.toBe(real);
    const lines: string[] = [];
    const err = await run(
      today,
      { afterDayRow: async () => writeFileSync(file, `${JSON.stringify(forged)}\n`) },
      {},
      1,
      lines,
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("SealAnchorMismatch");
    expect(
      (await su.query("SELECT 1 FROM scf.sealed_audit_anchors WHERE day = $1", [d])).rowCount,
    ).toBe(0);
    expect(lines.some((l) => l.includes('"seal_anchor_mismatch"') && l.includes(d))).toBe(true);
    writeFileSync(file, realText);
    const again = await run(today);
    expect(again.anchors?.published).toEqual([d]);
  });

  it("a kill between tenant transactions leaves provisional leaves that are never served; the rebuild serves valid proofs", async () => {
    today = addDays(today, 1);
    const d = addDays(today, -1);
    await writeAnchor(d);
    const sa = await signedSnapshot(A, new Date(`${d}T09:00:00Z`));
    const sb = await signedSnapshot(B, new Date(`${d}T09:00:00Z`));
    const kill = Object.assign(new Error("killed"), { name: "Killed" });
    await expect(
      run(today, {
        afterTenantLeaves: async (_day, _t, i) => {
          if (i === 0) throw kill;
        },
      }),
    ).rejects.toThrow("killed");
    expect(await dayRow("testnet", d)).toBeUndefined();
    const prov = await su.query<{ salt: Buffer; snapshot_id: string }>(
      "SELECT salt, snapshot_id FROM scf.seal_leaves WHERE network = 'testnet' AND day = $1",
      [d],
    );
    expect(prov.rowCount).toBe(1); // the first tenant's leaf only
    expect(await proofs(sa)).toBeNull();
    expect(await proofs(sb)).toBeNull();

    const r = await run(today);
    expect(r).toMatchObject({ built: [d], confirmed: [d] });
    for (const id of [sa, sb]) {
      const p = (await proofs(id)) as Proof[];
      expect(p).toHaveLength(1);
      verifyProof(p[0] as Proof);
    }
    // Fresh salts: the provisional leaf was deleted and rebuilt.
    const final = await su.query<{ salt: Buffer }>(
      "SELECT salt FROM scf.seal_leaves WHERE snapshot_id = $1 AND network = 'testnet'",
      [prov.rows[0]?.snapshot_id],
    );
    expect(final.rows[0]?.salt.equals(prov.rows[0]?.salt as Buffer)).toBe(false);
    // A final leaf can no longer be deleted by daily_seal (trigger seal_leaves_guard).
    await expect(
      db.tx("daily_seal", A.tenantId, (tx) =>
        tx.exec("DELETE FROM scf.seal_leaves WHERE tenant_id = $1 AND snapshot_id = $2", [
          A.tenantId,
          sa,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a kill after the day row leaves a built day that the next run submits", async () => {
    today = addDays(today, 1);
    const d = addDays(today, -1);
    await writeAnchor(d);
    const s = await signedSnapshot(A, new Date(`${d}T12:00:00Z`));
    await expect(
      run(today, {
        afterDayRow: async () => {
          throw new Error("killed after day row");
        },
      }),
    ).rejects.toThrow("killed after day row");
    expect((await dayRow("testnet", d))?.status).toBe("built");
    const before = ((await proofs(s)) as Proof[])[0] as Proof;
    expect(before.status).toBe("built");
    verifyProof(before);
    const r = await run(today);
    expect(r).toMatchObject({ built: [], confirmed: [d] });
    const after = ((await proofs(s)) as Proof[])[0] as Proof;
    expect(after).toMatchObject({
      status: "confirmed",
      leaf_hash: before.leaf_hash,
      root: before.root,
    });
  });

  it("a lost submission answer is resolved by looking up the stored hash (no second transaction)", async () => {
    today = addDays(today, 1);
    const d = addDays(today, -1);
    await writeAnchor(d);
    net.state.mode = "lose_response";
    const r1 = await run(today);
    net.state.mode = "ok";
    expect(r1).toMatchObject({ built: [d], confirmed: [] });
    const row = await dayRow("testnet", d);
    expect(row?.status).toBe("submitted");
    expect(net.state.txs.has(row?.tx_hash?.toString("hex") as string)).toBe(true);
    const subs = net.state.submissions;
    const r2 = await run(today);
    expect(r2).toMatchObject({ confirmed: [d] });
    expect(net.state.submissions).toBe(subs);
    // A rejected-then-retried submission (stale sequence) still confirms within the run.
    today = addDays(today, 1);
    const d2 = addDays(today, -1);
    await writeAnchor(d2);
    net.state.rejectNext = { code: "tx_bad_seq", count: 1 };
    expect(await run(today)).toMatchObject({ built: [d2], confirmed: [d2] });
  });

  it("builds every day of a three-day outage in ascending order, stopping at a missing anchor", async () => {
    const last = addDays(today, -1);
    today = addDays(today, 3);
    const days = [addDays(last, 1), addDays(last, 2), addDays(last, 3)];
    await writeAnchor(days[0] as string);
    await writeAnchor(days[2] as string); // the middle day's anchor is missing
    const s0 = await signedSnapshot(A, new Date(`${days[0]}T10:00:00Z`));
    const s1 = await signedSnapshot(B, new Date(`${days[1]}T10:00:00Z`));
    const s2 = await signedSnapshot(A, new Date(`${days[2]}T10:00:00Z`));
    const err = await run(today).catch((e) => e);
    expect(err.name).toBe("SealAnchorMissing"); // stuck before D−1: alertable
    expect(await dayRow("testnet", days[0] as string)).toMatchObject({ status: "confirmed" });
    expect(await dayRow("testnet", days[1] as string)).toBeUndefined();

    await writeAnchor(days[1] as string);
    const r = await run(today);
    expect(r).toMatchObject({ built: days.slice(1), confirmed: days.slice(1) });
    let prev = (await dayRow("testnet", last))?.root as Buffer;
    for (const day of days) {
      const row = await dayRow("testnet", day);
      expect(row?.prev_root.equals(prev)).toBe(true);
      prev = row?.root as Buffer;
    }
    // Each snapshot in the first day built after its signing.
    expect(((await proofs(s0)) as Proof[])[0]?.day).toBe(days[0]);
    expect(((await proofs(s1)) as Proof[])[0]?.day).toBe(days[1]);
    expect(((await proofs(s2)) as Proof[])[0]?.day).toBe(days[2]);
    // Submitted in day order: ascending ledgers.
    const ledgers = await Promise.all(
      days.map(async (x) => Number((await dayRow("testnet", x))?.ledger)),
    );
    expect([...ledgers].sort((a, b) => a - b)).toEqual(ledgers);
  });

  it("a lagging or catching-up Horizon proves no reset and changes nothing", async () => {
    const before = await su.query<{ day: string; status: string }>(
      "SELECT day::text AS day, status FROM scf.seal_days WHERE network = 'testnet' ORDER BY day",
    );
    // Far behind: an old latest ledger closed long before our confirmations, no account, no transaction.
    net.state.lag = { latest: 100, closedAt: "2020-01-01T00:00:00Z" };
    try {
      for (const hour of [1, 3]) {
        const err = await run(today, {}, {}, hour).catch((e) => e);
        expect(err.name).toBe("SealLedgerUnavailable");
      }
    } finally {
      net.state.lag = null;
    }
    const after = await su.query<{ day: string; status: string }>(
      "SELECT day::text AS day, status FROM scf.seal_days WHERE network = 'testnet' ORDER BY day",
    );
    expect(after.rows).toEqual(before.rows);
    expect(logs.join("\n")).not.toContain('"event":"seal_network_reset_detected"');
  });

  it("reverts a reset mark that the network contradicts", async () => {
    const newest = await su.query<{ day: string }>(
      `SELECT day::text AS day FROM scf.seal_days WHERE network = 'testnet' AND status = 'confirmed'
        ORDER BY day DESC LIMIT 2`,
    );
    const days = newest.rows.map((r) => r.day).sort();
    expect(days).toHaveLength(2);
    // as a false detection would have left them
    await su.query(
      "UPDATE scf.seal_days SET status = 'network_reset' WHERE network = 'testnet' AND day = ANY ($1::date[])",
      [days],
    );
    const r = await run(today);
    expect(r.resetReverted).toEqual(days);
    expect(r.resetDays).toEqual([]);
    for (const d of days) expect((await dayRow("testnet", d))?.status).toBe("confirmed");
    expect(r.history?.problems).toEqual([]);
  });

  it("a testnet reset marks confirmed days network_reset, re-funds the same key and starts segment + 1", async () => {
    const lastBefore = addDays(today, -1);
    const confirmedBefore = await su.query<{ day: string }>(
      "SELECT day::text AS day FROM scf.seal_days WHERE network = 'testnet' AND status = 'confirmed'",
    );
    const oldProof = ((await proofs(a1)) as Proof[])[0] as Proof;
    net.reset();
    today = addDays(today, 1);
    const d = addDays(today, -1);
    await writeAnchor(d);
    const s = await signedSnapshot(A, new Date(`${d}T10:00:00Z`));
    // First sighting of the proof: nothing is marked, funded, built or submitted.
    const first = await run(today, {}, {}, 1);
    expect(first).toMatchObject({
      built: [],
      confirmed: [],
      resetDays: [],
      funded: false,
      resetSuspected: true,
    });
    expect(logs.join("\n")).toContain('"event":"seal_network_reset_suspected"');
    expect((await dayRow("testnet", lastBefore))?.status).toBe("confirmed");
    // A run under 50 minutes later does not act either; one at least 50 minutes after the first does.
    expect((await run(today, {}, {}, 1)).resetDays).toEqual([]);
    const r = await run(today, {}, {}, 2);
    const kp = keypairFromSeed(seed);
    expect(r.funded).toBe(true);
    expect(net.state.friendbotCalls.at(-1)).toBe(kp.account); // the same key: source_account unchanged
    expect(r.resetDays.length).toBe(confirmedBefore.rowCount);
    expect(r).toMatchObject({ built: [d], confirmed: [d] });
    const reset = await su.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scf.seal_days
        WHERE network = 'testnet' AND status = 'network_reset' AND day = ANY ($1::date[])`,
      [confirmedBefore.rows.map((x) => x.day)],
    );
    expect(reset.rows[0]?.n).toBe(confirmedBefore.rowCount);
    const prevSeg = (await dayRow("testnet", lastBefore))?.segment as number;
    const row = await dayRow("testnet", d);
    expect(row).toMatchObject({
      segment: prevSeg + 1,
      status: "confirmed",
      source_account: kp.account,
    });
    verifyProof(((await proofs(s)) as Proof[])[0] as Proof);
    // Old proofs stay served and verifiable; their status says the transaction is gone.
    const p = ((await proofs(a1)) as Proof[])[0] as Proof;
    expect(p).toMatchObject({
      status: "network_reset",
      root: oldProof.root,
      tx_hash: oldProof.tx_hash,
    });
    verifyProof(p);
    // The history walk counts the reset days as not checkable, not as problems; the next run does not revert them.
    expect(r.history?.problems).toEqual([]);
    expect(r.history?.notCheckable).toBe(confirmedBefore.rowCount);
    expect((await run(today, {}, {}, 3)).resetReverted).toEqual([]);

    // The next day continues the new segment.
    today = addDays(today, 1);
    await writeAnchor(addDays(today, -1));
    await run(today);
    expect((await dayRow("testnet", addDays(today, -1)))?.segment).toBe(prevSeg + 1);
  });

  it("a tenant purged mid-build loses its leaves; the other proofs stay valid", async () => {
    today = addDays(today, 1);
    const d = addDays(today, -1);
    await writeAnchor(d);
    const C = await seedSite(su);
    const D = await seedSite(su);
    await optIn(C.tenantId);
    await optIn(D.tenantId);
    const sc = await signedSnapshot(C, new Date(`${d}T10:00:00Z`));
    const sd = await signedSnapshot(D, new Date(`${d}T10:00:00Z`));
    const purged = new Set<string>();
    const r = await run(today, {
      afterTenantLeaves: async (_day, tenantId) => {
        // While the first tenant's leaves are written, job tenant_purge removes the other tenant's snapshots.
        for (const t of [C.tenantId, D.tenantId]) {
          if (t === tenantId || purged.size > 0) continue;
          purged.add(t);
          await db.tx("tenant_purge", t, (tx) =>
            tx.exec("DELETE FROM scf.traction_snapshots WHERE tenant_id = $1", [t]),
          );
        }
      },
    });
    expect(r.built).toEqual([d]);
    expect(r.tenantsSkipped).toBeGreaterThanOrEqual(1);
    const kept = purged.has(C.tenantId) ? sd : sc;
    const gone = purged.has(C.tenantId) ? sc : sd;
    verifyProof(((await proofs(kept)) as Proof[])[0] as Proof);
    expect(await proofs(gone)).toBeNull();
    const left = await su.query("SELECT 1 FROM scf.seal_leaves WHERE snapshot_id = $1", [gone]);
    expect(left.rowCount).toBe(0);
  });

  it("the history walk detects a rewritten past seal (root changed behind the triggers)", async () => {
    // Every run above walked the account's whole history without a problem; here paged by 2 transactions.
    const fullLedger = ledger;
    ledger = new HorizonSealLedger({
      horizonUrl: net.horizonUrl,
      friendbotUrl: net.friendbotUrl,
      timeoutMs: 5000,
      historyPageSize: 2,
    });
    const clean = await run(today);
    expect(clean.history?.problems).toEqual([]);
    expect(clean.history?.daysChecked).toBeGreaterThanOrEqual(2);
    const victim = (
      await su.query<{ day: string; root: Buffer }>(
        `SELECT day::text AS day, root FROM scf.seal_days WHERE network = 'testnet' AND status = 'confirmed'
          ORDER BY day LIMIT 1`,
      )
    ).rows[0] as { day: string; root: Buffer };
    const forged = randomBytes(32);
    const asSuper = async (sql: string, params: unknown[]) => {
      const c = await su.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica"); // bypasses seal_days_guard
        await c.query(sql, params);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    };
    await asSuper("UPDATE scf.seal_days SET root = $2 WHERE network = 'testnet' AND day = $1", [
      victim.day,
      forged,
    ]);
    const lines: string[] = [];
    try {
      const err = await run(today, {}, {}, 1, lines).catch((e) => e);
      expect(err.name).toBe("SealHistoryMismatch");
      const problems = lines
        .map((l) => JSON.parse(l) as { event: string; problem?: string; day?: string })
        .filter((l) => l.event === "seal_history_problem");
      expect(problems).toContainEqual(
        expect.objectContaining({ problem: "memo_mismatch", day: victim.day }),
      );
      expect(problems).toContainEqual(
        expect.objectContaining({ problem: "root_mismatch", day: victim.day }),
      );
    } finally {
      await asSuper("UPDATE scf.seal_days SET root = $2 WHERE network = 'testnet' AND day = $1", [
        victim.day,
        victim.root,
      ]);
      ledger = fullLedger;
    }
    expect((await run(today)).history?.problems).toEqual([]);
  });

  it("builds but submits nothing without a key (mainnet chain, approved), and refuses a foreign network", async () => {
    const main = await nextFreeDay("mainnet", "2031-01-10");
    const d = addDays(main, -1);
    await writeAnchor(d);
    const before = net.state.requests.length;
    const r = await run(
      main,
      {},
      { network: "mainnet", passphrase: MAINNET, secretSeed: null, friendbot: false },
    );
    expect(r).toMatchObject({ built: [d], confirmed: [] });
    expect(net.state.requests.length).toBe(before); // no egress without a key
    expect(await dayRow("mainnet", d)).toMatchObject({
      status: "built",
      segment: 1,
      source_account: null,
    });

    // With a key, a Horizon serving another network is refused before anything is submitted.
    const subs = net.state.submissions;
    const err = await run(
      addDays(main, 1),
      {},
      { network: "mainnet", passphrase: MAINNET, friendbot: false },
    ).catch((e) => e);
    expect(err.name).toBe("SealLedgerUnavailable");
    expect(net.state.submissions).toBe(subs);
    expect(logs.join("\n")).toContain("SealNetworkMismatch");
  });

  it("never logs the seed or any secret key", () => {
    const text = logs.join("\n");
    expect(text).not.toContain(seed);
    expect(text).not.toMatch(/S[A-Z2-7]{55}/);
    expect(text).toContain('"event":"daily_seal_done"');
  });
});
