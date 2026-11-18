// SPDX-License-Identifier: Apache-2.0
// Strict SEP-23 v1.4.0 StrKey decoding: a port of packages/pathnorm/strkey.go
// (decodeInto). Only the type is needed here: the route placeholder depends on
// it, the payload is never kept.

/** The ten StrKey types of SEP-23 v1.4.0, by the first character of their encoding. */
export type StrKeyType = "G" | "S" | "M" | "T" | "X" | "P" | "C" | "L" | "B" | "W";

const VERSION_BYTES: ReadonlyArray<readonly [StrKeyType, number]> = [
  ["G", 6 << 3],
  ["S", 18 << 3],
  ["M", 12 << 3],
  ["T", 19 << 3],
  ["X", 23 << 3],
  ["P", 15 << 3],
  ["C", 2 << 3],
  ["L", 11 << 3],
  ["B", 1 << 3],
  ["W", 22 << 3],
];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Value of an upper-case RFC 4648 base32 character (by char code), or -1. */
export const B32 = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function b32Value(code: number): number {
  return code < 128 ? (B32[code] ?? -1) : -1;
}

/** CRC-16/XMODEM (polynomial 0x1021, init 0), as used by SEP-23. */
export function crc16XModem(data: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] ?? 0) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Strictly decode an upper-case StrKey and return its type, or undefined. Enforces
 * every strict-validity rule of SEP-23: length not ≡ 1, 3 or 6 (mod 8), zero unused
 * trailing bits, the CRC16-XModem checksum (little-endian), a known version byte,
 * the payload length of the type, claimable balance V0, and the signed-payload
 * length prefix and zero padding.
 */
export function decodeStrKeyType(s: string): StrKeyType | undefined {
  const n = s.length;
  if (n < 5) return undefined;
  const mod = n % 8;
  if (mod === 1 || mod === 3 || mod === 6) return undefined;
  const raw: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const v = b32Value(s.charCodeAt(i));
    if (v < 0) return undefined;
    acc = ((acc << 5) | v) & 0xffff; // at most 12 live bits are ever needed
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      raw.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return undefined;
  if (raw.length < 3) return undefined;
  const body = raw.slice(0, -2);
  const crc = crc16XModem(body);
  if (raw[raw.length - 2] !== (crc & 0xff) || raw[raw.length - 1] !== crc >> 8) return undefined;
  const version = body[0];
  const entry = VERSION_BYTES.find(([, v]) => v === version);
  if (!entry) return undefined;
  const typ = entry[0];
  const p = body.slice(1);
  switch (typ) {
    case "G":
    case "S":
    case "T":
    case "X":
    case "C":
    case "L":
      return p.length === 32 ? typ : undefined;
    case "M":
    case "W":
      return p.length === 40 ? typ : undefined;
    case "B":
      return p.length === 33 && p[0] === 0 ? typ : undefined;
    case "P": {
      if (p.length < 32 + 4 + 4 || p.length > 32 + 4 + 64) return undefined;
      const l =
        (((p[32] ?? 0) << 24) | ((p[33] ?? 0) << 16) | ((p[34] ?? 0) << 8) | (p[35] ?? 0)) >>> 0;
      if (l < 1 || l > 64) return undefined;
      const pad = (4 - (l % 4)) % 4;
      if (p.length !== 36 + l + pad) return undefined;
      for (let i = 36 + l; i < p.length; i++) if (p[i] !== 0) return undefined;
      return typ;
    }
  }
}

/** Encode a payload as a StrKey (tests use it to derive test-only keys at run time). */
export function encodeStrKey(t: StrKeyType, payload: ArrayLike<number>): string {
  const ver = VERSION_BYTES.find(([k]) => k === t)?.[1] ?? 0;
  const body = [ver, ...Array.from(payload)];
  const crc = crc16XModem(body);
  body.push(crc & 0xff, crc >> 8);
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of body) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** The 16 encoded lengths a signed-payload StrKey can have. */
export const SIGNED_PAYLOAD_LENGTHS: ReadonlySet<number> = (() => {
  const s = new Set<number>();
  for (let p = 4; p <= 64; p += 4) s.add(Math.floor(((1 + 32 + 4 + p + 2) * 8 + 4) / 5));
  return s;
})();
