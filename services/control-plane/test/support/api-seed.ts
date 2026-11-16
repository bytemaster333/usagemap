// SPDX-License-Identifier: Apache-2.0
// Fixtures for the tenant API analytics tests and the isolation matrix: services, contracts and ingest tokens through
// the real API, and metric rows written directly (superuser) in exactly the shape the metrics writer stores
// (data-model §8.11, §9: int4[] histograms in the exp3 (194) or explicit15 (15) layout).

import { randomInt } from "node:crypto";
import { expect } from "vitest";
import { call, type Harness } from "./harness.ts";

// ------------------------------------------------------------------------------------------------ via the API

export async function createService(
  h: Harness,
  cookie: string,
  tenantId: string,
  name = `svc-${randomInt(1e9)}`,
): Promise<string> {
  const res = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenantId}/services`,
    cookie,
    body: { service_name: name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().service_id as string;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function contractId(): string {
  let s = "C";
  for (let i = 0; i < 55; i++) s += B32[randomInt(32)];
  return s;
}

export async function declareContract(
  h: Harness,
  cookie: string,
  tenantId: string,
): Promise<string> {
  const res = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenantId}/contracts`,
    cookie,
    body: { contract_id: contractId(), network: "testnet" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().contract_ref as string;
}

export async function createIngestToken(
  h: Harness,
  cookie: string,
  tenantId: string,
): Promise<{ tokenId: string; token: string }> {
  const res = await call(h, {
    method: "POST",
    url: `/v1/tenants/${tenantId}/ingest-tokens`,
    cookie,
    body: { label: "fixture" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { tokenId: res.json().token_id as string, token: res.json().token as string };
}

/** Own/foreign fixtures for the isolation matrix: `serviceId`, `contractRef`, `tokenId` in `bag`. */
export async function apiFixtures(
  h: Harness,
  cookie: string,
  tenantId: string,
  bag: Record<string, string>,
): Promise<void> {
  bag.serviceId = await createService(h, cookie, tenantId);
  bag.contractRef = await declareContract(h, cookie, tenantId);
  bag.tokenId = (await createIngestToken(h, cookie, tenantId)).tokenId;
}

/** Valid bodies for the isolation matrix (a foreign path id must decide the answer, not validation). */
export const API_BODIES: Record<string, (ids: Record<string, string>) => unknown> = {
  createService: () => ({ service_name: `iso-${randomInt(1e9)}` }),
  updateService: () => ({ display_name: "renamed" }),
  declareContract: () => ({ contract_id: contractId(), network: "testnet" }),
  createIngestToken: () => ({ label: "iso" }),
};

// ------------------------------------------------------------------------------------------------ histograms

export const EXPLICIT15_BOUNDS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

/** exp3 element (1-based) of a value in seconds: (2^((k−114)/8), 2^((k−113)/8)] (data-model §9.2). */
export function exp3Index(v: number): number {
  const k = Math.ceil(8 * Math.log2(v)) + 113;
  return Math.min(194, Math.max(1, k));
}

export function exp3Hist(values: number[]): number[] {
  const h = new Array<number>(194).fill(0);
  for (const v of values) h[exp3Index(v) - 1] = (h[exp3Index(v) - 1] as number) + 1;
  return h;
}

/** explicit15: bucket i holds (b[i−1], b[i]] as OpenTelemetry does; the last bucket is (10, ∞). */
export function explicit15Index(v: number): number {
  const i = EXPLICIT15_BOUNDS.findIndex((b) => v <= b);
  return i === -1 ? 15 : i + 1;
}

export function explicit15Hist(values: number[]): number[] {
  const h = new Array<number>(15).fill(0);
  for (const v of values) h[explicit15Index(v) - 1] = (h[explicit15Index(v) - 1] as number) + 1;
  return h;
}

/** Nearest-rank quantile (the sample at rank ⌈q·N⌉). */
export function exactQuantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)] as number;
}

/** Deterministic PRNG (mulberry32) for reproducible latency samples. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Log-normal latencies in seconds around `median`. */
export function latencies(n: number, median: number, sigma: number, seed: number): number[] {
  const r = prng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(r(), 1e-12);
    const u2 = r();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(median * Math.exp(sigma * z));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ metric rows

type Table = "api_metrics_1m" | "api_metrics_1h" | "api_metrics_1d";
const UNIT: Record<Table, "day" | "month" | "year"> = {
  api_metrics_1m: "day",
  api_metrics_1h: "month",
  api_metrics_1d: "year",
};

/** Creates the partition holding `t` if it does not exist (the migration only creates current and future ones). */
export async function ensurePartition(h: Harness, table: Table, t: Date): Promise<void> {
  const unit = UNIT[table];
  const from = new Date(
    unit === "day"
      ? Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
      : unit === "month"
        ? Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)
        : Date.UTC(t.getUTCFullYear(), 0, 1),
  );
  const to = new Date(from);
  if (unit === "day") to.setUTCDate(to.getUTCDate() + 1);
  else if (unit === "month") to.setUTCMonth(to.getUTCMonth() + 1);
  else to.setUTCFullYear(to.getUTCFullYear() + 1);
  const iso = from.toISOString();
  const suffix =
    unit === "day"
      ? iso.slice(0, 10).replace(/-/g, "")
      : unit === "month"
        ? iso.slice(0, 7).replace("-", "")
        : iso.slice(0, 4);
  const name = `${table}_${suffix}`;
  const exists = await h.su.query(`SELECT to_regclass($1) AS r`, [`scf_part.${name}`]);
  if (exists.rows[0]?.r) return;
  await h.su.query(
    `CREATE TABLE IF NOT EXISTS scf_part.${name} PARTITION OF scf.${table}
       FOR VALUES FROM ('${iso}') TO ('${to.toISOString()}')`,
  );
  await h.su.query(`SELECT scf_admin.secure_partition($1::regclass, $2::regclass)`, [
    `scf_part.${name}`,
    `scf.${table}`,
  ]);
}

export interface Group {
  groupId: string;
  kind: "sdk_stable" | "sdk_legacy" | "span_derived";
}

const KIND_RANK = { sdk_stable: 1, sdk_legacy: 2, span_derived: 3 } as const;

export async function streamGroup(
  h: Harness,
  tenantId: string,
  serviceId: string,
  kind: Group["kind"] = "sdk_stable",
  scope = "@opentelemetry/instrumentation-http",
): Promise<Group> {
  const metric =
    kind === "sdk_stable"
      ? "http.server.request.duration"
      : kind === "sdk_legacy"
        ? "http.server.duration"
        : "scf.span.server.duration";
  const r = await h.su.query<{ id: string }>(
    `INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, service_id, kind, metric_name, scope_name) DO UPDATE SET rank_key = EXCLUDED.rank_key
     RETURNING group_id::text AS id`,
    [tenantId, serviceId, kind, metric, scope, `${KIND_RANK[kind]}|050|${scope}`],
  );
  return { groupId: r.rows[0]?.id as string, kind };
}

export async function route(
  h: Harness,
  tenantId: string,
  serviceId: string,
  path: string,
  rpcMethod: string | null = null,
): Promise<string> {
  const r = await h.su.query<{ id: string }>(
    `INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rpc_method, rules_version)
     VALUES ($1, $2, $3, $4, $5, 'scf-path-rules/1.0.0')
     ON CONFLICT (tenant_id, service_id, route, rpc_method, rules_version) DO UPDATE SET last_seen_at = now()
     RETURNING route_id::text AS id`,
    [
      tenantId,
      serviceId,
      path,
      path.startsWith("/") ? path.replace(/\/[^/]*$/, "") || "/" : "",
      rpcMethod,
    ],
  );
  return r.rows[0]?.id as string;
}

export interface MetricRow {
  table: Table;
  bucket: Date;
  routeId: string;
  status: number;
  values?: number[];
  kind?: "exp3" | "explicit15";
  /** Overrides (request count etc.) when `values` is not given. */
  count?: number;
  hist?: number[];
  quality?: 0 | 1 | 2;
  method?: number;
}

/** Inserts one stored row per entry and marks the group present for the row's UTC day. */
export async function metricRows(
  h: Harness,
  tenantId: string,
  serviceId: string,
  group: Group,
  rows: MetricRow[],
): Promise<void> {
  for (const r of rows) {
    await ensurePartition(h, r.table, r.bucket);
    const kind = r.kind ?? "exp3";
    const values = r.values ?? [];
    const hist = r.hist ?? (kind === "exp3" ? exp3Hist(values) : explicit15Hist(values));
    const count = r.count ?? values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    await h.su.query(
      `INSERT INTO scf.${r.table} (tenant_id, service_id, route_id, method, status_code, source, stream_group_id,
                                   bucket_start, request_count, duration_sum, duration_min, duration_max, hist_kind,
                                   hist, hist_quality)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::int4[], $15)
       ON CONFLICT (tenant_id, service_id, bucket_start, route_id, method, status_code, source, stream_group_id)
       DO UPDATE SET request_count = EXCLUDED.request_count + scf.${r.table}.request_count,
                     duration_sum = EXCLUDED.duration_sum + scf.${r.table}.duration_sum,
                     duration_min = LEAST(EXCLUDED.duration_min, scf.${r.table}.duration_min),
                     duration_max = GREATEST(EXCLUDED.duration_max, scf.${r.table}.duration_max),
                     hist = scf.hist_add(scf.${r.table}.hist, EXCLUDED.hist)`,
      [
        tenantId,
        serviceId,
        r.routeId,
        r.method ?? 1,
        r.status,
        group.kind === "span_derived" ? "span_derived" : "sdk_metric",
        group.groupId,
        r.bucket,
        count,
        sum,
        values.length ? Math.min(...values) : null,
        values.length ? Math.max(...values) : null,
        kind,
        hist,
        r.quality ?? 0,
      ],
    );
    await h.su.query(
      `INSERT INTO scf.api_service_day_groups (tenant_id, service_id, day, stream_group_id)
       VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'UTC')::date, $4) ON CONFLICT DO NOTHING`,
      [tenantId, serviceId, r.bucket, group.groupId],
    );
  }
}

/** The same values at 1m, 1h and 1d (as the writer stores every point at all three resolutions). */
export function allResolutions(t: Date, base: Omit<MetricRow, "table" | "bucket">): MetricRow[] {
  const m = new Date(Math.floor(t.getTime() / 60_000) * 60_000);
  const hr = new Date(Math.floor(t.getTime() / 3_600_000) * 3_600_000);
  const d = new Date(Math.floor(t.getTime() / 86_400_000) * 86_400_000);
  return [
    { ...base, table: "api_metrics_1m", bucket: m },
    { ...base, table: "api_metrics_1h", bucket: hr },
    { ...base, table: "api_metrics_1d", bucket: d },
  ];
}
