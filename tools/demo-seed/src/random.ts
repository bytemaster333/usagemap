// SPDX-License-Identifier: Apache-2.0
// Deterministic randomness for the demo seed: every stream is derived from the seed phrase and a label, so a re-run
// with the same phrase produces the same tenants, keys and figures (and one stream's use never shifts another's).

import { createHash } from "node:crypto";

export type Rng = () => number;

/** mulberry32 over a 32-bit state: small, fast, good enough for synthetic figures (not for secrets). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32 bytes derived from the phrase and a label (domain-separated). */
export function derive(phrase: string, label: string): Buffer {
  return createHash("sha256")
    .update(`scf-demo-seed/1\u0000${phrase}\u0000${label}`, "utf8")
    .digest();
}

export function rngFor(phrase: string, label: string): Rng {
  return mulberry32(derive(phrase, label).readUInt32LE(0));
}

/** A UUID (version 4 layout) derived from the phrase and a label. */
export function uuidFor(phrase: string, label: string): string {
  const b = Buffer.from(derive(phrase, `uuid:${label}`).subarray(0, 16));
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Normal deviate (Box–Muller). */
export function gauss(r: Rng): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Integer in [lo, hi]. */
export function between(r: Rng, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** Log-uniform value in [lo, hi]. */
export function logUniform(r: Rng, lo: number, hi: number): number {
  return Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo)));
}
