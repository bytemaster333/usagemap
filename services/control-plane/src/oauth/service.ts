// SPDX-License-Identifier: Apache-2.0
// State of the MCP OAuth authorization server in PostgreSQL (migration 0083): clients, pending authorization requests,
// grants, single-use codes and tokens. Every code and token is stored as SHA-256 only; nothing about the caller's
// network or browser is stored. A grant is ONE user's read-only access for ONE client and resource, either to one
// tenant (kind `tenant`, any member role) or to the SCF-operator view (kind `operator`: platform role, two passkeys and
// a fresh step-up at consent). Access is re-checked live at every token use: a removed member, a revoked operator role,
// a disabled or deleted account or a removed tenant ends the grant at once (`access_lost`).

import type { Database, Tx } from "../db/database.ts";
import { MIN_OPERATOR_PASSKEYS } from "../http/pipeline.ts";
import { uuidv7 } from "../util/ids.ts";
import type { OAuthConfig } from "./config.ts";
import {
  CONTROL_PLANE_AUDIENCE,
  LIFETIME,
  newToken,
  READ_SCOPE,
  tokenHash,
  tokenKind,
  verifyPkce,
} from "./rules.ts";

export type GrantKind = "tenant" | "operator";

export interface ClientRow extends Record<string, unknown> {
  client_id: string;
  kind: "dcr" | "cimd";
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
  metadata_fetched_at: Date | null;
  disabled_at: Date | null;
}

export interface RequestRow extends Record<string, unknown> {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: string;
  resource: string;
  expires_at: Date;
  decided_at: Date | null;
  client_name: string;
  client_kind: "dcr" | "cimd";
  client_uri: string | null;
}

interface GrantRow extends Record<string, unknown> {
  grant_id: string;
  client_id: string;
  user_id: string;
  kind: GrantKind;
  granted_tenant_id: string | null;
  scope: string;
  resource: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/** What a verified token stands for. */
export interface OAuthPrincipal {
  grantId: string;
  userId: string;
  kind: GrantKind;
  tenantId: string | null;
  clientId: string;
  clientName: string;
  scope: string;
  resource: string;
  expiresAt: Date;
}

export interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** OAuth error of the token endpoint (RFC 6749 §5.2). */
export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;
  constructor(error: string, description: string, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

const sys = (requestId: string, actorId = "oauth") => ({
  tenantId: null,
  actorKind: "system" as const,
  actorId,
  requestId,
});

export class OAuthService {
  readonly #db: Database;
  readonly cfg: OAuthConfig;
  readonly #now: () => number;
  #sweptAt = 0;

  constructor(db: Database, cfg: OAuthConfig, now: () => number = Date.now) {
    this.#db = db;
    this.cfg = cfg;
    this.#now = now;
  }

  // ------------------------------------------------------------------------------------------------- clients

  async client(clientId: string, requestId: string): Promise<ClientRow | null> {
    return (
      (await this.#db.tx(sys(requestId), (tx) =>
        tx.maybeOne<ClientRow>(
          `SELECT client_id, kind, client_name, client_uri, redirect_uris, metadata_fetched_at, disabled_at
             FROM scf.oauth_clients WHERE client_id = $1`,
          [clientId],
        ),
      )) ?? null
    );
  }

  /** Stores a registered (DCR) or fetched (CIMD) client; a CIMD client's metadata is replaced on every fetch. */
  async saveClient(
    c: {
      clientId: string;
      kind: "dcr" | "cimd";
      clientName: string;
      clientUri: string | null;
      redirectUris: string[];
    },
    requestId: string,
  ): Promise<void> {
    await this.#db.tx({ ...sys(requestId), actorKind: "anonymous", actorId: null }, async (tx) => {
      const r = await tx.query<{ inserted: boolean }>(
        `INSERT INTO scf.oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, metadata_fetched_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $2 = 'cimd' THEN now() END)
         ON CONFLICT (client_id) DO UPDATE
            SET client_name = EXCLUDED.client_name, client_uri = EXCLUDED.client_uri,
                redirect_uris = EXCLUDED.redirect_uris, metadata_fetched_at = EXCLUDED.metadata_fetched_at
          WHERE scf.oauth_clients.kind = 'cimd' AND EXCLUDED.kind = 'cimd'
         RETURNING (xmax = 0) AS inserted`,
        [c.clientId, c.kind, c.clientName, c.clientUri, c.redirectUris],
      );
      if (r[0]?.inserted)
        await tx.audit({
          action: "oauth.client_registered",
          targetType: "oauth_client",
          targetId: c.kind === "dcr" ? c.clientId : null,
          details: {
            kind: c.kind,
            client_name: c.clientName,
            redirect_hosts: [...new Set(c.redirectUris.map((u) => new URL(u).host))],
            ...(c.kind === "cimd" ? { metadata_host: new URL(c.clientId).host } : {}),
          },
        });
    });
  }

  // ------------------------------------------------------------------------------------------------- requests

  async createRequest(
    r: {
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      state: string | null;
      scope: string;
      resource: string;
    },
    requestId: string,
  ): Promise<string> {
    const id = uuidv7(this.#now());
    await this.#db.tx(sys(requestId), (tx) =>
      tx.query(
        `INSERT INTO scf.oauth_requests (request_id, client_id, redirect_uri, code_challenge, state, scope, resource,
                                         created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + make_interval(secs => $8))`,
        [
          id,
          r.clientId,
          r.redirectUri,
          r.codeChallenge,
          r.state,
          r.scope,
          r.resource,
          LIFETIME.request / 1000,
        ],
      ),
    );
    return id;
  }

  /** A pending request that is still open (not decided, not expired), or null. */
  async openRequest(tx: Tx, id: string, lock = false): Promise<RequestRow | null> {
    return (
      (await tx.maybeOne<RequestRow>(
        `SELECT r.request_id, r.client_id, r.redirect_uri, r.code_challenge, r.state, r.scope, r.resource,
                r.expires_at, r.decided_at, c.client_name, c.kind AS client_kind, c.client_uri
           FROM scf.oauth_requests r JOIN scf.oauth_clients c ON c.client_id = r.client_id
          WHERE r.request_id = $1 AND r.decided_at IS NULL AND r.expires_at > now() AND c.disabled_at IS NULL
          ${lock ? "FOR UPDATE OF r" : ""}`,
        [id],
      )) ?? null
    );
  }

  /** Marks a request decided (approve or deny); false when it was no longer open. */
  async closeRequest(tx: Tx, id: string): Promise<boolean> {
    const r = await tx.query(
      `UPDATE scf.oauth_requests SET decided_at = now()
        WHERE request_id = $1 AND decided_at IS NULL AND expires_at > now() RETURNING 1`,
      [id],
    );
    return r.length === 1;
  }

  /** Creates the grant and its authorization code inside the caller's transaction; returns the code. */
  async grant(
    tx: Tx,
    req: RequestRow,
    who: { userId: string; kind: GrantKind; tenantId: string | null },
  ): Promise<{ code: string; grantId: string }> {
    const grantId = uuidv7(this.#now());
    const life = who.kind === "operator" ? LIFETIME.grantOperator : LIFETIME.grantTenant;
    await tx.query(
      `INSERT INTO scf.oauth_grants (grant_id, client_id, user_id, kind, granted_tenant_id, scope, resource,
                                     created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + make_interval(secs => $8))`,
      [
        grantId,
        req.client_id,
        who.userId,
        who.kind,
        who.tenantId,
        req.scope,
        req.resource,
        life / 1000,
      ],
    );
    const code = newToken("code");
    await tx.query(
      `INSERT INTO scf.oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, created_at, expires_at)
       VALUES ($1, $2, $3, $4, now(), now() + make_interval(secs => $5))`,
      [tokenHash(code), grantId, req.redirect_uri, req.code_challenge, LIFETIME.code / 1000],
    );
    return { code, grantId };
  }

  // ------------------------------------------------------------------------------------------------- tokens

  /** Authorization code grant (OAuth 2.1 §4.1.3) with mandatory PKCE S256. */
  async exchangeCode(
    p: {
      code: string;
      clientId: string;
      redirectUri: string;
      codeVerifier: string | undefined;
      resource: string | null;
    },
    requestId: string,
  ): Promise<TokenSet> {
    if (tokenKind(p.code) !== "code")
      throw new OAuthError("invalid_grant", "unknown or expired code");
    const out = await this.#db.tx<TokenSet | OAuthError>(sys(requestId), async (tx) => {
      const row = await tx.maybeOne<
        GrantRow & {
          redirect_uri: string;
          code_challenge: string;
          used_at: Date | null;
          expired: boolean;
        }
      >(
        `SELECT g.grant_id, g.client_id, g.user_id, g.kind, g.granted_tenant_id, g.scope, g.resource, g.expires_at,
                g.revoked_at, c.redirect_uri, c.code_challenge, c.used_at, c.expires_at <= now() AS expired
           FROM scf.oauth_codes c JOIN scf.oauth_grants g ON g.grant_id = c.grant_id
          WHERE c.code_hash = $1 FOR UPDATE OF c`,
        [tokenHash(p.code)],
      );
      if (!row || row.expired) return new OAuthError("invalid_grant", "unknown or expired code");
      if (row.client_id !== p.clientId)
        return new OAuthError("invalid_grant", "the code was issued to another client");
      if (row.used_at) {
        // OAuth 2.1 §4.1.3: a code used twice revokes what was issued with it.
        await this.#revokeGrant(tx, row.grant_id, "code_reuse");
        return new OAuthError("invalid_grant", "the code has already been used");
      }
      await tx.query(`UPDATE scf.oauth_codes SET used_at = now() WHERE code_hash = $1`, [
        tokenHash(p.code),
      ]);
      if (row.redirect_uri !== p.redirectUri)
        return new OAuthError(
          "invalid_grant",
          "redirect_uri does not match the authorization request",
        );
      if (!verifyPkce(p.codeVerifier, row.code_challenge))
        return new OAuthError("invalid_grant", "PKCE verification failed");
      if (p.resource !== null && p.resource !== row.resource)
        return new OAuthError(
          "invalid_target",
          "resource does not match the authorization request",
        );
      if (row.revoked_at) return new OAuthError("invalid_grant", "the grant has been revoked");
      const denied = await this.#requireAccess(tx, row);
      if (denied) return denied;
      return this.#issue(tx, row);
    });
    if (out instanceof OAuthError) throw out; // after COMMIT: revocations and spent codes stay
    return out;
  }

  /** Refresh token grant with rotation (OAuth 2.1 §4.3.1; a reused refresh token revokes the grant). */
  async refresh(
    p: { refreshToken: string; clientId: string; resource: string | null },
    requestId: string,
  ): Promise<TokenSet> {
    if (tokenKind(p.refreshToken) !== "refresh")
      throw new OAuthError("invalid_grant", "unknown, expired or revoked refresh token");
    const out = await this.#db.tx<TokenSet | OAuthError>(sys(requestId), async (tx) => {
      const row = await tx.maybeOne<
        GrantRow & { used_at: Date | null; t_revoked: Date | null; t_expired: boolean }
      >(
        `SELECT g.grant_id, g.client_id, g.user_id, g.kind, g.granted_tenant_id, g.scope, g.resource, g.expires_at,
                g.revoked_at, t.used_at, t.revoked_at AS t_revoked, t.expires_at <= now() AS t_expired
           FROM scf.oauth_tokens t JOIN scf.oauth_grants g ON g.grant_id = t.grant_id
          WHERE t.token_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`,
        [tokenHash(p.refreshToken)],
      );
      if (!row || row.client_id !== p.clientId)
        return new OAuthError("invalid_grant", "unknown, expired or revoked refresh token");
      if (row.used_at) {
        await this.#revokeGrant(tx, row.grant_id, "refresh_reuse");
        return new OAuthError("invalid_grant", "the refresh token has already been used");
      }
      if (
        row.t_revoked ||
        row.t_expired ||
        row.revoked_at ||
        row.expires_at.getTime() <= this.#now()
      )
        return new OAuthError("invalid_grant", "unknown, expired or revoked refresh token");
      if (p.resource !== null && p.resource !== row.resource)
        return new OAuthError("invalid_target", "resource does not match the grant");
      await tx.query(`UPDATE scf.oauth_tokens SET used_at = now() WHERE token_hash = $1`, [
        tokenHash(p.refreshToken),
      ]);
      const denied = await this.#requireAccess(tx, row);
      if (denied) return denied;
      return this.#issue(tx, row);
    });
    if (out instanceof OAuthError) throw out; // after COMMIT: revocations and spent codes stay
    return out;
  }

  /**
   * Token exchange (RFC 8693) for the MCP server: a live access token for the MCP resource → a short-lived delegated
   * token for the control-plane API, never outliving the subject token. The caller authenticated as the exchange client.
   */
  async exchange(
    subjectToken: string,
    requestId: string,
  ): Promise<{
    token: string;
    expiresIn: number;
    principal: OAuthPrincipal;
    subjectExpiresAt: Date;
  }> {
    const subject =
      tokenKind(subjectToken) === "access"
        ? await this.#lookup(subjectToken, "access", requestId)
        : null;
    if (!subject || subject.resource !== this.cfg.mcpResource)
      throw new OAuthError(
        "invalid_grant",
        "the subject token is not an active access token for the MCP server",
      );
    const ms = Math.min(LIFETIME.delegatedMax, subject.expiresAt.getTime() - this.#now());
    if (ms < 1000) throw new OAuthError("invalid_grant", "the subject token is about to expire");
    const token = newToken("delegated");
    await this.#db.tx(sys(requestId), (tx) =>
      tx.query(
        `INSERT INTO scf.oauth_tokens (token_hash, grant_id, kind, audience, created_at, expires_at)
         VALUES ($1, $2, 'delegated', $3, now(), now() + make_interval(secs => $4))`,
        [tokenHash(token), subject.grantId, CONTROL_PLANE_AUDIENCE, Math.floor(ms / 1000)],
      ),
    );
    return {
      token,
      expiresIn: Math.floor(ms / 1000),
      principal: subject,
      subjectExpiresAt: subject.expiresAt,
    };
  }

  /** Verifies a delegated (control-plane audience) token; null when it is not active. */
  async delegatedPrincipal(token: string, requestId: string): Promise<OAuthPrincipal | null> {
    if (tokenKind(token) !== "delegated") return null;
    return this.#lookup(token, "delegated", requestId);
  }

  /**
   * Looks a token up with every live check: token and grant active, account active, client enabled, and the access the
   * grant stands for still held (membership of an active tenant, or the operator role with two passkeys).
   */
  async #lookup(
    token: string,
    kind: "access" | "delegated",
    requestId: string,
  ): Promise<OAuthPrincipal | null> {
    const row = await this.#db.tx(sys(requestId), (tx) =>
      tx.maybeOne<GrantRow & { client_name: string; t_expires: Date; access_ok: boolean }>(
        `SELECT g.grant_id, g.client_id, g.user_id, g.kind, g.granted_tenant_id, g.scope, g.resource, g.expires_at,
                g.revoked_at, c.client_name, least(t.expires_at, g.expires_at) AS t_expires,
                CASE g.kind
                  WHEN 'operator' THEN
                    EXISTS (SELECT 1 FROM scf.platform_operators o WHERE o.user_id = g.user_id AND o.revoked_at IS NULL)
                    AND (SELECT count(*) FROM scf.passkey_credentials p
                          WHERE p.user_id = g.user_id AND p.revoked_at IS NULL) >= $3
                  ELSE true END AS access_ok
           FROM scf.oauth_tokens t
           JOIN scf.oauth_grants g ON g.grant_id = t.grant_id
           JOIN scf.oauth_clients c ON c.client_id = g.client_id
           JOIN scf.users u ON u.user_id = g.user_id
          WHERE t.token_hash = $1 AND t.kind = $2 AND t.revoked_at IS NULL AND t.expires_at > now()
            AND g.revoked_at IS NULL AND g.expires_at > now() AND c.disabled_at IS NULL
            AND u.disabled_at IS NULL AND u.deleted_at IS NULL`,
        [tokenHash(token), kind, MIN_OPERATOR_PASSKEYS],
      ),
    );
    if (!row?.access_ok) return null;
    if (row.kind === "tenant" && kind === "access") {
      // Tenant membership is RLS-protected: read it in the grant's tenant context, as its user.
      const ok = await this.#tenantAccess(row.user_id, row.granted_tenant_id as string, requestId);
      if (!ok) return null;
    }
    return {
      grantId: row.grant_id,
      userId: row.user_id,
      kind: row.kind,
      tenantId: row.granted_tenant_id,
      clientId: row.client_id,
      clientName: row.client_name,
      scope: row.scope,
      resource: row.resource,
      expiresAt: row.t_expires,
    };
  }

  async #tenantAccess(userId: string, tenantId: string, requestId: string): Promise<boolean> {
    return this.#db.tx({ tenantId, actorKind: "user", actorId: userId, requestId }, async (tx) =>
      this.#tenantAccessTx(tx, userId, tenantId),
    );
  }

  async #tenantAccessTx(tx: Tx, userId: string, tenantId: string): Promise<boolean> {
    if (tx.ctx.tenantId !== tenantId)
      await tx.switchContext({ tenantId, actorKind: "user", actorId: userId });
    const r = await tx.maybeOne(
      `SELECT 1 FROM scf.memberships m JOIN scf.tenants t ON t.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND t.status IN ('active', 'suspended', 'pending')
          AND t.purged_at IS NULL`,
      [tenantId, userId],
    );
    return r !== undefined;
  }

  /** Live access check at code and refresh use; a grant whose access is gone is revoked. */
  async #requireAccess(tx: Tx, g: GrantRow): Promise<OAuthError | null> {
    const base = await tx.one<{ user_ok: boolean; op_ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM scf.users u WHERE u.user_id = $1 AND u.disabled_at IS NULL AND u.deleted_at IS NULL) AS user_ok,
              EXISTS (SELECT 1 FROM scf.platform_operators o WHERE o.user_id = $1 AND o.revoked_at IS NULL)
              AND (SELECT count(*) FROM scf.passkey_credentials p WHERE p.user_id = $1 AND p.revoked_at IS NULL) >= $2 AS op_ok`,
      [g.user_id, MIN_OPERATOR_PASSKEYS],
    );
    let ok = base.user_ok && (g.kind === "tenant" || base.op_ok);
    if (ok && g.kind === "tenant") {
      ok = await this.#tenantAccessTx(tx, g.user_id, g.granted_tenant_id as string);
      await tx.switchContext(sys(tx.ctx.requestId ?? ""));
    }
    if (!ok) {
      await this.#revokeGrant(tx, g.grant_id, "access_lost");
      return new OAuthError(
        "invalid_grant",
        "the user no longer has the access this grant stands for",
      );
    }
    return null;
  }

  async #issue(tx: Tx, g: GrantRow): Promise<TokenSet> {
    const access = newToken("access");
    const refresh = newToken("refresh");
    const grantLeft = g.expires_at.getTime() - this.#now();
    const accessMs = Math.min(LIFETIME.access, grantLeft);
    const refreshMs = Math.min(
      g.kind === "operator" ? LIFETIME.refreshOperator : LIFETIME.refreshTenant,
      grantLeft,
    );
    if (accessMs < 1000) throw new OAuthError("invalid_grant", "the grant has expired");
    await tx.query(
      `INSERT INTO scf.oauth_tokens (token_hash, grant_id, kind, audience, created_at, expires_at) VALUES
         ($1, $3, 'access', $4, now(), now() + make_interval(secs => $5)),
         ($2, $3, 'refresh', $4, now(), now() + make_interval(secs => $6))`,
      [
        tokenHash(access),
        tokenHash(refresh),
        g.grant_id,
        g.resource,
        Math.floor(accessMs / 1000),
        Math.floor(refreshMs / 1000),
      ],
    );
    await tx.query(
      `UPDATE scf.oauth_clients SET last_used_at = now()
        WHERE client_id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 hour')`,
      [g.client_id],
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(accessMs / 1000),
      refresh_token: refresh,
      scope: g.scope || READ_SCOPE,
    };
  }

  // ------------------------------------------------------------------------------------------------- revocation

  /**
   * RFC 7009: revokes a token the client holds. A refresh token (or a code) revokes its whole grant; an access token
   * only itself. Unknown tokens and tokens of other clients are ignored (the answer is the same 200 either way).
   */
  async revokeToken(token: string, clientId: string, requestId: string): Promise<void> {
    const kind = tokenKind(token);
    if (kind !== "access" && kind !== "refresh") return;
    await this.#db.tx(sys(requestId), async (tx) => {
      const row = await tx.maybeOne<{ grant_id: string; user_id: string; tenant: string | null }>(
        `SELECT g.grant_id, g.user_id, g.granted_tenant_id AS tenant FROM scf.oauth_tokens t
           JOIN scf.oauth_grants g ON g.grant_id = t.grant_id
          WHERE t.token_hash = $1 AND g.client_id = $2`,
        [tokenHash(token), clientId],
      );
      if (!row) return;
      if (kind === "refresh") await this.#revokeGrant(tx, row.grant_id, "user");
      else
        await tx.query(
          `UPDATE scf.oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash(token)],
        );
    });
  }

  /** Revokes a grant and every token issued under it; audited in the grant's tenant chain (or the platform chain). */
  async #revokeGrant(
    tx: Tx,
    grantId: string,
    reason: "user" | "refresh_reuse" | "code_reuse" | "access_lost",
  ) {
    const g = await tx.maybeOne<{
      user_id: string;
      tenant: string | null;
      kind: GrantKind;
      client_name: string;
    }>(
      `UPDATE scf.oauth_grants g SET revoked_at = now(), revoke_reason = $2
         FROM scf.oauth_clients c
        WHERE g.grant_id = $1 AND g.revoked_at IS NULL AND c.client_id = g.client_id
        RETURNING g.user_id, g.granted_tenant_id AS tenant, g.kind, c.client_name`,
      [grantId, reason],
    );
    await tx.query(
      `UPDATE scf.oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL`,
      [grantId],
    );
    if (!g) return;
    const prev = { ...tx.ctx };
    await tx.switchContext({
      tenantId: g.tenant,
      actorKind: reason === "user" ? "user" : "system",
      actorId: reason === "user" ? g.user_id : "oauth",
    });
    await tx.audit({
      action: "oauth.grant_revoked",
      targetType: "oauth_grant",
      targetId: grantId,
      outcome: "success",
      details: { reason, kind: g.kind, client_name: g.client_name },
    });
    await tx.switchContext(prev);
  }

  /** The signed-in user revokes one of their own grants (portal "Connected apps"). False when not theirs or gone. */
  async revokeOwnGrant(tx: Tx, userId: string, grantId: string): Promise<boolean> {
    const own = await tx.maybeOne(
      `SELECT 1 FROM scf.oauth_grants WHERE grant_id = $1 AND user_id = $2 AND revoked_at IS NULL
          AND expires_at > now()`,
      [grantId, userId],
    );
    if (!own) return false;
    await this.#revokeGrant(tx, grantId, "user");
    return true;
  }

  /** Deletes what has expired (at most every 10 minutes per process; the retention job may do the same). */
  async sweep(requestId: string): Promise<void> {
    const t = this.#now();
    if (t - this.#sweptAt < 10 * 60_000) return;
    this.#sweptAt = t;
    await this.#db.tx(sys(requestId, "oauth_sweep"), async (tx) => {
      await tx.query(`DELETE FROM scf.oauth_requests WHERE expires_at < now() - interval '1 hour'`);
      await tx.query(`DELETE FROM scf.oauth_codes WHERE expires_at < now() - interval '1 hour'`);
      await tx.query(`DELETE FROM scf.oauth_tokens WHERE expires_at < now() - interval '1 hour'`);
      await tx.query(
        `DELETE FROM scf.oauth_grants WHERE expires_at < now() - interval '30 days'
            OR revoked_at < now() - interval '30 days'`,
      );
      // Registered clients nobody has used for 30 days and that hold no grant (DCR makes many; CIMD re-fetches).
      await tx.query(
        `DELETE FROM scf.oauth_clients c WHERE coalesce(c.last_used_at, c.created_at) < now() - interval '30 days'
            AND NOT EXISTS (SELECT 1 FROM scf.oauth_grants g WHERE g.client_id = c.client_id)`,
      );
    });
  }
}
