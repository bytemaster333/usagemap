// SPDX-License-Identifier: Apache-2.0
// Integration catalogue operations:
//
//   listIntegrations      the catalogue for one website and one API service of the tenant (default: the oldest active
//                         of each), every card with its generated configuration, test command, live-check kind,
//                         status and, where the facts suggest one, a recommendation; filterable by group, project
//                         kind (`audience`) and stack tag;
//   getIntegrationStatus  the same statuses and the raw signals behind them, cheap enough to poll every 5 seconds
//                         while a live check runs (the portal compares `baseline_points_2d` before and after the OTLP
//                         test, and lists the website's dev events through listSiteDevEvents).
//
// Reads only, under the tenant's context (RLS). Nothing secret is returned: the site key is public, ingest tokens
// stay placeholders. A foreign or unknown `site_id`/`service_id` is the same 404 as a missing one (C-87).

import type { Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { trackerPin } from "../onboarding/kit.ts";
import type { TrackerRegistry } from "../tracker.ts";
import {
  type Audience,
  definition,
  type Group,
  INTEGRATION_IDS,
  render,
  select,
} from "./catalogue.ts";
import { recommendation, type Signals, statusOf } from "./status.ts";
import { WEB_TEST_PATH } from "./test-commands.ts";

export interface IntegrationsDeps {
  tracker: TrackerRegistry;
  portalOrigin: string;
  otlpEndpoint: string | undefined;
}

interface SiteRow extends Record<string, unknown> {
  site_id: string;
  name: string;
  site_key: string;
  tracker_profile: "standard" | "strict";
  dev_origins: string[];
}

interface Loaded {
  site: SiteRow | undefined;
  domains: Array<{ domain_id: string; host: string; state: string }>;
  signals: Signals;
  tenant: { slug: string; public_stats: boolean };
}

function visible(ctx: RequestContext): string {
  if (ctx.tenant?.status === "removed") throw new ApiError("not_found");
  return ctx.params.tenantId as string;
}

async function load(
  tx: Tx,
  tenantId: string,
  siteId: string | undefined,
  serviceId: string | undefined,
) {
  const site = await tx.maybeOne<SiteRow>(
    `SELECT site_id::text AS site_id, name, site_key, tracker_profile::text AS tracker_profile, dev_origins
       FROM scf.sites
      WHERE tenant_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR site_id = $2::uuid)
      ORDER BY created_at, site_id LIMIT 1`,
    [tenantId, siteId ?? null],
  );
  if (siteId && !site) throw new ApiError("not_found");
  const service = await tx.maybeOne<{ service_id: string; service_name: string }>(
    `SELECT service_id::text AS service_id, service_name FROM scf.api_services
      WHERE tenant_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR service_id = $2::uuid)
      ORDER BY registered_at, service_id LIMIT 1`,
    [tenantId, serviceId ?? null],
  );
  if (serviceId && !service) throw new ApiError("not_found");
  const domains = site
    ? await tx.query<{ domain_id: string; host: string; state: string }>(
        `SELECT domain_id::text AS domain_id, host, state::text AS state FROM scf.site_domains
          WHERE tenant_id = $1 AND site_id = $2 ORDER BY (state = 'verified') DESC, created_at, domain_id`,
        [tenantId, site.site_id],
      )
    : [];
  const f = await tx.one<{
    dev: number;
    dev_wallet: number;
    dev_test: number;
    last_dev: Date | null;
    counted: boolean;
    wallet: boolean;
    passkey: boolean;
    kit: boolean;
    baseline: string;
    reports: string;
    api_counted: boolean;
    footprint: number;
    rpc: boolean;
    app_events: string;
    app_stale: string;
    app_reports: string;
    slug: string;
    public_stats: boolean;
  }>(
    `WITH d AS (SELECT kind, path_class, received_at FROM scf.web_dev_events
                 WHERE tenant_id = $1 AND site_id = $2::uuid AND received_at > now() - interval '24 hours'),
          today AS (SELECT (now() AT TIME ZONE 'UTC')::date AS t)
     SELECT (SELECT count(*) FROM d)::int AS dev,
            (SELECT count(*) FROM d WHERE kind = 'stellar')::int AS dev_wallet,
            (SELECT count(*) FROM d WHERE path_class = $4)::int AS dev_test,
            (SELECT max(received_at) FROM d) AS last_dev,
            EXISTS (SELECT 1 FROM scf.web_edge_counters c, today
                     WHERE c.tenant_id = $1 AND c.site_id = $2::uuid AND c.day >= today.t - 6
                       AND c.counter = 'verdict' AND c.label IN ('verified', 'suspect') AND c.count > 0) AS counted,
            EXISTS (SELECT 1 FROM scf.web_event_property_daily p, today
                     WHERE p.tenant_id = $1 AND p.site_id = $2::uuid AND p.day >= today.t - 6 AND p.count > 0
                       AND p.event_name NOT IN ('smart_wallet_created', 'passkey_used')) AS wallet,
            EXISTS (SELECT 1 FROM scf.web_event_property_daily p, today
                     WHERE p.tenant_id = $1 AND p.site_id = $2::uuid AND p.day >= today.t - 6 AND p.count > 0
                       AND p.event_name IN ('smart_wallet_created', 'passkey_used')) AS passkey,
            EXISTS (SELECT 1 FROM scf.web_edge_counters c, today
                     WHERE c.tenant_id = $1 AND c.site_id = $2::uuid AND c.day >= today.t - 6
                       AND c.counter = 'kit_present_pageviews' AND c.count > 0) AS kit,
            (SELECT COALESCE(sum(a.count), 0) FROM scf.api_ingest_counters a, today
              WHERE a.tenant_id = $1 AND a.service_id = $3::uuid AND a.day >= today.t - 1
                AND a.reason = 'cumulative_first_point')::text AS baseline,
            (SELECT COALESCE(sum(a.count), 0) FROM scf.api_ingest_counters a, today
              WHERE a.tenant_id = $1 AND a.service_id = $3::uuid AND a.day >= today.t - 6)::text AS reports,
            EXISTS (SELECT 1 FROM scf.api_metrics_1d m, today
                     WHERE m.tenant_id = $1 AND m.service_id = $3::uuid
                       AND m.bucket_start >= (today.t - 6)::timestamp AT TIME ZONE 'UTC'
                       AND m.request_count > 0) AS api_counted,
            ((SELECT count(*) FROM scf.declared_contracts c WHERE c.tenant_id = $1 AND c.removed_at IS NULL)
             + (SELECT count(*) FROM scf.footprint_items i WHERE i.tenant_id = $1 AND i.removed_at IS NULL))::int
              AS footprint,
            EXISTS (SELECT 1 FROM scf.web_rpc_client_daily r, today
                     WHERE r.tenant_id = $1 AND r.site_id = $2::uuid AND r.day >= today.t - 6 AND r.count > 0) AS rpc,
            (SELECT COALESCE(sum(a.count), 0) FROM scf.app_event_daily a, today
              WHERE a.tenant_id = $1 AND a.site_id = $2::uuid AND a.day >= today.t - 6
                AND a.event_name NOT IN ('_session', '_dropped') AND a.prop_key = '_total')::text AS app_events,
            (SELECT COALESCE(sum(a.count), 0) FROM scf.app_event_daily a, today
              WHERE a.tenant_id = $1 AND a.site_id = $2::uuid AND a.day >= today.t - 1
                AND a.event_name = '_dropped' AND a.prop_key = 'reason' AND a.prop_value = 'stale')::text AS app_stale,
            (SELECT COALESCE(sum(a.count), 0) FROM scf.app_event_daily a, today
              WHERE a.tenant_id = $1 AND a.site_id = $2::uuid AND a.day >= today.t - 6)::text AS app_reports,
            t.slug, t.public_stats_enabled AS public_stats
       FROM scf.tenants t WHERE t.tenant_id = $1`,
    [tenantId, site?.site_id ?? null, service?.service_id ?? null, WEB_TEST_PATH],
  );
  const signals: Signals = {
    site: site
      ? {
          site_id: site.site_id,
          dev_origins: site.dev_origins,
          dev_events_24h: f.dev,
          wallet_dev_events_24h: f.dev_wallet,
          test_events_24h: f.dev_test,
          last_dev_event_at: f.last_dev?.toISOString() ?? null,
          counted_7d: f.counted,
          wallet_counted_7d: f.wallet,
          passkey_counted_7d: f.passkey,
          wallets_kit_seen_7d: f.kit,
          rpc_counted_7d: f.rpc,
          app_events_7d: Number(f.app_events),
          app_stale_drops_2d: Number(f.app_stale),
          app_reports_7d: Number(f.app_reports),
        }
      : null,
    service: service
      ? {
          service_id: service.service_id,
          service_name: service.service_name,
          baseline_points_2d: Number(f.baseline),
          reports_7d: Number(f.reports),
          counted_7d: f.api_counted,
        }
      : null,
    footprint_items: f.footprint,
    public_stats: f.public_stats,
  };
  return {
    site,
    domains,
    signals,
    tenant: { slug: f.slug, public_stats: f.public_stats },
  } satisfies Loaded;
}

export function integrationHandlers(deps: IntegrationsDeps): Record<string, Handler> {
  const listIntegrations: Handler = async (ctx) => {
    const tenantId = visible(ctx);
    const q = ctx.query as {
      site_id?: string;
      service_id?: string;
      group?: Group;
      audience?: Audience;
      stack?: string;
    };
    const data = await ctx.tx((tx) => load(tx, tenantId, q.site_id, q.service_id));
    const versions = deps.tracker.versions();
    const pin = data.site
      ? trackerPin(versions, deps.tracker.hosts, data.site.tracker_profile)
      : null;
    const anyActive = versions.find((v) => v.status === "active");
    const ingestOrigins = anyActive ? deps.tracker.hosts(anyActive.version) : [];
    const ingestOrigin = ingestOrigins[0];
    const service = data.signals.service
      ? {
          service_id: data.signals.service.service_id,
          service_name: data.signals.service.service_name,
        }
      : null;
    const rctx = {
      site: data.site ? { ...data.site, domains: data.domains } : null,
      pin,
      ingestOrigin,
      otlpEndpoint: deps.otlpEndpoint,
      service,
      portalOrigin: deps.portalOrigin,
      ingestOrigins,
      tenant: data.tenant,
    };
    const integrations = select({ group: q.group, audience: q.audience, stack: q.stack }).map(
      (d) => {
        const s = statusOf(d, data.signals);
        return {
          ...render(d, rctx),
          status: s.status,
          status_detail: s.detail,
          recommended: recommendation(d, data.signals),
        };
      },
    );
    return {
      status: 200,
      body: {
        tenant_id: tenantId,
        site: data.site
          ? {
              site_id: data.site.site_id,
              name: data.site.name,
              site_key: data.site.site_key,
              tracker_profile: data.site.tracker_profile,
              dev_origins: data.site.dev_origins,
            }
          : null,
        service,
        ingest_origin: ingestOrigin ?? null,
        otlp_endpoint: deps.otlpEndpoint ?? null,
        tracker_version: pin?.version ?? null,
        integrations,
      },
      headers: { "cache-control": "no-store" },
    };
  };

  const getIntegrationStatus: Handler = async (ctx) => {
    const tenantId = visible(ctx);
    const q = ctx.query as { site_id?: string; service_id?: string };
    const data = await ctx.tx((tx) => load(tx, tenantId, q.site_id, q.service_id));
    const statuses = INTEGRATION_IDS.map((id) => {
      const d = definition(id);
      if (!d) throw new Error(`unknown integration ${id}`);
      return statusOf(d, data.signals);
    });
    return {
      status: 200,
      body: { checked_at: new Date().toISOString(), signals: data.signals, statuses },
      headers: { "cache-control": "no-store" },
    };
  };

  return { listIntegrations, getIntegrationStatus };
}
