// SPDX-License-Identifier: Apache-2.0
// Display rules of the API analytics figures (dashboard.api-*, isolation.api-dashboard, operator.api-*, ADR-0010, C-16, C-22, C-103, C-110(9), wire-formats §h.3).
// Every percentile is shown with its accuracy class (mandatory, C-103); a percentile that falls in the first bucket of
// the 15-bucket explicit layout is reported by the API as 5 ms and is shown as "≤ 5 ms"; the placeholders `{unknown}`
// and `{overflow}` are explained instead of shown as if they were routes.

import type { ControlPlane } from "@usagemap/api-types";
import { DASH } from "./format.ts";

export type AccuracyClass = ControlPlane.AccuracyClass;

const ONE = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const TWO = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** True for the explicit-bucket classes, whose first bucket ends at 5 ms (C-103, C-110(9)). */
function explicit(a: AccuracyClass | null | undefined): boolean {
  return a === "explicit15" || a === "explicit15_approx";
}

/** Milliseconds → "0.8 ms", "4.3 ms", "182 ms", "1.25 s"; "≤ 5 ms" for a first-bucket value of an explicit layout. */
export function fmtMs(ms: number | null | undefined, accuracy?: AccuracyClass | null): string {
  if (ms === null || ms === undefined) return DASH;
  if (explicit(accuracy) && ms <= 5) return "≤ 5 ms";
  if (ms < 10) return `${ONE.format(ms)} ms`;
  if (ms < 1000) return `${INT.format(ms)} ms`;
  return `${TWO.format(ms / 1000)} s`;
}

export const ACCURACY_LABEL: Record<AccuracyClass, string> = {
  exp3: "± 4.3 %",
  explicit15: "bucket width",
  explicit15_approx: "bucket width, interpolated",
  coarse: "coarse",
};

export const ACCURACY_TEXT: Record<AccuracyClass, string> = {
  exp3: "Exponential histogram: each percentile is within 4.3 % of the exact value.",
  explicit15:
    "Your SDK sends a 15-bucket histogram: a percentile is only known to lie within its bucket and is typically 17–18 % above the exact value; anything faster than 5 ms is shown as “≤ 5 ms”.",
  explicit15_approx:
    "15-bucket histogram, partly interpolated because some points used other bucket bounds: treat the percentiles as approximate (bucket width).",
  coarse:
    "Your SDK sends a low-resolution exponential histogram: percentiles are coarse; raise the histogram scale for better precision.",
};

export function accuracyLabel(a: AccuracyClass | null | undefined): string {
  return a ? ACCURACY_LABEL[a] : "no data";
}

/** A share in [0, 1] → "1.25%" (two decimals: error rates of healthy APIs are small). */
export function fmtRate(r: number | null | undefined): string {
  return r === null || r === undefined ? DASH : `${TWO.format(r * 100)}%`;
}

/** Status classes of a summary → their shares of all requests, for the distribution bar and table. */
export function statusShares(s: ControlPlane.StatusClasses): {
  key: keyof ControlPlane.StatusClasses;
  label: string;
  count: number;
  share: number;
}[] {
  const total = s.s2xx + s.s3xx + s.s4xx + s.s5xx + s.unknown;
  const rows: [keyof ControlPlane.StatusClasses, string][] = [
    ["s2xx", "2xx success"],
    ["s3xx", "3xx redirect"],
    ["s4xx", "4xx client error"],
    ["s5xx", "5xx server error"],
    ["unknown", "no status code"],
  ];
  return rows.map(([key, label]) => ({
    key,
    label,
    count: s[key],
    share: total === 0 ? 0 : s[key] / total,
  }));
}

export const ROUTE_PLACEHOLDER_TEXT: Record<string, string> = {
  "{unknown}":
    "Requests without any route or path — typically requests that matched no route in your framework (404s) or a span-only stack that sent no path. They count towards your totals.",
  "{overflow}":
    "Requests on routes beyond the daily route limit (1,000 per service, 5,000 per project, 200 under one prefix). Usually a path parameter that was not recognised as one; declare the route template in your framework so these requests get their own row.",
};

export function isRoutePlaceholder(route: string): boolean {
  return route === "{unknown}" || route === "{overflow}";
}

/** Plain-language reason for every API data-quality counter (wire-formats §h.3). */
export const DQ_REASON_TEXT: Record<string, string> = {
  service_not_allowed: "Sent with a token that is not allowed for this service name.",
  service_quota_exceeded:
    "A new service name arrived after your project's service limit was reached.",
  before_registration: "Data timestamped before the service was registered (no back-filling).",
  too_old: "Data older than the stored time range.",
  future: "Timestamps in the future — check the server clock.",
  metric_not_allowed: "Metrics other than HTTP server duration (ignored by design).",
  client_metric_ignored:
    "HTTP client metrics (ignored by design: only your server side is counted).",
  span_not_server:
    "Spans that are not SERVER spans (ignored by design: only incoming requests count).",
  span_not_local_root: "SERVER spans with a local parent (ignored so a request is counted once).",
  logs_rejected: "Logs were sent; logs are never accepted.",
  route_overflow: "Routes beyond the daily route limit, counted under {overflow}.",
  route_redacted: "Route values that looked like personal data or secrets and were replaced.",
  route_seed_redacted:
    "Of those, request paths that held a Stellar secret seed (S…): the seed was replaced and never stored — rotate that key.",
  stellar_series_overflow:
    "Stellar RPC/Horizon client-metric points beyond your daily series or stream limit (dropped; API usage is unaffected).",
  cumulative_first_point:
    "First point of a cumulative stream seen after a restart — used only as the starting value.",
  cumulative_reset:
    "A cumulative counter went backwards (process restart); counted from the new start.",
  duplicate_batch: "A batch that had already been stored (retries are de-duplicated).",
  hist_layout_approx:
    "Histogram bucket bounds differ from the standard layout; percentiles are interpolated.",
  exp_scale_coarse: "Exponential histogram with a low scale; percentiles are coarse.",
  quota_exceeded: "Your project's daily data quota was reached.",
  malformed_point: "Points that could not be read (invalid values or structure).",
  negative_value: "Histogram points with negative values.",
  rate_limited: "Requests refused because the ingest rate limit was exceeded.",
  payload_too_large: "Requests larger than the accepted size.",
  tenant_pending: "Your project is awaiting approval by an SCF operator.",
  tenant_suspended: "Your project is suspended.",
  token_expired: "The ingest token had expired.",
  undeliverable_72h: "Data that could not be stored within 72 hours of receipt.",
  count_overflow: "Counts too large to store (a misbehaving exporter).",
  tenant_write_error: "Data that could not be written because of an error on our side.",
  hist_unit_suspect:
    "Histogram declared in seconds but using the millisecond default bucket layout; stored with coarse percentiles.",
};

export function dqReasonText(reason: string): string {
  return DQ_REASON_TEXT[reason] ?? "Other data-quality reason.";
}

/** Reasons that are expected by design (filtering), as opposed to problems the tenant should look at. */
export const DQ_BY_DESIGN = new Set([
  "metric_not_allowed",
  "client_metric_ignored",
  "span_not_server",
  "span_not_local_root",
  "duplicate_batch",
  "cumulative_first_point",
]);

// ------------------------------------------------------------------------------------------ filtered web traffic

/** Plain-language meaning of every web reason code (wire-formats §h.2). */
export const WEB_REASON_TEXT: Record<string, string> = {
  ua_bot: "The browser identified itself as a bot.",
  origin_mismatch: "Sent from a page whose host is not one of this site's domains.",
  fetch_impossible: "Request headers a browser cannot produce.",
  challenge_missing: "No challenge token.",
  challenge_invalid: "Invalid challenge token, or one for another site.",
  challenge_expired: "Challenge token older than 30 minutes or from the future.",
  proof_invalid: "Wrong proof-of-work answer.",
  token_flood: "Too many events for one challenge token.",
  tenant_pending: "The project is awaiting approval.",
  tenant_suspended: "The project is suspended.",
  proof_missing: "No proof-of-work (page hidden before it finished, or no WebCrypto).",
  challenge_unverifiable: "The token's key was unknown on the receiving node.",
  ctx_moved: "Network or browser class changed since the token was issued.",
  domain_unverified: "Sent from a declared domain that is not verified yet.",
  automation_flag: "The browser reported automation (webdriver or headless).",
  hidden_or_prerender: "Page view from a hidden or prerendered page.",
  net_datacenter: "Sent from a datacenter network.",
  multiplicity_high: "Many visitors from one network with little engagement.",
  header_inconsistent: "Headers missing that the claimed browser always sends.",
  origin_missing: "No Origin and no Referer header.",
  rate_anomaly: "Event rate far above this site's usual level.",
  transport_mismatch:
    "The connection's TLS/HTTP fingerprint belongs to another kind of client than the browser claimed.",
};

/** Plain-language label of a web reason code; unknown codes fall back to the code itself. */
export function webReasonText(code: string): string {
  return WEB_REASON_TEXT[code] ?? code;
}

export interface VerdictCounts {
  verified: number;
  suspect: number;
  rejected: number;
}

export interface FilteredView {
  received: number;
  /** (suspect + rejected) ÷ received; null without events */
  notCounted: number | null;
  suspect: number | null;
  rejected: number | null;
  rows: Array<{
    code: string;
    verdict: string;
    count: number;
    label: string;
    share: number | null;
  }>;
}

/**
 * Traffic the gateway did not count as verified, as shown on the Trust page (per website, the tenant's own exact
 * counters) and on the public card (tenant-wide, reasons already thresholded and rounded by the server, C-95).
 * Shares of reasons are of all events received; an event can carry several reasons, so they need not add up.
 */
export function filteredView(
  v: VerdictCounts,
  reasons: ReadonlyArray<{ code: string; verdict: string; count: number }>,
): FilteredView {
  const received = v.verified + v.suspect + v.rejected;
  const share = (n: number) => (received > 0 ? n / received : null);
  return {
    received,
    notCounted: share(v.suspect + v.rejected),
    suspect: share(v.suspect),
    rejected: share(v.rejected),
    rows: reasons
      .filter((r) => r.verdict === "suspect" || r.verdict === "rejected")
      .map((r) => ({ ...r, label: webReasonText(r.code), share: share(r.count) }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}

// ------------------------------------------------------------------------------------------ SLO / error budget

export const DEFAULT_SLO_TARGET_PCT = 99.5;

export interface SloView {
  targetPct: number;
  /** requests with a status code (the measure's denominator) */
  eligible: number;
  /** requests without a status code: left out of the measure, shown as such */
  noStatus: number;
  bad: number;
  /** share of eligible requests that were not 5xx; null without eligible requests */
  availability: number | null;
  /** 5xx requests the objective allows over the range */
  budget: number;
  /** consumed share of the budget (may exceed 1); null without eligible requests */
  burned: number | null;
  met: boolean | null;
  /** UTC days of the range with any request ÷ days of the range */
  coverage: number | null;
  daysWithData: number;
  days: number;
}

/**
 * Availability against the service's objective over the shown range: good = requests with a status code that are not
 * 5xx. Measured only from the telemetry the service sent (self-attested): a day without data is neither uptime nor
 * downtime, so coverage — the share of days with data — is shown next to it.
 */
export function sloView(
  status: ControlPlane.StatusClasses,
  targetPct: number,
  points: ReadonlyArray<{ t: string; requests: number }>,
): SloView {
  const total = status.s2xx + status.s3xx + status.s4xx + status.s5xx + status.unknown;
  const eligible = total - status.unknown;
  const bad = status.s5xx;
  const budget = ((100 - targetPct) / 100) * eligible;
  const availability = eligible > 0 ? (eligible - bad) / eligible : null;
  const byDay = new Map<string, number>();
  for (const p of points)
    byDay.set(p.t.slice(0, 10), (byDay.get(p.t.slice(0, 10)) ?? 0) + p.requests);
  const days = byDay.size;
  const daysWithData = [...byDay.values()].filter((n) => n > 0).length;
  return {
    targetPct,
    eligible,
    noStatus: status.unknown,
    bad,
    availability,
    budget,
    burned:
      eligible > 0 ? (budget > 0 ? bad / budget : bad > 0 ? Number.POSITIVE_INFINITY : 0) : null,
    met: availability === null ? null : availability * 100 >= targetPct,
    coverage: days > 0 ? daysWithData / days : null,
    daysWithData,
    days,
  };
}
