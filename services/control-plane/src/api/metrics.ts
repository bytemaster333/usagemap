// SPDX-License-Identifier: Apache-2.0
// Tenant API analytics (ADR-0010, ADR-0011; data-model §8.11, §9; C-22, C-23, C-86, C-103): volume, status classes and
// codes, p50/p95/p99 with the accuracy class, per-route table, time series, data-quality counters and assurance.
//
// Every read runs under the tenant's context (scf_app, RLS) and only over the preferred-group views
// `api_metrics_{1m,1h,1d}_pref` (one stream group per service and UTC day, C-22). Histograms are merged first and
// converted to percentiles once per group (C-103): exp3 rows are summed as exp3 while every row of the group is exp3;
// otherwise the summed exp3 part is converted to explicit15 once and added to the summed explicit15 part — the same
// rule as `op_api_metrics` (data-model §11), so tenant and SCF-operator figures agree.

import type { Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { toCsv } from "../operator/common.ts";
import { DAY, HOUR, iso, resolveRange, type Span, utcMidnight } from "../web/range.ts";
import { badField, loadService, visibleTenant } from "./services.ts";
import {
  SURFACE_LABEL,
  SURFACE_MAPPING_VERSION,
  type Surface,
  surfaceOf,
} from "./stellar-surfaces.ts";

export type Resolution = "1m" | "1h" | "1d";
const MINUTE = 60_000;
const STEP: Record<Resolution, number> = { "1m": MINUTE, "1h": HOUR, "1d": DAY };
const VIEW: Record<Resolution, string> = {
  "1m": "scf.api_metrics_1m_pref",
  "1h": "scf.api_metrics_1h_pref",
  "1d": "scf.api_metrics_1d_pref",
};
/** Retention of the finer tables (data-model §8.11): 1m 35 days, 1h 25 months. */
const RETENTION_DAYS: Partial<Record<Resolution, number>> = { "1m": 35, "1h": 25 * 31 };
/** Upper bound on series points per response. */
export const MAX_POINTS = 10_000;
export const LABEL = "self-attested telemetry";

/** `auto`: ≤ 6 h → 1m, ≤ 31 d → 1h, else 1d (parameter `resolution`). */
export function autoResolution(span: Span): Resolution {
  const d = span.end - span.start;
  if (d <= 6 * HOUR) return "1m";
  if (d <= 31 * DAY) return "1h";
  return "1d";
}

/** Aligns a span outward to the resolution's grid (buckets are whole minutes, hours or UTC days). */
export function alignSpan(span: Span, res: Resolution): Span {
  const s = STEP[res];
  return { start: Math.floor(span.start / s) * s, end: Math.ceil(span.end / s) * s };
}

/** Resolves range + resolution, enforcing retention of the finer tables and the point cap. */
export function planApiRange(
  q: Record<string, unknown>,
  now: number,
  createdAt: number,
  requested: Resolution | "auto" = "auto",
): { span: Span; res: Resolution } {
  const raw = resolveRange(q, now, createdAt);
  const res = requested === "auto" ? autoResolution(raw) : requested;
  const span = alignSpan(raw, res);
  const keep = RETENTION_DAYS[res];
  if (keep !== undefined && span.start < utcMidnight(now) - keep * DAY)
    throw badField(
      "/resolution",
      `${res} data is kept for ${keep} days; choose a coarser resolution`,
    );
  if ((span.end - span.start) / STEP[res] > MAX_POINTS)
    throw badField("/resolution", `at most ${MAX_POINTS} points; choose a coarser resolution`);
  return { span, res };
}

// ------------------------------------------------------------------------------------------------ SQL

/** Per-group aggregate over the preferred rows: counts, merged histogram, quantiles (seconds), accuracy class. */
export function aggregateSql(groupCols: string, where: string): string {
  const g = groupCols ? `${groupCols},` : "";
  return `
    WITH a AS (
      SELECT ${g}
             sum(m.request_count)::bigint AS n,
             COALESCE(sum(m.request_count) FILTER (WHERE m.status_code BETWEEN 200 AND 299), 0)::bigint AS n2,
             COALESCE(sum(m.request_count) FILTER (WHERE m.status_code BETWEEN 300 AND 399), 0)::bigint AS n3,
             COALESCE(sum(m.request_count) FILTER (WHERE m.status_code BETWEEN 400 AND 499), 0)::bigint AS n4,
             COALESCE(sum(m.request_count) FILTER (WHERE m.status_code BETWEEN 500 AND 599), 0)::bigint AS n5,
             COALESCE(sum(m.request_count) FILTER (WHERE m.status_code = 0), 0)::bigint AS n0,
             sum(m.duration_sum) AS dsum,
             bool_and(m.hist_kind = 'exp3') AS all_exp3, bool_and(m.hist_kind = 'explicit15') AS all_exp15,
             max(m.hist_quality)::smallint AS q,
             CASE WHEN bool_and(m.hist_kind = 'exp3') THEN scf.hist_sum(m.hist)
                  ELSE scf.hist_add8(scf.hist_sum(m.hist) FILTER (WHERE m.hist_kind = 'explicit15'),
                                     scf.hist_exp3_to_explicit15(scf.hist_sum(m.hist) FILTER (WHERE m.hist_kind = 'exp3')))
             END AS h,
             CASE WHEN bool_and(m.duration_min IS NOT NULL) THEN min(m.duration_min) END AS vmin,
             CASE WHEN bool_and(m.duration_max IS NOT NULL) THEN max(m.duration_max) END AS vmax
        FROM m ${where}
       ${groupCols ? `GROUP BY ${groupCols}` : ""})
    SELECT a.*,
           CASE WHEN a.n > 0 THEN a.dsum / a.n END AS mean_s,
           CASE WHEN a.n > 0 THEN scf.hist_quantile(CASE WHEN a.all_exp3 THEN 'exp3'::scf.hist_kind
                                                         ELSE 'explicit15' END, a.h, 0.50, a.vmin, a.vmax) END AS p50_s,
           CASE WHEN a.n > 0 THEN scf.hist_quantile(CASE WHEN a.all_exp3 THEN 'exp3'::scf.hist_kind
                                                         ELSE 'explicit15' END, a.h, 0.95, a.vmin, a.vmax) END AS p95_s,
           CASE WHEN a.n > 0 THEN scf.hist_quantile(CASE WHEN a.all_exp3 THEN 'exp3'::scf.hist_kind
                                                         ELSE 'explicit15' END, a.h, 0.99, a.vmin, a.vmax) END AS p99_s,
           CASE WHEN a.n > 0 THEN scf.accuracy_class(a.all_exp3, a.all_exp15, a.q) END AS accuracy_class
      FROM a WHERE a.n IS NOT NULL`;
}

export interface AggRow extends Record<string, unknown> {
  n: string;
  n2: string;
  n3: string;
  n4: string;
  n5: string;
  n0: string;
  mean_s: number | null;
  p50_s: number | null;
  p95_s: number | null;
  p99_s: number | null;
  accuracy_class: string | null;
}

/** `WITH m AS (…)`: the preferred rows of one service in the span, optionally one route. */
function sourceCte(res: Resolution, route: boolean): string {
  return `WITH m AS (
      SELECT * FROM ${VIEW[res]} v
       WHERE v.tenant_id = $1 AND v.service_id = $2 AND v.bucket_start >= $3 AND v.bucket_start < $4
       ${route ? `AND v.route_id IN (SELECT r.route_id FROM scf.api_routes r WHERE r.tenant_id = $1 AND r.service_id = $2 AND r.route = $5)` : ""})`;
}

/** The two CTE layers (m, then a) cannot both start with WITH: splice. */
function query(res: Resolution, route: boolean, groupCols: string, where = ""): string {
  const src = sourceCte(res, route);
  const agg = aggregateSql(groupCols, where).replace(/^\s*WITH a AS/, ", a AS");
  return `${src}${agg}`;
}

const ms = (s: number | null | undefined): number | null =>
  s === null || s === undefined ? null : Math.round(s * 1e6) / 1e3;

export function percentiles(r: AggRow | undefined): Record<string, unknown> {
  return {
    p50_ms: ms(r?.p50_s),
    p95_ms: ms(r?.p95_s),
    p99_ms: ms(r?.p99_s),
    mean_ms: ms(r?.mean_s),
    accuracy_class: r?.accuracy_class ?? null,
  };
}

function classes(r: AggRow | undefined) {
  return {
    s2xx: Number(r?.n2 ?? 0),
    s3xx: Number(r?.n3 ?? 0),
    s4xx: Number(r?.n4 ?? 0),
    s5xx: Number(r?.n5 ?? 0),
    unknown: Number(r?.n0 ?? 0),
  };
}

const rate = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null;

// ------------------------------------------------------------------------------------------------ range echo

/** Stream groups that delivered the shown rows (C-22): kind per UTC day of the preferred group, and a warning. */
async function streamGroupEcho(tx: Tx, tenantId: string, serviceId: string, span: Span) {
  const rows = await tx.query<{ day: string; kind: string; groups: number }>(
    `SELECT DISTINCT ON (d.day) d.day::text AS day, g.kind::text AS kind,
            count(*) OVER (PARTITION BY d.day)::int AS groups
       FROM scf.api_service_day_groups d
       JOIN scf.api_stream_groups g ON g.tenant_id = d.tenant_id AND g.group_id = d.stream_group_id
      WHERE d.tenant_id = $1 AND d.service_id = $2
        AND d.day >= ($3::timestamptz AT TIME ZONE 'UTC')::date AND d.day < ($4::timestamptz AT TIME ZONE 'UTC')::date + 1
      ORDER BY d.day, g.rank_key, g.group_id`,
    [tenantId, serviceId, new Date(span.start), new Date(span.end - 1)],
  );
  if (rows.length === 0) return { echo: {}, spanDerived: false };
  const kinds = new Set(rows.map((r) => r.kind));
  const multiple = rows.some((r) => r.groups > 1);
  const kind = kinds.size === 1 ? (rows[0]?.kind as string) : "mixed";
  return {
    echo: {
      stream_group: {
        kind,
        warning: multiple
          ? "More than one instrumentation reports this service; one preferred stream group per UTC day is shown (C-22)."
          : kinds.size > 1
            ? "The preferred stream group changed within the range (C-22)."
            : null,
      },
    },
    spanDerived: kinds.has("span_derived"),
  };
}

async function rangeEcho(
  tx: Tx,
  tenantId: string,
  serviceId: string,
  span: Span,
  res: Resolution,
): Promise<Record<string, unknown>> {
  const g = await streamGroupEcho(tx, tenantId, serviceId, span);
  return {
    start: iso(span.start),
    end: iso(span.end),
    resolution: res,
    label: LABEL,
    ...g.echo,
    // Span-derived counts carry no sampling weight in storage: shown as a lower bound (wire-formats §g.5).
    sampled_lower_bound: g.spanDerived,
  };
}

// ------------------------------------------------------------------------------------------------ handlers

interface Loaded {
  tenantId: string;
  serviceId: string;
  createdAt: number;
}

async function load(ctx: RequestContext, tx: Tx): Promise<Loaded> {
  const tenantId = visibleTenant(ctx);
  const serviceId = ctx.params.serviceId as string;
  const s = await loadService(tx, tenantId, serviceId);
  return { tenantId, serviceId, createdAt: s.registered_at.getTime() };
}

/** Cursor of the routes table: offset bound to the sort and range it was issued for. */
function encodeCursor(o: number, sort: string, span: Span): string {
  return Buffer.from(JSON.stringify({ o, s: sort, a: span.start, b: span.end })).toString(
    "base64url",
  );
}
function decodeCursor(c: string, sort: string, span: Span): number {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString()) as Record<string, unknown>;
    if (
      typeof v.o === "number" &&
      Number.isInteger(v.o) &&
      v.o >= 0 &&
      v.s === sort &&
      v.a === span.start &&
      v.b === span.end
    )
      return v.o;
  } catch {
    // fall through
  }
  throw badField("/cursor", "invalid cursor for this sort and range");
}

/** Every route of the service with its Stellar surface (stellar-surfaces.ts) and its JSON-RPC method. */
async function routeSurfaces(tx: Tx, tenantId: string, serviceId: string) {
  const routes = await tx.query<{
    route_id: string;
    route: string;
    rpc_method: string | null;
    rules_version: string;
  }>(
    `SELECT route_id::text AS route_id, route, rpc_method, rules_version
       FROM scf.api_routes WHERE tenant_id = $1 AND service_id = $2`,
    [tenantId, serviceId],
  );
  return routes.map((r) => ({ ...r, ...surfaceOf(r.route, r.rpc_method) }));
}

/** Aggregates the preferred rows of a service grouped by a key given per route (`$5` route ids, `$6` keys). */
function keyedQuery(res: Resolution): string {
  const agg = aggregateSql("m.k", "").replace(/^\s*WITH a AS/, ", a AS");
  return `WITH map AS (SELECT * FROM unnest($5::bigint[], $6::text[]) AS x(route_id, k)),
    m AS (
      SELECT v.*, map.k FROM ${VIEW[res]} v JOIN map ON map.route_id = v.route_id
       WHERE v.tenant_id = $1 AND v.service_id = $2 AND v.bucket_start >= $3 AND v.bucket_start < $4)${agg}`;
}

/** CSV columns of the per-route download (exportApiRoutes). */
export const ROUTE_CSV_COLUMNS = [
  "route",
  "rpc_method",
  "surface",
  "surface_group",
  "rules_version",
  "requests",
  "requests_5xx",
  "error_rate_5xx",
  "p50_ms",
  "p95_ms",
  "p99_ms",
  "accuracy_class",
] as const;

export function metricsHandlers(deps: { now?: () => number }): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  const getApiSummary: Handler = async (ctx) => {
    const now = clock();
    const route = ctx.query.route as string | undefined;
    const body = await ctx.tx(async (tx) => {
      const s = await load(ctx, tx);
      const { span, res } = planApiRange(ctx.query, now, s.createdAt);
      const params: unknown[] = [s.tenantId, s.serviceId, new Date(span.start), new Date(span.end)];
      if (route !== undefined) params.push(route);
      const r = (await tx.query<AggRow>(query(res, route !== undefined, ""), params))[0];
      const a = await tx.maybeOne<{ level: number; onchain_badge: string }>(
        `SELECT level, onchain_badge FROM scf.api_service_assurance
          WHERE tenant_id = $1 AND service_id = $2 AND day < ($3::timestamptz AT TIME ZONE 'UTC')::date + 1
          ORDER BY day DESC LIMIT 1`,
        [s.tenantId, s.serviceId, new Date(span.end - 1)],
      );
      const n = Number(r?.n ?? 0);
      return {
        range: await rangeEcho(tx, s.tenantId, s.serviceId, span, res),
        requests: n,
        error_rate_5xx: rate(Number(r?.n5 ?? 0), n),
        error_rate_4xx: rate(Number(r?.n4 ?? 0), n),
        status: classes(r),
        latency: percentiles(r),
        assurance_level: a ? `A${a.level}` : null,
        onchain_badge: a?.onchain_badge ?? null,
      };
    });
    return { status: 200, body };
  };

  const getApiTimeseries: Handler = async (ctx) => {
    const now = clock();
    const route = ctx.query.route as string | undefined;
    const body = await ctx.tx(async (tx) => {
      const s = await load(ctx, tx);
      const { span, res } = planApiRange(
        ctx.query,
        now,
        s.createdAt,
        (ctx.query.resolution as Resolution | "auto" | undefined) ?? "auto",
      );
      const params: unknown[] = [s.tenantId, s.serviceId, new Date(span.start), new Date(span.end)];
      if (route !== undefined) params.push(route);
      const rows = await tx.query<AggRow & { bucket_start: Date }>(
        query(res, route !== undefined, "m.bucket_start"),
        params,
      );
      const total = (await tx.query<AggRow>(query(res, route !== undefined, ""), params))[0];
      const by = new Map(rows.map((r) => [r.bucket_start.getTime(), r]));
      const points: Record<string, unknown>[] = [];
      for (let t = span.start; t < span.end; t += STEP[res]) {
        const r = by.get(t);
        points.push({
          t: iso(t),
          requests: Number(r?.n ?? 0),
          s4xx: Number(r?.n4 ?? 0),
          s5xx: Number(r?.n5 ?? 0),
          p50_ms: ms(r?.p50_s),
          p95_ms: ms(r?.p95_s),
          p99_ms: ms(r?.p99_s),
        });
      }
      return {
        range: await rangeEcho(tx, s.tenantId, s.serviceId, span, res),
        points,
        accuracy_class: total?.accuracy_class ?? null,
      };
    });
    return { status: 200, body };
  };

  const getApiStatusCodes: Handler = async (ctx) => {
    const now = clock();
    const route = ctx.query.route as string | undefined;
    const body = await ctx.tx(async (tx) => {
      const s = await load(ctx, tx);
      const { span, res } = planApiRange(ctx.query, now, s.createdAt);
      const params: unknown[] = [s.tenantId, s.serviceId, new Date(span.start), new Date(span.end)];
      if (route !== undefined) params.push(route);
      const src = sourceCte(res, route !== undefined);
      const codes = await tx.query<{ status_code: number; n: string }>(
        `${src} SELECT m.status_code::int AS status_code, sum(m.request_count)::bigint AS n
                  FROM m GROUP BY m.status_code ORDER BY m.status_code`,
        params,
      );
      const total = (await tx.query<AggRow>(query(res, route !== undefined, ""), params))[0];
      return {
        range: await rangeEcho(tx, s.tenantId, s.serviceId, span, res),
        classes: classes(total),
        codes: codes.map((c) => ({ status_code: c.status_code, requests: Number(c.n) })),
      };
    });
    return { status: 200, body };
  };

  const listApiRoutes: Handler = async (ctx) => {
    const now = clock();
    const sort = (ctx.query.sort as string | undefined) ?? "-requests";
    const limit = Number(ctx.query.limit ?? 50);
    const body = await ctx.tx(async (tx) => {
      const s = await load(ctx, tx);
      const { span, res } = planApiRange(ctx.query, now, s.createdAt);
      const offset =
        typeof ctx.query.cursor === "string" ? decodeCursor(ctx.query.cursor, sort, span) : 0;
      const rows = await tx.query<
        AggRow & {
          route_id: string;
          route: string;
          rpc_method: string | null;
          rules_version: string;
        }
      >(
        `${query(res, false, "m.route_id")}`.replace(
          /\s*FROM a WHERE a\.n IS NOT NULL$/,
          ` , r.route, r.rpc_method, r.rules_version
            FROM a JOIN scf.api_routes r ON r.tenant_id = $1 AND r.route_id = a.route_id
           WHERE a.n IS NOT NULL`,
        ),
        [s.tenantId, s.serviceId, new Date(span.start), new Date(span.end)],
      );
      const items = rows.map((r) => {
        const n = Number(r.n);
        return {
          route: r.route,
          rpc_method: r.rpc_method,
          rules_version: r.rules_version,
          requests: n,
          error_rate_5xx: rate(Number(r.n5), n),
          latency: percentiles(r),
        };
      });
      const desc = sort.startsWith("-");
      const key = sort.replace(/^-/, "");
      const val = (x: (typeof items)[number]): number | string | null =>
        key === "requests"
          ? x.requests
          : key === "error_rate_5xx"
            ? x.error_rate_5xx
            : key === "p95_ms"
              ? (x.latency.p95_ms as number | null)
              : x.route;
      items.sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        if (va === null && vb !== null) return 1; // nulls last in both directions
        if (vb === null && va !== null) return -1;
        let c = 0;
        if (va !== null && vb !== null) c = va < vb ? -1 : va > vb ? 1 : 0;
        if (desc) c = -c;
        if (c !== 0) return c;
        return a.route < b.route
          ? -1
          : a.route > b.route
            ? 1
            : (a.rpc_method ?? "").localeCompare(b.rpc_method ?? "") ||
              a.rules_version.localeCompare(b.rules_version);
      });
      const page = items.slice(offset, offset + limit);
      return {
        range: await rangeEcho(tx, s.tenantId, s.serviceId, span, res),
        items: page,
        next_cursor:
          offset + limit < items.length ? encodeCursor(offset + limit, sort, span) : null,
      };
    });
    return { status: 200, body };
  };

  const getApiSurfaces: Handler = async (ctx) => {
    const now = clock();
    const body = await ctx.tx(async (tx) => {
      const s = await load(ctx, tx);
      const { span, res } = planApiRange(ctx.query, now, s.createdAt);
      const routes = await routeSurfaces(tx, s.tenantId, s.serviceId);
      const base = [s.tenantId, s.serviceId, new Date(span.start), new Date(span.end)];
      const ids = routes.map((r) => r.route_id);
      const run = (keys: string[]) =>
        tx.query<AggRow & { k: string }>(keyedQuery(res), [...base, ids, keys]);
      const bySurface = await run(routes.map((r) => r.surface));
      // PostgreSQL text cannot hold NUL: the group key is a JSON pair
      const byGroup = await run(routes.map((r) => JSON.stringify([r.surface, r.group])));
      const view = (r: AggRow) => {
        const n = Number(r.n);
        return {
          requests: n,
          error_rate_5xx: rate(Number(r.n5), n),
          latency: percentiles(r),
        };
      };
      const surfaces = bySurface
        .map((r) => ({
          surface: r.k,
          label: SURFACE_LABEL[r.k as Surface],
          ...view(r),
          groups: byGroup
            .map((g) => ({ key: JSON.parse(g.k) as [string, string], g }))
            .filter((x) => x.key[0] === r.k)
            .map((x) => ({ group: x.key[1], ...view(x.g) }))
            .sort((a, b) => b.requests - a.requests || (a.group < b.group ? -1 : 1)),
        }))
        .sort((a, b) => b.requests - a.requests || (a.surface < b.surface ? -1 : 1));
      return {
        range: await rangeEcho(tx, s.tenantId, s.serviceId, span, res),
        mapping_version: SURFACE_MAPPING_VERSION,
        surfaces,
      };
    });
    return { status: 200, body };
  };

  const exportApiRoutes: Handler = async (ctx) => {
    const now = clock();
    const out = await ctx.tx(async (tx) => {
      const s = await load(ctx, tx);
      const { span, res } = planApiRange(ctx.query, now, s.createdAt);
      const routes = await routeSurfaces(tx, s.tenantId, s.serviceId);
      const meta = new Map(routes.map((r) => [r.route_id, r]));
      const rows = await tx.query<AggRow & { k: string }>(keyedQuery(res), [
        s.tenantId,
        s.serviceId,
        new Date(span.start),
        new Date(span.end),
        routes.map((r) => r.route_id),
        routes.map((r) => r.route_id),
      ]);
      const items = rows
        .map((r) => {
          const m = meta.get(r.k) as (typeof routes)[number];
          const n = Number(r.n);
          const p = percentiles(r);
          return {
            route: m.route,
            rpc_method: m.rpc_method ?? "",
            surface: m.surface,
            surface_group: m.group,
            rules_version: m.rules_version,
            requests: n,
            requests_5xx: Number(r.n5),
            error_rate_5xx: rate(Number(r.n5), n) ?? "",
            p50_ms: p.p50_ms ?? "",
            p95_ms: p.p95_ms ?? "",
            p99_ms: p.p99_ms ?? "",
            accuracy_class: p.accuracy_class ?? "",
          };
        })
        .sort(
          (a, b) => b.requests - a.requests || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0),
        );
      return { csv: toCsv(items, [...ROUTE_CSV_COLUMNS]), start: span.start };
    });
    return {
      status: 200,
      body: out.csv,
      contentType: "text/csv; charset=utf-8",
      headers: {
        "x-scf-label": LABEL,
        "content-disposition": `attachment; filename="api-routes-${new Date(out.start).toISOString().slice(0, 10)}.csv"`,
      },
    };
  };

  const getServiceDataQuality: Handler = async (ctx) => {
    const now = clock();
    const body = await ctx.tx(async (tx) => {
      const s = await load(ctx, tx);
      const preset = (ctx.query.range as string | undefined) ?? "7d";
      // Counters are daily: the echoed range is the UTC days that cover the preset.
      const end = utcMidnight(now) + DAY;
      const start =
        preset === "24h" ? utcMidnight(now - DAY) : end - (preset === "30d" ? 30 : 7) * DAY;
      const rows = await tx.query<{ attributed: boolean; reason: string; n: string }>(
        `SELECT service_id = $2 AS attributed, reason, sum(count)::bigint AS n
           FROM scf.api_ingest_counters
          WHERE tenant_id = $1 AND service_id IN ($2, '00000000-0000-0000-0000-000000000000')
            AND day >= ($3::timestamptz AT TIME ZONE 'UTC')::date AND day < ($4::timestamptz AT TIME ZONE 'UTC')::date
          GROUP BY 1, 2 ORDER BY 1, 3 DESC, 2`,
        [s.tenantId, s.serviceId, new Date(start), new Date(end)],
      );
      const pick = (a: boolean) =>
        rows
          .filter((r) => r.attributed === a)
          .map((r) => ({ reason: r.reason, count: Number(r.n) }));
      return { start: iso(start), end: iso(end), reasons: pick(true), unattributed: pick(false) };
    });
    return { status: 200, body };
  };

  const getApiAssurance: Handler = async (ctx) => {
    const start = Date.parse(ctx.query.start as string);
    const end = Date.parse(ctx.query.end as string);
    const body = await ctx.tx(async (tx) => {
      // The service is resolved first: a foreign or unknown id is the same 404 whatever the range (C-87).
      const s = await load(ctx, tx);
      if (end <= start) throw badField("/end", "end must be after start");
      if (end - start > 3660 * DAY) throw badField("/end", "range must not exceed 3 660 days");
      const rows = await tx.query<{
        day: string;
        level: number;
        onchain_badge: string;
        reason_codes: string[];
      }>(
        `SELECT day::text AS day, level, onchain_badge, reason_codes FROM scf.api_service_assurance
          WHERE tenant_id = $1 AND service_id = $2
            AND day >= ($3::timestamptz AT TIME ZONE 'UTC')::date AND day < ($4::timestamptz AT TIME ZONE 'UTC')::date
          ORDER BY day`,
        [s.tenantId, s.serviceId, new Date(start), new Date(end)],
      );
      return rows.map((r) => ({
        day: r.day,
        level: `A${r.level}`,
        onchain_badge: r.onchain_badge,
        reason_codes: r.reason_codes,
      }));
    });
    return { status: 200, body };
  };

  return {
    getApiSummary,
    getApiTimeseries,
    getApiStatusCodes,
    listApiRoutes,
    getServiceDataQuality,
    getApiSurfaces,
    exportApiRoutes,
    getApiAssurance,
  };
}
