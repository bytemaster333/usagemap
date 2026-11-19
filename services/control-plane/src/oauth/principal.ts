// SPDX-License-Identifier: Apache-2.0
// Delegated OAuth tokens (`scfa_odt_…`) at the control-plane API. Only the hosted MCP server holds them: it obtains one
// by token exchange (RFC 8693) for the access token a client sent it, so the client's own token never leaves the MCP
// server (MCP authorization 2026-07-28: servers "MUST NOT accept or transit any other tokens").
//
//   - tenant grants: the GET operations of OAUTH_TENANT_READ_OPS, for the grant's tenant only (another tenant → the
//     same 404 as an unknown one, C-87), as the granting member with a member's read rights; membership, the tenant's
//     state and the role are checked by the pipeline on every request as for a portal session. Nothing that writes,
//     nothing that reveals secrets, members or the audit log.
//   - operator grants: the operator metrics API (`/op/v1`, GET only) with the three read scopes, as an op_key-kind
//     context whose actor id is `oauth:<grant id>` (audited by op_begin like a key); the grant needed the operator role,
//     two passkeys and a fresh step-up, and every request re-checks role and passkeys.

import type { Session } from "../auth/sessions.ts";
import type { OperationSpec } from "../http/openapi.ts";
import { ApiError } from "../http/problem.ts";
import type { KeyRow } from "../opmetrics/keyauth.ts";
import { tokenHash } from "./rules.ts";
import type { OAuthPrincipal } from "./service.ts";

/** Tenant read operations a tenant grant may call (analytics a viewer sees; no secrets, members, audit or exports). */
export const OAUTH_TENANT_READ_OPS = new Set([
  "getTenant",
  "listSites",
  "getSite",
  "getInstallationCheck",
  "listSiteTrustScores",
  "getWebStats",
  "getWebTimeseries",
  "getWebBreakdown",
  "getSiteWalletFunnel",
  "listServices",
  "getService",
  "getServiceDataQuality",
  "getVerification",
  "getApiSummary",
  "getApiTimeseries",
  "getApiStatusCodes",
  "listApiRoutes",
  "getApiSurfaces",
  "getApiAssurance",
  "getOnchainDaily",
  "listTractionSnapshots",
  "getStellarClientMetrics",
  "getIntegrationStatus",
]);

/** Scopes an operator grant holds at `/op/v1` (read-only; the database checks them again in op_authorize). */
export const OAUTH_OPERATOR_SCOPES = ["registry:read", "web:read", "api:read"];
export const OAUTH_OPERATOR_RATE_PER_MIN = 120;

/** The bearer value when the Authorization header carries a delegated OAuth token, else undefined. */
export function delegatedBearer(authorization: string | undefined): string | undefined {
  if (typeof authorization !== "string") return undefined;
  const m = /^Bearer (scfa_odt_[A-Za-z0-9_-]{43})$/.exec(authorization);
  return m ? m[1] : undefined;
}

/**
 * The session a tenant grant acts with for one pipeline operation; throws when the operation is not open to it. The
 * session has no platform role, no passkey and no recent authentication, so step-up, recent-auth and operator checks
 * all refuse; the pipeline then checks membership and role as for any member.
 */
export function oauthSession(
  p: OAuthPrincipal,
  token: string,
  op: OperationSpec,
  params: Record<string, string>,
): Session {
  if (p.kind !== "tenant" || p.tenantId === null)
    throw new ApiError("forbidden", "an operator grant reads the operator metrics API only");
  if (op.method !== "get" || !OAUTH_TENANT_READ_OPS.has(op.operationId))
    throw new ApiError("forbidden", "this operation is not available to OAuth tokens");
  if (params.tenantId !== p.tenantId) throw new ApiError("not_found");
  const epoch = new Date(0);
  return {
    hash: tokenHash(token),
    userId: p.userId,
    kind: "tenant_user",
    firstFactor: "github",
    passkeyVerifiedAt: null,
    stepUpAt: null,
    reauthenticatedAt: epoch,
    reauthMethod: "github",
    createdAt: epoch,
    lastSeenAt: new Date(),
    idleExpiresAt: p.expiresAt,
    absoluteExpiresAt: p.expiresAt,
    platformRole: null,
    passkeyCount: 0,
  };
}

/** The key row an operator grant acts with at `/op/v1`. */
export function oauthOperatorKey(p: OAuthPrincipal): KeyRow {
  if (p.kind !== "operator")
    throw new ApiError("forbidden", "a tenant grant cannot read the operator metrics API");
  return {
    key_id: `oauth:${p.grantId}`,
    secret_hash: Buffer.alloc(0),
    pepper_version: 0,
    label: `OAuth: ${p.clientName}`,
    scopes: [...OAUTH_OPERATOR_SCOPES],
    tenant_restriction: null,
    rate_limit_per_min: OAUTH_OPERATOR_RATE_PER_MIN,
    expires_at: p.expiresAt,
    revoked_at: null,
  };
}
