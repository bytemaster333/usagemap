// SPDX-License-Identifier: Apache-2.0
// Erasure in `scf` (C-46, data-model §8.8), always inside a transaction under the requesting tenant's context:
//   - web: `web_daily_breakdowns` rows of the request's sites whose day overlaps the range and whose path / event-name
//     value matches the selector (all rows of the range without a selector). Site totals remain — they hold no path
//     or event content.
//   - dev events (`web_dev_events`, the 24-hour first-event buffer, C-136): with a path or event-name selector, the
//     request's sites' rows received in the range whose normalised path / event name matches; without a
//     selector, every row of the range. They are not counted separately (ErasureCounts has no field for them).
//   - API: for a path selector, every `api_routes` entry of the request's services matching it is erased together
//     with ALL its metric rows (1-minute, 1-hour, 1-day; the route string itself is what has to go, C-93) — the rows go
//     by the routes' ON DELETE CASCADE; without a selector, the services' metric rows overlapping the range.
// The same predicates serve the count-only preview (read under scf_app) and the deletion (job `erasure`, scf_jobs).
// Before its first api_* delete the deletion takes the tenant's API fence exclusively (fence.ts):
// it waits for the metrics writer's open transactions of the tenant, and deletes in the writer's table order
// (_1d, _1h, _1m) as a second line of defence.

import type { Tx } from "../db/database.ts";
import { type Counts, globToLike, type Range, type Selector, zeroCounts } from "./criteria.ts";
import { API_FENCE_LOCK_SQL } from "./fence.ts";

export interface ScfTarget {
  tenantId: string;
  siteIds: string[];
  serviceIds: string[];
  range: Range;
  selector: Selector | null;
}

function breakdownWhere(sel: Selector | null): string {
  const base = `b.tenant_id = $1 AND b.site_id = ANY ($2::uuid[])
                AND b.day >= ($3::timestamptz AT TIME ZONE 'UTC')::date
                AND (b.day::timestamp AT TIME ZONE 'UTC') < $4::timestamptz`;
  if (!sel) return base;
  if (sel.type === "path_pattern")
    return `${base} AND b.dimension = 'path' AND b.value LIKE $5 ESCAPE '\\'`;
  if (sel.type === "event_name") return `${base} AND b.dimension = 'event' AND b.value = $5`;
  return "false"; // no property dimension is aggregated
}

function breakdownParams(t: ScfTarget): unknown[] {
  const p: unknown[] = [t.tenantId, t.siteIds, t.range.start, t.range.end];
  if (t.selector)
    p.push(t.selector.type === "path_pattern" ? globToLike(t.selector.value) : t.selector.value);
  return p;
}

function devEventWhere(sel: Selector | null): string {
  const base = `d.tenant_id = $1 AND d.site_id = ANY ($2::uuid[]) AND d.received_at >= $3 AND d.received_at < $4`;
  if (!sel) return base;
  if (sel.type === "path_pattern") return `${base} AND d.path_class LIKE $5 ESCAPE '\\'`;
  if (sel.type === "event_name") return `${base} AND d.event_name = $5`;
  return "false"; // dev events carry no property values
}

/** In the metrics writer's upsert order (services/metrics-writer/internal/store/upsert.go: _1d, _1h, _1m). */
const METRIC_TABLES = [
  ["api_metrics_1d", "1 day"],
  ["api_metrics_1h", "1 hour"],
  ["api_metrics_1m", "1 minute"],
] as const;

/** Metric rows overlapping the range (no selector). */
function metricRangeWhere(width: string): string {
  return `m.tenant_id = $1 AND m.service_id = ANY ($2::uuid[]) AND m.bucket_start < $4
          AND m.bucket_start + interval '${width}' > $3`;
}

const n = (v: unknown): number => Number(v ?? 0);

export async function scfCounts(tx: Tx, t: ScfTarget): Promise<Counts> {
  const c = zeroCounts();
  if (t.siteIds.length > 0 && t.selector?.type !== "property_key") {
    const r = await tx.one(
      `SELECT count(*) AS rows, array_agg(DISTINCT b.day::text) AS days
         FROM scf.web_daily_breakdowns b WHERE ${breakdownWhere(t.selector)}`,
      breakdownParams(t),
    );
    c.breakdown_rows = n(r.rows);
    c.aggregate_days = ((r.days as string[] | null) ?? []).sort();
  }
  if (t.serviceIds.length > 0) {
    if (t.selector?.type === "path_pattern") {
      const routes = await matchingRoutes(tx, t);
      c.api_routes = routes.length;
      if (routes.length > 0)
        for (const [table] of METRIC_TABLES) {
          const r = await tx.one(
            `SELECT count(*) AS rows FROM scf.${table} m WHERE m.tenant_id = $1 AND m.route_id = ANY ($2::bigint[])`,
            [t.tenantId, routes],
          );
          c.api_metric_rows += n(r.rows);
        }
    } else if (!t.selector) {
      for (const [table, width] of METRIC_TABLES) {
        const r = await tx.one(
          `SELECT count(*) AS rows FROM scf.${table} m WHERE ${metricRangeWhere(width)}`,
          [t.tenantId, t.serviceIds, t.range.start, t.range.end],
        );
        c.api_metric_rows += n(r.rows);
      }
    }
  }
  return c;
}

async function matchingRoutes(tx: Tx, t: ScfTarget): Promise<string[]> {
  const rows = await tx.query<{ route_id: string }>(
    `SELECT r.route_id::text AS route_id FROM scf.api_routes r
      WHERE r.tenant_id = $1 AND r.service_id = ANY ($2::uuid[]) AND r.route LIKE $3 ESCAPE '\\'`,
    [t.tenantId, t.serviceIds, globToLike(t.selector?.value ?? "")],
  );
  return rows.map((r) => r.route_id);
}

/** Deletes what `scfCounts` counts; returns the counts actually deleted. */
export async function scfErase(tx: Tx, t: ScfTarget): Promise<Counts> {
  const c = zeroCounts();
  if (t.siteIds.length > 0 && t.selector?.type !== "property_key") {
    const r = await tx.query<{ day: string }>(
      `DELETE FROM scf.web_daily_breakdowns b WHERE ${breakdownWhere(t.selector)} RETURNING b.day::text AS day`,
      breakdownParams(t),
    );
    c.breakdown_rows = r.length;
    c.aggregate_days = [...new Set(r.map((x) => x.day))].sort();
    await tx.query(
      `DELETE FROM scf.web_dev_events d WHERE ${devEventWhere(t.selector)}`,
      breakdownParams(t),
    );
  }
  if (
    t.serviceIds.length > 0 &&
    t.selector?.type !== "event_name" &&
    t.selector?.type !== "property_key"
  ) {
    // The writer's open transactions of the tenant commit first (their rows are deleted below); new ones wait for
    // this transaction's commit. Taken before any api_* row lock, so no lock cycle with the writer can form.
    await tx.query(API_FENCE_LOCK_SQL, [t.tenantId]);
    if (t.selector?.type === "path_pattern") {
      const routes = await matchingRoutes(tx, t);
      if (routes.length > 0) {
        // Count the metric rows first: they leave with their route (ON DELETE CASCADE).
        for (const [table] of METRIC_TABLES) {
          const r = await tx.one(
            `WITH d AS (DELETE FROM scf.${table} m WHERE m.tenant_id = $1 AND m.route_id = ANY ($2::bigint[])
                         RETURNING 1)
             SELECT count(*) AS rows FROM d`,
            [t.tenantId, routes],
          );
          c.api_metric_rows += n(r.rows);
        }
        const d = await tx.query(
          `DELETE FROM scf.api_routes r WHERE r.tenant_id = $1 AND r.route_id = ANY ($2::bigint[]) RETURNING 1`,
          [t.tenantId, routes],
        );
        c.api_routes = d.length;
      }
    } else if (!t.selector) {
      for (const [table, width] of METRIC_TABLES) {
        const r = await tx.one(
          `WITH d AS (DELETE FROM scf.${table} m WHERE ${metricRangeWhere(width)} RETURNING 1)
           SELECT count(*) AS rows FROM d`,
          [t.tenantId, t.serviceIds, t.range.start, t.range.end],
        );
        c.api_metric_rows += n(r.rows);
      }
    }
  }
  return c;
}
