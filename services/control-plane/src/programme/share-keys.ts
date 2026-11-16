// SPDX-License-Identifier: Apache-2.0
// Tenant share keys `scfa_pub_…` (C-14, C-70, C-81; wire-formats §k; data-model §8.7): created by an `owner` or
// `admin`, shown once, stored as id + last4 + HMAC-SHA-256(pepper_pub[version], secret). A share key grants read-only
// access to that tenant's `metrics_endpoint` and nothing else.

import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { displayOf, mintKey, type Peppers } from "../keys/keys.ts";

interface ShareKeyRow extends Record<string, unknown> {
  key_id: string;
  last4: string;
  label: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const COLS = "key_id, last4, label, created_at, expires_at, last_used_at, revoked_at";

function view(r: ShareKeyRow): Record<string, unknown> {
  return {
    key_id: r.key_id,
    display: displayOf("pub", r.key_id, r.last4),
    label: r.label,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at?.toISOString() ?? null,
    last_used_at: r.last_used_at?.toISOString() ?? null,
    revoked_at: r.revoked_at?.toISOString() ?? null,
  };
}

export function shareKeyHandlers(deps: {
  peppers: Peppers;
  now?: () => number;
}): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  const listShareKeys: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) =>
      tx.query<ShareKeyRow>(
        `SELECT ${COLS} FROM scf.share_keys WHERE tenant_id = $1 ORDER BY created_at DESC, key_id`,
        [ctx.tenant?.id],
      ),
    );
    return { status: 200, body: rows.map(view) };
  };

  const createShareKey: Handler = async (ctx) => {
    const b = ctx.body as { label: string; expires_at?: string | null };
    const expires = b.expires_at ? Date.parse(b.expires_at) : null;
    if (expires !== null && expires <= clock())
      throw new ApiError("validation_failed", "expires_at must be in the future", {
        errors: [{ pointer: "/expires_at", detail: "must be in the future" }],
      });
    const set = deps.peppers.pub;
    if (!set)
      throw new ApiError("unavailable", "share keys are not configured (pepper_pub)", {
        retryAfter: 3600,
      });
    const k = mintKey("pub", set);
    const row = await ctx.tx(async (tx) => {
      await tx.audit({
        action: "share_key.created",
        targetType: "share_key",
        targetId: k.id,
        details: { expires_at: expires === null ? null : new Date(expires).toISOString() },
      });
      return tx.one<ShareKeyRow>(
        `INSERT INTO scf.share_keys (tenant_id, key_id, secret_hash, pepper_version, last4, label, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
        [
          ctx.tenant?.id,
          k.id,
          k.hash,
          k.pepperVersion,
          k.last4,
          b.label,
          ctx.session?.userId,
          expires === null ? null : new Date(expires),
        ],
      );
    });
    return {
      status: 201,
      body: { ...view(row), key: k.key },
      headers: { "cache-control": "no-store" },
    };
  };

  const revokeShareKey: Handler = async (ctx) => {
    const keyId = ctx.params.keyId as string;
    await ctx.tx(async (tx) => {
      const cur = await tx.maybeOne<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM scf.share_keys WHERE tenant_id = $1 AND key_id = $2 FOR UPDATE`,
        [ctx.tenant?.id, keyId],
      );
      if (!cur) throw new ApiError("not_found");
      await tx.audit({
        action: "share_key.revoked",
        targetType: "share_key",
        targetId: keyId,
        details: cur.revoked_at ? { already_revoked: true } : {},
      });
      if (cur.revoked_at) return;
      await tx.query(
        `UPDATE scf.share_keys SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND key_id = $2`,
        [ctx.tenant?.id, keyId, ctx.session?.userId],
      );
    });
    return { status: 204 };
  };

  return { listShareKeys, createShareKey, revokeShareKey };
}
