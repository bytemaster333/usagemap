// SPDX-License-Identifier: Apache-2.0
// Reading erasure requests and resolving what they cover — always under the requesting tenant's context (C-87): the
// sites and services are looked up by (tenant, id), so the Umami website ids found can only be that tenant's.

import type { Tx } from "../db/database.ts";
import {
  BACKUP_CLEAR_DAYS,
  type Counts,
  type Criteria,
  criteriaView,
  parseRange,
  type Range,
  type Scope,
  type Selector,
  selectorOf,
  selectorSummary,
} from "./criteria.ts";

export type Status =
  | "previewing"
  | "previewed"
  | "confirmed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** `result` as stored: the counts plus the spool-sweep record (§3 step 8 of docs/privacy/erasure.md). */
export interface StoredResult extends Partial<Counts> {
  spool_sweep?: SpoolSweep;
}

export interface SpoolSweep {
  due_at: string;
  started_at?: string | null;
  done_at?: string | null;
  counts?: Counts | null;
  skipped?: "selector_redacted" | null;
}

export interface RequestRow extends Record<string, unknown> {
  tenant_id: string;
  request_id: string;
  site_id: string | null;
  service_id: string | null;
  scope: Scope;
  criteria: Criteria;
  status: Status;
  preview: Counts | null;
  result: StoredResult | null;
  created_at: Date;
  confirmed_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  finished_at: Date | null;
  selector_redacted_at: Date | null;
  failure_code: string | null;
}

export const COLUMNS = `tenant_id::text AS tenant_id, request_id::text AS request_id, site_id::text AS site_id,
  service_id::text AS service_id, scope, criteria, status::text AS status, preview, result, created_at, confirmed_at,
  started_at, completed_at, finished_at, selector_redacted_at, failure_code`;

export async function loadRequest(
  tx: Tx,
  tenantId: string,
  requestId: string,
  lock = false,
): Promise<RequestRow | undefined> {
  return tx.maybeOne<RequestRow>(
    `SELECT ${COLUMNS} FROM scf.erasure_requests WHERE tenant_id = $1 AND request_id = $2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, requestId],
  );
}

export interface Target {
  tenantId: string;
  siteIds: string[];
  serviceIds: string[];
  websiteIds: string[];
  range: Range;
  selector: Selector | null;
}

/** The sites, services and Umami websites (main and twin, C-73) a request covers, read under the tenant's context. */
export async function resolveTarget(tx: Tx, r: RequestRow): Promise<Target> {
  const range = parseRange(r.criteria);
  if (!("start" in range)) throw new Error("stored criteria have an invalid range");
  const sites = await tx.query<{ site_id: string; main: string | null; twin: string | null }>(
    `SELECT site_id::text AS site_id, umami_website_id::text AS main, umami_twin_website_id::text AS twin
       FROM scf.sites
      WHERE tenant_id = $1 AND ($2::text = 'tenant' OR site_id = $3::uuid)`,
    [r.tenant_id, r.scope, r.site_id],
  );
  const services = await tx.query<{ service_id: string }>(
    `SELECT service_id::text AS service_id FROM scf.api_services
      WHERE tenant_id = $1 AND ($2::text = 'tenant' OR service_id = $3::uuid)`,
    [r.tenant_id, r.scope, r.service_id],
  );
  const websites = new Set<string>();
  for (const s of sites) {
    if (s.main) websites.add(s.main);
    if (s.twin) websites.add(s.twin);
  }
  return {
    tenantId: r.tenant_id,
    siteIds: r.scope === "tenant" || r.site_id ? sites.map((s) => s.site_id) : [],
    serviceIds: r.scope === "tenant" || r.service_id ? services.map((s) => s.service_id) : [],
    websiteIds: [...websites].sort(),
    range,
    selector: selectorOf(r.criteria),
  };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function countsView(c: Partial<Counts> | null): Counts | null {
  if (!c) return null;
  return {
    website_events: Number(c.website_events ?? 0),
    event_data_rows: Number(c.event_data_rows ?? 0),
    sessions_orphaned: Number(c.sessions_orphaned ?? 0),
    breakdown_rows: Number(c.breakdown_rows ?? 0),
    api_routes: Number(c.api_routes ?? 0),
    api_metric_rows: Number(c.api_metric_rows ?? 0),
    aggregate_days: [...(c.aggregate_days ?? [])],
  };
}

/** `ErasureRequest` of the API: literal selector only until redaction (C-88); the completion report when finished. */
export function requestView(r: RequestRow): Record<string, unknown> {
  const done = r.completed_at ?? null;
  const clearBy = done
    ? new Date(done.getTime() + BACKUP_CLEAR_DAYS * 86_400_000).toISOString().slice(0, 10)
    : null;
  const sweep = r.result?.spool_sweep;
  return {
    request_id: r.request_id,
    site_id: r.site_id,
    service_id: r.service_id,
    scope: r.scope,
    criteria: criteriaView(r.criteria),
    selector: selectorSummary(r.criteria),
    selector_redacted_at: iso(r.selector_redacted_at),
    status: r.status,
    preview: countsView(r.preview),
    result: r.result ? countsView(r.result) : null,
    created_at: r.created_at.toISOString(),
    confirmed_at: iso(r.confirmed_at),
    completed_at: iso(r.completed_at),
    backup_expiry_note: clearBy
      ? `Erased data leaves all backups within ${BACKUP_CLEAR_DAYS} days (by ${clearBy}).`
      : `Erased data leaves all backups within ${BACKUP_CLEAR_DAYS} days of completion.`,
    failure_code: r.failure_code,
    spool_sweep: sweep
      ? {
          due_at: sweep.due_at,
          done_at: sweep.done_at ?? null,
          counts: sweep.counts ? countsView(sweep.counts) : null,
          skipped: sweep.skipped ?? null,
        }
      : null,
  };
}
