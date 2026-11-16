// SPDX-License-Identifier: Apache-2.0
// URL search parameters of the dashboard: every view is a shareable URL (ADR-0024). Unknown or malformed values fall
// back to the defaults instead of failing.

import { PRESETS, type RangeKind, type Unit } from "./range.ts";

export interface DashboardSearch {
  range: RangeKind;
  /** custom range: first day, inclusive (YYYY-MM-DD, UTC) */
  from?: string;
  /** custom range: last day, inclusive (YYYY-MM-DD, UTC) */
  to?: string;
  /** which page-view and visitor figures the tiles, charts and tables show (C-73) */
  variant: "verified" | "raw";
  compare: boolean;
  unit?: Unit;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDashboardSearch(s: Record<string, unknown>): DashboardSearch {
  const range =
    s.range === "custom" || (PRESETS as readonly unknown[]).includes(s.range)
      ? (s.range as RangeKind)
      : "30d";
  const out: DashboardSearch = {
    range,
    variant: s.variant === "raw" ? "raw" : "verified",
    compare: s.compare === true || s.compare === "true" || s.compare === 1,
  };
  if (range === "custom") {
    if (typeof s.from === "string" && DAY.test(s.from)) out.from = s.from;
    if (typeof s.to === "string" && DAY.test(s.to)) out.to = s.to;
  }
  if (s.unit === "hour" || s.unit === "day" || s.unit === "month") out.unit = s.unit;
  return out;
}

export function parseReturnToSearch(s: Record<string, unknown>): { return_to?: string } {
  return typeof s.return_to === "string" ? { return_to: s.return_to } : {};
}

/** /signin: where to go afterwards, and `as=operator` to preselect the SCF operator mode. */
export function parseSignInSearch(s: Record<string, unknown>): {
  return_to?: string;
  as?: "operator";
  method?: "wallet";
} {
  return {
    ...parseReturnToSearch(s),
    ...(s.as === "operator" ? { as: "operator" as const } : {}),
    ...(s.method === "wallet" ? { method: "wallet" as const } : {}),
  };
}

export function parseRangeShort(s: Record<string, unknown>): { range: "24h" | "7d" | "30d" } {
  return { range: s.range === "24h" || s.range === "30d" ? s.range : "7d" };
}

export type SnippetFormat =
  | "html"
  | "npm"
  | "nextjs"
  | "vite"
  | "astro"
  | "angular"
  | "consent_html";
export const SNIPPET_FORMATS: { id: SnippetFormat; label: string }[] = [
  { id: "html", label: "HTML (script tag)" },
  { id: "consent_html", label: "HTML with consent mode" },
  { id: "npm", label: "npm package" },
  { id: "nextjs", label: "Next.js" },
  { id: "vite", label: "Vite" },
  { id: "astro", label: "Astro" },
  { id: "angular", label: "Angular" },
];

export function parseSnippetSearch(s: Record<string, unknown>): {
  format: SnippetFormat;
  version?: string;
} {
  const format = SNIPPET_FORMATS.some((f) => f.id === s.format)
    ? (s.format as SnippetFormat)
    : "html";
  const out: { format: SnippetFormat; version?: string } = { format };
  if (typeof s.version === "string" && /^\d+\.\d+\.\d+$/.test(s.version)) out.version = s.version;
  return out;
}

// --- API dashboard (dashboard.api-*) ---

export const ROUTE_SORTS = [
  "-requests",
  "requests",
  "-error_rate_5xx",
  "error_rate_5xx",
  "-p95_ms",
  "p95_ms",
  "route",
] as const;
export type RouteSort = (typeof ROUTE_SORTS)[number];

export interface ApiDashboardSearch {
  range: RangeKind;
  from?: string;
  to?: string;
  compare: boolean;
  /** one route's view (normalised template, `{unknown}` or `{overflow}`) */
  route?: string;
  sort: RouteSort;
  /** the API page's section */
  tab?: ApiTab;
}

export const API_TABS = [
  "traffic",
  "surfaces",
  "sdk",
  "partners",
  "payments",
  "anchors",
  "quality",
] as const;
export type ApiTab = (typeof API_TABS)[number];

export function parseApiDashboardSearch(s: Record<string, unknown>): ApiDashboardSearch {
  const base = parseDashboardSearch(s);
  const out: ApiDashboardSearch = {
    range: base.range,
    compare: base.compare,
    sort: (ROUTE_SORTS as readonly unknown[]).includes(s.sort)
      ? (s.sort as RouteSort)
      : "-requests",
  };
  if (base.from) out.from = base.from;
  if (base.to) out.to = base.to;
  if (typeof s.route === "string" && s.route.length > 0 && s.route.length <= 1024)
    out.route = s.route;
  if ((API_TABS as readonly unknown[]).includes(s.tab) && s.tab !== "traffic")
    out.tab = s.tab as ApiTab;
  return out;
}

// --- onboarding wizard ---

export const WEB_STEPS = ["site", "domain", "snippet", "check"] as const;
export const API_STEPS = ["service", "token", "configure", "verify"] as const;
export type WebStep = (typeof WEB_STEPS)[number];
export type ApiStep = (typeof API_STEPS)[number];
export const OTEL_STACKS = [
  "node",
  "nextjs",
  "fastapi",
  "go",
  "rust",
  "java",
  "dotnet",
  "collector",
] as const;
export type OtelStack = (typeof OTEL_STACKS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWebWizardSearch(s: Record<string, unknown>): { step: WebStep; site?: string } {
  const step = (WEB_STEPS as readonly unknown[]).includes(s.step) ? (s.step as WebStep) : "site";
  const out: { step: WebStep; site?: string } = { step };
  if (typeof s.site === "string" && UUID.test(s.site)) out.site = s.site;
  return out;
}

export function parseApiWizardSearch(s: Record<string, unknown>): {
  step: ApiStep;
  service?: string;
  stack: OtelStack;
} {
  const step = (API_STEPS as readonly unknown[]).includes(s.step) ? (s.step as ApiStep) : "service";
  const stack = (OTEL_STACKS as readonly unknown[]).includes(s.stack)
    ? (s.stack as OtelStack)
    : "node";
  const out: { step: ApiStep; service?: string; stack: OtelStack } = { step, stack };
  if (typeof s.service === "string" && UUID.test(s.service)) out.service = s.service;
  return out;
}

// --- SCF operator views (operator.web-*, operator.api-*) ---

export const LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;
export type Level = (typeof LEVELS)[number];
export type DayRange = "7d" | "30d" | "90d" | "custom";

export interface OperatorSearch {
  range: DayRange;
  from?: string;
  to?: string;
  variant: "verified" | "raw";
  min_level: Level;
  awarded: "any" | "yes" | "no";
  band: "any" | "high" | "medium" | "low" | "unscored";
  sort?: string;
  /** threshold: minimum page views (web) or requests (API) */
  min?: number;
  /** projects selected for side-by-side comparison */
  ids: string[];
}

export function parseOperatorSearch(s: Record<string, unknown>): OperatorSearch {
  const range =
    s.range === "7d" || s.range === "90d" || s.range === "custom" ? (s.range as DayRange) : "30d";
  const out: OperatorSearch = {
    range,
    variant: s.variant === "raw" ? "raw" : "verified",
    min_level: (LEVELS as readonly unknown[]).includes(s.min_level) ? (s.min_level as Level) : "L1",
    awarded: s.awarded === "yes" || s.awarded === "no" ? s.awarded : "any",
    band:
      s.band === "high" || s.band === "medium" || s.band === "low" || s.band === "unscored"
        ? s.band
        : "any",
    ids: [],
  };
  if (range === "custom") {
    if (typeof s.from === "string" && DAY.test(s.from)) out.from = s.from;
    if (typeof s.to === "string" && DAY.test(s.to)) out.to = s.to;
  }
  if (typeof s.sort === "string" && /^-?[a-z0-9_]{1,40}$/.test(s.sort)) out.sort = s.sort;
  const min = typeof s.min === "number" ? s.min : typeof s.min === "string" ? Number(s.min) : NaN;
  if (Number.isInteger(min) && min > 0) out.min = min;
  const ids = Array.isArray(s.ids) ? s.ids : typeof s.ids === "string" ? s.ids.split(",") : [];
  out.ids = ids.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 6);
  return out;
}

export function parseOperatorTenantsSearch(s: Record<string, unknown>): {
  status: string;
  q?: string;
  sort: "name" | "-created_at" | "-verification_level";
} {
  const status =
    typeof s.status === "string" && /^[a-z,]{1,60}$/.test(s.status)
      ? s.status
      : "active,suspended,pending";
  const out: { status: string; q?: string; sort: "name" | "-created_at" | "-verification_level" } =
    {
      status,
      sort: s.sort === "-created_at" || s.sort === "-verification_level" ? s.sort : "name",
    };
  if (typeof s.q === "string" && s.q.length > 0 && s.q.length <= 100) out.q = s.q;
  return out;
}

export function parseAuditSearch(s: Record<string, unknown>): { prefix: string } {
  return {
    prefix:
      typeof s.prefix === "string" && /^[a-z][a-z0-9_.]{0,95}$/.test(s.prefix) ? s.prefix : "",
  };
}
