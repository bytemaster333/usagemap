// SPDX-License-Identifier: Apache-2.0
// Self-attested app events of a tenant's native apps and Telegram Mini Apps (migration 0084, scf.app_event_daily;
// wire-formats §a.9): daily counts of named events, their closed properties, distinct sessions per edge node and day
// with app / SDK versions, and the edge's drops. An app cannot run the browser proof of work, so nothing here is
// verified: the response is labelled self-attested, and no web figure, quota, score, snapshot or the Usage Map reads
// these rows. Reads run under the tenant's context (scf_app, RLS) with an explicit tenant filter; a foreign or unknown
// site is 404 (C-87). The tenant's own view is exact: nothing leaves the tenant, so no small-count floor (C-137).

import { visibleTenant } from "../api/services.ts";
import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { DAY, dayString, resolveWebRange, type Span, utcMidnight } from "../web/range.ts";

export const LABEL = "self-attested (app events are not verified)";
const MAX_DAYS = 800;
const MAX_ROWS = 200;
const PLATFORMS = ["ios", "android", "web"] as const;
type Platform = (typeof PLATFORMS)[number];

export interface AppEventRow {
  site_id: string;
  day: string;
  platform: string;
  event_name: string;
  prop_key: string;
  prop_value: string;
  n: number;
}

const byCount = <T extends { count: number }>(a: T, b: T, ka: string, kb: string) =>
  b.count - a.count || ka.localeCompare(kb);

/** Shapes summed cells into the response (pure; exported for unit tests). */
export function shapeAppEvents(rows: readonly AppEventRow[], days: readonly string[]) {
  const zero = () => ({ ios: 0, android: 0, web: 0 }) as Record<Platform, number>;
  const totals = { events: 0, sessions: 0, dropped: 0 };
  const sites = new Map<string, { events: number; sessions: number }>();
  const platforms = { events: zero(), sessions: zero() };
  const events = new Map<string, { count: number; platforms: Record<Platform, number> }>();
  const props = new Map<string, number>();
  const appVersions = new Map<string, number>();
  const sdks = new Map<string, number>();
  const tma = new Map<string, number>();
  const dropped = new Map<string, number>();
  const daily = new Map(days.map((d) => [d, { day: d, events: 0, sessions: 0 }]));
  const site = (id: string) => {
    const s = sites.get(id) ?? { events: 0, sessions: 0 };
    sites.set(id, s);
    return s;
  };
  for (const r of rows) {
    const p = (PLATFORMS as readonly string[]).includes(r.platform)
      ? (r.platform as Platform)
      : null;
    if (r.event_name === "_dropped") {
      totals.dropped += r.n;
      dropped.set(r.prop_value, (dropped.get(r.prop_value) ?? 0) + r.n);
      continue;
    }
    if (r.event_name === "_session") {
      if (r.prop_key === "_total") {
        totals.sessions += r.n;
        site(r.site_id).sessions += r.n;
        if (p) platforms.sessions[p] += r.n;
        const d = daily.get(r.day);
        if (d) d.sessions += r.n;
      } else if (r.prop_key === "app_version")
        appVersions.set(r.prop_value, (appVersions.get(r.prop_value) ?? 0) + r.n);
      else if (r.prop_key === "sdk_version")
        sdks.set(r.prop_value, (sdks.get(r.prop_value) ?? 0) + r.n);
      else if (r.prop_key === "tma_platform")
        tma.set(r.prop_value, (tma.get(r.prop_value) ?? 0) + r.n);
      continue;
    }
    if (r.prop_key === "_total") {
      totals.events += r.n;
      site(r.site_id).events += r.n;
      if (p) platforms.events[p] += r.n;
      const e = events.get(r.event_name) ?? { count: 0, platforms: zero() };
      e.count += r.n;
      if (p) e.platforms[p] += r.n;
      events.set(r.event_name, e);
      const d = daily.get(r.day);
      if (d) d.events += r.n;
    } else {
      const k = JSON.stringify([r.event_name, r.prop_key, r.prop_value]);
      props.set(k, (props.get(k) ?? 0) + r.n);
    }
  }
  const list = (m: Map<string, number>, field: string) =>
    [...m.entries()]
      .map(([k, count]) => ({ [field]: k, count }))
      .sort((a, b) => byCount(a, b, String(a[field]), String(b[field])))
      .slice(0, MAX_ROWS);
  return {
    totals,
    sites: [...sites.entries()]
      .map(([site_id, s]) => ({ site_id, ...s }))
      .sort((a, b) => b.events - a.events || a.site_id.localeCompare(b.site_id)),
    platforms: PLATFORMS.map((platform) => ({
      platform,
      events: platforms.events[platform],
      sessions: platforms.sessions[platform],
    })),
    events: [...events.entries()]
      .map(([event, e]) => ({ event, ...e }))
      .sort((a, b) => byCount(a, b, a.event, b.event))
      .slice(0, MAX_ROWS),
    properties: [...props.entries()]
      .map(([k, count]) => {
        const [event, key, value] = JSON.parse(k) as [string, string, string];
        return { event, key, value, count };
      })
      .sort((a, b) =>
        byCount(a, b, `${a.event}|${a.key}|${a.value}`, `${b.event}|${b.key}|${b.value}`),
      )
      .slice(0, MAX_ROWS),
    app_versions: list(appVersions, "version"),
    sdk_versions: list(sdks, "sdk"),
    tma_platforms: list(tma, "platform"),
    dropped: list(dropped, "reason"),
    daily: [...daily.values()],
  };
}

async function siteExists(tx: Tx, tenantId: string, siteId: string): Promise<void> {
  const s = await tx.maybeOne(`SELECT 1 FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`, [
    tenantId,
    siteId,
  ]);
  if (!s) throw new ApiError("not_found");
}

/** Day-aligned span of the request (presets and custom), at most MAX_DAYS days. */
export function appEventDays(q: Record<string, unknown>, now: number, createdAt: number): Span {
  const raw = resolveWebRange(q, now, createdAt);
  const span = { start: utcMidnight(raw.start), end: Math.ceil(raw.end / DAY) * DAY };
  if (span.end - span.start > MAX_DAYS * DAY)
    throw new ApiError("validation_failed", `the range is at most ${MAX_DAYS} days`, {
      errors: [{ pointer: "/end", detail: `the range is at most ${MAX_DAYS} days` }],
    });
  return span;
}

export async function readAppEvents(tx: Tx, tenantId: string, span: Span, siteId: string | null) {
  const rows = await tx.query<Omit<AppEventRow, "n"> & { n: string }>(
    `SELECT site_id::text, day::text AS day, platform, event_name, prop_key, prop_value, sum(count)::text AS n
       FROM scf.app_event_daily
      WHERE tenant_id = $1 AND day >= $2::date AND day < $3::date AND ($4::uuid IS NULL OR site_id = $4::uuid)
      GROUP BY 1, 2, 3, 4, 5, 6`,
    [tenantId, dayString(span.start), dayString(span.end), siteId],
  );
  const days: string[] = [];
  for (let d = span.start; d < span.end; d += DAY) days.push(dayString(d));
  return {
    range: { start: dayString(span.start), end: dayString(span.end), label: LABEL },
    site_id: siteId,
    attestation: "self_attested" as const,
    ...shapeAppEvents(
      rows.map((r) => ({ ...r, n: Number(r.n) })),
      days,
    ),
  };
}

export function appEventsHandlers(deps: { now?: () => number } = {}): Record<string, Handler> {
  const clock = deps.now ?? Date.now;
  const getAppEvents: Handler = async (ctx) => {
    const now = clock();
    const tenantId = visibleTenant(ctx);
    const q = ctx.query as Record<string, unknown>;
    const siteId = typeof q.site_id === "string" ? q.site_id : null;
    const body = await ctx.tx(async (tx) => {
      // a foreign or unknown site is 404 before anything about the request is judged (C-87)
      if (siteId) await siteExists(tx, tenantId, siteId);
      const t = await tx.maybeOne<{ created_at: Date }>(
        `SELECT created_at FROM scf.tenants WHERE tenant_id = $1`,
        [tenantId],
      );
      if (!t) throw new ApiError("not_found");
      return readAppEvents(tx, tenantId, appEventDays(q, now, t.created_at.getTime()), siteId);
    });
    return { status: 200, body };
  };
  return { getAppEvents };
}
