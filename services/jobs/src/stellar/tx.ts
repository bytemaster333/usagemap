// SPDX-License-Identifier: Apache-2.0
// A minimal Stellar transaction builder for the daily seal (wire-formats §m.2; C-136, C-137): one `BUMP_SEQUENCE`
// operation with `bumpTo` = 0 (a no-op: no ledger entry, no reserve; stellar-core accepts any bumpTo >= 0 and
// "succeeds silently if bumpTo <= current"), `memo` = MEMO_HASH(root), base fee, 5-minute time bounds, from the
// platform sealing account, signed with Ed25519 (node:crypto). XDR per Stellar-transaction.x (protocol 23):
// TransactionEnvelope{ENVELOPE_TYPE_TX=2, TransactionV1Envelope{Transaction, DecoratedSignature<20>}}; the
// transaction hash (what Horizon calls `hash`) and the signed payload are sha256(networkId ‖ ENVELOPE_TYPE_TX ‖ Tx).
//
// The per-day `manage_data` anchor of §m.1 (`scf-audit-<YYYYMMDD>`) is superseded by the seal (C-136) and no longer
// written; entries already on the ledger stay verifiable by reading the anchoring account's data entries or the
// transactions that set them (decodeManageDataAnchor below is kept for that check).

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { strkeyDecode, strkeyEncode, VERSION } from "./xdr.ts";

const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const i64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};
const opaqueVar = (b: Buffer) =>
  Buffer.concat([u32(b.length), b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

export const ENVELOPE_TYPE_TX = 2;
export const OP_BUMP_SEQUENCE = 11;
export const MEMO_HASH = 3;
export const PRECOND_TIME = 1;

export interface Keypair {
  publicKey: Buffer;
  account: string;
  sign(msg: Buffer): Buffer;
}

/** Ed25519 key pair from a Stellar secret seed (S…). The seed never leaves this object. */
export function keypairFromSeed(seed: string): Keypair {
  const raw = strkeyDecode(seed, VERSION.seed);
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(spki.subarray(spki.length - 32));
  return {
    publicKey,
    account: strkeyEncode(publicKey, VERSION.account),
    sign: (m) => sign(null, m, key),
  };
}

/** sha256 of the network passphrase (the network id every signature commits to). */
export function networkIdOf(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase, "utf8").digest();
}

/** Transaction XDR of a seal: BUMP_SEQUENCE(bumpTo 0), MEMO_HASH(root), PRECOND_TIME(minTime, maxTime). */
export function sealTransaction(o: {
  source: Buffer;
  sequence: bigint;
  fee: number;
  memoHash: Buffer;
  minTime: bigint;
  maxTime: bigint;
}): Buffer {
  if (o.source.length !== 32 || o.memoHash.length !== 32)
    throw new Error("32-byte source and memo");
  if (!Number.isInteger(o.fee) || o.fee < 100 || o.fee > 0xffffffff) throw new Error("fee");
  return Buffer.concat([
    i32(0), // MuxedAccount KEY_TYPE_ED25519
    o.source,
    u32(o.fee),
    i64(o.sequence),
    i32(PRECOND_TIME),
    u64(o.minTime),
    u64(o.maxTime),
    i32(MEMO_HASH),
    o.memoHash,
    u32(1), // one operation
    i32(0), // no operation source
    i32(OP_BUMP_SEQUENCE),
    i64(0n), // bumpTo = 0: no-op
    i32(0), // ext v0
  ]);
}

/** Horizon's transaction hash: sha256(networkId ‖ ENVELOPE_TYPE_TX ‖ tx). */
export function transactionHash(networkId: Buffer, tx: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.concat([networkId, i32(ENVELOPE_TYPE_TX), tx]))
    .digest();
}

/** Base64 TransactionEnvelope (v1) with one decorated signature. */
export function signEnvelope(
  networkId: Buffer,
  tx: Buffer,
  kp: Pick<Keypair, "publicKey" | "sign">,
): string {
  const sig = kp.sign(transactionHash(networkId, tx));
  return Buffer.concat([
    i32(ENVELOPE_TYPE_TX),
    tx,
    u32(1),
    kp.publicKey.subarray(28, 32),
    opaqueVar(sig),
  ]).toString("base64");
}

export interface DecodedSeal {
  source: string;
  fee: number;
  sequence: bigint;
  minTime: bigint;
  maxTime: bigint;
  memoHash: Buffer;
  bumpTo: bigint;
  tx: Buffer;
  hint: Buffer;
  signature: Buffer;
}

/** Strict decoder of exactly the envelope signEnvelope(sealTransaction(…)) produces (used by tests and fakes). */
export function decodeSealEnvelope(b64: string): DecodedSeal {
  const env = Buffer.from(b64, "base64");
  const fail = (): never => {
    throw new Error("not a seal envelope");
  };
  const txLen = 4 + 32 + 4 + 8 + 4 + 16 + 4 + 32 + 4 + 4 + 4 + 8 + 4;
  if (env.length !== 4 + txLen + 4 + 4 + 4 + 64) fail();
  if (env.readInt32BE(0) !== ENVELOPE_TYPE_TX) fail();
  const tx = env.subarray(4, 4 + txLen);
  let o = 0;
  const rd32 = () => {
    const v = tx.readInt32BE(o);
    o += 4;
    return v;
  };
  if (rd32() !== 0) fail();
  const src = tx.subarray(o, o + 32);
  o += 32;
  const fee = tx.readUInt32BE(o);
  o += 4;
  const sequence = tx.readBigInt64BE(o);
  o += 8;
  if (rd32() !== PRECOND_TIME) fail();
  const minTime = tx.readBigUInt64BE(o);
  const maxTime = tx.readBigUInt64BE(o + 8);
  o += 16;
  if (rd32() !== MEMO_HASH) fail();
  const memoHash = Buffer.from(tx.subarray(o, o + 32));
  o += 32;
  if (rd32() !== 1 || rd32() !== 0 || rd32() !== OP_BUMP_SEQUENCE) fail();
  const bumpTo = tx.readBigInt64BE(o);
  o += 8;
  if (rd32() !== 0) fail();
  const rest = env.subarray(4 + txLen);
  if (rest.readUInt32BE(0) !== 1 || rest.readUInt32BE(8) !== 64) fail();
  return {
    source: strkeyEncode(src, VERSION.account),
    fee,
    sequence,
    minTime,
    maxTime,
    memoHash,
    bumpTo,
    tx: Buffer.from(tx),
    hint: Buffer.from(rest.subarray(4, 8)),
    signature: Buffer.from(rest.subarray(12, 76)),
  };
}

/**
 * Superseded §m.1 anchors stay verifiable: the data-entry name of a day and the check of a value read from the
 * anchoring account (Horizon `GET /accounts/{G}` → `data[name]`, base64) against the anchor document's sha256.
 */
export function manageDataAnchorName(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date");
  return `scf-audit-${date.replaceAll("-", "")}`;
}

export function manageDataAnchorMatches(dataValueB64: string, anchorSha256Hex: string): boolean {
  return Buffer.from(dataValueB64, "base64").equals(Buffer.from(anchorSha256Hex, "hex"));
}

/** Decodes a G… account to its 32-byte key (throws on anything else). */
export function accountKey(account: string): Buffer {
  return strkeyDecode(account, VERSION.account);
}
