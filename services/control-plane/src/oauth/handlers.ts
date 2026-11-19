// SPDX-License-Identifier: Apache-2.0
// Consent and "connected apps" operations of the MCP OAuth authorization server, served by the generated pipeline
// (session cookie; CSRF on writes; docs/api/control-plane.openapi.yaml tag `oauth`):
//
//   getOAuthRequest       GET    /v1/oauth/requests/{requestId}          what the consent page shows
//   approveOAuthRequest   POST   /v1/oauth/requests/{requestId}/approve  {tenant_id} or {operator: true} → redirect_to
//   denyOAuthRequest      POST   /v1/oauth/requests/{requestId}/deny     → redirect_to (error=access_denied)
//   listMyOAuthGrants     GET    /v1/me/oauth-grants                     the signed-in user's live grants
//   revokeMyOAuthGrant    DELETE /v1/me/oauth-grants/{grantId}            revoke one (audited)
//
// A grant is always read-only and for exactly ONE tenant the user belongs to (any role), or — for an SCF operator
// with two passkeys — the read-only operator view, which additionally needs a passkey step-up ≤ 10 minutes old at the
// moment of consent (C-09), like every sensitive operator action in the portal.

import { stepUpValidUntil } from "../auth/sessions.ts";
import { type Handler, MIN_OPERATOR_PASSKEYS, type RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { isLoopbackRedirect, redirectHost, withParams } from "./rules.ts";
import type { OAuthService, RequestRow } from "./service.ts";

function me(ctx: RequestContext) {
  if (!ctx.session) throw new ApiError("unauthenticated");
  return ctx.session;
}

function operatorStatus(ctx: RequestContext): {
  eligible: boolean;
  step_up_valid_until: string | null;
} {
  const s = me(ctx);
  const eligible = s.platformRole !== null && s.passkeyCount >= MIN_OPERATOR_PASSKEYS;
  const until = stepUpValidUntil(s);
  return {
    eligible,
    step_up_valid_until:
      eligible && until && until.getTime() > Date.now() ? until.toISOString() : null,
  };
}

function clientView(r: RequestRow) {
  let uriHost: string | null = null;
  if (r.client_uri) uriHost = new URL(r.client_uri).host;
  return {
    client_id: r.client_id,
    name: r.client_name,
    kind: r.client_kind,
    // For a Client ID Metadata Document the host that published it is the client's verifiable identity.
    metadata_host: r.client_kind === "cimd" ? new URL(r.client_id).host : null,
    uri_host: uriHost,
  };
}

export function oauthHandlers(deps: {
  service: OAuthService | undefined;
}): Record<string, Handler> {
  const svc = () => {
    if (!deps.service?.cfg.enabled) throw new ApiError("not_found");
    return deps.service;
  };

  const getOAuthRequest: Handler = async (ctx) => {
    const s = me(ctx);
    const service = svc();
    const id = ctx.params.requestId as string;
    const out = await ctx.tx(async (tx) => {
      const r = await service.openRequest(tx, id);
      if (!r) return null;
      const tenants = await tx.query<{
        tenant_id: string;
        slug: string;
        name: string;
        role: string;
        status: string;
      }>(
        `SELECT t.tenant_id, t.slug, t.name, m.role::text AS role, t.status::text AS status
           FROM scf.memberships m JOIN scf.tenants t ON t.tenant_id = m.tenant_id
          WHERE m.user_id = $1 AND t.purged_at IS NULL AND t.status <> 'removed' ORDER BY t.name, t.tenant_id`,
        [s.userId],
      );
      return { r, tenants };
    });
    if (!out) throw new ApiError("not_found");
    const { r, tenants } = out;
    return {
      status: 200,
      body: {
        request_id: r.request_id,
        client: clientView(r),
        redirect_host: redirectHost(r.redirect_uri),
        redirect_loopback: isLoopbackRedirect(r.redirect_uri),
        scope: r.scope,
        resource: r.resource,
        access: "read_only",
        expires_at: r.expires_at.toISOString(),
        tenants,
        operator: operatorStatus(ctx),
      },
    };
  };

  const approveOAuthRequest: Handler = async (ctx) => {
    const s = me(ctx);
    const service = svc();
    const id = ctx.params.requestId as string;
    const body = ctx.body as { tenant_id?: string; operator?: boolean };
    const wantsOperator = body.operator === true;
    if (wantsOperator === (body.tenant_id !== undefined))
      throw new ApiError("validation_failed", "give exactly one of tenant_id and operator: true", {
        errors: [{ pointer: "", detail: "exactly one of tenant_id, operator" }],
      });
    if (wantsOperator) {
      const st = operatorStatus(ctx);
      if (!st.eligible)
        throw new ApiError(
          "forbidden",
          "the operator view needs the SCF-operator role and two passkeys",
        );
      if (!st.step_up_valid_until) throw new ApiError("step_up_required");
    }
    const result = await ctx.tx(async (tx) => {
      const r = await service.openRequest(tx, id, true);
      if (!r) return null;
      if (!wantsOperator) {
        const tenantId = body.tenant_id as string;
        await tx.switchContext({ tenantId });
        const m = await tx.maybeOne(
          `SELECT 1 FROM scf.memberships m JOIN scf.tenants t ON t.tenant_id = m.tenant_id
            WHERE m.tenant_id = $1 AND m.user_id = $2 AND t.purged_at IS NULL AND t.status <> 'removed'`,
          [tenantId, s.userId],
        );
        // Not a member, unknown and removed tenants all answer the same 404 (C-87).
        if (!m) throw new ApiError("not_found");
      }
      if (!(await service.closeRequest(tx, id))) return null;
      const { code, grantId } = await service.grant(tx, r, {
        userId: s.userId,
        kind: wantsOperator ? "operator" : "tenant",
        tenantId: wantsOperator ? null : (body.tenant_id as string),
      });
      await tx.audit({
        action: "oauth.grant_created",
        targetType: "oauth_grant",
        targetId: grantId,
        details: {
          kind: wantsOperator ? "operator" : "tenant",
          client_name: r.client_name,
          client_kind: r.client_kind,
          redirect_host: redirectHost(r.redirect_uri),
          scope: r.scope,
          resource: r.resource,
        },
      });
      return withParams(r.redirect_uri, {
        code,
        state: r.state ?? undefined,
        iss: service.cfg.issuer,
      });
    });
    if (!result) throw new ApiError("not_found");
    return { status: 200, body: { redirect_to: result } };
  };

  const denyOAuthRequest: Handler = async (ctx) => {
    me(ctx);
    const service = svc();
    const id = ctx.params.requestId as string;
    const result = await ctx.tx(async (tx) => {
      const r = await service.openRequest(tx, id, true);
      if (!r || !(await service.closeRequest(tx, id))) return null;
      return withParams(r.redirect_uri, {
        error: "access_denied",
        error_description: "the user denied access",
        state: r.state ?? undefined,
        iss: service.cfg.issuer,
      });
    });
    if (!result) throw new ApiError("not_found");
    return { status: 200, body: { redirect_to: result } };
  };

  const listMyOAuthGrants: Handler = async (ctx) => {
    const s = me(ctx);
    if (!deps.service?.cfg.enabled) return { status: 200, body: [] };
    const rows = await ctx.tx((tx) =>
      tx.query<{
        grant_id: string;
        client_name: string;
        client_kind: string;
        kind: string;
        tenant_id: string | null;
        tenant_name: string | null;
        created_at: Date;
        expires_at: Date;
        last_used_at: Date | null;
      }>(
        `SELECT g.grant_id, c.client_name, c.kind AS client_kind, g.kind, g.granted_tenant_id AS tenant_id,
                t.name AS tenant_name, g.created_at, g.expires_at,
                (SELECT max(k.created_at) FROM scf.oauth_tokens k WHERE k.grant_id = g.grant_id) AS last_used_at
           FROM scf.oauth_grants g JOIN scf.oauth_clients c ON c.client_id = g.client_id
           LEFT JOIN scf.tenants t ON t.tenant_id = g.granted_tenant_id
          WHERE g.user_id = $1 AND g.revoked_at IS NULL AND g.expires_at > now()
          ORDER BY g.created_at DESC LIMIT 200`,
        [s.userId],
      ),
    );
    return {
      status: 200,
      body: rows.map((r) => ({
        ...r,
        created_at: r.created_at.toISOString(),
        expires_at: r.expires_at.toISOString(),
        last_used_at: r.last_used_at?.toISOString() ?? null,
      })),
    };
  };

  const revokeMyOAuthGrant: Handler = async (ctx) => {
    const s = me(ctx);
    const service = svc();
    const ok = await ctx.tx((tx) =>
      service.revokeOwnGrant(tx, s.userId, ctx.params.grantId as string),
    );
    if (!ok) throw new ApiError("not_found");
    return { status: 204 };
  };

  return {
    getOAuthRequest,
    approveOAuthRequest,
    denyOAuthRequest,
    listMyOAuthGrants,
    revokeMyOAuthGrant,
  };
}
