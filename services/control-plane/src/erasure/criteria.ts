// SPDX-License-Identifier: Apache-2.0
// Erasure criteria (data-model §8.8, ADR-0030, C-86, C-88): a C-86 range plus at most one selector — a path pattern,
// an event name or a property key. Shared by the API handlers and job `erasure`.

export type SelectorType = "path_pattern" | "event_name" | "property_key";
export type Scope = "filtered" | "site" | "service" | "tenant";

/** The literal criteria as stored until redaction. */
export interface Criteria {
  start: string;
  end: string;
  path_pattern?: string | null;
  event_name?: string | null;
  property_key?: string | null;
  /** Present only after redaction (C-88): type and length, never the value. */
  selector?: { type: SelectorType; length: number } | null;
}

export interface Selector {
  type: SelectorType;
  value: string;
}

export const SELECTOR_TYPES: readonly SelectorType[] = [
  "path_pattern",
  "event_name",
  "property_key",
];

/** The literal selector, or null when the request has none or it has been redacted. */
export function selectorOf(c: Criteria): Selector | null {
  for (const t of SELECTOR_TYPES) {
    const v = c[t];
    if (typeof v === "string") return { type: t, value: v };
  }
  return null;
}

/** Type and length of the selector — what the audit log and redacted responses carry (C-88). */
export function selectorSummary(c: Criteria): { type: SelectorType; length: number } | null {
  const s = selectorOf(c);
  if (s) return { type: s.type, length: [...s.value].length };
  return c.selector ?? null;
}

/**
 * `path_pattern` → SQL LIKE pattern with `\` as the escape character: `*` matches any run of characters including
 * `/`; `%`, `_` and `\` are literal (data-model §8.8: no other metacharacters).
 */
export function globToLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (m) => `\\${m}`).replace(/\*/g, "%");
}

export interface Range {
  start: Date;
  end: Date;
}

/** C-86: RFC 3339 in UTC, start inclusive, end exclusive, start < end. Returns a field error or the range. */
export function parseRange(
  c: Pick<Criteria, "start" | "end">,
): Range | { pointer: string; detail: string } {
  const start = new Date(c.start);
  const end = new Date(c.end);
  if (Number.isNaN(start.getTime()))
    return { pointer: "/criteria/start", detail: "must be an RFC 3339 time" };
  if (Number.isNaN(end.getTime()))
    return { pointer: "/criteria/end", detail: "must be an RFC 3339 time" };
  if (end.getTime() <= start.getTime())
    return { pointer: "/criteria/end", detail: "must be after start (end is exclusive, C-86)" };
  return { start, end };
}

/** The criteria as the API shows them: the literal selector until redaction, afterwards nulls (C-88). */
export function criteriaView(c: Criteria): Record<string, unknown> {
  return {
    start: new Date(c.start).toISOString().replace(".000Z", "Z"),
    end: new Date(c.end).toISOString().replace(".000Z", "Z"),
    path_pattern: typeof c.path_pattern === "string" ? c.path_pattern : null,
    event_name: typeof c.event_name === "string" ? c.event_name : null,
    property_key: typeof c.property_key === "string" ? c.property_key : null,
  };
}

/** Counts per table (`ErasureCounts`), used for both the preview and the result. */
export interface Counts {
  website_events: number;
  event_data_rows: number;
  sessions_orphaned: number;
  breakdown_rows: number;
  api_routes: number;
  api_metric_rows: number;
  aggregate_days: string[];
}

export function zeroCounts(): Counts {
  return {
    website_events: 0,
    event_data_rows: 0,
    sessions_orphaned: 0,
    breakdown_rows: 0,
    api_routes: 0,
    api_metric_rows: 0,
    aggregate_days: [],
  };
}

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    website_events: a.website_events + b.website_events,
    event_data_rows: a.event_data_rows + b.event_data_rows,
    sessions_orphaned: a.sessions_orphaned + b.sessions_orphaned,
    breakdown_rows: a.breakdown_rows + b.breakdown_rows,
    api_routes: a.api_routes + b.api_routes,
    api_metric_rows: a.api_metric_rows + b.api_metric_rows,
    aggregate_days: [...new Set([...a.aggregate_days, ...b.aggregate_days])].sort(),
  };
}

/** Days after which erased data has left every backup: 35-day retention + ≤ 7 days to the next full + 14 days (C-112). */
export const BACKUP_CLEAR_DAYS = 56;
