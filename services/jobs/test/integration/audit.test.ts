// SPDX-License-Identifier: Apache-2.0
// Acceptance (C-63, ADR-0014; data-model §5; wire-formats §m): audit_anchor publishes every chain head daily
// (file publisher, idempotently; the per-day manage_data publisher is superseded by daily_seal, C-136, and nothing is
// sent to a ledger any more — entries written before stay verifiable against the anchor files);
// audit_verify recomputes every chain with canonical text v2 computed outside the database (equal to
// scf.audit_canonical for every row) and detects a rewritten entry — also one whose attacker recomputed the hashes of
// the whole tail, through the published anchor.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIT_SELECT,
  type AuditRow,
  anchorSelfConsistent,
  buildAnchor,
  canonicalV2,
  FilePublisher,
  PLATFORM_CHAIN,
  rowHash,
  runAuditAnchor,
  runAuditVerify,
} from "../../src/audit/anchor.ts";
import type { ScfDb } from "../../src/db.ts";
import { publishSealedAnchors } from "../../src/seal/anchors.ts";
import { readAnchor } from "../../src/seal/daily-seal.ts";
import { buildDayTree, ZERO_ROOT } from "../../src/seal/merkle.ts";
import { manageDataAnchorMatches, manageDataAnchorName } from "../../src/stellar/tx.ts";
import { capture, jobsDb, seedSite, superClient } from "../support/harness.ts";

let su: pg.Pool;
let db: ScfDb;
let dir: string;
let horizon: Server;
let horizonUrl: string;
const requests: string[] = [];

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  dir = mkdtempSync(join(tmpdir(), "wsg-anchor-"));
  // Some chain content with awkward characters (quotes, newline, unicode, NULLs, arrays).
  const s = await seedSite(su);
  await db.tx("retention", s.tenantId, (tx) =>
    tx.audit("retention.umami_pruned", "tenant", s.tenantId, {
      note: 'a "q"\n\t\\ é ✓',
      n: 1.5,
      z: null,
      arr: [1, "x"],
    }),
  );
  // A Horizon that records every request: audit_anchor must not contact a ledger any more (C-136).
  horizon = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) =>
    horizon.listen(Number(process.env.SCF_WSG_HORIZON_PORT ?? 56273), "127.0.0.1", r),
  );
  horizonUrl = `http://127.0.0.1:${(horizon.address() as { port: number }).port}`;
});

afterAll(async () => {
  await su?.end();
  await db?.pool.end();
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => horizon?.close(r));
});

async function tamper(sql: string, params: unknown[]) {
  const c = await su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica"); // bypasses the append-only triggers
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

describe("audit chain anchoring and verification", () => {
  it("computes canonical text v2 exactly like scf.audit_canonical for every row", async () => {
    const r = await su.query<AuditRow & { sql_canon: string }>(
      `${AUDIT_SELECT.replace("FROM scf.audit_log a", ", scf.audit_canonical(a) AS sql_canon FROM scf.audit_log a")}
       ORDER BY a.chain_id, a.seq`,
    );
    expect(r.rows.length).toBeGreaterThan(5);
    for (const row of r.rows) {
      expect(canonicalV2(row)).toBe(row.sql_canon);
      expect(rowHash(row.prev_hash, canonicalV2(row)).equals(row.row_hash)).toBe(true);
    }
  });

  it("publishes the chain heads (file), idempotently, and verifies clean chains", async () => {
    const files = new FilePublisher(dir);
    const cap = capture();
    // Anchor today's rows as of "now" (production uses the end of the previous day); the audit.anchored row written
    // by the run itself is after the cut-off, so a rerun builds the identical document.
    const at = { date: new Date().toISOString().slice(0, 10), cutoff: new Date() };
    await new Promise((r) => setTimeout(r, 5));
    const doc = await runAuditAnchor(db, [files], cap.ctx(), at);
    expect(anchorSelfConsistent(doc)).toBe(true);
    const heads = await su.query(
      "SELECT count(*)::int AS n FROM scf.audit_chain_heads WHERE last_seq > 0",
    );
    expect(doc.chains.length).toBe(heads.rows[0]?.n);
    const onDisk = JSON.parse(readFileSync(join(dir, "audit-anchors", `${doc.date}.json`), "utf8"));
    expect(onDisk).toEqual(doc);

    // C-136: nothing goes to a ledger; a manage_data entry written before stays checkable against the file.
    expect(requests).toEqual([]);
    expect(horizonUrl).toMatch(/^http:/);
    const legacyValue = Buffer.from(doc.sha256, "hex").toString("base64"); // what Horizon returns as data[name]
    expect(manageDataAnchorName(doc.date)).toBe(`scf-audit-${doc.date.replaceAll("-", "")}`);
    expect(manageDataAnchorMatches(legacyValue, doc.sha256)).toBe(true);
    expect(manageDataAnchorMatches(legacyValue, "00".repeat(32))).toBe(false);

    // Rerun: the file stays as published.
    const again = await runAuditAnchor(db, [files], cap.ctx(), at);
    expect(
      JSON.parse(readFileSync(join(dir, "audit-anchors", `${doc.date}.json`), "utf8")),
    ).toEqual(doc);
    expect(again).toEqual(doc); // deterministic: the audit.anchored row of the first run is after nothing it covers

    const v = await runAuditVerify(db, files, cap.ctx());
    expect(v.problems).toEqual([]);
    expect(v.anchorChecked).toBe(true);
    expect(cap.registry.render()).toContain("scf_audit_chain_problems 0");
  });

  it("detects a rewritten entry, and a rewritten tail with recomputed hashes through the anchor", async () => {
    const files = new FilePublisher(dir);
    const anchor = await files.latest();
    const target = anchor?.chains.find((c) => c.seq >= 2);
    if (!target) throw new Error("no chain with two rows");
    const row = await su.query<{ details: unknown }>(
      "SELECT details FROM scf.audit_log WHERE chain_id = $1 AND seq = 1",
      [target.chain_id],
    );
    // 1) Naive rewrite of one entry's details.
    await tamper(
      "UPDATE scf.audit_log SET details = '{\"rewritten\":true}' WHERE chain_id = $1 AND seq = 1",
      [target.chain_id],
    );
    const cap = capture();
    await expect(runAuditVerify(db, files, cap.ctx())).rejects.toThrow(/verification failed/);
    expect(cap.registry.render()).not.toContain("scf_audit_chain_problems 0");

    // 2) A careful attacker recomputes row 1's hash and every following prev_hash/row_hash of that chain.
    const rows = await su.query<AuditRow>(`${AUDIT_SELECT} WHERE a.chain_id = $1 ORDER BY a.seq`, [
      target.chain_id,
    ]);
    let prev: Buffer = Buffer.alloc(32);
    for (const r of rows.rows) {
      const h = rowHash(prev, canonicalV2({ ...r, prev_hash: prev }));
      await tamper(
        "UPDATE scf.audit_log SET prev_hash = $3, row_hash = $4 WHERE chain_id = $1 AND seq = $2",
        [target.chain_id, r.seq, prev, h],
      );
      prev = h;
    }
    const cap2 = capture();
    await expect(runAuditVerify(db, files, cap2.ctx())).rejects.toThrow(/verification failed/);
    const verified = await su.query<{
      details: { problems: number; first_problems: Array<{ problem: string }> };
    }>(
      "SELECT details FROM scf.audit_log WHERE action = 'audit.verified' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(verified.rows[0]?.details.first_problems.map((p) => p.problem)).toContain(
      "anchor_mismatch",
    );

    // Restore the original content and hashes so later runs on a reused stack stay clean.
    await tamper("UPDATE scf.audit_log SET details = $2 WHERE chain_id = $1 AND seq = 1", [
      target.chain_id,
      JSON.stringify(row.rows[0]?.details),
    ]);
    const orig = await su.query<AuditRow>(`${AUDIT_SELECT} WHERE a.chain_id = $1 ORDER BY a.seq`, [
      target.chain_id,
    ]);
    prev = Buffer.alloc(32);
    for (const r of orig.rows) {
      const h = rowHash(prev, canonicalV2({ ...r, prev_hash: prev }));
      await tamper(
        "UPDATE scf.audit_log SET prev_hash = $3, row_hash = $4 WHERE chain_id = $1 AND seq = $2",
        [target.chain_id, r.seq, prev, h],
      );
      prev = h;
    }
    await expect(runAuditVerify(db, files, capture().ctx())).resolves.toMatchObject({
      problems: [],
    });
  });
  it("0077: a rewritten operator-log row is caught through the seal, even with the anchor file rewritten to match", async () => {
    const files = new FilePublisher(dir);
    const anchor = await files.latest();
    if (!anchor) throw new Error("no anchor");
    const platform = anchor.chains.find((c) => c.chain_id === PLATFORM_CHAIN && c.seq >= 1);
    if (!platform) throw new Error("the operator (platform) chain is not anchored");
    const file = join(dir, "audit-anchors", `${anchor.date}.json`);
    const fileText = readFileSync(file, "utf8");
    // Seal the anchor's day (a mainnet day row written as the job would; the triggers' chain rules are bypassed so
    // the row does not depend on other suites' chains) and let daily_seal publish the sealed document.
    const tree = buildDayTree({
      network: "mainnet",
      day: anchor.date,
      prevRoot: ZERO_ROOT,
      auditAnchorSha256: Buffer.from(anchor.sha256, "hex"),
      snapshots: [],
    });
    const cleanup = async () => {
      await tamper("DELETE FROM scf.sealed_audit_anchors WHERE day = $1::date", [anchor.date]);
      await tamper("DELETE FROM scf.seal_days WHERE network = 'mainnet' AND day = $1::date", [
        anchor.date,
      ]);
    };
    await cleanup();
    await tamper(
      `INSERT INTO scf.seal_days (network, day, segment, prev_root, audit_anchor_sha256, leaf_count, head_path, root)
       VALUES ('mainnet', $1::date, 1, $2, $3, $4, $5::bytea[], $6)`,
      [
        anchor.date,
        tree.prevRoot,
        tree.auditAnchorSha256,
        tree.leafCount,
        tree.headPath,
        tree.root,
      ],
    );
    const original = await su.query<AuditRow>(
      `${AUDIT_SELECT} WHERE a.chain_id = $1 ORDER BY a.seq`,
      [PLATFORM_CHAIN],
    );
    const rehash = async (rows: AuditRow[]) => {
      let prev: Buffer = Buffer.alloc(32);
      const heads = new Map<number, string>();
      for (const r of rows) {
        const h = rowHash(prev, canonicalV2({ ...r, prev_hash: prev }));
        await tamper(
          "UPDATE scf.audit_log SET prev_hash = $3, row_hash = $4 WHERE chain_id = $1 AND seq = $2",
          [PLATFORM_CHAIN, r.seq, prev, h],
        );
        heads.set(Number(r.seq), h.toString("hex"));
        prev = h;
      }
      return heads;
    };
    try {
      const pub = await publishSealedAnchors(
        db,
        "mainnet",
        (day) => readAnchor(dir, day),
        capture().ctx(),
      );
      expect(pub.published).toEqual([anchor.date]);
      const clean = await runAuditVerify(db, files, capture().ctx());
      expect(clean).toMatchObject({ problems: [], sealChecked: true });
      // the newest anchor checked: this day, or a later day another suite sealed on this stack
      expect((clean.anchorDate as string) >= anchor.date).toBe(true);

      // The attacker rewrites the first operator action, recomputes the whole tail of that chain AND rewrites the
      // anchor file with the new head (self-consistent), so the file-only check of before would pass.
      await tamper(
        "UPDATE scf.audit_log SET details = '{\"rewritten\":true}' WHERE chain_id = $1 AND seq = 1",
        [PLATFORM_CHAIN],
      );
      const rewritten = await su.query<AuditRow>(
        `${AUDIT_SELECT} WHERE a.chain_id = $1 ORDER BY a.seq`,
        [PLATFORM_CHAIN],
      );
      const heads = await rehash(rewritten.rows);
      const forged = buildAnchor(
        anchor.date,
        new Date(anchor.generated_at),
        anchor.chains.map((c) =>
          c.chain_id === PLATFORM_CHAIN ? { ...c, row_hash: heads.get(c.seq) as string } : c,
        ),
      );
      expect(anchorSelfConsistent(forged)).toBe(true);
      writeFileSync(file, `${JSON.stringify(forged, null, 1)}\n`);

      await expect(runAuditVerify(db, files, capture().ctx())).rejects.toThrow(
        /verification failed/,
      );
      const verified = await su.query<{
        details: { anchor_sealed: boolean; first_problems: Array<{ problem: string }> };
      }>(
        "SELECT details FROM scf.audit_log WHERE action = 'audit.verified' ORDER BY occurred_at DESC LIMIT 1",
      );
      const problems = verified.rows[0]?.details.first_problems.map((p) => p.problem);
      expect(problems).toContain("anchor_seal_mismatch"); // the file is not what the seal fixed
      expect(problems).toContain("anchor_mismatch"); // the live chain is not what the seal fixed
      expect(verified.rows[0]?.details.anchor_sealed).toBe(true);
    } finally {
      writeFileSync(file, fileText);
      await tamper("UPDATE scf.audit_log SET details = $2 WHERE chain_id = $1 AND seq = 1", [
        PLATFORM_CHAIN,
        (original.rows[0] as AuditRow).details,
      ]);
      const restored = await su.query<AuditRow>(
        `${AUDIT_SELECT} WHERE a.chain_id = $1 ORDER BY a.seq`,
        [PLATFORM_CHAIN],
      );
      await rehash(restored.rows);
      await cleanup();
    }
    await expect(runAuditVerify(db, files, capture().ctx())).resolves.toMatchObject({
      problems: [],
    });
  });
});
