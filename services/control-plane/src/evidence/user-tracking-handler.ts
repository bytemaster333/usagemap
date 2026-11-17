// SPDX-License-Identifier: Apache-2.0
// getUserTrackingStatement: loads the facts of one project's setup over the last 30 complete UTC days and renders the
// "user tracking" paragraph of a grant application (user-tracking.ts). Reads only, under the tenant's context (RLS); nothing is
// stored. Facts: active websites with their privacy settings and whether counted page views, wallet or passkey
// events arrived; active API services with stored request metrics or Stellar client metrics; registered contracts and
// whether on-chain activity was read; public statistics; the newest valid signed traction snapshot.

import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { type SiteFacts, type UserTrackingFacts, userTrackingStatement } from "./user-tracking.ts";

export const USER_TRACKING_WINDOW_DAYS = 30;
const PASSKEY_EVENTS = ["smart_wallet_created", "passkey_used"];

export interface UserTrackingDeps {
  portalOrigin: string;
  docsOrigin: string;
  now?: () => number;
}

export async function loadUserTrackingFacts(
  tx: Tx,
  tenantId: string,
  window: { start: Date; end: Date },
  origins: { portalOrigin: string; docsOrigin: string },
): Promise<UserTrackingFacts> {
  const t = await tx.maybeOne<{ name: string; slug: string; public_stats_enabled: boolean }>(
    `SELECT name, slug, public_stats_enabled FROM scf.tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!t) throw new ApiError("not_found");
  const startDay = window.start.toISOString().slice(0, 10);
  const endDay = window.end.toISOString().slice(0, 10);
  const sites = await tx.query<{
    name: string;
    profile: "standard" | "strict";
    visitor_id: "on" | "off" | "off_in";
    anonymous_reports: boolean;
    retention: number;
    pageviews: boolean;
    wallet: boolean;
    passkey: boolean;
  }>(
    `SELECT s.name, s.tracker_profile::text AS profile, s.visitor_id, s.anonymous_reports,
            LEAST(COALESCE(s.event_retention_days, 395),
                  COALESCE((SELECT (value #>> '{}')::int FROM scf.settings WHERE key = 'web_event_retention_days'), 90))
              AS retention,
            EXISTS (SELECT 1 FROM scf.web_edge_counters c
                     WHERE c.tenant_id = s.tenant_id AND c.site_id = s.site_id AND c.day >= $2::date AND c.day < $3::date
                       AND c.counter = 'verdict' AND c.label IN ('verified', 'suspect') AND c.count > 0) AS pageviews,
            EXISTS (SELECT 1 FROM scf.web_event_property_daily p
                     WHERE p.tenant_id = s.tenant_id AND p.site_id = s.site_id AND p.day >= $2::date AND p.day < $3::date
                       AND p.count > 0 AND p.event_name <> ALL ($4::text[])) AS wallet,
            EXISTS (SELECT 1 FROM scf.web_event_property_daily p
                     WHERE p.tenant_id = s.tenant_id AND p.site_id = s.site_id AND p.day >= $2::date AND p.day < $3::date
                       AND p.count > 0 AND p.event_name = ANY ($4::text[])) AS passkey
       FROM scf.sites s WHERE s.tenant_id = $1 AND s.status = 'active' ORDER BY s.created_at, s.site_id`,
    [tenantId, startDay, endDay, PASSKEY_EVENTS],
  );
  const services = await tx.query<{ name: string; requests: boolean; client: boolean }>(
    `SELECT a.service_name AS name,
            EXISTS (SELECT 1 FROM scf.api_metrics_1d m
                     WHERE m.tenant_id = a.tenant_id AND m.service_id = a.service_id
                       AND m.bucket_start >= $2 AND m.bucket_start < $3 AND m.request_count > 0) AS requests,
            EXISTS (SELECT 1 FROM scf.stellar_client_1d c
                     WHERE c.tenant_id = a.tenant_id AND c.service_id = a.service_id
                       AND c.bucket_start >= $2 AND c.bucket_start < $3 AND c.count > 0) AS client
       FROM scf.api_services a WHERE a.tenant_id = $1 AND a.status = 'active' ORDER BY a.registered_at, a.service_id`,
    [tenantId, window.start, window.end],
  );
  const c = await tx.one<{ declared: number; verified: number; activity: boolean }>(
    `SELECT count(*)::int AS declared, (count(*) FILTER (WHERE status = 'verified'))::int AS verified,
            EXISTS (SELECT 1 FROM scf.onchain_daily o JOIN scf.declared_contracts d
                      ON d.tenant_id = o.tenant_id AND d.contract_ref = o.contract_ref AND d.removed_at IS NULL
                     WHERE o.tenant_id = $1 AND o.day >= $2::date AND o.day < $3::date AND o.invocations > 0) AS activity
       FROM scf.declared_contracts WHERE tenant_id = $1 AND removed_at IS NULL`,
    [tenantId, startDay, endDay],
  );
  const snap = await tx.maybeOne<{ snapshot_id: string; schema_version: number }>(
    `SELECT snapshot_id::text AS snapshot_id, schema_version FROM scf.traction_snapshots
      WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, snapshot_id DESC LIMIT 1`,
    [tenantId],
  );
  return {
    projectName: t.name,
    window,
    sites: sites.map(
      (s): SiteFacts => ({
        name: s.name,
        profile: s.profile,
        visitorId: s.visitor_id,
        anonymousReports: s.anonymous_reports,
        retentionDays: Number(s.retention),
        pageviews: s.pageviews,
        wallet: s.wallet,
        passkey: s.passkey,
      }),
    ),
    services: services.map((s) => ({
      name: s.name,
      requests: s.requests,
      stellarClient: s.client,
    })),
    contracts: { declared: c.declared, verified: c.verified, activity: c.activity },
    publicStatsUrl: t.public_stats_enabled
      ? `${origins.portalOrigin}/p/${encodeURIComponent(t.slug)}`
      : null,
    snapshotUrl: snap
      ? `${origins.portalOrigin}/${snap.schema_version >= 3 ? "evidence" : "verify"}/${snap.snapshot_id}`
      : null,
    privacyUrl: `${origins.docsOrigin}/privacy`,
  };
}

/** The window: the last USER_TRACKING_WINDOW_DAYS complete UTC days. */
export function userTrackingWindow(now: number): { start: Date; end: Date } {
  const end = new Date(Math.floor(now / 86_400_000) * 86_400_000);
  return { start: new Date(end.getTime() - USER_TRACKING_WINDOW_DAYS * 86_400_000), end };
}

export function userTrackingHandlers(deps: UserTrackingDeps): Record<string, Handler> {
  const clock = deps.now ?? Date.now;
  const getUserTrackingStatement: Handler = async (ctx) => {
    if (ctx.tenant?.status === "removed") throw new ApiError("not_found");
    const tenantId = ctx.params.tenantId as string;
    const now = clock();
    const window = userTrackingWindow(now);
    const facts = await ctx.tx((tx) => loadUserTrackingFacts(tx, tenantId, window, deps));
    const out = userTrackingStatement(facts);
    return {
      status: 200,
      body: {
        tenant_id: tenantId,
        generated_at: new Date(now).toISOString(),
        window: { start: window.start.toISOString(), end: window.end.toISOString() },
        ...out,
        links: {
          privacy: facts.privacyUrl,
          public_stats: facts.publicStatsUrl,
          snapshot: facts.snapshotUrl,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  };
  return { getUserTrackingStatement };
}
