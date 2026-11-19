// SPDX-License-Identifier: Apache-2.0
// Mock control plane for the portal's browser tests: serves the built SPA under the production security headers
// (server/headers.ts) and answers /v1/* from fixtures. It follows the contract where the portal depends on it:
// CSRF (Origin + X-SCF-Request, C-20), problem+json errors, partial operator sessions (C-09, C-113), recent
// authentication and step-up (C-87, C-114), SEP-53 signatures (verified for real with Ed25519), WebAuthn challenges,
// the web read-path rules (whole UTC days for rollup ranges, `unit=hour` without visit metrics, C-112) — and every
// JSON body it sends is validated against the OpenAPI document, so a test cannot pass on data the API may not send.

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { ControlPlane } from "@usagemap/api-types";
import { CACHE_IMMUTABLE, CACHE_NONE, securityHeaders } from "../../server/headers.ts";
import {
  DOCS_BREAKDOWN,
  DOCS_PREVIOUS,
  DOCS_STATS,
  PRESET_RANGES,
  PRESET_SOURCE,
  rangeEcho,
  series,
  WALLET_BREAKDOWN,
  WALLET_STATS,
} from "../../test/fixtures/web.ts";
import { browserRpcHandlers } from "./mock-browser-rpc.ts";
import { type Answer, extraHandlers, MockProblem as Problem, seedExtra } from "./mock-extra.ts";
import { integrationsHandlers, seedIntegrations } from "./mock-integrations.ts";
import { keysHandlers, seedKeys } from "./mock-keys.ts";
import { onboardingHandlers } from "./mock-onboarding.ts";
import { operatorHandlers } from "./mock-operator.ts";
import { protocolsHandlers } from "./mock-protocols.ts";
import { reportHandlers } from "./mock-reports.ts";
import { MOCK_PASSPHRASE, seedTeam, setVerification, teamHandlers } from "./mock-team.ts";
import { usageMapHandlers } from "./mock-usagemap.ts";
import { assertValidResponse, findOperation } from "./openapi.ts";
import { buildChallenge, signedBy } from "./sep10.ts";

type Json = Record<string, unknown>;
type Site = ControlPlane.Site;
type Tenant = ControlPlane.Tenant;

const TEN_MIN = 10 * 60_000;

interface User {
  id: string;
  name: string;
  platformRole: "operator" | "operator_admin" | null;
  identities: ControlPlane.Identity[];
  passkeys: (ControlPlane.Passkey & { userHandle?: string })[];
  createdAt: string;
}

interface Sess {
  userId: string;
  firstFactor: "github" | "stellar_sep53" | "stellar_sep10";
  firstFactorAt: number;
  passkeyVerified: boolean;
  recentUntil: number | null;
  stepUpUntil: number | null;
  createdAt: number;
}

interface State {
  users: Map<string, User>;
  sessions: Map<string, Sess>;
  tenants: Map<string, Tenant & { members: Map<string, ControlPlane.TenantRole> }>;
  sites: Map<string, Site & { tenantId: string }>;
  domains: Map<string, ControlPlane.Domain & { siteId: string }>;
  verifications: Map<string, ControlPlane.DomainVerification>;
  challenges: Map<
    string,
    { account: string; method: "sep53" | "sep10"; message?: string; tx?: Buffer; expires: number }
  >;
  webauthn: Map<string, { userId: string; kind: "reg" | "auth" }>;
  githubStates: Map<string, string>;
  requests: { method: string; path: string; csrfHeader: boolean; origin: string | null }[];
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeAccountId(g: string): Buffer {
  if (!/^G[A-Z2-7]{55}$/.test(g)) throw new Error("not an account");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of g) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const raw = Buffer.from(out);
  if (raw.length !== 35 || raw[0] !== 6 << 3) throw new Error("not an account");
  let crc = 0;
  for (const byte of raw.subarray(0, 33)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  if (crc !== raw.readUInt16LE(33)) throw new Error("bad checksum");
  return raw.subarray(1, 33);
}

function verifySep53(account: string, message: string, sigB64: string): boolean {
  const sig = Buffer.from(sigB64, "base64");
  if (sig.length !== 64) return false;
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: decodeAccountId(account).toString("base64url") },
    format: "jwk",
  });
  const digest = createHash("sha256")
    .update(`Stellar Signed Message:\n${message}`, "utf8")
    .digest();
  return verify(null, digest, key, sig);
}

function accountKey(account: string): { raw: Buffer; key: KeyObject } {
  const raw = decodeAccountId(account);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
  return { raw: Buffer.from(raw), key };
}

/** The deployment's SEP-10 signing key (C-15) of the mock. */
function sep10Key(): { pub: Buffer; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { pub: Buffer.from(jwk.x, "base64url"), key: privateKey };
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(n: number): string {
  let out = "";
  for (const b of randomBytes(n)) out += B62[b % 62];
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function seed(): State {
  const now = Date.now();
  const st: State = {
    users: new Map(),
    sessions: new Map(),
    tenants: new Map(),
    sites: new Map(),
    domains: new Map(),
    verifications: new Map(),
    challenges: new Map(),
    webauthn: new Map(),
    githubStates: new Map(),
    requests: [],
  };
  const created = "2026-09-01T12:00:00Z";
  st.users.set("u-dev", {
    id: "u-dev",
    name: "octo-dev",
    platformRole: null,
    identities: [
      {
        identity_id: "11111111-1111-4111-8111-111111111111",
        provider: "github",
        display: "octo-dev",
        created_at: created,
        last_used_at: created,
      },
    ],
    passkeys: [],
    createdAt: created,
  });
  st.users.set("u-op", {
    id: "u-op",
    name: "scf-operator",
    platformRole: "operator",
    identities: [
      {
        identity_id: "22222222-2222-4222-8222-222222222222",
        provider: "github",
        display: "scf-operator",
        created_at: created,
        last_used_at: created,
      },
    ],
    passkeys: [],
    createdAt: created,
  });
  st.users.set("u-admin", {
    id: "u-admin",
    name: "scf-admin",
    platformRole: "operator_admin",
    identities: [
      {
        identity_id: "33333333-3333-4333-8333-333333333333",
        provider: "github",
        display: "scf-admin",
        created_at: created,
        last_used_at: created,
      },
    ],
    passkeys: [],
    createdAt: created,
  });
  const tenant = (id: string, slug: string, name: string, status: ControlPlane.TenantStatus) => ({
    tenant_id: id,
    slug,
    name,
    description: null,
    status,
    status_reason: null,
    verification_level: "L1" as const,
    created_at: created,
    removed_at: null,
    purge_after: null,
    onchain_correlation_enabled: false,
    public_stats_enabled: false,
    members: new Map<string, ControlPlane.TenantRole>([["u-dev", "owner"]]),
  });
  st.tenants.set(
    "a0000000-0000-4000-8000-000000000001",
    tenant("a0000000-0000-4000-8000-000000000001", "stellar-docs", "Stellar Docs", "active"),
  );
  st.tenants.set(
    "a0000000-0000-4000-8000-000000000002",
    tenant("a0000000-0000-4000-8000-000000000002", "pending-labs", "Pending Labs", "pending"),
  );
  addSite(
    st,
    "a0000000-0000-4000-8000-000000000001",
    "b0000000-0000-4000-8000-000000000001",
    "Docs site",
    "standard",
    "on",
    true,
  );
  addSite(
    st,
    "a0000000-0000-4000-8000-000000000001",
    "b0000000-0000-4000-8000-000000000002",
    "Wallet app",
    "strict",
    "off",
    false,
  );
  void now;
  return st;
}

function addSite(
  st: State,
  tenantId: string,
  siteId: string,
  name: string,
  profile: "standard" | "strict",
  visitorId: "on" | "off" | "off_in",
  anon: boolean,
): Site {
  const site = {
    tenantId,
    site_id: siteId,
    site_key: base62(22),
    name,
    tracker_profile: profile,
    visitor_id: visitorId,
    visitor_id_off_countries: [],
    exclude_countries: [],
    anonymous_reports: anon,
    path_folding: "full" as const,
    event_retention_days: null,
    opt_out_page_url: null,
    status: "active" as const,
    limits: { rate_limit_per_min: 6000, daily_quota: 1000000, verified_events_today: 4321 },
    created_at: "2026-09-02T08:00:00Z",
    effective_event_retention_days: 90,
  };
  st.sites.set(siteId, site);
  return site;
}

const TRACKER_INTEGRITY = {
  standard: "sha384-ZXN0YW5kYXJkLXRyYWNrZXItMS4wLjAtZml4dHVyZS1pbnRlZ3JpdHktdmFsdWUtMDAw",
  strict: "sha384-c3RyaWN0LXRyYWNrZXItMS4wLjAtZml4dHVyZS1pbnRlZ3JpdHktdmFsdWUtMDAwMDAw",
};
/** A second release (tracker.intentional-upgrade), published by POST /__mock/release-tracker: its own files and SRI hashes. */
const TRACKER_INTEGRITY_110 = {
  standard: "sha384-c3RhbmRhcmQtdHJhY2tlci0xLjEuMC1maXh0dXJlLWludGVncml0eS12YWx1ZS0wMDAw",
  strict: "sha384-c3RyaWN0LXRyYWNrZXItMS4xLjAtZml4dHVyZS1pbnRlZ3JpdHktdmFsdWUtMDAwMDAw",
};
const integrityOf = (version: string) =>
  version === "1.1.0" ? TRACKER_INTEGRITY_110 : TRACKER_INTEGRITY;

export interface MockServer {
  url: string;
  close(): Promise<void>;
}

export async function startMockServer(opts: {
  port: number;
  distDir: string;
  host?: string;
}): Promise<MockServer> {
  const host = opts.host ?? "localhost";
  const origin = `http://${host}:${opts.port}`;
  let st = seed();
  /** whether the second tracker release (1.1.0) is published (tracker.intentional-upgrade) */
  let trackerReleased = false;
  let ex = seedExtra(st.tenants);
  let team = seedTeam();
  let integ = seedIntegrations();
  let keysState = seedKeys();
  const SEP10 = sep10Key();
  /** whether the deployment has a SEP-10 signing key (POST /__mock/sep10) */
  let sep10On = true;
  /** ops.end-of-window-read-only read-only mode (POST /__mock/read-only): null = off. */
  let readOnly: { ingest: "accept" | "pause" } | null = null;
  const USER_UUIDS: Record<string, string> = {
    "u-dev": "c0000000-0000-4000-8000-000000000001",
    "u-op": "c0000000-0000-4000-8000-000000000002",
    "u-admin": "c0000000-0000-4000-8000-000000000003",
  };
  const userUuid = (id: string) => USER_UUIDS[id] ?? id;
  const userIdOf = (uuid: string) =>
    Object.entries(USER_UUIDS).find(([, u]) => u === uuid)?.[0] ??
    (st.users.has(uuid) ? uuid : undefined);

  const sessionOf = (req: IncomingMessage): { token: string; s: Sess } | null => {
    const m = /(?:^|;\s*)scf_mock_session=([^;]+)/.exec(req.headers.cookie ?? "");
    const token = m?.[1];
    const s = token ? st.sessions.get(token) : undefined;
    return token && s ? { token, s } : null;
  };

  const sessionView = (s: Sess): ControlPlane.Session => {
    const u = st.users.get(s.userId) as User;
    const operator = u.platformRole !== null;
    return {
      user_id: userUuid(u.id),
      kind: operator ? "operator" : "tenant_user",
      first_factor: s.firstFactor,
      passkey_verified: s.passkeyVerified,
      complete: !operator || s.passkeyVerified,
      platform_role: u.platformRole,
      step_up_valid_until: operator && s.stepUpUntil ? iso(s.stepUpUntil) : null,
      recent_auth_valid_until: s.recentUntil ? iso(s.recentUntil) : null,
      idle_expires_at: iso(Date.now() + 8 * 3600_000),
      absolute_expires_at: iso(s.createdAt + 7 * 86_400_000),
    };
  };

  const newSession = (res: ServerResponse, userId: string, factor: Sess["firstFactor"]): Sess => {
    const token = randomBytes(32).toString("base64url");
    const u = st.users.get(userId) as User;
    const now = Date.now();
    const s: Sess = {
      userId,
      firstFactor: factor,
      firstFactorAt: now,
      passkeyVerified: false,
      // A fresh first-factor sign-in is recent authentication only for members without a passkey (C-87).
      recentUntil: u.passkeys.length === 0 && u.platformRole === null ? now + TEN_MIN : null,
      stepUpUntil: null,
      createdAt: now,
    };
    st.sessions.set(token, s);
    res.setHeader("Set-Cookie", `scf_mock_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
    return s;
  };

  const requireSession = (req: IncomingMessage, allowPartial = false): Sess => {
    const c = sessionOf(req);
    if (!c) throw new Problem(401, "unauthenticated", "Authentication required");
    const v = sessionView(c.s);
    if (!v.complete && !allowPartial)
      throw new Problem(401, "unauthenticated", "Passkey step pending");
    return c.s;
  };

  const requireRecent = (s: Sess) => {
    const u = st.users.get(s.userId) as User;
    const now = Date.now();
    if (u.platformRole) {
      if (!s.stepUpUntil || s.stepUpUntil < now)
        throw new Problem(403, "step_up_required", "Passkey confirmation required");
    } else if (!s.recentUntil || s.recentUntil < now) {
      throw new Problem(403, "recent_auth_required", "Recent authentication required");
    }
  };

  const tenantFor = (s: Sess, tenantId: string) => {
    const t = st.tenants.get(tenantId);
    if (!t?.members.has(s.userId)) throw new Problem(404, "not_found", "Not found");
    return t;
  };
  const siteFor = (s: Sess, tenantId: string, siteId: string) => {
    tenantFor(s, tenantId);
    const site = st.sites.get(siteId);
    if (!site || site.tenantId !== tenantId) throw new Problem(404, "not_found", "Not found");
    return site;
  };
  const siteView = (site: Site & { tenantId: string }): Site => {
    const { tenantId: _t, ...rest } = site;
    return {
      ...rest,
      domains: [...st.domains.values()].filter((d) => d.siteId === site.site_id).map(domainView),
    };
  };
  const domainView = (d: ControlPlane.Domain & { siteId: string }): ControlPlane.Domain => {
    const { siteId: _s, ...rest } = d;
    return rest;
  };
  const tenantView = (t: Tenant & { members: unknown }): Tenant => {
    const { members: _m, ...rest } = t;
    return rest;
  };

  /** Resolves the range parameters like the control plane: presets from the fixture table, custom = whole days. */
  const resolveRange = (q: URLSearchParams, anonymized: boolean): ControlPlane.RangeEcho => {
    const range = q.get("range") ?? "30d";
    if (range === "custom") {
      const start = q.get("start");
      const end = q.get("end");
      const errors: Json[] = [];
      const midnight = (v: string | null) => !!v && /^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(v);
      if (!midnight(start))
        errors.push({ pointer: "/start", detail: "must be a UTC midnight (rollup part)" });
      if (!midnight(end))
        errors.push({ pointer: "/end", detail: "must be a UTC midnight (rollup part)" });
      if (errors.length === 0 && Date.parse(end as string) <= Date.parse(start as string))
        errors.push({ pointer: "/end", detail: "must be after start" });
      if (errors.length)
        throw new Problem(400, "validation_failed", "Validation failed", { errors });
      return rangeEcho(start as string, end as string, "rollup", anonymized);
    }
    const p = PRESET_RANGES[range];
    const src = PRESET_SOURCE[range];
    if (!p || !src)
      throw new Problem(400, "validation_failed", "Validation failed", {
        errors: [{ pointer: "/range", detail: "unknown preset" }],
      });
    const { source, ...extra } = src;
    return rangeEcho(p.start, p.end, source, anonymized, extra);
  };

  const handlers: Record<
    string,
    (ctx: {
      req: IncomingMessage;
      res: ServerResponse;
      q: URLSearchParams;
      p: Record<string, string>;
      body: Json;
    }) => Answer | Promise<Answer>
  > = {
    authGetSession: ({ req }) => {
      const c = sessionOf(req);
      if (!c) throw new Problem(401, "unauthenticated", "Authentication required");
      return { status: 200, body: sessionView(c.s) };
    },
    authLogout: ({ req, res }) => {
      const c = sessionOf(req);
      if (!c) throw new Problem(401, "unauthenticated", "Authentication required");
      st.sessions.delete(c.token);
      res.setHeader("Set-Cookie", "scf_mock_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return { status: 204 };
    },
    authStellarChallenge: ({ body }) => {
      const account = String(body.account ?? "");
      try {
        decodeAccountId(account);
      } catch {
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [{ pointer: "/account", detail: "invalid account id" }],
        });
      }
      const id = randomUUID();
      const now = Date.now();
      if (body.method === "sep10") {
        if (!sep10On)
          throw new Problem(503, "unavailable", "Temporarily unavailable", {
            detail: "SEP-10 is not configured on this deployment; use sep53",
          });
        const c = buildChallenge({
          serverPub: SEP10.pub,
          serverKey: SEP10.key,
          clientPub: accountKey(account).raw,
          homeDomain: "localhost",
          passphrase: MOCK_PASSPHRASE,
          nowS: Math.floor(now / 1000),
          ttlS: 900,
        });
        st.challenges.set(id, { account, method: "sep10", tx: c.tx, expires: now + 15 * 60_000 });
        return {
          status: 201,
          body: {
            challenge_id: id,
            method: "sep10",
            transaction_xdr: c.xdr,
            network_passphrase: MOCK_PASSPHRASE,
            expires_at: iso(now + 15 * 60_000),
          },
        };
      }
      const message = [
        "localhost wants you to sign in with your Stellar account:",
        account,
        "",
        "Purpose: sign in to UsageMap",
        "Signing this message does not send a transaction or cost a fee.",
        "Network: testnet",
        `Nonce: ${randomBytes(16).toString("base64url")}`,
        `Issued At: ${new Date(now).toISOString()}`,
        `Expiration Time: ${new Date(now + TEN_MIN).toISOString()}`,
      ].join("\n");
      st.challenges.set(id, { account, method: "sep53", message, expires: now + TEN_MIN });
      return {
        status: 201,
        body: { challenge_id: id, method: "sep53", message, expires_at: iso(now + TEN_MIN) },
      };
    },
    authStellarVerify: ({ req, res, body }) => {
      const ch = st.challenges.get(String(body.challenge_id));
      st.challenges.delete(String(body.challenge_id));
      const sep10 = typeof body.signed_transaction_xdr === "string";
      const valid =
        !!ch &&
        ch.expires >= Date.now() &&
        (sep10
          ? ch.method === "sep10" &&
            signedBy(
              body.signed_transaction_xdr as string,
              ch.tx as Buffer,
              accountKey(ch.account).key,
              MOCK_PASSPHRASE,
            )
          : ch.method === "sep53" &&
            typeof body.signature === "string" &&
            verifySep53(ch.account, ch.message as string, body.signature));
      if (!ch || !valid) throw new Problem(401, "unauthenticated", "Signature not accepted");
      let user = [...st.users.values()].find((u) =>
        u.identities.some((i) => i.provider === "stellar" && i.display === ch.account),
      );
      if (!user) {
        user = {
          id: randomUUID(),
          name: `${ch.account.slice(0, 5)}…${ch.account.slice(-4)}`,
          platformRole: null,
          identities: [
            {
              identity_id: randomUUID(),
              provider: "stellar",
              display: ch.account,
              created_at: iso(Date.now()),
              last_used_at: iso(Date.now()),
            },
          ],
          passkeys: [],
          createdAt: iso(Date.now()),
        };
        st.users.set(user.id, user);
      }
      const existing = sessionOf(req);
      if (existing && existing.s.userId === user.id) {
        // A fresh sign-in to the same account renews recent authentication (members without a passkey, C-87).
        if (user.passkeys.length === 0) existing.s.recentUntil = Date.now() + TEN_MIN;
        return { status: 200, body: sessionView(existing.s) };
      }
      return {
        status: 200,
        body: sessionView(newSession(res, user.id, sep10 ? "stellar_sep10" : "stellar_sep53")),
      };
    },
    authPasskeyRegistrationOptions: ({ req }) => {
      const s = requireSession(req, true);
      const u = st.users.get(s.userId) as User;
      const firstOperatorKey =
        u.platformRole !== null &&
        u.passkeys.length === 0 &&
        Date.now() - s.firstFactorAt < TEN_MIN;
      if (!firstOperatorKey) {
        if (!sessionView(s).complete)
          throw new Problem(401, "unauthenticated", "Passkey step pending");
        requireRecent(s);
      }
      const challenge = randomBytes(32).toString("base64url");
      st.webauthn.set(challenge, { userId: s.userId, kind: "reg" });
      return {
        status: 200,
        body: {
          challenge,
          rp: { name: "UsageMap", id: host },
          user: { id: Buffer.from(u.id).toString("base64url"), name: u.name, displayName: u.name },
          pubKeyCredParams: [
            { alg: -7, type: "public-key" },
            { alg: -257, type: "public-key" },
          ],
          timeout: 300000,
          attestation: "none",
          excludeCredentials: u.passkeys.map((p) => ({ id: p.credential_id, type: "public-key" })),
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        },
      };
    },
    authPasskeyRegistrationVerify: ({ req, body }) => {
      const s = requireSession(req, true);
      const cd = clientData(body);
      const c = st.webauthn.get(cd.challenge);
      st.webauthn.delete(cd.challenge);
      if (
        c?.kind !== "reg" ||
        c.userId !== s.userId ||
        cd.type !== "webauthn.create" ||
        cd.origin !== origin
      )
        throw new Problem(400, "validation_failed", "Unknown or expired WebAuthn challenge");
      const u = st.users.get(s.userId) as User;
      const pk = {
        credential_id: String(body.id),
        label: typeof body.label === "string" ? body.label : null,
        created_at: iso(Date.now()),
        last_used_at: null,
        backup_eligible: false,
      };
      u.passkeys.push(pk);
      return { status: 201, body: pk };
    },
    authPasskeyAssertionOptions: ({ req }) => {
      const s = requireSession(req, true);
      const u = st.users.get(s.userId) as User;
      if (u.passkeys.length === 0) throw new Problem(409, "conflict", "No passkey registered");
      const challenge = randomBytes(32).toString("base64url");
      st.webauthn.set(challenge, { userId: s.userId, kind: "auth" });
      return {
        status: 200,
        body: {
          challenge,
          rpId: host,
          allowCredentials: u.passkeys.map((p) => ({ id: p.credential_id, type: "public-key" })),
          userVerification: "required",
          timeout: 300000,
        },
      };
    },
    authPasskeyAssertionVerify: ({ req, body }) => {
      const s = requireSession(req, true);
      const cd = clientData(body);
      const c = st.webauthn.get(cd.challenge);
      st.webauthn.delete(cd.challenge);
      const u = st.users.get(s.userId) as User;
      if (
        c?.kind !== "auth" ||
        c.userId !== s.userId ||
        cd.type !== "webauthn.get" ||
        cd.origin !== origin ||
        !u.passkeys.some((p) => p.credential_id === body.id)
      )
        throw new Problem(401, "unauthenticated", "Passkey not accepted");
      const now = Date.now();
      s.passkeyVerified = true;
      s.recentUntil = now + TEN_MIN;
      if (u.platformRole) s.stepUpUntil = now + TEN_MIN;
      return { status: 200, body: sessionView(s) };
    },
    getMe: ({ req }) => {
      const s = requireSession(req);
      const u = st.users.get(s.userId) as User;
      return {
        status: 200,
        body: {
          user_id: sessionView(s).user_id,
          display_name: u.name,
          contact_email: null,
          created_at: u.createdAt,
          platform_role: u.platformRole,
          passkey_count: u.passkeys.length,
        },
      };
    },
    listMyIdentities: ({ req }) => ({
      status: 200,
      body: (st.users.get(requireSession(req).userId) as User).identities,
    }),
    unlinkIdentity: ({ req, p }) => {
      const s = requireSession(req);
      requireRecent(s);
      const u = st.users.get(s.userId) as User;
      if (!u.identities.some((i) => i.identity_id === p.identityId))
        throw new Problem(404, "not_found", "Not found");
      if (u.identities.length < 2)
        throw new Problem(409, "conflict", "The last sign-in identity cannot be removed");
      u.identities = u.identities.filter((i) => i.identity_id !== p.identityId);
      return { status: 204 };
    },
    listMyPasskeys: ({ req }) => ({
      status: 200,
      body: (st.users.get(requireSession(req).userId) as User).passkeys,
    }),
    deletePasskey: ({ req, p }) => {
      const s = requireSession(req);
      requireRecent(s);
      const u = st.users.get(s.userId) as User;
      if (!u.passkeys.some((k) => k.credential_id === p.credentialId))
        throw new Problem(404, "not_found", "Not found");
      u.passkeys = u.passkeys.filter((k) => k.credential_id !== p.credentialId);
      return { status: 204 };
    },
    listMyTenants: ({ req }) => {
      const s = requireSession(req);
      return {
        status: 200,
        body: [...st.tenants.values()]
          .filter((t) => t.members.has(s.userId))
          .map((t) => ({
            tenant_id: t.tenant_id,
            slug: t.slug,
            name: t.name,
            status: t.status,
            role: t.members.get(s.userId),
          })),
      };
    },
    createTenant: ({ req, body }) => {
      const s = requireSession(req);
      const slug = String(body.slug ?? "");
      if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug))
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [{ pointer: "/slug", detail: "lower-case letters, digits and hyphens" }],
        });
      if ([...st.tenants.values()].some((t) => t.slug === slug))
        throw new Problem(409, "conflict", "Conflict");
      const id = randomUUID();
      const t = {
        tenant_id: id,
        slug,
        name: String(body.name),
        description: (body.description as string | undefined) ?? null,
        status: "active" as const,
        status_reason: null,
        verification_level: "L0" as const,
        created_at: iso(Date.now()),
        removed_at: null,
        purge_after: null,
        onchain_correlation_enabled: false,
        public_stats_enabled: false,
        members: new Map<string, ControlPlane.TenantRole>([[s.userId, "owner"]]),
      };
      st.tenants.set(id, t);
      return { status: 201, body: tenantView(t) };
    },
    getTenant: ({ req, p }) => ({
      status: 200,
      body: tenantView(tenantFor(requireSession(req), p.tenantId as string)),
    }),
    listSites: ({ req, p }) => {
      const s = requireSession(req);
      tenantFor(s, p.tenantId as string);
      return {
        status: 200,
        body: [...st.sites.values()].filter((x) => x.tenantId === p.tenantId).map(siteView),
      };
    },
    createSite: ({ req, p, body }) => {
      const s = requireSession(req);
      tenantFor(s, p.tenantId as string);
      if (typeof body.name !== "string" || body.name.trim() === "")
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [{ pointer: "/name", detail: "required" }],
        });
      const site = addSite(
        st,
        p.tenantId as string,
        randomUUID(),
        body.name,
        (body.tracker_profile as "standard" | "strict") ?? "standard",
        (body.visitor_id as "on" | "off") ?? "on",
        true,
      );
      return { status: 201, body: siteView(site as Site & { tenantId: string }) };
    },
    getSite: ({ req, p }) => ({
      status: 200,
      body: siteView(siteFor(requireSession(req), p.tenantId as string, p.siteId as string)),
    }),
    updateSite: ({ req, p, body }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      if (body.tracker_profile === "standard" || body.tracker_profile === "strict")
        site.tracker_profile = body.tracker_profile;
      if (typeof body.name === "string") site.name = body.name;
      if (body.dev_origins !== undefined) {
        const list = body.dev_origins;
        const re =
          /^(localhost|127\.0\.0\.1|([a-z0-9-]*\*[a-z0-9-]*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/;
        if (
          !Array.isArray(list) ||
          list.length > 10 ||
          new Set(list).size !== list.length ||
          !list.every((o) => typeof o === "string" && re.test(o))
        )
          throw new Problem(400, "validation_failed", "Validation failed", {
            errors: [{ pointer: "/dev_origins", detail: "at most 10 distinct dev origins" }],
          });
        // wire-formats §a.8: never a bare wildcard directly above a public suffix
        if (list.some((o) => /^\*\.(vercel\.app|netlify\.app|pages\.dev)$/.test(o as string)))
          throw new Problem(400, "validation_failed", "Validation failed", {
            errors: [
              {
                pointer: "/dev_origins",
                detail: "a bare * above a public suffix admits every user of the host",
              },
            ],
          });
        Object.assign(site, { dev_origins: list as string[] });
      }
      return { status: 200, body: siteView(site) };
    },
    setSiteAnonymousReports: ({ req, p, body }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      site.anonymous_reports = body.anonymous_reports === true;
      return { status: 200, body: siteView(site) };
    },
    listDomains: ({ req, p }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      return {
        status: 200,
        body: [...st.domains.values()].filter((d) => d.siteId === site.site_id).map(domainView),
      };
    },
    addDomain: ({ req, p, body }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const hostName = String(body.host ?? "").toLowerCase();
      if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(hostName))
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [{ pointer: "/host", detail: "not a host name" }],
        });
      const d = {
        siteId: site.site_id,
        domain_id: randomUUID(),
        host: hostName,
        include_subdomains: body.include_subdomains === true,
        state: "unverified" as const,
        verified_at: null,
        grace_until: null,
        created_at: iso(Date.now()),
      };
      st.domains.set(d.domain_id, d);
      return { status: 201, body: domainView(d) };
    },
    removeDomain: ({ req, p }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const d = st.domains.get(p.domainId as string);
      if (!d || d.siteId !== site.site_id) throw new Problem(404, "not_found", "Not found");
      st.domains.delete(d.domain_id);
      return { status: 204 };
    },
    startDomainVerification: ({ req, p, body }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const d = st.domains.get(p.domainId as string);
      if (!d || d.siteId !== site.site_id) throw new Problem(404, "not_found", "Not found");
      const token = randomBytes(16).toString("hex");
      const method = body.method as ControlPlane.DomainVerification["method"];
      const v: ControlPlane.DomainVerification = {
        verification_id: randomUUID(),
        method,
        status: "pending",
        token,
        instructions: {
          dns_name: `_scf-verify.${d.host}`,
          dns_value: `scf-verify=${token}`,
          url: `https://${d.host}/.well-known/scf-verify.txt`,
          file_body: token,
          meta_tag: `<meta name="scf-site-verification" content="${token}">`,
        },
        expires_at: iso(Date.now() + 7 * 86_400_000),
        last_checked_at: null,
        last_result_code: null,
      };
      st.verifications.set(v.verification_id, v);
      return { status: 201, body: v };
    },
    checkDomainVerification: ({ req, p }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const d = st.domains.get(p.domainId as string);
      const v = st.verifications.get(p.verificationId as string);
      if (!d || d.siteId !== site.site_id || !v) throw new Problem(404, "not_found", "Not found");
      v.status = "verified";
      v.last_checked_at = iso(Date.now());
      v.last_result_code = "OK";
      d.state = "verified";
      d.verified_at = iso(Date.now());
      return { status: 202, body: v };
    },
    getInstallationCheck: ({ req, p, q }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const range = q.get("range") ?? "7d";
      const seeded = site.site_id === "b0000000-0000-4000-8000-000000000001";
      const k = range === "24h" ? 1 : range === "30d" ? 4 : 2;
      return {
        status: 200,
        body: {
          site_id: site.site_id,
          start:
            range === "24h"
              ? "2026-11-11T10:00:00Z"
              : range === "30d"
                ? "2026-10-14T00:00:00Z"
                : "2026-11-06T00:00:00Z",
          end: range === "24h" ? "2026-11-12T10:00:00Z" : "2026-11-13T00:00:00Z",
          tracker_version_seen: seeded ? "1.0.0" : null,
          verdicts: seeded
            ? { verified: 12000 * k, suspect: 640 * k, rejected: 311 * k }
            : { verified: 0, suspect: 0, rejected: 0 },
          reasons: seeded
            ? [
                { code: "proof_missing", verdict: "suspect", count: 420 * k },
                { code: "net_datacenter", verdict: "suspect", count: 220 * k },
                { code: "ua_bot", verdict: "rejected", count: 300 * k },
                { code: "origin_mismatch", verdict: "rejected", count: 11 * k },
              ]
            : [],
          drops: seeded ? [{ label: "engine_bot_drop", count: 3 * k }] : [],
          outdated_tracker: false,
          kit_present_pageviews: seeded ? 950 * k : 0,
          multiplicity: {
            mode: site.multiplicity_mode ?? ex.multiplicityMode,
            source: site.multiplicity_mode ? "site" : "platform",
            high_shadow: seeded ? 37 * k : 0,
          },
        },
      };
    },
    listTrackerVersions: () => ({
      status: 200,
      body: [
        ...(trackerReleased
          ? [
              {
                version: "1.1.0",
                status: "active" as const,
                released_at: "2026-12-01T00:00:00Z",
                files: (["standard", "strict"] as const).map((profile) => ({
                  profile,
                  url: `https://ingest.example.invalid/t/1.1.0/${profile}.js`,
                  integrity: TRACKER_INTEGRITY_110[profile],
                  gzip_bytes: profile === "standard" ? 3420 : 2470,
                })),
                advisory_url: null,
              },
            ]
          : []),
        {
          version: "1.0.0",
          status: "active",
          released_at: "2026-11-10T00:00:00Z",
          files: [
            {
              profile: "standard",
              url: "https://ingest.example.invalid/t/1.0.0/standard.js",
              integrity: TRACKER_INTEGRITY.standard,
              gzip_bytes: 3412,
            },
            {
              profile: "strict",
              url: "https://ingest.example.invalid/t/1.0.0/strict.js",
              integrity: TRACKER_INTEGRITY.strict,
              gzip_bytes: 2464,
            },
          ],
          advisory_url: null,
        },
      ],
    }),
    getSnippet: ({ req, p, q }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const format = q.get("format") ?? "html";
      // Every active version is served side by side (tracker.intentional-upgrade); without a choice, the newest.
      const served = trackerReleased ? ["1.1.0", "1.0.0"] : ["1.0.0"];
      const version = q.get("version") ?? (served[0] as string);
      if (!served.includes(version))
        throw new Problem(400, "validation_failed", "no active tracker version", {
          errors: [{ pointer: "/version", detail: "not an active tracker version" }],
        });
      const profile = site.tracker_profile;
      const src = `https://ingest.example.invalid/t/${version}/${profile}.js`;
      const integrity = integrityOf(version)[profile];
      const tag = `<script defer src="${src}" integrity="${integrity}" crossorigin="anonymous" data-site="${site.site_key}"${format === "consent_html" ? ' data-consent="required"' : ""}></script>`;
      const code =
        format === "html" || format === "consent_html"
          ? format === "consent_html"
            ? `${tag}\n<script>/* in your consent tool */ scfAnalytics.grantConsent();</script>`
            : tag
          : `npm install @usagemap/tracker@${version}\n\nimport { init } from "@usagemap/tracker${profile === "strict" ? "/strict" : ""}";\ninit({ site: "${site.site_key}" }); // ${format}`;
      return { status: 200, body: { format, version, integrity, code } };
    },
    getWebStats: ({ req, p, q }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const range = resolveRange(q, site.anonymous_reports);
      const docs = site.site_id === "b0000000-0000-4000-8000-000000000001";
      const base = docs
        ? DOCS_STATS
        : site.site_id === "b0000000-0000-4000-8000-000000000002"
          ? WALLET_STATS
          : EMPTY_STATS;
      const variant = q.get("variant") ?? "both";
      const pick = <T extends Json>(o: T) => {
        const out: Json = { ...o };
        if (variant === "verified") delete out.raw;
        if (variant === "raw") delete out.verified;
        return out;
      };
      const body: Json = { range, ...pick(base as Json) };
      if (q.get("compare") === "previous") {
        if ((q.get("range") ?? "30d") === "90d") {
          body.previous = null;
          body.comparison_unavailable = true;
        } else {
          body.previous = pick((docs ? DOCS_PREVIOUS : base) as Json);
          body.comparison_unavailable = false;
        }
      }
      return { status: 200, body };
    },
    getWebTimeseries: ({ req, p, q }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const range = resolveRange(q, site.anonymous_reports);
      const metrics = (q.get("metrics") ?? "pageviews,visitors").split(",");
      const days = (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000;
      const unit =
        (q.get("unit") as "hour" | "day" | "month" | null) ??
        (days <= 2 ? "hour" : days <= 92 ? "day" : "month");
      if (
        unit === "hour" &&
        metrics.some((m) =>
          ["visits", "bounces", "bounce_rate_pct", "avg_visit_duration_s"].includes(m),
        )
      )
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [{ pointer: "/metrics", detail: "visit metrics exist for unit=day|month only" }],
        });
      return { status: 200, body: series(range, unit, metrics) };
    },
    getWebBreakdown: ({ req, p, q }) => {
      const site = siteFor(requireSession(req), p.tenantId as string, p.siteId as string);
      const range = resolveRange(q, site.anonymous_reports);
      const dimension = q.get("dimension") as keyof typeof DOCS_BREAKDOWN;
      const table =
        site.site_id === "b0000000-0000-4000-8000-000000000001"
          ? DOCS_BREAKDOWN
          : site.site_id === "b0000000-0000-4000-8000-000000000002"
            ? WALLET_BREAKDOWN
            : null;
      const limit = Number(q.get("limit") ?? 20);
      const rows = table?.[dimension];
      const cut = (list: ControlPlane.BreakdownRow[]) => [
        ...list.filter((r) => !r.is_other).slice(0, limit),
        ...list.filter((r) => r.is_other),
      ];
      return {
        status: 200,
        body: {
          range,
          dimension,
          verified: rows ? cut(rows.verified) : [],
          raw: rows ? cut(rows.raw) : [],
          truncated: range.source !== "live",
        },
      };
    },
    exportWebDaily: () => ({ status: 200 }),
    getPublishedThresholds: () => ({
      status: 200,
      body: [
        { key: "op_min_count", value: 10, description: "Minimum count k", public: true },
        {
          key: "read_only_mode",
          value: { enabled: readOnly !== null, ingest: readOnly?.ingest ?? "accept" },
          description: "Read-only mode (ops.end-of-window-read-only)",
          public: true,
        },
      ],
    }),
    ...teamHandlers(
      {
        tenants: () => st.tenants,
        session: (req) => ({ userId: requireSession(req).userId }),
        userUuid,
        userIdOf,
        userName: (id) => st.users.get(id)?.name ?? null,
        verifySep53,
        accountKey,
        sep10: () => (sep10On ? SEP10 : null),
      },
      () => team,
    ),
    ...extraHandlers(
      {
        tenants: () => st.tenants,
        session: (req) => {
          const s = requireSession(req);
          return { userId: s.userId, role: (st.users.get(s.userId) as User).platformRole };
        },
        userDisplay: (userId) => st.users.get(userId)?.name ?? "deleted account",
        requireRecent: (req) => requireRecent(requireSession(req)),
        sites: () => st.sites,
        siteView,
      },
      () => ex,
    ),
    ...reportHandlers({
      site: (req, tenantId, siteId) => siteFor(requireSession(req), tenantId, siteId),
    }),
    ...onboardingHandlers({
      session: (req) => {
        const s = requireSession(req);
        return { userId: s.userId, role: (st.users.get(s.userId) as User).platformRole };
      },
      tenants: () => st.tenants,
      sites: () => st.sites,
      domains: () => st.domains,
      contracts: (tenantId) =>
        ex.d1.footprint
          .filter((i) => i.tenantId === tenantId)
          .flatMap((i) => (i.subject ? [i.subject] : [])),
      scriptTag: (site) => {
        const version = trackerReleased ? "1.1.0" : "1.0.0";
        const profile = site.tracker_profile;
        const src = `https://ingest.example.invalid/t/${version}/${profile}.js`;
        const integrity = integrityOf(version)[profile];
        return {
          version,
          code: `<script defer src="${src}" integrity="${integrity}" crossorigin="anonymous" data-site="${site.site_key}"></script>`,
        };
      },
      origin: (req) => `http://${req.headers.host ?? "localhost"}`,
    }),
    // integration catalogue (pick → generated config → test → live check)
    ...integrationsHandlers(
      {
        session: (req) => ({ userId: requireSession(req).userId }),
        tenants: () => st.tenants,
        sites: () => st.sites,
        services: () => ex.services,
        devEvents: (siteId) => ex.d1.devEvents.get(siteId) ?? [],
        scriptTag: (site) => {
          const version = trackerReleased ? "1.1.0" : "1.0.0";
          const profile = site.tracker_profile;
          const src = `https://ingest.example.invalid/t/${version}/${profile}.js`;
          return {
            version,
            code: `<script defer src="${src}" integrity="${integrityOf(version)[profile]}" crossorigin="anonymous" data-site="${site.site_key}"></script>`,
          };
        },
      },
      () => integ,
    ),
    // footprint registration keys and the user-tracking paragraph
    ...keysHandlers(
      {
        session: (req) => ({ userId: requireSession(req).userId }),
        tenants: () => st.tenants,
        sites: () => st.sites,
        requireRecent: (req) => requireRecent(requireSession(req)),
      },
      () => keysState,
    ),
    // Ecosystem Usage Map (FAKE projects)
    ...usageMapHandlers({
      session: (req) => {
        const s = requireSession(req);
        return { userId: s.userId, role: (st.users.get(s.userId) as User).platformRole };
      },
      member: (req, tenantId) => void tenantFor(requireSession(req), tenantId),
    }),
    // Protocol interactions (FAKE figures)
    ...protocolsHandlers({
      session: (req) => {
        const s = requireSession(req);
        return { userId: s.userId, role: (st.users.get(s.userId) as User).platformRole };
      },
      member: (req, tenantId) => void tenantFor(requireSession(req), tenantId),
    }),
    // SCF operator console: overview, verdicts, trust, campaigns, operators (Build 2; FAKE figures)
    ...operatorHandlers({
      session: (req) => {
        const s = requireSession(req);
        return { userId: s.userId, role: (st.users.get(s.userId) as User).platformRole };
      },
      tenants: () => st.tenants.values(),
      users: () => st.users,
    }),
    // Browser RPC/Horizon daily totals of a site (FAKE figures)
    ...browserRpcHandlers({
      site: (req, tenantId, siteId) => void siteFor(requireSession(req), tenantId, siteId),
    }),
  };

  const EMPTY_STATS = {
    verified: { pageviews: 0, pageviews_unidentified: 0, visitors: 0 },
    raw: { pageviews: 0, pageviews_unidentified: 0, visitors: 0 },
    visit_metrics: {
      visits: 0,
      bounces: 0,
      bounce_rate_pct: null,
      avg_visit_duration_s: null,
      suspect_pageview_share: null,
    },
  };

  const routes = Object.keys(handlers).map((id) => {
    const { path, method } = findOperation(id);
    const names: string[] = [];
    const re = new RegExp(
      `^${path
        .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
        .replace(/\{([A-Za-z0-9_]+)\}/g, (_m, n: string) => {
          names.push(n);
          return "([^/]+)";
        })}$`,
    );
    return { id, method: method.toUpperCase(), re, names };
  });

  const send = (res: ServerResponse, status: number, body?: unknown, type = "application/json") => {
    for (const [k, v] of Object.entries(securityHeaders("http"))) res.setHeader(k, v);
    res.setHeader("Cache-Control", CACHE_NONE);
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    res
      .writeHead(status, { "Content-Type": type })
      .end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const problem = (res: ServerResponse, opId: string | null, p: Problem) => {
    const body = {
      type: `${origin}/problems/${p.code}`,
      title: p.title,
      status: p.status,
      code: p.code,
      request_id: randomUUID(),
      ...p.extra,
    };
    // The control plane answers `409 conflict` on authPasskeyAssertionOptions when no passkey is registered, which
    // the OpenAPI document does not declare (reported as a contract change); such answers are checked as Problem.
    if (opId) assertValidResponse(opId, p.status, body, { undeclaredAsProblem: true });
    if (p.status === 429 || p.status === 503) res.setHeader("Retry-After", "10");
    send(res, p.status, body, "application/problem+json");
  };

  const readBody = (req: IncomingMessage): Promise<Json> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const s = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(s ? (JSON.parse(s) as Json) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

  const serveStatic = (res: ServerResponse, pathname: string) => {
    const types: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".html": "text/html; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(opts.distDir, safe);
    let isAsset = pathname.startsWith("/assets/");
    let exists = false;
    try {
      exists = statSync(file).isFile();
    } catch {
      exists = false;
    }
    // As server/Caddyfile: /docs/methodology/<semver> is the build-time page <semver>.html, never the SPA shell.
    if (!exists && pathname.startsWith("/docs/methodology/")) {
      try {
        exists = statSync(`${file}.html`).isFile();
      } catch {
        exists = false;
      }
      if (!exists) return send(res, 404, "not found", "text/plain");
      file = `${file}.html`;
    }
    if (!exists) {
      if (isAsset) return send(res, 404, "not found", "text/plain");
      file = join(opts.distDir, "index.html");
      isAsset = false;
    }
    for (const [k, v] of Object.entries(securityHeaders("http"))) res.setHeader(k, v);
    res.setHeader("Cache-Control", isAsset ? CACHE_IMMUTABLE : CACHE_NONE);
    res
      .writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" })
      .end(readFileSync(file));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const method = req.method ?? "GET";
    try {
      // --- test controls (never reachable by the page: it has no reason to call them) ---
      if (url.pathname === "/__mock/release-tracker" && method === "POST") {
        trackerReleased = true;
        return send(res, 204);
      }
      if (url.pathname === "/__mock/reset" && method === "POST") {
        trackerReleased = false;
        st = seed();
        ex = seedExtra(st.tenants);
        team = seedTeam();
        integ = seedIntegrations();
        keysState = seedKeys();
        sep10On = true;
        readOnly = null;
        return send(res, 204);
      }
      if (url.pathname === "/__mock/expire-recent-auth" && method === "POST") {
        for (const s of st.sessions.values()) {
          s.recentUntil = null;
          s.stepUpUntil = null;
        }
        return send(res, 204);
      }
      if (url.pathname === "/__mock/requests") return send(res, 200, st.requests);
      // A dev-origin event reaching the edge (C-136 §a.8): what the first-event panel lists.
      // The metrics writer counting the OTLP test curl's baseline point (cumulative_first_point) for a service.
      if (url.pathname === "/__mock/otlp-test-point" && method === "POST") {
        const id = String((await readBody(req)).service_id);
        integ.baseline.set(id, (integ.baseline.get(id) ?? 0) + 1);
        return send(res, 204);
      }
      if (url.pathname === "/__mock/dev-event" && method === "POST") {
        const b = await readBody(req);
        const siteId = String(b.site_id);
        const list = ex.d1.devEvents.get(siteId) ?? [];
        list.unshift({
          received_at: iso(Date.now()),
          kind: (b.kind as "pageview" | "custom" | "stellar" | undefined) ?? "pageview",
          event_name: String(b.event_name ?? "pageview"),
          path: String(b.path ?? "/"),
          would_be_verdict:
            (b.would_be_verdict as "verified" | "suspect" | "rejected" | undefined) ?? "verified",
          reason: (b.reason as string | null | undefined) ?? null,
        });
        ex.d1.devEvents.set(siteId, list.slice(0, 100));
        return send(res, 204);
      }
      if (url.pathname === "/__mock/read-only" && method === "POST") {
        const b = await readBody(req);
        readOnly =
          b.enabled === true ? { ingest: b.ingest === "pause" ? "pause" : "accept" } : null;
        return send(res, 204);
      }
      if (url.pathname === "/__mock/sep10" && method === "POST") {
        sep10On = (await readBody(req)).enabled !== false;
        return send(res, 204);
      }
      if (url.pathname === "/__mock/stellar-account" && method === "POST") {
        const b = await readBody(req);
        team.accounts.set(String(b.account), {
          home_domain: (b.home_domain as string | null | undefined) ?? null,
          listed: b.listed === true,
        });
        return send(res, 204);
      }
      if (url.pathname === "/__mock/verification" && method === "POST") {
        const b = await readBody(req);
        const t = st.tenants.get(String(b.tenant_id));
        if (!t) return send(res, 404);
        setVerification(
          team,
          t,
          b.level as ControlPlane.VerificationLevel,
          (b.domains as string[] | undefined) ?? [],
        );
        return send(res, 204);
      }
      // --- a stand-in for github.com's authorize page ---
      if (url.pathname === "/__mock/github/authorize") {
        const state = url.searchParams.get("state") ?? "";
        const link = (login: string) =>
          `/v1/auth/github/callback?code=${login}&state=${encodeURIComponent(state)}`;
        return send(
          res,
          200,
          `<!doctype html><html lang="en"><head><title>GitHub (mock)</title></head><body><main><h1>Authorize UsageMap</h1><p><a href="${link("octo-dev")}">Continue as octo-dev</a></p><p><a href="${link("scf-operator")}">Continue as scf-operator</a></p><p><a href="${link("scf-admin")}">Continue as scf-admin</a></p></main></body></html>`,
          "text/html; charset=utf-8",
        );
      }
      if (url.pathname === "/v1/auth/github/start" && method === "GET") {
        const returnTo = url.searchParams.get("return_to") ?? "/";
        if (
          !returnTo.startsWith("/") ||
          returnTo.startsWith("//") ||
          [...returnTo].some((ch) => ch === "\\" || ch.charCodeAt(0) < 0x20)
        )
          throw new Problem(400, "validation_failed", "Validation failed", {
            errors: [{ pointer: "/return_to", detail: "same-origin path only" }],
          });
        if (url.searchParams.get("link") === "true") {
          const s = requireSession(req);
          requireRecent(s);
        }
        const state = randomBytes(16).toString("base64url");
        st.githubStates.set(state, returnTo);
        res.setHeader("Location", `/__mock/github/authorize?state=${state}`);
        return send(res, 302);
      }
      if (url.pathname === "/v1/auth/github/callback" && method === "GET") {
        const state = url.searchParams.get("state") ?? "";
        const returnTo = st.githubStates.get(state);
        st.githubStates.delete(state);
        const login = url.searchParams.get("code");
        const user = [...st.users.values()].find((u) =>
          u.identities.some((i) => i.provider === "github" && i.display === login),
        );
        if (!returnTo || !user) throw new Problem(400, "validation_failed", "Invalid OAuth state");
        newSession(res, user.id, "github");
        res.setHeader("Location", returnTo);
        return send(res, 303);
      }
      // --- the API ---
      if (
        url.pathname.startsWith("/v1/") ||
        url.pathname.startsWith("/public/") ||
        url.pathname === "/.well-known/scf-snapshot-keys.json"
      ) {
        const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
        if (!route) throw new Problem(404, "not_found", "Not found");
        const changing = method !== "GET";
        st.requests.push({
          method,
          path: url.pathname,
          csrfHeader: req.headers["x-scf-request"] === "1",
          origin: req.headers.origin ?? null,
        });
        try {
          if (changing && (req.headers["x-scf-request"] !== "1" || req.headers.origin !== origin))
            throw new Problem(403, "csrf_failed", "CSRF check failed");
          // ops.end-of-window-read-only: every write is refused in read-only mode, except signing in and out.
          if (changing && readOnly && !route.id.startsWith("auth"))
            throw new Problem(403, "forbidden", "Forbidden", {
              detail: "the platform is in read-only mode",
            });
          const m = route.re.exec(url.pathname) as RegExpExecArray;
          const p: Record<string, string> = {};
          route.names.forEach((n, i) => {
            p[n] = decodeURIComponent(m[i + 1] as string);
          });
          const body = changing ? await readBody(req) : {};
          const handler = handlers[route.id] as (typeof handlers)[string];
          const out = await handler({ req, res, q: url.searchParams, p, body });
          if (route.id === "exportWebDaily") {
            res.setHeader("X-SCF-Source", "live");
            res.setHeader("X-SCF-Anonymized", "true");
            return send(
              res,
              200,
              "day,pageviews_verified,pageviews_raw\n2026-11-01,1230,1310\n",
              "text/csv",
            );
          }
          if (out.type) return send(res, out.status, out.body, out.type);
          if (out.body !== undefined) assertValidResponse(route.id, out.status, out.body);
          return send(res, out.status, out.body);
        } catch (e) {
          if (e instanceof Problem) return problem(res, route.id, e);
          throw e;
        }
      }
      if (method !== "GET" && method !== "HEAD")
        return send(res, 405, "method not allowed", "text/plain");
      return serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof Problem) return problem(res, null, e);
      console.error("mock server error:", e instanceof Error ? e.message : e);
      return send(
        res,
        500,
        {
          type: "about:blank",
          title: "Mock error",
          status: 500,
          detail: e instanceof Error ? e.message : String(e),
        },
        "application/problem+json",
      );
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  return {
    url: origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function clientData(body: Json): { challenge: string; type: string; origin: string } {
  const cd = (body.response as Json | undefined)?.clientDataJSON;
  if (typeof cd !== "string")
    throw new Problem(400, "validation_failed", "Malformed WebAuthn response");
  return JSON.parse(Buffer.from(cd, "base64url").toString("utf8")) as {
    challenge: string;
    type: string;
    origin: string;
  };
}
