// SPDX-License-Identifier: Apache-2.0
// API services and declared contracts (data-model §8.6; C-19, C-21, C-22, C-87). Every read and write runs under the
// tenant's context (scf_app, RLS); identifiers in the body are resolved under that context, so a foreign or unknown id
// is the same 404 as a missing one (C-87).

import type { Tx } from "../db/database.ts";
import { pgCode } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";

export function badField(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

/** The pattern the database enforces on `declared_base_url` (data-model §8.6). */
const BASE_URL_RE = /^https:\/\/[^/?#\s]+(\/[^?#\s]*)?$/;

interface ServiceRow extends Record<string, unknown> {
  service_id: string;
  service_name: string;
  display_name: string | null;
  declared_base_url: string | null;
  read_only_api: boolean;
  rpc_method_dimension: boolean;
  registration: "portal" | "auto";
  status: "active" | "archived";
  registered_at: Date;
  slo_target_pct: number;
}

const SERVICE_COLS = `service_id::text AS service_id, service_name, display_name, declared_base_url, read_only_api,
  rpc_method_dimension, registration, status, registered_at, slo_target_pct::float8 AS slo_target_pct`;

/** Stream groups of the services (C-22): each with whether it is today's preferred group. */
async function streamGroups(
  tx: Tx,
  tenantId: string,
  serviceIds: string[],
): Promise<Map<string, { groups: Record<string, unknown>[]; multiple: boolean }>> {
  const out = new Map<string, { groups: Record<string, unknown>[]; multiple: boolean }>();
  if (serviceIds.length === 0) return out;
  const rows = await tx.query<{
    service_id: string;
    kind: string;
    metric_name: string;
    scope_name: string;
    preferred_today: boolean;
    recent: boolean;
  }>(
    `SELECT g.service_id::text AS service_id, g.kind::text AS kind, g.metric_name, g.scope_name,
            COALESCE(g.group_id = (SELECT d.stream_group_id FROM scf.api_service_day_groups d
                                     JOIN scf.api_stream_groups g2
                                       ON g2.tenant_id = d.tenant_id AND g2.group_id = d.stream_group_id
                                    WHERE d.tenant_id = g.tenant_id AND d.service_id = g.service_id
                                      AND d.day = (now() AT TIME ZONE 'UTC')::date
                                    ORDER BY g2.rank_key, g2.group_id LIMIT 1), false) AS preferred_today,
            EXISTS (SELECT 1 FROM scf.api_service_day_groups d
                     WHERE d.tenant_id = g.tenant_id AND d.service_id = g.service_id AND d.stream_group_id = g.group_id
                       AND d.day >= (now() AT TIME ZONE 'UTC')::date - 6) AS recent
       FROM scf.api_stream_groups g
      WHERE g.tenant_id = $1 AND g.service_id = ANY ($2::uuid[])
      ORDER BY g.rank_key, g.group_id`,
    [tenantId, serviceIds],
  );
  for (const r of rows) {
    const e = out.get(r.service_id) ?? { groups: [], multiple: false };
    e.groups.push({
      kind: r.kind,
      metric_name: r.metric_name,
      scope_name: r.scope_name,
      preferred_today: r.preferred_today,
    });
    out.set(r.service_id, e);
  }
  // C-22: more than one group reported within the last 7 days → the portal shows a warning.
  const recent = new Map<string, number>();
  for (const r of rows) if (r.recent) recent.set(r.service_id, (recent.get(r.service_id) ?? 0) + 1);
  for (const [id, n] of recent) {
    const e = out.get(id);
    if (e) e.multiple = n > 1;
  }
  return out;
}

function serviceView(
  r: ServiceRow,
  g: { groups: Record<string, unknown>[]; multiple: boolean } | undefined,
): Record<string, unknown> {
  return {
    service_id: r.service_id,
    service_name: r.service_name,
    display_name: r.display_name,
    declared_base_url: r.declared_base_url,
    read_only_api: r.read_only_api,
    rpc_method_dimension: r.rpc_method_dimension,
    registration: r.registration,
    status: r.status,
    registered_at: r.registered_at.toISOString(),
    stream_groups: g?.groups ?? [],
    multiple_groups_warning: g?.multiple ?? false,
    slo_target_pct: r.slo_target_pct,
  };
}

export async function loadService(
  tx: Tx,
  tenantId: string,
  serviceId: string,
): Promise<ServiceRow> {
  const r = await tx.maybeOne<ServiceRow>(
    `SELECT ${SERVICE_COLS} FROM scf.api_services WHERE tenant_id = $1 AND service_id = $2`,
    [tenantId, serviceId],
  );
  if (!r) throw new ApiError("not_found");
  return r;
}

async function serviceBody(tx: Tx, tenantId: string, serviceId: string) {
  const r = await loadService(tx, tenantId, serviceId);
  return serviceView(r, (await streamGroups(tx, tenantId, [serviceId])).get(serviceId));
}

/** A removed tenant's data is hidden from every view (C-08). */
export function visibleTenant(ctx: RequestContext): string {
  if (ctx.tenant?.status === "removed") throw new ApiError("not_found");
  return ctx.params.tenantId as string;
}

export function serviceHandlers(): Record<string, Handler> {
  const listServices: Handler = async (ctx) => {
    const tenantId = visibleTenant(ctx);
    const body = await ctx.tx(async (tx) => {
      const rows = await tx.query<ServiceRow>(
        `SELECT ${SERVICE_COLS} FROM scf.api_services WHERE tenant_id = $1 ORDER BY registered_at, service_id`,
        [tenantId],
      );
      const g = await streamGroups(
        tx,
        tenantId,
        rows.map((r) => r.service_id),
      );
      return rows.map((r) => serviceView(r, g.get(r.service_id)));
    });
    return { status: 200, body };
  };

  const getService: Handler = async (ctx) => {
    const tenantId = visibleTenant(ctx);
    return {
      status: 200,
      body: await ctx.tx((tx) => serviceBody(tx, tenantId, ctx.params.serviceId as string)),
    };
  };

  const createService: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const b = ctx.body as {
      service_name: string;
      display_name?: string;
      declared_base_url?: string;
      read_only_api?: boolean;
      rpc_method_dimension?: boolean;
    };
    if (b.declared_base_url !== undefined && !BASE_URL_RE.test(b.declared_base_url))
      throw badField("/declared_base_url", "must be an https URL without query or fragment");
    const body = await ctx.tx(async (tx) => {
      // The writer's per-tenant lock (services/metrics-writer): portal and auto-registration share one quota (C-21).
      await tx.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scf-writer:' || $1::text, 0))`,
        [tenantId],
      );
      const q = await tx.one<{ level: number; n: number; l0: number; max: number }>(
        `SELECT scf.verification_level($1) AS level,
                (SELECT count(*)::int FROM scf.api_services WHERE tenant_id = $1) AS n,
                scf.setting_int('l0_max_services') AS l0, scf.setting_int('max_services_per_tenant') AS max`,
        [tenantId],
      );
      const cap = Number(q.level) === 0 ? Number(q.l0) : Number(q.max);
      if (Number(q.n) >= cap)
        throw new ApiError(
          "quota_exceeded",
          `service limit reached (${cap} at L${Number(q.level) === 0 ? 0 : "1+"})`,
        );
      let id: string;
      try {
        id = (
          await tx.one<{ id: string }>(
            `INSERT INTO scf.api_services (tenant_id, service_name, display_name, declared_base_url, read_only_api,
                                           rpc_method_dimension, registration, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, 'portal', $7) RETURNING service_id::text AS id`,
            [
              tenantId,
              b.service_name,
              b.display_name ?? null,
              b.declared_base_url ?? null,
              b.read_only_api ?? false,
              b.rpc_method_dimension ?? false,
              ctx.session?.userId,
            ],
          )
        ).id;
      } catch (err) {
        if (pgCode(err) === "23505")
          throw new ApiError("conflict", "a service with this service_name exists");
        throw err;
      }
      await tx.audit({
        action: "service.created",
        targetType: "api_service",
        targetId: id,
        details: { registration: "portal" },
      });
      // The edge snapshot carries nothing per service; the writer looks services up itself.
      return serviceBody(tx, tenantId, id);
    });
    return { status: 201, body };
  };

  const updateService: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const serviceId = ctx.params.serviceId as string;
    const b = ctx.body as {
      display_name?: string | null;
      declared_base_url?: string | null;
      read_only_api?: boolean;
      rpc_method_dimension?: boolean;
      status?: "active" | "archived";
      slo_target_pct?: number;
    };
    if (
      b.slo_target_pct !== undefined &&
      Math.abs(b.slo_target_pct * 1000 - Math.round(b.slo_target_pct * 1000)) > 1e-6
    )
      throw badField("/slo_target_pct", "at most three decimals");
    if (
      b.declared_base_url !== undefined &&
      b.declared_base_url !== null &&
      (!BASE_URL_RE.test(b.declared_base_url) || b.declared_base_url.length > 2048)
    )
      throw badField("/declared_base_url", "must be an https URL without query or fragment");
    const body = await ctx.tx(async (tx) => {
      const cur = await tx.maybeOne<ServiceRow>(
        `SELECT ${SERVICE_COLS} FROM scf.api_services WHERE tenant_id = $1 AND service_id = $2 FOR UPDATE`,
        [tenantId, serviceId],
      );
      if (!cur) throw new ApiError("not_found");
      const status = b.status ?? cur.status;
      await tx.query(
        `UPDATE scf.api_services
            SET display_name = $3, declared_base_url = $4, read_only_api = $5, rpc_method_dimension = $6,
                status = $7,
                archived_at = CASE WHEN $7 = 'archived' THEN COALESCE(archived_at, now()) END,
                slo_target_pct = $8
          WHERE tenant_id = $1 AND service_id = $2`,
        [
          tenantId,
          serviceId,
          "display_name" in b ? (b.display_name ?? null) : cur.display_name,
          "declared_base_url" in b ? (b.declared_base_url ?? null) : cur.declared_base_url,
          b.read_only_api ?? cur.read_only_api,
          b.rpc_method_dimension ?? cur.rpc_method_dimension,
          status,
          b.slo_target_pct ?? cur.slo_target_pct,
        ],
      );
      await tx.audit({
        action:
          status === "archived" && cur.status !== "archived"
            ? "service.archived"
            : "service.updated",
        targetType: "api_service",
        targetId: serviceId,
        details: { fields: Object.keys(b).sort() },
      });
      return serviceBody(tx, tenantId, serviceId);
    });
    return { status: 200, body };
  };

  return { listServices, getService, createService, updateService };
}

// ------------------------------------------------------------------------------------------------ contracts

interface ContractRow extends Record<string, unknown> {
  contract_ref: string;
  contract_id: string;
  network: "public" | "testnet";
  label: string | null;
  service_id: string | null;
  status: "declared" | "verified" | "rejected";
  verified_role: "deployer" | "admin" | null;
  rejected_reason: string | null;
  created_at: Date;
}

const CONTRACT_COLS = `contract_ref::text AS contract_ref, contract_id, network, label, service_id::text AS service_id,
  status, verified_role, rejected_reason, created_at`;

function contractView(r: ContractRow): Record<string, unknown> {
  return {
    contract_ref: r.contract_ref,
    contract_id: r.contract_id,
    network: r.network,
    label: r.label,
    service_id: r.service_id,
    status: r.status,
    verified_role: r.verified_role,
    rejected_reason: r.rejected_reason,
    created_at: r.created_at.toISOString(),
  };
}

export interface ContractInput {
  contract_id: string;
  network: "public" | "testnet";
  label?: string;
  service_id?: string;
}

/**
 * Declares a contract (declareContract and addFootprintItem with kind `contract`, C-136): 409 while it is declared;
 * declared again after removal, the old row comes back as a new declaration and any earlier verification, rejection
 * or conflict flag is dropped and re-checked (C-19, C-137) — except an SCF operator's `claimed_by_other_tenant`
 * rejection, which stays. Returns the contract_ref; the caller audits.
 */
export async function declareContractRow(
  tx: Tx,
  tenantId: string,
  userId: string | undefined,
  b: ContractInput,
): Promise<string> {
  if (b.service_id !== undefined) await loadService(tx, tenantId, b.service_id); // C-87: 404 if not ours
  const existing = await tx.maybeOne<{
    contract_ref: string;
    removed: boolean;
    operator_rejected: boolean;
  }>(
    `SELECT contract_ref::text AS contract_ref, removed_at IS NOT NULL AS removed,
            (status = 'rejected' AND rejected_reason = 'claimed_by_other_tenant') AS operator_rejected
       FROM scf.declared_contracts
      WHERE tenant_id = $1 AND contract_id = $2 AND network = $3 FOR UPDATE`,
    [tenantId, b.contract_id, b.network],
  );
  if (existing && !existing.removed)
    throw new ApiError("conflict", "this contract is already declared");
  if (existing?.operator_rejected) {
    // C-137 (5): an SCF operator's `claimed_by_other_tenant` rejection is a decision about the contract, not
    // about one declaration of it. Declared again, the row comes back still rejected (never re-checked), so removing
    // and re-adding cannot put the rightful tenant's contract back into conflict. Only the declaration's own fields
    // change.
    await tx.query(
      `UPDATE scf.declared_contracts
          SET removed_at = NULL, label = $3, service_id = $4, created_by = $5, created_at = now(), next_check_at = NULL
        WHERE tenant_id = $1 AND contract_ref = $2`,
      [tenantId, existing.contract_ref, b.label ?? null, b.service_id ?? null, userId],
    );
    return existing.contract_ref;
  }
  if (existing) {
    await tx.query(
      `UPDATE scf.declared_contracts
          SET removed_at = NULL, label = $3, service_id = $4, status = 'declared', verified_role = NULL,
              verified_by_evidence = NULL, verified_at = NULL, last_checked_at = NULL, created_by = $5,
              created_at = now(), verification_method = NULL, rejected_reason = NULL, next_check_at = NULL,
              conflict_since = NULL
        WHERE tenant_id = $1 AND contract_ref = $2`,
      [tenantId, existing.contract_ref, b.label ?? null, b.service_id ?? null, userId],
    );
    return existing.contract_ref;
  }
  return (
    await tx.one<{ ref: string }>(
      `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, label, service_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING contract_ref::text AS ref`,
      [tenantId, b.contract_id, b.network, b.label ?? null, b.service_id ?? null, userId],
    )
  ).ref;
}

export function contractHandlers(): Record<string, Handler> {
  const listContracts: Handler = async (ctx) => {
    const tenantId = visibleTenant(ctx);
    const rows = await ctx.tx((tx) =>
      tx.query<ContractRow>(
        `SELECT ${CONTRACT_COLS} FROM scf.declared_contracts
          WHERE tenant_id = $1 AND removed_at IS NULL ORDER BY created_at, contract_ref`,
        [tenantId],
      ),
    );
    return { status: 200, body: rows.map(contractView) };
  };

  const declareContract: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const b = ctx.body as ContractInput;
    const body = await ctx.tx(async (tx) => {
      const ref = await declareContractRow(tx, tenantId, ctx.session?.userId, b);
      await tx.audit({
        action: "verification.contract_declared",
        targetType: "declared_contract",
        targetId: ref,
        details: { network: b.network, with_service: b.service_id !== undefined },
      });
      return contractView(
        await tx.one<ContractRow>(
          `SELECT ${CONTRACT_COLS} FROM scf.declared_contracts WHERE tenant_id = $1 AND contract_ref = $2`,
          [tenantId, ref],
        ),
      );
    });
    return { status: 201, body };
  };

  const removeContract: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const ref = ctx.params.contractRef as string;
    await ctx.tx(async (tx) => {
      const r = await tx.query(
        `UPDATE scf.declared_contracts SET removed_at = now()
          WHERE tenant_id = $1 AND contract_ref = $2 AND removed_at IS NULL RETURNING contract_ref`,
        [tenantId, ref],
      );
      if (r.length === 0) throw new ApiError("not_found");
      await tx.audit({
        action: "verification.contract_removed",
        targetType: "declared_contract",
        targetId: ref,
      });
    });
    return { status: 204 };
  };

  return { listContracts, declareContract, removeContract };
}
