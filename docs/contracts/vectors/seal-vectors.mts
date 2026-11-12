// SPDX-License-Identifier: Apache-2.0
// Known-answer vectors for the daily seal (docs/contracts/wire-formats.md §m.2; decisions C-136, C-137).
// Node standard library only; run from the repository root:
//   node docs/contracts/vectors/seal-vectors.mts           writes docs/contracts/vectors/seal-v1.json
//   node docs/contracts/vectors/seal-vectors.mts --check   exits 1 when seal-v1.json is not what this script produces
// Every value is computed here and then checked a second, independent way: roots against the RFC 6962/9162 test
// vectors of the Certificate Transparency reference code, every inclusion path with the verification algorithm of
// RFC 9162 §2.1.3.2, every head path by recomputing the root from the chain and audit leaves alone. The job
// `daily_seal` and the browser verifier (/verify) must both reproduce seal-v1.json byte for byte in their tests.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Bytes = Buffer;
const H = (...parts: Bytes[]): Bytes => createHash("sha256").update(Buffer.concat(parts)).digest();
const hex = (b: Bytes): string => b.toString("hex");
const ascii = (s: string): Bytes => Buffer.from(s, "ascii");
const fill = (byte: number): Bytes => Buffer.alloc(32, byte);
const ZERO = fill(0);

// RFC 9162 §2.1.1: leaf hash H(0x00 ‖ data), node hash H(0x01 ‖ left ‖ right).
const leafHash = (data: Bytes): Bytes => H(Buffer.from([0]), data);
const nodeHash = (l: Bytes, r: Bytes): Bytes => H(Buffer.from([1]), l, r);
const split = (n: number): number => {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k; // the largest power of two smaller than n (n >= 2)
};

// MTH over leaf hashes (RFC 9162 §2.1.1).
function mth(hashes: Bytes[]): Bytes {
  if (hashes.length === 0) return H();
  if (hashes.length === 1) return hashes[0] as Bytes;
  const k = split(hashes.length);
  return nodeHash(mth(hashes.slice(0, k)), mth(hashes.slice(k)));
}

// PATH(m, D[n]) over leaf hashes (RFC 9162 §2.1.3.1), bottom-up.
function path(m: number, hashes: Bytes[]): Bytes[] {
  if (hashes.length <= 1) return [];
  const k = split(hashes.length);
  return m < k
    ? [...path(m, hashes.slice(0, k)), mth(hashes.slice(k))]
    : [...path(m - k, hashes.slice(k)), mth(hashes.slice(0, k))];
}

// RFC 9162 §2.1.3.2: verify an inclusion proof (independent of path()/mth()).
function verifyInclusion(index: number, size: number, leaf: Bytes, auditPath: Bytes[], root: Bytes): boolean {
  if (index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of auditPath) {
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

// Leaf encodings of §m.2 (strings ASCII, ‖ concatenation).
const chainData = (network: string, day: string, prevRoot: Bytes): Bytes =>
  Buffer.concat([ascii("scf-seal/1 chain"), Buffer.from([0]), ascii(network), Buffer.from([0]), ascii(day), prevRoot]);
const auditData = (day: string, anchorSha: Bytes): Bytes =>
  Buffer.concat([ascii("scf-seal/1 audit"), Buffer.from([0]), ascii(day), anchorSha]);
const uuidBytes = (id: string): Bytes => Buffer.from(id.replaceAll("-", ""), "hex"); // RFC 9562 byte order
const snapshotData = (salt: Bytes, snapshotId: string, snapshotSha: Bytes): Bytes =>
  Buffer.concat([ascii("scf-seal/1 snapshot"), Buffer.from([0]), salt, uuidBytes(snapshotId), snapshotSha]);

function fail(msg: string): never {
  throw new Error(`seal vectors: ${msg}`);
}

// 1. Anchor: the Certificate Transparency reference vectors (RFC 6962 test data, same tree as RFC 9162).
const ctInputs = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"];
const ctRoots = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];
const ctHashes = ctInputs.map((x) => leafHash(Buffer.from(x, "hex")));
ctRoots.forEach((want, i) => {
  if (hex(mth(ctHashes.slice(0, i + 1))) !== want) fail(`CT reference root for ${i + 1} leaves differs`);
});

// 2. Trees of 2…9 leaves: leaf data = ASCII "leaf-<i>"; root and the inclusion path of every index.
const trees = [];
for (let n = 2; n <= 9; n++) {
  const hashes = Array.from({ length: n }, (_, i) => leafHash(ascii(`leaf-${i}`)));
  const root = mth(hashes);
  const proofs = hashes.map((h, i) => {
    const p = path(i, hashes);
    if (!verifyInclusion(i, n, h, p, root)) fail(`path ${i} of ${n} does not verify`);
    return { leaf_index: i, audit_path: p.map(hex) };
  });
  trees.push({ leaf_count: n, leaf_data_ascii: hashes.map((_, i) => `leaf-${i}`), leaf_hashes: hashes.map(hex), root: hex(root), proofs });
}

// 3. The three leaf encodings, byte for byte.
const sample = {
  network: "testnet",
  day: "2026-11-16",
  prev_root: fill(0x11),
  audit_anchor_sha256: fill(0x22),
  salt: fill(0x33),
  snapshot_id: "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e12",
  snapshot_sha256: fill(0x44),
};
const encodings = {
  chain: {
    network: sample.network,
    day: sample.day,
    prev_root: hex(sample.prev_root),
    data: hex(chainData(sample.network, sample.day, sample.prev_root)),
    leaf_hash: hex(leafHash(chainData(sample.network, sample.day, sample.prev_root))),
  },
  chain_first_day: {
    network: sample.network,
    day: sample.day,
    prev_root: hex(ZERO),
    data: hex(chainData(sample.network, sample.day, ZERO)),
    leaf_hash: hex(leafHash(chainData(sample.network, sample.day, ZERO))),
  },
  audit: {
    day: sample.day,
    audit_anchor_sha256: hex(sample.audit_anchor_sha256),
    data: hex(auditData(sample.day, sample.audit_anchor_sha256)),
    leaf_hash: hex(leafHash(auditData(sample.day, sample.audit_anchor_sha256))),
  },
  snapshot: {
    salt: hex(sample.salt),
    snapshot_id: sample.snapshot_id,
    snapshot_sha256: hex(sample.snapshot_sha256),
    data: hex(snapshotData(sample.salt, sample.snapshot_id, sample.snapshot_sha256)),
    leaf_hash: hex(leafHash(snapshotData(sample.salt, sample.snapshot_id, sample.snapshot_sha256))),
  },
};

// 4. A chain of three days on testnet, the third the first day of segment 2 (after a testnet reset). Snapshot inputs
//    are fixed (salt and hash from a counter); leaves 2… are sorted by leaf hash, bytewise ascending.
type SnapIn = { snapshot_id: string; salt: Bytes; snapshot_sha256: Bytes };
const snap = (n: number): SnapIn => ({
  snapshot_id: `0193b7e2-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  salt: H(ascii(`salt-${n}`)),
  snapshot_sha256: H(ascii(`snapshot-${n}`)),
});
const dayInputs = [
  { day: "2026-11-14", segment: 1, anchor: H(ascii("anchor-2026-11-14")), snapshots: [] as SnapIn[] },
  { day: "2026-11-15", segment: 1, anchor: H(ascii("anchor-2026-11-15")), snapshots: [snap(1), snap(2)] },
  { day: "2026-11-16", segment: 2, anchor: H(ascii("anchor-2026-11-16")), snapshots: [snap(3), snap(4), snap(5)] },
];
let prev = ZERO;
const chain = dayInputs.map((d) => {
  const chainLeaf = leafHash(chainData("testnet", d.day, prev));
  const auditLeaf = leafHash(auditData(d.day, d.anchor));
  const snaps = d.snapshots
    .map((s) => ({ ...s, leaf: leafHash(snapshotData(s.salt, s.snapshot_id, s.snapshot_sha256)) }))
    .sort((a, b) => Buffer.compare(a.leaf, b.leaf));
  const hashes = [chainLeaf, auditLeaf, ...snaps.map((s) => s.leaf)];
  const root = mth(hashes);
  const headPath = path(0, hashes).slice(1);
  // §m.2 step 5: the root from the chain and audit leaves and head_path alone (leaf 0's siblings are all on the right)
  let r = nodeHash(chainLeaf, auditLeaf);
  for (const p of headPath) r = nodeHash(r, p);
  if (!r.equals(root)) fail(`head path of ${d.day} does not give the root`);
  if (headPath.length !== Math.ceil(Math.log2(hashes.length)) - 1) fail(`head path length of ${d.day}`);
  const proofs = snaps.map((s, i) => {
    const p = path(i + 2, hashes);
    if (!verifyInclusion(i + 2, hashes.length, s.leaf, p, root)) fail(`snapshot proof ${i + 2} of ${d.day}`);
    return {
      snapshot_id: s.snapshot_id,
      snapshot_sha256: hex(s.snapshot_sha256),
      salt: hex(s.salt),
      leaf_index: i + 2,
      leaf_hash: hex(s.leaf),
      audit_path: p.map(hex),
    };
  });
  const out = {
    network: "testnet",
    day: d.day,
    segment: d.segment,
    prev_root: hex(prev),
    audit_anchor_sha256: hex(d.anchor),
    chain_leaf_hash: hex(chainLeaf),
    audit_leaf_hash: hex(auditLeaf),
    leaf_count: hashes.length,
    head_path: headPath.map(hex),
    root: hex(root),
    proofs,
  };
  prev = root;
  return out;
});

const doc = {
  schema: "scf-analytics/seal-vectors/1",
  contract: "docs/contracts/wire-formats.md §m.2 (scf-seal/1); RFC 9162 §2.1",
  generator: "docs/contracts/vectors/seal-vectors.mts",
  notes: [
    "All binary values are lower-case hex. H = SHA-256. leaf = H(0x00 || data), node = H(0x01 || left || right).",
    "trees: leaf data is the ASCII string in leaf_data_ascii; audit_path is bottom-up (RFC 9162 §2.1.3.1).",
    "chain: day N's prev_root is day N-1's root; the first day's is 32 zero bytes; segment 2 marks a testnet reset.",
    "head_path: siblings from the node over leaves 0 and 1 to the root; root = fold(node(chain, audit), head_path) with every sibling on the right.",
  ],
  rfc6962_reference_roots: ctRoots.map((root, i) => ({ leaf_inputs_hex: ctInputs.slice(0, i + 1), root })),
  encodings,
  trees,
  chain,
};

const file = join(import.meta.dirname, "seal-v1.json");
const text = `${JSON.stringify(doc, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(file, "utf8") !== text) {
    console.error(`${file} is not current: run node docs/contracts/vectors/seal-vectors.mts`);
    process.exit(1);
  }
  console.log("seal vectors: current, all checks pass");
} else {
  writeFileSync(file, text);
  console.log(`wrote ${file}`);
}
