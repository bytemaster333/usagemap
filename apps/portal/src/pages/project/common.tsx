// SPDX-License-Identifier: Apache-2.0
// Shared pieces of the Stellar ecosystem project pages (approved project dashboard design): the top-bar range picker, data
// hooks for the project, its websites and API services, range arithmetic for "compared with the period before",
// the "Coming" badge for figures the API does not serve yet, and small formatting helpers. Page-level classes live
// in ./project.css (prefix `um-p-`).

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../../api/client.ts";
import { TopBarSlot } from "../../components/shell/TopBarSlot.tsx";
import { type Delta, Icon, Segmented, StatusBadge } from "../../components/ui/index.ts";
import { METRIC_DEFINITIONS, type MetricKey } from "../../lib/definitions.gen.ts";
import { TenantNav } from "../TenantNav.tsx";
import "./project.css";

export const PROJECT_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type ProjectRange = (typeof PROJECT_RANGES)[number];

export function parseProjectRange(v: unknown, fallback: ProjectRange = "30d"): ProjectRange {
  return (PROJECT_RANGES as readonly unknown[]).includes(v) ? (v as ProjectRange) : fallback;
}

export const RANGE_SUB: Record<ProjectRange, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

/** The range picker on the right of the top bar. */
export function RangePicker<T extends string>({
  value,
  onChange,
  options = PROJECT_RANGES as unknown as readonly T[],
}: {
  value: T;
  onChange: (v: T) => void;
  options?: readonly T[] | undefined;
}) {
  return (
    <TopBarSlot>
      <Segmented
        label="Date range"
        options={options.map((r) => ({ value: r, label: r }))}
        value={value}
        onChange={onChange}
      />
    </TopBarSlot>
  );
}

/** Every project page starts with the secret-seed warning when one is open. */
export function ProjectFrame({ tenantId, children }: { tenantId: string; children: ReactNode }) {
  return (
    <>
      <TenantNav tenantId={tenantId} />
      {children}
    </>
  );
}

export function useTenant(tenantId: string) {
  return useQuery({
    queryKey: ["tenant", tenantId],
    queryFn: () => api.call("getTenant", { path: { tenantId } }),
  });
}

export function useSites(tenantId: string) {
  return useQuery({
    queryKey: ["sites", tenantId],
    queryFn: () => api.call("listSites", { path: { tenantId } }),
  });
}

export function useServiceList(tenantId: string) {
  return useQuery({
    queryKey: ["services", tenantId],
    queryFn: () => api.call("listServices", { path: { tenantId } }),
  });
}

const DAY_MS = 86_400_000;
const z = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Whole UTC days of a range ending today (exclusive): [today − n, today). 24h maps to the last full day. */
export function rangeDays(r: ProjectRange): number {
  return r === "24h" ? 1 : r === "7d" ? 7 : r === "30d" ? 30 : 90;
}

export function completeDays(n: number, now = new Date()): { start: string; end: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: z(today - n * DAY_MS), end: z(today) };
}

/** The window of the range and the one before it, as whole UTC days. */
export function withPrevious(n: number, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    current: { start: z(today - n * DAY_MS), end: z(today) },
    previous: { start: z(today - 2 * n * DAY_MS), end: z(today - n * DAY_MS) },
    both: { start: z(today - 2 * n * DAY_MS), end: z(today) },
  };
}

/** The UTC days in [start, end) as YYYY-MM-DD. */
export function dayList(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "21 Oct" for an ISO day or timestamp; "14:00" for an hour bucket. */
export function axisLabel(iso: string, unit: "hour" | "day" | "month" = "day"): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (unit === "hour") return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  if (unit === "month") return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** Change against the period before, or undefined when there is nothing to compare with. */
export function deltaOf(
  cur: number | null | undefined,
  prev: number | null | undefined,
): Delta | undefined {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0)
    return undefined;
  const pct = ((cur - prev) / prev) * 100;
  const direction = pct > 0.5 ? "up" : pct < -0.5 ? "down" : "flat";
  return {
    text: `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`,
    direction,
    label: "compared with the period before",
  };
}

const NF = new Intl.NumberFormat("en-US");
export const fmtN = (n: number | null | undefined): string =>
  n === null || n === undefined ? "–" : NF.format(Math.round(n));
export const fmtPctN = (share: number | null | undefined, digits = 1): string =>
  share === null || share === undefined ? "–" : `${(share * 100).toFixed(digits)}%`;

/** A figure the platform stores but the API does not serve yet. Never a made-up number. */
export function Coming({ what }: { what?: string | undefined }) {
  return (
    <span title={what ? `${what}: recorded already, not in the API yet` : "Not in the API yet"}>
      <StatusBadge status="off">Coming</StatusBadge>
    </span>
  );
}

/** Share bars for a list of {key,count}: share of the total, "Other" last. */
export function shares<T>(rows: T[], count: (r: T) => number): { row: T; share: number }[] {
  const total = rows.reduce((a, r) => a + count(r), 0);
  return rows.map((row) => ({ row, share: total > 0 ? (count(row) / total) * 100 : 0 }));
}

/** "What this counts": the definition behind a figure (docs/metrics/definitions.md, generated). */
export function MetricDef({
  metric,
  term,
  text,
}: {
  metric?: MetricKey | undefined;
  /** for a figure the generated definitions do not cover yet */
  term?: string | undefined;
  text?: string | undefined;
}) {
  const d = metric ? METRIC_DEFINITIONS[metric] : { term: term ?? "", text: text ?? "" };
  return (
    <details
      className="metric-info um-p-def"
      data-metric={metric ?? term}
      data-testid={metric ? `def-${metric}` : undefined}
    >
      <summary>
        <Icon name="info" size="xs" />
        <span className="um-sr">Definition: {d.term} — </span>
        What this counts
      </summary>
      <p>
        <b>{d.term}.</b> {d.text}
      </p>
    </details>
  );
}
