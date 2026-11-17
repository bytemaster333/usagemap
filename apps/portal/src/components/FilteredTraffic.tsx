// SPDX-License-Identifier: Apache-2.0
// Filtered web traffic (2026-11-19 improvements): the share of events the gateway did not count as verified and the
// reason codes behind it, in plain language. Used on the tenant's Trust page (per website, exact counters) and on the
// public project card (tenant-wide; reason rows already thresholded and rounded by the server, C-95).

import { filteredView, type VerdictCounts } from "../lib/apiFormat.ts";
import { fmtInt } from "../lib/format.ts";
import { MetricInfo } from "./MetricInfo.tsx";

const PCT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export const fmtPct = (s: number | null): string => (s === null ? "—" : `${PCT.format(s * 100)} %`);

const EFFECT: Record<string, string> = {
  suspect: "suspect — raw figures only",
  rejected: "rejected — never counted",
};

export function FilteredTraffic({
  verdicts,
  reasons,
  suppressed = 0,
  caption,
  testId = "filtered-traffic",
}: {
  verdicts: VerdictCounts;
  reasons: ReadonlyArray<{ code: string; verdict: string; count: number }>;
  /** reason rows left out by the k-threshold (public card) */
  suppressed?: number;
  caption: string;
  testId?: string;
}) {
  const f = filteredView(verdicts, reasons);
  if (f.received === 0)
    return (
      <p className="muted" data-testid={`${testId}-empty`}>
        No events received in this period.
      </p>
    );
  return (
    <div className="stack" data-testid={testId}>
      <MetricInfo metric="filtered_share" />
      <p data-metric="filtered_share" data-testid={`${testId}-headline`}>
        <strong>{fmtPct(f.notCounted)}</strong> of {fmtInt(f.received)} events were not counted in
        the verified figures: {fmtPct(f.suspect)} suspect (counted in raw figures only) and{" "}
        {fmtPct(f.rejected)} rejected (never counted).
      </p>
      <div className="table-wrap">
        <table data-testid={`${testId}-reasons`}>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Reason</th>
              <th scope="col">Effect</th>
              <th scope="col" className="num">
                Events
              </th>
              <th scope="col" className="num">
                Share of events
              </th>
            </tr>
          </thead>
          <tbody>
            {f.rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No reason above the reporting threshold.
                </td>
              </tr>
            ) : (
              f.rows.map((r) => (
                <tr key={`${r.code}-${r.verdict}`}>
                  <th scope="row">
                    {r.label} <code className="small muted">{r.code}</code>
                  </th>
                  <td>{EFFECT[r.verdict] ?? r.verdict}</td>
                  <td className="num">{fmtInt(r.count)}</td>
                  <td className="num">{fmtPct(r.share)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        An event can have several reasons, so the reasons need not add up to the total.
        {suppressed > 0
          ? ` ${fmtInt(suppressed)} less frequent ${suppressed === 1 ? "reason is" : "reasons are"} not shown (below the minimum count; counts are rounded).`
          : ""}
      </p>
    </div>
  );
}
