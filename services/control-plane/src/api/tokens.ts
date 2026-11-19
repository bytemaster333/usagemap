// SPDX-License-Identifier: Apache-2.0
// Tenant ingest tokens (data-model §8.7, wire-formats §k, f.2; C-05, C-06, C-21, C-81). The full token is returned
// once in the creation response and never stored or logged: the database holds the id, the last four characters of
// the secret and HMAC-SHA-256(pepper_ing[version], secret). The edge learns tokens only from the signed snapshot, so a
// revocation notifies the snapshot builder (NOTIFY scf_edge) and the gateway refuses the token within 60 s (C-06).

import { pgCode } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { displayOf, mintKey, type Peppers } from "../keys/keys.ts";
import { badField, visibleTenant } from "./services.ts";

interface TokenRow extends Record<string, unknown> {
  token_id: string;
  last4: string;
  label: string;
  allowed_service_names: string[] | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  reminder: boolean;
}

const COLS = `token_id, last4, label, allowed_service_names, created_at, expires_at, last_used_at, revoked_at,
  created_at < now() - interval '12 months' AS reminder`;

function tokenView(r: TokenRow): Record<string, unknown> {
  return {
    token_id: r.token_id,
    display: displayOf("ing", r.token_id, r.last4),
    label: r.label,
    allowed_service_names: r.allowed_service_names,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at?.toISOString() ?? null,
    last_used_at: r.last_used_at?.toISOString() ?? null,
    revoked_at: r.revoked_at?.toISOString() ?? null,
    // C-21: reminder to rotate a token older than 12 months that is still usable.
    rotation_reminder: r.reminder && r.revoked_at === null,
  };
}

export function tokenHandlers(deps: {
  peppers: Peppers;
  now?: () => number;
}): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  const listIngestTokens: Handler = async (ctx) => {
    const tenantId = visibleTenant(ctx);
    const rows = await ctx.tx((tx) =>
      tx.query<TokenRow>(
        `SELECT ${COLS} FROM scf.ingest_tokens WHERE tenant_id = $1 ORDER BY created_at DESC, token_id`,
        [tenantId],
      ),
    );
    return { status: 200, body: rows.map(tokenView) };
  };

  const createIngestToken: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const b = ctx.body as {
      label: string;
      allowed_service_names?: string[] | null;
      expires_at?: string | null;
    };
    const set = deps.peppers.ing;
    if (!set) throw new ApiError("unavailable", "ingest tokens cannot be issued right now");
    let expires: Date | null = null;
    if (b.expires_at !== undefined && b.expires_at !== null) {
      expires = new Date(b.expires_at);
      if (!(expires.getTime() > clock())) throw badField("/expires_at", "must be in the future");
    }
    const names = b.allowed_service_names ? [...new Set(b.allowed_service_names)].sort() : null;
    const key = mintKey("ing", set);
    const body = await ctx.tx(async (tx) => {
      if (names && names.length > 0) {
        // C-87: allow-listed names are resolved under the caller's tenant; an unknown name is a 404.
        const known = await tx.query<{ service_name: string }>(
          `SELECT service_name FROM scf.api_services WHERE tenant_id = $1 AND service_name = ANY ($2::text[])`,
          [tenantId, names],
        );
        if (known.length !== names.length) throw new ApiError("not_found", "unknown service name");
      }
      try {
        await tx.query(
          `INSERT INTO scf.ingest_tokens (tenant_id, token_id, secret_hash, pepper_version, last4, label,
                                          allowed_service_names, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            tenantId,
            key.id,
            key.hash,
            key.pepperVersion,
            key.last4,
            b.label,
            names,
            ctx.session?.userId,
            expires,
          ],
        );
      } catch (err) {
        // The key_limits trigger raises 23514 without a constraint name (C-21: ≤ 5 active tokens).
        if (pgCode(err) === "23514" && !(err as { constraint?: string }).constraint)
          throw new ApiError("quota_exceeded", "at most 5 active ingest tokens per tenant");
        throw err;
      }
      await tx.audit({
        action: "ingest_token.created",
        targetType: "ingest_token",
        targetId: key.id,
        details: {
          allowed_services: names?.length ?? null,
          expires: expires !== null,
          pepper_version: key.pepperVersion,
        },
      });
      await tx.notify("scf_edge");
      return tokenView(
        await tx.one<TokenRow>(
          `SELECT ${COLS} FROM scf.ingest_tokens WHERE tenant_id = $1 AND token_id = $2`,
          [tenantId, key.id],
        ),
      );
    });
    return { status: 201, body: { ...body, token: key.key } };
  };

  const revokeIngestToken: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const tokenId = ctx.params.tokenId as string;
    await ctx.tx(async (tx) => {
      const cur = await tx.maybeOne<{ revoked: boolean }>(
        `SELECT revoked_at IS NOT NULL AS revoked FROM scf.ingest_tokens
          WHERE tenant_id = $1 AND token_id = $2 FOR UPDATE`,
        [tenantId, tokenId],
      );
      if (!cur) throw new ApiError("not_found");
      if (!cur.revoked)
        await tx.query(
          `UPDATE scf.ingest_tokens SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND token_id = $2`,
          [tenantId, tokenId, ctx.session?.userId],
        );
      await tx.audit({
        action: "ingest_token.revoked",
        targetType: "ingest_token",
        targetId: tokenId,
        details: { already_revoked: cur.revoked },
      });
      // C-06: the snapshot builder runs on NOTIFY, so the edge drops the token with the next snapshot (≤ 60 s).
      await tx.notify("scf_edge");
    });
    return { status: 204 };
  };

  return { listIngestTokens, createIngestToken, revokeIngestToken };
}
