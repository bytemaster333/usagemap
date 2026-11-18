// SPDX-License-Identifier: Apache-2.0
// The public tracker protocol v1 as an outsider sees it (docs/contracts/wire-formats.md §a, §b): challenge token
// layout, proof-of-work, event batches, and a forged token. Everything here is computable from the public contract;
// nothing needs a server secret — which is the point: a forger has exactly this and no more.

import { createHash, pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

export interface TokenFields {
  ver: number;
  kep: number;
  siteRef: Buffer;
  issuedMs: number;
  nonce: Buffer;
  ctx: Buffer;
  cost: number;
  max: number;
  pfx: Buffer;
  prof: number;
  mac: Buffer;
}

/** §b.1: 92 bytes → 123 base64url characters. */
export function parseToken(t: string): TokenFields {
  const b = Buffer.from(t, "base64url");
  if (b.length !== 92) throw new Error(`token is ${b.length} bytes, want 92`);
  return {
    ver: b[0] as number,
    kep: b.readUInt32BE(1),
    siteRef: b.subarray(5, 21),
    issuedMs: b.readUIntBE(21, 6),
    nonce: b.subarray(27, 43),
    ctx: b.subarray(43, 51),
    cost: b.readUInt16BE(51),
    max: b.readUInt16BE(53),
    pfx: b.subarray(55, 59),
    prof: b[59] as number,
    mac: b.subarray(60, 92),
  };
}

/** First 16 bytes of SHA-256(site key) — public, so a forger can always get it right. */
export function siteRef(siteKey: string): Buffer {
  return createHash("sha256").update(siteKey, "utf8").digest().subarray(0, 16);
}

/**
 * A token a forger can build without the server's hourly key: correct layout and site reference, a made-up key
 * epoch (`kep`), a fresh issue time, a cheap proof (cost 1, max 1) and a random MAC. The gateway checks the MAC under
 * K_chal[kep]; an epoch outside its window is `rejected/challenge_invalid` (§b.3, C-140).
 * Returns the token and the matching proof counter (0), so only the MAC is wrong.
 */
export async function forgeToken(
  siteKey: string,
  now = Date.now(),
): Promise<{ token: string; c: number; kep: number }> {
  const b = Buffer.alloc(92);
  const kep = 1 + (randomBytes(2).readUInt16BE(0) % 100_000); // an hour in 1970–1981: never a live epoch
  b[0] = 1;
  b.writeUInt32BE(kep, 1);
  siteRef(siteKey).copy(b, 5);
  b.writeUIntBE(now, 21, 6);
  const nonce = randomBytes(16);
  nonce.copy(b, 27);
  randomBytes(8).copy(b, 43);
  b.writeUInt16BE(1, 51); // cost
  b.writeUInt16BE(1, 53); // max
  (await powPrefix(nonce, 1, 0)).copy(b, 55); // a proof that is valid for this token's own fields
  b[59] = 0;
  randomBytes(32).copy(b, 60); // the MAC nobody outside the gateways can compute
  return { token: b.toString("base64url"), c: 0, kep };
}

/** §b.2: dk(c)[0..4] = PBKDF2-HMAC-SHA-256("scf-pow-v1" ‖ nonce ‖ uint32be(c), nonce, cost, 4). */
export async function powPrefix(nonce: Buffer, cost: number, c: number): Promise<Buffer> {
  const ctr = Buffer.alloc(4);
  ctr.writeUInt32BE(c);
  return pbkdf2Async(
    Buffer.concat([Buffer.from("scf-pow-v1", "ascii"), nonce, ctr]),
    nonce,
    cost,
    4,
    "sha256",
  );
}

/** Solves a token's proof (smallest matching counter), `parallel` attempts in flight. */
export async function solvePow(token: string, parallel = 8): Promise<number> {
  const f = parseToken(token);
  for (let base = 0; base < f.max; base += parallel) {
    const n = Math.min(parallel, f.max - base);
    const found = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        powPrefix(f.nonce, f.cost, base + i).then((p) => (p.equals(f.pfx) ? base + i : -1)),
      ),
    );
    const hit = found.find((c) => c >= 0);
    if (hit !== undefined) return hit;
  }
  throw new Error("no counter matches the token's prefix");
}

/** A random 22-character event id (C-37). */
export function eventId(): string {
  return randomBytes(16).toString("base64url").slice(0, 22);
}

export function pageviewBatch(o: {
  site: string;
  tv: string;
  path: string;
  token?: string | undefined;
  c?: number | undefined;
  id?: string;
}): string {
  return JSON.stringify({
    v: 1,
    s: o.site,
    p: "standard",
    tv: o.tv,
    ...(o.token !== undefined ? { t: o.token } : {}),
    ...(o.c !== undefined ? { c: o.c } : {}),
    sg: { wd: 0, vis: "v", act: 1 },
    e: [{ id: o.id ?? eventId(), k: "pv", u: o.path, w: "l", l: "en" }],
  });
}

export const CHROME_UA = (major: number) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

/** What Chrome sends with the tracker's `fetch(…, {keepalive, credentials: "omit"})` from the tenant's page. */
export function browserHeaders(origin: string, ua: string): Record<string, string> {
  return {
    "user-agent": ua,
    origin,
    referer: `${origin}/`,
    "content-type": "text/plain;charset=UTF-8",
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "sec-fetch-dest": "empty",
  };
}

/** What `curl --data` sends from a server: no Origin, no Sec-Fetch-*, a tool User-Agent. */
export function curlHeaders(): Record<string, string> {
  return { "user-agent": "curl/8.11.1", accept: "*/*", "content-type": "text/plain" };
}
