// SPDX-License-Identifier: Apache-2.0
// Integration harness: the real app on the real database (scf_app through PgBouncer), a local fake GitHub (OAuth +
// API, PKCE checked) behind the real HTTP client, a scripted Horizon, and response validation against the OpenAPI
// document on EVERY call made through `call()`.

import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { expect, inject } from "vitest";
import { type AppDeps, buildApps } from "../../src/app.ts";
import { httpGithubClient } from "../../src/auth/github.ts";
import { encodeAccountId, type HorizonClient, sep53Digest } from "../../src/auth/stellar.ts";
import { type Config, loadConfig } from "../../src/config.ts";
import { createPool, Database } from "../../src/db/database.ts";
import type { OpenApi } from "../../src/http/openapi.ts";
import { RateLimiter } from "../../src/http/ratelimit.ts";
import { OAUTH_PROTOCOL_OPS } from "../../src/oauth/protocol.ts";
import { TractionSigner, TractionSigningKey } from "../../src/programme/signer.ts";
import { loadTrackerRegistry } from "../../src/tracker.ts";
import { SoftAuthenticator } from "./authenticator.ts";

export const PORTAL = "https://portal.test";

/** Test peppers (32 bytes each, wire-formats §k); version 1 for every kind. */
export const TEST_PEPPERS = {
  ing: Buffer.alloc(32, 1),
  op: Buffer.alloc(32, 2),
  pub: Buffer.alloc(32, 3),
};

/**
 * State-changing operations whose contract lacks a 403 response although CSRF (and for some, recent auth) apply.
 * Empty since the contract documents 403 on all of them (C-113); a new entry is a contract gap to report.
 */
export const KNOWN_403_GAPS = new Set<string>([]);
export const contractGaps = new Set<string>();
/** Audited operations whose audit row was verified by `call()`. */
export const auditedOps = new Set<string>();

export interface FakeGithubUser {
  id: number;
  login: string;
  created_at?: string;
}

/** A local stand-in for github.com's OAuth endpoints and api.github.com/user, checking PKCE like GitHub does. */
export class FakeGithub {
  server: Server | undefined;
  url = "";
  readonly #codes = new Map<
    string,
    { challenge: string; user: FakeGithubUser; clientId: string; redirect: string }
  >();
  readonly #tokens = new Map<string, FakeGithubUser>();
  readonly seenBodies: string[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const u = new URL(req.url ?? "/", "http://x");
        if (req.method === "POST" && u.pathname === "/login/oauth/access_token") {
          this.seenBodies.push(body);
          const f = new URLSearchParams(body);
          const entry = this.#codes.get(f.get("code") ?? "");
          const verifier = f.get("code_verifier") ?? "";
          const ok =
            entry &&
            createHash("sha256").update(verifier).digest("base64url") === entry.challenge &&
            f.get("client_id") === entry.clientId &&
            f.get("client_secret") === "gh-secret" &&
            f.get("redirect_uri") === entry.redirect;
          res.setHeader("content-type", "application/json");
          if (!ok || !entry) {
            res.end(JSON.stringify({ error: "bad_verification_code" }));
            return;
          }
          this.#codes.delete(f.get("code") ?? "");
          const token = `gho_${randomUUID().replace(/-/g, "")}`;
          this.#tokens.set(token, entry.user);
          res.end(
            JSON.stringify({ access_token: token, token_type: "bearer", scope: "read:user" }),
          );
          return;
        }
        if (req.method === "GET" && u.pathname === "/user") {
          const user = this.#tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
          res.statusCode = user ? 200 : 401;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(user ?? { message: "Bad credentials" }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** What github.com does when the user approves: returns the code for the redirect. */
  approve(authorizeLocation: string, user: FakeGithubUser): { code: string; state: string } {
    const u = new URL(authorizeLocation);
    expect(u.origin + u.pathname).toBe(`${this.url}/login/oauth/authorize`);
    expect(u.searchParams.get("scope")).toBe("read:user");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const code = randomUUID();
    this.#codes.set(code, {
      challenge: u.searchParams.get("code_challenge") ?? "",
      user,
      clientId: u.searchParams.get("client_id") ?? "",
      redirect: u.searchParams.get("redirect_uri") ?? "",
    });
    return { code, state: u.searchParams.get("state") ?? "" };
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.server?.close(r));
  }
}

/** Horizon answers scripted per account; default = unfunded account (master key only). */
export class FakeHorizon implements HorizonClient {
  readonly accounts = new Map<
    string,
    {
      weight: number;
      mediumThreshold: number;
      homeDomain?: string | null;
      signers?: Array<{ key: string; weight: number }>;
    }
  >();
  /** Network asked for, per account (the deployment's network, never the client's choice: C-114). */
  readonly networks = new Map<string, string>();
  async signerWeight(n: "public" | "testnet", account: string) {
    this.networks.set(account, n);
    const a = this.accounts.get(account);
    return a
      ? { weight: a.weight, mediumThreshold: a.mediumThreshold }
      : { weight: 1, mediumThreshold: 0 };
  }
  async accountInfo(n: "public" | "testnet", account: string) {
    this.networks.set(account, n);
    const a = this.accounts.get(account);
    if (!a)
      return {
        weight: 1,
        mediumThreshold: 0,
        homeDomain: null,
        signers: [{ key: account, weight: 1 }],
        exists: false,
      };
    return {
      weight: a.weight,
      mediumThreshold: a.mediumThreshold,
      homeDomain: a.homeDomain ?? null,
      signers: a.signers ?? [{ key: account, weight: a.weight }],
      exists: true,
    };
  }
}

/** Scripted HTTPS answers for `stellar.toml` (L2 proof); unknown hosts answer like a refused connection. */
export class FakeFetcher {
  readonly bodies = new Map<string, string>();
  readonly seen: string[] = [];
  async fetchText(host: string, path: string) {
    this.seen.push(`${host}${path}`);
    const b = this.bodies.get(`${host}${path}`);
    return b === undefined
      ? { kind: "code" as const, code: "HTTP_STATUS" as const }
      : { kind: "ok" as const, body: b };
  }
}

/** The test deployment's SEP-10 server signing seed. */
export const SEP10_SEED = Keypair.random().secret();

/** Signs a SEP-10 challenge transaction with the given keys (what a wallet does). */
export function signSep10(xdr: string, passphrase: string, ...keys: Keypair[]): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  for (const k of keys) tx.sign(k);
  return tx.toXDR();
}

/** The test deployment's traction-snapshot signing key (Ed25519, PKCS#8 PEM) — held by the jobs service (F16). */
export const SNAPSHOT_KEY_PEM = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
/** Its public half, the only part the control plane is given (SCF_SNAPSHOT_PUBLIC_KEY). */
export const SNAPSHOT_PUBLIC_PEM = createPublicKey(SNAPSHOT_KEY_PEM)
  .export({ format: "pem", type: "spki" })
  .toString();

export interface StellarKey {
  account: string;
  signMessage(message: string): string;
}

export function stellarKey(): StellarKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    account: encodeAccountId(raw),
    signMessage: (m) => sign(null, sep53Digest(m), privateKey).toString("base64"),
  };
}

export class LogCapture {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  get text(): string {
    return this.lines.join("");
  }
}

export interface Harness {
  app: FastifyInstance;
  internal: FastifyInstance;
  openapi: OpenApi;
  db: Database;
  jobsDb: Database;
  /** scf_metrics_ro through PgBouncer (operator metrics API). */
  metricsDb: Database;
  su: pg.Pool;
  config: Config;
  github: FakeGithub;
  horizon: FakeHorizon;
  fetcher: FakeFetcher;
  logs: LogCapture;
  /** operationIds that have a handler (the rest answer 501 after authorisation). */
  built: Set<string>;
  responseProblems: string[];
  close(): Promise<void>;
}

export async function startHarness(
  env: Record<string, string> = {},
  extra: Partial<AppDeps> = {},
): Promise<Harness> {
  const github = new FakeGithub();
  await github.start();
  const config = loadConfig({
    SCF_PORTAL_ORIGIN: PORTAL,
    SCF_DATABASE_URL: inject("pgAppUrl"),
    SCF_GITHUB_CLIENT_ID: "gh-client",
    SCF_GITHUB_CLIENT_SECRET: "gh-secret",
    SCF_GITHUB_AUTHORIZE_URL: `${github.url}/login/oauth/authorize`,
    SCF_GITHUB_TOKEN_URL: `${github.url}/login/oauth/access_token`,
    SCF_GITHUB_API_URL: github.url,
    SCF_STELLAR_HOME_DOMAIN: "portal.test",
    SCF_LOG_LEVEL: "info",
    // Plain HTTP on the internal listener is allowed only on loopback (C-114); tests inject from 127.0.0.1.
    SCF_INTERNAL_LISTEN_HOST: "127.0.0.1",
    SCF_PEPPER_ING: `1:${TEST_PEPPERS.ing.toString("base64")}`,
    SCF_PEPPER_OP: `1:${TEST_PEPPERS.op.toString("base64")}`,
    SCF_PEPPER_PUB: `1:${TEST_PEPPERS.pub.toString("base64")}`,
    SCF_SNAPSHOT_PUBLIC_KEY: SNAPSHOT_PUBLIC_PEM,
    SCF_RATE_LIMIT_STORE: "memory",
    SCF_SNAPSHOT_KID: "snap-test",
    SCF_SEP10_SIGNING_SEED: SEP10_SEED,
    ...env,
  });
  const db = new Database(createPool({ connectionString: config.databaseUrl, max: 4 }));
  // erasure runs hold one connection for their fenced transaction while heartbeats and a second worker need others
  const jobsDb = new Database(createPool({ connectionString: inject("pgJobsUrl"), max: 6 }));
  const metricsDb = new Database(createPool({ connectionString: inject("pgMetricsUrl"), max: 2 }));
  const su = new pg.Pool({ connectionString: inject("pgSuperUrl"), max: 4 });
  const horizon = new FakeHorizon();
  const fetcher = new FakeFetcher();
  const logs = new LogCapture();
  // The jobs service's signer of traction snapshots (F16), in-process and woken by the create handler.
  const signer = config.programme.snapshotPublicKeyPem
    ? new TractionSigner(
        jobsDb,
        new TractionSigningKey(SNAPSHOT_KEY_PEM, config.programme.snapshotKid),
        {
          portalOrigin: config.portalOrigin,
          intervalMs: 3_600_000,
          log: { info: () => {}, error: () => {} },
        },
      )
    : undefined;
  const { publicApp, internalApp, openapi, handlers } = await buildApps({
    config,
    db,
    tracker: loadTrackerRegistry(
      new URL("./fixtures/tracker", import.meta.url).pathname,
      new URL("./fixtures/tracker/releases.json", import.meta.url).pathname,
    ),
    github: config.github ? httpGithubClient(config.github) : undefined,
    horizon,
    logStream: logs,
    // Generous limits in tests unless a test brings its own limiter.
    limiter: new RateLimiter(),
    metricsDb,
    textFetcher: fetcher,
    wakeSigner: () => signer?.wake(),
    ...extra,
  });
  await publicApp.ready();
  await internalApp.ready();
  return {
    app: publicApp,
    internal: internalApp,
    openapi,
    db,
    jobsDb,
    metricsDb,
    su,
    config,
    github,
    horizon,
    fetcher,
    logs,
    // The OAuth protocol endpoints are registered by registerOAuthProtocol (form bodies, RFC error shapes), not by the
    // generated pipeline; they are always built and answer 404 while OAuth is not configured (oauth.test.ts).
    built: new Set([...Object.keys(handlers), ...OAUTH_PROTOCOL_OPS]),
    responseProblems: [],
    async close() {
      await signer?.stop();
      await publicApp.close();
      await internalApp.close();
      await db.close();
      await jobsDb.close();
      await metricsDb.close();
      await su.end();
      await github.stop();
    },
  };
}

export interface CallOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  cookie?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip the CSRF headers a browser on the portal would send. */
  noCsrf?: boolean;
}

/** Finds the documented operation for a concrete request (for response validation). */
export function operationFor(h: Harness, method: string, url: string): string | undefined {
  const path = url.split("?")[0] ?? url;
  for (const op of h.openapi.operations) {
    if (op.method !== method.toLowerCase()) continue;
    const re = new RegExp(`^${op.path.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    if (re.test(path)) return op.operationId;
  }
  return undefined;
}

export async function call(h: Harness, o: CallOptions): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (!o.noCsrf && o.method !== "GET") {
    headers.origin ??= PORTAL;
    headers["x-scf-request"] ??= "1";
  }
  const res = await h.app.inject({
    method: o.method,
    url: o.url,
    headers,
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
  const opId = operationFor(h, o.method, o.url);
  if (opId && res.statusCode !== 501) {
    const ct = res.headers["content-type"] as string | undefined;
    const body =
      res.body.length > 0 && ct?.includes("json")
        ? res.json()
        : res.body.length > 0
          ? res.body
          : undefined;
    let problems = h.openapi.validateResponse(opId, res.statusCode, ct, body);
    // Known contract gap (reported): these operations enforce CSRF / recent auth but do not document 403.
    if (
      res.statusCode === 403 &&
      KNOWN_403_GAPS.has(opId) &&
      problems.length === 1 &&
      problems[0]?.endsWith("status 403 is not documented")
    ) {
      contractGaps.add(
        `${opId}: 403 ${body && typeof body === "object" ? (body as { code?: string }).code : ""}`,
      );
      problems = h.openapi.validateResponse("getTenant", 403, ct, body);
    }
    h.responseProblems.push(...problems);
    // Every successful call of an audited operation appended one of its documented actions (x-audit-action).
    const op = h.openapi.get(opId);
    // The metrics_endpoint is audited only for SCF-operator key reads (its x-audit-action).
    const auditedHere =
      op.audited &&
      (opId !== "getMetricsEndpoint" || /^Bearer scfa_op_/.test(o.headers?.authorization ?? ""));
    if (auditedHere && h.built.has(opId) && res.statusCode < 400) {
      const rows = await h.su.query<{ action: string }>(
        `SELECT action FROM scf.audit_log WHERE request_id = $1`,
        [String(res.headers["x-request-id"])],
      );
      const actions = rows.rows.map((r) => r.action);
      expect(
        actions.some((a) => op.auditActions.includes(a)),
        `${opId} wrote ${JSON.stringify(actions)}`,
      ).toBe(true);
      for (const a of actions)
        expect(op.auditActions.concat(["member.removed"]), `${opId}: ${a}`).toContain(a);
      auditedOps.add(opId);
    }
    expect(problems, `${o.method} ${o.url} → ${res.statusCode} ${res.body.slice(0, 300)}`).toEqual(
      [],
    );
  }
  return res;
}

/** The `__Host-scf_session=…` pair from a response, for the next request's Cookie header. */
export function sessionCookieOf(res: LightMyRequestResponse): string {
  const set = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const c = set.find(
    (s) => s.startsWith("__Host-scf_session=") && !s.startsWith("__Host-scf_session=;"),
  );
  if (!c) throw new Error(`no session cookie in response ${res.statusCode}`);
  return c.split(";")[0] as string;
}

/** Full GitHub sign-in through the fake: start → approve → callback. Returns the session cookie. */
export async function signInGithub(
  h: Harness,
  user: FakeGithubUser,
  currentCookie?: string,
): Promise<string> {
  const start = await call(h, {
    method: "GET",
    url: "/v1/auth/github/start?return_to=/dashboard",
    cookie: currentCookie,
  });
  expect(start.statusCode).toBe(302);
  const oauthCookie = ([] as string[])
    .concat(start.headers["set-cookie"] ?? [])
    .find((s) => s.startsWith("__Host-scf_oauth="))
    ?.split(";")[0];
  const { code, state } = h.github.approve(String(start.headers.location), user);
  const cb = await call(h, {
    method: "GET",
    url: `/v1/auth/github/callback?code=${code}&state=${state}`,
    cookie: [oauthCookie, currentCookie].filter(Boolean).join("; "),
  });
  expect(cb.statusCode, cb.body).toBe(303);
  expect(cb.headers.location).toBe("/dashboard");
  return sessionCookieOf(cb);
}

let ghIds = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
export function newGithubUser(): FakeGithubUser {
  ghIds++;
  return { id: ghIds, login: `user${ghIds}`, created_at: "2020-01-01T00:00:00Z" };
}

export function uniqueSlug(prefix = "t"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Creates a tenant as the signed-in user and returns its id. */
export async function createTenant(
  h: Harness,
  cookie: string,
  slug = uniqueSlug(),
): Promise<string> {
  const res = await call(h, {
    method: "POST",
    url: "/v1/tenants",
    cookie,
    body: { slug, name: `Project ${slug}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().tenant_id as string;
}

/** The raw session token of a `__Host-scf_session=…` cookie pair. */
export function tokenOf(cookie: string): string {
  return cookie.split("=")[1] as string;
}

/** Moves the session's last fresh sign-in (and step-up) `minutes` into the past (C-87 / C-114 window tests). */
export async function ageSession(h: Harness, cookie: string, minutes: number): Promise<void> {
  await h.su.query(
    `UPDATE scf.auth_sessions
        SET reauthenticated_at = now() - make_interval(mins => $2),
            step_up_at = CASE WHEN step_up_at IS NULL THEN NULL ELSE now() - make_interval(mins => $2) END
      WHERE session_hash = sha256(convert_to($1, 'UTF8'))`,
    [tokenOf(cookie), minutes],
  );
}

/** Marks the session's sign-in as fresh again by repeating the GitHub round-trip as the same user (C-87). */
export async function reauthGithub(
  h: Harness,
  user: FakeGithubUser,
  cookie: string,
): Promise<string> {
  return signInGithub(h, user, cookie);
}

/** Verifies every hash chain touched so far, recomputing row hashes in TypeScript (data-model §5). */
export async function verifyAuditChain(h: Harness, chainId: string): Promise<number> {
  const rows = (
    await h.su.query<{ seq: string; prev_hash: Buffer; row_hash: Buffer; canonical: string }>(
      `SELECT seq::text, prev_hash, row_hash, scf.audit_canonical(a) AS canonical FROM scf.audit_log a
        WHERE chain_id = $1 ORDER BY a.seq`,
      [chainId],
    )
  ).rows;
  let prev: Buffer = Buffer.alloc(32);
  rows.forEach((r, i) => {
    expect(Number(r.seq)).toBe(i + 1);
    expect(r.prev_hash.equals(prev)).toBe(true);
    const h2 = createHash("sha256")
      .update(Buffer.concat([prev, Buffer.from(r.canonical, "utf8")]))
      .digest();
    expect(h2.equals(r.row_hash)).toBe(true);
    prev = r.row_hash;
  });
  const head = await h.su.query<{ last_seq: string; last_hash: Buffer }>(
    `SELECT last_seq::text, last_hash FROM scf.audit_chain_heads WHERE chain_id = $1`,
    [chainId],
  );
  if (rows.length > 0) {
    expect(Number(head.rows[0]?.last_seq)).toBe(rows.length);
    expect(head.rows[0]?.last_hash.equals(prev)).toBe(true);
  }
  return rows.length;
}

export const PLATFORM_CHAIN = "00000000-0000-0000-0000-000000000000";

/**
 * A complete SCF-operator session (C-09): GitHub sign-in, platform role granted (bootstrap seed, as superuser), first
 * passkey enrolled and asserted — so the returned cookie has a fresh step-up.
 */
export async function operatorSession(
  h: Harness,
  role: "operator" | "operator_admin",
  opts: { passkeys?: 1 | 2 } = {},
): Promise<{ cookie: string; userId: string; user: FakeGithubUser }> {
  const user = newGithubUser();
  const first = await signInGithub(h, user);
  const userId = (await call(h, { method: "GET", url: "/v1/me", cookie: first })).json()
    .user_id as string;
  await h.su.query(`INSERT INTO scf.platform_operators (user_id, role) VALUES ($1, $2)`, [
    userId,
    role,
  ]);
  const partial = await signInGithub(h, user);
  const auth = new SoftAuthenticator("portal.test", PORTAL);
  const regOpts = await call(h, {
    method: "POST",
    url: "/v1/auth/passkeys/registration/options",
    cookie: partial,
  });
  await call(h, {
    method: "POST",
    url: "/v1/auth/passkeys/registration/verify",
    cookie: partial,
    body: auth.register(regOpts.json()),
  });
  const aOpts = await call(h, {
    method: "POST",
    url: "/v1/auth/passkeys/assertion/options",
    cookie: partial,
  });
  const done = await call(h, {
    method: "POST",
    url: "/v1/auth/passkeys/assertion/verify",
    cookie: partial,
    body: auth.assert(aOpts.json()),
  });
  expect(done.statusCode, done.body).toBe(200);
  const cookie = sessionCookieOf(done);
  if ((opts.passkeys ?? 2) === 2) {
    // C-20: operators keep two passkeys (a second device); operator operations need both.
    const second = new SoftAuthenticator("portal.test", PORTAL);
    const o2 = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      cookie,
    });
    const r2 = await call(h, {
      method: "POST",
      url: "/v1/auth/passkeys/registration/verify",
      cookie,
      body: second.register(o2.json()),
    });
    expect(r2.statusCode, r2.body).toBeLessThan(300);
  }
  return { cookie, userId, user };
}
