// SPDX-License-Identifier: Apache-2.0
// The daily seal's tree (wire-formats §m.2, scf-seal/1; C-136, C-137): RFC 9162 §2.1 (Certificate Transparency v2)
// Merkle tree with SHA-256, leaf hash H(0x00 ‖ data), node hash H(0x01 ‖ left ‖ right), the root of n leaves split at
// the largest power of two below n. Leaves: 0 = chain (previous day's root), 1 = audit (the day's audit-anchor
// document hash), 2… = salted snapshot leaves sorted bytewise by leaf hash.
//
// Everything here is pure and deterministic given the salts; docs/contracts/vectors/seal-v1.json is the known-answer
// test (test/unit/seal-merkle.test.ts reproduces every value of it).

import { createHash } from "node:crypto";

export type Bytes = Buffer;

export const ZERO_ROOT: Bytes = Buffer.alloc(32);

const H = (...parts: Bytes[]): Bytes => createHash("sha256").update(Buffer.concat(parts)).digest();
const ascii = (s: string): Bytes => Buffer.from(s, "ascii");
const Z = Buffer.from([0]);

export const leafHash = (data: Bytes): Bytes => H(Buffer.from([0]), data);
export const nodeHash = (l: Bytes, r: Bytes): Bytes => H(Buffer.from([1]), l, r);

/** The largest power of two smaller than n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/** MTH over leaf hashes (RFC 9162 §2.1.1). */
export function merkleRoot(hashes: readonly Bytes[]): Bytes {
  if (hashes.length === 0) return H();
  if (hashes.length === 1) return hashes[0] as Bytes;
  const k = split(hashes.length);
  return nodeHash(merkleRoot(hashes.slice(0, k)), merkleRoot(hashes.slice(k)));
}

/** PATH(m, D[n]) over leaf hashes (RFC 9162 §2.1.3.1), bottom-up. */
export function auditPath(m: number, hashes: readonly Bytes[]): Bytes[] {
  if (hashes.length <= 1) return [];
  const k = split(hashes.length);
  return m < k
    ? [...auditPath(m, hashes.slice(0, k)), merkleRoot(hashes.slice(k))]
    : [...auditPath(m - k, hashes.slice(k)), merkleRoot(hashes.slice(0, k))];
}

/** RFC 9162 §2.1.3.2: verifies an inclusion proof. */
export function verifyInclusion(
  index: number,
  size: number,
  leaf: Bytes,
  path: readonly Bytes[],
  root: Bytes,
): boolean {
  if (index >= size || index < 0) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && r.equals(root);
}

// ------------------------------------------------------------------------------------------- leaf encodings

export type SealNetwork = "testnet" | "mainnet";

export function chainLeafData(network: SealNetwork, day: string, prevRoot: Bytes): Bytes {
  if (prevRoot.length !== 32) throw new Error("prev_root must be 32 bytes");
  return Buffer.concat([ascii("scf-seal/1 chain"), Z, ascii(network), Z, ascii(day), prevRoot]);
}

export function auditLeafData(day: string, anchorSha256: Bytes): Bytes {
  if (anchorSha256.length !== 32) throw new Error("anchor sha256 must be 32 bytes");
  return Buffer.concat([ascii("scf-seal/1 audit"), Z, ascii(day), anchorSha256]);
}

/** RFC 9562 byte order: the UUID's 32 hex digits as bytes. */
export function uuidBytes(id: string): Bytes {
  const hex = id.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("not a uuid");
  return Buffer.from(hex, "hex");
}

export function snapshotLeafData(salt: Bytes, snapshotId: string, snapshotSha256: Bytes): Bytes {
  if (salt.length !== 32 || snapshotSha256.length !== 32)
    throw new Error("salt and hash are 32 bytes");
  return Buffer.concat([
    ascii("scf-seal/1 snapshot"),
    Z,
    salt,
    uuidBytes(snapshotId),
    snapshotSha256,
  ]);
}

// ------------------------------------------------------------------------------------------- one day's tree

export interface SnapshotInput {
  tenantId: string;
  snapshotId: string;
  snapshotSha256: Bytes;
  salt: Bytes;
}

export interface SealedSnapshot extends SnapshotInput {
  leafIndex: number;
  leafHash: Bytes;
  auditPath: Bytes[];
}

export interface DayTree {
  network: SealNetwork;
  day: string;
  prevRoot: Bytes;
  auditAnchorSha256: Bytes;
  chainLeaf: Bytes;
  auditLeaf: Bytes;
  leafCount: number;
  /** Siblings above the node over leaves 0 and 1, bottom-up, each a right sibling (C-137). */
  headPath: Bytes[];
  root: Bytes;
  snapshots: SealedSnapshot[];
}

export function buildDayTree(o: {
  network: SealNetwork;
  day: string;
  prevRoot: Bytes;
  auditAnchorSha256: Bytes;
  snapshots: readonly SnapshotInput[];
}): DayTree {
  const chainLeaf = leafHash(chainLeafData(o.network, o.day, o.prevRoot));
  const auditLeaf = leafHash(auditLeafData(o.day, o.auditAnchorSha256));
  const snaps = o.snapshots
    .map((s) => ({
      ...s,
      leafHash: leafHash(snapshotLeafData(s.salt, s.snapshotId, s.snapshotSha256)),
    }))
    .sort((a, b) => Buffer.compare(a.leafHash, b.leafHash));
  const hashes = [chainLeaf, auditLeaf, ...snaps.map((s) => s.leafHash)];
  const root = merkleRoot(hashes);
  return {
    network: o.network,
    day: o.day,
    prevRoot: o.prevRoot,
    auditAnchorSha256: o.auditAnchorSha256,
    chainLeaf,
    auditLeaf,
    leafCount: hashes.length,
    headPath: auditPath(0, hashes).slice(1),
    root,
    snapshots: snaps.map((s, i) => ({
      ...s,
      leafIndex: i + 2,
      auditPath: auditPath(i + 2, hashes),
    })),
  };
}

/** §m.2 verification step 5: the root from public data alone (prev_root, anchor hash, head_path). */
export function rootFromHead(
  network: SealNetwork,
  day: string,
  prevRoot: Bytes,
  auditAnchorSha256: Bytes,
  headPath: readonly Bytes[],
): Bytes {
  let r = nodeHash(
    leafHash(chainLeafData(network, day, prevRoot)),
    leafHash(auditLeafData(day, auditAnchorSha256)),
  );
  for (const p of headPath) r = nodeHash(r, p);
  return r;
}
