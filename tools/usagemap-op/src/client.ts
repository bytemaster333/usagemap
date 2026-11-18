// SPDX-License-Identifier: Apache-2.0
// HTTP client of the operator CLI. Node standard library only (global fetch).
//
// Two credentials, because the platform has two operator surfaces (docs/api/*.openapi.yaml):
//   - the SCF-operator API key `scfa_op_…` (Bearer) for the machine API `/op/v1/*` (registry, projects, metrics);
//   - the SCF-operator portal session (`__Host-scf_session` cookie) for `/v1/operator/*` (onboarding coverage, tenant
//     removal). Those routes accept no API key: an operator signs in with a passkey in the browser and hands the CLI
//     that session. State-changing calls send the CSRF pair the control plane requires (Origin = portal origin and
//     `X-SCF-Request: 1`, C-20).
//
// Network rule: one origin only, the configured base URL; redirects are never followed (a 3xx is an error), so a
// response cannot send the client, or a credential, anywhere else.
// Secret rule: credentials are read from files, kept in memory, sent only in their header, never printed. Every string
// this module returns or throws passes `redact()`.

import { readFileSync, statSync } from "node:fs";

/** wire-formats §k: `scfa_<kind>_<12 base62>_<33 base62>`. */
export const KEY_RE = /^scfa_(op|ing|pub)_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/;
const KEY_ANYWHERE = /scfa_(?:op|ing|pub)_[0-9A-Za-z]{12}_[0-9A-Za-z]{6,}/g;
const SEED_ANYWHERE = /\bS[A-Z2-7]{55}\b/g;
/** Session tokens are 32 random bytes, base64url (services/control-plane/src/auth/sessions.ts). */
export const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_COOKIE = "__Host-scf_session";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const secrets = new Set<string>();

/** Replaces anything key- or seed-shaped, and every loaded session token, by a fixed marker. */
export function redact(s: string): string {
  let out = s.replace(KEY_ANYWHERE, "scfa_[redacted]").replace(SEED_ANYWHERE, "S[redacted]");
  for (const t of secrets) out = out.split(t).join("[session redacted]");
  return out;
}

function firstLine(file: string, what: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(
      `cannot read the ${what} file ${file}: ${(e as NodeJS.ErrnoException).code ?? "error"}`,
    );
  }
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!line) throw new Error(`the ${what} file ${file} is empty`);
  return line;
}

/** Warning text when a credential file is readable by group or others (stderr; the CLI still runs). */
export function permissionWarning(file: string): string | null {
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077)
      return `warning: ${file} is readable by others (mode ${mode.toString(8)}); chmod 600 it`;
  } catch {
    // reported by the reader
  }
  return null;
}

/** Reads an SCF-operator API key; the error never contains the file's content. */
export function loadOperatorKey(file: string): string {
  const raw = firstLine(file, "operator key");
  const m = KEY_RE.exec(raw);
  if (!m)
    throw new Error("the operator key file does not hold a UsageMap key (expected scfa_op_…)");
  if (m[1] !== "op") throw new Error(`expected an scfa_op_ key, got an scfa_${m[1]}_ key`);
  return raw;
}

/** Reads a portal session: the bare cookie value, or `__Host-scf_session=<value>` as copied from the browser. */
export function loadSession(file: string): string {
  let raw = firstLine(file, "session");
  const prefix = `${SESSION_COOKIE}=`;
  if (raw.startsWith(prefix)) raw = raw.slice(prefix.length).split(";")[0]?.trim() ?? "";
  if (!SESSION_RE.test(raw))
    throw new Error(
      `the session file does not hold a ${SESSION_COOKIE} cookie value (43 characters)`,
    );
  secrets.add(raw);
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

export type Auth = "key" | "session" | "none";
export type Query = Record<string, string | number | boolean | undefined | null>;

export interface ClientOpts {
  baseUrl: string;
  key?: string | undefined;
  session?: string | undefined;
  /** Origin header for state-changing session calls (the control plane's SCF_PORTAL_ORIGIN); default: the base origin. */
  portalOrigin?: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch | undefined;
}

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export class OpClient {
  readonly origin: string;
  readonly portalOrigin: string;
  readonly hasKey: boolean;
  readonly hasSession: boolean;
  readonly #base: URL;
  readonly #key: string | undefined;
  readonly #session: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(o: ClientOpts) {
    const u = new URL(o.baseUrl);
    if (u.protocol !== "https:" && !isLoopback(u.hostname))
      throw new Error(`base URL must be https (http only for a loopback address): ${u.origin}`);
    if (u.username || u.password || u.search || u.hash)
      throw new Error("base URL must not carry credentials, a query or a fragment");
    this.#base = u;
    this.origin = u.origin;
    this.portalOrigin = o.portalOrigin ? new URL(o.portalOrigin).origin : u.origin;
    this.#key = o.key;
    this.#session = o.session;
    this.hasKey = o.key !== undefined;
    this.hasSession = o.session !== undefined;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#fetch = o.fetch ?? fetch;
  }

  url(path: string, q: Query = {}): URL {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`bad path ${path}`);
    const u = new URL(this.#base.pathname.replace(/\/$/, "") + path, this.#base.origin);
    if (u.origin !== this.origin) throw new Error("refusing a request off the configured origin");
    for (const [k, v] of Object.entries(q))
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    o: { auth: Auth; query?: Query; body?: unknown },
  ): Promise<T> {
    const u = this.url(path, o.query);
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "usagemap-op/1",
    };
    if (o.auth === "key") {
      if (!this.#key)
        throw new ApiError(
          0,
          `${path} needs an SCF-operator API key: pass --key-file (or USAGEMAP_OPERATOR_KEY_FILE)`,
        );
      headers.authorization = `Bearer ${this.#key}`;
    } else if (o.auth === "session") {
      if (!this.#session)
        throw new ApiError(
          0,
          `${path} needs an SCF-operator portal session (these routes accept no API key): pass --session-file (or USAGEMAP_SESSION_FILE)`,
        );
      headers.cookie = `${SESSION_COOKIE}=${this.#session}`;
      if (method !== "GET") {
        headers.origin = this.portalOrigin;
        headers["x-scf-request"] = "1";
      }
    }
    let payload: string | undefined;
    if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      headers["content-type"] = "application/json";
    }
    let r: Response;
    try {
      r = await this.#fetch(u, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new ApiError(0, `${method} ${u.pathname}: ${(e as Error).message}`);
    }
    const text = await r.text();
    if (r.status >= 300 && r.status < 400)
      throw new ApiError(r.status, `${method} ${u.pathname}: redirect refused (${r.status})`);
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
        `${method} ${u.pathname} → ${r.status}${detail ? ` (${detail})` : ""}${retry ? `; retry after ${retry} s` : ""}`,
        code,
      );
    }
    if (r.status === 204 || text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(r.status, `${method} ${u.pathname}: the answer is not JSON`);
    }
  }

  get<T>(path: string, auth: Auth, query: Query = {}): Promise<T> {
    return this.request<T>("GET", path, { auth, query });
  }

  /** Follows `next_cursor` of an `/op/v1` page (`{data, next_cursor}`) to the end or `maxRows`. */
  async all<R>(path: string, query: Query = {}, maxRows = 20_000): Promise<R[]> {
    const out: R[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.get<{ data: R[]; next_cursor?: string | null }>(path, "key", {
        ...query,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...page.data);
      cursor = page.next_cursor;
    } while (cursor && out.length < maxRows);
    return out;
  }
}
