// SPDX-License-Identifier: Apache-2.0
// Stellar keys for the demo: StrKey encoding (SEP-23: version byte, payload, CRC16-XModem little-endian, base32) and
// Ed25519 keys derived deterministically from the seed phrase. The keys are demo keys: they exist only to sign the
// SEP-53 sign-in message of a local stack and must never be funded or used on a public network.

import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import { derive } from "./random.ts";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const VERSION = { account: 6 << 3, contract: 2 << 3 } as const;

export function crc16xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function encodeStrKey(version: number, payload: Uint8Array): string {
  if (payload.length !== 32) throw new Error("StrKey payload must be 32 bytes");
  const body = Buffer.concat([Buffer.from([version]), Buffer.from(payload)]);
  const c = Buffer.alloc(2);
  c.writeUInt16LE(crc16xmodem(body));
  return base32(Buffer.concat([body, c]));
}

/** Decodes a 56-character StrKey; throws on a bad alphabet, length, version or checksum. */
export function decodeStrKey(s: string): { version: number; payload: Buffer } {
  if (!/^[A-Z2-7]{56}$/.test(s)) throw new Error("not a StrKey");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const raw = Buffer.from(out);
  if (raw.length !== 35) throw new Error("bad StrKey length");
  if (crc16xmodem(raw.subarray(0, 33)) !== raw.readUInt16LE(33)) throw new Error("bad checksum");
  return { version: raw[0] as number, payload: raw.subarray(1, 33) };
}

/** A synthetic contract id (`C…`) with a valid checksum, derived from the phrase; it exists on no network. */
export function demoContractId(phrase: string, label: string): string {
  return encodeStrKey(VERSION.contract, derive(phrase, `contract:${label}`));
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export interface DemoKey {
  account: string;
  privateKey: KeyObject;
  /** SEP-53: base64 Ed25519 signature over SHA-256("Stellar Signed Message:\n" ‖ message). */
  signMessage(message: string): string;
}

export function demoKey(phrase: string, label: string): DemoKey {
  const seed = derive(phrase, `key:${label}`);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  const account = encodeStrKey(VERSION.account, Buffer.from(jwk.x, "base64url"));
  return {
    account,
    privateKey,
    signMessage(message: string): string {
      const digest = createHash("sha256")
        .update(`Stellar Signed Message:\n${message}`, "utf8")
        .digest();
      return sign(null, digest, privateKey).toString("base64");
    },
  };
}
