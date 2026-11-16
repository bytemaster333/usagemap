// SPDX-License-Identifier: Apache-2.0
// Fixed-window rate limits (OpenAPI "Rate limits"; C-64). Keys are user ids or truncated client subnets.
//
// Production uses PgRateLimiter: the windows live in `scf.rate_limit_buckets`, so every
// control-plane instance counts against the same windows and a restart resets nothing. A bucket is named by
// HMAC-SHA-256(secret, key): neither the subnet nor the user id is stored, and the secret never leaves the process.
// One statement per request (an upsert over all of the request's limits), PgBouncer-safe (transaction mode, no session
// state). The in-memory RateLimiter stays for single-process tests.

import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { Database } from "../db/database.ts";

export interface Limit {
  key: string;
  limit: number;
  windowMs: number;
}

export interface Verdict {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** seconds until the window resets */
  reset: number;
}

/** A limiter: counts one request against every limit and returns the most restrictive verdict. */
export interface Limiter {
  hit(limits: readonly Limit[]): Verdict | Promise<Verdict>;
}

function worstOf(verdicts: Verdict[]): Verdict {
  let worst: Verdict | undefined;
  for (const v of verdicts) {
    if (
      !worst ||
      (!v.allowed && worst.allowed) ||
      (v.allowed === worst.allowed && v.remaining < worst.remaining)
    )
      worst = v;
  }
  return worst ?? { allowed: true, limit: 0, remaining: 0, reset: 1 };
}

/** Windows shared through PostgreSQL (scf_app, global table `rate_limit_buckets`, migration 0060). */
export class PgRateLimiter implements Limiter {
  readonly #db: Database;
  readonly #secret: Buffer;
  readonly #sweepEveryMs: number;
  #lastSweep = 0;

  constructor(db: Database, secret: Buffer, opts: { sweepEveryMs?: number } = {}) {
    if (secret.length < 32) throw new Error("rate-limit secret must be at least 32 bytes");
    this.#db = db;
    this.#secret = secret;
    this.#sweepEveryMs = opts.sweepEveryMs ?? 300_000;
  }

  bucketOf(key: string): Buffer {
    return createHmac("sha256", this.#secret).update(key, "utf8").digest();
  }

  async hit(limits: readonly Limit[]): Promise<Verdict> {
    if (limits.length === 0) return worstOf([]);
    // Sorted by bucket: concurrent requests lock rows in one order (no deadlock between multi-limit upserts).
    const rows = limits
      .map((l) => ({ l, bucket: this.bucketOf(l.key) }))
      .sort((a, b) => Buffer.compare(a.bucket, b.bucket));
    const sweep = Date.now() - this.#lastSweep >= this.#sweepEveryMs;
    if (sweep) this.#lastSweep = Date.now();
    const res = await this.#db.tx(
      { tenantId: null, actorKind: "system", actorId: "rate_limit" },
      async (tx) => {
        if (sweep)
          await tx.query(
            `DELETE FROM scf.rate_limit_buckets WHERE window_end < now() - interval '1 minute'`,
          );
        return tx.query<{ bucket: Buffer; hits: number; reset_ms: string }>(
          `INSERT INTO scf.rate_limit_buckets AS b (bucket, window_end, hits)
           SELECT r.bucket, now() + r.window_ms * interval '1 millisecond', 1
             FROM unnest($1::bytea[], $2::int[]) AS r(bucket, window_ms)
           ON CONFLICT (bucket) DO UPDATE SET
             hits = CASE WHEN b.window_end <= now() THEN 1 ELSE b.hits + 1 END,
             window_end = CASE WHEN b.window_end <= now() THEN EXCLUDED.window_end ELSE b.window_end END
           RETURNING b.bucket, b.hits, (extract(epoch FROM b.window_end - now()) * 1000)::bigint::text AS reset_ms`,
          [rows.map((r) => r.bucket), rows.map((r) => r.l.windowMs)],
        );
      },
    );
    const byBucket = new Map(res.map((r) => [r.bucket.toString("hex"), r]));
    return worstOf(
      rows.map(({ l, bucket }) => {
        const r = byBucket.get(bucket.toString("hex"));
        const hits = Number(r?.hits ?? 1);
        return {
          allowed: hits <= l.limit,
          limit: l.limit,
          remaining: Math.max(0, l.limit - hits),
          reset: Math.max(1, Math.ceil(Number(r?.reset_ms ?? l.windowMs) / 1000)),
        };
      }),
    );
  }
}

/** In-memory windows of one process (tests, and SCF_RATE_LIMIT_STORE=memory). */
export class RateLimiter implements Limiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #now: () => number;
  #lastSweep = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Counts one request against every limit; the most restrictive verdict is returned (and headers use it). */
  hit(limits: readonly Limit[]): Verdict {
    const now = this.#now();
    this.#sweep(now);
    let worst: Verdict | undefined;
    for (const l of limits) {
      let w = this.#windows.get(l.key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + l.windowMs };
        this.#windows.set(l.key, w);
      }
      w.count++;
      const v: Verdict = {
        allowed: w.count <= l.limit,
        limit: l.limit,
        remaining: Math.max(0, l.limit - w.count),
        reset: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
      };
      if (
        !worst ||
        (!v.allowed && worst.allowed) ||
        (v.allowed === worst.allowed && v.remaining < worst.remaining)
      ) {
        worst = v;
      }
    }
    return worst ?? { allowed: true, limit: 0, remaining: 0, reset: 1 };
  }

  #sweep(now: number): void {
    if (now - this.#lastSweep < 60_000) return;
    this.#lastSweep = now;
    for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k);
  }
}

/** IPv4 /24 or IPv6 /48 of the client (ADR-0006 truncation), for per-subnet limits only. */
export function subnetOf(ip: string | undefined): string {
  if (!ip) return "unknown";
  const v4 = ip.startsWith("::ffff:") && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(v4)) return `${v4.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIPv6(ip)) {
    const [head = "", tail = ""] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = ip.includes("::")
      ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]
      : h;
    return `${groups
      .slice(0, 3)
      .map((g) => g.toLowerCase())
      .join(":")}::/48`;
  }
  return "unknown";
}
