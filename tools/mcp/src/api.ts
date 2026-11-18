// SPDX-License-Identifier: Apache-2.0
// Read-only client of the UsageMap metrics APIs (docs/api/operator-metrics.openapi.yaml `/op/v1`, and the public
// per-project metrics document `/public/v1/projects/{slug}/metrics.json`). Node standard library only (global fetch).
//
// Network rule: the client talks to exactly one origin, the configured base URL. Every request URL is built from a
// fixed path and checked against that origin; redirects are never followed (a 3xx is an error), so a response cannot
// send the client — or the key in its Authorization header — anywhere else.
//
// Secret rule: keys are read from a file (preferred) or an environment variable, kept in memory, sent only in
// `Authorization: Bearer`, and never printed. Every string this module returns or throws passes `redact()`.

import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";

/** wire-formats §k: `scfa_<kind>_<12 base62>_<33 base62>`. */
export const KEY_RE = /^scfa_(op|ing|pub)_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/;
const KEY_ANYWHERE = /scfa_(?:op|ing|pub)_[0-9A-Za-z]{12}_[0-9A-Za-z]{6,}/g;
/** Stellar secret seeds (S + 55 base32) — never echoed, wherever they appear. */
const SEED_ANYWHERE = /\bS[A-Z2-7]{55}\b/g;

/** Replaces anything key- or seed-shaped by a fixed marker (defence in depth for every printed string). */
export function redact(s: string): string {
  return s.replace(KEY_ANYWHERE, "scfa_[redacted]").replace(SEED_ANYWHERE, "S[redacted]");
}

export type KeyKind = "op" | "ing" | "pub";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(n: number, width: number): string {
  let out = "";
  let v = n;
  while (v > 0) {
    out = (B62[v % 62] as string) + out;
    v = Math.floor(v / 62);
  }
  return out.padStart(width, "0");
}

/**
 * Parses a key offline (wire-formats §k): grammar and CRC-32 (IEEE) of `scfa_<kind>_<id>_<secret>`. Returns the kind
 * and the public lookup id, or `null` for anything that is not a well-formed key. The secret is never returned.
 */
export function parseKeyOffline(key: string): { kind: KeyKind; id: string } | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const body = key.slice(0, -6);
  if (base62(crc32(Buffer.from(body, "ascii")) >>> 0, 6) !== key.slice(-6)) return null;
  return { kind: m[1] as KeyKind, id: key.slice(5 + (m[1] as string).length + 1, -34) };
}

/** Builds a key with a valid checksum (tests and fixtures only; the secret is the caller's). */
export function keyWithChecksum(kind: KeyKind, id: string, secret: string): string {
  const body = `scfa_${kind}_${id}_${secret}`;
  return body + base62(crc32(Buffer.from(body, "ascii")) >>> 0, 6);
}

/**
 * Reads a key from `file` (first non-empty line) or `value`; throws a message that never contains the key.
 * `kind` checks the prefix, so an ingest token cannot be used where an operator key is expected.
 */
export function loadKey(
  opts: { file?: string | undefined; value?: string | undefined },
  kind: KeyKind,
): string {
  let raw: string | undefined;
  if (opts.file) {
    try {
      raw = readFileSync(opts.file, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l !== "");
    } catch (e) {
      throw new Error(
        `cannot read the key file ${opts.file}: ${(e as NodeJS.ErrnoException).code ?? "error"}`,
      );
    }
  } else raw = opts.value?.trim();
  if (!raw) throw new Error(`no ${kind} key given`);
  const m = KEY_RE.exec(raw);
  if (!m) throw new Error(`the ${kind} key is not a UsageMap key (expected scfa_${kind}_…)`);
  if (m[1] !== kind) throw new Error(`expected a scfa_${kind}_ key, got a scfa_${m[1]}_ key`);
  return raw;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(redact(message));
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOpts {
  baseUrl: string;
  key?: string | undefined;
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch | undefined;
  userAgent?: string;
  /** Allow plain http to a non-loopback host (the hosted server's internal network address only). */
  allowInsecureHttp?: boolean | undefined;
  /** Extra request headers (the hosted server's forwarded client address). Never carries a key. */
  headers?: Record<string, string> | undefined;
  /** Aborts every request of this client (the hosted server: the caller went away). */
  signal?: AbortSignal | undefined;
}

export type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export class ApiClient {
  readonly origin: string;
  readonly #base: URL;
  readonly #key: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #ua: string;
  readonly #headers: Record<string, string>;
  readonly #signal: AbortSignal | undefined;

  constructor(o: ApiClientOpts) {
    const u = new URL(o.baseUrl);
    if (
      u.protocol !== "https:" &&
      !(u.protocol === "http:" && (isLoopback(u.hostname) || o.allowInsecureHttp))
    )
      throw new Error(`base URL must be https (http only for a loopback address): ${u.origin}`);
    if (u.username || u.password || u.search || u.hash)
      throw new Error("base URL must not carry credentials, a query or a fragment");
    this.#base = u;
    this.origin = u.origin;
    this.#key = o.key;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#fetch = o.fetch ?? fetch;
    this.#ua = o.userAgent ?? "usagemap-tools/1";
    this.#headers = { ...(o.headers ?? {}) };
    this.#signal = o.signal;
  }

  /** URL of `path` (absolute path, no host) under the base, with the query; refuses anything off-origin. */
  url(path: string, q: Query = {}): URL {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`bad path ${path}`);
    const prefix = this.#base.pathname.replace(/\/$/, "");
    const u = new URL(prefix + path, this.#base.origin);
    if (u.origin !== this.origin) throw new Error("refusing a request off the configured origin");
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return u;
  }

  async get<T>(path: string, q: Query = {}, auth = true): Promise<T> {
    const u = this.url(path, q);
    const headers: Record<string, string> = {
      ...this.#headers,
      accept: "application/json",
      "user-agent": this.#ua,
    };
    if (auth) {
      if (!this.#key) throw new ApiError(0, "this call needs an API key and none is configured");
      headers.authorization = `Bearer ${this.#key}`;
    }
    let r: Response;
    try {
      r = await this.#fetch(u, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: this.#signal
          ? AbortSignal.any([this.#signal, AbortSignal.timeout(this.#timeoutMs)])
          : AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new ApiError(0, `GET ${u.pathname}: ${(e as Error).message}`);
    }
    const text = await r.text();
    if (r.status >= 300 && r.status < 400)
      throw new ApiError(r.status, `GET ${u.pathname}: redirect refused (${r.status})`);
    if (!r.ok) {
      let code: string | undefined;
      let detail = text.slice(0, 300);
      try {
        const p = JSON.parse(text) as { code?: string; title?: string; detail?: string };
        code = p.code;
        detail = [p.code, p.title, p.detail].filter(Boolean).join(": ");
      } catch {
        // not problem+json
      }
      const retry = r.headers.get("retry-after");
      throw new ApiError(
        r.status,
        `GET ${u.pathname} → ${r.status}${detail ? ` (${detail})` : ""}${retry ? `; retry after ${retry} s` : ""}`,
        code,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(r.status, `GET ${u.pathname}: the answer is not JSON`);
    }
  }

  /** Follows `next_cursor` of an `{data, next_cursor}` page until the end or `maxRows`. */
  async all<R>(path: string, q: Query = {}, maxRows = 10_000): Promise<R[]> {
    const out: R[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.get<{ data: R[]; next_cursor?: string | null }>(path, {
        ...q,
        limit: q.limit ?? 1000,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...page.data);
      cursor = page.next_cursor;
    } while (cursor && out.length < maxRows);
    return out;
  }
}

export function isLoopback(host: string): boolean {
  return (
    host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → RFC 3339 midnight UTC (ranges are start-inclusive, end-exclusive: C-86). */
export function dayStart(d: string): string {
  if (!DAY_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))
    throw new Error(`not a date (YYYY-MM-DD): ${d}`);
  return `${d}T00:00:00Z`;
}

/** The default range: the last `days` complete UTC days before `now` (end = today 00:00 UTC, exclusive). */
export function lastDays(days: number, now = new Date()): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
