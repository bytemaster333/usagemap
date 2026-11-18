// SPDX-License-Identifier: Apache-2.0
// "Assurance per day" on the API page's Data quality tab (getApiAssurance): one cell per UTC day, A2 (also matches
// the ledger / probes), A1 (plausibility checks pass) or A0 (unchecked), with the latest day's reasons.

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.ts";
import { Card, ErrorState, LoadingState, StatusBadge } from "../../components/ui/index.ts";
import { ASSURANCE_REASON_TEXT } from "../../lib/usage.ts";
import { completeDays, dayList } from "./common.tsx";

const LEVEL_CLASS = { A2: "um-c-webmid", A1: "um-c-weblight", A0: "um-c-line" } as const;

export function ApiAssurancePanel({
  tenantId,
  serviceId,
}: {
  tenantId: string;
  serviceId: string;
}) {
  const span = completeDays(30);
  const q = useQuery({
    queryKey: ["api-assurance", tenantId, serviceId, span.start],
    queryFn: () => api.call("getApiAssurance", { path: { tenantId, serviceId }, query: span }),
  });
  const days = dayList(span.start, span.end);
  const byDay = new Map((q.data ?? []).map((d) => [d.day.slice(0, 10), d]));
  const count = (l: "A0" | "A1" | "A2") => (q.data ?? []).filter((d) => d.level === l).length;
  const last = [...(q.data ?? [])].sort((a, b) => (a.day < b.day ? 1 : -1))[0];
  const n = days.length;
  return (
    <Card
      title="Assurance per day"
      sub="A2: also passes our outside checks · A1: plausibility checks pass · A0: unchecked"
      data-testid="api-assurance-days"
    >
      {q.error ? (
        <ErrorState error={q.error} plain onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <LoadingState />
      ) : (
        <>
          <svg
            className="um-p-strip"
            role="img"
            aria-label={`Assurance level per day over the last ${n} days`}
            preserveAspectRatio="none"
          >
            {days.map((d, i) => {
              const a = byDay.get(d);
              return (
                <rect
                  key={d}
                  className={a ? LEVEL_CLASS[a.level] : "um-c-line"}
                  x={`${(i * 100) / n}%`}
                  width={`${100 / n - 0.4}%`}
                  height="100%"
                  rx="3"
                >
                  <title>{`${d}: ${a ? a.level : "no data"}`}</title>
                </rect>
              );
            })}
          </svg>
          <p className="um-p-fine">
            A2 <b>{count("A2")}</b> · A1 <b>{count("A1")}</b> · A0 <b>{count("A0")}</b> days
          </p>
          {last ? (
            <p className="um-p-tools">
              <StatusBadge status="set">Latest: {last.level}</StatusBadge>
              <StatusBadge status="off">
                On-chain: {last.onchain_badge.replace("_", " ")}
              </StatusBadge>
              {last.reason_codes.map((c) => (
                <span key={c} className="um-p-fine">
                  {ASSURANCE_REASON_TEXT[c] ?? c}
                </span>
              ))}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
