// SPDX-License-Identifier: Apache-2.0
// Seeds for the SCF-operator tests: tenants made eligible for the op_* functions (active, verification level ≥ 1 by
// a valid domain evidence), web rollup rows, API metric rows with their stream groups and routes, and operator API
// keys created through the console (`createOperatorKey`, also used by the isolation matrix).

import { randomUUID } from "node:crypto";
import { operatorMetricsOpenApi } from "@usagemap/api-types";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { OpenApi } from "../../src/http/openapi.ts";
import {
  call,
  createTenant,
  type Harness,
  newGithubUser,
  signInGithub,
  uniqueSlug,
} from "./harness.ts";

export interface SeededProject {
  tenantId: string;
  slug: string;
  cookie: string;
  siteId: string;
}

/** A tenant with one site, `active`, at verification level `level` (0 or 1), optionally SCF-awarded. */
export async function seedProject(
  h: Harness,
  opts: { level?: 0 | 1; awarded?: boolean; status?: "active" | "suspended" | "pending" } = {},
): Promise<SeededProject> {
  const cookie = await signInGithub(h, newGithubUser());
  const slug = uniqueSlug("op");
  const tenantId = await createTenant(h, cookie, slug);
  const site = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenantId}/sites`,
    cookie,
    body: { name: `Site of ${slug}` },
  });
  expect(site.statusCode, site.body).toBe(201);
  await h.su.query(`UPDATE scf.tenants SET status = $2::scf.tenant_status WHERE tenant_id = $1`, [
    tenantId,
    opts.status ?? "active",
  ]);
  if ((opts.level ?? 1) >= 1) {
    await h.su.query(
      `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, status, verified_at)
       VALUES ($1, 'domain', $2, '{}'::jsonb, 'valid', now())`,
      [tenantId, `${slug}.example`],
    );
  }
  if (opts.awarded !== undefined) {
    const rp = randomUUID();
    await h.su.query(
      `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, fetched_at,
         content_sha256, raw)
       VALUES ($1, 'operator', $2, $3, $4, now(), sha256(convert_to($2, 'UTF8')), '{}'::jsonb)`,
      [rp, `src-${slug}`, `Registry ${slug}`, opts.awarded],
    );
    await h.su.query(
      `INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status)
       VALUES ($1, $2, '{operator}', 'confirmed')`,
      [tenantId, rp],
    );
  }
  return { tenantId, slug, cookie, siteId: site.json().site_id as string };
}

export interface WebDay {
  pvVerified: number;
  pvRaw: number;
  visitorsVerified?: number;
  visitorsRaw?: number;
  visits?: number;
  bounces?: number;
  durationS?: number;
  final?: boolean;
}

export async function seedWebDay(
  h: Harness,
  p: SeededProject,
  day: string,
  v: WebDay,
): Promise<void> {
  await h.su.query(
    `INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw,
       pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces,
       total_duration_s, events_raw, is_final, engine_version)
     VALUES ($1, $2, $3::date, $4, $5, 0, 0, $6, $7, $8, $9, $10, $5, $11, 'umami/3.5.0')`,
    [
      p.tenantId,
      p.siteId,
      day,
      v.pvVerified,
      v.pvRaw,
      v.visitorsVerified ?? Math.floor(v.pvVerified / 2),
      v.visitorsRaw ?? Math.floor(v.pvRaw / 2),
      v.visits ?? Math.floor(v.pvRaw / 2),
      v.bounces ?? 0,
      v.durationS ?? 0,
      v.final ?? true,
    ],
  );
}

export async function seedBreakdown(
  h: Harness,
  p: SeededProject,
  day: string,
  dimension: string,
  value: string,
  visitors: number,
  pageviews: number,
  variant: "verified" | "raw" = "verified",
): Promise<void> {
  await h.su.query(
    `INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors,
       pageviews, visits, events)
     VALUES ($1, $2, $3::date, $4::scf.web_variant, $5::scf.web_dimension, $6,
             (SELECT COALESCE(max(rank), 0) + 1 FROM scf.web_daily_breakdowns
               WHERE tenant_id = $1 AND site_id = $2 AND day = $3::date AND variant = $4::scf.web_variant
                 AND dimension = $5::scf.web_dimension), $7, $8,
             CASE WHEN $4::scf.web_variant = 'raw' THEN $7::bigint END,
             CASE WHEN $5::scf.web_dimension = 'event' THEN $8::bigint END)`,
    [p.tenantId, p.siteId, day, variant, dimension, value, visitors, pageviews],
  );
}

export async function seedVerdict(
  h: Harness,
  p: SeededProject,
  day: string,
  counter: "verdict" | "reason",
  label: string,
  count: number,
): Promise<void> {
  await h.su.query(
    `INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count)
     VALUES ($1, $2, $3::date, $4, $5, $6)`,
    [p.tenantId, p.siteId, day, counter, label, count],
  );
}

export interface SeededService {
  serviceId: string;
  groupId: string;
  name: string;
}

export async function seedService(
  h: Harness,
  p: SeededProject,
  name = `svc-${randomUUID().slice(0, 6)}`,
): Promise<SeededService> {
  const s = await h.su.query<{ service_id: string }>(
    `INSERT INTO scf.api_services (tenant_id, service_name, registration) VALUES ($1, $2, 'auto')
     RETURNING service_id::text AS service_id`,
    [p.tenantId, name],
  );
  const serviceId = s.rows[0]?.service_id as string;
  const g = await h.su.query<{ group_id: string }>(
    `INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key)
     VALUES ($1, $2, 'sdk_stable', 'http.server.request.duration', '@opentelemetry/instrumentation-http',
             '1|050|@opentelemetry/instrumentation-http')
     RETURNING group_id::text AS group_id`,
    [p.tenantId, serviceId],
  );
  return { serviceId, groupId: g.rows[0]?.group_id as string, name };
}

/** Explicit15 histogram with `count` values in bucket `idx` (1-based). */
export function hist15(count: number, idx: number): number[] {
  return Array.from({ length: 15 }, (_v, i) => (i + 1 === idx ? count : 0));
}

/**
 * One hour of API metrics (1h row plus the matching 1d row) for a route and status; marks the service's stream group
 * as reporting that day so the preferred-group views include it.
 */
export async function seedApiHour(
  h: Harness,
  p: SeededProject,
  svc: SeededService,
  hourIso: string,
  route: string,
  status: number,
  count: number,
  bucketIdx: number,
  durationEach: number,
): Promise<void> {
  const r = await h.su.query<{ route_id: string }>(
    `INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rules_version)
     VALUES ($1, $2, $3, '/', 'scf-path-rules/1.0.0')
     ON CONFLICT (tenant_id, service_id, route, rpc_method, rules_version) DO UPDATE SET last_seen_at = now()
     RETURNING route_id::text AS route_id`,
    [p.tenantId, svc.serviceId, route],
  );
  const routeId = r.rows[0]?.route_id as string;
  const day = hourIso.slice(0, 10);
  await h.su.query(
    `INSERT INTO scf.api_service_day_groups (tenant_id, service_id, day, stream_group_id)
     VALUES ($1, $2, $3::date, $4) ON CONFLICT DO NOTHING`,
    [p.tenantId, svc.serviceId, day, svc.groupId],
  );
  for (const [table, bucket] of [
    ["api_metrics_1h", hourIso],
    ["api_metrics_1d", `${day}T00:00:00Z`],
  ] as const) {
    await h.su.query(
      `INSERT INTO scf.${table} (tenant_id, service_id, route_id, method, status_code, source, stream_group_id,
         bucket_start, request_count, duration_sum, duration_min, duration_max, hist_kind, hist)
       VALUES ($1, $2, $3, 1, $4, 'sdk_metric', $5, $6::timestamptz, $7, $8, NULL, NULL, 'explicit15', $9::int4[])
       ON CONFLICT (tenant_id, service_id, bucket_start, route_id, method, status_code, source, stream_group_id)
       DO UPDATE SET request_count = ${table}.request_count + EXCLUDED.request_count,
                     duration_sum = ${table}.duration_sum + EXCLUDED.duration_sum,
                     hist = (SELECT array_agg(a + b ORDER BY i) FROM unnest(${table}.hist, EXCLUDED.hist)
                               WITH ORDINALITY AS u(a, b, i))`,
      [
        p.tenantId,
        svc.serviceId,
        routeId,
        status,
        svc.groupId,
        bucket,
        count,
        count * durationEach,
        hist15(count, bucketIdx),
      ],
    );
  }
}

/** Creates an SCF-operator API key through the console as `adminCookie` (an operator_admin with a fresh step-up). */
export async function createOperatorKey(
  h: Harness,
  adminCookie: string,
  opts: {
    scopes: Array<"web:read" | "api:read" | "registry:read">;
    tenant_restriction?: string[] | null;
    rate_limit_per_min?: number;
    expires_in_days?: number;
    label?: string;
  },
): Promise<{ key: string; keyId: string }> {
  const res = await call(h, {
    method: "POST",
    url: "/v1/operator/api-keys",
    cookie: adminCookie,
    body: { label: opts.label ?? "test key", ...opts },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { key: res.json().key as string, keyId: res.json().key_id as string };
}

/** Calls the operator metrics API with a bearer key; validates the response against operator-metrics.openapi.yaml. */
let metricsDoc: OpenApi | undefined;
export function metricsOpenApi(): OpenApi {
  metricsDoc ??= new OpenApi(operatorMetricsOpenApi());
  return metricsDoc;
}

export async function callMetrics(
  h: Harness,
  key: string | undefined,
  url: string,
  headers: Record<string, string> = {},
  remoteAddress?: string,
): Promise<LightMyRequestResponse> {
  const res = await h.app.inject({
    method: "GET",
    url,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    ...(remoteAddress ? { remoteAddress } : {}),
  });
  const doc = metricsOpenApi();
  const path = url.split("?")[0] ?? url;
  const op = doc.operations.find((o) =>
    new RegExp(`^${o.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path),
  );
  if (op) {
    const ct = res.headers["content-type"] as string | undefined;
    const body =
      res.body.length > 0 && ct?.includes("json")
        ? res.json()
        : res.body.length > 0
          ? res.body
          : undefined;
    expect(
      doc.validateResponse(op.operationId, res.statusCode, ct, body),
      `${url} → ${res.statusCode} ${res.body.slice(0, 300)}`,
    ).toEqual([]);
  }
  return res;
}

/** Scope each operator metrics operation requires (`x-required-scope`; null = any valid key). */
export const METRICS_SCOPES: Record<string, "web:read" | "api:read" | "registry:read" | null> = {
  metricsGetKeyInfo: null,
  metricsListProjects: "registry:read",
  metricsGetProject: "registry:read",
  metricsListRegistryProjects: "registry:read",
  metricsGetWebDaily: "web:read",
  metricsGetWebAggregate: "web:read",
  metricsGetWebSummary: "web:read",
  metricsGetWebBreakdowns: "web:read",
  metricsGetWebVerdicts: "web:read",
  metricsGetWebTrust: "web:read",
  metricsGetApiDaily: "api:read",
  metricsGetApiHourly: "api:read",
  metricsGetApiSummary: "api:read",
  metricsGetApiAssurance: "api:read",
  metricsGetOnchainDaily: "api:read",
  metricsGetCohorts: "web:read",
};
