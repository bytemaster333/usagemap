// SPDX-License-Identifier: Apache-2.0
// Configuration of the hosted MCP server, from the environment. The server holds no API key of its own — every tool
// call runs with the caller's Bearer key, or (OAuth) with a short-lived control-plane token exchanged for the caller's
// OAuth access token. The only secret is the OAuth exchange secret (shared with the control plane).
//
//   MCP_CONTROL_PLANE_URL        control-plane public API origin (required), e.g. http://control-plane:8080
//   MCP_ALLOW_INSECURE_UPSTREAM  "true" allows http to a non-loopback control-plane address (internal network only)
//   MCP_LISTEN_HOST / MCP_PORT   listen address (default 127.0.0.1:8080; the container sets 0.0.0.0)
//   MCP_PATH                     MCP endpoint path (default /mcp)
//   MCP_ALLOWED_ORIGINS          comma list of browser origins allowed to call (default none: any Origin header → 403)
//   MCP_TRUST_PROXY              comma list of proxy addresses whose X-Forwarded-For is believed (default none)
//   MCP_FORWARD_CLIENT_ADDRESS   "true" sends the caller's address to the control plane as X-Forwarded-For (only when
//                                the control plane trusts this service's address, SCF_TRUST_PROXY)
//   MCP_KEY_RATE_PER_MIN         MCP requests per key and minute (default 120)
//   MCP_AUTH_FAIL_PER_MIN        failed authentications per client subnet and minute before 429 (default 20)
//   MCP_MAX_INFLIGHT             concurrent requests before 503 (default 64)
//   MCP_INTROSPECT_CACHE_MS      how long an operator key's /op/v1/me answer (or an OAuth token exchange) is reused
//                                (default 30000, max 60000)
//   MCP_OAUTH_EXCHANGE_SECRET    (or *_FILE) secret of the confidential client `usagemap-mcp` at the control plane's
//                                token endpoint (= SCF_OAUTH_EXCHANGE_SECRET there). Set: OAuth access tokens are
//                                accepted and protected resource metadata (RFC 9728) is served. Unset: API keys only.
//   MCP_RESOURCE_URL             canonical URI of this server as clients reach it (required with OAuth), e.g.
//                                https://app.usagemap.dev/mcp — the `resource` tokens are bound to (RFC 8707)
//   MCP_AUTHORIZATION_SERVER     issuer of the authorization server (default: the origin of MCP_RESOURCE_URL)

import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export interface Config {
  controlPlaneUrl: string;
  allowInsecureUpstream: boolean;
  host: string;
  port: number;
  path: string;
  allowedOrigins: string[];
  trustProxy: string[];
  forwardClientAddress: boolean;
  keyRatePerMin: number;
  authFailPerMin: number;
  maxInflight: number;
  introspectCacheMs: number;
  /** OAuth (src/oauth.ts); null = API keys only. */
  oauth: { secret: string; resource: string; issuer: string } | null;
}

function int(env: NodeJS.ProcessEnv, name: string, d: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  if (v === undefined || v === "" || v === "false") return false;
  if (v === "true") return true;
  throw new Error(`${name} must be true or false`);
}

function list(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function secretOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** Canonical resource URI (RFC 8707 §2; MCP "Canonical Server URI"): no fragment, lower-case host, no lone "/". */
export function canonicalResource(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") ||
    raw.includes("#") ||
    u.username ||
    u.password
  )
    return null;
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

function oauthOf(env: NodeJS.ProcessEnv): Config["oauth"] {
  const secret = secretOf(env, "MCP_OAUTH_EXCHANGE_SECRET");
  if (secret === undefined) return null;
  if (secret.length < 32)
    throw new Error("MCP_OAUTH_EXCHANGE_SECRET must be at least 32 characters");
  const raw = env.MCP_RESOURCE_URL;
  if (!raw) throw new Error("MCP_RESOURCE_URL is required when MCP_OAUTH_EXCHANGE_SECRET is set");
  const resource = canonicalResource(raw);
  if (!resource)
    throw new Error("MCP_RESOURCE_URL must be an absolute http(s) URI without a fragment");
  const issuer = env.MCP_AUTHORIZATION_SERVER ?? new URL(resource).origin;
  if (!/^https?:\/\/[^#?\s]+$/.test(issuer))
    throw new Error("MCP_AUTHORIZATION_SERVER must be an issuer URL");
  return { secret, resource, issuer: issuer.replace(/\/$/, "") };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const cp = env.MCP_CONTROL_PLANE_URL;
  if (!cp) throw new Error("MCP_CONTROL_PLANE_URL is required");
  const u = new URL(cp);
  if (u.username || u.password || u.search || u.hash)
    throw new Error("MCP_CONTROL_PLANE_URL must not carry credentials, a query or a fragment");
  const path = env.MCP_PATH ?? "/mcp";
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new Error("MCP_PATH must be an absolute path");
  const origins = list(env, "MCP_ALLOWED_ORIGINS");
  for (const o of origins)
    if (new URL(o).origin !== o) throw new Error(`MCP_ALLOWED_ORIGINS: not an origin: ${o}`);
  const trust = list(env, "MCP_TRUST_PROXY");
  for (const a of trust) if (!isIP(a)) throw new Error(`MCP_TRUST_PROXY: not an IP address: ${a}`);
  return {
    controlPlaneUrl: u.href.replace(/\/$/, ""),
    allowInsecureUpstream: bool(env, "MCP_ALLOW_INSECURE_UPSTREAM"),
    host: env.MCP_LISTEN_HOST ?? "127.0.0.1",
    port: int(env, "MCP_PORT", 8080, 0, 65535),
    path,
    allowedOrigins: origins,
    trustProxy: trust,
    forwardClientAddress: bool(env, "MCP_FORWARD_CLIENT_ADDRESS"),
    keyRatePerMin: int(env, "MCP_KEY_RATE_PER_MIN", 120, 1, 100_000),
    authFailPerMin: int(env, "MCP_AUTH_FAIL_PER_MIN", 20, 1, 10_000),
    maxInflight: int(env, "MCP_MAX_INFLIGHT", 64, 1, 10_000),
    introspectCacheMs: int(env, "MCP_INTROSPECT_CACHE_MS", 30_000, 0, 60_000),
    oauth: oauthOf(env),
  };
}
