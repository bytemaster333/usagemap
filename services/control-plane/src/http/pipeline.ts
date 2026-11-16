// SPDX-License-Identifier: Apache-2.0
// The request pipeline every public operation goes through, driven by the OpenAPI metadata (C-89: the isolation matrix
// can be generated from `x-required-role` alone, so enforcement is generated from it too):
//
//   rate limit → CSRF (state-changing) → authentication → path ids (malformed = 404) → query validation →
//   tenant membership (404; a removed tenant's data reads also 404, C-08) →
//   tenant role / platform role (403) → read-only mode (403 for writes, ops.end-of-window-read-only) → passkey step-up (C-09) →
//   recent authentication (C-87; operators: step-up, C-114) → body validation →
//   handler (or 501 for an operation not built yet)

import type { FastifyReply, FastifyRequest } from "fastify";
import {
  clearCookie,
  isComplete,
  parseCookies,
  recentAuthValidUntil,
  SESSION_COOKIE,
  type Session,
  type SessionStore,
  stepUpValidUntil,
} from "../auth/sessions.ts";
import type { Database, Tx, TxContext } from "../db/database.ts";
import { signOutPending } from "../domain/account.ts";
import type { FootprintKeyAuth } from "../keys/footprint-keys.ts";
// MCP OAuth: delegated tokens of the hosted MCP server (src/oauth/principal.ts)
import { delegatedBearer, oauthSession } from "../oauth/principal.ts";
import type { OAuthPrincipal } from "../oauth/service.ts";
import { cpMetrics, routeClassOf } from "../obs/metrics.ts";
import { sha256 } from "../util/ids.ts";
import type { ConcurrencyGate } from "./concurrency.ts";
import { type OperationSpec, type RequiredRole, toFieldErrors } from "./openapi.ts";
import { ApiError } from "./problem.ts";
import { type Limit, type Limiter, subnetOf } from "./ratelimit.ts";

export type TenantRole = "owner" | "admin" | "member" | "viewer";
export type TenantStatus = "pending" | "active" | "suspended" | "removed";
const RANK: Record<TenantRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export interface TenantAccess {
  id: string;
  role: TenantRole;
  status: TenantStatus;
}

export interface RequestContext {
  op: OperationSpec;
  requestId: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  cookies: Map<string, string>;
  header(name: string): string | undefined;
  session: Session | null;
  tenant: TenantAccess | null;
  /** Truncated client subnet; memory only (rate limits). */
  subnet: string;
  /** The verified footprint registration key of a `footprint_key` operation (keys/footprint-keys.ts); else null. */
  footprintKey?: FootprintKeyAuth | null;
  /** Opens a transaction in this request's context (tenant of the path, the signed-in user). */
  tx<T>(fn: (tx: Tx) => Promise<T>, override?: Partial<TxContext>): Promise<T>;
}

export interface HandlerResult {
  status: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string | string[]>;
}

export type Handler = (ctx: RequestContext) => Promise<HandlerResult>;

export interface PipelineDeps {
  db: Database;
  sessions: SessionStore;
  limiter: Limiter;
  portalOrigin: string;
  /** Creating calls per client subnet per hour (C-64; `SCF_CREATE_LIMIT_PER_HOUR`, default 60). */
  createLimitPerHour?: number;
  /** Verifier of footprint registration keys `scfa_reg_…` (keys/footprint-keys.ts); without it they are refused (401). */
  footprintKeys?:
    | {
        authenticate(
          authorization: string | undefined,
          tenantId: string,
          requestId: string,
        ): Promise<FootprintKeyAuth>;
      }
    | undefined;
  /** Verifier of delegated MCP OAuth tokens (`scfa_odt_…`, src/oauth); without it such a bearer is refused (401). */
  oauth?:
    | { delegatedPrincipal(token: string, requestId: string): Promise<OAuthPrincipal | null> }
    | undefined;
  /**
   * Gate of the SCF-operator console reads (`GET` operations with an operator role, src/http/concurrency.ts): they
   * serialise on the platform audit chain in the database, so without it a burst of them holds every pooled connection
   * and other requests' session lookups time out. Without a gate they run unlimited.
   */
  operatorReads?: ConcurrencyGate | undefined;
}

/** Operations a partial SCF-operator session (first factor done, passkey pending, C-09) may call. */
const PARTIAL_ALLOWED = new Set([
  "authGetSession",
  "authLogout",
  "authPasskeyAssertionOptions",
  "authPasskeyAssertionVerify",
]);
/** Passkey registration is allowed in a partial session only while the user has no passkey (first enrolment). */
const FIRST_PASSKEY = new Set(["authPasskeyRegistrationOptions", "authPasskeyRegistrationVerify"]);
/** Live passkeys an SCF operator needs before any operator operation (C-20). */
export const MIN_OPERATOR_PASSKEYS = 2;
/** Problem detail of that refusal; the portal recognises it and offers to register the second passkey. */
export const SECOND_PASSKEY_DETAIL =
  "register a second passkey before using operator operations (C-20)";
const CREATION = new Set(["createTenant", "createSite", "createService"]);
const STATE_CHANGING = new Set(["post", "put", "patch", "delete"]);

/**
 * Tenant-scoped reads that stay available while the tenant is `removed` (C-08, data-model §8.3: a removed tenant's data
 * is hidden from every view). What remains is the tenant record itself (its status and purge date), who belongs to it,
 * its own audit trail, and its erasure requests (data-subject rights continue until the purge). Every other tenant
 * read answers the same 404 as an unknown tenant's data.
 */
export const REMOVED_TENANT_READABLE = new Set([
  "getTenant",
  "listMembers",
  "listTenantAudit",
  "listErasureRequests",
  "getErasureRequest",
]);

/**
 * State-changing operations still allowed in platform read-only mode (ops.end-of-window-read-only): signing in and out and the passkey
 * ceremonies (every `auth*` operation), the data subject's own rights (profile correction, unlinking, passkey removal,
 * account deletion, erasure requests), removals and purges (they only reduce what is held), revocations of keys,
 * tokens and operator grants (they only reduce access), and the settings switch itself (to leave read-only mode).
 */
export const READ_ONLY_ALLOWED = new Set([
  "updateMe",
  "deleteMe",
  "unlinkIdentity",
  "deletePasskey",
  "removeOwnTenant",
  "revokeIngestToken",
  "revokeShareKey",
  "revokeFootprintKey",
  "revokeTractionSnapshot",
  // MCP OAuth (src/oauth): connecting an app is signing in by another route, so it stays open like every auth*
  // operation; disconnecting only reduces access. (The protocol endpoints run outside this pipeline.)
  "revokeMyOAuthGrant",
  "approveOAuthRequest",
  "denyOAuthRequest",
  "oauthRegisterClient",
  "oauthToken",
  "oauthRevoke",
  "createErasureRequest",
  "confirmErasureRequest",
  "cancelErasureRequest",
  "operatorRemoveTenant",
  "operatorPurgeTenant",
  "operatorRevokeApiKey",
  "operatorRevoke",
  "operatorUpdateSetting",
]);

export const READ_ONLY_DETAIL = "the platform is in read-only mode";

/** The `read_only_mode` setting (ops.end-of-window-read-only); a missing or malformed row means off. */
export interface ReadOnlyMode {
  enabled: boolean;
  ingest: "accept" | "pause";
}

export function parseReadOnlyMode(v: unknown): ReadOnlyMode {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return { enabled: o.enabled === true, ingest: o.ingest === "pause" ? "pause" : "accept" };
  }
  return { enabled: false, ingest: "accept" };
}

/** Cached per database: a switch takes effect on every instance within READ_ONLY_CACHE_MS. */
export const READ_ONLY_CACHE_MS = 5_000;
let readOnlyCache = new WeakMap<Database, { at: number; value: ReadOnlyMode }>();

/** Forgets the cached mode in this process (called when the setting is changed here). */
export function invalidateReadOnlyMode(): void {
  readOnlyCache = new WeakMap();
}

export async function readOnlyMode(db: Database, requestId?: string): Promise<ReadOnlyMode> {
  const hit = readOnlyCache.get(db);
  if (hit && Date.now() - hit.at < READ_ONLY_CACHE_MS) return hit.value;
  const row = await db.tx(
    {
      tenantId: null,
      actorKind: "system",
      actorId: "read_only_mode",
      requestId: requestId ?? null,
    },
    (tx) =>
      tx.maybeOne<{ value: unknown }>(
        `SELECT value FROM scf.settings WHERE key = 'read_only_mode'`,
      ),
  );
  const value = parseReadOnlyMode(row?.value);
  readOnlyCache.set(db, { at: Date.now(), value });
  return value;
}

function tenantMinRole(roles: readonly RequiredRole[]): TenantRole | undefined {
  const t = roles
    .filter((r): r is `tenant:${TenantRole}` => r.startsWith("tenant:"))
    .map((r) => r.slice(7) as TenantRole);
  if (t.length === 0) return undefined;
  return t.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

export const DEFAULT_CREATE_LIMIT_PER_HOUR = 60;
/**
 * Footprint registration with a `scfa_reg_…` key (registerFootprintContract, migration 0081): per client subnet and per
 * key id. The key id is read from the bearer value before authentication (grammar and CRC only); it is no secret, so
 * a stranger who knows it can at most use up that key's window, never act with it.
 */
export const FOOTPRINT_KEY_LIMITS = { perSubnetMin: 60, perKeyMin: 30, perKeyDay: 500 } as const;

/** The key id of a well-formed `Authorization: Bearer scfa_reg_…` value (rate-limit bucket only; not authentication). */
export function footprintKeyIdOf(authorization: string | undefined): string | undefined {
  const m =
    typeof authorization === "string"
      ? /^Bearer scfa_reg_([0-9A-Za-z]{12})_[0-9A-Za-z]{33}$/.exec(authorization)
      : null;
  return m ? m[1] : undefined;
}
/** Registry picker searches per client subnet per minute (on top of the general public limit). */
export const REGISTRY_SEARCH_PER_MIN = 30;

export function limitsFor(
  op: OperationSpec,
  session: Session | null,
  subnet: string,
  createLimitPerHour: number = DEFAULT_CREATE_LIMIT_PER_HOUR,
  footprintKeyId?: string,
): Limit[] {
  const min = 60_000;
  const limits: Limit[] = [];
  if (session) limits.push({ key: `s:${session.userId}`, limit: 600, windowMs: min });
  else if (op.operationId.startsWith("auth"))
    limits.push({ key: `a:${subnet}`, limit: 60, windowMs: min });
  else limits.push({ key: `p:${subnet}`, limit: 600, windowMs: min });
  // The public registry picker (searchRegistryProjects): small pages and its own per-subnet limit, so it is no bulk
  // export of the registry.
  if (op.operationId === "searchRegistryProjects")
    limits.push({ key: `rs:${subnet}`, limit: REGISTRY_SEARCH_PER_MIN, windowMs: min });
  if (op.roles?.includes("footprint_key")) {
    limits.push({ key: `fk:${subnet}`, limit: FOOTPRINT_KEY_LIMITS.perSubnetMin, windowMs: min });
    if (footprintKeyId) {
      limits.push({
        key: `fkm:${footprintKeyId}`,
        limit: FOOTPRINT_KEY_LIMITS.perKeyMin,
        windowMs: min,
      });
      limits.push({
        key: `fkd:${footprintKeyId}`,
        limit: FOOTPRINT_KEY_LIMITS.perKeyDay,
        windowMs: 24 * 60 * min,
      });
    }
  }
  if (CREATION.has(op.operationId)) {
    // C-64: sign-up and site/service creation, per identity and per subnet.
    if (session) limits.push({ key: `c:${session.userId}`, limit: 20, windowMs: 60 * min });
    limits.push({ key: `cs:${subnet}`, limit: createLimitPerHour, windowMs: 60 * min });
  }
  return limits;
}

/** scf_cp_auth_events_total for the sign-in, passkey and step-up operations (method and outcome only). */
function recordAuth(operationId: string, session: Session | null, ok: boolean): void {
  switch (operationId) {
    case "authGithubCallback":
      cpMetrics.auth("github", ok ? "success" : "failed");
      return;
    case "authStellarVerify":
      cpMetrics.auth("stellar", ok ? "success" : "failed");
      return;
    case "authPasskeyRegistrationVerify":
      cpMetrics.auth("passkey", ok ? "passkey_registered" : "failed");
      return;
    case "authPasskeyAssertionVerify":
      // An assertion in a complete session is a step-up (C-09); otherwise the second factor of a sign-in.
      cpMetrics.auth(
        "passkey",
        ok ? "success" : session && isComplete(session) ? "step_up_failed" : "passkey_failed",
      );
      return;
    default:
      return;
  }
}

export function buildHandler(op: OperationSpec, handler: Handler | undefined, deps: PipelineDeps) {
  const minTenantRole = tenantMinRole(op.roles);
  const isPublic = op.roles.includes("public");
  // A footprint-key operation authenticates its bearer key in the handler (keys/footprint-keys.ts): no session.
  const keyAuthed = op.roles.includes("footprint_key");
  const operatorRole = op.roles.includes("operator")
    ? "operator"
    : op.roles.includes("operator_admin")
      ? "operator_admin"
      : undefined;

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const requestId = req.id;
    const cookies = parseCookies(req.headers.cookie);
    const subnet = subnetOf(req.ip);
    let session: Session | null;
    try {
      session = await deps.sessions.lookup(cookies.get(SESSION_COOKIE), requestId);
    } catch (err) {
      // Sign-out fails closed even when the session cannot be looked up (database unreachable, pool exhausted): a
      // request that passes the CSRF check has its cookie refused here and revoked as presented (retried until
      // written), and the cookie is cleared. Anything else surfaces the error (503 for an unavailable database).
      const token = cookies.get(SESSION_COOKIE);
      if (
        op.operationId === "authLogout" &&
        token &&
        /^[A-Za-z0-9_-]{43}$/.test(token) &&
        req.headers["x-scf-request"] === "1" &&
        req.headers.origin === deps.portalOrigin
      ) {
        await deps.sessions.signOut(sha256(token), { userId: null }, requestId);
        throw signOutPending({ "set-cookie": clearCookie(SESSION_COOKIE) });
      }
      throw err;
    }
    // MCP OAuth (src/oauth/principal.ts): a delegated token acts as its member, for its one tenant, on the allow-listed
    // GET operations only; it replaces any cookie session of the same request.
    const delegated = delegatedBearer(req.headers.authorization);
    if (delegated) {
      const p = (await deps.oauth?.delegatedPrincipal(delegated, requestId)) ?? null;
      if (!p) throw new ApiError("unauthenticated", "the OAuth token is not active");
      session = oauthSession(p, delegated, op, { ...(req.params as Record<string, string>) });
    }

    const verdict = await deps.limiter.hit(
      limitsFor(
        op,
        session,
        subnet,
        deps.createLimitPerHour,
        keyAuthed ? footprintKeyIdOf(req.headers.authorization) : undefined,
      ),
    );
    reply.header("RateLimit-Limit", String(verdict.limit));
    reply.header("RateLimit-Remaining", String(verdict.remaining));
    reply.header("RateLimit-Reset", String(verdict.reset));
    if (!verdict.allowed) {
      cpMetrics.rateLimited(routeClassOf(op.operationId));
      throw new ApiError("rate_limited", undefined, { retryAfter: verdict.reset });
    }

    if (STATE_CHANGING.has(op.method) && op.csrf) {
      if (req.headers["x-scf-request"] !== "1" || req.headers.origin !== deps.portalOrigin) {
        throw new ApiError("csrf_failed");
      }
    }

    if (!isPublic && !keyAuthed) {
      if (!session) throw new ApiError("unauthenticated");
      if (!isComplete(session)) {
        const ok =
          PARTIAL_ALLOWED.has(op.operationId) ||
          (FIRST_PASSKEY.has(op.operationId) && session.passkeyCount === 0);
        // Not signed in yet: every non-public operation documents 401; GET /v1/auth/session shows `complete: false`.
        if (!ok)
          throw new ApiError("unauthenticated", "passkey assertion required to complete sign-in");
      }
    }

    const params = { ...(req.params as Record<string, string>) };
    // A malformed path identifier names nothing that exists: the same 404 as an unknown or foreign one (C-87), which every
    // operation with a path identifier documents (400 is not documented on all of them).
    if (op.validateParams && !op.validateParams(params)) throw new ApiError("not_found");
    // A footprint-key operation authenticates its bearer key before anything else is looked at (401 for a missing or
    // unusable key, 404 when the key belongs to another tenant).
    let footprintKey: FootprintKeyAuth | null = null;
    if (keyAuthed) {
      if (!deps.footprintKeys)
        throw new ApiError("unauthenticated", "footprint registration keys are not accepted here");
      footprintKey = await deps.footprintKeys.authenticate(
        req.headers.authorization,
        params.tenantId as string,
        requestId,
      );
    }
    const query = { ...(req.query as Record<string, unknown>) };
    for (const name of op.csvQuery) {
      const v = query[name];
      if (typeof v === "string") query[name] = v.split(",");
    }
    if (op.validateQuery && !op.validateQuery(query)) {
      throw new ApiError("validation_failed", undefined, {
        errors: toFieldErrors(op.validateQuery.errors, ""),
      });
    }

    let tenant: TenantAccess | null = null;
    if (minTenantRole) {
      const tenantId = params.tenantId;
      if (!session || !tenantId) throw new ApiError("not_found");
      const row = await deps.db.tx(
        { tenantId, actorKind: "user", actorId: session.userId, requestId },
        (tx) =>
          tx.maybeOne<{ role: TenantRole; status: TenantStatus }>(
            `SELECT m.role::text AS role, t.status::text AS status
               FROM scf.memberships m JOIN scf.tenants t ON t.tenant_id = m.tenant_id
              WHERE m.tenant_id = $1 AND m.user_id = $2 AND t.purged_at IS NULL`,
            [tenantId, session.userId],
          ),
      );
      // Not a member, unknown tenant and malformed-but-valid ids all answer the same 404 (C-87).
      if (!row) throw new ApiError("not_found");
      if (RANK[row.role] < RANK[minTenantRole]) throw new ApiError("forbidden");
      tenant = { id: tenantId, role: row.role, status: row.status };
      // A removed tenant is read-only until restored or purged (C-08): every state-changing tenant operation is refused.
      if (row.status === "removed" && STATE_CHANGING.has(op.method))
        throw new ApiError("forbidden", "the tenant has been removed");
      // …and its data is hidden from every view (C-08): the same 404 as for data that does not exist.
      if (row.status === "removed" && !REMOVED_TENANT_READABLE.has(op.operationId))
        throw new ApiError("not_found");
    }

    if (operatorRole) {
      if (!session) throw new ApiError("unauthenticated");
      const pr = session.platformRole;
      if (!pr || (operatorRole === "operator_admin" && pr !== "operator_admin"))
        throw new ApiError("forbidden");
      // C-20: an SCF operator registers at least two passkeys (one lost device must not lock the account out). Until the
      // second live passkey exists every operator operation is refused; registering one (an `authenticated` operation)
      // stays open.
      if (session.passkeyCount < MIN_OPERATOR_PASSKEYS)
        throw new ApiError("forbidden", SECOND_PASSKEY_DETAIL);
    }

    // ops.end-of-window-read-only: platform read-only mode refuses every write except those in READ_ONLY_ALLOWED.
    if (
      STATE_CHANGING.has(op.method) &&
      !op.operationId.startsWith("auth") &&
      !READ_ONLY_ALLOWED.has(op.operationId) &&
      (await readOnlyMode(deps.db, requestId)).enabled
    )
      throw new ApiError("forbidden", READ_ONLY_DETAIL);

    if (op.stepUp) {
      const until = session ? stepUpValidUntil(session) : null;
      if (!until || until.getTime() <= Date.now()) throw new ApiError("step_up_required");
    }
    const recentUntil = session ? recentAuthValidUntil(session) : null;
    if (op.recentAuth && (!recentUntil || recentUntil.getTime() <= Date.now())) {
      // For an SCF operator with a passkey recent authentication IS a step-up (C-114): say so.
      throw new ApiError(
        session?.platformRole && session.passkeyCount > 0
          ? "step_up_required"
          : "recent_auth_required",
      );
    }

    let body: unknown = req.body;
    if (op.validateBody) {
      if (body === undefined || body === null) {
        if (op.bodyRequired) {
          throw new ApiError("validation_failed", "request body required", {
            errors: [{ pointer: "", detail: "request body required" }],
          });
        }
      } else if (!op.validateBody(body)) {
        throw new ApiError("validation_failed", undefined, {
          errors: toFieldErrors(op.validateBody.errors, ""),
        });
      }
    } else {
      body = undefined;
    }

    if (!handler) throw new ApiError("not_implemented", `${op.operationId} is not built yet`);
    const run = handler;

    const recentFresh =
      recentUntil && recentUntil.getTime() > Date.now() && session
        ? session.reauthenticatedAt
        : null;
    const ctx: RequestContext = {
      op,
      requestId,
      params,
      query,
      body,
      cookies,
      header: (name) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
      session,
      tenant,
      subnet,
      footprintKey,
      // SCF-operator operations act as `operator` with the live platform role and the step-up time, which the op_*
      // functions and the database backstops check themselves (data-model §4, C-09, C-17).
      tx: (fn, override = {}) =>
        deps.db.tx(
          {
            tenantId: tenant?.id ?? null,
            actorKind: session ? (operatorRole ? "operator" : "user") : "anonymous",
            actorId: session?.userId ?? null,
            reauthenticatedAt: recentFresh,
            ...(operatorRole && session
              ? { platformRole: session.platformRole, stepUpAt: session.stepUpAt }
              : {}),
            requestId,
            ...override,
          },
          fn,
        ),
    };
    if (operatorRole && session && op.method === "get") cpMetrics.operatorRead(session.userId);
    let result: Awaited<ReturnType<Handler>>;
    try {
      result =
        operatorRole && op.method === "get" && deps.operatorReads
          ? await deps.operatorReads.run(() => run(ctx))
          : await run(ctx);
    } catch (err) {
      recordAuth(op.operationId, session, false);
      throw err;
    }
    recordAuth(op.operationId, session, true);
    for (const [k, v] of Object.entries(result.headers ?? {})) reply.header(k, v);
    reply.code(result.status);
    if (result.body === undefined) {
      await reply.send();
      return;
    }
    if (result.contentType) reply.type(result.contentType);
    await reply.send(result.body);
  };
}
