// SPDX-License-Identifier: Apache-2.0
// Shared logic of the SCF-operator console (operator.global-view-credentials, operator.web-*, operator.api-*): the role check, whole-UTC-day spans, the
// filter parameters every operator read shares, the comparison selection and the sortable table header. Breakdown
// rows carry the minimum count and rounding; every other figure is exact (C-91, C-95).

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../../api/client.ts";
import { useSession } from "../../auth/session.ts";
import { type DaySpan, daySpan } from "../../lib/days.ts";
import type { OperatorSearch } from "../../lib/search.ts";
import { MAX_PICKS, nextSort } from "./model.ts";

export const MAX_COMPARE = MAX_PICKS;

export function useOperatorRole(): "operator" | "operator_admin" | null {
  const s = useSession();
  return s.data?.kind === "operator" ? (s.data.platform_role ?? "operator") : null;
}

export function spanOf(search: OperatorSearch): DaySpan | { error: string } {
  return daySpan(search.range, search.from, search.to);
}

/** The filter parameters every operator read shares. */
export function filterQuery(search: OperatorSearch, span: DaySpan) {
  return {
    start: span.start,
    end: span.end,
    min_level: search.min_level,
    ...(search.awarded === "any" ? {} : { scf_awarded: search.awarded === "yes" }),
    ...(search.band === "any" ? {} : { trust_band: search.band }),
  };
}

export function toggleId(ids: string[], id: string, max = MAX_COMPARE): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= max ? ids : [...ids, id];
}

/** The published platform settings (thresholds the pages state instead of hard-coding them). */
export function useOpSettings() {
  return useQuery({
    queryKey: ["op-settings"],
    queryFn: () => api.call("operatorGetSettings", {}),
    staleTime: 60_000,
  });
}

export function settingNumber(
  settings: { key: string; value: unknown }[] | undefined,
  key: string,
): number | null {
  const v = settings?.find((s) => s.key === key)?.value;
  return typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;
}

/**
 * A sortable column header: the active column shows ▲/▼, the others ↕. A new column starts descending (largest
 * first) unless `ascFirst` (names, "lower is better" figures).
 */
export function SortTh({
  label,
  field,
  sort,
  onSort,
  num = true,
  ascFirst = false,
  className,
}: {
  label: ReactNode;
  field: string;
  sort: string;
  onSort: (s: string) => void;
  num?: boolean;
  ascFirst?: boolean;
  className?: string;
}) {
  const active = sort.replace(/^-/, "") === field;
  const desc = sort.startsWith("-");
  const cls = [num ? "um-r" : "", className ?? ""].filter(Boolean).join(" ") || undefined;
  return (
    <th
      scope="col"
      className={cls}
      aria-sort={active ? (desc ? "descending" : "ascending") : undefined}
    >
      <button
        type="button"
        className="um-sort"
        onClick={() => onSort(nextSort(sort, field, ascFirst))}
      >
        {label}
        <span className="um-op-sortarr" aria-hidden="true">
          {active ? (desc ? "▼" : "▲") : "↕"}
        </span>
      </button>
    </th>
  );
}
