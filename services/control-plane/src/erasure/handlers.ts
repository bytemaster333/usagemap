// SPDX-License-Identifier: Apache-2.0
// Tenant-triggered erasure (privacy.tenant-erasure, privacy.erasure-workflow; data-model §8.8, docs/privacy/erasure.md §3): createErasureRequest (the
// count-only preview is computed by job `erasure`, which alone can read the `umami` database — 202, poll until
// `previewed`), listErasureRequests, getErasureRequest (with the completion report), confirmErasureRequest (fresh
// sign-in ≤ 10 min: `x-requires-recent-auth` in the pipeline and the `erasure_confirm_reauth` trigger, C-87) and
// cancelErasureRequest. Owner and admin only (`tenant:admin`). Every identifier is resolved under the caller's tenant
// (C-87); audit rows carry the selector TYPE and counts, never the literal selector (C-88).

import { pgCode, type Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { type Criteria, parseRange, type Scope, selectorOf } from "./criteria.ts";
import { COLUMNS, loadRequest, type RequestRow, requestView } from "./requests.ts";

export interface ErasureDeps {
  /** Wakes the in-process erasure worker after a request or a confirmation. */
  wake?: (() => void) | undefined;
  now?: () => number;
}

interface CreateBody {
  site_id?: string;
  service_id?: string;
  scope?: Scope;
  criteria: Criteria;
}

function auditOf(r: RequestRow, counts: unknown) {
  return {
    targetType: "erasure_request",
    targetId: r.request_id,
    details: {
      request_id: r.request_id,
      scope: r.scope,
      selector_type: selectorOf(r.criteria)?.type ?? null,
      counts,
    },
  };
}

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(c: string): string {
  const id = Buffer.from(c, "base64url").toString("utf8");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new ApiError("validation_failed", "invalid cursor", {
      errors: [{ pointer: "/cursor", detail: "not a cursor returned by this operation" }],
    });
  return id;
}

export function erasureHandlers(deps: ErasureDeps): Record<string, Handler> {
  const tenantOf = (ctx: RequestContext) => ctx.params.tenantId as string;
  const userOf = (ctx: RequestContext) => ctx.session?.userId as string;

  async function mustLoad(tx: Tx, ctx: RequestContext, lock = false): Promise<RequestRow> {
    const r = await loadRequest(tx, tenantOf(ctx), ctx.params.requestId as string, lock);
    if (!r) throw new ApiError("not_found");
    return r;
  }

  const createErasureRequest: Handler = async (ctx) => {
    const body = ctx.body as CreateBody;
    const scope: Scope = body.scope ?? "filtered";
    const range = parseRange(body.criteria);
    if (!("start" in range))
      throw new ApiError("validation_failed", range.detail, { errors: [range] });
    const c = body.criteria;
    // Without a selector, every aggregate row of the range goes — daily breakdown rows and API
    // metric buckets up to one day wide — so the range must be whole UTC days; otherwise the rest of a partly covered
    // day would be erased from the aggregates while its events stay in the engine.
    const hasSelector = [c.path_pattern, c.event_name, c.property_key].some(
      (v) => typeof v === "string",
    );
    if (!hasSelector) {
      for (const [k, d] of [
        ["start", range.start],
        ["end", range.end],
      ] as const)
        if (d.getTime() % 86_400_000 !== 0)
          throw new ApiError(
            "validation_failed",
            "a request without a selector covers whole UTC days: start and end must be 00:00 UTC",
            {
              errors: [
                { pointer: `/criteria/${k}`, detail: "must be 00:00 UTC without a selector" },
              ],
            },
          );
    }
    if (body.service_id && typeof c.event_name === "string")
      throw new ApiError("validation_failed", "event_name applies to sites only", {
        errors: [{ pointer: "/criteria/event_name", detail: "API services have no event names" }],
      });
    const criteria = {
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      path_pattern: c.path_pattern ?? null,
      event_name: c.event_name ?? null,
      property_key: c.property_key ?? null,
    };
    const tenantId = tenantOf(ctx);
    const row = await ctx.tx(async (tx) => {
      // Body identifiers are resolved under the caller's tenant: foreign and unknown ids are the same 404 (C-87).
      if (body.site_id) {
        const s = await tx.maybeOne(
          `SELECT 1 FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`,
          [tenantId, body.site_id],
        );
        if (!s) throw new ApiError("not_found");
      }
      if (body.service_id) {
        const s = await tx.maybeOne(
          `SELECT 1 FROM scf.api_services WHERE tenant_id = $1 AND service_id = $2`,
          [tenantId, body.service_id],
        );
        if (!s) throw new ApiError("not_found");
      }
      const r = await tx.one<RequestRow>(
        `INSERT INTO scf.erasure_requests (tenant_id, site_id, service_id, scope, criteria, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [
          tenantId,
          body.site_id ?? null,
          body.service_id ?? null,
          scope,
          JSON.stringify(criteria),
          userOf(ctx),
        ],
      );
      await tx.audit({ action: "erasure.requested", ...auditOf(r, null) });
      // The erasure worker runs in the jobs service (F16): NOTIFY wakes it at commit.
      await tx.query(`SELECT pg_notify('scf_erasure', '')`);
      return r;
    });
    deps.wake?.();
    return { status: 202, body: requestView(row) };
  };

  const listErasureRequests: Handler = async (ctx) => {
    const limit = Number(ctx.query.limit ?? 50);
    const after = typeof ctx.query.cursor === "string" ? decodeCursor(ctx.query.cursor) : null;
    const rows = await ctx.tx((tx) =>
      tx.query<RequestRow>(
        `SELECT ${COLUMNS} FROM scf.erasure_requests
          WHERE tenant_id = $1 AND ($2::uuid IS NULL OR request_id < $2::uuid)
          ORDER BY request_id DESC LIMIT $3`,
        [tenantOf(ctx), after, limit + 1],
      ),
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      status: 200,
      body: {
        items: page.map(requestView),
        next_cursor: rows.length > limit && last ? encodeCursor(last.request_id) : null,
      },
    };
  };

  const getErasureRequest: Handler = async (ctx) => {
    const r = await ctx.tx((tx) => mustLoad(tx, ctx));
    return { status: 200, body: requestView(r) };
  };

  const confirmErasureRequest: Handler = async (ctx) => {
    const row = await ctx
      .tx(async (tx) => {
        const r = await mustLoad(tx, ctx, true);
        if (r.status !== "previewed")
          throw new ApiError(
            "conflict",
            r.status === "previewing"
              ? "the preview is not ready yet"
              : `a ${r.status} request cannot be confirmed`,
          );
        const u = await tx.one<RequestRow>(
          `UPDATE scf.erasure_requests SET status = 'confirmed', confirmed_by = $3, confirmed_at = now()
            WHERE tenant_id = $1 AND request_id = $2 RETURNING ${COLUMNS}`,
          [r.tenant_id, r.request_id, userOf(ctx)],
        );
        await tx.audit({ action: "erasure.confirmed", ...auditOf(u, u.preview) });
        await tx.query(`SELECT pg_notify('scf_erasure', '')`);
        return u;
      })
      .catch((err: unknown) => {
        // The database backstop (`erasure_confirm_reauth`, C-87) refused: the sign-in is not fresh.
        if (pgCode(err) === "42501") throw new ApiError("recent_auth_required");
        throw err;
      });
    deps.wake?.();
    return { status: 202, body: requestView(row) };
  };

  const cancelErasureRequest: Handler = async (ctx) => {
    const row = await ctx.tx(async (tx) => {
      const r = await mustLoad(tx, ctx, true);
      if (r.status !== "previewing" && r.status !== "previewed")
        throw new ApiError("conflict", `a ${r.status} request cannot be cancelled`);
      const u = await tx.one<RequestRow>(
        `UPDATE scf.erasure_requests SET status = 'cancelled', finished_at = now()
          WHERE tenant_id = $1 AND request_id = $2 RETURNING ${COLUMNS}`,
        [r.tenant_id, r.request_id],
      );
      await tx.audit({ action: "erasure.cancelled", ...auditOf(u, null) });
      return u;
    });
    return { status: 200, body: requestView(row) };
  };

  return {
    createErasureRequest,
    listErasureRequests,
    getErasureRequest,
    confirmErasureRequest,
    cancelErasureRequest,
  };
}
