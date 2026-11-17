// SPDX-License-Identifier: Apache-2.0
// Protocol-level client of the gateway (wire-formats §a, §b): challenge, proof-of-work, event batches — with every
// request header under the caller's control, so the simulations can be a "clean" scripted client, a curl-like one, a
// headless browser, a replay, … The proof-of-work is the contract's (§b.2), computed with node:crypto.

import { pbkdf2, randomBytes } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import { promisify } from "node:util";
import { type Res, request } from "./http.ts";

const pbkdf2Async = promisify(pbkdf2);

/** Token layout of §b.1 (92 bytes → 123 base64url characters). */
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

/** Flips one bit of the MAC (tampered token: bad MAC with a known epoch → `rejected/challenge_invalid`). */
export function tamperToken(t: string): string {
  const b = Buffer.from(t, "base64url");
  b[91] = (b[91] as number) ^ 0x01;
  return b.toString("base64url");
}

/** dk(c)[0..4] of §b.2: PBKDF2-HMAC-SHA-256("scf-pow-v1" ‖ nonce ‖ uint32be(c), nonce, cost, 4). */
export async function powPrefix(nonce: Buffer, cost: number, c: number): Promise<Buffer> {
  const ctr = Buffer.alloc(4);
  ctr.writeUInt32BE(c);
  const password = Buffer.concat([Buffer.from("scf-pow-v1", "ascii"), nonce, ctr]);
  return pbkdf2Async(password, nonce, cost, 4, "sha256");
}

/** Solves the proof of a token: the smallest c in [0, max) whose prefix matches, `parallel` attempts in flight. */
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
  throw new Error("no counter matches the token's prefix (token tampered or not issued by §b.2)");
}

/** A random 22-character event id (C-37). */
export function eventId(): string {
  return randomBytes(16).toString("base64url").slice(0, 22);
}

export const CHROME_UA = (major = 131, os = "Windows NT 10.0; Win64; x64") =>
  `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

/**
 * Headers a current Chrome sends with `fetch(…, {keepalive, credentials:"omit"})` from a cross-site page — what the
 * tracker produces. A scripted client sending these is indistinguishable from a browser at the header layer; that is
 * the documented limit of L1–L5 (ADR-0008), and the reason the proof-of-work and multiplicity layers exist.
 */
export function browserHeaders(origin: string, ua = CHROME_UA()): Record<string, string> {
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

/** What `curl --data` sends: no Origin, no Sec-Fetch-*, a tool User-Agent. */
export function curlHeaders(): Record<string, string> {
  return { "user-agent": "curl/8.11.1", accept: "*/*", "content-type": "text/plain" };
}

export interface GatewayTarget {
  url: string;
  /** SNI / Host header (the listener certificate names the ingest hosts). */
  servername: string;
  caFile: string;
}

export interface ChallengeResult {
  status: number;
  token?: string;
  pow?: { alg: string; cost: number; max: number; pfx: string };
}

export interface Pageview {
  k: "pv";
  u: string;
  r?: string;
  w?: "s" | "m" | "l" | "x";
  l?: string;
  wk?: true;
}
export interface Custom {
  k: "ev";
  u: string;
  n: string;
  d?: Record<string, string | number | boolean>;
}
export type OutEvent = (Pageview | Custom) & { id?: string };

export interface Batch {
  site: string;
  profile?: "standard" | "strict";
  tv?: string;
  token?: string | undefined;
  c?: number | null | undefined;
  sg?: { wd?: 0 | 1; vis?: "v" | "h" | "p"; act?: 0 | 1 } | undefined;
  events: OutEvent[];
  /** Extra top-level fields (schema violations such as `ip`). */
  extra?: Record<string, unknown>;
}

export class GatewayClient {
  readonly target: GatewayTarget;
  readonly headers: OutgoingHttpHeaders;
  constructor(target: GatewayTarget, headers: OutgoingHttpHeaders) {
    this.target = target;
    this.headers = headers;
  }

  async post(path: string, body: string, extraHeaders: OutgoingHttpHeaders = {}): Promise<Res> {
    return request(`${this.target.url}${path}`, {
      method: "POST",
      headers: { ...this.headers, ...extraHeaders },
      body,
      servername: this.target.servername,
      caFile: this.target.caFile,
    });
  }

  async challenge(site: string, profile = "standard", tv = "1.2.0"): Promise<ChallengeResult> {
    const r = await this.post("/v1/c", JSON.stringify({ v: 1, s: site, p: profile, tv }));
    if (r.status !== 200) return { status: r.status };
    const j = JSON.parse(r.body) as { t: string; pow: ChallengeResult["pow"] };
    return { status: 200, token: j.t, ...(j.pow ? { pow: j.pow } : {}) };
  }

  /** Challenge + proof, like the tracker on page load. */
  async solved(site: string, profile = "standard"): Promise<{ token: string; c: number }> {
    const ch = await this.challenge(site, profile);
    if (!ch.token) throw new Error(`challenge answered ${ch.status}`);
    return { token: ch.token, c: await solvePow(ch.token) };
  }

  async send(b: Batch, extraHeaders: OutgoingHttpHeaders = {}): Promise<Res> {
    const body: Record<string, unknown> = {
      v: 1,
      s: b.site,
      p: b.profile ?? "standard",
      tv: b.tv ?? "1.2.0",
      ...(b.token !== undefined ? { t: b.token } : {}),
      ...(b.c !== undefined ? { c: b.c } : {}),
      ...(b.sg ? { sg: b.sg } : {}),
      e: b.events.map((e) => ({ id: e.id ?? eventId(), ...e })),
      ...(b.extra ?? {}),
    };
    return this.post("/v1/e", JSON.stringify(body), extraHeaders);
  }
}
