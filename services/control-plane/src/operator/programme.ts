// SPDX-License-Identifier: Apache-2.0
// SCF-operator actions on the verification ladder, registry and trust (control-plane.openapi.yaml; ADR-0015, ADR-0028,
// ADR-0032; C-17, C-19, C-80): approval (L4), registry link decisions, domain dispute resolution and annotations — each
// through its audited `op_*` function, which checks the platform role and the 10-minute step-up itself (C-09, C-114) —
// plus the campaign-versus-baseline comparison (`op_web_metrics`, once per window), the synced registry with
// provenance, and an on-demand registry sync (job `registry_sync`, woken by NOTIFY).

import { pgCode, type Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import {
  ANNOTATION_COLS,
  type AnnotationInput,
  type AnnotationRow,
  annotationView,
  checkAnnotation,
} from "../trust/handlers.ts";
import { uuidv7 } from "../util/ids.ts";
import { EVIDENCE_COLS, evidenceView } from "../verify/ladder.ts";
import {
  DAY_MS,
  decodeCursor,
  num,
  opError,
  page,
  privacySettings,
  projectLabels,
  toCsv,
  WEB_COLUMNS,
  type WebRow,
  webCells,
  zeroWebCells,
} from "./common.ts";

/** op_* errors plus: an unknown tenant, site or registry project (foreign key or P0002) is 404 (C-87). */
function opWriteError(err: unknown): never {
  const code = pgCode(err);
  if (code === "23503" || code === "P0002") throw new ApiError("not_found");
  opError(err);
}

async function opCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    opWriteError(err);
  }
}

/** Reads a tenant row back after an op_* write, as `system` under that tenant (no extra audit row; C-117). */
async function asTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.switchContext({ tenantId, actorKind: "system", actorId: "operator-action-echo" });
}

function wantsCsv(ctx: RequestContext): boolean {
  const a = ctx.header("accept") ?? "";
  return a.includes("text/csv") && !a.includes("json");
}

export function operatorProgrammeHandlers(deps: { now?: () => number }): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  const operatorApproveTenantLevel: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const note = (ctx.body as { note: string }).note;
    const body = await ctx.tx(async (tx) => {
      const r = await opCall(() =>
        tx.one<{ id: string }>(`SELECT scf.op_approve_tenant_evidence($1::uuid, $2)::text AS id`, [
          tenantId,
          note,
        ]),
      );
      await tx.notify("scf_edge"); // the level travels to the gateway in the edge snapshot
      await asTenant(tx, tenantId);
      return evidenceView(
        await tx.one(
          `SELECT ${EVIDENCE_COLS} FROM scf.verification_evidence WHERE tenant_id = $1 AND evidence_id = $2`,
          [tenantId, r.id],
        ),
      );
    });
    return { status: 201, body };
  };

  const operatorDecideRegistryLink: Handler = async (ctx) => {
    const decision = (ctx.body as { decision: "confirm" | "reject" }).decision;
    await ctx.tx(async (tx) => {
      await opCall(() =>
        tx.query(`SELECT scf.op_registry_link_decide($1::uuid, $2::uuid, $3)`, [
          ctx.params.tenantId,
          ctx.params.registryProjectId,
          decision,
        ]),
      );
      await tx.notify("scf_edge");
    });
    return { status: 204 };
  };

  const operatorResolveDomainDispute: Handler = async (ctx) => {
    const decision = (ctx.body as { decision: "keep" | "release" }).decision;
    await ctx.tx(async (tx) => {
      await opCall(() =>
        tx.query(`SELECT scf.op_resolve_domain_dispute($1::uuid, $2::uuid, $3)`, [
          ctx.params.tenantId,
          ctx.params.domainId,
          decision,
        ]),
      );
      await tx.notify("scf_edge");
    });
    return { status: 204 };
  };

  /** C-124: an operator_admin (step-up) sets or clears a site's multiplicity mode; null = the platform setting. */
  const operatorSetSiteMultiplicityMode: Handler = async (ctx) => {
    const mode = (ctx.body as { multiplicity_mode: "enforce" | "shadow" | null }).multiplicity_mode;
    const effective = await ctx.tx(async (tx) => {
      const r = await opCall(() =>
        tx.one<{ mode: "enforce" | "shadow" }>(
          `SELECT scf.op_set_site_multiplicity_mode($1::uuid, $2::uuid, $3) AS mode`,
          [ctx.params.tenantId, ctx.params.siteId, mode],
        ),
      );
      await tx.notify("scf_edge");
      return r.mode;
    });
    return {
      status: 200,
      body: {
        site_id: ctx.params.siteId,
        multiplicity_mode: mode,
        effective_multiplicity_mode: effective,
      },
    };
  };

  const operatorAnnotate: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const b = ctx.body as AnnotationInput & { marks_explained?: boolean };
    checkAnnotation(b);
    const body = await ctx.tx(async (tx) => {
      const r = await opCall(() =>
        tx.one<{ id: string }>(
          `SELECT scf.op_add_annotation($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz, $6, $7::text[], $8)::text AS id`,
          [
            tenantId,
            b.site_id ?? null,
            b.service_id ?? null,
            b.start,
            b.end,
            b.body,
            [...new Set(b.explains_reason_codes ?? [])],
            b.marks_explained ?? false,
          ],
        ),
      );
      await asTenant(tx, tenantId);
      return annotationView(
        await tx.one<AnnotationRow>(
          `SELECT ${ANNOTATION_COLS} FROM scf.trust_annotations WHERE tenant_id = $1 AND annotation_id = $2`,
          [tenantId, r.id],
        ),
      );
    });
    return { status: 201, body };
  };

  const operatorCampaignComparison: Handler = async (ctx) => {
    const q = ctx.query;
    const ids = [...new Set(q.tenant_ids as string[])];
    const win = (s: unknown, e: unknown, name: string) => {
      const a = Date.parse(String(s));
      const z = Date.parse(String(e));
      if (!(z > a) || z - a > 3660 * DAY_MS)
        throw new ApiError(
          "validation_failed",
          `${name}_end must be after ${name}_start; ≤ 3 660 days (C-86)`,
          {
            errors: [
              { pointer: `/${name}_end`, detail: "end must be after start; range ≤ 3 660 days" },
            ],
          },
        );
      return Math.round((z - a) / DAY_MS);
    };
    if (ids.length < 2)
      throw new ApiError("validation_failed", "name at least two distinct tenants", {
        errors: [{ pointer: "/tenant_ids", detail: "at least two distinct tenants" }],
      });
    const campaignDays = win(q.campaign_start, q.campaign_end, "campaign");
    const baselineDays = win(q.baseline_start, q.baseline_end, "baseline");
    const variant = (q.variant as string | undefined) ?? "verified";
    const { camp, base, labels, privacy } = await ctx.tx(async (tx) => {
      const labels = await projectLabels(tx, 0);
      for (const id of ids) if (!labels.has(id)) throw new ApiError("not_found"); // same 404 (C-87)
      const run = (s: unknown, e: unknown) =>
        opCall(() =>
          tx.query<WebRow>(
            `SELECT ${WEB_COLUMNS} FROM scf.op_web_metrics($1, $2, 'range', 'tenant', $3::scf.web_variant, $4::uuid[], 0::smallint)`,
            [s, e, variant, ids],
          ),
        );
      const camp = await run(q.campaign_start, q.campaign_end);
      const base = await run(q.baseline_start, q.baseline_end);
      return { camp, base, labels, privacy: await privacySettings(tx) };
    });
    const cells = (rows: WebRow[], id: string) => {
      const r = rows.find((x) => x.tenant_id === id);
      return r ? webCells(r) : zeroWebCells();
    };
    const ratio = (c: number, b: number) =>
      b > 0 ? Math.round((c / campaignDays / (b / baselineDays)) * 10_000) / 10_000 : null;
    const rows = ids.map((id) => {
      const c = cells(camp, id);
      const b = cells(base, id);
      return {
        tenant_id: id,
        slug: labels.get(id)?.slug as string,
        campaign: c,
        baseline: b,
        campaign_days: campaignDays,
        baseline_days: baselineDays,
        pageviews_per_day_ratio: ratio(num(c.pageviews), num(b.pageviews)),
        visitors_per_day_ratio: ratio(num(c.visitors_sum), num(b.visitors_sum)),
      };
    });
    if (wantsCsv(ctx))
      return {
        status: 200,
        body: toCsv(rows),
        contentType: "text/csv; charset=utf-8",
        headers: { "content-disposition": 'attachment; filename="campaign-comparison.csv"' },
      };
    return {
      status: 200,
      body: {
        privacy: {
          min_count: privacy.minCount,
          round_to: privacy.roundTo,
          aggregation: "sum_of_unrounded_then_rounded",
          excluded_levels_below: "L0",
        },
        rows,
      },
    };
  };

  const operatorListRegistryProjects: Handler = async (ctx) => {
    const q = ctx.query;
    const limit = Number(q.limit ?? 50);
    const bind = `rp:${q.q ?? ""}:${q.scf_awarded ?? ""}`;
    const offset = decodeCursor(q.cursor, bind);
    const { rows, linked } = await ctx.tx(async (tx) => {
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
        missing_since: Date | null;
      }>(
        `SELECT registry_project_id::text AS registry_project_id, source, source_id, canonical_daoip5_id, name,
                websites, scf_awarded, scf_awards, source_url, source_as_of::text AS source_as_of, fetched_at,
                missing_since
           FROM scf.registry_projects
          WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR source_id ILIKE '%' || $1 || '%')
            AND ($2::boolean IS NULL OR scf_awarded IS NOT DISTINCT FROM $2)
          ORDER BY name, registry_project_id`,
        [q.q ?? null, typeof q.scf_awarded === "boolean" ? q.scf_awarded : null],
      );
      // Confirmed links per tenant, through op_projects (audited; the console sees every status).
      const labels = await projectLabels(tx, 0, ["pending", "active", "suspended", "removed"]);
      const linked = new Map<string, string[]>();
      for (const l of labels.values())
        for (const r of l.registryProjectIds) linked.set(r, [...(linked.get(r) ?? []), l.tenantId]);
      return { rows, linked };
    });
    const items = rows.map((r) => ({
      registry_project_id: r.registry_project_id,
      source: r.source,
      source_id: r.source_id,
      canonical_daoip5_id: r.canonical_daoip5_id,
      name: r.name,
      websites: r.websites ?? [],
      scf_awarded: r.scf_awarded,
      scf_awards: (Array.isArray(r.scf_awards) ? r.scf_awards : []).map(
        (a: Record<string, unknown>) => ({
          round: typeof a.round === "number" ? a.round : null,
          award_type: String(a.award_type ?? ""),
          amount_usd: typeof a.amount_usd === "number" ? a.amount_usd : null,
          status: String(a.status ?? ""),
        }),
      ),
      source_url: r.source_url,
      source_as_of: r.source_as_of,
      fetched_at: r.fetched_at.toISOString(),
      missing_since: r.missing_since?.toISOString() ?? null,
      linked_tenant_ids: (linked.get(r.registry_project_id) ?? []).sort(),
    }));
    return { status: 200, body: page(items, offset, limit, bind) };
  };

  const operatorTriggerRegistrySync: Handler = async (ctx) => {
    const body = await ctx.tx(async (tx) => {
      // A run that is still going is returned instead of queuing another (idempotent while it runs).
      const running = await tx.maybeOne<{ run_id: string; started_at: Date }>(
        `SELECT run_id::text AS run_id, started_at FROM scf.registry_sync_runs
          WHERE status = 'running' AND finished_at IS NULL AND started_at > now() - interval '1 hour'
          ORDER BY started_at DESC LIMIT 1`,
      );
      const run = running ?? { run_id: uuidv7(clock()), started_at: new Date(clock()) };
      await tx.audit({
        action: "registry.sync_requested",
        targetType: "registry_sync_run",
        targetId: run.run_id,
        details: { already_running: running !== undefined },
      });
      // The jobs service LISTENs on `scf_registry_sync` and runs registry_sync now; the payload is the run id.
      if (!running) await tx.query(`SELECT pg_notify('scf_registry_sync', $1)`, [run.run_id]);
      return { run_id: run.run_id, status: "running", started_at: run.started_at.toISOString() };
    });
    return { status: 202, body };
  };

  const operatorListErasureRequests: Handler = async (ctx) => {
    const q = ctx.query;
    const now = clock();
    const end = typeof q.end === "string" ? q.end : new Date(now).toISOString();
    const start =
      typeof q.start === "string" ? q.start : new Date(Date.parse(end) - 90 * DAY_MS).toISOString();
    if (
      !(Date.parse(end) > Date.parse(start)) ||
      Date.parse(end) - Date.parse(start) > 3660 * DAY_MS
    )
      throw new ApiError(
        "validation_failed",
        "end must be after start; range ≤ 3 660 days (C-86)",
        {
          errors: [{ pointer: "/end", detail: "end must be after start; range ≤ 3 660 days" }],
        },
      );
    const limit = Number(q.limit ?? 50);
    const status = (q.status as string[] | undefined) ?? null;
    const bind = `er:${start}:${end}:${q.tenant_id ?? ""}:${status?.join(",") ?? ""}`;
    const offset = decodeCursor(q.cursor, bind);
    const rows = await ctx.tx(async (tx) => {
      try {
        return await tx.query<Record<string, unknown>>(
          `SELECT tenant_id::text AS tenant_id, slug, request_id::text AS request_id, scope, site_id::text AS site_id,
                  service_id::text AS service_id, range_start, range_end, selector_type, status::text AS status,
                  created_at, previewed_at, confirmed_at, started_at, completed_at, finished_at, failure_code,
                  selector_redacted, counts
             FROM scf.op_erasure_requests($1, $2, $3::uuid, $4::scf.erasure_status[])`,
          [start, end, q.tenant_id ?? null, status],
        );
      } catch (err) {
        // 42883: the database lacks the function (migration 0058 not applied yet).
        if (pgCode(err) === "42883")
          throw new ApiError("unavailable", "the erasure list needs database migration 0058", {
            retryAfter: 3600,
          });
        opWriteError(err);
      }
    });
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
    const items = rows.map((r) => {
      const c = (r.counts ?? null) as Record<string, unknown> | null;
      const counts =
        c && Object.keys(c).length > 0
          ? Object.fromEntries(
              [
                "website_events",
                "event_data_rows",
                "sessions_orphaned",
                "breakdown_rows",
                "api_routes",
                "api_metric_rows",
              ]
                .filter((k) => typeof c[k] === "number")
                .map((k) => [k, c[k]]),
            )
          : null;
      return {
        tenant_id: r.tenant_id,
        slug: r.slug,
        request_id: r.request_id,
        scope: r.scope,
        site_id: r.site_id ?? null,
        service_id: r.service_id ?? null,
        start: (r.range_start as Date).toISOString().replace(/\.000Z$/, "Z"),
        end: (r.range_end as Date).toISOString().replace(/\.000Z$/, "Z"),
        selector_type: r.selector_type ?? null,
        selector_redacted: Boolean(r.selector_redacted),
        status: r.status,
        created_at: (r.created_at as Date).toISOString(),
        previewed_at: iso(r.previewed_at),
        confirmed_at: iso(r.confirmed_at),
        started_at: iso(r.started_at),
        completed_at: iso(r.completed_at),
        finished_at: iso(r.finished_at),
        failure_code: r.failure_code ?? null,
        counts,
      };
    });
    return { status: 200, body: page(items, offset, limit, bind) };
  };

  return {
    operatorListErasureRequests,
    operatorApproveTenantLevel,
    operatorDecideRegistryLink,
    operatorResolveDomainDispute,
    operatorSetSiteMultiplicityMode,
    operatorAnnotate,
    operatorCampaignComparison,
    operatorListRegistryProjects,
    operatorTriggerRegistrySync,
  };
}
