// SPDX-License-Identifier: Apache-2.0
// Web › Trust scores (operatorTrustScores): how believable each website's traffic is, 0–100, from eight signals with
// the published weights (platform setting `trust_weights`). Score = 100 − Σ weight × p, p ∈ [0, 1] per signal
// (services/jobs trust algorithm). Advice for readers only: it never changes a counted figure.

import { useQuery } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { Card, EmptyState, Note, Segmented, TableScroll } from "../../components/ui/index.ts";
import { filterQuery, spanOf, useOpSettings } from "./common.tsx";
import { BarList, bandOf, Num, OpQueryState, PName, StackBar, TrustCell } from "./kit.tsx";
import { fmtShareD, type OpSearch, reasonText, TRUST_SIGNALS } from "./model.ts";

type TrustRow = ControlPlane.OpTrustRow;

/** The latest score per website and window. */
export function latestPerSite(items: readonly TrustRow[], windowDays: 1 | 28): TrustRow[] {
  const by = new Map<string, TrustRow>();
  for (const r of items) {
    if (r.window_days !== windowDays) continue;
    const cur = by.get(r.site_id);
    if (!cur || r.day > cur.day) by.set(r.site_id, r);
  }
  return [...by.values()].sort(
    (a, b) => (a.score ?? 999) - (b.score ?? 999) || a.slug.localeCompare(b.slug),
  );
}

export function WebTrust({ search }: { search: OpSearch }) {
  const [win, setWin] = useState<"28" | "1">("28");
  const [sel, setSel] = useState<string | null>(null);
  const span = spanOf(search);
  const base = "error" in span ? null : filterQuery(search, span);
  const trust = useQuery({
    queryKey: ["op-trust", base],
    enabled: !!base,
    queryFn: () =>
      api.call("operatorTrustScores", {
        query: { ...(base as NonNullable<typeof base>), limit: 200 },
      }),
  });
  const projects = useQuery({
    queryKey: ["op-web-projects", "trust-names", base],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorWebProjects", {
        query: {
          ...(base as NonNullable<typeof base>),
          variant: "verified",
          min_level: "L0",
          limit: 200,
        },
      }),
    staleTime: 60_000,
  });
  const settings = useOpSettings();
  const weightsRaw = settings.data?.find((s) => s.key === "trust_weights")?.value;
  const weights =
    weightsRaw && typeof weightsRaw === "object" ? (weightsRaw as Record<string, number>) : null;
  const names = new Map((projects.data?.items ?? []).map((p) => [p.tenant_id, p]));

  return (
    <>
      <p className="um-op-lead">
        How believable each project’s web traffic is, from 0 to 100. The score combines eight
        signals with published weights. It is advice for readers; it never changes the counted
        figures.
      </p>
      <OpQueryState
        query={trust}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState title="No trust scores in this window">
            Scores are computed daily for websites with enough traffic.
          </EmptyState>
        }
      >
        {(d) => {
          const rows = latestPerSite(d.items, win === "28" ? 28 : 1);
          const cur = rows.find((r) => r.site_id === sel) ?? rows[0];
          const bands = { high: 0, medium: 0, low: 0, unscored: 0 };
          for (const r of rows) bands[bandOf(r.score)]++;
          const nameOf = (r: TrustRow) => names.get(r.tenant_id)?.name ?? r.slug;
          const sitesOf = (t: string) => rows.filter((x) => x.tenant_id === t).length;
          return (
            <div className="um-grid um-g21 um-op-start">
              <div className="um-op-col">
                <Card
                  title="Stellar ecosystem projects by score"
                  actions={
                    <Segmented
                      label="Window"
                      value={win}
                      onChange={setWin}
                      options={[
                        { value: "28", label: "28 days" },
                        { value: "1", label: "Yesterday" },
                      ]}
                    />
                  }
                >
                  <StackBar
                    label="Websites by trust band"
                    parts={[
                      { key: "high", value: bands.high, cls: "um-op-f-good", label: "High · 80+" },
                      {
                        key: "medium",
                        value: bands.medium,
                        cls: "um-op-f-mid",
                        label: "Medium · 50–79",
                      },
                      { key: "low", value: bands.low, cls: "um-op-f-low", label: "Low · under 50" },
                      {
                        key: "unscored",
                        value: bands.unscored,
                        cls: "um-op-f-none",
                        label: "Not scored",
                      },
                    ]}
                  />
                </Card>
                <Card
                  title="Scores"
                  sub="Lowest first · pick a website to see its signals"
                  flush
                  className="um-op-card-flush"
                >
                  {rows.length === 0 ? (
                    <EmptyState plain title="No scores for this window" />
                  ) : (
                    <TableScroll label="Trust scores" stickyFirst>
                      <table className="um-table um-op-table" data-testid="trust-table">
                        <thead>
                          <tr>
                            <th scope="col">Project</th>
                            <th scope="col" className="um-r">
                              Score
                            </th>
                            <th scope="col" className="um-r">
                              Filtered
                            </th>
                            <th scope="col">Main reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => {
                            const p = names.get(r.tenant_id);
                            const on = r.site_id === cur?.site_id;
                            return (
                              <tr key={r.site_id} className={on ? "um-op-picked" : undefined}>
                                <th scope="row">
                                  <PName
                                    sub={
                                      p ? (
                                        <>
                                          <Num value={p.pageviews} /> page views
                                          {sitesOf(r.tenant_id) > 1 ? " · one of its websites" : ""}
                                        </>
                                      ) : (
                                        r.slug
                                      )
                                    }
                                  >
                                    <button
                                      type="button"
                                      className="um-op-tlink"
                                      aria-pressed={on}
                                      onClick={() => setSel(r.site_id)}
                                    >
                                      {nameOf(r)}
                                    </button>
                                  </PName>
                                </th>
                                <td className="um-r">
                                  <TrustCell score={r.score} />
                                </td>
                                <td
                                  className="um-r"
                                  title="Share of events marked suspect or rejected"
                                >
                                  {r.decision_rate === null || r.decision_rate === undefined
                                    ? "—"
                                    : fmtShareD(r.decision_rate, 0)}
                                </td>
                                <td className="um-op-wrap um-op-det">
                                  {r.reason_codes[0] ? (
                                    reasonText(r.reason_codes[0])
                                  ) : (
                                    <span className="um-muted">No concerns</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </TableScroll>
                  )}
                </Card>
              </div>
              <div className="um-op-col">
                {cur ? <Signals row={cur} name={nameOf(cur)} weights={weights} /> : null}
                <Card
                  title="Weights"
                  sub="Score = 100 − points lost. Each signal loses points up to its weight."
                  actions={
                    cur ? (
                      <span
                        className="um-op-hint"
                        title="Thresholds of the published trust algorithm; weights are the platform setting trust_weights"
                      >
                        Method {cur.algorithm_version}
                      </span>
                    ) : null
                  }
                >
                  {weights ? (
                    <BarList
                      rows={TRUST_SIGNALS.filter((s) => weights[s.key] !== undefined).map((s) => ({
                        key: s.key,
                        label: s.label,
                        value: weights[s.key] ?? 0,
                        shown: String(weights[s.key]),
                        hint: s.hint,
                      }))}
                    />
                  ) : settings.isPending ? null : (
                    <Note>
                      The weights are a platform setting that only an operator admin can read here.
                    </Note>
                  )}
                </Card>
              </div>
            </div>
          );
        }}
      </OpQueryState>
    </>
  );
}

function Signals({
  row,
  name,
  weights,
}: {
  row: TrustRow;
  name: string;
  weights: Record<string, number> | null;
}) {
  const comps = TRUST_SIGNALS.filter((s) => row.components[s.key]);
  return (
    <Card
      title={name}
      tone="web"
      actions={<TrustCell score={row.score} />}
      data-testid="trust-signals"
    >
      {row.score === null ? (
        <Note icon="clock">
          {reasonText("insufficient_data")}. A score appears after enough days of traffic.
        </Note>
      ) : (
        <>
          <BarList
            tint="web"
            rows={comps.map((s) => {
              const c = row.components[s.key] as ControlPlane.TrustComponent;
              const kept = Math.round((1 - c.p) * 100);
              return {
                key: s.key,
                label: (
                  <>
                    {s.label}
                    {weights?.[s.key] !== undefined ? <small>×{weights[s.key]}</small> : null}
                  </>
                ),
                value: kept,
                shown: String(kept),
                hint: c.explanation ?? s.hint,
              };
            })}
          />
          <div className="um-op-fld">
            <span className="um-op-lb">Reason codes</span>
            {row.reason_codes.length ? (
              <ul className="um-op-ilist">
                {row.reason_codes.map((r) => (
                  <li key={r}>
                    <div>
                      <b>{reasonText(r)}</b>
                      <small className="um-op-mono">{r}</small>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="um-op-hint">None. Every signal is within its usual range.</span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
