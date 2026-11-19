// SPDX-License-Identifier: Apache-2.0
// In-process limits of the hosted MCP server: fixed one-minute windows per key id and per client subnet (failed
// authentications only), and an in-flight cap. One process per host in v1; the control plane enforces its own per-key
// limits (C-21) on every upstream call, so these are a first line, not the only one.
//
// Privacy: a client address is reduced to its subnet (IPv4 /24, IPv6 /48) and the subnet to an HMAC under a random
// per-process secret before it is used as a map key; neither the address nor the subnet is stored or logged.

import { createHmac, randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

export interface Verdict {
  allowed: boolean;
  /** seconds until the window resets */
  retryAfter: number;
}

export class WindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #max: number;
  #windows = new Map<string, { start: number; n: number }>();

  constructor(
    limit: number,
    opts: { windowMs?: number; now?: () => number; maxKeys?: number } = {},
  ) {
    this.#limit = limit;
    this.#windowMs = opts.windowMs ?? 60_000;
    this.#now = opts.now ?? Date.now;
    this.#max = opts.maxKeys ?? 50_000;
  }

  #window(key: string): { start: number; n: number } {
    const t = this.#now();
    let w = this.#windows.get(key);
    if (!w || t - w.start >= this.#windowMs) {
      if (!w && this.#windows.size >= this.#max) this.#sweep(t);
      w = { start: t, n: 0 };
      this.#windows.set(key, w);
    }
    return w;
  }

  #sweep(t: number): void {
    for (const [k, w] of this.#windows) if (t - w.start >= this.#windowMs) this.#windows.delete(k);
    // Still full (a flood of distinct keys within one window): start over rather than grow without bound.
    if (this.#windows.size >= this.#max) this.#windows.clear();
  }

  #retry(w: { start: number }): number {
    return Math.max(1, Math.ceil((w.start + this.#windowMs - this.#now()) / 1000));
  }

  /** Counts one event and says whether it is within the limit. */
  hit(key: string): Verdict {
    const w = this.#window(key);
    w.n++;
    return { allowed: w.n <= this.#limit, retryAfter: this.#retry(w) };
  }

  /** Whether `key` is already over the limit in this window (does not count). */
  blocked(key: string): Verdict {
    const w = this.#windows.get(key);
    if (!w || this.#now() - w.start >= this.#windowMs) return { allowed: true, retryAfter: 0 };
    return { allowed: w.n < this.#limit, retryAfter: this.#retry(w) };
  }
}

const SECRET = randomBytes(32);

/** Opaque limiter key of a client address: HMAC of its /24 (IPv4) or /48 (IPv6) subnet. */
export function subnetKey(address: string): string {
  let subnet: string;
  const a = address.startsWith("::ffff:") && isIPv4(address.slice(7)) ? address.slice(7) : address;
  if (isIPv4(a)) subnet = `${a.split(".").slice(0, 3).join(".")}.0/24`;
  else if (isIPv6(a)) subnet = `${expand6(a).slice(0, 3).join(":")}::/48`;
  else subnet = "unknown";
  return createHmac("sha256", SECRET).update(subnet).digest("base64url").slice(0, 22);
}

function expand6(a: string): string[] {
  const [head = "", tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - h.length - t.length)).fill("0") : [];
  return [...h, ...fill, ...t].map((x) => x.toLowerCase().padStart(4, "0"));
}

/** Counter of requests in flight with a hard cap. */
export class Inflight {
  readonly #max: number;
  n = 0;
  constructor(max: number) {
    this.#max = max;
  }
  enter(): boolean {
    if (this.n >= this.#max) return false;
    this.n++;
    return true;
  }
  leave(): void {
    this.n = Math.max(0, this.n - 1);
  }
}
