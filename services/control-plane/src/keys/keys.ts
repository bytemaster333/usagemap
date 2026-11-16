// SPDX-License-Identifier: Apache-2.0
// Key and token formats (wire-formats §k, ADR-0016, C-05, C-81):
//
//   key    = "scfa_" kind "_" id "_" secret crc
//   id     = 12 base62 (public lookup id), secret = 27 base62 (160 CSPRNG bits, zero-padded),
//   crc    = 6 base62 = CRC-32 (IEEE) of the ASCII "scfa_" kind "_" id "_" secret, zero-padded.
//
// Stored: id, last4 (last 4 characters of `secret`), HMAC-SHA-256(pepper_<kind>[pepper_version], secret) and the
// pepper version. The full key is shown once. The CRC is checked offline before any lookup.
//
// Kinds: `ing` ingest tokens, `op` SCF-operator API keys, `pub` share keys, `reg` footprint registration keys (one
// tenant, scope `footprint:register` only: they add `claimed` contracts and nothing else; migration 0081).

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { crc32 } from "node:zlib";
import { randomBase62 } from "../util/ids.ts";

export type KeyKind = "op" | "ing" | "pub" | "reg";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const KEY_RE = /^scfa_(op|ing|pub|reg)_([0-9A-Za-z]{12})_([0-9A-Za-z]{27})([0-9A-Za-z]{6})$/;

/** Pepper set of one kind: versions → key bytes; `current` hashes new keys (C-81). */
export interface PepperSet {
  peppers: Map<number, Buffer>;
  current: number;
}

export interface Peppers {
  ing: PepperSet | undefined;
  op: PepperSet | undefined;
  pub: PepperSet | undefined;
  /** Footprint registration keys; when unset, derived from `pub` (see footprintPepperSet). */
  reg?: PepperSet | undefined;
}

/**
 * The pepper set of footprint registration keys (`scfa_reg_…`): SCF_PEPPER_REG when configured, otherwise one pepper
 * per share-key pepper version, derived with HKDF-SHA-256 (info `scfa_reg/1`). The derived set is independent of the
 * share-key hashes (a `pub` hash never verifies a `reg` secret) and needs no new secret on existing deployments;
 * rotating the share-key pepper rotates it too (the old versions stay as long as `pub` keeps them).
 */
export function footprintPepperSet(p: Peppers): PepperSet | undefined {
  if (p.reg) return p.reg;
  if (!p.pub) return undefined;
  const peppers = new Map<number, Buffer>();
  for (const [v, key] of p.pub.peppers)
    peppers.set(v, Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "scfa_reg/1", 32)));
  return { peppers, current: p.pub.current };
}

function toBase62(n: bigint, width: number): string {
  let s = "";
  let v = n;
  while (v > 0n) {
    s = BASE62[Number(v % 62n)] + s;
    v /= 62n;
  }
  if (s.length > width) throw new Error("value too large for width");
  return s.padStart(width, "0");
}

/** 160-bit secret as 27 base62 characters (base62 of a 20-byte random integer, zero-padded). */
export function newSecret(): string {
  return toBase62(BigInt(`0x${randomBytes(20).toString("hex")}`), 27);
}

export function checksum(kind: KeyKind, id: string, secret: string): string {
  return toBase62(BigInt(crc32(Buffer.from(`scfa_${kind}_${id}_${secret}`, "ascii")) >>> 0), 6);
}

export function hashSecret(pepper: Buffer, secret: string): Buffer {
  return createHmac("sha256", pepper).update(secret, "ascii").digest();
}

export interface NewKey {
  id: string;
  secret: string;
  key: string;
  last4: string;
  display: string;
  hash: Buffer;
  pepperVersion: number;
}

/** A fresh key of `kind`, hashed with the current pepper of that kind. */
export function mintKey(kind: KeyKind, set: PepperSet): NewKey {
  const id = randomBase62(12);
  const secret = newSecret();
  const pepper = set.peppers.get(set.current);
  if (!pepper) throw new Error(`pepper_${kind} version ${set.current} is not configured`);
  const last4 = secret.slice(-4);
  return {
    id,
    secret,
    key: `scfa_${kind}_${id}_${secret}${checksum(kind, id, secret)}`,
    last4,
    display: displayOf(kind, id, last4),
    hash: hashSecret(pepper, secret),
    pepperVersion: set.current,
  };
}

export function displayOf(kind: KeyKind, id: string, last4: string): string {
  return `scfa_${kind}_${id}_…${last4}`;
}

export interface ParsedKey {
  kind: KeyKind;
  id: string;
  secret: string;
}

export type ParseResult =
  | { ok: true; key: ParsedKey }
  | { ok: false; reason: "format" | "checksum" };

/** Grammar and CRC, offline (wire-formats §k). */
export function parseKey(raw: string, kind?: KeyKind): ParseResult {
  const m = KEY_RE.exec(raw);
  if (!m || (kind && m[1] !== kind)) return { ok: false, reason: "format" };
  const k = m[1] as KeyKind;
  const id = m[2] as string;
  const secret = m[3] as string;
  if (checksum(k, id, secret) !== m[4]) return { ok: false, reason: "checksum" };
  return { ok: true, key: { kind: k, id, secret } };
}

/** Constant-time comparison of a presented secret with the stored hash under the row's pepper version. */
export function verifySecret(
  set: PepperSet | undefined,
  pepperVersion: number,
  secret: string,
  stored: Buffer,
): boolean {
  const pepper = set?.peppers.get(pepperVersion);
  if (!pepper) return false;
  const h = hashSecret(pepper, secret);
  return h.length === stored.length && timingSafeEqual(h, stored);
}

/** `1:<base64>,2:<base64>` → pepper versions (each ≥ 32 bytes); `current` = the given or highest version. */
export function parsePepperSet(
  name: string,
  v: string | undefined,
  versionVar: string | undefined,
): PepperSet | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const peppers = new Map<number, Buffer>();
  for (const part of v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^([1-9][0-9]{0,4}):([A-Za-z0-9+/_=-]+)$/.exec(part);
    const key = m ? Buffer.from(m[2] as string, "base64") : undefined;
    if (!m || !key || key.length < 32 || Number(m[1]) > 32767)
      throw new Error(`${name} must be \`<version>:<base64 of ≥ 32 bytes>\`, comma-separated`);
    peppers.set(Number(m[1]), key);
  }
  const current = versionVar === undefined ? Math.max(...peppers.keys()) : Number(versionVar);
  if (!peppers.has(current)) throw new Error(`${name}_VERSION names no version in ${name}`);
  return { peppers, current };
}
