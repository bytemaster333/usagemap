// SPDX-License-Identifier: Apache-2.0
// StrKey encoding (SEP-23) and a test wallet that signs SEP-53 messages with a real Ed25519 key — used to sign in to
// the control plane exactly like a tenant user would, and to mint well-formed canary seeds/addresses.

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const VERSION = { G: 6 << 3, S: 18 << 3, C: 2 << 3, M: 12 << 3 } as const;

function crc16(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function base32(all: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of all) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function strKey(version: number, payload: Buffer): string {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const c = Buffer.alloc(2);
  c.writeUInt16LE(crc16(body));
  return base32(Buffer.concat([body, c]));
}

/** A random, checksum-valid StrKey of the given kind (canary values: never a real funded key). */
export function randomStrKey(kind: keyof typeof VERSION): string {
  return strKey(VERSION[kind], randomBytes(32));
}

export class TestWallet {
  readonly account: string;
  readonly #key: KeyObject;
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    this.account = strKey(VERSION.G, Buffer.from(jwk.x, "base64url"));
    this.#key = privateKey;
  }
  /** SEP-53: Ed25519 over SHA-256("Stellar Signed Message:\n" ‖ message), base64. */
  signMessage(message: string): string {
    const digest = createHash("sha256")
      .update(`Stellar Signed Message:\n${message}`, "utf8")
      .digest();
    return sign(null, digest, this.#key).toString("base64");
  }
}
