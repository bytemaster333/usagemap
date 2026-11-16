// SPDX-License-Identifier: Apache-2.0
// Shared helpers of the SCF-operator console and the operator metrics API: every read of tenant data goes through an
// `op_*` function (data-model §11, C-17), which authorises, audits and applies the privacy rules itself. This module
// only shapes rows; it never reads a tenant table directly.

import { pgCode, type Tx } from "../db/database.ts";
import { ApiError } from "../http/problem.ts";

export const DAY_MS = 86_400_000;

/** Maps SQLSTATEs of the op_* functions: 42501 → 403, 22023 / 22007 / 22008 → 400. */
export function opError(err: unknown): never {
  const code = pgCode(err);
  if (code === "42501") throw new ApiError("forbidden");
  if (code === "22023" || code === "22007" || code === "22008")
    throw new ApiError("validation_failed", "invalid range or arguments", {
      errors: [{ pointer: "", detail: "invalid range or arguments (C-86)" }],
    });
  throw err;
}

/** Runs one op_* call and maps its errors. */
export async function op<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    opError(err);
  }
}

export function levelNumber(v: unknown, dflt = 1): number {
  return typeof v === "string" && /^L[0-4]$/.test(v) ? Number(v.slice(1)) : dflt;
}

export function levelName(n: number | string | null | undefined): string {
  return `L${Number(n ?? 0)}`;
}

export function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Seconds (database) → milliseconds (API), 3 decimals; null stays null. */
export function ms(v: unknown): number | null {
  return v === null || v === undefined ? null : Math.round(Number(v) * 1_000_000) / 1000;
}

export function dayString(d: Date | string): string {
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Every UTC day of [start, end) as `YYYY-MM-DD`. */
export function daysOf(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += DAY_MS)
    out.push(dayString(new Date(t)));
  return out;
}

export async function privacySettings(tx: Tx): Promise<{ minCount: number; roundTo: number }> {
  const rows = await tx.query<{ key: string; v: number }>(
    `SELECT key, (value #>> '{}')::int AS v FROM scf.settings WHERE key IN ('op_min_count', 'op_round_to')`,
  );
  const m = new Map(rows.map((r) => [r.key, Number(r.v)]));
  return { minCount: m.get("op_min_count") ?? 10, roundTo: m.get("op_round_to") ?? 10 };
}

// ------------------------------------------------------------------------------------------------ cursors

/** Opaque offset cursor (base64url JSON) bound to the query that produced it. */
export function encodeCursor(offset: number, bind: string): string {
  return Buffer.from(JSON.stringify({ o: offset, b: bind }), "utf8").toString("base64url");
}

export function decodeCursor(c: unknown, bind: string): number {
  if (c === undefined || c === null || c === "") return 0;
  try {
    const v = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8")) as {
      o?: unknown;
      b?: unknown;
    };
    if (Number.isInteger(v.o) && (v.o as number) >= 0 && v.b === bind) return v.o as number;
  } catch {
    /* fall through */
  }
  throw new ApiError("validation_failed", "invalid cursor", {
    errors: [{ pointer: "/cursor", detail: "invalid cursor" }],
  });
}

export function page<T>(
  rows: T[],
  offset: number,
  limit: number,
  bind: string,
): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(offset, offset + limit);
  return {
    items,
    next_cursor: offset + limit < rows.length ? encodeCursor(offset + limit, bind) : null,
  };
}

/** Stable comparator for `sort` values like `-pageviews` / `name`; nulls last in both directions. */
export function sorter<T extends Record<string, unknown>>(
  sort: string,
  tiebreak: (r: T) => string,
): (a: T, b: T) => number {
  const desc = sort.startsWith("-");
  const key = desc ? sort.slice(1) : sort;
  return (a, b) => {
    const x = a[key];
    const y = b[key];
    let c = 0;
    if (x === y || (x == null && y == null)) c = 0;
    else if (x == null) return 1;
    else if (y == null) return -1;
    else if (typeof x === "number" && typeof y === "number") c = x - y;
    else c = String(x).localeCompare(String(y));
    if (desc) c = -c;
    return c !== 0 ? c : tiebreak(a).localeCompare(tiebreak(b));
  };
}

// ------------------------------------------------------------------------------------------------ CSV

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join(" ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  // OWASP CSV injection: text a spreadsheet would evaluate as a formula gets a leading apostrophe.
  // Only text cells: numbers (also negative ones, and numeric text such as PostgreSQL `numeric`) are written as they are.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function flatten(row: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === "object" && !Array.isArray(v))
      Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

/** RFC 4180, UTF-8, header row of the JSON field names (nested objects flattened with `.`), nulls empty. */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const flat = rows.map((r) => flatten(r));
  const cols = columns ?? [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const lines = [cols.join(",")];
  for (const r of flat) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

// ------------------------------------------------------------------------------------------------ cells

export interface WebRow extends Record<string, unknown> {
  tenant_id: string | null;
  site_id: string | null;
  day: Date | string | null;
  verification_level: number | null;
  pageviews: string | number;
  pageviews_unidentified: string | number;
  visitors_sum: string | number;
  visits: string | number;
  bounces: string | number;
  bounce_rate_pct: string | number | null;
  avg_visit_duration_s: string | number | null;
  suspect_pageview_share: string | number | null;
  all_final: boolean | null;
  /** C-119 (migration 0053): the tenant's slug on every row (null when grouped over all tenants) */
  slug: string | null;
}

export const WEB_COLUMNS = `tenant_id::text AS tenant_id, site_id::text AS site_id, day::text AS day, verification_level,
  pageviews, pageviews_unidentified, visitors_sum, visits, bounces, bounce_rate_pct, avg_visit_duration_s,
  suspect_pageview_share, all_final, slug`;

export function webCells(r: WebRow): Record<string, unknown> {
  return {
    pageviews: num(r.pageviews),
    pageviews_unidentified: num(r.pageviews_unidentified),
    visitors_sum: num(r.visitors_sum),
    visits: num(r.visits),
    bounces: num(r.bounces),
    bounce_rate_pct: numOrNull(r.bounce_rate_pct),
    avg_visit_duration_s: numOrNull(r.avg_visit_duration_s),
    suspect_pageview_share: numOrNull(r.suspect_pageview_share),
  };
}

export function zeroWebCells(): Record<string, unknown> {
  return {
    pageviews: 0,
    pageviews_unidentified: 0,
    visitors_sum: 0,
    visits: 0,
    bounces: 0,
    bounce_rate_pct: null,
    avg_visit_duration_s: null,
    suspect_pageview_share: null,
  };
}

export interface ApiMetricRow extends Record<string, unknown> {
  tenant_id: string | null;
  service_id: string | null;
  route: string | null;
  rpc_method: string | null;
  bucket_start: Date | null;
  verification_level: number | null;
  requests: string | number | null;
  status_2xx: string | number | null;
  status_3xx: string | number | null;
  status_4xx: string | number | null;
  status_5xx: string | number | null;
  status_unknown: string | number | null;
  error_rate_5xx: string | number | null;
  mean_s: number | null;
  p50_s: number | null;
  p95_s: number | null;
  p99_s: number | null;
  accuracy_class: string | null;
  /** C-119 (migration 0053): row labels */
  slug: string | null;
  service_name: string | null;
}

export const API_COLUMNS = `tenant_id::text AS tenant_id, service_id::text AS service_id, route, rpc_method, bucket_start,
  verification_level, requests, status_2xx, status_3xx, status_4xx, status_5xx, status_unknown, error_rate_5xx,
  mean_s, p50_s, p95_s, p99_s, accuracy_class, slug, service_name`;

/** API cells in the console's naming (`s2xx`…/`unknown`, CR-34). */
export function apiCellsConsole(r: ApiMetricRow): Record<string, unknown> {
  return {
    requests: num(r.requests),
    s2xx: num(r.status_2xx),
    s3xx: num(r.status_3xx),
    s4xx: num(r.status_4xx),
    s5xx: num(r.status_5xx),
    unknown: num(r.status_unknown),
    error_rate_5xx: numOrNull(r.error_rate_5xx),
    mean_ms: ms(r.mean_s),
    p50_ms: ms(r.p50_s),
    p95_ms: ms(r.p95_s),
    p99_ms: ms(r.p99_s),
    accuracy_class: r.accuracy_class ?? null,
  };
}

/** API cells in the machine API's naming (`status_2xx`…, CR-34). */
export function apiCellsMachine(r: ApiMetricRow): Record<string, unknown> {
  return {
    requests: num(r.requests),
    status_2xx: num(r.status_2xx),
    status_3xx: num(r.status_3xx),
    status_4xx: num(r.status_4xx),
    status_5xx: num(r.status_5xx),
    status_unknown: num(r.status_unknown),
    error_rate_5xx: numOrNull(r.error_rate_5xx),
    mean_ms: ms(r.mean_s),
    p50_ms: ms(r.p50_s),
    p95_ms: ms(r.p95_s),
    p99_ms: ms(r.p99_s),
    accuracy_class: r.accuracy_class ?? null,
  };
}

// ------------------------------------------------------------------------------------------------ labels

export interface ProjectLabel {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  createdAt: Date;
  level: number;
  scfAwarded: boolean | null;
  registryProjectIds: string[];
  siteCount: number;
  serviceCount: number;
  /** K1: public registry facts of the confirmed links (null without one, or when not requested) */
  registry: RegistryFacts | null;
}

/** A row of the global, public `scf.registry_projects` table (readable by scf_app; no tenant data). */
export interface RegistryProjectRow extends Record<string, unknown> {
  registry_project_id: string;
  source: string;
  source_id: string;
  name: string;
  source_url: string | null;
  scf_awarded: boolean | null;
  award_round: number | null;
  award_stage: string | null;
  scf_categories: string[] | null;
}

/** `OperatorRegistryFacts`: the confirmed link with the latest award round; categories over all confirmed links. */
export interface RegistryFacts {
  registry_project_id: string;
  source: string;
  source_id: string;
  name: string;
  url: string | null;
  award_round: number | null;
  award_stage: string | null;
  categories: string[];
}

/**
 * K1: the registry facts of a tenant from its confirmed links. With several links the primary one is the one with
 * the latest award round (no round last), then awarded before not, then the lowest id; categories are the sorted union.
 */
export function registryFacts(rows: RegistryProjectRow[]): RegistryFacts | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort(
    (a, b) =>
      (b.award_round ?? -1) - (a.award_round ?? -1) ||
      Number(b.scf_awarded === true) - Number(a.scf_awarded === true) ||
      a.registry_project_id.localeCompare(b.registry_project_id),
  );
  const p = sorted[0] as RegistryProjectRow;
  return {
    registry_project_id: p.registry_project_id,
    source: p.source,
    source_id: p.source_id,
    name: p.name,
    url: p.source_url,
    award_round: p.award_round === null ? null : Number(p.award_round),
    award_stage: p.award_stage,
    categories: [...new Set(rows.flatMap((r) => r.scf_categories ?? []))].sort(),
  };
}

/** Reads the registry projects named by confirmed links (global public table; not tenant data, not audited). */
export async function registryProjects(
  tx: Tx,
  ids: string[],
): Promise<Map<string, RegistryProjectRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<RegistryProjectRow>(
    `SELECT registry_project_id::text AS registry_project_id, source, source_id, name, source_url, scf_awarded,
            award_round, award_stage, scf_categories
       FROM scf.registry_projects WHERE registry_project_id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  return new Map(rows.map((r) => [r.registry_project_id, r]));
}

/** Registry facts per tenant from the registry project ids of its confirmed links. */
export async function registryFactsByTenant(
  tx: Tx,
  links: Array<{ tenantId: string; ids: string[] }>,
): Promise<Map<string, RegistryFacts | null>> {
  const projects = await registryProjects(
    tx,
    links.flatMap((l) => l.ids),
  );
  return new Map(
    links.map((l) => [
      l.tenantId,
      registryFacts(
        l.ids.flatMap((id) => (projects.has(id) ? [projects.get(id) as RegistryProjectRow] : [])),
      ),
    ]),
  );
}

/**
 * Tenant labels (slug, name, registry linkage) through `op_projects` — the only cross-tenant read of tenant metadata
 * an application role has (C-17); audited `operator.read.op_projects`.
 */
export async function projectLabels(
  tx: Tx,
  minLevel: number,
  statuses: string[] = ["active", "suspended"],
  opts: { registry?: boolean } = {},
): Promise<Map<string, ProjectLabel>> {
  const rows = await op(() =>
    tx.query<{
      tenant_id: string;
      slug: string;
      name: string;
      status: string;
      created_at: Date;
      verification_level: number;
      scf_awarded: boolean | null;
      registry_project_ids: string[] | null;
      site_count: string;
      service_count: string;
    }>(
      `SELECT tenant_id::text AS tenant_id, slug, name, status::text AS status, created_at, verification_level,
              scf_awarded, registry_project_ids::text[] AS registry_project_ids, site_count::text, service_count::text
         FROM scf.op_projects($1::smallint, $2::scf.tenant_status[], NULL)`,
      [minLevel, statuses],
    ),
  );
  const facts = opts.registry
    ? await registryFactsByTenant(
        tx,
        rows.map((r) => ({ tenantId: r.tenant_id, ids: r.registry_project_ids ?? [] })),
      )
    : new Map<string, RegistryFacts | null>();
  return new Map(
    rows.map((r) => [
      r.tenant_id,
      {
        tenantId: r.tenant_id,
        slug: r.slug,
        name: r.name,
        status: r.status,
        createdAt: r.created_at,
        level: Number(r.verification_level),
        scfAwarded: r.scf_awarded,
        registryProjectIds: r.registry_project_ids ?? [],
        siteCount: Number(r.site_count),
        serviceCount: Number(r.service_count),
        registry: facts.get(r.tenant_id) ?? null,
      },
    ]),
  );
}
