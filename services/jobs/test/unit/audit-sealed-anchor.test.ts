// SPDX-License-Identifier: Apache-2.0
// Audit log anchored by the daily seal (migration 0077; wire-formats §m.1, §m.2): which anchor audit_verify checks the
// live chains against, and when a sealed document may be published. No database, no network.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AnchorDocument,
  anchorMatchesSeal,
  buildAnchor,
  chooseAnchors,
  PLATFORM_CHAIN,
  type SealedDayRow,
} from "../../src/audit/anchor.ts";
import { isSealedDocument } from "../../src/seal/anchors.ts";
import { buildDayTree, ZERO_ROOT } from "../../src/seal/merkle.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

function anchorOf(day: string, seq: number, salt = ""): AnchorDocument {
  return buildAnchor(day, new Date(`${day}T23:59:59Z`), [
    { chain_id: PLATFORM_CHAIN, seq, row_hash: h(`${day}${seq}${salt}`) },
    { chain_id: "0193aaaa-0000-7000-8000-000000000001", seq: 3, row_hash: h(`t${day}`) },
  ]);
}

/** The seal day that commits to `doc` (a real tree with two snapshot leaves). */
function sealOf(doc: AnchorDocument, prevRoot: Buffer = ZERO_ROOT): SealedDayRow {
  const t = buildDayTree({
    network: "testnet",
    day: doc.date,
    prevRoot,
    auditAnchorSha256: Buffer.from(doc.sha256, "hex"),
    snapshots: [1, 2].map((i) => ({
      tenantId: "t",
      snapshotId: `0193aaaa-0000-7000-8000-00000000000${i}`,
      snapshotSha256: Buffer.alloc(32, i),
      salt: Buffer.alloc(32, 9 + i),
    })),
  });
  return {
    network: "testnet",
    day: doc.date,
    prev_root: t.prevRoot,
    audit_anchor_sha256: t.auditAnchorSha256,
    head_path: t.headPath,
    root: t.root,
  };
}

describe("anchorMatchesSeal", () => {
  it("accepts the sealed document and rejects every other", () => {
    const doc = anchorOf("2026-11-18", 40);
    const seal = sealOf(doc);
    expect(anchorMatchesSeal(doc, seal)).toBe(true);
    // the operator chain's head rewritten (one row of the operator log changed, the file recomputed)
    const rewritten = anchorOf("2026-11-18", 40, "rewritten");
    expect(rewritten.sha256).not.toBe(doc.sha256);
    expect(anchorMatchesSeal(rewritten, seal)).toBe(false);
    expect(anchorMatchesSeal(anchorOf("2026-11-17", 40), seal)).toBe(false);
  });

  it("rejects a seal row whose stored hash was swapped without recomputing the root", () => {
    const doc = anchorOf("2026-11-18", 40);
    const other = anchorOf("2026-11-18", 41);
    const seal = { ...sealOf(doc), audit_anchor_sha256: Buffer.from(other.sha256, "hex") };
    expect(anchorMatchesSeal(other, seal)).toBe(false);
  });
});

describe("chooseAnchors", () => {
  const d1 = anchorOf("2026-11-17", 30);
  const d2 = anchorOf("2026-11-18", 40);

  it("uses only the file before anything is sealed", () => {
    expect(chooseAnchors(d2, [], null)).toEqual({ anchors: [d2], sealed: false, problems: [] });
  });

  it("uses the sealed document and the newer, not yet sealed file", () => {
    const r = chooseAnchors(d2, [], { doc: d1, seals: [sealOf(d1)] });
    expect(r.problems).toEqual([]);
    expect(r.sealed).toBe(true);
    expect(r.anchors.map((a) => a.date)).toEqual(["2026-11-17", "2026-11-18"]);
  });

  it("uses one anchor when the file is the sealed day", () => {
    const r = chooseAnchors(d2, [sealOf(d2)], { doc: d2, seals: [sealOf(d2)] });
    expect(r).toEqual({ anchors: [d2], sealed: true, problems: [] });
  });

  it("reports a file its seal contradicts and checks against the sealed document instead", () => {
    const forged = anchorOf("2026-11-18", 40, "rewritten");
    const r = chooseAnchors(forged, [sealOf(d2)], { doc: d2, seals: [sealOf(d2)] });
    expect(r.problems).toEqual([
      { chain_id: PLATFORM_CHAIN, seq: 0, problem: "anchor_seal_mismatch" },
    ]);
    expect(r.anchors).toEqual([d2]);
    expect(r.sealed).toBe(true);
  });

  it("reports a stored sealed document that its seal no longer fixes, and does not use it", () => {
    const forged = anchorOf("2026-11-17", 30, "rewritten");
    const r = chooseAnchors(null, [], { doc: forged, seals: [sealOf(d1)] });
    expect(r.problems.map((p) => p.problem)).toEqual(["anchor_seal_mismatch"]);
    expect(r.anchors).toEqual([]);
    expect(r.sealed).toBe(false);
  });

  it("a stored document whose seal row is gone is not trusted", () => {
    const r = chooseAnchors(null, [], { doc: d1, seals: [] });
    expect(r.problems.map((p) => p.problem)).toEqual(["anchor_seal_mismatch"]);
  });
});

describe("isSealedDocument (what daily_seal publishes)", () => {
  it("publishes only the document whose hash was sealed", () => {
    const doc = anchorOf("2026-11-18", 40);
    const sealed = Buffer.from(doc.sha256, "hex");
    expect(isSealedDocument(doc, "2026-11-18", sealed)).toBe(true);
    expect(isSealedDocument(anchorOf("2026-11-18", 41), "2026-11-18", sealed)).toBe(false);
    expect(isSealedDocument(doc, "2026-11-17", sealed)).toBe(false);
  });
});
