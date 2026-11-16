// SPDX-License-Identifier: Apache-2.0
// SCF-operator console (control-plane.openapi.yaml `/v1/operator/...`; operator.global-view-credentials, operator.web-*, operator.api-*):
// ecosystem totals, per-project tables with filter / sort / paging, side-by-side comparison, breakdowns, verdict
// counters, trust and assurance, tenant detail, the audit log, and SCF-operator API keys and grants.
//
// Reads of tenant data go ONLY through the `op_*` functions (C-17): each one authorises the operator context set by
// the pipeline (actor_kind `operator`, live platform role), writes its own audit row in the same transaction, excludes
// pending/removed/L0 tenants by default, and applies minimum count and rounding to web breakdown rows only (C-95).
// Tenant labels (name, registry linkage) come from `op_projects`; slugs and service names from the metric rows
// themselves (C-119, migration 0053); the tenant detail from `op_tenant_detail` — all
// audited; no other cross-tenant read exists for this process.

import { pgCode, type Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { displayOf, mintKey, type Peppers } from "../keys/keys.ts";
import {
  API_COLUMNS,
  type ApiMetricRow,
  apiCellsConsole,
  DAY_MS,
  dayString,
  daysOf,
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
  zeroWebCells,
} from "./common.ts";
import { tenantDetailView } from "./detail.ts";

export interface OperatorDeps {
  peppers: Peppers;
  now?: () => number;
}

type Q = Record<string, unknown>;

const SELF_ATTESTED = "self-attested telemetry";

/** The metric columns of an API row without requests (movers: a service seen only in the previous window). */
const ZERO_API = {
  requests: 0,
  status_2xx: 0,
  status_3xx: 0,
  status_4xx: 0,
  status_5xx: 0,
  status_unknown: 0,
  error_rate_5xx: null,
  mean_s: null,
  p50_s: null,
  p95_s: null,
  p99_s: null,
  accuracy_class: null,
};

function wantsCsv(ctx: RequestContext): boolean {
  return (
    (ctx.header("accept") ?? "").includes("text/csv") &&
    !(ctx.header("accept") ?? "").includes("json")
  );
}

function csvResult(
  rows: Record<string, unknown>[],
  name: string,
  privacy: { minCount: number; roundTo: number },
) {
  return {
    status: 200,
    body: toCsv(rows),
    contentType: "text/csv; charset=utf-8",
    headers: {
      "x-scf-min-count": String(privacy.minCount),
      "x-scf-round-to": String(privacy.roundTo),
      "content-disposition": `attachment; filename="${name}.csv"`,
    },
  };
}

function privacyEcho(p: { minCount: number; roundTo: number }, minLevel?: number) {
  return {
    min_count: p.minCount,
    round_to: p.roundTo,
    aggregation: "sum_of_unrounded_then_rounded" as const,
    ...(minLevel !== undefined ? { excluded_levels_below: levelName(minLevel) } : {}),
  };
}

/**
 * Per-tenant 28-day trust score through `op_trust`: each site's latest 28-day score within the range, averaged over the
 * tenant's scored sites (no score at all = `unscored`).
 */
async function trustScores(tx: Tx, q: Q, minLevel: number, tenants: string[] | null) {
  const rows = await op(() =>
    tx.query<{ tenant_id: string; day: string; score: number | null }>(
      `SELECT DISTINCT ON (site_id) tenant_id::text AS tenant_id, day::text AS day, score
         FROM scf.op_trust($1, $2, $3::uuid[], $4::smallint)
        WHERE window_days = 28 ORDER BY site_id, day DESC`,
      [q.start, q.end, tenants, minLevel],
    ),
  );
  const acc = new Map<string, number[]>();
  for (const r of rows) {
    if (r.score === null) continue;
    const a = acc.get(r.tenant_id) ?? [];
    a.push(Number(r.score));
    acc.set(r.tenant_id, a);
  }
  return new Map(
    [...acc].map(([t, s]) => [t, Math.round(s.reduce((x, y) => x + y, 0) / s.length)]),
  );
}

function band(score: number | undefined): "high" | "medium" | "low" | "unscored" {
  if (score === undefined) return "unscored";
  return score >= 80 ? "high" : score >= 50 ? "medium" : "low";
}

/** True when a filter that needs the tenant labels (registry linkage, trust) is set. */
function labelFiltered(q: Q): boolean {
  return (
    q.scf_awarded !== undefined ||
    q.trust_band !== undefined ||
    q.award_round !== undefined ||
    q.award_stage !== undefined ||
    q.category !== undefined
  );
}

/** K1: the registry-linkage filters `award_round`, `award_stage` and `category` on one label. */
export function registryMatches(l: ProjectLabel, q: Q): boolean {
  const r = l.registry;
  if (typeof q.award_round === "number" && r?.award_round !== q.award_round) return false;
  if (typeof q.award_stage === "string" && r?.award_stage !== q.award_stage) return false;
  if (typeof q.category === "string" && !(r?.categories ?? []).includes(q.category)) return false;
  return true;
}

/**
 * The tenant set of the filters `tenant_ids`, `scf_awarded`, `award_round`, `award_stage`, `category` and `trust_band`
 * (null = no filter: every eligible tenant). Labels (with registry facts) are returned for row decoration.
 */
async function selection(tx: Tx, q: Q, minLevel: number) {
  const labels = await projectLabels(tx, 0, ["pending", "active", "suspended", "removed"], {
    registry: true,
  });
  let set: string[] | null = (q.tenant_ids as string[] | undefined) ?? null;
  if (typeof q.scf_awarded === "boolean") {
    const want = q.scf_awarded;
    const keep = [...labels.values()]
      .filter((l) => (l.scfAwarded === true) === want)
      .map((l) => l.tenantId);
    set = set ? set.filter((t) => keep.includes(t)) : keep;
  }
  if (q.award_round !== undefined || q.award_stage !== undefined || q.category !== undefined) {
    const keep = [...labels.values()].filter((l) => registryMatches(l, q)).map((l) => l.tenantId);
    set = set ? set.filter((t) => keep.includes(t)) : keep;
  }
  let trust: Map<string, number> | null = null;
  if (typeof q.trust_band === "string") {
    trust = await trustScores(tx, q, minLevel, set);
    const keep = [...labels.keys()].filter((t) => band(trust?.get(t)) === q.trust_band);
    set = set ? set.filter((t) => keep.includes(t)) : keep;
  }
  return { labels, tenants: set, trust };
}

function label(labels: Map<string, ProjectLabel>, id: string | null): ProjectLabel {
  const l = id ? labels.get(id) : undefined;
  if (!l) throw new ApiError("not_found");
  return l;
}

async function webMetrics(
  tx: Tx,
  q: Q,
  bucket: "day" | "range",
  group: "tenant" | "site" | "all",
  tenants: string[] | null,
  minLevel: number,
): Promise<WebRow[]> {
  return op(() =>
    tx.query<WebRow>(
      `SELECT ${WEB_COLUMNS} FROM scf.op_web_metrics($1, $2, $3, $4, $5::scf.web_variant, $6::uuid[], $7::smallint)`,
      [q.start, q.end, bucket, group, q.variant ?? "verified", tenants, minLevel],
    ),
  );
}

async function apiMetrics(
  tx: Tx,
  q: Q,
  bucket: "hour" | "day" | "range",
  group: "all" | "tenant" | "service" | "route",
  tenants: string[] | null,
  services: string[] | null,
  minLevel: number,
): Promise<ApiMetricRow[]> {
  return op(() =>
    tx.query<ApiMetricRow>(
      `SELECT ${API_COLUMNS} FROM scf.op_api_metrics($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7::smallint)`,
      [q.start, q.end, bucket, group, tenants, services, minLevel],
    ),
  );
}

function checkRange(q: Q, maxDays = 3660): void {
  const s = Date.parse(String(q.start));
  const e = Date.parse(String(q.end));
  if (!(e > s) || e - s > maxDays * DAY_MS)
    throw new ApiError("validation_failed", "end must be after start, range ≤ 3 660 days (C-86)", {
      errors: [{ pointer: "/end", detail: "end must be after start; range ≤ 3 660 days" }],
    });
}

/**
 * K1 movers: with `compare=previous`, the equal-length window just before `start` (null otherwise). A `*_change` sort
 * without it is a 400.
 */
export function previousWindow(q: Q, sort: string): { start: string; end: string } | null {
  if (q.compare !== "previous") {
    if (sort.endsWith("_change"))
      throw new ApiError("validation_failed", "a *_change sort needs compare=previous", {
        errors: [{ pointer: "/sort", detail: "needs compare=previous" }],
      });
    return null;
  }
  const s = Date.parse(String(q.start));
  const e = Date.parse(String(q.end));
  return { start: new Date(s - (e - s)).toISOString(), end: new Date(s).toISOString() };
}

/** Registry facts of a row (K1): null / empty without a confirmed link. */
function registryCells(l: ProjectLabel): Record<string, unknown> {
  return {
    award_round: l.registry?.award_round ?? null,
    award_stage: l.registry?.award_stage ?? null,
    categories: l.registry?.categories ?? [],
  };
}

export function operatorConsoleHandlers(deps: OperatorDeps): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  // ---------------------------------------------------------------------------------------------- web

  const operatorWebSummary: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const minLevel = levelNumber(q.min_level);
    const { days, privacy } = await ctx.tx(async (tx) => {
      const sel = labelFiltered(q)
        ? await selection(tx, q, minLevel)
        : { tenants: (q.tenant_ids as string[]) ?? null };
      const rows = await webMetrics(tx, q, "day", "all", sel.tenants, minLevel);
      return { days: rows, privacy: await privacySettings(tx) };
    });
    const byDay = new Map(days.map((r) => [dayString(String(r.day)), r]));
    const out = daysOf(String(q.start), String(q.end)).map((d) => {
      const r = byDay.get(d);
      return r
        ? { day: d, all_final: r.all_final ?? false, ...webCells(r) }
        : { day: d, ...zeroWebCells() };
    });
    if (wantsCsv(ctx)) return csvResult(out, "web-summary", privacy);
    return {
      status: 200,
      body: {
        privacy: privacyEcho(privacy, minLevel),
        variant: q.variant ?? "verified",
        days: out,
      },
    };
  };

  const operatorWebProjects: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const minLevel = levelNumber(q.min_level);
    const limit = Number(q.limit ?? 50);
    const sort = String(q.sort ?? "-pageviews");
    const prev = previousWindow(q, sort);
    const bind = `wp:${q.start}:${q.end}:${sort}:${prev ? "p" : ""}`;
    const offset = decodeCursor(q.cursor, bind);
    const { rows, before, sel, trust, privacy } = await ctx.tx(async (tx) => {
      const sel = await selection(tx, q, minLevel);
      const rows = await webMetrics(tx, q, "range", "tenant", sel.tenants, minLevel);
      const before = prev
        ? await webMetrics(tx, { ...q, ...prev }, "range", "tenant", sel.tenants, minLevel)
        : [];
      const trust = sel.trust ?? (await trustScores(tx, q, minLevel, sel.tenants));
      return { rows, before, sel, trust, privacy: await privacySettings(tx) };
    });
    const prevOf = new Map(before.map((r) => [String(r.tenant_id), r]));
    // Movers: a tenant with figures only in the previous window is a row with zero figures now (a full drop).
    const current = new Set(rows.map((r) => String(r.tenant_id)));
    const dropped = before
      .filter((r) => !current.has(String(r.tenant_id)))
      .map((r) => ({ ...r, ...zeroWebCells(), all_final: null }) as WebRow);
    let items = [...rows, ...dropped].map((r) => {
      const l = label(sel.labels, r.tenant_id);
      const cells = webCells(r);
      const p = prevOf.get(l.tenantId);
      return {
        tenant_id: l.tenantId,
        slug: l.slug,
        name: l.name,
        verification_level: levelName(r.verification_level),
        trust_score_28d: trust.get(l.tenantId) ?? null,
        scf_awarded: l.scfAwarded,
        ...registryCells(l),
        ...(prev
          ? {
              pageviews_prev: num(p?.pageviews),
              visitors_prev: num(p?.visitors_sum),
              pageviews_change: num(cells.pageviews) - num(p?.pageviews),
            }
          : {}),
        ...cells,
      } as Record<string, unknown>;
    });
    if (typeof q.min_pageviews === "number")
      items = items.filter((r) => num(r.pageviews) >= Number(q.min_pageviews));
    items.sort(sorter(sort, (r) => String(r.tenant_id)));
    if (wantsCsv(ctx)) return csvResult(items, "web-projects", privacy);
    const p = page(items, offset, limit, bind);
    return {
      status: 200,
      body: { ...p, privacy: privacyEcho(privacy, minLevel), ...(prev ? { previous: prev } : {}) },
    };
  };

  const operatorWebCompare: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const ids = [...new Set(q.tenant_ids as string[])];
    if (ids.length < 2)
      throw new ApiError("validation_failed", "name at least two distinct tenants", {
        errors: [{ pointer: "/tenant_ids", detail: "at least two distinct tenants" }],
      });
    const { rows, labels, privacy } = await ctx.tx(async (tx) => {
      const labels = await projectLabels(tx, 0);
      for (const id of ids) label(labels, id); // unknown, pending or removed: the same 404 (C-87)
      const rows = await webMetrics(tx, q, "day", "tenant", ids, 0);
      return { rows, labels, privacy: await privacySettings(tx) };
    });
    const days = daysOf(String(q.start), String(q.end));
    const series = ids.map((id) => {
      const mine = new Map(
        rows.filter((r) => r.tenant_id === id).map((r) => [dayString(String(r.day)), r]),
      );
      return {
        tenant_id: id,
        slug: label(labels, id).slug,
        days: days.map((d) => {
          const r = mine.get(d);
          return r
            ? { day: d, all_final: r.all_final ?? false, ...webCells(r) }
            : { day: d, ...zeroWebCells() };
        }),
      };
    });
    if (wantsCsv(ctx))
      return csvResult(
        series.flatMap((s) => s.days.map((d) => ({ tenant_id: s.tenant_id, slug: s.slug, ...d }))),
        "web-compare",
        privacy,
      );
    return { status: 200, body: { privacy: privacyEcho(privacy, 0), series } };
  };

  const operatorWebBreakdown: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const minLevel = levelNumber(q.min_level);
    const { rows, privacy, hiddenMin } = await ctx.tx(async (tx) => {
      const sel = labelFiltered(q)
        ? await selection(tx, q, minLevel)
        : { tenants: (q.tenant_ids as string[]) ?? null };
      const rows = await op(() =>
        tx.query<BreakdownRow>(
          `SELECT tenant_id::text AS tenant_id, value, visitors_sum, pageviews, events, hidden_rows
             FROM scf.op_web_breakdown($1, $2, $3::scf.web_dimension, $4::scf.web_variant, $5::uuid[], $6::smallint,
                                       $7::int, 'tenant')`,
          [
            q.start,
            q.end,
            q.dimension,
            q.variant ?? "verified",
            sel.tenants,
            minLevel,
            Number(q.limit ?? 20),
          ],
        ),
      );
      return { rows, privacy: await privacySettings(tx), hiddenMin: await cohortMin(tx) };
    });
    return {
      status: 200,
      body: {
        privacy: privacyEcho(privacy, minLevel),
        dimension: String(q.dimension),
        ...breakdownView(rows, hiddenMin),
      },
    };
  };

  const operatorWebVerdicts: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const minLevel = levelNumber(q.min_level);
    const { rows, privacy } = await ctx.tx(async (tx) => {
      const sel = labelFiltered(q)
        ? await selection(tx, q, minLevel)
        : { tenants: (q.tenant_ids as string[]) ?? null };
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
      return { rows, privacy: await privacySettings(tx) };
    });
    return {
      status: 200,
      body: {
        privacy: privacyEcho(privacy, minLevel),
        rows: rows.map((r) => ({ ...r, count: Number(r.count) })),
      },
    };
  };

  // ---------------------------------------------------------------------------------------------- API

  const operatorApiSummary: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const minLevel = levelNumber(q.min_level);
    const { rows, privacy } = await ctx.tx(async (tx) => {
      const sel = labelFiltered(q)
        ? await selection(tx, q, minLevel)
        : { tenants: (q.tenant_ids as string[]) ?? null };
      const rows = await apiMetrics(tx, q, "day", "all", sel.tenants, null, minLevel);
      return { rows, privacy: await privacySettings(tx) };
    });
    const byDay = new Map(rows.map((r) => [dayString(r.bucket_start as Date), r]));
    const days = daysOf(String(q.start), String(q.end)).map((d) => {
      const r = byDay.get(d);
      return r
        ? { day: d, ...apiCellsConsole(r) }
        : {
            day: d,
            requests: 0,
            error_rate_5xx: null,
            p50_ms: null,
            p95_ms: null,
            p99_ms: null,
            accuracy_class: null,
          };
    });
    if (wantsCsv(ctx)) return csvResult(days, "api-summary", privacy);
    return {
      status: 200,
      body: { privacy: privacyEcho(privacy, minLevel), label: SELF_ATTESTED, days },
    };
  };

  const operatorApiServices: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const minLevel = levelNumber(q.min_level);
    const limit = Number(q.limit ?? 50);
    const sort = String(q.sort ?? "-requests");
    const prev = previousWindow(q, sort);
    const bind = `as:${q.start}:${q.end}:${sort}:${prev ? "p" : ""}`;
    const offset = decodeCursor(q.cursor, bind);
    const data = await ctx.tx(async (tx) => {
      const sel = await selection(tx, q, minLevel);
      const range = await apiMetrics(tx, q, "range", "service", sel.tenants, null, minLevel);
      const before = prev
        ? await apiMetrics(tx, { ...q, ...prev }, "range", "service", sel.tenants, null, minLevel)
        : [];
      const daily = await apiMetrics(tx, q, "day", "service", sel.tenants, null, minLevel);
      const assurance = await op(() =>
        tx.query<{
          tenant_id: string;
          service_id: string;
          day: string;
          level: number;
          onchain_badge: string;
        }>(
          `SELECT tenant_id::text AS tenant_id, service_id::text AS service_id, day::text AS day, level, onchain_badge
             FROM scf.op_api_assurance($1, $2, $3::uuid[], $4::smallint) ORDER BY day`,
          [q.start, q.end, sel.tenants, minLevel],
        ),
      );
      return { sel, range, before, daily, assurance, privacy: await privacySettings(tx) };
    });
    const prevOf = new Map(data.before.map((r) => [String(r.service_id), num(r.requests)]));
    // Movers: a service with requests only in the previous window is a row with zero requests now (a full drop).
    const current = new Set(data.range.map((r) => String(r.service_id)));
    const dropped = data.before
      .filter((r) => !current.has(String(r.service_id)))
      .map((r) => ({ ...r, ...ZERO_API }) as ApiMetricRow);
    const active = new Map<string, number>();
    for (const r of data.daily)
      if (num(r.requests) > 0)
        active.set(String(r.service_id), (active.get(String(r.service_id)) ?? 0) + 1);
    const latest = new Map(data.assurance.map((a) => [a.service_id, a])); // ordered by day: last wins
    let items = [...data.range, ...dropped].map((r) => {
      const l = label(data.sel.labels, r.tenant_id);
      const a = latest.get(String(r.service_id));
      return {
        tenant_id: l.tenantId,
        slug: l.slug,
        service_id: String(r.service_id),
        service_name: r.service_name ?? String(r.service_id),
        verification_level: levelName(r.verification_level),
        assurance_level: a ? `A${a.level}` : null,
        onchain_badge: a?.onchain_badge ?? null,
        active_days: active.get(String(r.service_id)) ?? 0,
        scf_awarded: l.scfAwarded,
        ...registryCells(l),
        ...(prev
          ? {
              requests_prev: prevOf.get(String(r.service_id)) ?? 0,
              requests_change: num(r.requests) - (prevOf.get(String(r.service_id)) ?? 0),
            }
          : {}),
        ...apiCellsConsole(r),
      } as Record<string, unknown>;
    });
    if (typeof q.min_requests === "number")
      items = items.filter((r) => num(r.requests) >= Number(q.min_requests));
    const nameSort = sort === "name";
    if (!nameSort) items.sort(sorter(sort, (r) => String(r.service_id)));
    const shownAll = wantsCsv(ctx);
    if (nameSort)
      items.sort(
        (a, b) =>
          `${a.slug}/${a.service_name}`.localeCompare(`${b.slug}/${b.service_name}`) ||
          String(a.service_id).localeCompare(String(b.service_id)),
      );
    if (shownAll) return csvResult(items, "api-services", data.privacy);
    const p = page(items, offset, limit, bind);
    return {
      status: 200,
      body: {
        ...p,
        privacy: privacyEcho(data.privacy, minLevel),
        label: SELF_ATTESTED,
        ...(prev ? { previous: prev } : {}),
      },
    };
  };

  const operatorApiCompare: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const ids = [...new Set(q.tenant_ids as string[])];
    if (ids.length < 2)
      throw new ApiError("validation_failed", "name at least two distinct tenants", {
        errors: [{ pointer: "/tenant_ids", detail: "at least two distinct tenants" }],
      });
    const { rows, labels, privacy } = await ctx.tx(async (tx) => {
      const labels = await projectLabels(tx, 0);
      for (const id of ids) label(labels, id);
      const rows = await apiMetrics(tx, q, "day", "tenant", ids, null, 0);
      return { rows, labels, privacy: await privacySettings(tx) };
    });
    const days = daysOf(String(q.start), String(q.end));
    const series = ids.map((id) => {
      const mine = new Map(
        rows.filter((r) => r.tenant_id === id).map((r) => [dayString(r.bucket_start as Date), r]),
      );
      return {
        tenant_id: id,
        slug: label(labels, id).slug,
        days: days.map((d) => {
          const r = mine.get(d);
          return r
            ? { day: d, ...apiCellsConsole(r) }
            : {
                day: d,
                requests: 0,
                error_rate_5xx: null,
                p50_ms: null,
                p95_ms: null,
                p99_ms: null,
                accuracy_class: null,
              };
        }),
      };
    });
    if (wantsCsv(ctx))
      return csvResult(
        series.flatMap((s) => s.days.map((d) => ({ tenant_id: s.tenant_id, slug: s.slug, ...d }))),
        "api-compare",
        privacy,
      );
    return {
      status: 200,
      body: { privacy: privacyEcho(privacy, 0), label: SELF_ATTESTED, series },
    };
  };

  const operatorApiRoutes: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const limit = Number(q.limit ?? 50);
    const tenant = String(q.tenant_id);
    const service = typeof q.service_id === "string" ? q.service_id : null;
    const bind = `ar:${tenant}:${service ?? ""}:${q.start}:${q.end}`;
    const offset = decodeCursor(q.cursor, bind);
    const { rows, privacy } = await ctx.tx(async (tx) => {
      // The tenant must exist (any status but purged) and the service must belong to it (C-87): same 404 otherwise.
      const d = await op(() =>
        tx.maybeOne<{ d: { services?: Array<{ service_id: string }> } | null }>(
          `SELECT scf.op_tenant_detail($1::uuid) AS d`,
          [tenant],
        ),
      );
      if (!d?.d) throw new ApiError("not_found");
      if (service && !(d.d.services ?? []).some((s) => s.service_id === service))
        throw new ApiError("not_found");
      const rows = await apiMetrics(
        tx,
        q,
        "range",
        "route",
        [tenant],
        service ? [service] : null,
        0,
      );
      return { rows, privacy: await privacySettings(tx) };
    });
    const items = rows
      .map(
        (r) =>
          ({
            service_id: String(r.service_id),
            route: r.route ?? "{unknown}",
            rpc_method: r.rpc_method,
            ...apiCellsConsole(r),
          }) as Record<string, unknown>,
      )
      .sort(
        (a, b) =>
          num(b.requests) - num(a.requests) ||
          `${a.service_id}${a.route}`.localeCompare(`${b.service_id}${b.route}`),
      );
    return {
      status: 200,
      body: { ...page(items, offset, limit, bind), privacy: privacyEcho(privacy, 0) },
    };
  };

  // ---------------------------------------------------------------------------------------------- trust

  const operatorTrustScores: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const minLevel = levelNumber(q.min_level);
    const limit = Number(q.limit ?? 50);
    const bind = `ts:${q.start}:${q.end}`;
    const offset = decodeCursor(q.cursor, bind);
    const { rows, labels } = await ctx.tx(async (tx) => {
      const sel = await selection(tx, q, minLevel);
      const rows = await op(() =>
        tx.query<{
          tenant_id: string;
          site_id: string;
          day: string;
          window_days: number;
          score: number | null;
          components: Record<string, unknown> | null;
          reason_codes: string[] | null;
          decision_rate: string | null;
          algorithm_version: string;
        }>(
          `SELECT tenant_id::text AS tenant_id, site_id::text AS site_id, day::text AS day, window_days, score,
                  components, reason_codes, decision_rate, algorithm_version
             FROM scf.op_trust($1, $2, $3::uuid[], $4::smallint) ORDER BY day, tenant_id, site_id, window_days`,
          [q.start, q.end, sel.tenants, minLevel],
        ),
      );
      return { rows, labels: sel.labels };
    });
    const items = rows.map((r) => ({
      tenant_id: r.tenant_id,
      slug: label(labels, r.tenant_id).slug,
      site_id: r.site_id,
      day: r.day,
      window_days: Number(r.window_days),
      score: r.score === null ? null : Number(r.score),
      components: r.components ?? {},
      reason_codes: r.reason_codes ?? [],
      decision_rate: numOrNull(r.decision_rate),
      algorithm_version: r.algorithm_version,
    }));
    return { status: 200, body: page(items, offset, limit, bind) };
  };

  const operatorApiAssurance: Handler = async (ctx) => {
    const q = ctx.query;
    checkRange(q);
    const minLevel = levelNumber(q.min_level);
    const limit = Number(q.limit ?? 50);
    const bind = `aa:${q.start}:${q.end}`;
    const offset = decodeCursor(q.cursor, bind);
    const rows = await ctx.tx(async (tx) => {
      const sel = labelFiltered(q)
        ? await selection(tx, q, minLevel)
        : { tenants: (q.tenant_ids as string[]) ?? null };
      return op(() =>
        tx.query<{
          tenant_id: string;
          service_id: string;
          day: string;
          level: number;
          onchain_badge: string;
          reason_codes: string[] | null;
        }>(
          `SELECT tenant_id::text AS tenant_id, service_id::text AS service_id, day::text AS day, level, onchain_badge,
                  reason_codes
             FROM scf.op_api_assurance($1, $2, $3::uuid[], $4::smallint) ORDER BY day, tenant_id, service_id`,
          [q.start, q.end, sel.tenants, minLevel],
        ),
      );
    });
    const items = rows.map((r) => ({
      tenant_id: r.tenant_id,
      service_id: r.service_id,
      day: r.day,
      level: `A${Number(r.level)}`,
      onchain_badge: r.onchain_badge,
      reason_codes: r.reason_codes ?? [],
    }));
    return { status: 200, body: page(items, offset, limit, bind) };
  };

  // ---------------------------------------------------------------------------------------------- tenant, audit

  /** K1: enrolment counts of the overview through `op_enrolment_summary` (console only, audited). */
  const operatorOverview: Handler = async (ctx) => {
    const r = await ctx.tx((tx) =>
      op(() =>
        tx.one<EnrolmentRow>(
          `SELECT month_start::text AS month_start, enrolled, enrolled_at_month_start, pending_approval,
                  pending_at_month_start, new_this_month, new_previous_month, removed_this_month,
                  removed_previous_month
             FROM scf.op_enrolment_summary()`,
        ),
      ),
    );
    return { status: 200, body: overviewView(r, clock()) };
  };

  const operatorGetTenant: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const view = await ctx.tx(async (tx) => {
      const d = await op(() =>
        tx.maybeOne<{ d: Record<string, unknown> | null }>(
          `SELECT scf.op_tenant_detail($1::uuid) AS d`,
          [tenantId],
        ),
      );
      if (!d?.d) throw new ApiError("not_found");
      return tenantDetailView(tx, d.d, clock());
    });
    return { status: 200, body: view };
  };

  const operatorListAudit: Handler = async (ctx) => {
    const q = ctx.query;
    const now = clock();
    const end = typeof q.end === "string" ? q.end : new Date(now).toISOString();
    const start =
      typeof q.start === "string" ? q.start : new Date(Date.parse(end) - 30 * DAY_MS).toISOString();
    if (
      !(Date.parse(end) > Date.parse(start)) ||
      Date.parse(end) - Date.parse(start) > 3660 * DAY_MS
    )
      throw new ApiError("validation_failed", "end must be after start; range ≤ 10 years", {
        errors: [{ pointer: "/end", detail: "end must be after start; range ≤ 10 years" }],
      });
    const limit = Number(q.limit ?? 50);
    let after: { t: string; c: string; s: string } | null = null;
    if (typeof q.cursor === "string" && q.cursor !== "") {
      try {
        const v = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")) as Record<
          string,
          unknown
        >;
        if (typeof v.t === "string" && typeof v.c === "string" && typeof v.s === "string")
          after = { t: v.t, c: v.c, s: v.s };
      } catch {
        /* invalid below */
      }
      if (!after)
        throw new ApiError("validation_failed", "invalid cursor", {
          errors: [{ pointer: "/cursor", detail: "invalid cursor" }],
        });
    }
    const rows = await ctx.tx((tx) =>
      op(() =>
        tx.query<{
          chain_id: string;
          seq: string;
          occurred_at: Date;
          occurred_text: string;
          actor_kind: string;
          actor_id: string | null;
          action: string;
          target_type: string | null;
          target_id: string | null;
          outcome: "success" | "denied" | "failure";
          details: Record<string, unknown>;
          row_hash: Buffer;
          prev_hash: Buffer;
        }>(
          `SELECT chain_id::text AS chain_id, seq::text AS seq, occurred_at,
                  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_text,
                  actor_kind, actor_id, action, target_type, target_id, outcome, details, row_hash, prev_hash
             FROM scf.op_audit_list($1, $2, $3::uuid, $4, $5, $6::timestamptz, $7::uuid, $8::bigint)`,
          [
            start,
            end,
            q.tenant_id ?? null,
            q.action_prefix ?? null,
            limit + 1,
            after?.t ?? null,
            after?.c ?? null,
            after?.s ?? null,
          ],
        ),
      ),
    );
    const items = rows.slice(0, limit).map((r) => ({
      chain_id: r.chain_id,
      seq: Number(r.seq),
      occurred_at: r.occurred_at.toISOString(),
      actor_kind: r.actor_kind,
      actor_id: r.actor_id,
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      outcome: r.outcome,
      details: r.details ?? {},
      row_hash: r.row_hash.toString("hex"),
      prev_hash: r.prev_hash.toString("hex"),
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      status: 200,
      body: {
        items,
        next_cursor: last
          ? Buffer.from(
              JSON.stringify({ t: last.occurred_text, c: last.chain_id, s: last.seq }),
            ).toString("base64url")
          : null,
      },
    };
  };

  // ---------------------------------------------------------------------------------------------- API keys

  interface KeyRow extends Record<string, unknown> {
    key_id: string;
    last4: string;
    label: string;
    scopes: string[];
    tenant_restriction: string[] | null;
    rate_limit_per_min: number;
    created_by: string;
    created_at: Date;
    expires_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
    flagged_for_review_at: Date | null;
  }
  const KEY_COLUMNS = `key_id, last4, label, scopes, tenant_restriction::text[] AS tenant_restriction, rate_limit_per_min,
    created_by::text AS created_by, created_at, expires_at, last_used_at, revoked_at, flagged_for_review_at`;
  const keyView = (r: KeyRow) => ({
    key_id: r.key_id,
    display: displayOf("op", r.key_id, r.last4),
    label: r.label,
    scopes: r.scopes,
    tenant_restriction: r.tenant_restriction,
    rate_limit_per_min: r.rate_limit_per_min,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
    last_used_at: r.last_used_at?.toISOString() ?? null,
    revoked_at: r.revoked_at?.toISOString() ?? null,
    flagged_for_review: r.flagged_for_review_at !== null,
  });

  const operatorListApiKeys: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) =>
      tx.query<KeyRow>(
        `SELECT ${KEY_COLUMNS} FROM scf.operator_api_keys ORDER BY created_at DESC, key_id`,
      ),
    );
    return { status: 200, body: rows.map(keyView) };
  };

  const operatorCreateApiKey: Handler = async (ctx) => {
    const b = ctx.body as {
      label: string;
      scopes: string[];
      tenant_restriction?: string[] | null;
      expires_in_days?: number;
      rate_limit_per_min?: number;
    };
    const set = deps.peppers.op;
    if (!set) throw new ApiError("unavailable", "operator API keys are not configured (pepper_op)");
    const k = mintKey("op", set);
    const scopes = [...new Set(b.scopes)].sort();
    const restriction = b.tenant_restriction ? [...new Set(b.tenant_restriction)].sort() : null;
    const days = b.expires_in_days ?? 90;
    const row = await ctx.tx(async (tx) => {
      // The table policies require the audit row first (scf.audited_in_tx(), data-model §8.7); never the key.
      await tx.audit({
        action: "api_key.created",
        targetType: "operator_api_key",
        targetId: k.id,
        details: {
          scopes,
          tenant_restriction_count: restriction?.length ?? null,
          expires_in_days: days,
          rate_limit_per_min: b.rate_limit_per_min ?? 600,
        },
      });
      return tx.one<KeyRow>(
        `INSERT INTO scf.operator_api_keys (key_id, secret_hash, pepper_version, last4, label, scopes,
                                            tenant_restriction, rate_limit_per_min, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7::uuid[], $8, $9, now() + make_interval(days => $10))
         RETURNING ${KEY_COLUMNS}`,
        [
          k.id,
          k.hash,
          k.pepperVersion,
          k.last4,
          b.label,
          scopes,
          restriction,
          b.rate_limit_per_min ?? 600,
          ctx.session?.userId,
          days,
        ],
      );
    });
    return {
      status: 201,
      body: { ...keyView(row), key: k.key },
      headers: { "cache-control": "no-store" },
    };
  };

  const operatorRevokeApiKey: Handler = async (ctx) => {
    const keyId = ctx.params.keyId as string;
    const reason = (ctx.body as { reason: string }).reason;
    await ctx.tx(async (tx) => {
      const cur = await tx.maybeOne<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM scf.operator_api_keys WHERE key_id = $1`,
        [keyId],
      );
      if (!cur) throw new ApiError("not_found");
      await tx.audit({
        action: "api_key.revoked",
        targetType: "operator_api_key",
        targetId: keyId,
        details: cur.revoked_at ? { already_revoked: true } : {},
      });
      if (cur.revoked_at) return; // already revoked: idempotent (still audited)
      await tx.query(
        `UPDATE scf.operator_api_keys SET revoked_at = now(), revoked_by = $2, revoke_reason = left($3, 200)
          WHERE key_id = $1 AND revoked_at IS NULL`,
        [keyId, ctx.session?.userId, reason],
      );
    });
    return { status: 204 };
  };

  // ---------------------------------------------------------------------------------------------- operators (operator.global-view-credentials)

  /**
   * operator.global-view-credentials / C-20: the platform keeps at least one usable operator_admin (active grant, user neither deleted nor
   * disabled). Every change that can take the role away from `userId` first takes one transaction-scoped advisory lock
   * shared by all such changes (the database trigger on scf.platform_operators takes the same lock), so two admins
   * revoking or demoting each other concurrently are serialised and the second sees the first's result.
   */
  async function keepOneAdmin(tx: Tx, userId: string): Promise<void> {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('scf.platform_operators.admin_set'))`);
    const r = await tx.one<{ target: boolean; others: number }>(
      `SELECT EXISTS (SELECT 1 FROM scf.platform_operators
                       WHERE user_id = $1 AND role = 'operator_admin' AND revoked_at IS NULL) AS target,
              (SELECT count(*) FROM scf.platform_operators o JOIN scf.users u ON u.user_id = o.user_id
                WHERE o.role = 'operator_admin' AND o.revoked_at IS NULL AND o.user_id <> $1
                  AND u.deleted_at IS NULL AND u.disabled_at IS NULL)::int AS others`,
      [userId],
    );
    if (r.target && r.others === 0)
      throw new ApiError("conflict", "the last operator_admin cannot be revoked or demoted");
  }

  const OPERATOR_SQL = `SELECT o.user_id::text AS user_id, u.display_name, o.role::text AS role, o.granted_at,
      o.granted_by::text AS granted_by,
      (SELECT count(*) FROM scf.passkey_credentials p WHERE p.user_id = o.user_id AND p.revoked_at IS NULL)::int AS passkey_count
    FROM scf.platform_operators o JOIN scf.users u ON u.user_id = o.user_id WHERE o.revoked_at IS NULL`;
  const operatorView = (r: Record<string, unknown>) => ({
    user_id: r.user_id,
    display_name: r.display_name ?? null,
    role: r.role,
    granted_at: (r.granted_at as Date).toISOString(),
    granted_by: r.granted_by ?? null,
    passkey_count: Number(r.passkey_count),
  });

  const operatorListOperators: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) => tx.query(`${OPERATOR_SQL} ORDER BY o.granted_at, o.user_id`));
    return { status: 200, body: rows.map(operatorView) };
  };

  const operatorGrant: Handler = async (ctx) => {
    const b = ctx.body as { user_id: string; role: "operator" | "operator_admin"; note?: string };
    const row = await ctx.tx(async (tx) => {
      const u = await tx.maybeOne(
        `SELECT 1 FROM scf.users WHERE user_id = $1 AND deleted_at IS NULL AND disabled_at IS NULL`,
        [b.user_id],
      );
      if (!u) throw new ApiError("not_found");
      // operator.global-view-credentials: a grant of `operator` to a current operator_admin is a demotion; never the last one.
      if (b.role !== "operator_admin") await keepOneAdmin(tx, b.user_id);
      await tx.audit({
        action: "operator.grant.added",
        targetType: "user",
        targetId: b.user_id,
        details: { role: b.role },
      });
      try {
        await tx.query(
          `INSERT INTO scf.platform_operators (user_id, role, granted_by, note) VALUES ($1, $2::scf.platform_role, $3, $4)
           ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by,
             granted_at = now(), note = EXCLUDED.note, revoked_at = NULL, revoked_by = NULL`,
          [b.user_id, b.role, ctx.session?.userId, b.note ?? null],
        );
      } catch (err) {
        throw lastAdminError(err);
      }
      // C-114: granting an operator role ends the user's sessions (the next sign-in needs the passkey step).
      await tx.query(
        `UPDATE scf.auth_sessions SET revoked_at = now(), revoke_reason = 'operator_revoked'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [b.user_id],
      );
      return tx.one(`${OPERATOR_SQL} AND o.user_id = $1`, [b.user_id]);
    });
    return { status: 201, body: operatorView(row) };
  };

  const operatorRevoke: Handler = async (ctx) => {
    const userId = ctx.params.userId as string;
    await ctx.tx(async (tx) => {
      // The row lock needs the UPDATE policy, which needs the audit row first (audited_in_tx); a refusal below rolls
      // the audit row back with everything else.
      await tx.audit({
        action: "operator.grant.revoked",
        targetType: "user",
        targetId: userId,
        details: {},
      });
      await keepOneAdmin(tx, userId);
      const cur = await tx.maybeOne<{ role: string }>(
        `SELECT role::text AS role FROM scf.platform_operators WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE`,
        [userId],
      );
      if (!cur) throw new ApiError("not_found");
      try {
        await tx.query(
          `UPDATE scf.platform_operators SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1`,
          [userId, ctx.session?.userId],
        );
      } catch (err) {
        throw lastAdminError(err);
      }
      // The revoked user's API keys are flagged for review (contract); their sessions lose the operator role at once.
      await tx.query(
        `UPDATE scf.operator_api_keys SET flagged_for_review_at = now()
          WHERE created_by = $1 AND revoked_at IS NULL AND flagged_for_review_at IS NULL`,
        [userId],
      );
      await tx.query(
        `UPDATE scf.auth_sessions SET revoked_at = now(), revoke_reason = 'operator_revoked'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    });
    return { status: 204 };
  };

  return {
    operatorWebSummary,
    operatorWebProjects,
    operatorWebCompare,
    operatorWebBreakdown,
    operatorWebVerdicts,
    operatorApiSummary,
    operatorApiServices,
    operatorApiCompare,
    operatorApiRoutes,
    operatorTrustScores,
    operatorApiAssurance,
    operatorOverview,
    operatorGetTenant,
    operatorListAudit,
    operatorListApiKeys,
    operatorCreateApiKey,
    operatorRevokeApiKey,
    operatorListOperators,
    operatorGrant,
    operatorRevoke,
  };
}

/** The database backstop (trigger on scf.platform_operators, SQLSTATE 23514) answers the same 409 as the app check. */
function lastAdminError(err: unknown): unknown {
  return pgCode(err) === "23514"
    ? new ApiError("conflict", "the last operator_admin cannot be revoked or demoted")
    : err;
}

// ------------------------------------------------------------------------------------------------ K1 views

export interface BreakdownRow extends Record<string, unknown> {
  tenant_id: string | null;
  value: string | null;
  visitors_sum: string | number | null;
  pageviews: string | number | null;
  events: string | number | null;
  hidden_rows: number | null;
}

/** `cohort_min_tenants` (≥ 2): the group size below which a withheld-value count is not reported (C-136/C-137). */
async function cohortMin(tx: Tx): Promise<number> {
  const r = await tx.maybeOne<{ v: number }>(
    `SELECT (value #>> '{}')::int AS v FROM scf.settings WHERE key = 'cohort_min_tenants'`,
  );
  return Math.max(Number(r?.v ?? 5), 2);
}

/**
 * K1 hidden values: op_web_breakdown's summary rows (value NULL) carry the withheld-value count of a tenant, and exist
 * only when that count reaches cohort_min_tenants; they never carry a value or a figure. The count is passed on; no
 * figure of a withheld value is derived or returned.
 */
export function breakdownView(rows: BreakdownRow[], hiddenMin: number) {
  const shown = rows.filter((r) => r.value !== null);
  const hidden = rows
    .filter((r) => r.value === null && r.tenant_id !== null && Number(r.hidden_rows) >= hiddenMin)
    .map((r) => ({ tenant_id: String(r.tenant_id), hidden_rows: Number(r.hidden_rows) }));
  return {
    rows: shown.map((r) => ({
      tenant_id: String(r.tenant_id),
      value: String(r.value),
      visitors_sum: numOrNull(r.visitors_sum),
      pageviews: numOrNull(r.pageviews),
      events: numOrNull(r.events),
    })),
    hidden_rows: hidden.length > 0 ? hidden.reduce((a, h) => a + h.hidden_rows, 0) : null,
    hidden_rows_min: hiddenMin,
    hidden_total_suppressed: true as const,
    hidden_by_tenant: hidden,
  };
}

export interface EnrolmentRow extends Record<string, unknown> {
  month_start: string;
  enrolled: number;
  enrolled_at_month_start: number;
  pending_approval: number;
  pending_at_month_start: number;
  new_this_month: number;
  new_previous_month: number;
  removed_this_month: number;
  removed_previous_month: number;
}

/** `OperatorOverview`: each count with its comparison value and the delta. */
export function overviewView(r: EnrolmentRow, now: number) {
  const c = (value: unknown, previous: unknown) => ({
    value: Number(value),
    previous: Number(previous),
    delta: Number(value) - Number(previous),
  });
  return {
    as_of: new Date(now).toISOString(),
    month_start: r.month_start,
    enrolled: c(r.enrolled, r.enrolled_at_month_start),
    pending_approval: c(r.pending_approval, r.pending_at_month_start),
    new_this_month: c(r.new_this_month, r.new_previous_month),
    removed_this_month: c(r.removed_this_month, r.removed_previous_month),
  };
}
