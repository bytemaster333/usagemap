// SPDX-License-Identifier: Apache-2.0
// "Verify this number" (src/components/VerifyNumberCheck.tsx): a complete, honest world — a signed snapshot in the
// project's list, sealed in a day's RFC 9162 tree whose audit leaf is a real audit-anchor document, confirmed on the
// ledger — and every tamper case: a changed figure, a list naming another hash, a forged inclusion path, a broken
// chain, a rewritten operator actions log, a reset testnet anchored by a later day, no snapshot, no seal yet.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AnchorDocument,
  checkOperatorLog,
  figureOf,
  type ListEntryLite,
  latestValid,
  OPERATOR_CHAIN,
  type ServedProof,
  type VerifySources,
  verifyNumber,
} from "../../src/components/VerifyNumberCheck.tsx";
import { canonicalize } from "../../src/lib/jcs.ts";
import type { SealDayView } from "../../src/lib/seal.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
const H = (...p: Buffer[]) => sha(Buffer.concat(p));
const leaf = (d: Buffer) => H(Buffer.from([0]), d);
const node = (l: Buffer, r: Buffer) => H(Buffer.from([1]), l, r);
const ascii = (s: string) => Buffer.from(s, "ascii");
const Z = Buffer.from([0]);
const split = (n: number) => {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
};
const mth = (h: Buffer[]): Buffer =>
  h.length === 1
    ? (h[0] as Buffer)
    : node(mth(h.slice(0, split(h.length))), mth(h.slice(split(h.length))));
const path = (m: number, h: Buffer[]): Buffer[] => {
  if (h.length <= 1) return [];
  const k = split(h.length);
  return m < k
    ? [...path(m, h.slice(0, k)), mth(h.slice(k))]
    : [...path(m - k, h.slice(k)), mth(h.slice(0, k))];
};
const hex = (b: Buffer) => b.toString("hex");

const fmt = { day: (iso: string) => iso.slice(0, 10), int: (n: number) => String(n) };
const SNAP_ID = "0193b7e2-0000-7000-8000-000000000042";
const ACCOUNT = `G${"A".repeat(55)}`;
const NETWORK = {
  name: "testnet" as const,
  passphrase: "Test SDF Network ; September 2015",
  durable: false,
  notice:
    "Stellar testnet is reset several times a year; this seal is a demonstration, not durable evidence.",
  lookup: {
    horizon: "https://horizon-testnet.stellar.org",
    explorer: "https://stellar.expert/explorer/testnet/tx/{tx_hash}",
    ledger_files: null,
  },
};

function anchorDoc(day: string, opSeq = 41, salt = ""): AnchorDocument {
  const body = {
    schema: "scf-analytics/audit-anchor/1",
    date: day,
    generated_at: `${day}T23:59:59Z`,
    chains: [{ chain_id: OPERATOR_CHAIN, seq: opSeq, row_hash: hex(sha(`op-${day}${salt}`)) }],
  };
  return { ...body, sha256: hex(sha(canonicalize(body))) };
}

interface World {
  sources: VerifySources;
  list: ListEntryLite[];
  doc: { snapshot: Record<string, unknown>; signature: { alg: string; kid: string; sig: string } };
  proof: ServedProof;
  days: SealDayView[];
  anchors: Map<string, AnchorDocument>;
}

/** Day 1 (the seal of the snapshot) and day 2, both confirmed unless `reset`. */
function world(o: { reset?: boolean; sealEnabled?: boolean } = {}): World {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as { x: string }),
    kty: "OKP",
    crv: "Ed25519",
    kid: "snap-1",
  };
  const snapshot = {
    schema: "scf-analytics/traction-snapshot/2",
    snapshot_id: SNAP_ID,
    issued_at: "2026-11-17T09:00:00Z",
    web: { verified: { pageviews: 21_000, visitors_sum: 9118 } },
    api: { requests: 50_000 },
    seal: { enabled: o.sealEnabled ?? true, network: "testnet", proof_url: null },
  };
  const sig = sign(null, Buffer.from(canonicalize(snapshot)), privateKey).toString("base64url");
  const doc = { snapshot, signature: { alg: "Ed25519", kid: "snap-1", sig } };
  const snapSha = sha(canonicalize(snapshot));
  const list: ListEntryLite[] = [
    {
      snapshot_id: SNAP_ID,
      seq: 2,
      sha256: hex(snapSha),
      status: "valid",
      signed_at: "2026-11-17T09:00:05Z",
      period: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
    },
    {
      snapshot_id: "0193b7e2-0000-7000-8000-000000000001",
      seq: 1,
      sha256: "00".repeat(32),
      status: "valid",
      signed_at: "2026-10-01T09:00:00Z",
      period: { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" },
    },
  ];
  const anchors = new Map<string, AnchorDocument>();
  const days: SealDayView[] = [];
  let prev: Buffer = Buffer.alloc(32);
  let proof: ServedProof | null = null;
  ["2026-11-17", "2026-11-18"].forEach((day, i) => {
    const a = anchorDoc(day);
    anchors.set(day, a);
    const chainL = leaf(
      Buffer.concat([ascii("scf-seal/1 chain"), Z, ascii("testnet"), Z, ascii(day), prev]),
    );
    const auditL = leaf(
      Buffer.concat([ascii("scf-seal/1 audit"), Z, ascii(day), Buffer.from(a.sha256, "hex")]),
    );
    const salt = sha("salt");
    const snapL = leaf(
      Buffer.concat([
        ascii("scf-seal/1 snapshot"),
        Z,
        salt,
        Buffer.from(SNAP_ID.replaceAll("-", ""), "hex"),
        snapSha,
      ]),
    );
    const hashes = i === 0 ? [chainL, auditL, snapL] : [chainL, auditL];
    const root = mth(hashes);
    const status = o.reset && i === 0 ? ("network_reset" as const) : ("confirmed" as const);
    const segment = o.reset && i === 1 ? 2 : 1;
    const tx = hex(sha(`tx-${day}`));
    const ledger = 5_808_323 + i * 17_280;
    days.push({
      day,
      network: { name: "testnet" },
      segment,
      prev_root: hex(prev),
      root: hex(root),
      audit_anchor_sha256: a.sha256,
      leaf_count: hashes.length,
      head_path: path(0, hashes).slice(1).map(hex),
      status,
      tx_hash: tx,
      ledger,
      source_account: ACCOUNT,
    });
    if (i === 0)
      proof = {
        network: NETWORK,
        snapshot_id: SNAP_ID,
        snapshot_sha256: hex(snapSha),
        day,
        segment,
        leaf_index: 2,
        leaf_count: 3,
        salt: hex(salt),
        leaf_hash: hex(snapL),
        audit_path: path(2, hashes).map(hex),
        head_path: path(0, hashes).slice(1).map(hex),
        root: hex(root),
        prev_root: hex(prev),
        audit_anchor_sha256: a.sha256,
        status,
        source_account: ACCOUNT,
        tx_hash: tx,
        ledger,
        explorer_url: `https://stellar.expert/explorer/testnet/tx/${tx}`,
      };
    prev = root;
  });
  const w: World = {
    sources: null as unknown as VerifySources,
    list,
    doc,
    proof: proof as unknown as ServedProof,
    days,
    anchors,
  };
  w.sources = {
    list: async () => w.list,
    snapshot: async () => w.doc as never,
    keys: async () => [jwk as never],
    proofs: async () => (o.sealEnabled === false ? null : [w.proof]),
    days: async (start) => w.days.filter((d) => d.day >= start),
    anchor: async (day) => w.anchors.get(day) ?? null,
  };
  return w;
}

describe("verify this number", () => {
  it("passes every step and says so in plain words", async () => {
    const r = await verifyNumber(world().sources, "stellar-docs", "visitors", fmt);
    expect(Object.values(r.steps).map((s) => s.state)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(r.snapshot).toMatchObject({ seq: 2, figure: 9118, kid: "snap-1" });
    expect(r.verdict).toEqual({
      kind: "sealed",
      text: "This number is exactly what UsageMap published on 2026-11-17 and sealed on Stellar testnet in ledger 5808323.",
    });
    expect(r.steps.operatorLog.text).toContain("Operator actions log: sealed");
    expect(r.steps.operatorLog.text).toContain("entry 41");
    expect(r.seal?.anchor?.explorerUrl).toMatch(
      /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\//,
    );
    expect(r.verdict.text).not.toMatch(/genuine|endorse|SCF|SDF/);
  });

  it("tamper: a changed figure breaks the signature", async () => {
    const w = world();
    (w.doc.snapshot.web as { verified: { visitors_sum: number } }).verified.visitors_sum = 91_180;
    const r = await verifyNumber(w.sources, "s", "visitors", fmt);
    expect(r.steps.signature.state).toBe("fail");
    expect(r.verdict.kind).toBe("failed");
  });

  it("tamper: the list names another hash", async () => {
    const w = world();
    (w.list[0] as ListEntryLite).sha256 = "ab".repeat(32);
    const r = await verifyNumber(w.sources, "s", "visitors", fmt);
    expect(r.steps.listed.state).toBe("fail");
    expect(r.verdict.kind).toBe("failed");
  });

  it("tamper: a forged inclusion path or root", async () => {
    const w = world();
    w.proof = { ...w.proof, audit_path: ["cd".repeat(32), ...w.proof.audit_path.slice(1)] };
    const r = await verifyNumber(w.sources, "s", "visitors", fmt);
    expect(r.steps.inclusion.state).toBe("fail");
    expect(r.verdict.kind).toBe("failed");
  });

  it("tamper: a broken chain of seal days", async () => {
    const w = world();
    (w.days[1] as SealDayView).prev_root = "ef".repeat(32);
    const r = await verifyNumber(w.sources, "s", "visitors", fmt);
    expect(r.steps.chain.state).toBe("fail");
    expect(r.verdict.kind).toBe("failed");
  });

  it("tamper: a rewritten operator actions log (self-consistent document, not the sealed one)", async () => {
    const w = world();
    w.anchors.set("2026-11-17", anchorDoc("2026-11-17", 41, "rewritten"));
    const r = await verifyNumber(w.sources, "s", "visitors", fmt);
    expect(r.steps.operatorLog.state).toBe("fail");
    expect(r.steps.operatorLog.text).toContain("changed after sealing");
    expect(r.verdict.kind).toBe("failed");
  });

  it("an unpublished operator log is pending, not a failure", async () => {
    const w = world();
    w.anchors.clear();
    const r = await verifyNumber(w.sources, "s", "visitors", fmt);
    expect(r.steps.operatorLog.state).toBe("pending");
    expect(r.verdict.kind).toBe("sealed");
  });

  it("a reset testnet day is anchored by the next confirmed day", async () => {
    const r = await verifyNumber(world({ reset: true }).sources, "s", "api", fmt);
    expect(r.snapshot?.figure).toBe(50_000);
    expect(r.verdict.kind).toBe("sealed");
    expect(r.verdict.text).toContain(
      "anchored through the chain by the transaction of 2026-11-18 in ledger 5825603",
    );
  });

  it("no seal opt-in, and no snapshot at all", async () => {
    const r = await verifyNumber(world({ sealEnabled: false }).sources, "s", "visitors", fmt);
    expect(r.verdict).toMatchObject({ kind: "signed_only" });
    expect(r.verdict.text).toContain("has not opted in");
    const w = world();
    w.list = [];
    expect((await verifyNumber(w.sources, "s", "visitors", fmt)).verdict.kind).toBe("no_snapshot");
  });

  it("helpers: latest valid snapshot, figures, operator log of another day", async () => {
    expect(
      latestValid([
        {
          snapshot_id: "a",
          seq: 3,
          sha256: "",
          status: "revoked",
          signed_at: "",
          period: { start: "", end: "" },
        },
        {
          snapshot_id: "b",
          seq: 2,
          sha256: "",
          status: "valid",
          signed_at: "",
          period: { start: "", end: "" },
        },
      ])?.snapshot_id,
    ).toBe("b");
    expect(figureOf({ web: { verified: { pageviews: 5 } } }, "pageviews")).toBe(5);
    expect(figureOf({ api: null }, "api")).toBeNull();
    const a = anchorDoc("2026-11-17");
    expect((await checkOperatorLog(a, "2026-11-18", a.sha256)).state).toBe("fail");
  });
});
