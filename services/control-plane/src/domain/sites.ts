// SPDX-License-Identifier: Apache-2.0
// Sites and their declared domains (data-model §8.4; C-02, C-19, C-51, C-52, C-53, C-58, C-73, C-90). A site maps to
// one Umami website for identified events and, once it needs one, a twin website for unidentified events; both ids are
// assigned here and provisioned by the `umami_reconcile` job (NOTIFY scf_umami). Every change that the edge must see
// sends NOTIFY scf_edge (the snapshot builder reacts within seconds; it also rebuilds every 10 s).

import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { newSiteKey } from "../util/ids.ts";
import { releaseClaim } from "../verify/claims.ts";
import { assertDevOrigins } from "./dev-origins.ts";
import { settingInts } from "./tenants.ts";

type VisitorId = "on" | "off" | "off_in";
type Profile = "standard" | "strict";

interface SiteRow extends Record<string, unknown> {
  site_id: string;
  site_key: string;
  name: string;
  tracker_profile: Profile;
  visitor_id: VisitorId;
  visitor_id_off_countries: string[];
  visitor_id_explicit: boolean;
  exclude_countries: string[];
  anonymous_reports: boolean;
  path_folding: "full" | "relaxed";
  event_retention_days: number | null;
  opt_out_page_url: string | null;
  status: "active" | "archived" | "purging";
  created_at: Date;
  umami_twin_website_id: string | null;
  multiplicity_mode: "enforce" | "shadow" | null;
  dev_origins: string[];
  /** debug_until while it is in the future, else null (off) */
  debug_until: Date | null;
}

interface DomainRow extends Record<string, unknown> {
  domain_id: string;
  site_id: string;
  host: string;
  include_subdomains: boolean;
  state: string;
  verified_at: Date | null;
  grace_until: Date | null;
  created_at: Date;
}

const SITE_COLUMNS = `site_id, site_key, name, tracker_profile::text AS tracker_profile, visitor_id,
  visitor_id_off_countries::text[] AS visitor_id_off_countries, visitor_id_explicit,
  exclude_countries::text[] AS exclude_countries, anonymous_reports, path_folding, event_retention_days, opt_out_page_url,
  status, created_at, umami_twin_website_id, multiplicity_mode, dev_origins,
  CASE WHEN debug_until > now() THEN debug_until END AS debug_until`;

function domainView(d: DomainRow): Record<string, unknown> {
  return {
    domain_id: d.domain_id,
    host: d.host,
    include_subdomains: d.include_subdomains,
    state: d.state,
    verified_at: d.verified_at?.toISOString() ?? null,
    grace_until: d.grace_until?.toISOString() ?? null,
    created_at: d.created_at.toISOString(),
  };
}

/** Site views for one tenant (all sites, or the listed ones), with limits computed as the edge snapshot does (C-90). */
async function siteViews(
  tx: Tx,
  tenantId: string,
  siteIds?: string[],
): Promise<Record<string, unknown>[]> {
  const sites = await tx.query<SiteRow>(
    `SELECT ${SITE_COLUMNS} FROM scf.sites WHERE tenant_id = $1 AND ($2::uuid[] IS NULL OR site_id = ANY($2::uuid[]))
      ORDER BY created_at, site_id`,
    [tenantId, siteIds ?? null],
  );
  if (sites.length === 0) return [];
  const domains = await tx.query<DomainRow>(
    `SELECT domain_id, site_id, host, include_subdomains, state, verified_at, grace_until, created_at
       FROM scf.site_domains WHERE tenant_id = $1 AND site_id = ANY($2::uuid[]) ORDER BY created_at, domain_id`,
    [tenantId, sites.map((s) => s.site_id)],
  );
  const counts = await tx.query<{ site_id: string; n: string }>(
    `SELECT site_id, sum(count)::text AS n FROM scf.web_edge_counters
      WHERE tenant_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date AND counter = 'verdict' AND label = 'verified'
      GROUP BY site_id`,
    [tenantId],
  );
  const lvl = await tx.one<{ level: number }>(`SELECT scf.verification_level($1) AS level`, [
    tenantId,
  ]);
  const s = await settingInts(tx, [
    "web_requests_per_min_site",
    "l0_web_requests_per_min_site",
    "l0_events_per_day",
    "l1_events_per_day",
    "web_event_retention_days",
  ]);
  const l0 = Number(lvl.level) === 0;
  const dailyQuota = (l0 ? s.l0_events_per_day : s.l1_events_per_day) ?? null;
  const perSite = new Map(counts.map((c) => [c.site_id, Number(c.n)]));
  const tenantVerified = [...perSite.values()].reduce((a, b) => a + b, 0);
  const platformRetention = s.web_event_retention_days ?? 90;
  return sites.map((site) => {
    const status =
      site.status === "active" && dailyQuota !== null && tenantVerified >= dailyQuota
        ? "over_quota"
        : site.status;
    const view: Record<string, unknown> = {
      site_id: site.site_id,
      site_key: site.site_key,
      name: site.name,
      tracker_profile: site.tracker_profile,
      visitor_id: site.visitor_id,
      visitor_id_off_countries: site.visitor_id_off_countries,
      exclude_countries: site.exclude_countries,
      anonymous_reports: site.anonymous_reports,
      path_folding: site.path_folding,
      event_retention_days: site.event_retention_days,
      opt_out_page_url: site.opt_out_page_url,
      // C-124: read-only here; set by an SCF operator (operatorSetSiteMultiplicityMode)
      multiplicity_mode: site.multiplicity_mode,
      // C-136, wire-formats §a.8
      dev_origins: site.dev_origins,
      debug_until: site.debug_until?.toISOString() ?? null,
      status,
      limits: {
        rate_limit_per_min:
          (l0 ? s.l0_web_requests_per_min_site : s.web_requests_per_min_site) ?? 600,
        daily_quota: dailyQuota,
        verified_events_today: perSite.get(site.site_id) ?? 0,
      },
      created_at: site.created_at.toISOString(),
      effective_event_retention_days: Math.min(site.event_retention_days ?? 395, platformRetention),
      domains: domains.filter((d) => d.site_id === site.site_id).map(domainView),
    };
    return view;
  });
}

async function siteView(
  tx: Tx,
  tenantId: string,
  siteId: string,
): Promise<Record<string, unknown>> {
  const [v] = await siteViews(tx, tenantId, [siteId]);
  if (!v) throw new ApiError("not_found");
  return v;
}

/** Locks the site row; 404 for a foreign or unknown id (C-87). */
async function lockSite(tx: Tx, tenantId: string, siteId: string): Promise<SiteRow> {
  const site = await tx.maybeOne<SiteRow>(
    `SELECT ${SITE_COLUMNS} FROM scf.sites WHERE tenant_id = $1 AND site_id = $2 FOR UPDATE`,
    [tenantId, siteId],
  );
  if (!site) throw new ApiError("not_found");
  return site;
}

function badField(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", undefined, { errors: [{ pointer, detail }] });
}

async function checkRetention(tx: Tx, days: number | null | undefined): Promise<void> {
  if (days === null || days === undefined) return;
  const s = await settingInts(tx, ["web_event_retention_days"]);
  if (days > (s.web_event_retention_days ?? 395)) {
    throw badField("/event_retention_days", "must not exceed the platform's event retention");
  }
}

/** Lower-case A-label, no port, no trailing dot (data-model §8.4); IDNs are converted. */
export function normaliseHost(input: string): string | null {
  const trimmed = input.trim().replace(/\.$/, "");
  if (trimmed.length === 0 || /[/:@\s]/.test(trimmed)) return null;
  const ascii = domainToASCII(trimmed.toLowerCase());
  if (!ascii || ascii.length > 253) return null;
  const label = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
  return new RegExp(`^(${label}\\.)+${label}$`).test(ascii) ? ascii : null;
}

type SiteInput = {
  name?: string;
  tracker_profile?: Profile;
  visitor_id?: VisitorId;
  visitor_id_off_countries?: string[];
  exclude_countries?: string[];
  path_folding?: "full" | "relaxed";
  event_retention_days?: number | null;
  opt_out_page_url?: string | null;
  dev_origins?: string[];
};

/** The tenant's verified domain hosts (dev-origin wildcard rule, wire-formats §a.8). */
async function verifiedHosts(tx: Tx, tenantId: string): Promise<Set<string>> {
  const rows = await tx.query<{ host: string }>(
    `SELECT DISTINCT host FROM scf.site_domains WHERE tenant_id = $1 AND state = 'verified'`,
    [tenantId],
  );
  return new Set(rows.map((r) => r.host));
}

async function checkDevOriginsOf(tx: Tx, tenantId: string, list: string[] | undefined) {
  if (list === undefined) return;
  assertDevOrigins(list, await verifiedHosts(tx, tenantId));
}

export function siteHandlers() {
  const listSites: Handler = async (ctx) => ({
    status: 200,
    body: await ctx.tx((tx) => siteViews(tx, ctx.params.tenantId as string)),
  });

  const getSite: Handler = async (ctx) => ({
    status: 200,
    body: await ctx.tx((tx) =>
      siteView(tx, ctx.params.tenantId as string, ctx.params.siteId as string),
    ),
  });

  const createSite: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const b = ctx.body as SiteInput & { name: string };
    const profile = b.tracker_profile ?? "standard";
    // C-53: the default follows the profile unless the tenant chose explicitly.
    const visitorId: VisitorId = b.visitor_id ?? (profile === "strict" ? "off" : "on");
    const offCountries = visitorId === "off_in" ? (b.visitor_id_off_countries ?? []) : [];
    if (visitorId === "off_in" && offCountries.length === 0) {
      throw badField("/visitor_id_off_countries", "required when visitor_id is off_in");
    }
    const body = await ctx.tx(async (tx) => {
      await checkRetention(tx, b.event_retention_days);
      await checkDevOriginsOf(tx, tenantId, b.dev_origins);
      // Serialise concurrent creations per tenant so the L0 limit holds (C-19): the lock comes FIRST, so the count below
      // (a new statement under READ COMMITTED) sees every site a concurrent creation committed before it.
      await tx.query(`SELECT 1 FROM scf.tenants WHERE tenant_id = $1 FOR UPDATE`, [tenantId]);
      const limit = await tx.one<{ level: number; n: number; max: number }>(
        `SELECT scf.verification_level($1) AS level,
                (SELECT count(*)::int FROM scf.sites WHERE tenant_id = $1 AND status <> 'archived') AS n,
                scf.setting_int('l0_max_sites') AS max`,
        [tenantId],
      );
      if (Number(limit.level) === 0 && limit.n >= limit.max)
        throw new ApiError("quota_exceeded", "site limit reached at L0");
      const siteId = randomUUID();
      const twin = visitorId === "on" ? null : randomUUID();
      await tx.query(
        `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id, tracker_profile,
                                visitor_id, visitor_id_off_countries, visitor_id_explicit, exclude_countries, path_folding,
                                event_retention_days, opt_out_page_url, created_by, dev_origins)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::char(2)[], $10, $11::char(2)[], $12, $13, $14, $15, $16)`,
        [
          tenantId,
          siteId,
          b.name,
          newSiteKey(),
          randomUUID(),
          twin,
          profile,
          visitorId,
          offCountries,
          b.visitor_id !== undefined,
          b.exclude_countries ?? [],
          b.path_folding ?? "full",
          b.event_retention_days ?? null,
          b.opt_out_page_url ?? null,
          ctx.session?.userId,
          b.dev_origins ?? [],
        ],
      );
      await tx.audit({
        action: "site.created",
        targetType: "site",
        targetId: siteId,
        details: {
          tracker_profile: profile,
          visitor_id: visitorId,
          ...(b.dev_origins?.length ? { dev_origins: b.dev_origins.length } : {}),
        },
      });
      await tx.notify("scf_umami");
      await tx.notify("scf_edge");
      return siteView(tx, tenantId, siteId);
    });
    return { status: 201, body };
  };

  const updateSite: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const b = ctx.body as SiteInput;
    const body = await ctx.tx(async (tx) => {
      // An archived site's settings stay editable (no ingest either way; updateSite documents no 409).
      const cur = await lockSite(tx, tenantId, siteId);
      await checkRetention(tx, b.event_retention_days);
      await checkDevOriginsOf(tx, tenantId, b.dev_origins);
      const profile = b.tracker_profile ?? cur.tracker_profile;
      const explicit = cur.visitor_id_explicit || b.visitor_id !== undefined;
      let visitorId: VisitorId = b.visitor_id ?? cur.visitor_id;
      // C-53: switching to strict turns identifiers off unless the tenant chose visitor_id explicitly.
      if (b.visitor_id === undefined && !explicit && b.tracker_profile !== undefined) {
        visitorId = profile === "strict" ? "off" : "on";
      }
      const offCountries =
        visitorId === "off_in" ? (b.visitor_id_off_countries ?? cur.visitor_id_off_countries) : [];
      if (visitorId === "off_in" && offCountries.length === 0) {
        throw badField("/visitor_id_off_countries", "required when visitor_id is off_in");
      }
      // C-73: the twin is assigned once, the first time the site has events without an identifier.
      const twin = cur.umami_twin_website_id ?? (visitorId === "on" ? null : randomUUID());
      await tx.query(
        `UPDATE scf.sites SET name = $3, tracker_profile = $4, visitor_id = $5, visitor_id_off_countries = $6::char(2)[],
                visitor_id_explicit = $7, exclude_countries = $8::char(2)[], path_folding = $9,
                event_retention_days = $10, opt_out_page_url = $11, umami_twin_website_id = $12, dev_origins = $13
          WHERE tenant_id = $1 AND site_id = $2`,
        [
          tenantId,
          siteId,
          b.name ?? cur.name,
          profile,
          visitorId,
          offCountries,
          explicit,
          b.exclude_countries ?? cur.exclude_countries,
          b.path_folding ?? cur.path_folding,
          "event_retention_days" in b ? (b.event_retention_days ?? null) : cur.event_retention_days,
          "opt_out_page_url" in b ? (b.opt_out_page_url ?? null) : cur.opt_out_page_url,
          twin,
          b.dev_origins ?? cur.dev_origins,
        ],
      );
      await tx.audit({
        action: "site.updated",
        targetType: "site",
        targetId: siteId,
        details: { fields: Object.keys(b).sort() },
      });
      if (twin !== cur.umami_twin_website_id) await tx.notify("scf_umami");
      await tx.notify("scf_edge");
      return siteView(tx, tenantId, siteId);
    });
    return { status: 200, body };
  };

  const setSiteAnonymousReports: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const on = (ctx.body as { anonymous_reports: boolean }).anonymous_reports;
    const body = await ctx.tx(async (tx) => {
      await lockSite(tx, tenantId, siteId);
      await tx.query(
        `UPDATE scf.sites SET anonymous_reports = $3 WHERE tenant_id = $1 AND site_id = $2`,
        [tenantId, siteId, on],
      );
      await tx.audit({
        action: "site.updated",
        targetType: "site",
        targetId: siteId,
        details: { anonymous_reports: on },
      });
      return siteView(tx, tenantId, siteId);
    });
    return { status: 200, body };
  };

  const archiveSite: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    await ctx.tx(async (tx) => {
      const cur = await lockSite(tx, tenantId, siteId);
      if (cur.status !== "active") {
        // Idempotent repeat: nothing changes, but every successful audited call leaves its row.
        await tx.audit({
          action: "site.archived",
          targetType: "site",
          targetId: siteId,
          details: { unchanged: true },
        });
        return;
      }
      await tx.query(
        `UPDATE scf.sites SET status = 'archived', archived_at = now() WHERE tenant_id = $1 AND site_id = $2`,
        [tenantId, siteId],
      );
      await tx.audit({ action: "site.archived", targetType: "site", targetId: siteId });
      await tx.notify("scf_edge");
    });
    return { status: 204 };
  };

  const listDomains: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const rows = await ctx.tx(async (tx) => {
      const site = await tx.maybeOne(
        `SELECT 1 FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`,
        [tenantId, ctx.params.siteId],
      );
      if (!site) throw new ApiError("not_found");
      return tx.query<DomainRow>(
        `SELECT domain_id, site_id, host, include_subdomains, state, verified_at, grace_until, created_at
           FROM scf.site_domains WHERE tenant_id = $1 AND site_id = $2 ORDER BY created_at, domain_id`,
        [tenantId, ctx.params.siteId],
      );
    });
    return { status: 200, body: rows.map(domainView) };
  };

  const addDomain: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const b = ctx.body as { host: string; include_subdomains?: boolean };
    const host = normaliseHost(b.host);
    if (!host) throw badField("/host", "not a valid host name");
    const row = await ctx.tx(async (tx) => {
      const site = await lockSite(tx, tenantId, siteId);
      if (site.status !== "active") throw new ApiError("conflict", "the site is archived");
      const dup = await tx.maybeOne(
        `SELECT 1 FROM scf.site_domains WHERE tenant_id = $1 AND site_id = $2 AND host = $3`,
        [tenantId, siteId, host],
      );
      if (dup) throw new ApiError("conflict", "domain already declared for this site");
      // A host verified by another tenant is accepted as declared; verification then yields `disputed` (no oracle).
      const r = await tx.one<DomainRow>(
        `INSERT INTO scf.site_domains (tenant_id, site_id, host, include_subdomains) VALUES ($1, $2, $3, $4)
         RETURNING domain_id, site_id, host, include_subdomains, state, verified_at, grace_until, created_at`,
        [tenantId, siteId, host, b.include_subdomains ?? false],
      );
      await tx.audit({
        action: "domain.added",
        targetType: "domain",
        targetId: r.domain_id,
        details: { site_id: siteId },
      });
      await tx.notify("scf_edge");
      return r;
    });
    return { status: 201, body: domainView(row) };
  };

  const removeDomain: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    await ctx.tx(async (tx) => {
      // scf_app may not lock site_domains rows (no UPDATE privilege, migration 0067): the tenant row serialises this
      // tenant's domain removals instead.
      await tx.query(`SELECT 1 FROM scf.tenants WHERE tenant_id = $1 FOR UPDATE`, [tenantId]);
      const own = await tx.maybeOne<{ host: string }>(
        `SELECT host FROM scf.site_domains WHERE tenant_id = $1 AND site_id = $2 AND domain_id = $3`,
        [tenantId, ctx.params.siteId, ctx.params.domainId],
      );
      if (!own) throw new ApiError("not_found");
      // Before the row goes: the host claim moves to another VERIFIED declaration of the host by this tenant, or is
      // released when there is none (C-114) — never left with an unverified one, where it would block the
      // host's owner.
      const stillVerified = await releaseClaim(
        tx,
        tenantId,
        ctx.params.domainId as string,
        own.host,
      );
      // The host's `domain` evidence (ladder L1+) lapses with the last verified declaration of the host:
      // otherwise the tenant would keep its level for a host it gave up, which another tenant may then verify. Done
      // before the row goes, so it is audited (the database's AFTER DELETE backstop, migration 0069, writes no audit).
      if (!stillVerified) {
        const lapsed = await tx.maybeOne<{ evidence_id: string }>(
          `UPDATE scf.verification_evidence SET status = 'lapsed', lapsed_at = now()
            WHERE tenant_id = $1 AND kind = 'domain' AND subject = $2 AND status = 'valid'
            RETURNING evidence_id`,
          [tenantId, own.host],
        );
        if (lapsed)
          await tx.audit({
            action: "verification.evidence_lapsed",
            targetType: "evidence",
            targetId: lapsed.evidence_id,
            details: { kind: "domain", reason: "domain_removed" },
          });
      }
      await tx.query(
        `DELETE FROM scf.site_domains WHERE tenant_id = $1 AND site_id = $2 AND domain_id = $3`,
        [tenantId, ctx.params.siteId, ctx.params.domainId],
      );
      await tx.audit({
        action: "domain.removed",
        targetType: "domain",
        targetId: ctx.params.domainId as string,
      });
      await tx.notify("scf_edge");
    });
    return { status: 204 };
  };

  return {
    listSites,
    getSite,
    createSite,
    updateSite,
    setSiteAnonymousReports,
    archiveSite,
    listDomains,
    addDomain,
    removeDomain,
  };
}
