// SPDX-License-Identifier: Apache-2.0
// Tenant trust views (ADR-0028; data-model §8.10, §8.12; C-44, C-80): the advisory web trust scores written by job
// `trust_scoring`, period annotations (tenant authors; SCF operators annotate through `op_add_annotation`), and the
// daily on-chain counts of declared contracts written by job `onchain_correlation` (empty until it has run). All reads
// run under the tenant's own context; scores never delete or change data.

import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";

const DAY = 86_400_000;

/** Trust-score (wire-formats §h.4) and API-assurance (§h.5) reason codes an annotation may explain. */
export const EXPLAINABLE_CODES = new Set([
  "proof_coverage_low",
  "network_datacenter_share_high",
  "multiplicity_share_high",
  "engagement_low",
  "hidden_share_high",
  "duration_entropy_low",
  "mix_divergent_device",
  "mix_divergent_country",
  "night_share_high",
  "step_change",
  "burstiness_high",
  "pow_latency_implausible",
  "cross_signal_inconsistent",
  "insufficient_data",
  "a1_rate_implausible",
  "a1_status_mix_implausible",
  "a1_latency_implausible",
  "a1_route_profile_implausible",
  "a2_no_base_url",
  "a2_probe_failed",
  "a3_no_verified_contract",
  "a3_onchain_inconsistent",
  "a3_not_applicable",
  // reason codes of a sudden suspect share (C-80a) are explained against the volume itself
  "volume_spike",
]);

function bad(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

/** `start`/`end` of daily data: end after start, at most 3 660 days (C-86). */
export function dayRange(q: Record<string, unknown>, maxDays = 3660): { start: Date; end: Date } {
  const start = Date.parse(String(q.start));
  const end = Date.parse(String(q.end));
  if (!(end > start)) throw bad("/end", "end must be after start");
  if (end - start > maxDays * DAY) throw bad("/end", `the range is at most ${maxDays} days`);
  return { start: new Date(start), end: new Date(end) };
}

export interface AnnotationRow extends Record<string, unknown> {
  annotation_id: string;
  site_id: string | null;
  service_id: string | null;
  range_start: Date;
  range_end: Date;
  author_kind: "tenant" | "scf_operator";
  body: string;
  explains_reason_codes: string[];
  marks_explained: boolean;
  created_at: Date;
}

export const ANNOTATION_COLS = `annotation_id::text AS annotation_id, site_id::text AS site_id,
  service_id::text AS service_id, range_start, range_end, author_kind, body, explains_reason_codes, marks_explained,
  created_at`;

const z = (d: Date) => d.toISOString().replace(/\.000Z$/, "Z");

export function annotationView(r: AnnotationRow): Record<string, unknown> {
  return {
    annotation_id: r.annotation_id,
    site_id: r.site_id,
    service_id: r.service_id,
    start: z(r.range_start),
    end: z(r.range_end),
    author_kind: r.author_kind,
    body: r.body,
    explains_reason_codes: r.explains_reason_codes,
    marks_explained: r.marks_explained,
    created_at: r.created_at.toISOString(),
  };
}

export interface AnnotationInput {
  site_id?: string;
  service_id?: string;
  start: string;
  end: string;
  body: string;
  explains_reason_codes?: string[];
}

/** Checks shared by the tenant and the SCF-operator path: range (≤ 366 days, C-86) and known reason codes. */
export function checkAnnotation(b: AnnotationInput): void {
  const s = Date.parse(b.start);
  const e = Date.parse(b.end);
  if (!(e > s)) throw bad("/end", "end must be after start");
  if (e - s > 366 * DAY) throw bad("/end", "an annotation covers at most 366 days");
  (b.explains_reason_codes ?? []).forEach((c, i) => {
    if (!EXPLAINABLE_CODES.has(c)) throw bad(`/explains_reason_codes/${i}`, "unknown reason code");
  });
}

async function ownSite(tx: Tx, tenantId: string, siteId: string): Promise<void> {
  const s = await tx.maybeOne(`SELECT 1 FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`, [
    tenantId,
    siteId,
  ]);
  if (!s) throw new ApiError("not_found");
}

function component(v: unknown): Record<string, unknown> {
  const o = (v ?? {}) as Record<string, unknown>;
  const num = (x: unknown) =>
    x === null || x === undefined || Number.isNaN(Number(x)) ? null : Number(x);
  return {
    p: Math.min(1, Math.max(0, Number(o.p ?? 0))),
    value: num(o.value),
    eco_percentile: num(o.eco_percentile),
    ...(typeof o.explanation === "string" ? { explanation: o.explanation } : {}),
  };
}

export function trustHandlers(): Record<string, Handler> {
  const listSiteTrustScores: Handler = async (ctx) => {
    const tenantId = ctx.tenant?.id as string;
    const siteId = ctx.params.siteId as string;
    const body = await ctx.tx(async (tx) => {
      await ownSite(tx, tenantId, siteId); // a foreign or unknown site is the same 404 whatever the range (C-87)
      const { start, end } = dayRange(ctx.query);
      const rows = await tx.query<{
        day: string;
        window_days: number;
        score: number | null;
        components: Record<string, unknown>;
        reason_codes: string[];
        decision_rate: string | null;
        algorithm_version: string;
      }>(
        `SELECT day::text AS day, window_days, score, components, reason_codes, decision_rate::text AS decision_rate,
                algorithm_version
           FROM scf.web_trust_scores
          WHERE tenant_id = $1 AND site_id = $2
            AND day >= ($3::timestamptz AT TIME ZONE 'UTC')::date AND day < ($4::timestamptz AT TIME ZONE 'UTC')::date
          ORDER BY day, window_days`,
        [tenantId, siteId, start, end],
      );
      return rows.map((r) => ({
        site_id: siteId,
        day: r.day,
        window_days: Number(r.window_days),
        score: r.score === null ? null : Number(r.score),
        components: Object.fromEntries(
          Object.entries(r.components ?? {}).map(([k, v]) => [k, component(v)]),
        ),
        reason_codes: r.reason_codes,
        decision_rate: r.decision_rate === null ? null : Number(r.decision_rate),
        algorithm_version: r.algorithm_version,
      }));
    });
    return { status: 200, body };
  };

  const listAnnotations: Handler = async (ctx) => {
    const rows = await ctx.tx((tx) =>
      tx.query<AnnotationRow>(
        `SELECT ${ANNOTATION_COLS} FROM scf.trust_annotations WHERE tenant_id = $1
          ORDER BY range_start DESC, created_at DESC, annotation_id`,
        [ctx.tenant?.id],
      ),
    );
    return { status: 200, body: rows.map(annotationView) };
  };

  const createAnnotation: Handler = async (ctx) => {
    const b = ctx.body as AnnotationInput;
    const tenantId = ctx.tenant?.id as string;
    const row = await ctx.tx(async (tx) => {
      // Body identifiers are resolved under the caller's tenant first (C-87): another tenant's id is 404.
      if (b.site_id) await ownSite(tx, tenantId, b.site_id);
      if (b.service_id) {
        const s = await tx.maybeOne(
          `SELECT 1 FROM scf.api_services WHERE tenant_id = $1 AND service_id = $2`,
          [tenantId, b.service_id],
        );
        if (!s) throw new ApiError("not_found");
      }
      checkAnnotation(b);
      await tx.audit({
        action: "trust.annotation.created",
        targetType: "annotation",
        details: { site: b.site_id ?? null, service: b.service_id ?? null },
      });
      return tx.one<AnnotationRow>(
        `INSERT INTO scf.trust_annotations (tenant_id, site_id, service_id, range_start, range_end, author_kind,
                                            author_user_id, body, explains_reason_codes)
         VALUES ($1, $2, $3, $4, $5, 'tenant', $6, $7, $8) RETURNING ${ANNOTATION_COLS}`,
        [
          tenantId,
          b.site_id ?? null,
          b.service_id ?? null,
          b.start,
          b.end,
          ctx.session?.userId,
          b.body,
          [...new Set(b.explains_reason_codes ?? [])],
        ],
      );
    });
    return { status: 201, body: annotationView(row) };
  };

  const getOnchainDaily: Handler = async (ctx) => {
    const { start, end } = dayRange(ctx.query);
    const rows = await ctx.tx((tx) =>
      tx.query<{
        contract_id: string;
        network: string;
        status: "declared" | "verified";
        day: string;
        invocations: string;
        successful_invocations: string;
        distinct_invokers: string;
      }>(
        `SELECT c.contract_id, c.network, c.status, o.day::text AS day, o.invocations::text AS invocations,
                o.successful_invocations::text AS successful_invocations, o.distinct_invokers::text AS distinct_invokers
           FROM scf.onchain_daily o
           JOIN scf.declared_contracts c ON c.tenant_id = o.tenant_id AND c.contract_ref = o.contract_ref
          WHERE o.tenant_id = $1
            AND o.day >= ($2::timestamptz AT TIME ZONE 'UTC')::date AND o.day < ($3::timestamptz AT TIME ZONE 'UTC')::date
          ORDER BY o.day, c.network, c.contract_id`,
        [ctx.tenant?.id, start, end],
      ),
    );
    // Public ledger counts, exact (C-95); empty until job onchain_correlation has run for this tenant.
    return {
      status: 200,
      body: rows.map((r) => ({
        contract_id: r.contract_id,
        network: r.network,
        contract_status: r.status,
        day: r.day,
        invocations: Number(r.invocations),
        successful_invocations: Number(r.successful_invocations),
        distinct_invokers: Number(r.distinct_invokers),
      })),
    };
  };

  return { listSiteTrustScores, listAnnotations, createAnnotation, getOnchainDaily };
}
