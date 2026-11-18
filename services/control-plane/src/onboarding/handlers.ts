// SPDX-License-Identifier: Apache-2.0
// Onboarding of SCF-awarded projects from the public registry:
//
//   searchRegistryProjects     public picker over the synced public registry (registry.ts); small pages, a minimum
//                              query length and its own per-subnet limit (pipeline.ts), public fields only;
//   getRegistryProjectPrefill  what the sign-up pre-fills, and the caller's claim state: a pre-fill never grants trust,
//                              a project another tenant already claims is shown as "claimed" (dispute path: the
//                              existing cross-tenant domain conflict handling, an SCF operator decides);
//   getIntegrationKit          the ready-to-copy kit with the tenant's site key and a progress checklist (kit.ts);
//   operatorRegistryCoverage   SCF's view: every SCF-awarded registry project with its onboarding status and an invite
//                              link the operator copies (the platform never contacts a project).
//
// Tenant creation itself stays createTenant / createSite / addDomain / startDomainVerification / addFootprintItem, so
// their quotas, audit rows, tombstone checks and rate limits apply unchanged; the portal calls them in sequence.

import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { op } from "../operator/common.ts";
import type { TrackerRegistry } from "../tracker.ts";
import {
  checklist,
  frameworkSnippet,
  type KitSite,
  otelEnv,
  scriptTag,
  testCommands,
  trackerPin,
  walletSnippets,
} from "./kit.ts";
import {
  buildPrefill,
  frameworkHint,
  groupRows,
  type KitFramework,
  likePattern,
  normaliseQuery,
  PICKABLE,
  type ProjectGroup,
  REGISTRY_COLUMNS,
  type RegistryRow,
  rankGroups,
  verificationOptions,
} from "./registry.ts";

export interface OnboardingDeps {
  tracker: TrackerRegistry;
  portalOrigin: string;
  otlpEndpoint: string | undefined;
}

/** Rows read per search before grouping; far above any page, far below a bulk export. */
const SEARCH_ROWS = 60;
const DEFAULT_SERVICE = "my-api";

/** The group a row belongs to: rows sharing a registrable domain, or the same name when the row has no domain. */
async function loadGroup(tx: Tx, id: string): Promise<ProjectGroup | undefined> {
  const row = await tx.maybeOne<RegistryRow>(
    `SELECT ${REGISTRY_COLUMNS} FROM scf.registry_projects WHERE registry_project_id = $1 AND ${PICKABLE}`,
    [id],
  );
  if (!row) return undefined;
  const domains = row.registrable_domains ?? [];
  const siblings = await tx.query<RegistryRow>(
    `SELECT ${REGISTRY_COLUMNS} FROM scf.registry_projects
      WHERE ${PICKABLE}
        AND (CASE WHEN cardinality($1::text[]) > 0 THEN registrable_domains && $1::text[]
                  ELSE cardinality(registrable_domains) = 0 AND lower(btrim(name)) = lower(btrim($2)) END)
      ORDER BY registry_project_id LIMIT 20`,
    [domains, row.name],
  );
  const groups = groupRows(siblings.some((r) => r.registry_project_id === id) ? siblings : [row]);
  return groups.find((g) => g.rows.some((r) => r.registry_project_id === id));
}

/** Hosts that belong to one of the domains (the domain itself or a subdomain). */
function onDomains(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export function onboardingHandlers(deps: OnboardingDeps): Record<string, Handler> {
  const searchRegistryProjects: Handler = async (ctx) => {
    const q = normaliseQuery(String(ctx.query.q ?? ""));
    const limit = Number(ctx.query.limit ?? 8);
    if (q.length < 2)
      throw new ApiError("validation_failed", undefined, {
        errors: [{ pointer: "/q", detail: "at least 2 characters" }],
      });
    const { rows, more } = await ctx.tx(async (tx) => {
      const hits = await tx.query<RegistryRow>(
        `SELECT ${REGISTRY_COLUMNS} FROM scf.registry_projects
          WHERE ${PICKABLE}
            AND (name ILIKE $1 OR slug ILIKE $1
                 OR EXISTS (SELECT 1 FROM unnest(registrable_domains) d WHERE d ILIKE $1))
          ORDER BY (lower(name) = lower($2)) DESC, (lower(name) LIKE lower($3)) DESC, name, registry_project_id
          LIMIT ${SEARCH_ROWS}`,
        [likePattern(q), q, `${likePattern(q).slice(1)}`],
      );
      // The other source's rows of the projects found (same website domain), so an entry is complete even when only
      // one source's name matched.
      const domains = [...new Set(hits.flatMap((r) => r.registrable_domains ?? []))];
      const seen = new Set(hits.map((r) => r.registry_project_id));
      const siblings =
        domains.length === 0
          ? []
          : await tx.query<RegistryRow>(
              `SELECT ${REGISTRY_COLUMNS} FROM scf.registry_projects
                WHERE ${PICKABLE} AND registrable_domains && $1::text[] AND NOT (registry_project_id = ANY($2::uuid[]))
                ORDER BY registry_project_id LIMIT ${SEARCH_ROWS}`,
              [domains, [...seen]],
            );
      return { rows: [...hits, ...siblings], more: hits.length >= SEARCH_ROWS };
    });
    const groups = rankGroups(groupRows(rows), q);
    return {
      status: 200,
      body: {
        items: groups.slice(0, limit).map((g) => g.summary),
        more: groups.length > limit || more,
      },
    };
  };

  const getRegistryProjectPrefill: Handler = async (ctx) => {
    const id = ctx.params.registryProjectId as string;
    const userId = ctx.session?.userId as string;
    const { group, claimants, tenants } = await ctx.tx(async (tx) => {
      const group = await loadGroup(tx, id);
      if (!group) throw new ApiError("not_found");
      const claimants = new Map<string, number>();
      for (const r of group.rows) {
        const n = await tx.one<{ n: number }>(`SELECT scf.registry_claimants($1) AS n`, [
          r.registry_project_id,
        ]);
        claimants.set(r.registry_project_id, Number(n.n));
      }
      const tenants = await tx.query<{ tenant_id: string }>(
        `SELECT t.tenant_id::text AS tenant_id FROM scf.memberships m JOIN scf.tenants t ON t.tenant_id = m.tenant_id
          WHERE m.user_id = $1 AND t.status <> 'removed' AND t.purged_at IS NULL ORDER BY t.created_at`,
        [userId],
      );
      return { group, claimants, tenants };
    });
    const ids = group.rows.map((r) => r.registry_project_id);
    const domains = [...new Set(group.rows.flatMap((r) => r.registrable_domains ?? []))];
    // The caller's own claims, read in each of the caller's tenant contexts (RLS): per registry row, how many of the
    // caller's tenants hold a confirmed link or a verified domain on it; and which tenants already declared it.
    const own = new Map<string, number>(ids.map((x) => [x, 0]));
    const yours: string[] = [];
    for (const t of tenants) {
      const r = await ctx.tx(
        (tx) =>
          Promise.all([
            tx.query<{ registry_project_id: string; status: string }>(
              `SELECT registry_project_id::text AS registry_project_id, status FROM scf.tenant_registry_links
                WHERE tenant_id = $1 AND registry_project_id = ANY($2::uuid[]) AND status <> 'rejected'`,
              [t.tenant_id, ids],
            ),
            tx.query<{ host: string; state: string }>(
              `SELECT d.host, d.state::text AS state FROM scf.site_domains d
                 JOIN scf.sites s ON s.tenant_id = d.tenant_id AND s.site_id = d.site_id AND s.status = 'active'
                WHERE d.tenant_id = $1`,
              [t.tenant_id],
            ),
          ]),
        { tenantId: t.tenant_id },
      );
      const [links, hosts] = r;
      const onIt = hosts.filter((h) => onDomains(h.host, domains));
      if (links.length > 0 || onIt.length > 0) yours.push(t.tenant_id);
      const verifiedHost = onIt.some((h) => h.state === "verified");
      for (const x of ids) {
        const rowDomains =
          group.rows.find((g) => g.registry_project_id === x)?.registrable_domains ?? [];
        const linked = links.some((l) => l.registry_project_id === x && l.status === "confirmed");
        const hosted = verifiedHost && onIt.some((h) => onDomains(h.host, rowDomains));
        if (linked || hosted) own.set(x, (own.get(x) ?? 0) + 1);
      }
    }
    const others = ids.some((x) => (claimants.get(x) ?? 0) - (own.get(x) ?? 0) > 0);
    const p = buildPrefill(group);
    return {
      status: 200,
      body: {
        project: group.summary,
        links: p.links,
        prefill: p.prefill,
        claim: {
          state: yours.length > 0 ? "yours" : others ? "claimed" : "open",
          your_tenant_ids: yours,
        },
        framework_hint: p.framework_hint,
        is_dapp: p.is_dapp,
        verification_options: verificationOptions(group.summary.domain),
      },
    };
  };

  const getIntegrationKit: Handler = async (ctx) => {
    const tenantId = ctx.tenant?.id as string;
    const wantedSite = ctx.query.site_id as string | undefined;
    const data = await ctx.tx(async (tx) => {
      const site = await tx.maybeOne<{
        site_id: string;
        name: string;
        site_key: string;
        tracker_profile: "standard" | "strict";
      }>(
        `SELECT site_id::text AS site_id, name, site_key, tracker_profile::text AS tracker_profile FROM scf.sites
          WHERE tenant_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR site_id = $2::uuid)
          ORDER BY created_at, site_id LIMIT 1`,
        [tenantId, wantedSite ?? null],
      );
      if (wantedSite && !site) throw new ApiError("not_found");
      const domains = site
        ? await tx.query<{ domain_id: string; host: string; state: string }>(
            `SELECT domain_id::text AS domain_id, host, state::text AS state FROM scf.site_domains
              WHERE tenant_id = $1 AND site_id = $2 ORDER BY (state = 'verified') DESC, created_at, domain_id`,
            [tenantId, site.site_id],
          )
        : [];
      const allHosts = await tx.query<{ host: string }>(
        `SELECT d.host FROM scf.site_domains d
           JOIN scf.sites s ON s.tenant_id = d.tenant_id AND s.site_id = d.site_id AND s.status = 'active'
          WHERE d.tenant_id = $1`,
        [tenantId],
      );
      const facts = await tx.one<{
        events: boolean;
        stellar: boolean;
        footprint: number;
        services: number;
        service_name: string | null;
      }>(
        `SELECT (EXISTS (SELECT 1 FROM scf.web_edge_counters c
                          WHERE c.tenant_id = $1 AND c.counter = 'verdict' AND c.count > 0
                            AND ($2::uuid IS NULL OR c.site_id = $2::uuid))
                 OR EXISTS (SELECT 1 FROM scf.web_dev_events e
                             WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.site_id = $2::uuid))) AS events,
                EXISTS (SELECT 1 FROM scf.verification_evidence v
                         WHERE v.tenant_id = $1 AND v.kind = 'stellar_account' AND v.status = 'valid') AS stellar,
                ((SELECT count(*) FROM scf.declared_contracts c WHERE c.tenant_id = $1 AND c.removed_at IS NULL)
                 + (SELECT count(*) FROM scf.footprint_items f WHERE f.tenant_id = $1 AND f.removed_at IS NULL))::int
                  AS footprint,
                (SELECT count(*) FROM scf.api_services a WHERE a.tenant_id = $1 AND a.status = 'active')::int AS services,
                (SELECT a.service_name FROM scf.api_services a WHERE a.tenant_id = $1 AND a.status = 'active'
                  ORDER BY a.registered_at, a.service_id LIMIT 1) AS service_name`,
        [tenantId, site?.site_id ?? null],
      );
      const registered = await tx.query<{ contract_id: string }>(
        `SELECT contract_id FROM scf.declared_contracts WHERE tenant_id = $1 AND removed_at IS NULL`,
        [tenantId],
      );
      // The registry project: a confirmed link first, then any other link, then a declared domain on its website.
      const links = await tx.query<{ registry_project_id: string; status: string }>(
        `SELECT registry_project_id::text AS registry_project_id, status FROM scf.tenant_registry_links
          WHERE tenant_id = $1 AND status <> 'rejected'
          ORDER BY (status = 'confirmed') DESC, created_at, registry_project_id`,
        [tenantId],
      );
      let projectId = links[0]?.registry_project_id;
      if (!projectId && allHosts.length > 0) {
        // registrable domains of the hosts' parents, so www.x.org and app.x.org find x.org
        const candidates = [
          ...new Set(
            allHosts.flatMap((h) => {
              const parts = h.host.split(".");
              return parts.slice(0, -1).map((_p, i) => parts.slice(i).join("."));
            }),
          ),
        ];
        const m = await tx.maybeOne<{ registry_project_id: string }>(
          `SELECT registry_project_id::text AS registry_project_id FROM scf.registry_projects
            WHERE ${PICKABLE} AND registrable_domains && $1::text[]
            ORDER BY (source = 'stellarlight') DESC, registry_project_id LIMIT 1`,
          [candidates],
        );
        projectId = m?.registry_project_id;
      }
      const group = projectId ? await loadGroup(tx, projectId) : undefined;
      return {
        site,
        domains,
        facts,
        registered: new Set(registered.map((r) => r.contract_id)),
        group,
        confirmed: links.some((l) => l.status === "confirmed"),
      };
    });

    const site: KitSite | null = data.site ? { ...data.site, domains: data.domains } : null;
    const websites = data.group?.rows.flatMap((r) => r.websites ?? []) ?? [];
    const detected = frameworkHint(websites);
    const selected =
      (ctx.query.framework as KitFramework | undefined) ?? detected.framework ?? "html";
    const versions = deps.tracker.versions();
    const pin = site ? trackerPin(versions, deps.tracker.hosts, site.tracker_profile) : null;
    const anyActive = versions.find((v) => v.status === "active");
    const ingestOrigin = anyActive ? deps.tracker.hosts(anyActive.version)[0] : undefined;
    const serviceName =
      (ctx.query.service_name as string | undefined) ?? data.facts.service_name ?? DEFAULT_SERVICE;
    const prefill = data.group ? buildPrefill(data.group) : undefined;
    return {
      status: 200,
      body: {
        tenant_id: tenantId,
        site,
        registry_project: data.group?.summary ?? null,
        framework: { selected, detected },
        tracker_version: pin?.version ?? null,
        script_tag:
          site && pin
            ? {
                title: "Script tag (pinned version, Subresource Integrity)",
                filename: null,
                install: null,
                code: scriptTag(pin, site.site_key),
                guide_path: "docs/onboarding/web-html.md",
              }
            : null,
        framework_snippet: site && pin ? frameworkSnippet(selected, site, pin) : null,
        wallets: {
          recommended: prefill?.is_dapp ?? false,
          snippets: site && pin ? walletSnippets(site, pin) : [],
        },
        otel: otelEnv(deps.otlpEndpoint, serviceName),
        test_commands: testCommands({
          site,
          pin,
          ingestOrigin,
          otlpEndpoint: deps.otlpEndpoint,
          serviceName,
        }),
        contracts: (prefill?.prefill.contracts ?? []).map((c) => ({
          contract_id: c.contract_id,
          registered: data.registered.has(c.contract_id),
        })),
        checklist: checklist({
          site,
          devOrCountedEvents: data.facts.events,
          stellarAccount: data.facts.stellar,
          footprintItems: data.facts.footprint,
          apiServices: data.facts.services,
          registryMatch: data.confirmed,
          registryKnown: data.group !== undefined,
        }),
      },
    };
  };

  const operatorRegistryCoverage: Handler = async (ctx) => {
    const q = typeof ctx.query.q === "string" ? normaliseQuery(ctx.query.q).toLowerCase() : "";
    const want = ctx.query.status as string | undefined;
    const days = Number(ctx.query.measuring_days ?? 7);
    const { rows, cov } = await ctx.tx(async (tx) => {
      const cov = await op(() =>
        tx.query<{
          registry_project_id: string;
          tenants_enrolled: number;
          tenants_verified: number;
          tenants_measuring: number;
        }>(
          `SELECT registry_project_id::text AS registry_project_id, tenants_enrolled, tenants_verified,
                  tenants_measuring FROM scf.op_registry_coverage($1::integer)`,
          [days],
        ),
      );
      const rows = await tx.query<RegistryRow>(
        `SELECT ${REGISTRY_COLUMNS} FROM scf.registry_projects WHERE ${PICKABLE} ORDER BY name, registry_project_id`,
      );
      return { rows, cov };
    });
    const byRow = new Map(cov.map((c) => [c.registry_project_id, c]));
    const totals = { projects: 0, not_enrolled: 0, enrolled: 0, verified: 0, measuring: 0 };
    const items = [];
    for (const g of groupRows(rows)) {
      // a tenant can be counted on both rows of a project: the larger count, never the sum
      const pick = (k: "tenants_enrolled" | "tenants_verified" | "tenants_measuring") =>
        Math.max(0, ...g.rows.map((r) => Number(byRow.get(r.registry_project_id)?.[k] ?? 0)));
      const enrolled = pick("tenants_enrolled");
      const verified = pick("tenants_verified");
      const measuring = pick("tenants_measuring");
      const status =
        measuring > 0
          ? "measuring"
          : verified > 0
            ? "verified"
            : enrolled > 0
              ? "enrolled"
              : "not_enrolled";
      totals.projects++;
      totals[status]++;
      if (want && status !== want) continue;
      const s = g.summary;
      if (q && !s.name.toLowerCase().includes(q) && !(s.domain ?? "").includes(q)) continue;
      items.push({
        project: s,
        status,
        tenants_enrolled: enrolled,
        tenants_verified: verified,
        tenants_measuring: measuring,
        invite_url: `${deps.portalOrigin}/onboard?project=${s.registry_project_id}`,
      });
    }
    return { status: 200, body: { measuring_days: days, totals, items } };
  };

  return {
    searchRegistryProjects,
    getRegistryProjectPrefill,
    getIntegrationKit,
    operatorRegistryCoverage,
  };
}
