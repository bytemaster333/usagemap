// SPDX-License-Identifier: Apache-2.0
// Web › Campaigns (operatorCampaignComparison): a campaign window against a baseline window, per day so windows of
// different lengths compare fairly. The API compares 2 to 10 projects at a time: the picked projects of the Projects
// tab, otherwise the ten with the most verified page views under the current filters. A large jump with a trust
// score under 80 is marked for a closer look; the score never changes a figure.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { api } from "../../api/client.ts";
import {
  Button,
  Card,
  EmptyState,
  Icon,
  LoadingState,
  Note,
  TableScroll,
} from "../../components/ui/index.ts";
import { daysOf } from "../../lib/days.ts";
import { customRange, dayString } from "../../lib/range.ts";
import { filterQuery, spanOf } from "./common.tsx";
import { LineChart, Num, OpQueryState, PName, PrivacyFloor, Track, TrustCell } from "./kit.tsx";
import { awardLine, type OpSearch, withOp } from "./model.ts";

const DAY_MS = 86_400_000;
const MAX_CAMPAIGN = 10;

function defaults() {
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  const d = (n: number) => dayString(new Date(today - n * DAY_MS));
  return { bFrom: d(14), bTo: d(8), cFrom: d(7), cTo: d(1) };
}

export function WebCampaigns({ search }: { search: OpSearch }) {
  const id = useId();
  const [form, setForm] = useState(defaults);
  const [applied, setApplied] = useState(form);
  const [error, setError] = useState<string | null>(null);
  const span = spanOf(search);
  const base = "error" in span ? null : filterQuery(search, span);
  const b = customRange(applied.bFrom, applied.bTo);
  const c = customRange(applied.cFrom, applied.cTo);
  const valid = !("error" in b) && !("error" in c);

  const top = useQuery({
    queryKey: ["op-web-projects", "campaign-top", base, search.ids],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorWebProjects", {
        query: {
          ...(base as NonNullable<typeof base>),
          variant: "verified",
          sort: "-pageviews",
          limit: 200,
        },
      }),
  });
  const ids =
    search.ids.length >= 2
      ? search.ids
      : (top.data?.items ?? [])
          .filter((r) => r.pageviews > 0)
          .slice(0, MAX_CAMPAIGN)
          .map((r) => r.tenant_id);
  const cq = valid
    ? {
        tenant_ids: ids,
        baseline_start: b.start,
        baseline_end: b.end,
        campaign_start: c.start,
        campaign_end: c.end,
        variant: search.variant,
      }
    : null;
  const cmp = useQuery({
    queryKey: ["op-campaign", cq],
    enabled: !!cq && ids.length >= 2,
    queryFn: () => api.json("operatorCampaignComparison", { query: cq as NonNullable<typeof cq> }),
  });
  const chartSpan = valid
    ? { start: [b.start, c.start].sort()[0] as string, end: [b.end, c.end].sort()[1] as string }
    : null;
  const chart = useQuery({
    queryKey: ["op-web-summary", "campaign", chartSpan, search.min_level, ids],
    enabled: !!chartSpan && ids.length >= 2,
    queryFn: () =>
      api.json("operatorWebSummary", {
        query: {
          ...(chartSpan as NonNullable<typeof chartSpan>),
          min_level: "L0",
          tenant_ids: ids,
          variant: "verified",
        },
      }),
  });
  const chartDays = chartSpan ? daysOf(chartSpan) : [];
  const bandFrom = valid ? chartDays.indexOf(dayString(new Date(c.start))) : -1;
  const bandTo = valid ? chartDays.indexOf(dayString(new Date(Date.parse(c.end) - DAY_MS))) : -1;
  const names = new Map((top.data?.items ?? []).map((r) => [r.tenant_id, r]));

  return (
    <>
      <p className="um-op-lead">
        Compare a campaign window with a baseline window. Figures are per day, so windows of
        different lengths compare fairly. A large jump with a low trust score is worth a closer
        look.
      </p>
      <Card title="Windows" sub="Verified page views of the compared projects">
        <form
          className="um-op-camp-form"
          onSubmit={(e) => {
            e.preventDefault();
            const bb = customRange(form.bFrom, form.bTo);
            const cc = customRange(form.cFrom, form.cTo);
            if ("error" in bb) return setError(`Baseline: ${bb.error}`);
            if ("error" in cc) return setError(`Campaign: ${cc.error}`);
            setError(null);
            setApplied(form);
          }}
        >
          <fieldset className="um-op-camp-w">
            <legend>Baseline</legend>
            <label htmlFor={`${id}-bf`} className="um-sr">
              Baseline first day
            </label>
            <input
              id={`${id}-bf`}
              className="um-inp um-inp--mono"
              type="date"
              value={form.bFrom}
              onChange={(e) => setForm({ ...form, bFrom: e.target.value })}
            />
            <span aria-hidden="true">–</span>
            <label htmlFor={`${id}-bt`} className="um-sr">
              Baseline last day
            </label>
            <input
              id={`${id}-bt`}
              className="um-inp um-inp--mono"
              type="date"
              value={form.bTo}
              onChange={(e) => setForm({ ...form, bTo: e.target.value })}
            />
          </fieldset>
          <fieldset className="um-op-camp-w">
            <legend>Campaign</legend>
            <label htmlFor={`${id}-cf`} className="um-sr">
              Campaign first day
            </label>
            <input
              id={`${id}-cf`}
              className="um-inp um-inp--mono"
              type="date"
              value={form.cFrom}
              onChange={(e) => setForm({ ...form, cFrom: e.target.value })}
            />
            <span aria-hidden="true">–</span>
            <label htmlFor={`${id}-ct`} className="um-sr">
              Campaign last day
            </label>
            <input
              id={`${id}-ct`}
              className="um-inp um-inp--mono"
              type="date"
              value={form.cTo}
              onChange={(e) => setForm({ ...form, cTo: e.target.value })}
            />
          </fieldset>
          <Button variant="primary" type="submit">
            Compare
          </Button>
        </form>
        {error ? (
          <Note tone="bad" role="alert">
            {error}
          </Note>
        ) : null}
        {ids.length < 2 && !top.isPending ? null : chart.isPending ? (
          <LoadingState block />
        ) : chart.data ? (
          <LineChart
            height={200}
            label="Verified page views per day across the baseline and campaign windows"
            days={chart.data.days.map((d) => d.day)}
            band={
              bandFrom >= 0 && bandTo >= bandFrom
                ? { from: bandFrom, to: bandTo, label: "Campaign" }
                : undefined
            }
            series={[
              {
                name: "Verified page views",
                color: "#111111",
                area: true,
                values: chart.data.days.map((d) => d.pageviews),
              },
            ]}
          />
        ) : null}
      </Card>
      <Card
        title="Stellar ecosystem projects"
        flush
        className="um-op-card-flush"
        actions={<PrivacyFloor privacy={cmp.data?.privacy} />}
        data-testid="campaign-table"
      >
        {search.ids.length < 2 ? (
          <div className="um-op-filters">
            <p className="um-op-hint">
              Comparing the {MAX_CAMPAIGN} projects with the most verified page views. Pick 2 to 4
              projects on the{" "}
              <Link
                to="/operator/web"
                search={withOp(search, { tab: undefined })}
                className="um-link"
              >
                Stellar ecosystem projects tab
              </Link>{" "}
              to compare those instead.
            </p>
          </div>
        ) : null}
        {top.isPending ? (
          <LoadingState />
        ) : ids.length < 2 ? (
          <EmptyState plain title="Not enough Stellar ecosystem projects with page views">
            A comparison needs at least two projects with verified page views under the current
            filters.
          </EmptyState>
        ) : (
          <OpQueryState
            query={cmp}
            plain
            isEmpty={(d) => d.rows.length === 0}
            empty={<EmptyState plain title="No figures for these windows" />}
          >
            {(d) => {
              const rows = [...d.rows].sort(
                (x, y) => (y.pageviews_per_day_ratio ?? -1) - (x.pageviews_per_day_ratio ?? -1),
              );
              const mx = Math.max(0, ...rows.map((r) => r.pageviews_per_day_ratio ?? 0));
              return (
                <TableScroll label="Campaign comparison" stickyFirst>
                  <table className="um-table um-op-table">
                    <thead>
                      <tr>
                        <th scope="col">Project</th>
                        <th scope="col" className="um-r">
                          Baseline / day
                        </th>
                        <th scope="col" className="um-r">
                          Campaign / day
                        </th>
                        <th scope="col">Page views ratio</th>
                        <th scope="col" className="um-r">
                          Visitors ratio
                        </th>
                        <th scope="col" className="um-r">
                          Trust
                        </th>
                        <th scope="col">
                          <span className="um-sr">Flag</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const p = names.get(r.tenant_id);
                        const ratio = r.pageviews_per_day_ratio ?? null;
                        const trust = p?.trust_score_28d ?? null;
                        return (
                          <tr key={r.tenant_id} data-testid={`camp-${r.slug}`}>
                            <th scope="row">
                              <PName sub={p ? awardLine(p) : r.slug}>
                                <Link
                                  to="/operator/tenants/$tenantId"
                                  params={{ tenantId: r.tenant_id }}
                                >
                                  {p?.name ?? r.slug}
                                </Link>
                              </PName>
                            </th>
                            <td className="um-r">
                              <Num
                                value={
                                  r.baseline_days ? r.baseline.pageviews / r.baseline_days : null
                                }
                              />
                            </td>
                            <td className="um-r">
                              <Num
                                value={
                                  r.campaign_days ? r.campaign.pageviews / r.campaign_days : null
                                }
                              />
                            </td>
                            <td>
                              {ratio === null ? (
                                <span className="um-op-na">—</span>
                              ) : (
                                <span className="um-op-cbar">
                                  <Track
                                    value={ratio}
                                    max={mx}
                                    className={ratio >= 1 ? "um-op-trk--good" : "um-op-trk--bad"}
                                    minFill={2}
                                  />
                                  <b className="um-op-mono">×{ratio.toFixed(2)}</b>
                                </span>
                              )}
                            </td>
                            <td className="um-r">
                              {r.visitors_per_day_ratio === null ||
                              r.visitors_per_day_ratio === undefined
                                ? "—"
                                : `×${r.visitors_per_day_ratio.toFixed(2)}`}
                            </td>
                            <td className="um-r">
                              <TrustCell score={trust} />
                            </td>
                            <td>
                              {ratio !== null && ratio >= 3 && (trust ?? 0) < 80 ? (
                                <span
                                  className="um-op-chip-org"
                                  title="Traffic rose sharply while the trust score is below 80."
                                >
                                  <Icon name="alert" />
                                  Check
                                </span>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableScroll>
              );
            }}
          </OpQueryState>
        )}
      </Card>
    </>
  );
}
