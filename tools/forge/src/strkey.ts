// SPDX-License-Identifier: Apache-2.0
// Stellar StrKey encoding (SEP-23): version byte ‖ 32-byte payload ‖ CRC16-XModem (little-endian), RFC 4648 base32
// without padding. Used only to make throwaway, random, never-funded keys for the redaction demonstration (step g):
// an account id (G…) and a secret seed (S…) that no one holds.

import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const VERSION = { account: 6 << 3, seed: 18 << 3 } as const;

export function crc16xmodem(b: Uint8Array): number {
  let crc = 0;
  for (const byte of b) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function base32(b: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function encode(version: number, payload: Uint8Array): string {
  if (payload.length !== 32) throw new Error("payload must be 32 bytes");
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const crc = crc16xmodem(body);
  return base32(Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]));
}

/** A random account id and secret seed (unrelated to each other; neither is a usable key pair). */
export function throwawayKeys(): { account: string; seed: string } {
  return {
    account: encode(VERSION.account, randomBytes(32)),
    seed: encode(VERSION.seed, randomBytes(32)),
  };
}
