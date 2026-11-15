// SPDX-License-Identifier: Apache-2.0
// Live-window reads R1–R8 with the tenant's own view-only API key (wire-formats §j.3, C-73, C-99, C-109, C-112(6)).
//
// Rules implemented here (and only here):
// - every range is [start, end) (C-86); Umami's endAt is inclusive, so endAt = end − 1 ms (C-99);
// - `timezone=UTC` always, `period` never;
// - verified = `tag=v`; raw = no tag parameter;
// - visits, bounces and totaltime come from ONE unfiltered R1 call on the main website and are never added across
//   responses for the same days (not across tags, not main + twin);
// - numbers may arrive as JSON strings (R4) and are parsed as number-or-string;
// - every call has a 5 s timeout; a timeout or connection error is a UmamiUnavailableError, the signal for the caller
//   to answer from the rollups instead (C-112(6)).
// - the report reads R6–R8 (funnel, goal, journey; Umami 3.5.0's ad-hoc GET routes, nothing is stored in Umami) follow
//   the same range, timezone, tag and timeout rules; they have no rollup, so a failure is the caller's 503. They read the
//   main website only (twin events carry no visit) and return aggregates only — never a session or visitor id.

import { HttpClient, type HttpClientOptions, UmamiError } from "./http.ts";

export interface Range {
  /** inclusive, ms since epoch (UTC) */
  start: number;
  /** exclusive, ms since epoch (UTC) */
  end: number;
}

export type Variant = "verified" | "raw";
export type ExpandedType = "referrer" | "country" | "device" | "browser" | "os" | "path";
export type Unit = "hour" | "day";

export interface StatsResult {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}

export interface SeriesPoint {
  /** bucket start, ISO time as Umami returns it */
  x: string;
  y: number;
}

export interface PageviewsResult {
  pageviews: SeriesPoint[];
  sessions: SeriesPoint[];
}

export interface EventRow {
  name: string;
  events: number;
}

export interface ExpandedRow {
  name: string;
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}

export type ReportStepType = "path" | "event";

/** A funnel step or goal: a page path (`*` = any run of characters, Umami's wildcard) or a custom event name. */
export interface ReportStep {
  type: ReportStepType;
  value: string;
}

export interface FunnelStepResult extends ReportStep {
  /** distinct sessions that reached this step in order */
  visitors: number;
}

export interface GoalResult {
  /** distinct sessions that reached the goal */
  visitors: number;
  /** distinct sessions with any event in the range */
  total: number;
}

export interface JourneyOptions {
  /** number of leading events of a visit, 2–7 */
  steps: number;
  /** only visits whose first item is this path or event name */
  startStep?: string | undefined;
  /** only visits whose last item (within `steps`) is this path or event name */
  endStep?: string | undefined;
}

export interface JourneyRow {
  /** page paths and custom event names in order */
  items: string[];
  /** visits that followed this sequence */
  count: number;
}

export const FUNNEL_MIN_STEPS = 2;
export const FUNNEL_MAX_STEPS = 8;
export const FUNNEL_MAX_WINDOW = 1440;
export const JOURNEY_MIN_STEPS = 2;
export const JOURNEY_MAX_STEPS = 7;
export const REPORT_VALUE_MAX = 500;

/** True when `v` contains a C0 control character or DEL. */
export function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function checkValue(v: string): void {
  if (typeof v !== "string" || v.length < 1 || v.length > REPORT_VALUE_MAX || hasControlChar(v))
    throw new RangeError(
      `a step value must be 1–${REPORT_VALUE_MAX} characters without control characters`,
    );
}

function checkSteps(steps: readonly ReportStep[], min: number, max: number): void {
  if (!Array.isArray(steps) || steps.length < min || steps.length > max)
    throw new RangeError(`between ${min} and ${max} steps`);
  for (const s of steps) {
    if (s.type !== "path" && s.type !== "event")
      throw new RangeError("step type must be path or event");
    checkValue(s.value);
  }
}

/** Parses a JSON number or a numeric string (R4 sends `"pageviews":"4"`, S-01). Anything else is an error. */
export function toNumber(v: unknown, field: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  if (v === null || v === undefined) return 0;
  throw new UmamiError(`umami field ${field} is not numeric`, "GET", "read");
}

/** Query parameters common to every read: startAt, endAt = end − 1 ms, timezone=UTC, optional tag=v. */
export function rangeParams(range: Range, variant: Variant): Record<string, string | number> {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.end <= range.start) {
    throw new RangeError("range must be integer ms with end > start");
  }
  const p: Record<string, string | number> = {
    startAt: range.start,
    endAt: range.end - 1,
    timezone: "UTC",
  };
  if (variant === "verified") p.tag = "v";
  return p;
}

function uuid(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new RangeError("website id must be a UUID");
  }
  return id.toLowerCase();
}

export class UmamiReader {
  readonly #http: HttpClient;

  constructor(opts: HttpClientOptions | HttpClient) {
    this.#http = opts instanceof HttpClient ? opts : new HttpClient(opts);
  }

  /** R1 `/stats`. With `verified` only pageviews and visitors are meaningful (C-73): callers must not use the rest. */
  async stats(
    apiKey: string,
    websiteId: string,
    range: Range,
    variant: Variant,
  ): Promise<StatsResult> {
    const body = (await this.#http.expect({
      method: "GET",
      path: `/api/websites/${uuid(websiteId)}/stats`,
      template: "/api/websites/{websiteId}/stats",
      bearer: apiKey,
      query: rangeParams(range, variant),
    })) as Record<string, unknown>;
    return {
      pageviews: toNumber(body.pageviews, "pageviews"),
      visitors: toNumber(body.visitors, "visitors"),
      visits: toNumber(body.visits, "visits"),
      bounces: toNumber(body.bounces, "bounces"),
      totaltime: toNumber(body.totaltime, "totaltime"),
    };
  }

  /** R2 `/pageviews` with `unit` hour or day. */
  async pageviews(
    apiKey: string,
    websiteId: string,
    range: Range,
    unit: Unit,
    variant: Variant,
  ): Promise<PageviewsResult> {
    const body = (await this.#http.expect({
      method: "GET",
      path: `/api/websites/${uuid(websiteId)}/pageviews`,
      template: "/api/websites/{websiteId}/pageviews",
      bearer: apiKey,
      query: { ...rangeParams(range, variant), unit },
    })) as { pageviews?: unknown; sessions?: unknown };
    const series = (v: unknown, field: string): SeriesPoint[] =>
      (Array.isArray(v) ? v : []).map((p: { x?: unknown; y?: unknown }) => ({
        x: String(p.x),
        y: toNumber(p.y, field),
      }));
    return {
      pageviews: series(body.pageviews, "pageviews.y"),
      sessions: series(body.sessions, "sessions.y"),
    };
  }

  /** R3 `/metrics?type=event`: events per event name (`y` = count(*)). */
  async events(
    apiKey: string,
    websiteId: string,
    range: Range,
    variant: Variant,
    limit = 500,
  ): Promise<EventRow[]> {
    const body = await this.#http.expect({
      method: "GET",
      path: `/api/websites/${uuid(websiteId)}/metrics`,
      template: "/api/websites/{websiteId}/metrics",
      bearer: apiKey,
      query: {
        ...rangeParams(range, variant),
        type: "event",
        limit: Math.min(Math.max(1, limit), 500),
      },
    });
    return (Array.isArray(body) ? body : []).map((r: { x?: unknown; y?: unknown }) => ({
      name: String(r.x ?? ""),
      events: toNumber(r.y, "y"),
    }));
  }

  /** R4 `/metrics/expanded`. Numbers may be strings. */
  async expanded(
    apiKey: string,
    websiteId: string,
    range: Range,
    type: ExpandedType,
    variant: Variant,
    limit = 500,
  ): Promise<ExpandedRow[]> {
    const body = await this.#http.expect({
      method: "GET",
      path: `/api/websites/${uuid(websiteId)}/metrics/expanded`,
      template: "/api/websites/{websiteId}/metrics/expanded",
      bearer: apiKey,
      query: { ...rangeParams(range, variant), type, limit: Math.min(Math.max(1, limit), 500) },
    });
    return (Array.isArray(body) ? body : []).map((r: Record<string, unknown>) => ({
      name: String(r.name ?? ""),
      pageviews: toNumber(r.pageviews, "pageviews"),
      visitors: toNumber(r.visitors, "visitors"),
      visits: toNumber(r.visits, "visits"),
      bounces: toNumber(r.bounces, "bounces"),
      totaltime: toNumber(r.totaltime, "totaltime"),
    }));
  }

  /**
   * R6 `/funnels/stats` (ad-hoc funnel, nothing stored in Umami): distinct sessions reaching each step in order, each
   * step within `windowMinutes` of the previous one. Umami applies the range and `tag` to the FIRST step only (later
   * steps join the session's events of any tag inside the range), so a verified funnel is "first step verified".
   */
  async funnel(
    apiKey: string,
    websiteId: string,
    range: Range,
    steps: readonly ReportStep[],
    windowMinutes: number,
    variant: Variant,
  ): Promise<FunnelStepResult[]> {
    checkSteps(steps, FUNNEL_MIN_STEPS, FUNNEL_MAX_STEPS);
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > FUNNEL_MAX_WINDOW)
      throw new RangeError(`window must be an integer 1–${FUNNEL_MAX_WINDOW} minutes`);
    const template = "/api/websites/{websiteId}/funnels/stats";
    const body = await this.#http.expect({
      method: "GET",
      path: `/api/websites/${uuid(websiteId)}/funnels/stats`,
      template,
      bearer: apiKey,
      query: {
        ...rangeParams(range, variant),
        window: windowMinutes,
        steps: JSON.stringify(steps.map((s) => ({ type: s.type, value: s.value }))),
      },
    });
    if (!Array.isArray(body) || body.length !== steps.length)
      throw new UmamiError("umami funnel answer does not match the steps", "GET", template);
    return steps.map((s, i) => ({
      type: s.type,
      value: s.value,
      visitors: toNumber((body[i] as Record<string, unknown> | null)?.visitors, "visitors"),
    }));
  }

  /**
   * R7 `/goals/stats` (ad-hoc goal): `visitors` = distinct sessions with a page view of the path (`path`) or a custom
   * event of the name (`event`); `total` = distinct sessions with any event in the range. `tag` applies to both.
   */
  async goal(
    apiKey: string,
    websiteId: string,
    range: Range,
    goal: ReportStep,
    variant: Variant,
  ): Promise<GoalResult> {
    checkSteps([goal], 1, 1);
    const body = (await this.#http.expect({
      method: "GET",
      path: `/api/websites/${uuid(websiteId)}/goals/stats`,
      template: "/api/websites/{websiteId}/goals/stats",
      bearer: apiKey,
      query: { ...rangeParams(range, variant), type: goal.type, value: goal.value },
    })) as Record<string, unknown> | null;
    return { visitors: toNumber(body?.num, "num"), total: toNumber(body?.total, "total") };
  }

  /**
   * R8 `/journeys`: the 100 most frequent sequences of the first `steps` events of a visit (`(session, visit)`), each
   * item a custom event name or else the page path, consecutive repeats collapsed by Umami. `count` = visits.
   */
  async journey(
    apiKey: string,
    websiteId: string,
    range: Range,
    opts: JourneyOptions,
    variant: Variant,
  ): Promise<JourneyRow[]> {
    if (
      !Number.isInteger(opts.steps) ||
      opts.steps < JOURNEY_MIN_STEPS ||
      opts.steps > JOURNEY_MAX_STEPS
    )
      throw new RangeError(`steps must be an integer ${JOURNEY_MIN_STEPS}–${JOURNEY_MAX_STEPS}`);
    for (const v of [opts.startStep, opts.endStep]) if (v !== undefined) checkValue(v);
    const body = await this.#http.expect({
      method: "GET",
      path: `/api/websites/${uuid(websiteId)}/journeys`,
      template: "/api/websites/{websiteId}/journeys",
      bearer: apiKey,
      query: {
        ...rangeParams(range, variant),
        steps: opts.steps,
        startStep: opts.startStep,
        endStep: opts.endStep,
      },
    });
    return (Array.isArray(body) ? body : []).map((r: { items?: unknown; count?: unknown }) => ({
      // Shorter visits leave trailing nulls (one per missing step); they are not items.
      items: (Array.isArray(r.items) ? r.items : []).filter(
        (x): x is string => typeof x === "string",
      ),
      count: toNumber(r.count, "count"),
    }));
  }

  /** R5 `/api/heartbeat`. */
  async heartbeat(): Promise<boolean> {
    try {
      const res = await this.#http.call({
        method: "GET",
        path: "/api/heartbeat",
        template: "/api/heartbeat",
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * The C-73 figures of one site over a live range, with the calls of the §j.3 table:
   * two R1 calls on M (verified; raw, whose visit fields are the one visit figure) and, with a twin, two on T.
   */
  async siteTotals(apiKey: string, site: SiteWebsites, range: Range): Promise<LiveTotals> {
    const calls: Array<Promise<StatsResult | null>> = [
      this.stats(apiKey, site.main, range, "verified"),
      this.stats(apiKey, site.main, range, "raw"),
      site.twin ? this.stats(apiKey, site.twin, range, "verified") : Promise.resolve(null),
      site.twin ? this.stats(apiKey, site.twin, range, "raw") : Promise.resolve(null),
    ];
    const [mv, mr, tv, tr] = await Promise.all(calls);
    return composeTotals(mv as StatsResult, mr as StatsResult, tv ?? null, tr ?? null);
  }
}

/**
 * Month buckets composed from day buckets (the engine proxy's reader allow-list permits R2 `unit` = hour|day only).
 * Page views and sessions per day are additive across days (sessions never cross 00:00 UTC, C-110), so a month is the
 * sum of its days. `x` becomes the first day of the UTC month.
 */
export function monthlyFromDaily(points: readonly SeriesPoint[]): SeriesPoint[] {
  const sums = new Map<string, number>();
  for (const p of points) {
    const d = new Date(p.x);
    if (Number.isNaN(d.getTime()))
      throw new UmamiError("bad bucket time", "GET", "/api/websites/{websiteId}/pageviews");
    const key = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
    sums.set(key, (sums.get(key) ?? 0) + p.y);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([x, y]) => ({ x, y }));
}

export interface SiteWebsites {
  main: string;
  /** null until the twin is provisioned (C-73). */
  twin: string | null;
}

export interface LiveTotals {
  pageviews: { verified: number; raw: number };
  /** the twin's page views (also included in `pageviews`) */
  pageviewsUnidentified: { verified: number; raw: number };
  visitors: { verified: number; raw: number };
  /** one figure each, from the unfiltered main-website call only (C-73) */
  visits: number;
  bounces: number;
  totaltimeSeconds: number;
  /** 1 − verified ÷ raw page views; null without page views */
  suspectPageviewShare: number | null;
}

/**
 * Pure composition of the §j.3 table. `mainVerified`'s visit fields are ignored (a tag-filtered call is never used for
 * visits, bounces or totaltime); the twin contributes page views only.
 */
export function composeTotals(
  mainVerified: StatsResult,
  mainRaw: StatsResult,
  twinVerified: StatsResult | null,
  twinRaw: StatsResult | null,
): LiveTotals {
  const tv = twinVerified?.pageviews ?? 0;
  const tr = twinRaw?.pageviews ?? 0;
  const pvVerified = mainVerified.pageviews + tv;
  const pvRaw = mainRaw.pageviews + tr;
  return {
    pageviews: { verified: pvVerified, raw: pvRaw },
    pageviewsUnidentified: { verified: tv, raw: tr },
    visitors: { verified: mainVerified.visitors, raw: mainRaw.visitors },
    visits: mainRaw.visits,
    bounces: mainRaw.bounces,
    totaltimeSeconds: mainRaw.totaltime,
    suspectPageviewShare: pvRaw > 0 ? 1 - pvVerified / pvRaw : null,
  };
}
