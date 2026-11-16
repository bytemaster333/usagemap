// SPDX-License-Identifier: Apache-2.0
// Tenant web reports read from the engine: getWebFunnelReport, getWebGoalsReport, getWebJourneyReport (wire-formats
// §j.3 R6–R8; C-51, C-87, C-109, C-110, C-112(6)). Each is one or a few ad-hoc GET calls on the site's MAIN website with
// the tenant's own view-only key (the twin's events carry no visit and cannot form a funnel or journey).
//
// - Reports have no rollup: they cover the site's live window only (the part of a range before it is left out and
//   echoed as `range.truncated`; a range wholly before it is 400), and an engine that cannot answer is 503.
// - Order of checks: the site (a foreign, unknown or malformed site is 404 before anything about the request is judged,
//   C-87) → the report parameters → the range → the engine.
// - Privacy: aggregates only, never a session, visit or visitor id. Funnel and goal counts follow the site's
//   `anonymous_reports` (C-51: below the minimum count → null, otherwise rounded); journeys are ALWAYS floored at the
//   minimum count (a rare path could single a visitor out) and rounded with `anonymous_reports`.
// - Step parameters are page paths (normalised like tracked paths, no query strings or fragments, no Stellar addresses)
//   or custom event names (the gateway's event-name alphabet), each optionally with Umami's `*` wildcard.

import {
  type FunnelStepResult,
  type GoalResult,
  type JourneyOptions,
  type JourneyRow,
  type ReportStep,
  UmamiHttpError,
  type UmamiReader,
  UmamiUnavailableError,
} from "@usagemap/umami-adapter";
import type { UmamiCredsKeys } from "../config.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { cpMetrics } from "../obs/metrics.ts";
import { tenantApiKey } from "../umami/credentials.ts";
import type { AnonPolicy } from "./figures.ts";
import { tenantAnonPolicy } from "./handlers.ts";
import { iso, planRange, resolveWebRange, type Span } from "./range.ts";

/** The engine calls the reports use (wire-formats §j.3 R6–R8). */
export type ReportReader = Pick<UmamiReader, "funnel" | "goal" | "journey">;

export interface ReportDeps {
  reader: ReportReader | undefined;
  credsKeys: UmamiCredsKeys | undefined;
  now?: (() => number) | undefined;
  log?: { warn(obj: object, msg: string): void } | undefined;
}

export const FUNNEL_STEPS = { min: 2, max: 8 } as const;
export const GOALS = { min: 1, max: 5 } as const;
export const DEFAULT_WINDOW_MIN = 60;
export const DEFAULT_JOURNEY_STEPS = 4;
const PATH_MAX = 500;
const EVENT_MAX = 50;
const RETRY_AFTER_S = 30;

function bad(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

// ------------------------------------------------------------------------------------------- step parameters

/** The gateway's event-name alphabet (`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`, 1–50) plus Umami's `*` wildcard. */
const EVENT_RE = /^[A-Za-z0-9*][A-Za-z0-9_.:*-]*$/;
/** A whole path segment that is a Stellar StrKey (accounts, muxed accounts, contracts, seeds…): never a step value. */
const STRKEY_SEGMENT = /^[GMSCLBTXPW][A-Z2-7]{55}([A-Z2-7]{13})?$/;

function hasControlOrSpace(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Parses `path:<page path>` or `event:<event name>` (funnel steps, goals, journey start/end). Paths are normalised the
 * way the gateway normalises tracked paths (repeated slashes collapsed, trailing slash removed, root stays `/`); a query
 * string, fragment, whitespace, control character or a Stellar address segment is refused, never stripped.
 */
export function parseStep(raw: unknown, pointer: string): ReportStep {
  if (typeof raw !== "string") throw bad(pointer, "expected path:<page path> or event:<name>");
  const i = raw.indexOf(":");
  const kind = i > 0 ? raw.slice(0, i) : "";
  const value = i > 0 ? raw.slice(i + 1) : "";
  if (kind === "event") {
    if (value.length < 1 || value.length > EVENT_MAX || !EVENT_RE.test(value))
      throw bad(
        pointer,
        `an event name is 1–${EVENT_MAX} characters of A–Z, a–z, 0–9, _ . : - (and * as a wildcard)`,
      );
    return { type: "event", value };
  }
  if (kind !== "path") throw bad(pointer, "expected path:<page path> or event:<name>");
  if (!value.startsWith("/")) throw bad(pointer, "a page path starts with /");
  if (value.includes("?") || value.includes("#"))
    throw bad(pointer, "a page path has no query string or fragment (C-65)");
  if (hasControlOrSpace(value))
    throw bad(pointer, "a page path has no spaces or control characters");
  let p = value.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p.length > PATH_MAX) throw bad(pointer, `a page path is at most ${PATH_MAX} characters`);
  if (p.split("/").some((seg) => STRKEY_SEGMENT.test(seg)))
    throw bad(
      pointer,
      "tracked paths never contain Stellar addresses: use the placeholder (e.g. {account}, {contract})",
    );
  return { type: "path", value: p };
}

function list(v: unknown): unknown[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function parseSteps(
  raw: unknown,
  name: string,
  bounds: { min: number; max: number },
): ReportStep[] {
  const items = list(raw);
  if (items.length < bounds.min || items.length > bounds.max)
    throw bad(`/${name}`, `between ${bounds.min} and ${bounds.max} values of ${name}`);
  return items.map((s, i) => parseStep(s, `/${name}/${i}`));
}

// ------------------------------------------------------------------------------------------- presentation (pure)

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function pct(n: number | null, d: number | null): number | null {
  return n === null || d === null || d <= 0 ? null : round1((100 * n) / d);
}

/** A count as shown: exact; with `anonymous` (C-51) null below the minimum count, else rounded to the policy's step. */
export function displayCount(n: number, anonymous: boolean, policy: AnonPolicy): number | null {
  if (!anonymous) return n;
  if (n < policy.minCount) return null;
  return Math.round(n / policy.roundTo) * policy.roundTo;
}

export interface FunnelStepView {
  type: ReportStep["type"];
  value: string;
  visitors: number | null;
  conversion_pct: number | null;
  step_conversion_pct: number | null;
  suppressed: boolean;
}

/** Funnel steps with conversions computed from the displayed (floored, rounded) counts, so nothing hidden leaks. */
export function presentFunnel(
  rows: readonly FunnelStepResult[],
  anonymous: boolean,
  policy: AnonPolicy,
): FunnelStepView[] {
  const shown = rows.map((r) => displayCount(r.visitors, anonymous, policy));
  return rows.map((r, i) => ({
    type: r.type,
    value: r.value,
    visitors: shown[i] ?? null,
    conversion_pct: pct(shown[i] ?? null, shown[0] ?? null),
    step_conversion_pct: i === 0 ? null : pct(shown[i] ?? null, shown[i - 1] ?? null),
    suppressed: shown[i] === null,
  }));
}

export interface GoalView {
  type: ReportStep["type"];
  value: string;
  visitors: number | null;
  conversion_pct: number | null;
  suppressed: boolean;
}

export function presentGoals(
  goals: readonly ReportStep[],
  results: readonly GoalResult[],
  anonymous: boolean,
  policy: AnonPolicy,
): { total_visitors: number | null; goals: GoalView[] } {
  // Every call answers the same denominator (same range and tag); the largest guards against a racing new event.
  const total = displayCount(Math.max(0, ...results.map((r) => r.total)), anonymous, policy);
  return {
    total_visitors: total,
    goals: goals.map((g, i) => {
      const v = displayCount(results[i]?.visitors ?? 0, anonymous, policy);
      return {
        type: g.type,
        value: g.value,
        visitors: v,
        conversion_pct: pct(v, total),
        suppressed: v === null,
      };
    }),
  };
}

export interface JourneyView {
  journeys: Array<{ items: ReportStep[]; visits: number }>;
  other_visits: number;
  suppressed_journeys: number;
}

/**
 * Journeys at or above the minimum count, in Umami's order (most visits first); every other sequence is only counted
 * (`other_visits`, `suppressed_journeys`). Items are typed by their first character: tracked paths start with `/`, event
 * names never do (the gateway's alphabet).
 */
export function presentJourneys(
  rows: readonly JourneyRow[],
  anonymous: boolean,
  policy: AnonPolicy,
): JourneyView {
  const out: JourneyView = { journeys: [], other_visits: 0, suppressed_journeys: 0 };
  const round = (n: number) => (anonymous ? Math.round(n / policy.roundTo) * policy.roundTo : n);
  for (const r of rows) {
    if (r.items.length === 0) continue;
    if (r.count < policy.minCount) {
      out.other_visits += r.count;
      out.suppressed_journeys++;
      continue;
    }
    out.journeys.push({
      items: r.items.map((v) => ({ type: v.startsWith("/") ? "path" : "event", value: v })),
      visits: round(r.count),
    });
  }
  out.journeys.sort((a, b) => b.visits - a.visits);
  out.other_visits = round(out.other_visits);
  return out;
}

// ------------------------------------------------------------------------------------------- handlers

interface ReportSite {
  tenantId: string;
  siteId: string;
  createdAt: number;
  anonymous: boolean;
  main: string;
  liveDays: number;
  apiKey: string | null;
  policy: AnonPolicy;
}

export function reportHandlers(deps: ReportDeps): Record<string, Handler> {
  const clock = deps.now ?? Date.now;

  async function loadSite(ctx: RequestContext): Promise<ReportSite> {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    // A removed tenant's data is hidden from every view (C-08).
    if (ctx.tenant?.status === "removed") throw new ApiError("not_found");
    return ctx.tx(async (tx) => {
      const s = await tx.maybeOne<{
        created_at: Date;
        anonymous_reports: boolean;
        umami_website_id: string;
      }>(
        `SELECT created_at, anonymous_reports, umami_website_id::text AS umami_website_id
           FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`,
        [tenantId, siteId],
      );
      if (!s) throw new ApiError("not_found");
      const l = await tx.one<{ days: number }>(`SELECT scf.web_live_window_days($1, $2) AS days`, [
        tenantId,
        siteId,
      ]);
      let apiKey: string | null = null;
      if (deps.reader) {
        try {
          apiKey = await tenantApiKey(tx, deps.credsKeys, tenantId);
        } catch {
          apiKey = null; // undecryptable (key version not configured)
        }
      }
      return {
        tenantId,
        siteId,
        createdAt: s.created_at.getTime(),
        anonymous: s.anonymous_reports,
        main: s.umami_website_id,
        liveDays: Number(l.days),
        apiKey,
        policy: await tenantAnonPolicy(tx),
      };
    });
  }

  /** The requested range and the part of it the engine answers (the live window, C-109). */
  function covered(ctx: RequestContext, site: ReportSite, now: number) {
    const span = resolveWebRange(ctx.query, now, site.createdAt);
    const plan = planRange(span, site.liveDays, now, false);
    if (!plan.live)
      throw bad(
        "/start",
        `reports cover the site's live window only, which starts at ${iso(plan.liveBoundary)}`,
      );
    return { span, live: plan.live };
  }

  function rangeView(span: Span, live: Span, site: ReportSite) {
    return {
      start: iso(span.start),
      end: iso(span.end),
      covered_start: iso(live.start),
      truncated: live.start > span.start,
      source: "live",
      timezone: "UTC",
      anonymized: site.anonymous,
    };
  }

  /** Runs the engine calls; anything that cannot be answered is 503 (reports have no rollup). */
  async function engine<T>(
    site: ReportSite,
    fn: (r: ReportReader, key: string) => Promise<T>,
  ): Promise<T> {
    const reason = !deps.reader ? "no_engine" : !site.apiKey ? "not_provisioned" : null;
    if (reason || !deps.reader || !site.apiKey) {
      deps.log?.warn(
        { tenant_id: site.tenantId, site_id: site.siteId, reason },
        "web report unavailable",
      );
      throw new ApiError("unavailable", "the analytics engine cannot answer this report now", {
        retryAfter: RETRY_AFTER_S,
      });
    }
    try {
      return await fn(deps.reader, site.apiKey);
    } catch (err) {
      const why =
        err instanceof UmamiHttpError && (err.status === 401 || err.status === 403)
          ? "unauthorized"
          : err instanceof UmamiUnavailableError
            ? "timeout"
            : "engine_error";
      cpMetrics.liveFallback(why);
      deps.log?.warn(
        {
          tenant_id: site.tenantId,
          site_id: site.siteId,
          reason: why,
          ...(err instanceof UmamiHttpError ? { status: err.status } : {}),
          ...(err instanceof Error ? { error_class: err.name } : {}),
        },
        "web report: engine call failed",
      );
      throw new ApiError("unavailable", "the analytics engine did not answer this report", {
        retryAfter: RETRY_AFTER_S,
      });
    }
  }

  const variantOf = (q: Record<string, unknown>) =>
    q.variant === "raw" ? ("raw" as const) : ("verified" as const);

  const getWebFunnelReport: Handler = async (ctx) => {
    const now = clock();
    const site = await loadSite(ctx);
    const steps = parseSteps(ctx.query.step, "step", FUNNEL_STEPS);
    const window = Number(ctx.query.window ?? DEFAULT_WINDOW_MIN);
    const variant = variantOf(ctx.query);
    const { span, live } = covered(ctx, site, now);
    const rows = await engine(site, (r, key) =>
      r.funnel(key, site.main, live, steps, window, variant),
    );
    return {
      status: 200,
      body: {
        range: rangeView(span, live, site),
        variant,
        window_minutes: window,
        steps: presentFunnel(rows, site.anonymous, site.policy),
      },
      headers: { "cache-control": "no-store" },
    };
  };

  const getWebGoalsReport: Handler = async (ctx) => {
    const now = clock();
    const site = await loadSite(ctx);
    const goals = parseSteps(ctx.query.goal, "goal", GOALS);
    const variant = variantOf(ctx.query);
    const { span, live } = covered(ctx, site, now);
    const results = await engine(site, (r, key) =>
      Promise.all(goals.map((g) => r.goal(key, site.main, live, g, variant))),
    );
    return {
      status: 200,
      body: {
        range: rangeView(span, live, site),
        variant,
        ...presentGoals(goals, results, site.anonymous, site.policy),
      },
      headers: { "cache-control": "no-store" },
    };
  };

  const getWebJourneyReport: Handler = async (ctx) => {
    const now = clock();
    const site = await loadSite(ctx);
    const steps = Number(ctx.query.steps ?? DEFAULT_JOURNEY_STEPS);
    const opts: JourneyOptions = { steps };
    if (ctx.query.start_step !== undefined)
      opts.startStep = parseStep(ctx.query.start_step, "/start_step").value;
    if (ctx.query.end_step !== undefined)
      opts.endStep = parseStep(ctx.query.end_step, "/end_step").value;
    const variant = variantOf(ctx.query);
    const { span, live } = covered(ctx, site, now);
    const rows = await engine(site, (r, key) => r.journey(key, site.main, live, opts, variant));
    return {
      status: 200,
      body: {
        range: rangeView(span, live, site),
        variant,
        steps,
        min_count: site.policy.minCount,
        ...presentJourneys(rows, site.anonymous, site.policy),
      },
      headers: { "cache-control": "no-store" },
    };
  };

  return { getWebFunnelReport, getWebGoalsReport, getWebJourneyReport };
}
