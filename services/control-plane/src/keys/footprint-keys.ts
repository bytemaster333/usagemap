// SPDX-License-Identifier: Apache-2.0
// Footprint registration keys `scfa_reg_…` (migration 0081;
// wire-formats §k). A tenant API key with exactly one scope, `footprint:register`: a build tool (the Scaffold Stellar
// post-deploy extension, templates/scaffold-stellar) adds the contract it just deployed as a `claimed` footprint item.
// It cannot verify, remove or read anything, and it answers for one tenant (and optionally one network) only.
//
//   listFootprintKeys / createFootprintKey / revokeFootprintKey   tenant `admin`/`owner`, recent sign-in for changes;
//                                    the full key is in the creation response only (no-store), the database holds id,
//                                    last4 and HMAC-SHA-256(pepper_reg[version], secret);
//   registerFootprintContract       `Authorization: Bearer scfa_reg_…`, no session: grammar + CRC offline, lookup by id
//                                    (scf.lookup_footprint_key), constant-time HMAC, then usable (not revoked/expired),
//                                    path tenant = key tenant (else 404, no oracle), network binding (else 403), the
//                                    creator still `admin`/`owner` of the tenant (else 401). The write runs under the
//                                    key's tenant as actor `system` / `footprint_key:<id>` and acts for the creator
//                                    (declared_contracts.created_by). Rate limits: http/pipeline.ts FOOTPRINT_KEY_LIMITS.
//
// Never logged or stored: the key or its secret. A key seen in a URL is never accepted (only the header is read).

import type { Database } from "../db/database.ts";
import { pgCode } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { addContractItem } from "../verify/footprint.ts";
import {
  displayOf,
  footprintPepperSet,
  mintKey,
  type Peppers,
  parseKey,
  verifySecret,
} from "./keys.ts";

export const FOOTPRINT_SCOPE = "footprint:register";
/** last_used_at is written at most once per this interval per key. */
const TOUCH_INTERVAL = "1 minute";

interface KeyRow extends Record<string, unknown> {
  key_id: string;
  last4: string;
  label: string;
  network: "mainnet" | "testnet" | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const COLS = "key_id, last4, label, network, created_at, expires_at, last_used_at, revoked_at";

function view(r: KeyRow): Record<string, unknown> {
  return {
    key_id: r.key_id,
    display: displayOf("reg", r.key_id, r.last4),
    label: r.label,
    scope: FOOTPRINT_SCOPE,
    network: r.network,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at?.toISOString() ?? null,
    last_used_at: r.last_used_at?.toISOString() ?? null,
    revoked_at: r.revoked_at?.toISOString() ?? null,
  };
}

/** The authenticated key: the tenant it answers for, its network binding and the member it acts for. */
export interface FootprintKeyAuth {
  keyId: string;
  tenantId: string;
  network: "mainnet" | "testnet" | null;
  createdBy: string;
}

/**
 * Verifies `Authorization: Bearer scfa_reg_…` for `pathTenant`. 401 for anything that is not a usable key of a creator
 * who is still `admin`/`owner`; 404 when the key belongs to another tenant or the tenant is removed (the same answer as
 * an unknown tenant, C-87).
 */
export async function authenticateFootprintKey(
  db: Database,
  peppers: Peppers,
  authorization: string | undefined,
  pathTenant: string,
  requestId: string,
): Promise<FootprintKeyAuth> {
  const m = typeof authorization === "string" ? /^Bearer (\S+)$/.exec(authorization) : null;
  if (!m)
    throw new ApiError(
      "unauthenticated",
      "a footprint registration key is required (Authorization: Bearer scfa_reg_…)",
    );
  const parsed = parseKey(m[1] as string, "reg");
  if (!parsed.ok) throw new ApiError("unauthenticated", "invalid key");
  const set = footprintPepperSet(peppers);
  const row = await db.tx(
    { tenantId: null, actorKind: "anonymous", actorId: null, requestId },
    (tx) =>
      tx.maybeOne<{
        tenant_id: string;
        secret_hash: Buffer;
        pepper_version: number;
        network: "mainnet" | "testnet" | null;
        created_by: string;
        usable: boolean;
      }>(
        `SELECT tenant_id::text AS tenant_id, secret_hash, pepper_version, network, created_by::text AS created_by,
                usable FROM scf.lookup_footprint_key($1)`,
        [parsed.key.id],
      ),
  );
  if (!row || !verifySecret(set, row.pepper_version, parsed.key.secret, row.secret_hash))
    throw new ApiError("unauthenticated", "invalid key");
  if (!row.usable) throw new ApiError("unauthenticated", "the key has been revoked or has expired");
  if (row.tenant_id !== pathTenant) throw new ApiError("not_found");
  const actor = await db.tx(
    {
      tenantId: row.tenant_id,
      actorKind: "system",
      actorId: `footprint_key:${parsed.key.id}`,
      requestId,
    },
    (tx) =>
      tx.maybeOne<{ role: string; status: string }>(
        `SELECT m.role::text AS role, t.status::text AS status
           FROM scf.tenants t LEFT JOIN scf.memberships m ON m.tenant_id = t.tenant_id AND m.user_id = $2
          WHERE t.tenant_id = $1 AND t.purged_at IS NULL`,
        [row.tenant_id, row.created_by],
      ),
  );
  if (!actor || actor.status === "removed") throw new ApiError("not_found");
  if (actor.role !== "admin" && actor.role !== "owner")
    throw new ApiError(
      "unauthenticated",
      "the member who created this key is no longer an admin of the project",
    );
  return {
    keyId: parsed.key.id,
    tenantId: row.tenant_id,
    network: row.network,
    createdBy: row.created_by,
  };
}

export function footprintKeyHandlers(deps: {
  peppers: Peppers;
  now?: () => number;
}): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  const listFootprintKeys: Handler = async (ctx) => {
    if (ctx.tenant?.status === "removed") throw new ApiError("not_found");
    const rows = await ctx.tx((tx) =>
      tx.query<KeyRow>(
        `SELECT ${COLS} FROM scf.footprint_keys WHERE tenant_id = $1 ORDER BY created_at DESC, key_id`,
        [ctx.tenant?.id],
      ),
    );
    return { status: 200, body: rows.map(view), headers: { "cache-control": "no-store" } };
  };

  const createFootprintKey: Handler = async (ctx) => {
    const b = ctx.body as {
      label: string;
      network?: "mainnet" | "testnet" | null;
      expires_at?: string | null;
    };
    const expires = b.expires_at ? Date.parse(b.expires_at) : null;
    if (expires !== null && expires <= clock())
      throw new ApiError("validation_failed", "expires_at must be in the future", {
        errors: [{ pointer: "/expires_at", detail: "must be in the future" }],
      });
    const set = footprintPepperSet(deps.peppers);
    if (!set)
      throw new ApiError(
        "unavailable",
        "footprint registration keys are not configured (pepper_reg)",
        { retryAfter: 3600 },
      );
    const k = mintKey("reg", set);
    const network = b.network ?? null;
    const row = await ctx.tx(async (tx) => {
      let r: KeyRow;
      try {
        r = await tx.one<KeyRow>(
          `INSERT INTO scf.footprint_keys (tenant_id, key_id, secret_hash, pepper_version, last4, label, network,
                                           created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS}`,
          [
            ctx.tenant?.id,
            k.id,
            k.hash,
            k.pepperVersion,
            k.last4,
            b.label,
            network,
            ctx.session?.userId,
            expires === null ? null : new Date(expires),
          ],
        );
      } catch (err) {
        // the footprint_keys_limit trigger raises 23514 without a constraint name
        if (pgCode(err) === "23514" && !(err as { constraint?: string }).constraint)
          throw new ApiError(
            "quota_exceeded",
            "at most 5 usable footprint registration keys per project",
          );
        throw err;
      }
      await tx.audit({
        action: "footprint_key.created",
        targetType: "footprint_key",
        targetId: k.id,
        details: {
          scope: FOOTPRINT_SCOPE,
          network,
          expires_at: expires === null ? null : new Date(expires).toISOString(),
          pepper_version: k.pepperVersion,
        },
      });
      return r;
    });
    return {
      status: 201,
      body: { ...view(row), key: k.key },
      headers: { "cache-control": "no-store" },
    };
  };

  const revokeFootprintKey: Handler = async (ctx) => {
    const keyId = ctx.params.keyId as string;
    await ctx.tx(async (tx) => {
      const cur = await tx.maybeOne<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM scf.footprint_keys WHERE tenant_id = $1 AND key_id = $2 FOR UPDATE`,
        [ctx.tenant?.id, keyId],
      );
      if (!cur) throw new ApiError("not_found");
      await tx.audit({
        action: "footprint_key.revoked",
        targetType: "footprint_key",
        targetId: keyId,
        details: cur.revoked_at ? { already_revoked: true } : {},
      });
      if (cur.revoked_at) return;
      await tx.query(
        `UPDATE scf.footprint_keys SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND key_id = $2`,
        [ctx.tenant?.id, keyId, ctx.session?.userId],
      );
    });
    return { status: 204 };
  };

  const registerFootprintContract: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    // authenticated by the pipeline (http/pipeline.ts) before the body was read
    const key = ctx.footprintKey;
    if (!key) throw new ApiError("unauthenticated", "a footprint registration key is required");
    const b = ctx.body as {
      kind?: "contract";
      subject: string;
      network: "mainnet" | "testnet";
      label?: string;
    };
    if (key.network !== null && key.network !== b.network)
      throw new ApiError("forbidden", `this key registers ${key.network} contracts only`);
    const body = await ctx.tx(
      async (tx) => {
        const item = await addContractItem(
          tx,
          tenantId,
          key.createdBy,
          {
            subject: b.subject,
            mainnet: b.network === "mainnet",
            ...(b.label !== undefined ? { label: b.label } : {}),
          },
          { via: "footprint_key", key_id: key.keyId },
        );
        await tx.query(
          `UPDATE scf.footprint_keys SET last_used_at = now()
            WHERE tenant_id = $1 AND key_id = $2
              AND (last_used_at IS NULL OR last_used_at < now() - interval '${TOUCH_INTERVAL}')`,
          [tenantId, key.keyId],
        );
        return item;
      },
      {
        tenantId,
        actorKind: "system",
        actorId: `footprint_key:${key.keyId}`,
        reauthenticatedAt: null,
      },
    );
    return { status: 201, body, headers: { "cache-control": "no-store" } };
  };

  return { listFootprintKeys, createFootprintKey, revokeFootprintKey, registerFootprintContract };
}
