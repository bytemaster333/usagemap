// SPDX-License-Identifier: Apache-2.0
// Known-answer test of the daily seal (wire-formats §m.2, C-137): the job's tree code reproduces every value of
// docs/contracts/vectors/seal-v1.json — the RFC 6962 reference roots, RFC 9162 roots and inclusion paths for 2 to 9
// leaves at every index, the three leaf encodings byte for byte, and the three-day chain (head paths, segment change,
// snapshot proofs) built through buildDayTree with the vector's salts.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditLeafData,
  auditPath,
  buildDayTree,
  chainLeafData,
  leafHash,
  merkleRoot,
  rootFromHead,
  snapshotLeafData,
  verifyInclusion,
  ZERO_ROOT,
} from "../../src/seal/merkle.ts";

const VECTORS = resolve(import.meta.dirname, "../../../../docs/contracts/vectors/seal-v1.json");

interface Vectors {
  schema: string;
  rfc6962_reference_roots: { leaf_inputs_hex: string[]; root: string }[];
  encodings: {
    chain: { network: string; day: string; prev_root: string; data: string; leaf_hash: string };
    chain_first_day: {
      network: string;
      day: string;
      prev_root: string;
      data: string;
      leaf_hash: string;
    };
    audit: { day: string; audit_anchor_sha256: string; data: string; leaf_hash: string };
    snapshot: {
      salt: string;
      snapshot_id: string;
      snapshot_sha256: string;
      data: string;
      leaf_hash: string;
    };
  };
  trees: {
    leaf_count: number;
    leaf_data_ascii: string[];
    leaf_hashes: string[];
    root: string;
    proofs: { leaf_index: number; audit_path: string[] }[];
  }[];
  chain: {
    network: "testnet";
    day: string;
    segment: number;
    prev_root: string;
    audit_anchor_sha256: string;
    chain_leaf_hash: string;
    audit_leaf_hash: string;
    leaf_count: number;
    head_path: string[];
    root: string;
    proofs: {
      snapshot_id: string;
      snapshot_sha256: string;
      salt: string;
      leaf_index: number;
      leaf_hash: string;
      audit_path: string[];
    }[];
  }[];
}

const v = JSON.parse(readFileSync(VECTORS, "utf8")) as Vectors;
const hex = (b: Buffer) => b.toString("hex");
const bytes = (h: string) => Buffer.from(h, "hex");

describe("seal known-answer vectors (seal-v1.json)", () => {
  it("is the scf-seal/1 vector file", () => {
    expect(v.schema).toBe("scf-analytics/seal-vectors/1");
  });

  it("reproduces the RFC 6962 reference roots", () => {
    for (const r of v.rfc6962_reference_roots) {
      expect(hex(merkleRoot(r.leaf_inputs_hex.map((x) => leafHash(bytes(x)))))).toBe(r.root);
    }
  });

  it("reproduces roots and every inclusion path of trees with 2 to 9 leaves", () => {
    expect(v.trees.map((t) => t.leaf_count)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    for (const t of v.trees) {
      const hashes = t.leaf_data_ascii.map((d) => leafHash(Buffer.from(d, "ascii")));
      expect(hashes.map(hex)).toEqual(t.leaf_hashes);
      const root = merkleRoot(hashes);
      expect(hex(root)).toBe(t.root);
      for (const p of t.proofs) {
        const path = auditPath(p.leaf_index, hashes);
        expect(path.map(hex)).toEqual(p.audit_path);
        expect(
          verifyInclusion(p.leaf_index, t.leaf_count, hashes[p.leaf_index] as Buffer, path, root),
        ).toBe(true);
        // A proof for the wrong index or a modified leaf fails.
        expect(
          verifyInclusion(
            (p.leaf_index + 1) % t.leaf_count,
            t.leaf_count,
            hashes[p.leaf_index] as Buffer,
            path,
            root,
          ),
        ).toBe(false);
        expect(verifyInclusion(p.leaf_index, t.leaf_count, Buffer.alloc(32, 9), path, root)).toBe(
          false,
        );
      }
    }
  });

  it("encodes the three leaves byte for byte", () => {
    const e = v.encodings;
    const chain = chainLeafData("testnet", e.chain.day, bytes(e.chain.prev_root));
    expect(hex(chain)).toBe(e.chain.data);
    expect(hex(leafHash(chain))).toBe(e.chain.leaf_hash);
    const first = chainLeafData("testnet", e.chain_first_day.day, ZERO_ROOT);
    expect(hex(first)).toBe(e.chain_first_day.data);
    expect(hex(leafHash(first))).toBe(e.chain_first_day.leaf_hash);
    const audit = auditLeafData(e.audit.day, bytes(e.audit.audit_anchor_sha256));
    expect(hex(audit)).toBe(e.audit.data);
    expect(hex(leafHash(audit))).toBe(e.audit.leaf_hash);
    const snap = snapshotLeafData(
      bytes(e.snapshot.salt),
      e.snapshot.snapshot_id,
      bytes(e.snapshot.snapshot_sha256),
    );
    expect(hex(snap)).toBe(e.snapshot.data);
    expect(hex(leafHash(snap))).toBe(e.snapshot.leaf_hash);
  });

  it("builds the three-day chain exactly (head paths, segment change, snapshot proofs)", () => {
    let prev = ZERO_ROOT;
    for (const d of v.chain) {
      expect(d.prev_root).toBe(hex(prev));
      // Inputs in an order different from the sorted one: the tree sorts snapshot leaves by leaf hash.
      const inputs = [...d.proofs].reverse().map((p) => ({
        tenantId: "00000000-0000-0000-0000-000000000001",
        snapshotId: p.snapshot_id,
        snapshotSha256: bytes(p.snapshot_sha256),
        salt: bytes(p.salt),
      }));
      const tree = buildDayTree({
        network: d.network,
        day: d.day,
        prevRoot: prev,
        auditAnchorSha256: bytes(d.audit_anchor_sha256),
        snapshots: inputs,
      });
      expect(hex(tree.chainLeaf)).toBe(d.chain_leaf_hash);
      expect(hex(tree.auditLeaf)).toBe(d.audit_leaf_hash);
      expect(tree.leafCount).toBe(d.leaf_count);
      expect(tree.headPath.map(hex)).toEqual(d.head_path);
      expect(hex(tree.root)).toBe(d.root);
      expect(
        tree.snapshots.map((s) => ({
          snapshot_id: s.snapshotId,
          snapshot_sha256: hex(s.snapshotSha256),
          salt: hex(s.salt),
          leaf_index: s.leafIndex,
          leaf_hash: hex(s.leafHash),
          audit_path: s.auditPath.map(hex),
        })),
      ).toEqual(d.proofs);
      // Verification step 5: the root from public data alone.
      expect(
        hex(rootFromHead("testnet", d.day, prev, bytes(d.audit_anchor_sha256), tree.headPath)),
      ).toBe(d.root);
      // head_path length = ceil(log2(leaf_count)) - 1, as the seal_days check requires.
      expect(tree.headPath.length).toBe(Math.ceil(Math.log2(d.leaf_count)) - 1);
      prev = tree.root;
    }
    expect(v.chain.map((d) => d.segment)).toEqual([1, 1, 2]);
  });

  it("changes the root when anything that is committed changes", () => {
    const base = {
      network: "testnet" as const,
      day: "2026-11-16",
      prevRoot: Buffer.alloc(32, 1),
      auditAnchorSha256: Buffer.alloc(32, 2),
      snapshots: [
        {
          tenantId: "t",
          snapshotId: "0193b7e2-0000-7000-8000-000000000001",
          snapshotSha256: createHash("sha256").update("doc").digest(),
          salt: Buffer.alloc(32, 3),
        },
      ],
    };
    const r = hex(buildDayTree(base).root);
    expect(hex(buildDayTree({ ...base, network: "mainnet" }).root)).not.toBe(r);
    expect(hex(buildDayTree({ ...base, day: "2026-11-17" }).root)).not.toBe(r);
    expect(hex(buildDayTree({ ...base, prevRoot: Buffer.alloc(32, 9) }).root)).not.toBe(r);
    expect(hex(buildDayTree({ ...base, auditAnchorSha256: Buffer.alloc(32, 9) }).root)).not.toBe(r);
    expect(
      hex(
        buildDayTree({
          ...base,
          snapshots: [
            { ...(base.snapshots[0] as (typeof base.snapshots)[0]), salt: Buffer.alloc(32, 4) },
          ],
        }).root,
      ),
    ).not.toBe(r);
  });
});
