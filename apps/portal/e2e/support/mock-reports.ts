// SPDX-License-Identifier: Apache-2.0
// Mock answers of the web reports (getWebFunnelReport, getWebGoalsReport, getWebJourneyReport; wire-formats §j.3
// R6–R8) for the portal's browser tests. They follow the contract where the portal depends on it: steps checked after
// the site (a foreign site is 404), `path:`/`event:` syntax with no query strings, 2–8 funnel steps and 1–5 goals,
// the live-window truncation of ranges longer than the docs site's 5-day window, `anonymous_reports` (counts below 10
// withheld, the rest rounded), journeys always floored at 10 visits, and `step=event:boom` answers 503 (engine down).

import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import { type Answer, MockProblem } from "./mock-extra.ts";

type Site = ControlPlane.Site & { tenantId: string };
type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
}) => Answer;

export interface ReportsCtx {
  /** the tenant's site for a complete session; throws the mock's 404 problem otherwise */
  site(req: IncomingMessage, tenantId: string, siteId: string): Site;
}

const DAY = 86_400_000;
const LIVE_DAYS = 5;
const MIN = 10;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Scripted engine answers: visitors per path/event (the docs site's day), funnel order as given. */
const VISITORS: Record<string, number> = {
  "path:/": 1240,
  "path:/docs": 610,
  "path:/pricing": 287,
  "path:/docs/*": 702,
  "event:wallet_connected": 96,
  "event:signup": 7,
};
const TOTAL = 1500;
const JOURNEYS: Array<{ items: string[]; count: number }> = [
  { items: ["/", "/docs", "/docs/{slug}"], count: 412 },
  { items: ["/", "/pricing", "signup"], count: 31 },
  { items: ["/docs/{slug}"], count: 18 },
  { items: ["/", "wallet_connected"], count: 6 },
  { items: ["/blog/{slug}", "/"], count: 2 },
];

function bad(pointer: string, detail: string): MockProblem {
  return new MockProblem(400, "validation_failed", "Validation failed", {
    errors: [{ pointer, detail }],
  });
}

function step(raw: string | null, pointer: string): ControlPlane.ReportStep {
  const m = /^(path|event):(.+)$/.exec(raw ?? "");
  if (!m) throw bad(pointer, "expected path:<page path> or event:<name>");
  const type = m[1] as "path" | "event";
  let value = m[2] as string;
  if (type === "path") {
    if (!value.startsWith("/")) throw bad(pointer, "a page path starts with /");
    if (/[?#\s]/.test(value))
      throw bad(pointer, "a page path has no query string or fragment (C-65)");
    value = value.replace(/\/{2,}/g, "/");
    if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  } else if (!/^[A-Za-z0-9*][A-Za-z0-9_.:*-]{0,49}$/.test(value)) {
    throw bad(pointer, "an event name is 1–50 characters of A–Z, a–z, 0–9, _ . : -");
  }
  return { type, value };
}

function steps(q: URLSearchParams, name: string, min: number, max: number) {
  const all = q.getAll(name);
  if (all.length < min || all.length > max)
    throw bad(`/${name}`, `between ${min} and ${max} values of ${name}`);
  return all.map((s, i) => step(s, `/${name}/${i}`));
}

function range(q: URLSearchParams, site: Site): ControlPlane.ReportRange {
  const now = Date.now();
  const endOfToday = Math.floor(now / DAY) * DAY + DAY;
  const r = q.get("range") ?? "30d";
  const start = r === "24h" ? now - DAY : endOfToday - (r === "7d" ? 7 : 30) * DAY;
  const end = r === "24h" ? now : endOfToday;
  const b = endOfToday - LIVE_DAYS * DAY;
  const covered = r === "24h" ? start : Math.max(start, b);
  return {
    start: iso(start),
    end: iso(end),
    covered_start: iso(covered),
    truncated: covered > start,
    source: "live",
    timezone: "UTC",
    anonymized: site.anonymous_reports,
  };
}

function shown(n: number, anonymous: boolean): number | null {
  if (!anonymous) return n;
  return n < MIN ? null : Math.round(n / 10) * 10;
}

const pct = (n: number | null, d: number | null) =>
  n === null || d === null || d <= 0 ? null : Math.round((1000 * n) / d) / 10;

function engineDown(list: ControlPlane.ReportStep[]): void {
  if (list.some((s) => s.value === "boom"))
    throw new MockProblem(503, "unavailable", "Temporarily unavailable", {
      detail: "the analytics engine did not answer this report",
    });
}

export function reportHandlers(ctx: ReportsCtx): Record<string, Handler> {
  const variant = (q: URLSearchParams) => (q.get("variant") === "raw" ? "raw" : "verified");
  return {
    getWebFunnelReport: ({ req, p, q }) => {
      const site = ctx.site(req, p.tenantId as string, p.siteId as string);
      const list = steps(q, "step", 2, 8);
      const window = Number(q.get("window") ?? 60);
      if (!Number.isInteger(window) || window < 1 || window > 1440)
        throw bad("/window", "1–1440 minutes");
      engineDown(list);
      const raw: number[] = [];
      for (const s of list) {
        const v = VISITORS[`${s.type}:${s.value}`] ?? 0;
        raw.push(Math.min(v, raw.at(-1) ?? v)); // a funnel never grows
      }
      const vis = raw.map((v) => shown(v, site.anonymous_reports));
      return {
        status: 200,
        body: {
          range: range(q, site),
          variant: variant(q),
          window_minutes: window,
          steps: list.map((s, i) => ({
            ...s,
            visitors: vis[i] ?? null,
            conversion_pct: pct(vis[i] ?? null, vis[0] ?? null),
            step_conversion_pct: i === 0 ? null : pct(vis[i] ?? null, vis[i - 1] ?? null),
            suppressed: vis[i] === null,
          })),
        } satisfies ControlPlane.WebFunnelReport,
      };
    },
    getWebGoalsReport: ({ req, p, q }) => {
      const site = ctx.site(req, p.tenantId as string, p.siteId as string);
      const list = steps(q, "goal", 1, 5);
      engineDown(list);
      const total = shown(TOTAL, site.anonymous_reports);
      return {
        status: 200,
        body: {
          range: range(q, site),
          variant: variant(q),
          total_visitors: total,
          goals: list.map((g) => {
            const v = shown(VISITORS[`${g.type}:${g.value}`] ?? 0, site.anonymous_reports);
            return { ...g, visitors: v, conversion_pct: pct(v, total), suppressed: v === null };
          }),
        } satisfies ControlPlane.WebGoalsReport,
      };
    },
    getWebJourneyReport: ({ req, p, q }) => {
      const site = ctx.site(req, p.tenantId as string, p.siteId as string);
      const depth = Number(q.get("steps") ?? 4);
      if (!Number.isInteger(depth) || depth < 2 || depth > 7) throw bad("/steps", "2–7");
      const from = q.get("start_step");
      const first = from === null ? null : step(from, "/start_step").value;
      const rows = JOURNEYS.map((j) => ({ ...j, items: j.items.slice(0, depth) })).filter(
        (j) => first === null || j.items[0] === first,
      );
      const round = (n: number) => (site.anonymous_reports ? Math.round(n / 10) * 10 : n);
      const kept = rows.filter((j) => j.count >= MIN);
      const rest = rows.filter((j) => j.count < MIN);
      return {
        status: 200,
        body: {
          range: range(q, site),
          variant: variant(q),
          steps: depth,
          min_count: MIN,
          journeys: kept.map((j) => ({
            items: j.items.map((v) => ({
              type: v.startsWith("/") ? ("path" as const) : ("event" as const),
              value: v,
            })),
            visits: round(j.count),
          })),
          other_visits: round(rest.reduce((a, j) => a + j.count, 0)),
          suppressed_journeys: rest.length,
        } satisfies ControlPlane.WebJourneyReport,
      };
    },
  };
}
