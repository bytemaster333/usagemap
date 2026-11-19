// SPDX-License-Identifier: Apache-2.0
// Pure rules of the MCP OAuth authorization server (no I/O; unit-tested in test/unit/oauth.test.ts).
//
// Spec basis (checked 2026-11-19 on modelcontextprotocol.io, revision 2026-07-28 "Authorization", and Claude's
// connector authentication requirements on claude.com/docs/connectors/building/authentication):
//   - OAuth 2.1 (draft-ietf-oauth-v2-1-13): authorization code + PKCE; S256 is the only method accepted here;
//     exact redirect URI matching, except loopback redirects, which match with the port ignored (RFC 8252 §7.3;
//     Claude Code declares http://localhost/callback and http://127.0.0.1/callback and uses an ephemeral port).
//   - RFC 8707: the `resource` names the MCP server; a token is only ever issued for the configured MCP resource.
//   - Redirect URIs: https, or http on a loopback host. No fragment, no user info, no custom schemes.
//   - Tokens: 256-bit opaque values with a kind prefix, stored as SHA-256 only.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The only scope a resource needs (read-only access); `offline_access` is accepted and ignored (refresh tokens are always issued). */
export const READ_SCOPE = "usagemap:read";
export const OFFLINE_SCOPE = "offline_access";
export const SCOPES_SUPPORTED = [READ_SCOPE, OFFLINE_SCOPE] as const;

/** Audience of a delegated token (RFC 8693 token exchange): the control-plane API itself. */
export const CONTROL_PLANE_AUDIENCE = "usagemap-api";
export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export type TokenKind = "access" | "refresh" | "delegated" | "code";
const PREFIX: Record<TokenKind, string> = {
  access: "scfa_oat_",
  refresh: "scfa_ort_",
  delegated: "scfa_odt_",
  code: "scfa_oac_",
};
const TOKEN_RE = /^scfa_(oat|ort|odt|oac)_([A-Za-z0-9_-]{43})$/;
const KIND_OF: Record<string, TokenKind> = {
  oat: "access",
  ort: "refresh",
  odt: "delegated",
  oac: "code",
};

/** Lifetimes (ms). Operator grants follow the operator session (C-20: idle 30 min, absolute 12 h). */
export const LIFETIME = {
  request: 10 * 60_000,
  code: 60_000,
  access: 10 * 60_000,
  delegatedMax: 5 * 60_000,
  refreshTenant: 30 * 24 * 3_600_000,
  refreshOperator: 30 * 60_000,
  grantTenant: 90 * 24 * 3_600_000,
  grantOperator: 12 * 3_600_000,
} as const;

export function newToken(kind: TokenKind): string {
  return `${PREFIX[kind]}${randomBytes(32).toString("base64url")}`;
}

/** The kind of a well-formed token, or null. */
export function tokenKind(token: string): TokenKind | null {
  const m = TOKEN_RE.exec(token);
  return m ? (KIND_OF[m[1] as string] ?? null) : null;
}

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~]. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** base64url(SHA-256) without padding is exactly 43 characters. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** S256 check in constant time; false for a malformed verifier. */
export function verifyPkce(verifier: string | undefined, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return false;
  const a = Buffer.from(pkceChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A redirect URI a client may register: https, or http on a loopback host (RFC 8252 §7.3). Null when acceptable. */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
    return "redirect URI must be a string of at most 2048 characters";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "redirect URI is not an absolute URI";
  }
  if (raw.includes("#") || u.hash) return "redirect URI must not contain a fragment";
  if (u.username || u.password) return "redirect URI must not contain user information";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return "redirect URI must use https, or http on a loopback address (localhost, 127.0.0.1, [::1])";
}

export function isLoopbackRedirect(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether `presented` matches one of the registered redirect URIs: exact string comparison (OAuth 2.1 §2.3.1), except
 * that a loopback http redirect matches a registered one with the same host, path and query whatever the port.
 */
export function redirectMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  if (!isLoopbackRedirect(presented)) return false;
  const p = new URL(presented);
  return registered.some((r) => {
    if (!isLoopbackRedirect(r)) return false;
    const q = new URL(r);
    return q.hostname === p.hostname && q.pathname === p.pathname && q.search === p.search;
  });
}

/**
 * Canonical form of a resource indicator (RFC 8707 §2, MCP "Canonical Server URI"): absolute, no fragment, scheme and
 * host lower-cased (URL does that), a lone trailing slash removed. Null for anything else.
 */
export function canonicalResource(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512 || raw.includes("#"))
    return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/** The scopes granted for a requested `scope` string: always exactly READ_SCOPE; unknown scopes are an error. */
export function grantedScope(raw: unknown): { ok: true; scope: string } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, scope: READ_SCOPE };
  if (typeof raw !== "string" || raw.length > 256) return { ok: false };
  const parts = raw.split(" ").filter((s) => s !== "");
  for (const p of parts)
    if (!(SCOPES_SUPPORTED as readonly string[]).includes(p)) return { ok: false };
  return { ok: true, scope: READ_SCOPE };
}

/** C0/C1 controls, zero-width characters and bidirectional overrides/isolates. */
function unsafeChar(c: number): boolean {
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
  );
}

/** A client name safe to display: control and bidi-override characters removed, whitespace collapsed, ≤ 100 chars. */
export function cleanClientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = [...raw]
    .filter((ch) => !unsafeChar(ch.codePointAt(0) as number))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length === 0) return null;
  return s.slice(0, 100);
}

/** A Client ID Metadata Document URL (draft-ietf-oauth-client-id-metadata-document): https, a path, default port. */
export function isCimdClientId(raw: string): boolean {
  if (!raw.startsWith("https://") || raw.length > 512) return false;
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      u.port === "" &&
      u.pathname.length > 1 &&
      !u.hash &&
      !u.username &&
      !u.password &&
      u.href === raw
    );
  } catch {
    return false;
  }
}

/** Client ids issued by Dynamic Client Registration: `umc_` + 32 base64url characters. */
export const DCR_CLIENT_ID_RE = /^umc_[A-Za-z0-9_-]{32}$/;

export function newDcrClientId(): string {
  return `umc_${randomBytes(24).toString("base64url")}`;
}

export type ClientMetadataResult =
  | {
      ok: true;
      clientName: string;
      clientUri: string | null;
      redirectUris: string[];
    }
  | { ok: false; error: string; description: string };

/**
 * Validates client metadata, from a registration request (RFC 7591 §2, `expectedClientId` undefined) or a fetched
 * Client ID Metadata Document (`client_id` must equal the document URL). Only public clients: token endpoint
 * authentication `none`; grant types `authorization_code` (+ `refresh_token`); response type `code`.
 */
export function validateClientMetadata(
  doc: unknown,
  expectedClientId?: string,
): ClientMetadataResult {
  const bad = (error: string, description: string) => ({ ok: false as const, error, description });
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return bad("invalid_client_metadata", "metadata must be a JSON object");
  const d = doc as Record<string, unknown>;
  if (expectedClientId !== undefined && d.client_id !== expectedClientId)
    return bad("invalid_client_metadata", "client_id must equal the metadata document URL");
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10)
    return bad("invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs");
  for (const u of uris) {
    const p = redirectUriProblem(u);
    if (p) return bad("invalid_redirect_uri", p);
  }
  const auth = d.token_endpoint_auth_method ?? "none";
  if (auth !== "none")
    return bad(
      "invalid_client_metadata",
      "only public clients are supported: token_endpoint_auth_method must be none",
    );
  const grants = d.grant_types ?? ["authorization_code"];
  if (
    !Array.isArray(grants) ||
    !grants.includes("authorization_code") ||
    grants.some((g) => g !== "authorization_code" && g !== "refresh_token")
  )
    return bad(
      "invalid_client_metadata",
      "grant_types must be authorization_code (and optionally refresh_token)",
    );
  const responses = d.response_types ?? ["code"];
  if (!Array.isArray(responses) || responses.some((r) => r !== "code"))
    return bad("invalid_client_metadata", "response_types must be code");
  const name = d.client_name === undefined ? "Unnamed MCP client" : cleanClientName(d.client_name);
  if (!name) return bad("invalid_client_metadata", "client_name must be a non-empty string");
  let clientUri: string | null = null;
  if (d.client_uri !== undefined) {
    if (typeof d.client_uri !== "string" || d.client_uri.length > 512)
      return bad("invalid_client_metadata", "client_uri must be an https URI");
    try {
      const u = new URL(d.client_uri);
      if (u.protocol !== "https:") throw new Error();
      clientUri = u.href;
    } catch {
      return bad("invalid_client_metadata", "client_uri must be an https URI");
    }
  }
  return { ok: true, clientName: name, clientUri, redirectUris: [...new Set(uris as string[])] };
}

/** Appends OAuth response parameters to a redirect URI (keeps its own query). */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

/** The host a user sees on the consent page for a redirect URI. */
export function redirectHost(uri: string): string {
  return new URL(uri).host;
}
