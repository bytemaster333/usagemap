// SPDX-License-Identifier: Apache-2.0
// Configuration from the environment. Every secret can also be given as a file (`<NAME>_FILE`), which is how Compose
// and SOPS-decrypted deployments pass them; values are never logged.
//
// Listeners and edge identity (C-60, C-113, C-114):
//   SCF_LISTEN_HOST            public listener address (default 0.0.0.0), port SCF_PUBLIC_PORT (8080)
//   SCF_INTERNAL_LISTEN_HOST   internal edge API address (default SCF_LISTEN_HOST), port SCF_INTERNAL_PORT (8081)
//   SCF_INTERNAL_TLS_CERT / _KEY / _CA   server certificate, key and the CA that issues engine-proxy client certificates
//   SCF_INTERNAL_ALLOWED_CLIENTS         comma-separated client-certificate CNs (node names) of the engine proxies
//   Mutual TLS is the default and mandatory: without SCF_INTERNAL_TLS_CERT the process refuses to start unless
//   SCF_INTERNAL_LISTEN_HOST is a loopback address (then only loopback peers may name a node).
// Sign-in:
//   SCF_STELLAR_NETWORK        public (default) | testnet — the one network of this deployment; SCF_HORIZON_URL
//                              (or SCF_HORIZON_URL_PUBLIC / _TESTNET) its Horizon
//   SCF_SEP10_SIGNING_SEED     SEP-10 server signing key (`S…` seed, file recommended; C-15) — enables method sep10 for
//                              sign-in and Stellar-account linking (L2); its public key is SIGNING_KEY in stellar.toml
//   SCF_TRUST_PROXY            false (default) | true | comma-separated proxy addresses/CIDRs whose X-Forwarded-For
//                              names the client for per-subnet auth rate limits (never logged or stored)
//   SCF_CREATE_LIMIT_PER_HOUR  creating calls (sign-up, site and service creation) per client subnet per hour
//                              (default 60, C-64). Raise it only for test stacks whose suites create many tenants
//                              from one address; the per-user limit (20 per hour) is unchanged
//   SCF_RATE_LIMIT_SECRET      key of the HMAC that names rate-limit buckets in PostgreSQL (F21: the limits are shared
//                              by every instance and survive restarts; no address or user id is stored). Every
//                              instance needs the same value; default: derived from the configured peppers
//   SCF_RATE_LIMIT_STORE       postgres (default) | memory (one process only; tests)
// Operations (C-123 lean profile):
//   SCF_METRICS_LISTEN_HOST / SCF_METRICS_PORT  Prometheus `/metrics` (scf_cp_*), never on the public listener
//                              (default 127.0.0.1:9464; Compose binds it on the internal monitoring network)
//
// Not here (F16): edge-snapshot and traction-snapshot signing keys, scf_jobs and scf_umami_maint URLs, the
// provisioner certificate and admin password belong to the jobs service (src/workers/config.ts); this process refuses
// to start when one of them is configured.
// Umami (wire-formats §j; C-85) — live reads only (the reader certificate):
//   SCF_ENGINE_PROXY_URL       this core's engine proxy (reads R1–R5)
//   SCF_UMAMI_CREDS_KEYS       K_umami_creds versions, `<version>:<base64 of 32 bytes>[,…]` (AES-256-GCM, C-40), to
//                              decrypt the tenants' view-only API keys
//   SCF_WEB_LIVE_TIMEOUT_MS    per-call timeout of live reads (default 5000, C-112(6))
// Domain verification (ADR-0015, data-model §8.4): the worker runs in the jobs service (NOTIFY scf_verify); here only
//   SCF_VERIFIER_DNS_SERVERS   resolvers for the stellar.toml fetch of the L2 proof, comma-separated `ip[:port]`
// Onboarding:
//   SCF_NOTICE_TEXT_URL        URL of the privacy-notice text offered with the snippet (optional)
//
// Keys (wire-formats §k, C-81): one pepper set per kind, `<version>:<base64 of ≥ 32 bytes>[,…]`; `_VERSION` picks the
// version that hashes new keys (default: the highest). Without a set, creating keys of that kind answers 503.
//   SCF_PEPPER_ING / SCF_PEPPER_ING_VERSION   ingest tokens (shared with the edge nodes)
//   SCF_PEPPER_OP  / SCF_PEPPER_OP_VERSION    SCF-operator API keys (core only)
//   SCF_PEPPER_PUB / SCF_PEPPER_PUB_VERSION   share keys (core only)
//   SCF_PEPPER_REG / SCF_PEPPER_REG_VERSION   footprint registration keys (core only; optional: derived from
//                                             SCF_PEPPER_PUB when unset, keys/keys.ts footprintPepperSet)
//   SCF_DOCS_ORIGIN            public documentation site linked from generated texts (default https://docs.usagemap.dev)
//   SCF_OAUTH_*                MCP OAuth authorization server (src/oauth/config.ts)
//   SCF_OTLP_ENDPOINT          public OTLP endpoint shown in generated OpenTelemetry configs (optional)
//   SCF_METRICS_DATABASE_URL   `scf` as scf_metrics_ro (operator metrics API `/op/v1`); the API answers 503 when unset
//
// Erasure (data-model §8.8, §16): confirmed requests are executed by the jobs service (NOTIFY scf_erasure).
//
// Programme outputs (ADR-0032, wire-formats §i):
//   SCF_SNAPSHOT_PUBLIC_KEY    Ed25519 PUBLIC key (SPKI PEM) of the traction-snapshot key held by the jobs service
//                              (C-47, F16); without it creating a snapshot answers 503 and the JWKS has no current key
//   SCF_SNAPSHOT_KID           its key id in the JWKS (default `snap-1`); SCF_SNAPSHOT_KEY_NOT_BEFORE its validity start
//   SCF_SNAPSHOT_RETIRED_KEYS  JSON array of earlier public keys still published, `[{"kid","x","not_before","not_after"}]`
//   SCF_SNAPSHOT_WAIT_MS       how long a create waits for the jobs service's signature before answering 202 (10000)
//   SCF_HEALTH_INGEST_HOSTS    ingest hostnames and the edge nodes behind them, `host=node|node,host=node` (health_endpoint)
//   SCF_HEALTH_NODE_STALE_S    an edge node whose last counter report is older is `down` (default 300)
//   SCF_HEALTH_BACKLOG_DEGRADED  queued spool records on one node above which `processing` is degraded (default 10000)
//   SCF_STATUS_PAGE_URL        status page linked from the health_endpoint (optional)
//   SCF_SEAL_NETWORK, SCF_SEAL_NETWORK_PASSPHRASE, SCF_SEAL_HORIZON_URL, SCF_SEAL_EXPLORER_URL,
//   SCF_SEAL_LEDGER_FILES_URL  the daily seal's network as the public seal endpoints name it (wire-formats §m.2;
//                              src/programme/seal-network.ts); testnet by default (C-135). The sealing key is not here.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { NODE_NAME_RE } from "./edge/node.ts";
import { type Peppers, parsePepperSet } from "./keys/keys.ts";
import { type OAuthConfig, oauthConfig } from "./oauth/config.ts";
import { parseSealNetwork, type SealNetworkConfig } from "./programme/seal-network.ts";

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
  redirectUri: string;
}

export interface InternalTlsConfig {
  cert: string;
  key: string;
  ca: string;
  /**
   * Subject CNs of the client certificates allowed to call the internal edge API: the engine proxies' node names
   * (C-60, C-113). Only a request on such a connection may name an edge node in `X-Scf-Edge-Node`.
   */
  allowedClients: string[];
}

export type StellarNetwork = "public" | "testnet";

/** Umami through the engine proxy (C-60): one mTLS identity per role (certificate OU = role, CN = node name). */
export interface EngineConfig {
  url: string;
  ca: string;
  reader: { cert: string; key: string };
}

/** K_umami_creds (data-model §8.7): AES-256-GCM keys by version; `current` encrypts new ciphertexts. */
export interface UmamiCredsKeys {
  keys: Map<number, Buffer>;
  current: number;
}

export interface Config {
  host: string;
  publicPort: number;
  internalPort: number;
  /** Fully qualified origin of the portal, e.g. `https://portal.example.org` (CSRF Origin check, WebAuthn origin). */
  portalOrigin: string;
  problemBase: string;
  databaseUrl: string;
  databasePoolMax: number;
  github: GithubConfig | undefined;
  engine: EngineConfig | undefined;
  umami: {
    credsKeys: UmamiCredsKeys | undefined;
    /** Per-call timeout of live-window reads (C-112(6)). */
    liveTimeoutMs: number;
  };
  verifier: {
    /** `ip` or `ip:port` resolvers; undefined = the system's. */
    dnsServers: string[] | undefined;
  };
  stellar: {
    /** Service domain named in SEP-53 messages. */
    homeDomain: string;
    /** The one network this deployment signs in against (C-114); never chosen by the client. */
    network: StellarNetwork;
    /** Horizon of that network. */
    horizonUrl: string;
    /** SEP-10 server signing seed (`S…`, C-15); SEP-10 challenges answer 503 without it. Never logged. */
    sep10Seed: string | undefined;
  };
  webauthn: { rpId: string; rpName: string };
  edge: {
    /** Name of the header the engine proxy sets to the verified node id of the client certificate (C-60). */
    nodeHeader: string;
    /** Address of the internal listener; plain HTTP is allowed only on loopback (C-114). */
    internalHost: string;
    /** Mutual TLS of the internal listener; undefined only when `internalHost` is loopback. */
    tls: InternalTlsConfig | undefined;
  };
  tracker: {
    manifestDir: string | undefined;
    releasesFile: string | undefined;
    noticeTextUrl: string | undefined;
  };
  /**
   * `SCF_TRUST_PROXY`: the reverse proxies (the portal's) whose `X-Forwarded-For` names the client for the per-subnet
   * rate limits of unauthenticated auth routes — `true` (any peer), `false` (default: the peer itself) or a
   * comma-separated list of addresses/CIDRs. Behind a proxy that is not listed, every anonymous caller shares the
   * proxy's bucket. The address is used truncated (/24, /48), in memory only, and is never logged or stored.
   */
  trustProxy: string | boolean;
  /** Creating calls per client subnet per hour (SCF_CREATE_LIMIT_PER_HOUR, default 60, C-64). */
  createLimitPerHour: number;
  rateLimit: { store: "postgres" | "memory"; secret: Buffer };
  /** Prometheus listener (never the public one). */
  metrics: { host: string; port: number };
  logLevel: string;
  version: string;
  peppers: Peppers;
  /** Public OTLP endpoint shown in generated OpenTelemetry configs (`SCF_OTLP_ENDPOINT`). */
  otlpEndpoint: string | undefined;
  /** MCP OAuth authorization server (src/oauth/config.ts: SCF_OAUTH_*). */
  oauth: OAuthConfig;
  /** Public documentation site linked from generated texts (`SCF_DOCS_ORIGIN`). */
  docsOrigin: string;
  /** scf_metrics_ro connection for the operator metrics API (`/op/v1`); unset = that API answers 503. */
  metricsDatabaseUrl: string | undefined;
  programme: ProgrammeConfig;
}

/** A published snapshot-signing public key (JWKS entry, wire-formats §i.3). */
export interface SnapshotPublicKey {
  kid: string;
  /** base64url of the 32-byte Ed25519 public key */
  x: string;
  not_before?: string;
  not_after: string | null;
}

export interface ProgrammeConfig {
  snapshotPublicKeyPem: string | undefined;
  snapshotKid: string;
  snapshotWaitMs: number;
  snapshotKeyNotBefore: string | undefined;
  retiredSnapshotKeys: SnapshotPublicKey[];
  /** ingest hostname → edge nodes serving it (health_endpoint §i.2) */
  ingestHosts: Array<{ host: string; nodes: string[] }>;
  nodeStaleSeconds: number;
  backlogDegraded: number;
  statusPageUrl: string | undefined;
  /** The daily seal's network (wire-formats §m.2, C-135). */
  seal: SealNetworkConfig;
}

type Env = Record<string, string | undefined>;

function get(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

function req(env: Env, name: string): string {
  const v = get(env, name);
  if (v === undefined) throw new Error(`missing required configuration ${name}`);
  return v;
}

function int(env: Env, name: string, dflt: number): number {
  const v = get(env, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function positiveInt(env: Env, name: string, dflt: number): number {
  const n = int(env, name, dflt);
  if (n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

/** 127.0.0.0/8, ::1, ::ffff:127.x and `localhost`: the only addresses a plain-HTTP internal listener may bind. */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  const v4 = host.startsWith("::ffff:") ? host.slice(7) : host;
  if (isIP(v4) === 4) return v4.startsWith("127.");
  return host === "::1" || host === "0:0:0:0:0:0:0:1";
}

function trustProxy(v: string | undefined): string | boolean {
  if (v === undefined || v === "false") return false;
  if (v === "true") return true;
  const parts = v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of parts) {
    const [addr = "", bits, ...rest] = p.split("/");
    const fam = isIP(addr);
    const okBits =
      bits === undefined ||
      (/^\d{1,3}$/.test(bits) && Number(bits) <= (fam === 6 ? 128 : 32) && rest.length === 0);
    if (fam === 0 || !okBits)
      throw new Error("SCF_TRUST_PROXY must be true, false or a list of IP addresses / CIDRs");
  }
  if (parts.length === 0) return false;
  return parts.join(",");
}

function internalTls(env: Env, host: string): InternalTlsConfig | undefined {
  const cert = get(env, "SCF_INTERNAL_TLS_CERT");
  if (!cert) {
    if (!isLoopbackHost(host)) {
      throw new Error(
        "the internal edge API needs mutual TLS (SCF_INTERNAL_TLS_CERT, SCF_INTERNAL_TLS_KEY, SCF_INTERNAL_TLS_CA, " +
          "SCF_INTERNAL_ALLOWED_CLIENTS) unless SCF_INTERNAL_LISTEN_HOST is a loopback address",
      );
    }
    return undefined;
  }
  const key = req(env, "SCF_INTERNAL_TLS_KEY");
  const ca = req(env, "SCF_INTERNAL_TLS_CA");
  const allowed = (get(env, "SCF_INTERNAL_ALLOWED_CLIENTS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0 || !allowed.every((cn) => NODE_NAME_RE.test(cn))) {
    throw new Error(
      "SCF_INTERNAL_ALLOWED_CLIENTS must list the engine proxies' client-certificate CNs (node names)",
    );
  }
  return { cert, key, ca, allowedClients: allowed };
}

/** `1:<base64>,2:<base64>` → keys by version; each key must be exactly 32 bytes. */
export function parseCredsKeys(
  v: string | undefined,
  versionVar: string | undefined,
): UmamiCredsKeys | undefined {
  if (v === undefined) return undefined;
  const keys = new Map<number, Buffer>();
  for (const part of v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^([1-9][0-9]{0,4}):([A-Za-z0-9+/_=-]+)$/.exec(part);
    const key = m ? Buffer.from(m[2] as string, "base64") : undefined;
    if (!m || !key || key.length !== 32 || Number(m[1]) > 32767)
      throw new Error(
        "SCF_UMAMI_CREDS_KEYS must be `<version>:<base64 of 32 bytes>`, comma-separated",
      );
    keys.set(Number(m[1]), key);
  }
  if (keys.size === 0) throw new Error("SCF_UMAMI_CREDS_KEYS is empty");
  const current = versionVar === undefined ? Math.max(...keys.keys()) : Number(versionVar);
  if (!keys.has(current))
    throw new Error("SCF_UMAMI_CREDS_KEY_VERSION names no key in SCF_UMAMI_CREDS_KEYS");
  return { keys, current };
}

function list(v: string | undefined): string[] | undefined {
  const items = (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function stellarNetwork(v: string | undefined): StellarNetwork {
  if (v === undefined || v === "public") return "public";
  if (v === "testnet") return "testnet";
  throw new Error("SCF_STELLAR_NETWORK must be public or testnet");
}

function origin(v: string, name: string): string {
  const u = new URL(v);
  if (u.origin !== v.replace(/\/$/, ""))
    throw new Error(`${name} must be an origin (scheme://host[:port])`);
  return u.origin;
}

/**
 * Secrets that only the jobs service may hold (F16). A control plane configured with one of them refuses to start, so a
 * leftover deployment setting cannot silently put a signing key back into the internet-facing process.
 */
export const JOBS_ONLY_SETTINGS = [
  "SCF_JOBS_DATABASE_URL",
  "SCF_JOBS_LISTEN_DATABASE_URL",
  "SCF_UMAMI_MAINT_URL",
  "SCF_EDGE_SIGNING_KEY",
  "SCF_SNAPSHOT_SIGNING_KEY",
  "SCF_ENGINE_PROXY_PROVISIONER_CERT",
  "SCF_ENGINE_PROXY_PROVISIONER_KEY",
  "SCF_UMAMI_PROVISIONER_PASSWORD",
] as const;

function rateLimitSecret(env: Env, peppers: Peppers): Buffer {
  const explicit = get(env, "SCF_RATE_LIMIT_SECRET");
  if (explicit) {
    if (Buffer.byteLength(explicit) < 32)
      throw new Error("SCF_RATE_LIMIT_SECRET must be at least 32 bytes");
    return createHash("sha256").update("scf-rate-limit/1\0").update(explicit).digest();
  }
  // Derived from the pepper sets (shared by every instance of a deployment), so no extra secret is required.
  const h = createHash("sha256").update("scf-rate-limit/derived/1\0");
  for (const set of [peppers.ing, peppers.op, peppers.pub]) {
    if (!set) continue;
    for (const v of [...set.peppers.keys()].sort((a, b) => a - b)) {
      h.update(String(v)).update(set.peppers.get(v) as Buffer);
    }
  }
  return h.digest();
}

export function loadConfig(env: Env = process.env): Config {
  const present = JOBS_ONLY_SETTINGS.filter((n) => get(env, n) !== undefined);
  if (present.length > 0)
    throw new Error(`${present.join(", ")} belong to the jobs service, not to the control plane`);
  const portalOrigin = origin(req(env, "SCF_PORTAL_ORIGIN"), "SCF_PORTAL_ORIGIN");
  const githubId = get(env, "SCF_GITHUB_CLIENT_ID");
  const host = get(env, "SCF_LISTEN_HOST") ?? "0.0.0.0";
  const internalHost = get(env, "SCF_INTERNAL_LISTEN_HOST") ?? host;
  const network = stellarNetwork(get(env, "SCF_STELLAR_NETWORK"));
  const engineUrl = get(env, "SCF_ENGINE_PROXY_URL");
  const peppers: Peppers = {
    ing: parsePepperSet(
      "SCF_PEPPER_ING",
      get(env, "SCF_PEPPER_ING"),
      get(env, "SCF_PEPPER_ING_VERSION"),
    ),
    op: parsePepperSet(
      "SCF_PEPPER_OP",
      get(env, "SCF_PEPPER_OP"),
      get(env, "SCF_PEPPER_OP_VERSION"),
    ),
    pub: parsePepperSet(
      "SCF_PEPPER_PUB",
      get(env, "SCF_PEPPER_PUB"),
      get(env, "SCF_PEPPER_PUB_VERSION"),
    ),
    reg: parsePepperSet(
      "SCF_PEPPER_REG",
      get(env, "SCF_PEPPER_REG"),
      get(env, "SCF_PEPPER_REG_VERSION"),
    ),
  };
  const store = get(env, "SCF_RATE_LIMIT_STORE") ?? "postgres";
  if (store !== "postgres" && store !== "memory")
    throw new Error("SCF_RATE_LIMIT_STORE must be postgres or memory");
  return {
    host,
    publicPort: int(env, "SCF_PUBLIC_PORT", 8080),
    internalPort: int(env, "SCF_INTERNAL_PORT", 8081),
    portalOrigin,
    problemBase: get(env, "SCF_PROBLEM_BASE") ?? `${portalOrigin}/problems/`,
    databaseUrl: req(env, "SCF_DATABASE_URL"),
    databasePoolMax: int(env, "SCF_DATABASE_POOL_MAX", 10),
    github: githubId
      ? {
          clientId: githubId,
          clientSecret: req(env, "SCF_GITHUB_CLIENT_SECRET"),
          authorizeUrl:
            get(env, "SCF_GITHUB_AUTHORIZE_URL") ?? "https://github.com/login/oauth/authorize",
          tokenUrl:
            get(env, "SCF_GITHUB_TOKEN_URL") ?? "https://github.com/login/oauth/access_token",
          apiUrl: get(env, "SCF_GITHUB_API_URL") ?? "https://api.github.com",
          redirectUri:
            get(env, "SCF_GITHUB_REDIRECT_URI") ?? `${portalOrigin}/v1/auth/github/callback`,
        }
      : undefined,
    engine: engineUrl
      ? {
          url: engineUrl,
          ca: req(env, "SCF_ENGINE_PROXY_CA"),
          reader: {
            cert: req(env, "SCF_ENGINE_PROXY_READER_CERT"),
            key: req(env, "SCF_ENGINE_PROXY_READER_KEY"),
          },
        }
      : undefined,
    umami: {
      credsKeys: parseCredsKeys(
        get(env, "SCF_UMAMI_CREDS_KEYS"),
        get(env, "SCF_UMAMI_CREDS_KEY_VERSION"),
      ),
      liveTimeoutMs: int(env, "SCF_WEB_LIVE_TIMEOUT_MS", 5_000),
    },
    verifier: {
      dnsServers: list(get(env, "SCF_VERIFIER_DNS_SERVERS")),
    },
    stellar: {
      homeDomain: get(env, "SCF_STELLAR_HOME_DOMAIN") ?? new URL(portalOrigin).hostname,
      network,
      horizonUrl:
        get(env, "SCF_HORIZON_URL") ??
        (network === "public"
          ? (get(env, "SCF_HORIZON_URL_PUBLIC") ?? "https://horizon.stellar.org")
          : (get(env, "SCF_HORIZON_URL_TESTNET") ?? "https://horizon-testnet.stellar.org")),
      sep10Seed: get(env, "SCF_SEP10_SIGNING_SEED"),
    },
    webauthn: {
      rpId: get(env, "SCF_WEBAUTHN_RP_ID") ?? new URL(portalOrigin).hostname,
      rpName: get(env, "SCF_WEBAUTHN_RP_NAME") ?? "UsageMap",
    },
    edge: {
      nodeHeader: (get(env, "SCF_EDGE_NODE_HEADER") ?? "x-scf-edge-node").toLowerCase(),
      internalHost,
      tls: internalTls(env, internalHost),
    },
    tracker: {
      manifestDir: get(env, "SCF_TRACKER_MANIFEST_DIR"),
      releasesFile: get(env, "SCF_TRACKER_RELEASES_FILE"),
      noticeTextUrl: get(env, "SCF_NOTICE_TEXT_URL"),
    },
    trustProxy: trustProxy(get(env, "SCF_TRUST_PROXY")),
    createLimitPerHour: positiveInt(env, "SCF_CREATE_LIMIT_PER_HOUR", 60),
    rateLimit: { store, secret: rateLimitSecret(env, peppers) },
    metrics: {
      host: get(env, "SCF_METRICS_LISTEN_HOST") ?? "127.0.0.1",
      port: int(env, "SCF_METRICS_PORT", 9464),
    },
    logLevel: get(env, "SCF_LOG_LEVEL") ?? "info",
    version: get(env, "SCF_VERSION") ?? "0.1.0",
    peppers,
    otlpEndpoint: get(env, "SCF_OTLP_ENDPOINT"),
    docsOrigin: origin(
      get(env, "SCF_DOCS_ORIGIN") ?? "https://docs.usagemap.dev",
      "SCF_DOCS_ORIGIN",
    ),
    metricsDatabaseUrl: get(env, "SCF_METRICS_DATABASE_URL"),
    programme: programmeConfig(env),
    oauth: oauthConfig((n) => get(env, n), portalOrigin),
  };
}

function isoOrUndefined(v: string | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`${name} must be an RFC 3339 time`);
  return new Date(t).toISOString().replace(/\.000Z$/, "Z");
}

export function parseRetiredKeys(v: string | undefined): SnapshotPublicKey[] {
  if (v === undefined) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(v);
  } catch {
    throw new Error("SCF_SNAPSHOT_RETIRED_KEYS must be a JSON array");
  }
  if (!Array.isArray(raw)) throw new Error("SCF_SNAPSHOT_RETIRED_KEYS must be a JSON array");
  return raw.map((e: unknown) => {
    const o = (e ?? {}) as Record<string, unknown>;
    if (typeof o.kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(o.kid))
      throw new Error("SCF_SNAPSHOT_RETIRED_KEYS: invalid kid");
    if (typeof o.x !== "string" || Buffer.from(o.x, "base64url").length !== 32)
      throw new Error("SCF_SNAPSHOT_RETIRED_KEYS: x must be a base64url Ed25519 public key");
    if (typeof o.not_after !== "string")
      throw new Error("SCF_SNAPSHOT_RETIRED_KEYS: a retired key needs not_after");
    const nb = isoOrUndefined(
      typeof o.not_before === "string" ? o.not_before : undefined,
      "not_before",
    );
    return {
      kid: o.kid,
      x: o.x,
      ...(nb ? { not_before: nb } : {}),
      not_after: isoOrUndefined(o.not_after, "not_after") as string,
    };
  });
}

export function parseIngestHosts(v: string | undefined): Array<{ host: string; nodes: string[] }> {
  if (v === undefined) return [];
  return v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m =
        /^([a-z0-9.-]{1,253})=([a-z0-9][a-z0-9-]{1,31}(?:\|[a-z0-9][a-z0-9-]{1,31})*)$/.exec(p);
      if (!m) throw new Error("SCF_HEALTH_INGEST_HOSTS must be `host=node|node,…`");
      return { host: m[1] as string, nodes: (m[2] as string).split("|") };
    });
}

function programmeConfig(env: Env): ProgrammeConfig {
  const kid = get(env, "SCF_SNAPSHOT_KID") ?? "snap-1";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid))
    throw new Error("SCF_SNAPSHOT_KID is not a valid key id");
  return {
    snapshotPublicKeyPem: get(env, "SCF_SNAPSHOT_PUBLIC_KEY"),
    snapshotKid: kid,
    snapshotWaitMs: int(env, "SCF_SNAPSHOT_WAIT_MS", 10_000),
    snapshotKeyNotBefore: isoOrUndefined(
      get(env, "SCF_SNAPSHOT_KEY_NOT_BEFORE"),
      "SCF_SNAPSHOT_KEY_NOT_BEFORE",
    ),
    retiredSnapshotKeys: parseRetiredKeys(get(env, "SCF_SNAPSHOT_RETIRED_KEYS")),
    ingestHosts: parseIngestHosts(get(env, "SCF_HEALTH_INGEST_HOSTS")),
    nodeStaleSeconds: int(env, "SCF_HEALTH_NODE_STALE_S", 300),
    backlogDegraded: int(env, "SCF_HEALTH_BACKLOG_DEGRADED", 10_000),
    statusPageUrl: get(env, "SCF_STATUS_PAGE_URL"),
    seal: parseSealNetwork((n) => get(env, n)),
  };
}
