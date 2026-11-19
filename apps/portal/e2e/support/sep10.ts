// SPDX-License-Identifier: Apache-2.0
// Minimal SEP-10 for the portal's browser tests, in real Stellar XDR so a real wallet's signed envelope would also be
// accepted: the mock control plane builds a server-signed challenge (TransactionEnvelope v1: source = server key,
// seqNum 0, time bounds, two ManageData operations "<home> auth" (source = client) and "web_auth_domain"), and the test
// wallet signs it like any Stellar wallet: Ed25519 over SHA-256(SHA-256(passphrase) ‖ ENVELOPE_TYPE_TX ‖ tx), appended
// as a DecoratedSignature (hint = last 4 bytes of the public key). Only the shapes this file writes are parsed.

import { createHash, type KeyObject, randomBytes, sign, verify } from "node:crypto";

const ENVELOPE_TYPE_TX = 2;
const MANAGE_DATA = 10;

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const varOpaque = (b: Buffer) => Buffer.concat([u32(b.length), pad(b)]);
const muxed = (pub: Buffer) => Buffer.concat([u32(0), pub]); // KEY_TYPE_ED25519

function manageData(source: Buffer, name: string, value: Buffer): Buffer {
  return Buffer.concat([
    u32(1),
    muxed(source), // optional source account: present
    u32(MANAGE_DATA),
    varOpaque(Buffer.from(name, "ascii")),
    u32(1),
    varOpaque(value), // optional DataValue: present
  ]);
}

/** The signature payload of a transaction (TransactionSignaturePayload, ENVELOPE_TYPE_TX). */
export function txHash(tx: Buffer, passphrase: string): Buffer {
  const networkId = createHash("sha256").update(passphrase, "utf8").digest();
  return createHash("sha256")
    .update(Buffer.concat([networkId, u32(ENVELOPE_TYPE_TX), tx]))
    .digest();
}

function decorated(pub: Buffer, sig: Buffer): Buffer {
  return Buffer.concat([pub.subarray(28, 32), varOpaque(sig)]);
}

/** A server-signed SEP-10 challenge for `client`, valid `ttlS` seconds; returns the envelope (base64) and tx bytes. */
export function buildChallenge(opts: {
  serverPub: Buffer;
  serverKey: KeyObject;
  clientPub: Buffer;
  homeDomain: string;
  passphrase: string;
  nowS: number;
  ttlS: number;
}): { xdr: string; tx: Buffer } {
  const nonce = Buffer.from(randomBytes(48).toString("base64"), "ascii"); // 64 printable bytes
  const tx = Buffer.concat([
    muxed(opts.serverPub),
    u32(200), // fee
    u64(0n), // seqNum 0
    u32(1), // PRECOND_TIME
    u64(BigInt(opts.nowS)),
    u64(BigInt(opts.nowS + opts.ttlS)),
    u32(0), // MEMO_NONE
    u32(2),
    manageData(opts.clientPub, `${opts.homeDomain} auth`, nonce),
    manageData(opts.serverPub, "web_auth_domain", Buffer.from(opts.homeDomain, "ascii")),
    u32(0), // ext
  ]);
  const sig = sign(null, txHash(tx, opts.passphrase), opts.serverKey);
  const env = Buffer.concat([u32(ENVELOPE_TYPE_TX), tx, u32(1), decorated(opts.serverPub, sig)]);
  return { xdr: env.toString("base64"), tx };
}

const SIG_LEN = 4 + 4 + 64; // hint + length + signature

/** Splits an envelope this file's shape produced: (tx bytes, signatures). Throws on anything else. */
export function parseEnvelope(xdr: string, txLength: number): { tx: Buffer; sigs: Buffer[] } {
  const b = Buffer.from(xdr, "base64");
  if (b.readUInt32BE(0) !== ENVELOPE_TYPE_TX) throw new Error("not a v1 transaction envelope");
  const tx = b.subarray(4, 4 + txLength);
  const n = b.readUInt32BE(4 + txLength);
  if (n < 1 || n > 20 || b.length !== 4 + txLength + 4 + n * SIG_LEN)
    throw new Error("malformed signatures");
  const sigs: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const off = 4 + txLength + 4 + i * SIG_LEN;
    if (b.readUInt32BE(off + 4) !== 64) throw new Error("malformed signature");
    sigs.push(b.subarray(off + 8, off + 8 + 64));
  }
  return { tx, sigs };
}

/** Whether the envelope carries the unchanged challenge transaction and a valid signature of `pub`. */
export function signedBy(
  xdr: string,
  challengeTx: Buffer,
  pub: KeyObject,
  passphrase: string,
): boolean {
  try {
    const { tx, sigs } = parseEnvelope(xdr, challengeTx.length);
    if (!tx.equals(challengeTx)) return false;
    const h = txHash(tx, passphrase);
    return sigs.some((s) => verify(null, h, pub, s));
  } catch {
    return false;
  }
}

/**
 * What a wallet does with a challenge: append its signature. The transaction length is read from the envelope's
 * trailing signature block (the server's one signature), so the caller needs no XDR parser.
 */
export function signChallenge(
  xdr: string,
  key: KeyObject,
  pub: Buffer,
  passphrase: string,
): string {
  const b = Buffer.from(xdr, "base64");
  const count = b.readUInt32BE(b.length - 4 - SIG_LEN);
  if (count !== 1) throw new Error("expected a challenge with exactly the server's signature");
  const tx = b.subarray(4, b.length - 4 - SIG_LEN);
  const sig = sign(null, txHash(tx, passphrase), key);
  return Buffer.concat([
    b.subarray(0, 4 + tx.length),
    u32(2),
    b.subarray(b.length - SIG_LEN),
    decorated(pub, sig),
  ]).toString("base64");
}
