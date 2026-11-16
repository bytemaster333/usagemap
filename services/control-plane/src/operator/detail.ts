// SPDX-License-Identifier: Apache-2.0
// `operatorGetTenant`: maps the jsonb of `scf.op_tenant_detail(p_tenant)` (data-model §11; the only cross-tenant read
// of a tenant's configuration, audited `operator.read.op_tenant_detail`) to `OperatorTenantDetail`.
//
// Mapping (op_tenant_detail key → OperatorTenantDetail):
//   tenant (to_jsonb(tenants) − status_changed_by) + verification_level → `tenant` (Tenant): tenant_id, slug, name,
//       description, status, status_reason, created_at, removed_at, purge_after, onchain_correlation_enabled,
//       public_stats_enabled; `verification_level` = "L" ‖ level; `quotas` from settings exactly as the tenant's own
//       view (L0: l0_max_sites, l0_max_services, l0_events_per_day, l0_routes_per_day; otherwise max_services_per_tenant,
//       l1_events_per_day). is_canary, created_by, status_changed_at, purged_at are not part of Tenant and are dropped.
//   members → `members` (Member): user_id, display_name, role, added_at.
//   sites (to_jsonb(sites) − Umami website ids + effective_event_retention_days) + domains → `sites` (Site):
//       site_id, site_key, name, tracker_profile, visitor_id, visitor_id_off_countries, exclude_countries,
//       anonymous_reports, path_folding, event_retention_days, opt_out_page_url, status, created_at,
//       effective_event_retention_days; `domains` = the tenant's `domains` rows with that site_id (Domain fields);
//       `limits.rate_limit_per_min` / `limits.daily_quota` from settings and the verification level exactly as the
//       edge snapshot computes them (C-90); `limits.verified_events_today` is the site's quota counter for the current
//       UTC day, which op_tenant_detail exposes per site since migration 0054 (C-119). visitor_id_explicit, the Umami ids and
//       internal columns are dropped.
//   services → `services` (Service): service_id, service_name, display_name, declared_base_url, read_only_api,
//       rpc_method_dimension, registration, status, registered_at (stream groups are not exposed by the function).
//   evidence → `evidence` (Evidence): evidence_id, kind, subject, status, verified_at, last_checked_at, details.
//   registry_links → `registry_links` (RegistryLink): registry_project_id, match_basis, status from the link; name,
//       source, scf_awarded, source_as_of from the global table `registry_projects` (public registry data, readable).
//   ingest_tokens (− secret_hash) → `ingest_tokens` (IngestToken): token_id, display (`scfa_ing_<id>_…<last4>`),
//       label, allowed_service_names, created_at, expires_at, last_used_at, revoked_at, rotation_reminder (> 12 months).
//   annotations → `annotations` (Annotation): annotation_id, site_id, service_id, start/end (= range_start/range_end
//       as midnight UTC), author_kind, body, explains_reason_codes, marks_explained, created_at.
//   erasure_requests (no selectors) has no field in OperatorTenantDetail and is not returned.

import type { Tx } from "../db/database.ts";
import { displayOf } from "../keys/keys.ts";

type J = Record<string, unknown>;

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(String(v)).toISOString();
const isoReq = (v: unknown): string => new Date(String(v)).toISOString();
const midnight = (v: unknown): string =>
  `${new Date(String(v)).toISOString().slice(0, 10)}T00:00:00Z`;
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);

async function ints(tx: Tx, keys: string[]): Promise<Record<string, number>> {
  const rows = await tx.query<{ key: string; v: number }>(
    `SELECT key, (value #>> '{}')::int AS v FROM scf.settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.v)]));
}

export async function tenantDetailView(tx: Tx, d: J, now: number): Promise<J> {
  const t = (d.tenant ?? {}) as J;
  const level = Number(d.verification_level ?? 0);
  const l0 = level === 0;
  const s = await ints(tx, [
    "l0_max_sites",
    "l0_max_services",
    "l0_events_per_day",
    "l0_routes_per_day",
    "l1_events_per_day",
    "max_services_per_tenant",
    "web_requests_per_min_site",
    "l0_web_requests_per_min_site",
    "web_event_retention_days",
  ]);
  const quotas = l0
    ? {
        max_sites: s.l0_max_sites,
        max_services: s.l0_max_services,
        web_events_per_day: s.l0_events_per_day,
        routes_per_day: s.l0_routes_per_day,
      }
    : { max_services: s.max_services_per_tenant, web_events_per_day: s.l1_events_per_day };
  const tenant: J = {
    tenant_id: t.tenant_id,
    slug: t.slug,
    name: t.name,
    description: t.description ?? null,
    status: t.status,
    status_reason: t.status_reason ?? null,
    removal_reason_code: t.removal_reason_code ?? null,
    verification_level: `L${level}`,
    created_at: isoReq(t.created_at),
    removed_at: iso(t.removed_at),
    purge_after: iso(t.purge_after),
    onchain_correlation_enabled: Boolean(t.onchain_correlation_enabled),
    public_stats_enabled: Boolean(t.public_stats_enabled),
    quotas: Object.fromEntries(Object.entries(quotas).filter(([, v]) => typeof v === "number")),
  };
  const domains = arr(d.domains);
  const dailyQuota = (l0 ? s.l0_events_per_day : s.l1_events_per_day) ?? null;
  const sites = arr(d.sites).map((x) => ({
    site_id: x.site_id,
    site_key: x.site_key,
    name: x.name,
    tracker_profile: x.tracker_profile,
    visitor_id: x.visitor_id,
    visitor_id_off_countries: arr(x.visitor_id_off_countries),
    exclude_countries: arr(x.exclude_countries),
    anonymous_reports: Boolean(x.anonymous_reports),
    path_folding: x.path_folding,
    event_retention_days: x.event_retention_days ?? null,
    opt_out_page_url: x.opt_out_page_url ?? null,
    multiplicity_mode: x.multiplicity_mode ?? null,
    status: x.status,
    limits: {
      rate_limit_per_min:
        (l0 ? s.l0_web_requests_per_min_site : s.web_requests_per_min_site) ?? 600,
      daily_quota: dailyQuota,
      verified_events_today: Number(x.verified_events_today ?? 0),
    },
    created_at: isoReq(x.created_at),
    effective_event_retention_days: Number(
      x.effective_event_retention_days ??
        Math.min(Number(x.event_retention_days ?? 395), s.web_event_retention_days ?? 90),
    ),
    domains: domains
      .filter((m) => m.site_id === x.site_id)
      .map((m) => ({
        domain_id: m.domain_id,
        host: m.host,
        include_subdomains: Boolean(m.include_subdomains),
        state: m.state,
        verified_at: iso(m.verified_at),
        grace_until: iso(m.grace_until),
        created_at: isoReq(m.created_at),
      })),
  }));
  const links = arr(d.registry_links);
  const projects = links.length
    ? await tx.query<{
        registry_project_id: string;
        source: string;
        name: string;
        scf_awarded: boolean | null;
        source_as_of: string | null;
        source_url: string | null;
        award_round: number | null;
        award_stage: string | null;
        scf_categories: string[] | null;
      }>(
        `SELECT registry_project_id::text AS registry_project_id, source, name, scf_awarded,
                source_as_of::text AS source_as_of, source_url, award_round, award_stage, scf_categories
           FROM scf.registry_projects WHERE registry_project_id = ANY($1::uuid[])`,
        [links.map((l) => l.registry_project_id)],
      )
    : [];
  const byId = new Map(projects.map((p) => [p.registry_project_id, p]));
  const year = 365 * 86_400_000;
  return {
    tenant,
    members: arr(d.members).map((m) => ({
      user_id: m.user_id,
      display_name: m.display_name ?? null,
      role: m.role,
      added_at: isoReq(m.added_at),
    })),
    sites,
    services: arr(d.services).map((x) => ({
      service_id: x.service_id,
      service_name: x.service_name,
      display_name: x.display_name ?? null,
      declared_base_url: x.declared_base_url ?? null,
      read_only_api: Boolean(x.read_only_api),
      rpc_method_dimension: Boolean(x.rpc_method_dimension),
      registration: x.registration,
      status: x.status,
      registered_at: isoReq(x.registered_at),
    })),
    evidence: arr(d.evidence).map((e) => ({
      evidence_id: e.evidence_id,
      kind: e.kind,
      subject: e.subject,
      status: e.status,
      verified_at: isoReq(e.verified_at),
      last_checked_at: iso(e.last_checked_at),
      details: (e.details as J | null) ?? {},
    })),
    registry_links: links
      .filter((l) => byId.has(String(l.registry_project_id)))
      .map((l) => {
        const p = byId.get(String(l.registry_project_id));
        return {
          registry_project_id: l.registry_project_id,
          source: p?.source,
          name: p?.name,
          scf_awarded: p?.scf_awarded ?? null,
          source_as_of: p?.source_as_of ?? null,
          // K1: the operator view adds the source page, the award round and stage, and the SCF categories
          source_url: p?.source_url ?? null,
          award_round: p?.award_round ?? null,
          award_stage: p?.award_stage ?? null,
          categories: p?.scf_categories ?? [],
          match_basis: arr(l.match_basis),
          status: l.status,
        };
      }),
    ingest_tokens: arr(d.ingest_tokens).map((k) => ({
      token_id: k.token_id,
      display: displayOf("ing", String(k.token_id), String(k.last4)),
      label: k.label,
      allowed_service_names: (k.allowed_service_names as string[] | null) ?? null,
      created_at: isoReq(k.created_at),
      expires_at: iso(k.expires_at),
      last_used_at: iso(k.last_used_at),
      revoked_at: iso(k.revoked_at),
      rotation_reminder: k.revoked_at == null && now - Date.parse(String(k.created_at)) > year,
    })),
    annotations: arr(d.annotations).map((a) => ({
      annotation_id: a.annotation_id,
      site_id: a.site_id ?? null,
      service_id: a.service_id ?? null,
      start: midnight(a.range_start),
      end: midnight(a.range_end),
      author_kind: a.author_kind,
      body: a.body,
      explains_reason_codes: arr(a.explains_reason_codes),
      marks_explained: Boolean(a.marks_explained),
      created_at: isoReq(a.created_at),
    })),
  };
}
