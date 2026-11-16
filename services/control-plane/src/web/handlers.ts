// SPDX-License-Identifier: Apache-2.0
// Tenant web analytics operations: getWebStats, getWebTimeseries, getWebBreakdown, exportWebDaily (wire-formats §j.3,
// §j.6; data-model §8.9; C-51, C-73, C-95, C-109, C-110, C-112). Every range is split at a UTC midnight into a live
// part (Umami through the adapter, the tenant's own view-only key, 5 s per call) and a rollup part (our tables). A live
// part that cannot be answered — engine timeout or error, tenant not provisioned yet — is answered from the rollups
// (`source: rollup`, `partial_today`). Database work and engine calls never overlap: no transaction is held open
// while the engine is asked.

import { UmamiHttpError, type UmamiReader, UmamiUnavailableError } from "@usagemap/umami-adapter";
import type { UmamiCredsKeys } from "../config.ts";
import type { Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { cpMetrics } from "../obs/metrics.ts";
import { tenantApiKey } from "../umami/credentials.ts";
import {
  type AnonPolicy,
  addTotals,
  anonPolicyOf,
  type BreakdownMap,
  floorPerDay,
  mergeBreakdowns,
  presentBreakdown,
  type Totals,
  totalsView,
  type Variant,
  visitMetrics,
  ZERO,
} from "./figures.ts";
import { liveBreakdown, liveSeries, liveTotals, liveVisitFigures, type Websites } from "./live.ts";
import {
  anonymousSegments,
  bucketOf,
  buckets,
  DAY,
  dayString,
  defaultUnit,
  isMidnight,
  iso,
  type Plan,
  planRange,
  previousSpan,
  resolveWebRange,
  type Span,
  seriesPoints,
  type Unit,
  utcMidnight,
} from "./range.ts";
import {
  type Dimension,
  dailyBreakdown,
  dailyBreakdownByDay,
  dailyTotals,
  hourlyTotals,
  rollupTotals,
} from "./rollup.ts";

/** The live-window calls the web operations use (wire-formats §j.3). */
export type LiveReader = Pick<UmamiReader, "stats" | "pageviews" | "expanded" | "events">;

export interface WebDeps {
  reader: LiveReader | undefined;
  credsKeys: UmamiCredsKeys | undefined;
  /** Clock (tests). */
  now?: () => number;
  /** Warnings about live reads that fell back (ids, reason, status, error class — never a key or a URL). */
  log?: { warn(obj: object, msg: string): void } | undefined;
}

export type LiveFallbackReason =
  | "not_provisioned"
  | "key_unavailable"
  | "unauthorized"
  | "timeout"
  | "engine_error";

/** Why a live read failed: 401/403 = the tenant's key may not read the website (e.g. it is outside the tenant's team). */
export function liveFallbackReason(err: unknown): LiveFallbackReason {
  if (err instanceof UmamiHttpError && (err.status === 401 || err.status === 403))
    return "unauthorized";
  if (err instanceof UmamiUnavailableError) return "timeout";
  return "engine_error";
}

export const VISITOR_NOTE =
  "Unique visitors are per UTC day; over several days they are the sum of daily uniques (the visitor key rotates " +
  "daily). Visits, bounce rate and duration count all identified, non-rejected events.";

interface SiteInfo {
  tenantId: string;
  siteId: string;
  createdAt: number;
  anonymous: boolean;
  websites: Websites;
  liveDays: number;
  apiKey: string | null;
  /** Why there is no key, when there is none. */
  keyProblem: LiveFallbackReason | null;
}

type Source = "live" | "rollup" | "mixed";

interface Echo {
  source: Source;
  liveStart: number | null;
  partialToday: boolean;
}

function rangeEcho(span: Span, echo: Echo, site: SiteInfo): Record<string, unknown> {
  return {
    start: iso(span.start),
    end: iso(span.end),
    source: echo.source,
    live_start: echo.liveStart === null ? null : iso(echo.liveStart),
    partial_today: echo.partialToday,
    timezone: "UTC",
    anonymized: site.anonymous,
    visitor_note: VISITOR_NOTE,
  };
}

function echoOf(plan: Plan, liveOk: boolean, now: number): Echo {
  const fellBack = plan.live !== null && !liveOk;
  const today = utcMidnight(now);
  return {
    source: plan.live === null || fellBack ? "rollup" : plan.rollup === null ? "live" : "mixed",
    liveStart: plan.live && liveOk ? plan.live.start : null,
    partialToday: fellBack && plan.live !== null && plan.live.end > today && plan.live.start < now,
  };
}

function variantOf(q: Record<string, unknown>): Variant {
  return (q.variant as Variant | undefined) ?? "both";
}

/** The C-51 thresholds of the tenant dashboard (settings `tenant_min_count`, `tenant_round_to`). */
export async function tenantAnonPolicy(tx: Tx): Promise<AnonPolicy> {
  const rows = await tx.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM scf.settings WHERE key IN ('tenant_min_count', 'tenant_round_to')`,
  );
  return anonPolicyOf(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

export function webHandlers(deps: WebDeps): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  async function loadSite(ctx: RequestContext): Promise<SiteInfo> {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    // A removed tenant's data is hidden from every view (C-08).
    if (ctx.tenant?.status === "removed") throw new ApiError("not_found");
    return ctx.tx(async (tx) => {
      const s = await tx.maybeOne<{
        created_at: Date;
        anonymous_reports: boolean;
        umami_website_id: string;
        umami_twin_website_id: string | null;
        twin_provisioned_at: Date | null;
      }>(
        `SELECT created_at, anonymous_reports, umami_website_id::text AS umami_website_id,
                umami_twin_website_id::text AS umami_twin_website_id, twin_provisioned_at
           FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`,
        [tenantId, siteId],
      );
      if (!s) throw new ApiError("not_found");
      const l = await tx.one<{ days: number }>(`SELECT scf.web_live_window_days($1, $2) AS days`, [
        tenantId,
        siteId,
      ]);
      let apiKey: string | null = null;
      let keyProblem: LiveFallbackReason | null = null;
      if (deps.reader) {
        try {
          apiKey = await tenantApiKey(tx, deps.credsKeys, tenantId);
          if (!apiKey) keyProblem = "not_provisioned";
        } catch {
          apiKey = null; // undecryptable (key version not configured): answer from the rollups
          keyProblem = "key_unavailable";
        }
      }
      return {
        tenantId,
        siteId,
        createdAt: s.created_at.getTime(),
        anonymous: s.anonymous_reports,
        websites: {
          main: s.umami_website_id,
          twin: s.twin_provisioned_at ? s.umami_twin_website_id : null,
        },
        liveDays: Number(l.days),
        apiKey,
        keyProblem,
      };
    });
  }

  /**
   * A live read that falls back is counted (scf_cp_web_live_fallbacks_total{reason}) and logged at most once a minute
   * per site and reason with ids and the error class only: the 2026-11-13 journey failure (websites outside the tenant's
   * Umami team, every read 401) was invisible because this fallback was silent.
   */
  const lastLogged = new Map<string, number>();
  function fellBack(site: SiteInfo, reason: LiveFallbackReason, err: unknown): void {
    cpMetrics.liveFallback(reason);
    const k = `${site.siteId}:${reason}`;
    const now = Date.now();
    if ((lastLogged.get(k) ?? 0) > now - 60_000) return;
    if (lastLogged.size > 10_000) lastLogged.clear();
    lastLogged.set(k, now);
    deps.log?.warn(
      {
        tenant_id: site.tenantId,
        site_id: site.siteId,
        reason,
        ...(err instanceof UmamiHttpError ? { status: err.status } : {}),
        ...(err instanceof Error ? { error_class: err.name } : {}),
      },
      "web live read answered from the rollups",
    );
  }

  /** Runs `fn` against the engine when it can be asked; null = answer from the rollups instead (C-112(6)). */
  async function tryLive<T>(
    site: SiteInfo,
    fn: (r: LiveReader, key: string) => Promise<T>,
  ): Promise<T | null> {
    if (!deps.reader) return null;
    if (!site.apiKey) {
      fellBack(site, site.keyProblem ?? "not_provisioned", undefined);
      return null;
    }
    try {
      return await fn(deps.reader, site.apiKey);
    } catch (err) {
      fellBack(site, liveFallbackReason(err), err);
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ totals

  async function totalsFor(ctx: RequestContext, site: SiteInfo, plan: Plan, now: number) {
    let t: Totals = { ...ZERO };
    let liveOk = true;
    if (plan.live) {
      const live = plan.live;
      const r = await tryLive(site, (rd, key) => liveTotals(rd, key, site.websites, live));
      if (r) t = addTotals(t, r);
      else liveOk = false;
    }
    const rollupSpans = [plan.rollup, liveOk ? null : plan.live].filter(
      (x): x is Span => x !== null,
    );
    if (rollupSpans.length > 0) {
      const parts = await ctx.tx(async (tx) => {
        let acc: Totals = { ...ZERO };
        for (const s of rollupSpans)
          acc = addTotals(acc, await rollupTotals(tx, site.tenantId, site.siteId, s, now));
        return acc;
      });
      t = addTotals(t, parts);
    }
    return { totals: t, echo: echoOf(plan, liveOk, now) };
  }

  const getWebStats: Handler = async (ctx) => {
    const now = clock();
    const site = await loadSite(ctx);
    const span = resolveWebRange(ctx.query, now, site.createdAt);
    const plan = planRange(span, site.liveDays, now);
    const variant = variantOf(ctx.query);
    const main = await totalsFor(ctx, site, plan, now);
    const body: Record<string, unknown> = {
      range: rangeEcho(span, main.echo, site),
      ...totalsView(main.totals, variant),
      visit_metrics: visitMetrics(main.totals),
    };
    if (ctx.query.compare === "previous") {
      let prevPlan: Plan | null = null;
      try {
        prevPlan = planRange(previousSpan(span), site.liveDays, now);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
      }
      if (prevPlan) {
        const prev = await totalsFor(ctx, site, prevPlan, now);
        body.previous = {
          ...totalsView(prev.totals, variant),
          visit_metrics: visitMetrics(prev.totals),
        };
        body.comparison_unavailable = false;
      } else {
        body.previous = null;
        body.comparison_unavailable = true;
      }
    }
    return { status: 200, body, headers: { "x-scf-source": main.echo.source } };
  };

  // ------------------------------------------------------------------------------------------------ series

  const VISIT_ONLY = new Set(["visits", "bounces", "bounce_rate_pct", "avg_visit_duration_s"]);

  /**
   * Bucketed totals over the plan. Page views and visitors: rollup part from hourly/daily rows, live part from R2
   * (hour or day; months composed from days). Visit figures (when `visits`): complete days from `web_daily_totals`,
   * today and any partial day from a live R1 call (today's daily row on failure) — C-112(4).
   */
  async function seriesFor(
    ctx: RequestContext,
    site: SiteInfo,
    plan: Plan,
    unit: Unit,
    need: { verified: boolean; raw: boolean; visits: boolean },
    now: number,
  ) {
    const span = plan.span;
    const out = new Map<number, Totals>();
    for (const b of buckets(span, unit)) out.set(b, { ...ZERO });
    const add = (t: number, v: Totals, pvOnly = true) => {
      const b = bucketOf(t, unit);
      const cur = out.get(b);
      if (!cur) return;
      out.set(b, addTotals(cur, pvOnly ? { ...v, visits: 0, bounces: 0, durationS: 0 } : v));
    };
    let liveOk = true;
    let liveRows: Map<number, Totals> | null = null;
    if (plan.live) {
      const live = plan.live;
      liveRows = await tryLive(site, (rd, key) =>
        liveSeries(rd, key, site.websites, live, unit === "hour" ? "hour" : "day", need),
      );
      if (!liveRows) liveOk = false;
    }
    const rollupSpans = [plan.rollup, liveOk ? null : plan.live].filter(
      (x): x is Span => x !== null,
    );
    const today = utcMidnight(now);
    const visitDays: number[] = [];
    if (need.visits) {
      for (let d = utcMidnight(span.start); d < span.end && d <= today; d += DAY) visitDays.push(d);
    }
    const db = await ctx.tx(async (tx) => {
      const rows: Array<Map<number, Totals>> = [];
      for (const s of rollupSpans) {
        rows.push(
          unit === "hour"
            ? await hourlyTotals(tx, site.tenantId, site.siteId, s)
            : // whole days only (a leading partial day of a fallen-back live part has no daily row of its own);
              // today's row stands for today up to now
              await dailyTotals(tx, site.tenantId, site.siteId, {
                start: isMidnight(s.start) ? s.start : utcMidnight(s.start) + DAY,
                end: s.end >= now ? today + DAY : s.end,
              }),
        );
      }
      const daily =
        visitDays.length > 0
          ? await dailyTotals(tx, site.tenantId, site.siteId, {
              start: visitDays[0] as number,
              end: (visitDays[visitDays.length - 1] as number) + DAY,
            })
          : new Map<number, Totals>();
      return { rows, daily };
    });
    for (const m of db.rows) for (const [t, v] of m) add(t, v);
    if (liveRows) for (const [t, v] of liveRows) add(t, v);
    // Visit figures per day.
    for (const d of visitDays) {
      const whole = d >= span.start && d + DAY <= span.end && d < today;
      let fig: Pick<Totals, "visits" | "bounces" | "durationS"> | null = null;
      if (whole) {
        fig = db.daily.get(d) ?? null;
      } else {
        const part = { start: Math.max(d, span.start), end: Math.min(d + DAY, span.end, now) };
        if (part.end > part.start)
          fig = await tryLive(site, (rd, key) => liveVisitFigures(rd, key, site.websites, part));
        if (!fig && d === today) {
          fig = db.daily.get(d) ?? null;
          if (plan.live) liveOk = false;
        }
      }
      if (fig)
        add(
          d,
          { ...ZERO, visits: fig.visits, bounces: fig.bounces, durationS: fig.durationS },
          false,
        );
    }
    return { points: out, echo: echoOf(plan, liveOk, now) };
  }

  function seriesNeed(variant: Variant, metrics: string[]) {
    const share = metrics.includes("suspect_pageview_share");
    return {
      verified: variant !== "raw" || share,
      raw: variant !== "verified" || share,
      visits: metrics.some((m) => VISIT_ONLY.has(m)),
    };
  }

  const getWebTimeseries: Handler = async (ctx) => {
    const now = clock();
    const site = await loadSite(ctx);
    const span = resolveWebRange(ctx.query, now, site.createdAt);
    const unit = (ctx.query.unit as Unit | undefined) ?? defaultUnit(span);
    const metrics = (ctx.query.metrics as string[] | undefined) ?? ["pageviews", "visitors"];
    if (unit === "hour" && metrics.some((m) => VISIT_ONLY.has(m))) {
      throw new ApiError("validation_failed", "visit metrics exist for unit=day|month only", {
        errors: [
          { pointer: "/metrics", detail: "visit metrics exist for unit=day|month only (C-112)" },
        ],
      });
    }
    if (unit === "hour") {
      const d = new Date(utcMidnight(now));
      if (span.start < Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 25, d.getUTCDate()))
        throw new ApiError("validation_failed", "hourly series exist for the last 25 months only", {
          errors: [{ pointer: "/unit", detail: "hourly series exist for the last 25 months only" }],
        });
    }
    // Bounded number of points (400 before any engine or database read).
    seriesPoints(span, unit);
    const variant = variantOf(ctx.query);
    const plan = planRange(span, site.liveDays, now, unit !== "hour");
    const { points, echo } = await seriesFor(
      ctx,
      site,
      plan,
      unit,
      seriesNeed(variant, metrics),
      now,
    );
    const want = (m: string) => metrics.includes(m);
    const point = (t: number, v: Totals, which: "verified" | "raw") => {
      const p: Record<string, unknown> = { t: iso(t) };
      if (want("pageviews")) p.pageviews = which === "verified" ? v.pvVerified : v.pvRaw;
      if (want("pageviews_unidentified"))
        p.pageviews_unidentified = which === "verified" ? v.pvUnidVerified : v.pvUnidRaw;
      if (want("visitors")) p.visitors = which === "verified" ? v.visitorsVerified : v.visitorsRaw;
      return p;
    };
    const entries = [...points.entries()].sort(([a], [b]) => a - b);
    const body: Record<string, unknown> = { range: rangeEcho(span, echo, site), unit };
    if (want("pageviews") || want("pageviews_unidentified") || want("visitors")) {
      if (variant !== "raw") body.verified = entries.map(([t, v]) => point(t, v, "verified"));
      if (variant !== "verified") body.raw = entries.map(([t, v]) => point(t, v, "raw"));
    }
    const visitWanted = metrics.filter((m) => VISIT_ONLY.has(m) || m === "suspect_pageview_share");
    if (visitWanted.length > 0) {
      body.visit_metrics = entries.map(([t, v]) => {
        const vm = visitMetrics(v) as unknown as Record<string, unknown>;
        const p: Record<string, unknown> = { t: iso(t) };
        for (const m of visitWanted) p[m] = vm[m];
        return p;
      });
    }
    return { status: 200, body, headers: { "x-scf-source": echo.source } };
  };

  // ------------------------------------------------------------------------------------------------ breakdown

  const getWebBreakdown: Handler = async (ctx) => {
    const now = clock();
    const site = await loadSite(ctx);
    const span = resolveWebRange(ctx.query, now, site.createdAt);
    const plan = planRange(span, site.liveDays, now);
    const variant = variantOf(ctx.query);
    const dimension = ctx.query.dimension as Dimension;
    const limit = Number(ctx.query.limit ?? 20);
    const variants = (["verified", "raw"] as const).filter(
      (v) => variant === "both" || variant === v,
    );
    if (site.anonymous) return anonymousBreakdown(ctx, site, plan, dimension, limit, variants, now);
    const live: Partial<Record<"verified" | "raw", BreakdownMap>> = {};
    let liveOk = true;
    if (plan.live) {
      const lp = plan.live;
      const r = await tryLive(site, async (rd, key) => {
        const res = await Promise.all(
          variants.map((v) => liveBreakdown(rd, key, site.websites, lp, dimension, v)),
        );
        return res;
      });
      if (r) {
        variants.forEach((v, i) => {
          live[v] = r[i] as BreakdownMap;
        });
      } else liveOk = false;
    }
    const today = utcMidnight(now);
    const rollupSpans: Span[] = [];
    if (plan.rollup) rollupSpans.push(plan.rollup);
    if (!liveOk && plan.live) {
      // Fallback: whole days of the live part (today's row stands for today); a leading partial day has no rows.
      const s = isMidnight(plan.live.start) ? plan.live.start : utcMidnight(plan.live.start) + DAY;
      const e = plan.live.end >= now ? today + DAY : utcMidnight(plan.live.end);
      if (e > s) rollupSpans.push({ start: s, end: e });
    }
    const fromRollup = await ctx.tx(async (tx) => {
      const out: Partial<Record<"verified" | "raw", BreakdownMap>> = {};
      for (const v of variants) {
        let m: BreakdownMap = new Map();
        for (const s of rollupSpans)
          m = mergeBreakdowns(
            m,
            await dailyBreakdown(tx, site.tenantId, site.siteId, s, dimension, v, now),
          );
        out[v] = m;
      }
      return out;
    });
    const echo = echoOf(plan, liveOk, now);
    const body: Record<string, unknown> = {
      range: rangeEcho(span, echo, site),
      dimension,
      truncated: rollupSpans.length > 0,
    };
    for (const v of variants) {
      const merged = mergeBreakdowns(fromRollup[v] ?? new Map(), live[v] ?? new Map());
      body[v] = presentBreakdown(merged, {
        limit,
        anonymous: site.anonymous,
        byEvents: dimension === "event",
      });
    }
    return { status: 200, body, headers: { "x-scf-source": echo.source } };
  };

  /**
   * The anonymous-reports breakdown (C-51) with the minimum count applied per UTC day:
   * whole past days from the daily rollup rows, one row set per day; partial days (a mid-day start, today) live, one
   * engine read per day (at most two); a partial day whose live read fails is answered by its daily row when it is
   * today and omitted otherwise (as in the non-anonymous fallback). Each day's rows are floored on their own before
   * summing, then presented with the tenant thresholds (settings `tenant_min_count`, `tenant_round_to`; #13).
   */
  async function anonymousBreakdown(
    ctx: RequestContext,
    site: SiteInfo,
    plan: Plan,
    dimension: Dimension,
    limit: number,
    variants: ReadonlyArray<"verified" | "raw">,
    now: number,
  ) {
    const seg = anonymousSegments(plan, now);
    const today = utcMidnight(now);
    const live: Record<"verified" | "raw", BreakdownMap[]> = { verified: [], raw: [] };
    let liveOk = true;
    const fallbackDays: Span[] = [];
    for (const part of seg.live) {
      const r = await tryLive(site, (rd, key) =>
        Promise.all(variants.map((v) => liveBreakdown(rd, key, site.websites, part, dimension, v))),
      );
      if (r) {
        variants.forEach((v, i) => {
          live[v].push(r[i] as BreakdownMap);
        });
      } else {
        liveOk = false;
        if (utcMidnight(part.start) === today)
          fallbackDays.push({ start: today, end: today + DAY });
      }
    }
    const db = await ctx.tx(async (tx) => {
      const policy = await tenantAnonPolicy(tx);
      const days: Record<"verified" | "raw", BreakdownMap[]> = { verified: [], raw: [] };
      for (const v of variants)
        for (const s of [seg.rollup, ...fallbackDays])
          if (s)
            days[v].push(
              ...(await dailyBreakdownByDay(tx, site.tenantId, site.siteId, s, dimension, v)),
            );
      return { policy, days };
    });
    const usedRollup = seg.rollup !== null || fallbackDays.length > 0;
    const anyLive = seg.live.length > 0 && liveOk;
    const echo: Echo = {
      source: !anyLive ? "rollup" : usedRollup ? "mixed" : "live",
      liveStart: anyLive ? (seg.live[0]?.start ?? null) : null,
      partialToday: !liveOk && plan.span.end > today && plan.span.start < now,
    };
    const body: Record<string, unknown> = {
      range: rangeEcho(plan.span, echo, site),
      dimension,
      truncated: usedRollup,
    };
    for (const v of variants) {
      const floored = floorPerDay(
        [...db.days[v], ...live[v]],
        db.policy.minCount,
        dimension === "event",
      );
      body[v] = presentBreakdown(floored.rows, {
        limit,
        anonymous: true,
        byEvents: dimension === "event",
        policy: db.policy,
        suppressed: floored.suppressed,
      });
    }
    return { status: 200, body, headers: { "x-scf-source": echo.source } };
  }

  // ------------------------------------------------------------------------------------------------ export

  const CSV_COLUMNS = [
    "day",
    "pageviews_verified",
    "pageviews_raw",
    "pageviews_unidentified_verified",
    "pageviews_unidentified_raw",
    "visitors_verified",
    "visitors_raw",
    "visits",
    "bounces",
    "bounce_rate_pct",
    "avg_visit_duration_s",
    "suspect_pageview_share",
  ];

  const exportWebDaily: Handler = async (ctx) => {
    const now = clock();
    const site = await loadSite(ctx);
    const span = resolveWebRange(ctx.query, now, site.createdAt);
    // One row per UTC day: the range must start at a UTC midnight and end at one (or now, for today).
    if (!isMidnight(span.start))
      throw new ApiError(
        "validation_failed",
        "the export is per UTC day: start must be 00:00 UTC",
        {
          errors: [{ pointer: "/start", detail: "must be 00:00 UTC" }],
        },
      );
    if (!isMidnight(span.end) && span.end < now)
      throw new ApiError("validation_failed", "the export is per UTC day: end must be 00:00 UTC", {
        errors: [{ pointer: "/end", detail: "must be 00:00 UTC" }],
      });
    const plan = planRange(span, site.liveDays, now);
    const { points, echo } = await seriesFor(
      ctx,
      site,
      plan,
      "day",
      { verified: true, raw: true, visits: true },
      now,
    );
    const lines = [CSV_COLUMNS.join(",")];
    for (const [t, v] of [...points.entries()].sort(([a], [b]) => a - b)) {
      if (t > now) continue;
      const vm = visitMetrics(v);
      const cell = (x: number | null) => (x === null ? "" : String(x));
      lines.push(
        [
          dayString(t),
          v.pvVerified,
          v.pvRaw,
          v.pvUnidVerified,
          v.pvUnidRaw,
          v.visitorsVerified,
          v.visitorsRaw,
          vm.visits,
          vm.bounces,
          cell(vm.bounce_rate_pct),
          cell(vm.avg_visit_duration_s),
          cell(vm.suspect_pageview_share),
        ].join(","),
      );
    }
    return {
      status: 200,
      body: `${lines.join("\n")}\n`,
      contentType: "text/csv; charset=utf-8",
      headers: {
        "x-scf-source": echo.source,
        "x-scf-anonymized": String(site.anonymous),
        "content-disposition": `attachment; filename="web-daily-${dayString(span.start)}.csv"`,
      },
    };
  };

  return { getWebStats, getWebTimeseries, getWebBreakdown, exportWebDaily };
}
