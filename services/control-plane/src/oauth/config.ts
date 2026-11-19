// SPDX-License-Identifier: Apache-2.0
// Configuration of the MCP OAuth authorization server (src/oauth). The issuer is the portal origin (the authorization
// endpoints live under /v1/oauth on the same origin, the metadata at /.well-known/oauth-authorization-server).
//
//   SCF_OAUTH_MCP_RESOURCE         canonical URI of the hosted MCP server, the only resource tokens are issued for
//                                  (default <portal origin>/mcp)
//   SCF_OAUTH_EXCHANGE_SECRET      shared secret (≥ 32 characters; also *_FILE) of the MCP server, the one confidential
//                                  client allowed to exchange an MCP access token for a control-plane token (RFC 8693).
//                                  Unset: the authorization server is off (metadata 404, every endpoint 404).
//   SCF_OAUTH_CIMD                 "false" turns off Client ID Metadata Documents (default on; needs HTTPS egress)
//   SCF_OAUTH_DCR_PER_HOUR         dynamic registrations per client subnet and hour (default 10)
//   SCF_OAUTH_DCR_GLOBAL_PER_HOUR  dynamic registrations in total per hour (default 500)

import { createHash } from "node:crypto";
import { canonicalResource } from "./rules.ts";

export const EXCHANGE_CLIENT_ID = "usagemap-mcp";

export interface OAuthConfig {
  enabled: boolean;
  issuer: string;
  mcpResource: string;
  /** SHA-256 of the exchange secret (the secret itself is not kept). */
  exchangeSecretHash: Buffer | null;
  cimd: boolean;
  dcrPerHour: number;
  dcrGlobalPerHour: number;
}

function positive(v: string | undefined, name: string, d: number): number {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function oauthConfig(
  get: (name: string) => string | undefined,
  portalOrigin: string,
): OAuthConfig {
  const resource = canonicalResource(get("SCF_OAUTH_MCP_RESOURCE") ?? `${portalOrigin}/mcp`);
  if (!resource)
    throw new Error("SCF_OAUTH_MCP_RESOURCE must be an absolute http(s) URI without a fragment");
  const secret = get("SCF_OAUTH_EXCHANGE_SECRET");
  if (secret !== undefined && secret.length < 32)
    throw new Error("SCF_OAUTH_EXCHANGE_SECRET must be at least 32 characters");
  const cimd = get("SCF_OAUTH_CIMD");
  if (cimd !== undefined && cimd !== "true" && cimd !== "false")
    throw new Error("SCF_OAUTH_CIMD must be true or false");
  return {
    enabled: secret !== undefined,
    issuer: portalOrigin,
    mcpResource: resource,
    exchangeSecretHash: secret === undefined ? null : createHash("sha256").update(secret).digest(),
    cimd: cimd !== "false",
    dcrPerHour: positive(get("SCF_OAUTH_DCR_PER_HOUR"), "SCF_OAUTH_DCR_PER_HOUR", 10),
    dcrGlobalPerHour: positive(
      get("SCF_OAUTH_DCR_GLOBAL_PER_HOUR"),
      "SCF_OAUTH_DCR_GLOBAL_PER_HOUR",
      500,
    ),
  };
}
