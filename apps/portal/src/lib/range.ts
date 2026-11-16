// SPDX-License-Identifier: Apache-2.0
// Dashboard time ranges (dashboard.time-ranges, C-86, C-109, C-112). Presets are resolved by the control plane (and echoed in
// `range`); a custom range is chosen as whole UTC days — the person picks a first and a last day, the API receives the
// half-open pair [first 00:00Z, day after last 00:00Z). Whole days always satisfy the rule that a rollup part must be
// whole UTC days, so the portal never produces the `400` that a partial day would get.

export const PRESETS = ["24h", "7d", "30d", "90d", "12m", "all"] as const;
export type Preset = (typeof PRESETS)[number];
export type RangeKind = Preset | "custom";
export type Unit = "hour" | "day" | "month";

export const PRESET_LABELS: Record<Preset, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "12m": "Last 12 months",
  all: "All time",
};

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The API accepts ranges up to 10 years. */
export const MAX_CUSTOM_DAYS = 3653;

/** Parses "YYYY-MM-DD" as a UTC day; null for anything else (including impossible dates such as 2026-02-30). */
export function parseDay(s: string | undefined): Date | null {
  if (!s) return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s ? d : null;
}

export function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** RFC 3339 UTC with second precision, as the API echoes it ("2026-11-12T00:00:00Z"). */
export function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type CustomRange = { start: string; end: string; days: number };

/** Inclusive first/last day → the API's half-open [start, end). Errors are messages for the form. */
export function customRange(
  from: string | undefined,
  to: string | undefined,
): CustomRange | { error: string } {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return { error: "Enter a first and a last day as YYYY-MM-DD." };
  if (b.getTime() < a.getTime()) return { error: "The last day must not be before the first day." };
  const days = Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1;
  if (days > MAX_CUSTOM_DAYS) return { error: "A range can be at most 10 years long." };
  return { start: isoZ(a), end: isoZ(new Date(b.getTime() + DAY_MS)), days };
}

/** Approximate span of a preset in days (for the unit choice); null for "all" (unknown until answered). */
export function presetDays(p: Preset): number | null {
  switch (p) {
    case "24h":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "12m":
      return 366;
    case "all":
      return null;
  }
}

/** The control plane's default unit rule: hour ≤ 2 days, day ≤ 92 days, else month (OpenAPI parameter `unit`). */
export function defaultUnit(days: number | null): Unit {
  if (days === null) return "month";
  if (days <= 2) return "hour";
  if (days <= 92) return "day";
  return "month";
}

/** Units offered for a span: hours only up to 7 days, days up to about a year, months always. */
export function allowedUnits(days: number | null): Unit[] {
  const u: Unit[] = [];
  if (days !== null && days <= 7) u.push("hour");
  if (days !== null && days <= 400) u.push("day");
  u.push("month");
  return u;
}

/**
 * Visits, bounces, bounce rate and visit duration are computed per UTC day, so the API refuses them for `unit=hour`
 * (C-112(4)); the dashboard then hides those series instead of asking.
 */
export function visitSeriesAvailable(unit: Unit): boolean {
  return unit !== "hour";
}
