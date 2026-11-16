// SPDX-License-Identifier: Apache-2.0
// Per-site Stellar operations (C-136, C-137): the time-boxed debug mode and the first-event panel of dev/preview
// origins (wire-formats §a.8; data-model §12.1), and the wallet funnel of the Stellar event schema v1 (wire-formats
// §a.3.1; metric definitions §2.11) from `web_event_property_daily`, its source of truth (C-137). Every statement runs
// under the tenant's own context with an explicit tenant filter; a foreign or unknown site is the same 404 (C-87).
// The tenant's own funnel is exact (no small-count floor: that applies only to outputs that leave the tenant, C-137).

import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { DAY, dayString, iso } from "./range.ts";

/** Funnel order of the v1 events (wire-formats §a.3.1). */
export const FUNNEL_EVENTS = [
  "wallet_modal_opened",
  "wallet_modal_closed",
  "wallet_selected",
  "wallet_connect",
  "wallet_disconnect",
  "sign_requested",
  "sign_approved",
  "sign_rejected",
  "tx_submitted",
  "smart_wallet_created",
  "passkey_used",
] as const;

export const STELLAR_EVENT_SCHEMA = "scf-stellar-events/1";
const MAX_FUNNEL_DAYS = 400;
const DEV_EVENT_LIMIT = 100;

function bad(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

async function siteExists(tx: Tx, tenantId: string, siteId: string): Promise<void> {
  const s = await tx.maybeOne(`SELECT 1 FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`, [
    tenantId,
    siteId,
  ]);
  if (!s) throw new ApiError("not_found");
}

export interface FunnelRow {
  day: string;
  event_name: string;
  prop_key: string;
  prop_value: string;
  n: number;
}

/** Shapes summed rollup rows into the `WalletFunnel` steps and daily series (pure; unit-tested). */
export function shapeFunnel(
  rows: readonly FunnelRow[],
  days: readonly string[],
): {
  steps: Array<{
    event: string;
    count: number;
    by_wallet: Record<string, number>;
    by_property: Record<string, Record<string, number>>;
  }>;
  daily: Array<{
    day: string;
    wallet_connect: number;
    sign_approved: number;
    tx_submitted_success: number;
  }>;
} {
  const steps = new Map(
    FUNNEL_EVENTS.map((e) => [
      e as string,
      {
        event: e as string,
        count: 0,
        by_wallet: {} as Record<string, number>,
        by_property: {} as Record<string, Record<string, number>>,
      },
    ]),
  );
  const daily = new Map(
    days.map((d) => [d, { day: d, wallet_connect: 0, sign_approved: 0, tx_submitted_success: 0 }]),
  );
  for (const r of rows) {
    const s = steps.get(r.event_name);
    if (!s) continue;
    if (r.prop_key === "_total") {
      s.count += r.n;
      const d = daily.get(r.day);
      if (d && r.event_name === "wallet_connect") d.wallet_connect += r.n;
      if (d && r.event_name === "sign_approved") d.sign_approved += r.n;
    } else if (r.prop_key === "wallet") {
      s.by_wallet[r.prop_value] = (s.by_wallet[r.prop_value] ?? 0) + r.n;
    } else {
      const m = s.by_property[r.prop_key] ?? {};
      m[r.prop_value] = (m[r.prop_value] ?? 0) + r.n;
      s.by_property[r.prop_key] = m;
      const d = daily.get(r.day);
      if (
        d &&
        r.event_name === "tx_submitted" &&
        r.prop_key === "result_class" &&
        r.prop_value === "success"
      )
        d.tx_submitted_success += r.n;
    }
  }
  return { steps: [...steps.values()], daily: [...daily.values()] };
}

export function stellarSiteHandlers(): Record<string, Handler> {
  /** C-136: on for 1–1440 minutes from now (database clock, which the edge snapshot also reads), or off. */
  const setSiteDebugMode: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const b = ctx.body as { enabled: boolean; duration_minutes?: number };
    if (!b.enabled && b.duration_minutes !== undefined)
      throw bad("/duration_minutes", "duration_minutes is allowed only with enabled: true");
    const minutes = b.enabled ? (b.duration_minutes ?? 60) : null;
    const until = await ctx.tx(async (tx) => {
      const r = await tx.maybeOne<{ debug_until: Date | null }>(
        `UPDATE scf.sites
            SET debug_until = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END
          WHERE tenant_id = $1 AND site_id = $2 RETURNING debug_until`,
        [tenantId, siteId, minutes],
      );
      if (!r) throw new ApiError("not_found");
      await tx.audit({
        action: "site.debug_mode_set",
        targetType: "site",
        targetId: siteId,
        details: b.enabled
          ? { enabled: true, minutes, until: r.debug_until?.toISOString() }
          : { enabled: false },
      });
      await tx.notify("scf_edge"); // reaches every edge within 60 s
      return r.debug_until;
    });
    return {
      status: 200,
      body: { site_id: siteId, debug_until: until?.toISOString() ?? null },
    };
  };

  const listSiteDevEvents: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const body = await ctx.tx(async (tx) => {
      const site = await tx.maybeOne<{ dev_origins: string[]; debug_until: Date | null }>(
        `SELECT dev_origins, CASE WHEN debug_until > now() THEN debug_until END AS debug_until
           FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`,
        [tenantId, siteId],
      );
      if (!site) throw new ApiError("not_found");
      const events = await tx.query<{
        received_at: Date;
        kind: string;
        event_name: string;
        path_class: string;
        would_be_verdict: string;
        reason: string | null;
      }>(
        `SELECT received_at, kind, event_name, path_class, would_be_verdict, reason FROM scf.web_dev_events
          WHERE tenant_id = $1 AND site_id = $2 AND received_at > now() - interval '24 hours'
          ORDER BY received_at DESC, event_id DESC LIMIT ${DEV_EVENT_LIMIT}`,
        [tenantId, siteId],
      );
      return {
        site_id: siteId,
        dev_origins: site.dev_origins,
        debug_until: site.debug_until?.toISOString() ?? null,
        events: events.map((e) => ({
          received_at: e.received_at.toISOString(),
          kind: e.kind,
          event_name: e.event_name,
          path: e.path_class,
          would_be_verdict: e.would_be_verdict,
          reason: e.reason,
        })),
      };
    });
    return { status: 200, body, headers: { "cache-control": "no-store" } };
  };

  const getSiteWalletFunnel: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const q = ctx.query as { start: string; end: string; network?: string; variant?: string };
    const start = Date.parse(q.start);
    const end = Date.parse(q.end);
    const network = q.network ?? "mainnet";
    const variant = q.variant === "raw" ? "raw" : "verified";
    const rows = await ctx.tx(async (tx) => {
      // a foreign or unknown site is 404 before anything about the request is judged (C-87)
      await siteExists(tx, tenantId, siteId);
      if (!(end > start)) throw bad("/end", "end must be after start");
      if (end - start > MAX_FUNNEL_DAYS * DAY)
        throw bad("/end", `the range is at most ${MAX_FUNNEL_DAYS} days`);
      return tx.query<{
        day: string;
        event_name: string;
        prop_key: string;
        prop_value: string;
        n: string;
      }>(
        `SELECT day::text AS day, event_name, prop_key, prop_value, sum(count)::text AS n
           FROM scf.web_event_property_daily
          WHERE tenant_id = $1 AND site_id = $2 AND day >= $3::date AND day < $4::date
            AND ($5::text IS NULL OR network = $5) AND verdict = ANY ($6::text[])
          GROUP BY 1, 2, 3, 4`,
        [
          tenantId,
          siteId,
          dayString(start),
          dayString(end),
          network === "all" ? null : network,
          variant === "raw" ? ["verified", "suspect"] : ["verified"],
        ],
      );
    });
    const days: string[] = [];
    for (let d = start; d < end; d += DAY) days.push(dayString(d));
    const shaped = shapeFunnel(
      rows.map((r) => ({ ...r, n: Number(r.n) })),
      days,
    );
    return {
      status: 200,
      body: {
        range: { start: iso(start), end: iso(end) },
        network,
        variant,
        schema: STELLAR_EVENT_SCHEMA,
        ...shaped,
      },
    };
  };

  return { setSiteDebugMode, listSiteDevEvents, getSiteWalletFunnel };
}
