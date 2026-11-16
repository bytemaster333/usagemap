// SPDX-License-Identifier: Apache-2.0
// Operator metrics API (`/op/v1`, docs/api/operator-metrics.openapi.yaml; keys.operator-api-keys, keys.revocation,
// operator.api-*, operator.web-* machine side). Its own small pipeline, driven by that document:
//
//   key in the (decoded) URL → 401 · Accept (406) · subnet blocked after too many failed authentications (429) ·
//   bearer key: grammar + CRC offline (bad CRC → 401, audited) → lookup by id
//   (scf_metrics_ro, cache ≤ 5 s, C-06) → constant-time HMAC under the row's pepper version → revoked / expired → 401 →
//   per-key rate limit (429 + Retry-After) → scope (`x-required-scope`, 403) → path ids (malformed = 404) → query
//   validation (400) → handler.
//
// Every data read is one or more `op_*` functions in a transaction whose context is `actor_kind = op_key` with the
// key's scopes and tenant restriction (data-model §11): the database authorises, intersects the restriction, audits
// and applies the privacy rules (C-17, C-95). Nothing here reads a tenant table.

import { operatorMetricsOpenApi } from "@usagemap/api-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database, Tx } from "../db/database.ts";
import { OpenApi, type OperationSpec, toFieldErrors } from "../http/openapi.ts";
import { ApiError } from "../http/problem.ts";
import { type Limiter, RateLimiter, subnetOf } from "../http/ratelimit.ts";
import type { Peppers } from "../keys/keys.ts";
// MCP OAuth: an operator grant's delegated token reads /op/v1 like a read-only key
import { delegatedBearer, oauthOperatorKey } from "../oauth/principal.ts";
import type { OAuthPrincipal } from "../oauth/service.ts";
import { cpMetrics } from "../obs/metrics.ts";
import {
  API_COLUMNS,
  type ApiMetricRow,
  apiCellsMachine,
  dayString,
  decodeCursor,
  levelName,
  levelNumber,
  num,
  numOrNull,
  op,
  type ProjectLabel,
  page,
  privacySettings,
  projectLabels,
  sorter,
  toCsv,
  WEB_COLUMNS,
  type WebRow,
  webCells,
} from "../operator/common.ts";
import { cohortFigures, readCohorts } from "../operator/footprint.ts";
import { type KeyRow, OpKeyAuth } from "./keyauth.ts";

export interface OpMetricsDeps {
  /** scf_metrics_ro; undefined = every operation answers 503. */
  db: Database | undefined;
  peppers: Peppers;
  now?: () => number;
  /** Shared key verifier (one cache for `/op/v1` and the metrics_endpoint). */
  keyAuth?: OpKeyAuth;
  /** The control plane's shared limiter (F21); default: in-memory. */
  limiter?: Limiter;
  /** Verifier of delegated MCP OAuth tokens (src/oauth); without it such a bearer is refused (401). */
  oauth?: { delegatedPrincipal(token: string, requestId: string): Promise<OAuthPrincipal | null> };
}

export { KEY_CACHE_MS } from "./keyauth.ts";

/**
 * Failed key authentications per client subnet (IPv4 /24, IPv6 /48) and minute before the subnet is refused with 429
 * BEFORE any key lookup. Only failures count, so a valid key keeps its own per-key budget (up to
 * 6,000/min, C-21); the counter lives in the shared limiter, the block in this process until the window resets.
 */
export const ANON_LIMIT_PER_MIN = 60;
const MAX_BLOCKED_SUBNETS = 10_000;

/** True when `url` (raw, or percent-decoded once) contains something shaped like an SCF key (wire-formats §k). */
export function keyInUrl(url: string): boolean {
  const re = /scfa_(op|ing|pub)_/;
  if (re.test(url)) return true;
  try {
    return re.test(decodeURIComponent(url));
  } catch {
    return false;
  }
}

const SELF_ATTESTED = "self-attested telemetry";

interface Caller {
  key: KeyRow;
}

interface Ctx {
  op: OperationSpec;
  requestId: string;
  key: KeyRow;
  params: Record<string, string>;
  query: Record<string, unknown>;
  csv: boolean;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

interface Result {
  rows?: Record<string, unknown>[];
  body: Record<string, unknown>;
  nextCursor?: string | null;
}

type OpHandler = (ctx: Ctx) => Promise<Result>;

function hasScope(key: KeyRow, scope: string): boolean {
  return key.scopes.includes(scope);
}

export function registerOperatorMetrics(app: FastifyInstance, deps: OpMetricsDeps): void {
  const clock = deps.now ?? Date.now;
  const openapi = new OpenApi(operatorMetricsOpenApi());
  const limiter: Limiter = deps.limiter ?? new RateLimiter(clock);
  const auth = deps.keyAuth ?? new OpKeyAuth(deps.db, deps.peppers, clock);
  const handlers = metricsHandlers(clock);
  const keyEvent = (
    db: Database,
    action: "api_key.rate_limited",
    id: string,
    requestId: string,
    kind: "op_key",
  ) => auth.keyEvent(db, action, id, requestId, kind);
  const authenticate = async (req: FastifyRequest): Promise<Caller> => {
    const delegated = delegatedBearer(req.headers.authorization);
    if (delegated) {
      const p = (await deps.oauth?.delegatedPrincipal(delegated, req.id)) ?? null;
      if (!p) throw new ApiError("unauthenticated", "the OAuth token is not active");
      return { key: oauthOperatorKey(p) };
    }
    return auth.authenticate(req.headers.authorization, req.id);
  };
  /** Subnets refused until the given time after ANON_LIMIT_PER_MIN failed authentications. */
  const blocked = new Map<string, number>();
  const authenticateLimited = async (req: FastifyRequest, reply: FastifyReply): Promise<Caller> => {
    const subnet = subnetOf(req.ip);
    const until = blocked.get(subnet);
    if (until !== undefined) {
      const left = until - clock();
      if (left > 0) {
        cpMetrics.rateLimited("op_key");
        throw new ApiError("rate_limited", "too many failed authentications", {
          retryAfter: Math.max(1, Math.ceil(left / 1000)),
        });
      }
      blocked.delete(subnet);
    }
    try {
      return await authenticate(req);
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthenticated") {
        const v = await limiter.hit([
          { key: `op-fail:${subnet}`, limit: ANON_LIMIT_PER_MIN, windowMs: 60_000 },
        ]);
        reply.header("RateLimit-Limit", String(v.limit));
        reply.header("RateLimit-Remaining", String(v.remaining));
        reply.header("RateLimit-Reset", String(v.reset));
        if (v.remaining === 0) {
          if (blocked.size >= MAX_BLOCKED_SUBNETS) blocked.clear();
          blocked.set(subnet, clock() + v.reset * 1000);
          if (!v.allowed) {
            cpMetrics.rateLimited("op_key");
            throw new ApiError("rate_limited", "too many failed authentications", {
              retryAfter: v.reset,
            });
          }
        }
      }
      throw err;
    }
  };

  for (const spec of openapi.operations) {
    const handler = handlers[spec.operationId];
    const scope = spec.roles.map((r) => /^operator_key:(.+)$/.exec(r)?.[1]).find(Boolean) ?? null;
    app.route({
      method: spec.method.toUpperCase() as "GET",
      url: spec.routePath,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        // A key in the URL is a leaked key (wire-formats §k): never accepted there.
        // Tested on the raw and the percent-decoded URL: Fastify decodes `scfa%5Fop%5F…` into a query value (#24).
        if (keyInUrl(req.url)) {
          // …and an operator key found there is revoked at once (C-119, migration 0055).
          cpMetrics.opKey("key_in_url");
          await auth.revokeExposed(req.url, req.id);
          throw new ApiError(
            "unauthenticated",
            "keys are accepted only in the Authorization header; a key sent in a URL is revoked",
          );
        }
        const accept = String(req.headers.accept ?? "*/*");
        const q0 = req.query as Record<string, unknown>;
        const csv =
          q0.format === "csv" ||
          (q0.format !== "json" && accept.includes("text/csv") && !accept.includes("json"));
        if (
          !/(\*\/\*|application\/\*|application\/json|application\/problem\+json|text\/csv|text\/\*)/.test(
            accept,
          )
        )
          throw new ApiError("not_acceptable");
        reply.header("WWW-Authenticate", 'Bearer realm="scf-op-metrics"');
        const { key } = await authenticateLimited(req, reply);
        reply.removeHeader("WWW-Authenticate");
        const v = await limiter.hit([
          { key: `op:${key.key_id}`, limit: key.rate_limit_per_min, windowMs: 60_000 },
        ]);
        reply.header("RateLimit-Limit", String(v.limit));
        reply.header("RateLimit-Remaining", String(v.remaining));
        reply.header("RateLimit-Reset", String(v.reset));
        if (!v.allowed) {
          cpMetrics.opKey("rate_limited");
          cpMetrics.rateLimited("op_key");
          if (deps.db)
            await keyEvent(deps.db, "api_key.rate_limited", key.key_id, req.id, "op_key");
          throw new ApiError("rate_limited", undefined, { retryAfter: v.reset });
        }
        if (scope && !hasScope(key, scope))
          throw new ApiError("forbidden", `scope ${scope} required`);
        const params = { ...(req.params as Record<string, string>) };
        if (spec.validateParams && !spec.validateParams(params)) throw new ApiError("not_found");
        const query = { ...q0 };
        for (const name of spec.csvQuery) {
          const x = query[name];
          if (typeof x === "string") query[name] = x.split(",");
        }
        if (spec.validateQuery && !spec.validateQuery(query))
          throw new ApiError("validation_failed", undefined, {
            errors: toFieldErrors(spec.validateQuery.errors, ""),
          });
        if (!handler) throw new ApiError("not_implemented", `${spec.operationId} is not built yet`);
        const db = deps.db as Database;
        const ctx: Ctx = {
          op: spec,
          requestId: req.id,
          key,
          params,
          query,
          csv,
          tx: (fn) =>
            db.tx(
              {
                tenantId: null,
                actorKind: "op_key",
                actorId: key.key_id,
                keyScopes: key.scopes,
                keyTenants: key.tenant_restriction,
                requestId: req.id,
              },
              async (tx) => {
                // last_used_at at most once a minute (the only column scf_metrics_ro may update)
                await tx.query(
                  `UPDATE scf.operator_api_keys SET last_used_at = now()
                    WHERE key_id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
                  [key.key_id],
                );
                return fn(tx);
              },
            ),
        };
        const out = await handler(ctx);
        const privacy = out.body.privacy as { min_count: number; round_to: number } | undefined;
        if (privacy) {
          reply.header("X-SCF-Min-Count", String(privacy.min_count));
          reply.header("X-SCF-Round-To", String(privacy.round_to));
        }
        if (csv && out.rows) {
          if (out.nextCursor) {
            const u = new URL(req.url, "http://x");
            u.searchParams.set("cursor", out.nextCursor);
            reply.header("Link", `<${u.pathname}${u.search}>; rel="next"`);
          }
          await reply.code(200).type("text/csv; charset=utf-8").send(toCsv(out.rows));
          return;
        }
        await reply.code(200).type("application/json").send(out.body);
      },
    });
  }
}

// ================================================================================================ operations

function privacy(p: { minCount: number; roundTo: number }) {
  return {
    min_count: p.minCount,
    round_to: p.roundTo,
    rounding: "half_up_to_multiple",
    aggregation: "sum_of_unrounded_then_rounded",
    cross_tenant_deduplication: false,
  };
}

/**
 * The tenants a request names (`project_ids`, `scf_awarded`), intersected with the key's restriction. null = no filter
 * (the database applies the restriction itself). All named projects outside the restriction → 403.
 */
async function selection(ctx: Ctx, tx: Tx, minLevel: number) {
  const q = ctx.query;
  const restriction = ctx.key.tenant_restriction;
  let set: string[] | null = (q.project_ids as string[] | undefined) ?? null;
  if (set && restriction) {
    set = set.filter((t) => restriction.includes(t));
    if (set.length === 0)
      throw new ApiError(
        "forbidden",
        "all named projects are outside the key's tenant restriction",
      );
  }
  // Labels (slug) only for keys that may read the project registry (op_projects needs registry:read).
  const labels = hasScope(ctx.key, "registry:read")
    ? await projectLabels(tx, 0)
    : new Map<string, ProjectLabel>();
  if (typeof q.scf_awarded === "boolean") {
    if (!hasScope(ctx.key, "registry:read"))
      throw new ApiError("forbidden", "the scf_awarded filter needs scope registry:read");
    const keep = [...labels.values()]
      .filter((l) => (l.scfAwarded === true) === q.scf_awarded)
      .map((l) => l.tenantId);
    set = set ? set.filter((t) => keep.includes(t)) : keep;
  }
  void minLevel;
  return { tenants: set, labels };
}

/** The row's slug (C-119: op_* rows carry it, migration 0053), else the registry label when the key may read it. */
function slugOf(
  labels: Map<string, ProjectLabel>,
  id: string,
  rowSlug?: string | null,
): Record<string, string> {
  if (rowSlug) return { slug: rowSlug };
  const l = labels.get(id);
  return l ? { slug: l.slug } : {};
}

function meta(ctx: Ctx, extra: Record<string, unknown> = {}) {
  const q = ctx.query;
  return {
    start: String(q.start),
    end: String(q.end),
    generated_at: new Date().toISOString(),
    min_level: levelName(levelNumber(q.min_level)),
    ...extra,
  };
}

function paged(
  ctx: Ctx,
  rows: Record<string, unknown>[],
  bind: string,
  p: { minCount: number; roundTo: number },
  metaExtra: Record<string, unknown> = {},
): Result {
  const limit = Number(ctx.query.limit ?? 100);
  const offset = decodeCursor(ctx.query.cursor, bind);
  const pg = page(rows, offset, limit, bind);
  return {
    rows: pg.items,
    nextCursor: pg.next_cursor,
    body: {
      data: pg.items,
      next_cursor: pg.next_cursor,
      privacy: privacy(p),
      meta: meta(ctx, metaExtra),
    },
  };
}

const API_GROUP: Record<string, "tenant" | "service" | "route"> = {
  project: "tenant",
  service: "service",
  route: "route",
};

export function metricsHandlers(clock: () => number): Record<string, OpHandler> {
  const bindOf = (ctx: Ctx) =>
    `${ctx.op.operationId}:${JSON.stringify(
      Object.fromEntries(
        Object.entries(ctx.query)
          .filter(([k]) => !["cursor", "limit", "format"].includes(k))
          .sort(),
      ),
    )}`;

  const projectView = (l: ProjectLabel) => ({
    project_id: l.tenantId,
    slug: l.slug,
    name: l.name,
    status: l.status,
    created_at: l.createdAt.toISOString(),
    verification_level: levelName(l.level),
    scf_awarded: l.scfAwarded,
    registry_project_ids: l.registryProjectIds,
    site_count: l.siteCount,
    service_count: l.serviceCount,
  });

  async function apiRows(ctx: Ctx, bucket: "hour" | "day" | "range") {
    const q = ctx.query;
    const minLevel = levelNumber(q.min_level);
    const group = API_GROUP[String(q.group ?? "service")] ?? "service";
    return ctx.tx(async (tx) => {
      const sel = await selection(ctx, tx, minLevel);
      const rows = await op(() =>
        tx.query<ApiMetricRow>(
          `SELECT ${API_COLUMNS} FROM scf.op_api_metrics($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7::smallint)`,
          [
            q.start,
            q.end,
            bucket,
            group,
            sel.tenants,
            (q.service_ids as string[] | undefined) ?? null,
            minLevel,
          ],
        ),
      );
      const out = rows.map((r) => ({
        bucket_start: r.bucket_start ? r.bucket_start.toISOString() : null,
        project_id: String(r.tenant_id),
        ...slugOf(sel.labels, String(r.tenant_id), r.slug),
        service_id: r.service_id,
        service_name: r.service_name ?? null,
        route: r.route,
        rpc_method: r.rpc_method,
        verification_level: levelName(r.verification_level),
        ...apiCellsMachine(r),
      })) as Record<string, unknown>[];
      return { out, privacy: await privacySettings(tx) };
    });
  }

  function apiSort(rows: Record<string, unknown>[], sort: string) {
    rows.sort(
      sorter(
        sort,
        (r) => `${r.bucket_start ?? ""}|${r.project_id}|${r.service_id ?? ""}|${r.route ?? ""}`,
      ),
    );
  }

  async function webRows(ctx: Ctx, bucket: "day" | "range", group: "tenant" | "site" | "all") {
    const q = ctx.query;
    const minLevel = levelNumber(q.min_level);
    return ctx.tx(async (tx) => {
      const sel = await selection(ctx, tx, minLevel);
      const rows = await op(() =>
        tx.query<WebRow>(
          `SELECT ${WEB_COLUMNS} FROM scf.op_web_metrics($1, $2, $3, $4, $5::scf.web_variant, $6::uuid[], $7::smallint)`,
          [q.start, q.end, bucket, group, q.variant ?? "verified", sel.tenants, minLevel],
        ),
      );
      let counts: Map<string, number> | null = null;
      if (group === "all") {
        const per = await op(() =>
          tx.query<{ day: string; n: string }>(
            `SELECT day::text AS day, count(DISTINCT tenant_id)::text AS n
               FROM scf.op_web_metrics($1, $2, 'day', 'tenant', $3::scf.web_variant, $4::uuid[], $5::smallint)
              GROUP BY day`,
            [q.start, q.end, q.variant ?? "verified", sel.tenants, minLevel],
          ),
        );
        counts = new Map(per.map((r) => [r.day, Number(r.n)]));
      }
      return { rows, labels: sel.labels, counts, privacy: await privacySettings(tx) };
    });
  }

  const handlers: Record<string, OpHandler> = {
    metricsGetKeyInfo: async (ctx) => {
      await ctx.tx(async () => undefined); // touches last_used_at; not a data read (no audit row)
      return {
        body: {
          key_id: ctx.key.key_id,
          label: ctx.key.label,
          scopes: ctx.key.scopes,
          tenant_restriction: ctx.key.tenant_restriction,
          expires_at: ctx.key.expires_at.toISOString(),
          rate_limit_per_min: ctx.key.rate_limit_per_min,
        },
      };
    },

    metricsListProjects: async (ctx) => {
      const q = ctx.query;
      const minLevel = levelNumber(q.min_level);
      const { rows, p } = await ctx.tx(async (tx) => {
        const rows = await op(() =>
          tx.query<{ tenant_id: string }>(
            `SELECT tenant_id::text AS tenant_id FROM scf.op_projects($1::smallint, '{active,suspended}', $2)`,
            [minLevel, q.q ?? null],
          ),
        );
        const labels = await projectLabels(tx, 0);
        return {
          rows: rows
            .map((r) => labels.get(r.tenant_id))
            .filter((l): l is ProjectLabel => l !== undefined),
          p: await privacySettings(tx),
        };
      });
      const ids = q.project_ids as string[] | undefined;
      if (
        ids &&
        ctx.key.tenant_restriction &&
        !ids.some((i) => ctx.key.tenant_restriction?.includes(i))
      )
        throw new ApiError(
          "forbidden",
          "all named projects are outside the key's tenant restriction",
        );
      let list = rows.filter((l) => !ids || ids.includes(l.tenantId));
      if (typeof q.scf_awarded === "boolean")
        list = list.filter((l) => (l.scfAwarded === true) === q.scf_awarded);
      const items = list.map(projectView) as Record<string, unknown>[];
      const sort = String(q.sort ?? "slug");
      items.sort(
        sort === "-verification_level"
          ? (a, b) =>
              String(b.verification_level).localeCompare(String(a.verification_level)) ||
              String(a.slug).localeCompare(String(b.slug))
          : sorter(sort, (r) => String(r.project_id)),
      );
      const res = paged(ctx, items, bindOf(ctx), p);
      res.body.meta = {
        start: "1970-01-01T00:00:00Z",
        end: new Date(clock()).toISOString(),
        generated_at: new Date().toISOString(),
        min_level: levelName(minLevel),
      };
      return res;
    },

    metricsGetProject: async (ctx) => {
      const id = ctx.params.projectId as string;
      if (ctx.key.tenant_restriction && !ctx.key.tenant_restriction.includes(id))
        throw new ApiError("not_found");
      const l = await ctx.tx(async (tx) => (await projectLabels(tx, 0)).get(id));
      if (!l) throw new ApiError("not_found"); // unknown, pending, removed or outside the restriction: one 404
      return { body: projectView(l) };
    },

    metricsListRegistryProjects: async (ctx) => {
      const q = ctx.query;
      const { rows, linked, p } = await ctx.tx(async (tx) => {
        await tx.audit({
          action: "operator.read.registry",
          details: { q: q.q ?? null, scf_awarded: q.scf_awarded ?? null },
        });
        const rows = await tx.query<{
          registry_project_id: string;
          source: string;
          source_id: string;
          canonical_daoip5_id: string | null;
          name: string;
          websites: string[] | null;
          scf_awarded: boolean | null;
          scf_awards: unknown;
          source_url: string | null;
          source_as_of: string | null;
          fetched_at: Date;
        }>(
          `SELECT registry_project_id::text AS registry_project_id, source, source_id, canonical_daoip5_id, name,
                  websites, scf_awarded, scf_awards, source_url, source_as_of::text AS source_as_of, fetched_at
             FROM scf.registry_projects
            WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR source_id ILIKE '%' || $1 || '%')
              AND ($2::boolean IS NULL OR scf_awarded IS NOT DISTINCT FROM $2)
            ORDER BY name, registry_project_id`,
          [q.q ?? null, typeof q.scf_awarded === "boolean" ? q.scf_awarded : null],
        );
        // Linked projects: the confirmed links op_projects reports per tenant (restriction applied by the database).
        const labels = await projectLabels(tx, 0);
        const linked = new Map<string, string[]>();
        for (const l of labels.values())
          for (const r of l.registryProjectIds)
            linked.set(r, [...(linked.get(r) ?? []), l.tenantId]);
        return { rows, linked, p: await privacySettings(tx) };
      });
      const items = rows.map((r) => ({
        ...r,
        websites: r.websites ?? [],
        scf_awards: Array.isArray(r.scf_awards) ? r.scf_awards : [],
        fetched_at: r.fetched_at.toISOString(),
        linked_project_ids: (linked.get(r.registry_project_id) ?? []).sort(),
      }));
      const res = paged(ctx, items, bindOf(ctx), p);
      res.body.meta = {
        start: "1970-01-01T00:00:00Z",
        end: new Date(clock()).toISOString(),
        generated_at: new Date().toISOString(),
        min_level: "L0",
      };
      return res;
    },

    metricsGetWebDaily: async (ctx) => {
      const group = ctx.query.group === "site" ? "site" : "tenant";
      const { rows, labels, privacy: p } = await webRows(ctx, "day", group);
      const items = rows.map((r) => ({
        day: dayString(String(r.day)),
        project_id: String(r.tenant_id),
        ...slugOf(labels, String(r.tenant_id), r.slug),
        site_id: r.site_id,
        verification_level: levelName(r.verification_level),
        is_final: r.all_final ?? false,
        ...webCells(r),
      })) as Record<string, unknown>[];
      items.sort(
        sorter(
          String(ctx.query.sort ?? "-pageviews"),
          (r) => `${r.day}|${r.project_id}|${r.site_id ?? ""}`,
        ),
      );
      return paged(ctx, items, bindOf(ctx), p, { variant: ctx.query.variant ?? "verified" });
    },

    metricsGetWebAggregate: async (ctx) => {
      const { rows, counts, privacy: p } = await webRows(ctx, "day", "all");
      const data = rows
        .map((r) => ({
          day: dayString(String(r.day)),
          projects: counts?.get(dayString(String(r.day))) ?? 0,
          ...webCells(r),
        }))
        .sort((a, b) => a.day.localeCompare(b.day));
      return {
        rows: data,
        body: {
          data,
          privacy: privacy(p),
          meta: meta(ctx, { variant: ctx.query.variant ?? "verified" }),
        },
      };
    },

    metricsGetWebSummary: async (ctx) => {
      const { rows, labels, privacy: p } = await webRows(ctx, "range", "tenant");
      let items = rows.map((r) => {
        const l = labels.get(String(r.tenant_id));
        return {
          project_id: String(r.tenant_id),
          ...(l ? { slug: l.slug, scf_awarded: l.scfAwarded } : {}),
          verification_level: levelName(r.verification_level),
          all_final: r.all_final ?? false,
          ...webCells(r),
        } as Record<string, unknown>;
      });
      if (typeof ctx.query.min_pageviews === "number")
        items = items.filter((r) => num(r.pageviews) >= Number(ctx.query.min_pageviews));
      const sort = String(ctx.query.sort ?? "-pageviews");
      items.sort(
        sorter(sort === "day" || sort === "-day" ? "-pageviews" : sort, (r) =>
          String(r.project_id),
        ),
      );
      return paged(ctx, items, bindOf(ctx), p, { variant: ctx.query.variant ?? "verified" });
    },

    metricsGetWebBreakdowns: async (ctx) => {
      const q = ctx.query;
      const minLevel = levelNumber(q.min_level);
      const { rows, labels, p } = await ctx.tx(async (tx) => {
        const sel = await selection(ctx, tx, minLevel);
        const rows = await op(() =>
          tx.query<{
            tenant_id: string;
            value: string;
            visitors_sum: string | null;
            pageviews: string | null;
            events: string | null;
            slug: string | null;
          }>(
            `SELECT tenant_id::text AS tenant_id, value, visitors_sum, pageviews, events, slug
               FROM scf.op_web_breakdown($1, $2, $3::scf.web_dimension, $4::scf.web_variant, $5::uuid[],
                                         $6::smallint, $7::int, 'tenant')
              WHERE value IS NOT NULL`, // 0087: the withheld-value summary rows are not listed here (K1)
            [
              q.start,
              q.end,
              q.dimension,
              q.variant ?? "verified",
              sel.tenants,
              minLevel,
              Number(q.limit_per_project ?? 20),
            ],
          ),
        );
        return { rows, labels: sel.labels, p: await privacySettings(tx) };
      });
      const items = rows.map((r) => ({
        project_id: r.tenant_id,
        ...slugOf(labels, r.tenant_id, r.slug),
        dimension: String(q.dimension),
        value: r.value,
        visitors_sum: numOrNull(r.visitors_sum),
        pageviews: numOrNull(r.pageviews),
        events: numOrNull(r.events),
      }));
      return paged(ctx, items, bindOf(ctx), p, { variant: q.variant ?? "verified" });
    },

    metricsGetWebVerdicts: async (ctx) => {
      const q = ctx.query;
      const minLevel = levelNumber(q.min_level);
      const { rows, p } = await ctx.tx(async (tx) => {
        const sel = await selection(ctx, tx, minLevel);
        const rows = await op(() =>
          tx.query<{
            tenant_id: string;
            site_id: string;
            day: string;
            counter: string;
            label: string;
            count: string;
          }>(
            `SELECT tenant_id::text AS tenant_id, site_id::text AS site_id, day::text AS day, counter, label, count
               FROM scf.op_web_verdicts($1, $2, $3::uuid[], $4::smallint)
              ORDER BY day, tenant_id, site_id, counter, label`,
            [q.start, q.end, sel.tenants, minLevel],
          ),
        );
        return { rows, p: await privacySettings(tx) };
      });
      const items = rows.map((r) => ({
        project_id: r.tenant_id,
        site_id: r.site_id,
        day: r.day,
        counter: r.counter,
        label: r.label,
        count: Number(r.count),
      }));
      return paged(ctx, items, bindOf(ctx), p);
    },

    metricsGetApiDaily: async (ctx) => {
      const { out, privacy: p } = await apiRows(ctx, "day");
      apiSort(out, String(ctx.query.sort ?? "-requests"));
      return paged(ctx, out, bindOf(ctx), p, { label: SELF_ATTESTED });
    },

    metricsGetApiHourly: async (ctx) => {
      const { out, privacy: p } = await apiRows(ctx, "hour");
      apiSort(out, "bucket_start");
      return paged(ctx, out, bindOf(ctx), p, { label: SELF_ATTESTED });
    },

    metricsGetApiSummary: async (ctx) => {
      const { out, privacy: p } = await apiRows(ctx, "range");
      const min = ctx.query.min_requests;
      const rows = typeof min === "number" ? out.filter((r) => num(r.requests) >= min) : out;
      apiSort(rows, String(ctx.query.sort ?? "-requests"));
      return paged(ctx, rows, bindOf(ctx), p, { label: SELF_ATTESTED });
    },

    metricsGetWebTrust: async (ctx) => {
      const q = ctx.query;
      const minLevel = levelNumber(q.min_level);
      const window = Number(q.window_days ?? 28);
      const { rows, p } = await ctx.tx(async (tx) => {
        const sel = await selection(ctx, tx, minLevel);
        const rows = await op(() =>
          tx.query<{
            tenant_id: string;
            site_id: string;
            day: string;
            window_days: number;
            score: number | null;
            components: Record<string, Record<string, unknown>> | null;
            reason_codes: string[] | null;
            decision_rate: string | null;
            algorithm_version: string;
          }>(
            `SELECT tenant_id::text AS tenant_id, site_id::text AS site_id, day::text AS day, window_days, score,
                    components, reason_codes, decision_rate, algorithm_version
               FROM scf.op_trust($1, $2, $3::uuid[], $4::smallint) WHERE window_days = $5
              ORDER BY day, tenant_id, site_id`,
            [q.start, q.end, sel.tenants, minLevel, window],
          ),
        );
        return { rows, p: await privacySettings(tx) };
      });
      const items = rows.map((r) => ({
        project_id: r.tenant_id,
        site_id: r.site_id,
        day: r.day,
        window_days: Number(r.window_days),
        score: r.score === null ? null : Number(r.score),
        components: Object.fromEntries(
          Object.entries(r.components ?? {}).map(([k, v]) => [
            k,
            {
              p: Number(v.p ?? 0),
              value: numOrNull(v.value),
              eco_percentile: numOrNull(v.eco_percentile),
            },
          ]),
        ),
        reason_codes: r.reason_codes ?? [],
        decision_rate: numOrNull(r.decision_rate),
        algorithm_version: r.algorithm_version,
      }));
      return paged(ctx, items, bindOf(ctx), p);
    },

    metricsGetApiAssurance: async (ctx) => {
      const q = ctx.query;
      const minLevel = levelNumber(q.min_level);
      const services = q.service_ids as string[] | undefined;
      const { rows, p } = await ctx.tx(async (tx) => {
        const sel = await selection(ctx, tx, minLevel);
        const rows = await op(() =>
          tx.query<{
            tenant_id: string;
            service_id: string;
            day: string;
            level: number;
            onchain_badge: string;
            reason_codes: string[] | null;
          }>(
            `SELECT tenant_id::text AS tenant_id, service_id::text AS service_id, day::text AS day, level,
                    onchain_badge, reason_codes
               FROM scf.op_api_assurance($1, $2, $3::uuid[], $4::smallint)
              WHERE $5::uuid[] IS NULL OR service_id = ANY ($5::uuid[])
              ORDER BY day, tenant_id, service_id`,
            [q.start, q.end, sel.tenants, minLevel, services ?? null],
          ),
        );
        return { rows, p: await privacySettings(tx) };
      });
      const items = rows.map((r) => ({
        project_id: r.tenant_id,
        service_id: r.service_id,
        day: r.day,
        level: `A${Number(r.level)}`,
        onchain_badge: r.onchain_badge,
        reason_codes: r.reason_codes ?? [],
      }));
      return paged(ctx, items, bindOf(ctx), p);
    },

    // C-136 (plan C3): cohorts by SCF round, category or award stage — one page; small cohorts suppressed and figures
    // below op_min_count withheld by scf.op_cohorts itself (C-137).
    metricsGetCohorts: async (ctx) => {
      const { rows, minTenants, p } = await ctx.tx(async (tx) => ({
        ...(await readCohorts(tx, ctx.query)),
        p: await privacySettings(tx),
      }));
      const data = rows.map((r) => ({
        cohort: r.cohort,
        project_count: r.tenant_count,
        projects_with_onchain: r.tenants_with_onchain,
        ...cohortFigures(r),
      }));
      return {
        rows: data,
        nextCursor: null,
        body: {
          by: ctx.query.by,
          min_projects: minTenants,
          data,
          next_cursor: null,
          privacy: privacy(p),
          meta: meta(ctx),
        },
      };
    },

    metricsGetOnchainDaily: async (ctx) => {
      const q = ctx.query;
      const minLevel = levelNumber(q.min_level);
      const { rows, p } = await ctx.tx(async (tx) => {
        const sel = await selection(ctx, tx, minLevel);
        const rows = await op(() =>
          tx.query<{
            tenant_id: string;
            contract_id: string;
            network: string;
            contract_status: string;
            day: string;
            invocations: string;
            successful_invocations: string | null;
            distinct_invokers: string | null;
          }>(
            `SELECT tenant_id::text AS tenant_id, contract_id, network, contract_status, day::text AS day, invocations,
                    successful_invocations, distinct_invokers
               FROM scf.op_onchain($1, $2, $3::uuid[], $4::smallint) ORDER BY day, tenant_id, contract_id`,
            [q.start, q.end, sel.tenants, minLevel],
          ),
        );
        return { rows, p: await privacySettings(tx) };
      });
      const items = rows.map((r) => ({
        project_id: r.tenant_id,
        contract_id: r.contract_id,
        network: r.network,
        contract_status: r.contract_status,
        day: r.day,
        invocations: Number(r.invocations),
        successful_invocations: numOrNull(r.successful_invocations),
        distinct_invokers: numOrNull(r.distinct_invokers),
      }));
      return paged(ctx, items, bindOf(ctx), p);
    },
  };
  return handlers;
}
