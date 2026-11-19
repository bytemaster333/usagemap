// SPDX-License-Identifier: Apache-2.0
// Caller authentication of the hosted MCP server: the caller's own UsageMap key, or an OAuth access token issued for
// this server (src/oauth.ts: exchanged at the control plane, never passed on). This service holds no key of its own and
// never widens what a key or a grant may do.
//
//   - `scfa_oat_…` (OAuth access token, when OAuth is configured): exchanged (RFC 8693) for a short-lived control-plane
//     token; the grant is ONE tenant (tenant tools) or the SCF-operator view (operator tools). Refresh, delegated and
//     code values (`scfa_ort_`/`scfa_odt_`/`scfa_oac_`) are never accepted here.
//   - Only `Authorization: Bearer <key>`; a key anywhere in the URL is refused (and is to be treated as compromised).
//   - Grammar and CRC are checked offline (wire-formats §k), so malformed or mistyped keys never reach the control plane.
//   - `scfa_op_…` (SCF operator): verified by the control plane through `GET /op/v1/me`, which also returns the key's
//     scopes and tenant restriction; the answer is reused for a short time, keyed by SHA-256 of the whole key (a
//     different secret with the same public id is a different cache entry).
//   - `scfa_pub_…` (tenant share key): there is no introspection endpoint for share keys; the control plane verifies the
//     key on the one call it opens (`/public/v1/projects/{slug}/metrics.json`, its own tenant only, otherwise 404).
//   - `scfa_ing_…` (ingest tokens) are write-only credentials and are refused.

import { createHash } from "node:crypto";
import { ApiClient, ApiError, parseKeyOffline } from "../../../tools/mcp/src/api.ts";
import {
  ExchangeError,
  type Grant,
  isOAuthAccessToken,
  isOtherOAuthToken,
  type TokenExchanger,
} from "./oauth.ts";

export interface Caller {
  kind: "op" | "pub" | "oauth";
  /** Public lookup id of the key (not a secret; the control plane audits by it). */
  keyId: string;
  key: string;
  scopes?: string[];
  tenantRestriction?: string[] | null;
  /** OAuth callers: what the grant stands for, with the delegated control-plane token. */
  grant?: Grant;
}

export class AuthError extends Error {
  readonly status: number;
  readonly retryAfter: number | undefined;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Extracts the Bearer key; throws AuthError(401) for anything else. */
export function bearer(header: string | undefined): string {
  if (!header)
    throw new AuthError(401, "an Authorization: Bearer header with a UsageMap API key is required");
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  if (!m) throw new AuthError(401, "the Authorization header must be: Bearer <UsageMap API key>");
  return m[1] as string;
}

interface MeAnswer {
  key_id: string;
  scopes: string[];
  tenant_restriction: string[] | null;
  expires_at?: string;
}

export interface AuthenticatorOpts {
  controlPlaneUrl: string;
  allowInsecureUpstream: boolean;
  cacheMs: number;
  fetch?: typeof fetch | undefined;
  now?: () => number;
  /** OAuth access tokens (null: API keys only). */
  exchanger?: TokenExchanger | null;
}

export class Authenticator {
  readonly #o: AuthenticatorOpts;
  readonly #now: () => number;
  #cache = new Map<string, { until: number; me: MeAnswer }>();
  #pending = new Map<string, Promise<MeAnswer>>();

  constructor(o: AuthenticatorOpts) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** Authenticates one request's key. `headers` are forwarded to the control plane (client address only). */
  async authenticate(key: string, headers: Record<string, string> = {}): Promise<Caller> {
    if (isOAuthAccessToken(key)) {
      if (!this.#o.exchanger)
        throw new AuthError(401, "OAuth is not enabled on this server: use a UsageMap API key");
      try {
        const grant = await this.#o.exchanger.grantFor(key);
        return { kind: "oauth", keyId: grant.grantId, key: "", grant };
      } catch (e) {
        if (e instanceof ExchangeError) throw new AuthError(e.status, e.message, e.retryAfter);
        throw e;
      }
    }
    if (isOtherOAuthToken(key))
      throw new AuthError(401, "only OAuth access tokens issued for this server are accepted");
    const k = parseKeyOffline(key);
    if (!k) throw new AuthError(401, "not a valid UsageMap API key (format or checksum)");
    if (k.kind === "ing")
      throw new AuthError(
        401,
        "ingest tokens (scfa_ing_…) cannot read: use a tenant share key (scfa_pub_…) or an operator key (scfa_op_…)",
      );
    if (k.kind === "pub") return { kind: "pub", keyId: k.id, key };
    const me = await this.#introspect(key, headers);
    return {
      kind: "op",
      keyId: k.id,
      key,
      scopes: me.scopes,
      tenantRestriction: me.tenant_restriction,
    };
  }

  async #introspect(key: string, headers: Record<string, string>): Promise<MeAnswer> {
    const h = createHash("sha256").update(key).digest("base64url");
    const t = this.#now();
    const hit = this.#cache.get(h);
    if (hit && hit.until > t) return hit.me;
    const running = this.#pending.get(h);
    if (running) return running;
    const p = (async () => {
      const client = new ApiClient({
        baseUrl: this.#o.controlPlaneUrl,
        key,
        fetch: this.#o.fetch,
        userAgent: "usagemap-mcp-hosted/1",
        allowInsecureHttp: this.#o.allowInsecureUpstream,
        headers,
        timeoutMs: 10_000,
      });
      let me: MeAnswer;
      try {
        me = await client.get<MeAnswer>("/op/v1/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401)
          throw new AuthError(
            401,
            "the control plane refused the key: it is wrong, revoked or expired",
          );
        if (e instanceof ApiError && e.status === 429)
          throw new AuthError(429, "rate limited by the control plane", retryAfterOf(e.message));
        throw new AuthError(503, "the control plane is not reachable; try again shortly", 5);
      }
      if (!Array.isArray(me.scopes))
        throw new AuthError(503, "unexpected answer from the control plane", 5);
      if (this.#o.cacheMs > 0) {
        if (this.#cache.size > 10_000) this.#cache.clear();
        let until = this.#now() + this.#o.cacheMs;
        const exp = me.expires_at ? Date.parse(me.expires_at) : Number.NaN;
        if (Number.isFinite(exp)) until = Math.min(until, exp);
        this.#cache.set(h, { until, me });
      }
      return me;
    })();
    this.#pending.set(h, p);
    try {
      return await p;
    } finally {
      this.#pending.delete(h);
    }
  }
}

function retryAfterOf(message: string): number {
  const m = /retry after (\d+) s/.exec(message);
  return m ? Number(m[1]) : 60;
}
