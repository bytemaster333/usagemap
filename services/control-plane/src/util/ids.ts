// SPDX-License-Identifier: Apache-2.0
// Identifier and secret generation (data-model §1, wire-formats §k). CSPRNG only.

import { createHash, randomBytes, randomInt } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** UUIDv7 (RFC 9562): 48-bit Unix ms timestamp, version 7, variant 10, random rest. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = ((b[6] as number) & 0x0f) | 0x70;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Uniformly random base62 string (rejection-free via randomInt). */
export function randomBase62(length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += BASE62[randomInt(62)];
  return s;
}

/** Public site key: 22 base62 characters (wire-formats §k). */
export function newSiteKey(): string {
  return randomBase62(22);
}

/** Invitation code `scfi_` + 22 base62 (≈131 bits), stored as SHA-256 (wire-formats §k). */
export function newInvitationCode(): string {
  return `scfi_${randomBase62(22)}`;
}

/** 256-bit opaque token, base64url without padding (43 characters): session cookie, OAuth binder, etc. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(data: string | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deterministic UUID-shaped id (version 8) derived from a name: used for idempotency keys of record parts. */
export function derivedUuid(...parts: string[]): string {
  const b = sha256(parts.join("\u0000")).subarray(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x80;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
