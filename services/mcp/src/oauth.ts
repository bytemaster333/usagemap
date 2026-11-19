// SPDX-License-Identifier: Apache-2.0
// OAuth at the hosted MCP server (MCP authorization, revision 2026-07-28; checked on modelcontextprotocol.io and
// claude.com/docs/connectors/building/authentication on 2026-11-19).
//
// The server is an OAuth 2.1 resource server. It
//   - publishes Protected Resource Metadata (RFC 9728) at /.well-known/oauth-protected-resource<path> and at the root
//     well-known URI, naming the control plane as the authorization server and `usagemap:read` as the only scope;
//   - answers 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="usagemap:read"` (Claude needs the 401
//     with the pointer to start sign-in);
//   - accepts only OAuth access tokens issued for ITS resource (`scfa_oat_…`), and never passes them on: for every new
//     token it asks the control plane, authenticated as the confidential client `usagemap-mcp`, to exchange it
//     (RFC 8693) for a ≤ 5-minute control-plane token. The exchange is the validation (the authorization server checks
//     the token is live and bound to this resource, RFC 8707, and that the user still holds the access) and yields
//     what the token stands for (one tenant, or the SCF-operator view).
//
// Why exchange and not a self-validated signed JWT: the control plane must see every call anyway (it authorises and
// audits each read), revocation must take effect at once (a JWT stays valid until it expires), no signing key has to be
// distributed, rotated or protected, and the spec forbids passing the client's token through to an upstream API.

import { createHash } from "node:crypto";

export const READ_SCOPE = "usagemap:read";
export const EXCHANGE_CLIENT_ID = "usagemap-mcp";
const ACCESS_TOKEN_RE = /^scfa_oat_[A-Za-z0-9_-]{43}$/;
/** Other OAuth token kinds of the authorization server: never accepted here (refresh, delegated, code). */
const OTHER_OAUTH_RE = /^scfa_o(rt|dt|ac)_/;

export function isOAuthAccessToken(token: string): boolean {
  return ACCESS_TOKEN_RE.test(token);
}

export function isOtherOAuthToken(token: string): boolean {
  return OTHER_OAUTH_RE.test(token);
}

export interface OAuthSettings {
  secret: string;
  resource: string;
  issuer: string;
}

/** Path of the RFC 9728 metadata for a resource: `/.well-known/oauth-protected-resource` + the resource's path. */
export function metadataPath(resource: string): string {
  const p = new URL(resource).pathname;
  return `/.well-known/oauth-protected-resource${p === "/" ? "" : p}`;
}

export function metadataUrl(o: OAuthSettings): string {
  return `${new URL(o.resource).origin}${metadataPath(o.resource)}`;
}

/** Protected Resource Metadata (RFC 9728 §2). */
export function resourceMetadata(o: OAuthSettings): Record<string, unknown> {
  return {
    resource: o.resource,
    authorization_servers: [o.issuer],
    scopes_supported: [READ_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "UsageMap",
    resource_documentation: "https://docs.usagemap.dev/",
  };
}

/** `WWW-Authenticate` for a 401 (RFC 6750 §3, RFC 9728 §5.1). */
export function challenge(o: OAuthSettings, invalidToken: boolean, description?: string): string {
  const parts = [
    `resource_metadata="${metadataUrl(o)}"`,
    `scope="${READ_SCOPE}"`,
    ...(invalidToken ? ['error="invalid_token"'] : []),
    ...(description ? [`error_description="${description.replace(/["\\]/g, "")}"`] : []),
  ];
  return `Bearer ${parts.join(", ")}`;
}

/** What an exchanged token stands for. */
export interface Grant {
  grantId: string;
  kind: "tenant" | "operator";
  tenantId: string | null;
  clientName: string;
  /** Control-plane token (`scfa_odt_…`) for this caller's tool calls. */
  delegated: string;
  /** When the delegated token expires (ms since the epoch). */
  until: number;
}

export class ExchangeError extends Error {
  /** 401: the client's token is not (or no longer) valid; 429/503: try again. */
  readonly status: 401 | 429 | 503;
  readonly retryAfter: number | undefined;
  constructor(status: 401 | 429 | 503, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface ExchangerOpts {
  controlPlaneUrl: string;
  settings: OAuthSettings;
  cacheMs: number;
  fetch?: typeof fetch | undefined;
  now?: () => number;
  /** Called on a refused client authentication (a configuration error, never the caller's fault). */
  onMisconfigured?: () => void;
}

export class TokenExchanger {
  readonly #o: ExchangerOpts;
  readonly #now: () => number;
  readonly #cache = new Map<string, Grant>();
  readonly #pending = new Map<string, Promise<Grant>>();

  constructor(o: ExchangerOpts) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** Forgets a token (its delegated token was refused upstream). */
  forget(accessToken: string): void {
    this.#cache.delete(hash(accessToken));
  }

  async grantFor(accessToken: string): Promise<Grant> {
    const h = hash(accessToken);
    const hit = this.#cache.get(h);
    // reuse while the delegated token has ≥ 15 s left, and never longer than the cache bound
    if (hit && hit.until - 15_000 > this.#now()) return hit;
    const running = this.#pending.get(h);
    if (running) return running;
    const p = this.#exchange(accessToken).then((g) => {
      if (this.#o.cacheMs > 0) {
        if (this.#cache.size > 10_000) this.#cache.clear();
        this.#cache.set(h, {
          ...g,
          until: Math.min(g.until, this.#now() + this.#o.cacheMs + 15_000),
        });
      }
      return g;
    });
    this.#pending.set(h, p);
    try {
      return await p;
    } finally {
      this.#pending.delete(h);
    }
  }

  async #exchange(accessToken: string): Promise<Grant> {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: accessToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience: "usagemap-api",
    });
    const basic = Buffer.from(
      `${encodeURIComponent(EXCHANGE_CLIENT_ID)}:${encodeURIComponent(this.#o.settings.secret)}`,
    ).toString("base64");
    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${this.#o.controlPlaneUrl}/v1/oauth/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "user-agent": "usagemap-mcp-hosted/1",
        },
        body: body.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ExchangeError(
        503,
        "the authorization server is not reachable; try again shortly",
        5,
      );
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* handled below */
    }
    if (res.status === 200) {
      const u = json.usagemap as Record<string, unknown> | undefined;
      const token = json.access_token;
      const expiresIn = json.expires_in;
      if (
        typeof token !== "string" ||
        !/^scfa_odt_[A-Za-z0-9_-]{43}$/.test(token) ||
        typeof expiresIn !== "number" ||
        !u ||
        (u.kind !== "tenant" && u.kind !== "operator") ||
        typeof u.grant_id !== "string"
      )
        throw new ExchangeError(503, "unexpected answer from the authorization server", 5);
      return {
        grantId: u.grant_id,
        kind: u.kind,
        tenantId: typeof u.tenant_id === "string" ? u.tenant_id : null,
        clientName: typeof u.client_name === "string" ? u.client_name : "",
        delegated: token,
        until: this.#now() + expiresIn * 1000,
      };
    }
    if (res.status === 400 && (json.error === "invalid_grant" || json.error === "invalid_request"))
      throw new ExchangeError(401, "the access token is invalid, expired or revoked");
    if (res.status === 429)
      throw new ExchangeError(
        429,
        "rate limited by the authorization server",
        Number(res.headers.get("retry-after")) || 60,
      );
    if (res.status === 401 || res.status === 404) this.#o.onMisconfigured?.();
    throw new ExchangeError(
      503,
      "the authorization server refused the exchange; try again later",
      30,
    );
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Removes anything shaped like an OAuth token from a string (defence in depth for logs and answers). */
export function redactOAuth(s: string): string {
  return s.replace(/scfa_o(at|rt|dt|ac)_[A-Za-z0-9_-]{6,}/g, "scfa_o$1_[redacted]");
}
