// SPDX-License-Identifier: Apache-2.0
// Tenant web dashboard (dashboard.*). Figures and their meaning follow the contract exactly:
//   - page views and unique visitors: a verified and a raw figure (C-73); the toggle chooses which one the tiles,
//     the time series and the breakdown tables show, and the tiles always name both;
//   - visits, bounce rate and visit duration: one figure each over all identified, non-rejected events, shown next to
//     the share of suspect page views — there is no verified-only variant (C-73);
//   - unique visitors over several days are the sum of daily uniques (ADR-0007, C-110);
//   - read path `range.source` live / rollup / mixed with `live_start` and `partial_today` (C-109, C-112);
//   - compare with the previous period, or "comparison unavailable" when it cannot be composed (C-112(5));
//   - time series by hour hide the visit metrics, which exist per UTC day only (C-112(4));
//   - the verified-vs-raw band chart (plan D-3) draws the suspect gap per day with the site's anomaly flags as
//     markers; a click on a day narrows the page to that day, a click on a marker shows its reasons and annotations;
//   - breakdown rows arrive rounded to 10 with small rows merged into "Other" when anonymous reports are on (C-51,
//     C-95); the portal shows them as received and says so; totals are exact.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { type ReactNode, useEffect, useId, useState } from "react";
import { api, operationUrl } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import { BandChart } from "../components/BandChart.tsx";
import { PrivacyCard } from "../components/PrivacyCard.tsx";
import { TopBarSlot } from "../components/shell/TopBarSlot.tsx";
import {
  Button,
  Card,
  Chart,
  type Delta,
  ErrorState,
  Icon,
  isPartialBucket,
  Kpi,
  Legend,
  LoadingState,
  Note,
  partialLast,
  Segmented,
} from "../components/ui/index.ts";
import type { MetricKey } from "../lib/definitions.gen.ts";
import {
  countryName,
  DASH,
  fmtBucket,
  fmtDay,
  fmtDelta,
  fmtDuration,
  fmtInt,
  fmtPct,
  fmtRange,
  fmtShare,
} from "../lib/format.ts";
import {
  allowedUnits,
  customRange,
  dayString,
  defaultUnit,
  presetDays,
  type RangeKind,
  type Unit,
  visitSeriesAvailable,
} from "../lib/range.ts";
import type { DashboardSearch } from "../lib/search.ts";
import { anomalyFlags } from "../lib/usage.ts";
import { MetricDef } from "./project/common.tsx";
import { useSite } from "./SiteLayout.tsx";
import { FlagCard } from "./Trust.tsx";

type WebStats = ControlPlane.WebStats;
type RangeEcho = ControlPlane.RangeEcho;
type BreakdownRow = ControlPlane.BreakdownRow;
type Dimension = ControlPlane.WebBreakdown["dimension"];

const SOURCE_TEXT: Record<RangeEcho["source"], string> = {
  live: "Live",
  rollup: "Daily rollups",
  mixed: "Mixed",
};

/** The query parameters for the chosen range, or an error for an incomplete custom range. */
export function rangeQuery<S extends Pick<DashboardSearch, "range" | "from" | "to">>(
  s: S,
):
  | { query: { range: RangeKind; start?: string; end?: string }; days: number | null }
  | { error: string } {
  if (s.range !== "custom") return { query: { range: s.range }, days: presetDays(s.range) };
  const c = customRange(s.from, s.to);
  if ("error" in c) return c;
  return { query: { range: "custom", start: c.start, end: c.end }, days: c.days };
}

export function SourceIndicator({ range }: { range: RangeEcho }) {
  let text: string;
  if (range.source === "live") text = "Live: the analytics engine answered the whole range.";
  else if (range.source === "rollup")
    text = "Daily rollups: this range is answered from our stored daily and hourly aggregates.";
  else
    text = `Mixed: daily rollups before ${range.live_start ? fmtDay(range.live_start) : "the live window"}, live from then on.`;
  return (
    <p className="um-p-source" data-testid="source-indicator">
      <b>Source: {SOURCE_TEXT[range.source]}.</b> {text}
      {range.partial_today ? (
        <span data-testid="partial-today">
          {" "}
          Today's figures come from the hourly rollup because the live engine did not answer in
          time; they can be up to an hour behind.
        </span>
      ) : null}
    </p>
  );
}

/** A KPI with the figure's definition and, when comparing, the change against the previous period. */
function WebKpi({
  metric,
  icon,
  label,
  value,
  unit,
  sub,
  delta,
  deltaText,
  testId,
}: {
  metric: MetricKey;
  icon: "users" | "filecheck" | "pointer" | "repeat" | "clock" | "filter";
  label: string;
  value: string;
  unit?: string | undefined;
  sub?: ReactNode;
  delta?: Delta | undefined;
  /** "+12.4%" text for the previous-period line; null: no comparison possible */
  deltaText?: string | null | undefined;
  testId: string;
}) {
  return (
    <Kpi
      testId={testId}
      tone="web"
      icon={icon}
      label={label}
      value={value === DASH ? null : value}
      unit={unit}
      delta={delta}
      foot={
        <>
          {sub ? <span className="um-p-kpisub">{sub}</span> : null}
          {deltaText !== undefined ? (
            <span className="um-p-kpisub" data-testid={`${testId}-delta`}>
              {deltaText === null ? "No comparison" : `${deltaText} vs previous period`}
            </span>
          ) : null}
          <MetricDef metric={metric} />
        </>
      }
    />
  );
}

/** Difference in percentage points for a rate, e.g. "+1.2 pp". */
function fmtPp(cur: number | null | undefined, prev: number | null | undefined): string | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  const d = cur - prev;
  const a = Math.abs(d).toFixed(1);
  if (a === "0.0") return "0.0 pp";
  return d > 0 ? `+${a} pp` : `−${a} pp`;
}

function asDelta(text: string | null | undefined, invert = false): Delta | undefined {
  if (!text) return undefined;
  const neg = text.startsWith("−") || text.startsWith("-");
  const zero = /^[+−-]?0(\.0+)?( ?%| pp)?$/.test(text);
  const up = !neg && !zero;
  return {
    text,
    direction: zero ? "flat" : up !== invert ? "up" : "down",
    label: "compared with the previous period",
  };
}

export function StatTiles({
  stats,
  variant,
  compare,
}: {
  stats: WebStats;
  variant: "verified" | "raw";
  compare: boolean;
}) {
  const cur = stats[variant];
  const prev = stats.previous ? stats.previous[variant] : undefined;
  const vm = stats.visit_metrics;
  const pvm = stats.previous?.visit_metrics;
  const showDelta = compare && !!stats.previous;
  const dPv = showDelta ? fmtDelta(cur?.pageviews, prev?.pageviews) : undefined;
  const dVis = showDelta ? fmtDelta(cur?.visitors, prev?.visitors) : undefined;
  const dVisits = showDelta ? fmtDelta(vm.visits, pvm?.visits) : undefined;
  const dBounce = showDelta ? fmtPp(vm.bounce_rate_pct, pvm?.bounce_rate_pct) : undefined;
  const dDur = showDelta ? fmtDelta(vm.avg_visit_duration_s, pvm?.avg_visit_duration_s) : undefined;
  return (
    <>
      <section className="um-grid um-p-g6" aria-label="Summary">
        <WebKpi
          metric={variant === "verified" ? "visitors_verified" : "visitors_raw"}
          testId="tile-visitors"
          icon="users"
          label="Unique visitors"
          value={fmtInt(cur?.visitors)}
          sub={`Verified ${fmtInt(stats.verified?.visitors)} · Raw ${fmtInt(stats.raw?.visitors)}`}
          delta={asDelta(dVis)}
          deltaText={dVis}
        />
        <WebKpi
          metric={variant === "verified" ? "pageviews_verified" : "pageviews_raw"}
          testId="tile-pageviews"
          icon="filecheck"
          label="Page views"
          value={fmtInt(cur?.pageviews)}
          sub={`Verified ${fmtInt(stats.verified?.pageviews)} · Raw ${fmtInt(stats.raw?.pageviews)} · ${fmtInt(
            cur?.pageviews_unidentified,
          )} without visitor identifier`}
          delta={asDelta(dPv)}
          deltaText={dPv}
        />
        <WebKpi
          metric="visits"
          testId="tile-visits"
          icon="pointer"
          label="Visits"
          value={fmtInt(vm.visits)}
          delta={asDelta(dVisits)}
          deltaText={dVisits}
        />
        <WebKpi
          metric="bounce_rate"
          testId="tile-bounce"
          icon="repeat"
          label="Bounce rate"
          value={fmtPct(vm.bounce_rate_pct)}
          sub={`${fmtInt(vm.bounces)} single-page visits`}
          delta={asDelta(dBounce, true)}
          deltaText={dBounce}
        />
        <WebKpi
          metric="avg_visit_duration"
          testId="tile-duration"
          icon="clock"
          label="Visit duration"
          value={fmtDuration(vm.avg_visit_duration_s)}
          delta={asDelta(dDur)}
          deltaText={dDur}
        />
        <WebKpi
          metric="suspect_share"
          testId="tile-suspect"
          icon="filter"
          label="Suspect page views"
          value={fmtShare(vm.suspect_pageview_share)}
          sub="share flagged suspect in this range"
        />
      </section>
      <p className="um-p-fine" data-testid="visit-metrics-note">
        Visits, bounce rate and visit duration are one figure each, computed over all identified,
        non-rejected events — {fmtShare(vm.suspect_pageview_share)} of this range's page views are
        suspect. They have no verified-only variant, because removing events from inside a visit
        would distort them. A visit with any custom or wallet event is not a bounce.
      </p>
    </>
  );
}

const DIMENSIONS: { id: Dimension; title: string; valueHeader: string }[] = [
  { id: "path", title: "Pages", valueHeader: "Page" },
  { id: "referrer", title: "Referrers", valueHeader: "Referrer host" },
  { id: "country", title: "Countries", valueHeader: "Country" },
  { id: "device", title: "Devices", valueHeader: "Device" },
  { id: "browser", title: "Browsers", valueHeader: "Browser" },
  { id: "os", title: "Operating systems", valueHeader: "Operating system" },
  { id: "event", title: "Custom events", valueHeader: "Event" },
];

function rowLabel(dim: Dimension, r: BreakdownRow): string {
  if (r.is_other) return "Other";
  if (dim === "country") return countryName(r.value);
  if (dim === "referrer" && r.value === "") return "Direct / none";
  return r.value;
}

export function BreakdownTable({
  title,
  dimension,
  valueHeader,
  rows,
  truncated,
}: {
  title: string;
  dimension: Dimension;
  valueHeader: string;
  rows: BreakdownRow[];
  truncated: boolean;
}) {
  const isEvent = dimension === "event";
  const max = Math.max(1, ...rows.map((r) => r.share_pct ?? 0));
  return (
    <Card
      tone="web"
      title={title}
      headingLevel={3}
      flush
      data-testid={`breakdown-${dimension}`}
      actions={
        dimension === "path" ? (
          <span className="um-p-fine">paths only, never query strings</span>
        ) : null
      }
    >
      <table className="um-table um-p-bd">
        <caption className="um-sr">{title}</caption>
        <thead>
          <tr>
            <th scope="col">{valueHeader}</th>
            {isEvent ? (
              <th scope="col" className="um-r">
                Events
              </th>
            ) : (
              <>
                <th scope="col" className="um-r">
                  Visitors
                </th>
                <th scope="col" className="um-r">
                  Page views
                </th>
              </>
            )}
            <th scope="col" className="um-r">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={isEvent ? 3 : 4} className="um-muted">
                No data in this range.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={`${r.is_other ? "\u0000other" : r.value}`}
                className={r.is_other ? "um-p-oth" : undefined}
              >
                <td>
                  <span className="um-p-bdk">
                    <svg className="um-p-bdbar" aria-hidden="true" preserveAspectRatio="none">
                      <rect
                        width={`${Math.max(1, ((r.share_pct ?? 0) / max) * 100)}%`}
                        height="100%"
                        rx="5"
                      />
                    </svg>
                    <span>{rowLabel(dimension, r)}</span>
                    {r.is_other ? <span className="um-tag">combined</span> : null}
                  </span>
                </td>
                {isEvent ? (
                  <td className="um-r">{fmtInt(r.events)}</td>
                ) : (
                  <>
                    <td className="um-r">{fmtInt(r.visitors)}</td>
                    <td className="um-r">{fmtInt(r.pageviews)}</td>
                  </>
                )}
                <td className="um-r um-muted">{fmtPct(r.share_pct)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {truncated || dimension === "country" ? (
        <div className="um-p-cardfoot">
          {truncated ? (
            <p>Older days keep only their top 50 rows; the rest is included in “Other”.</p>
          ) : null}
          {dimension === "country" ? (
            <p>
              <a href="https://db-ip.com" rel="noopener noreferrer">
                IP Geolocation by DB-IP
              </a>{" "}
              (CC BY 4.0). Countries come from a truncated address; the full address is never
              stored.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

const TOP_RANGES = ["24h", "7d", "30d", "90d", "12m", "all", "custom"] as const;
const TOP_LABEL: Record<(typeof TOP_RANGES)[number], string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  "12m": "12m",
  all: "All",
  custom: "Custom",
};

/** Top-bar range picker plus the in-page options: custom days, interval, compare. */
function RangeControls({
  search,
  onChange,
}: {
  search: DashboardSearch;
  onChange: (s: DashboardSearch) => void;
}) {
  const id = useId();
  const today = dayString(new Date());
  const [from, setFrom] = useState(search.from ?? "");
  const [to, setTo] = useState(search.to ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    setFrom(search.from ?? "");
    setTo(search.to ?? "");
  }, [search.from, search.to]);
  const rq = rangeQuery(search);
  const days = "error" in rq ? null : rq.days;
  const units = allowedUnits(days);
  const unit = search.unit && units.includes(search.unit) ? search.unit : defaultUnit(days);
  const { unit: _drop, ...withoutUnit } = search;
  const pick = (r: RangeKind) => {
    if (r === "custom") {
      const end = new Date();
      const start = new Date(end.getTime() - 6 * 86_400_000);
      onChange({
        ...withoutUnit,
        range: "custom",
        from: search.from ?? dayString(start),
        to: search.to ?? dayString(end),
      });
    } else {
      const { from: _f, to: _t, ...rest } = withoutUnit;
      onChange({ ...rest, range: r });
    }
  };
  return (
    <>
      <TopBarSlot>
        <Segmented
          label="Date range"
          value={search.range}
          onChange={pick}
          options={TOP_RANGES.map((r) => ({
            value: r,
            label: TOP_LABEL[r],
            icon: r === "custom" ? ("cal" as const) : undefined,
          }))}
        />
      </TopBarSlot>
      <form
        className="um-p-filters"
        aria-label="Dashboard filters"
        onSubmit={(e) => {
          e.preventDefault();
          const c = customRange(from, to);
          if ("error" in c) {
            setFormError(c.error);
            return;
          }
          setFormError(null);
          onChange({ ...withoutUnit, range: "custom", from, to });
        }}
      >
        {search.range === "custom" ? (
          <>
            <label className="um-p-inline" htmlFor={`${id}-from`}>
              <span>First day (UTC)</span>
              <input
                id={`${id}-from`}
                className="um-inp"
                type="date"
                value={from}
                max={today}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="um-p-inline" htmlFor={`${id}-to`}>
              <span>Last day (UTC)</span>
              <input
                id={`${id}-to`}
                className="um-inp"
                type="date"
                value={to}
                max={today}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <Button type="submit" size="sm" variant="primary">
              Apply
            </Button>
          </>
        ) : null}
        <label className="um-p-inline">
          <span>Interval</span>
          <select
            className="um-inp"
            value={unit}
            onChange={(e) => onChange({ ...search, unit: e.target.value as Unit })}
          >
            {units.map((u) => (
              <option key={u} value={u}>
                {u === "hour" ? "Hourly" : u === "day" ? "Daily" : "Monthly"}
              </option>
            ))}
          </select>
        </label>
        <label className="um-p-check">
          <input
            type="checkbox"
            checked={search.compare}
            onChange={(e) => onChange({ ...search, compare: e.target.checked })}
          />
          Compare with previous period
        </label>
        {formError ? (
          <p className="um-fld-err" role="alert">
            {formError}
          </p>
        ) : null}
      </form>
    </>
  );
}

export function SiteDashboardPage() {
  const { tenantId, siteId } = useParams({ from: "/app/t/$tenantId/sites/$siteId/" });
  const search = useSearch({ from: "/app/t/$tenantId/sites/$siteId/" });
  const navigate = useNavigate();
  const site = useSite(tenantId, siteId);
  useTitle(site.data ? `Web · ${site.data.name}` : "Web");
  const path = { tenantId, siteId };
  const rq = rangeQuery(search);
  const ok = !("error" in rq);
  const baseQuery = ok ? rq.query : { range: "30d" as const };
  const days = ok ? rq.days : null;
  const units = allowedUnits(days);
  const unit: Unit = search.unit && units.includes(search.unit) ? search.unit : defaultUnit(days);
  const visitSeries = visitSeriesAvailable(unit);

  const stats = useQuery({
    queryKey: ["web-stats", tenantId, siteId, baseQuery, search.compare],
    enabled: ok,
    queryFn: () =>
      api.call("getWebStats", {
        path,
        query: { ...baseQuery, variant: "both", compare: search.compare ? "previous" : "none" },
      }),
  });
  const series = useQuery({
    queryKey: ["web-timeseries", tenantId, siteId, baseQuery, unit],
    enabled: ok,
    queryFn: () =>
      api.call("getWebTimeseries", {
        path,
        query: {
          ...baseQuery,
          variant: "both",
          unit,
          metrics: visitSeries
            ? ["pageviews", "visitors", "visits", "bounce_rate_pct", "avg_visit_duration_s"]
            : ["pageviews", "visitors"],
        },
      }),
  });
  const breakdowns = useQuery({
    queryKey: ["web-breakdowns", tenantId, siteId, baseQuery],
    enabled: ok,
    queryFn: () =>
      Promise.all(
        DIMENSIONS.map((d) =>
          api.call("getWebBreakdown", {
            path,
            query: { ...baseQuery, variant: "both", dimension: d.id, limit: 10 },
          }),
        ),
      ),
  });

  const onChange = (s: DashboardSearch) =>
    void navigate({ to: "/t/$tenantId/sites/$siteId", params: path, search: s, replace: true });

  const range = stats.data?.range;
  const ts = series.data;
  // Whole UTC days around the series, for the trust scores behind the anomaly markers.
  const DAY_MS = 86_400_000;
  const flagSpan =
    ts && ts.unit === "day"
      ? {
          start: new Date(Math.floor(Date.parse(ts.range.start) / DAY_MS) * DAY_MS)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
          end: new Date(Math.ceil(Date.parse(ts.range.end) / DAY_MS) * DAY_MS)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
        }
      : null;
  const trust = useQuery({
    queryKey: ["trust-scores", tenantId, siteId, flagSpan?.start, flagSpan?.end],
    enabled: flagSpan !== null,
    queryFn: () =>
      api.call("listSiteTrustScores", {
        path,
        query: { start: flagSpan?.start as string, end: flagSpan?.end as string },
      }),
  });
  const annotations = useQuery({
    queryKey: ["annotations", tenantId],
    enabled: flagSpan !== null,
    queryFn: () => api.call("listAnnotations", { path: { tenantId } }),
  });
  const flags = anomalyFlags(trust.data ?? [], annotations.data ?? []);
  const [flagDay, setFlagDay] = useState<string | null>(null);
  const selectedFlag = flags.find((f) => f.day === flagDay) ?? null;
  const verified = search.variant === "verified";
  const variantPoints = ts ? ((verified ? ts.verified : ts.raw) ?? []) : [];
  const exportHref = ok
    ? operationUrl("exportWebDaily", { path, query: { ...baseQuery, variant: "both" } })
    : null;
  const pvRaw = stats.data?.raw?.pageviews ?? 0;
  const pvVer = stats.data?.verified?.pageviews ?? 0;
  const filtered = Math.max(0, pvRaw - pvVer);

  return (
    <>
      <RangeControls search={search} onChange={onChange} />
      {!ok ? (
        <Note tone="bad" role="alert">
          {rq.error}
        </Note>
      ) : null}
      {stats.error ? <ErrorState error={stats.error} onRetry={() => void stats.refetch()} /> : null}
      {stats.data ? (
        <>
          {search.compare && stats.data.comparison_unavailable ? (
            <Note tone="warn">
              <span data-testid="comparison-unavailable">
                Comparison unavailable: the previous period of the same length cannot be composed
                from the live engine and the daily rollups for this range.
              </span>
            </Note>
          ) : null}
          <StatTiles stats={stats.data} variant={search.variant} compare={search.compare} />
        </>
      ) : stats.isLoading && ok ? (
        <LoadingState block label="Loading figures…" />
      ) : null}

      <Card
        title="Traffic"
        sub={
          verified
            ? "Verified events only: passed every check"
            : "Everything that reached the edge, before filtering"
        }
        actions={
          <Legend
            items={[
              { label: "Unique visitors", color: verified ? "web" : "ink2" },
              { label: "Page views", color: "grey", dash: true },
            ]}
          />
        }
      >
        {range ? (
          <div className="um-p-rangeline">
            <span data-testid="range-text">
              <b>{fmtRange(range.start, range.end)}</b> (UTC)
            </span>
            <SourceIndicator range={range} />
          </div>
        ) : null}
        {series.error || trust.error || annotations.error ? (
          <ErrorState error={series.error ?? trust.error ?? annotations.error} plain />
        ) : ts ? (
          <Chart
            partial={partialLast(
              variantPoints.map((p) => p.t),
              ts.unit,
            )}
            labels={variantPoints.map((p) => axisLabel(p.t, ts.unit))}
            label={`Page views and unique visitors (${search.variant})`}
            series={[
              {
                name: "Unique visitors",
                color: verified ? "web" : "ink2",
                data: variantPoints.map((p) => p.visitors ?? null),
                area: true,
              },
              {
                name: "Page views",
                color: "grey",
                data: variantPoints.map((p) => p.pageviews ?? null),
                dash: true,
                thin: true,
              },
            ]}
            height={250}
            table={{
              title: `Page views and unique visitors (${search.variant})`,
              firstColumn:
                ts.unit === "hour" ? "Hour (UTC)" : ts.unit === "day" ? "Day (UTC)" : "Month",
              rows: variantPoints.map((p) => fmtBucket(p.t, ts.unit)),
              format: (v) => fmtInt(v),
            }}
          />
        ) : series.isLoading ? (
          <LoadingState block />
        ) : null}
        {stats.data && pvRaw > 0 ? (
          <Note tone={filtered > 0 ? "warn" : "info"} icon="filter">
            <p>
              <b>{fmtInt(filtered)} page views filtered out</b> (
              {fmtShare(pvRaw > 0 ? filtered / pvRaw : null)}). They stay in the raw figures with
              their reasons.{" "}
              {verified ? (
                <>
                  Switch to <b>All received</b> to compare.
                </>
              ) : null}
            </p>
          </Note>
        ) : null}
        <p className="um-p-fine" data-testid="visitor-note">
          {stats.data?.range.visitor_note ??
            "Unique visitors are per UTC day; over several days they are the sum of daily uniques (the visitor key rotates daily)."}
        </p>
      </Card>

      {ts ? (
        <section className={ts.unit === "day" ? "um-grid um-g21" : "um-grid"}>
          {ts.unit === "day" ? (
            <Card
              title="Verified and all received, per day"
              sub="The shaded band is what our checks set aside. Click a day to show only that day."
              data-testid="band-section"
            >
              <BandChart
                title="Verified and raw page views per day"
                points={(ts.verified ?? [])
                  .map((p, i) => ({
                    t: p.t,
                    verified: p.pageviews ?? null,
                    raw: ts.raw?.[i]?.pageviews ?? null,
                  }))
                  // today is still running: the band ends at the last complete day
                  .filter((p) => !isPartialBucket(p.t, "day"))}
                markers={flags.map((f) => ({
                  day: f.day,
                  label: f.codes.join(", "),
                  explained: f.explained,
                }))}
                onSelectDay={(day) => onChange({ ...search, range: "custom", from: day, to: day })}
              />
              {flags.length > 0 ? (
                <div className="um-p-tools" data-testid="band-flags">
                  <span className="um-p-fine">Anomaly flags:</span>
                  {flags.map((f) => (
                    <Button
                      key={f.day}
                      size="sm"
                      aria-pressed={flagDay === f.day}
                      onClick={() => setFlagDay(flagDay === f.day ? null : f.day)}
                    >
                      {fmtDay(`${f.day}T00:00:00Z`)}
                      {f.explained ? " (explained)" : ""}
                    </Button>
                  ))}
                </div>
              ) : null}
              {selectedFlag ? (
                <FlagCard tenantId={tenantId} flag={selectedFlag} siteName={site.data?.name} />
              ) : null}
            </Card>
          ) : null}
          <Card
            title="Visits"
            sub="Per UTC day, over all identified events"
            data-testid="visit-series"
          >
            {visitSeries ? (
              <Chart
                partial={partialLast(
                  (ts.visit_metrics ?? []).map((p) => p.t),
                  ts.unit,
                )}
                labels={(ts.visit_metrics ?? []).map((p) => axisLabel(p.t, ts.unit))}
                label="Visits"
                series={[
                  {
                    name: "Visits",
                    color: "webmid",
                    data: (ts.visit_metrics ?? []).map((p) => p.visits ?? null),
                    area: true,
                  },
                ]}
                height={220}
              />
            ) : (
              <p className="um-muted" data-testid="visit-series-hidden">
                Visits, bounce rate and visit duration are computed per UTC day, so they are not
                shown by hour. Choose a daily or monthly interval to see them over time.
              </p>
            )}
          </Card>
        </section>
      ) : null}

      {range?.anonymized ? (
        <p className="um-p-fine" data-testid="anonymized-note">
          Anonymous reports are on for this website: counts in these tables are rounded to the
          nearest 10 and rows below 10 are combined into “Other”. The totals above are exact.
        </p>
      ) : range ? (
        <p className="um-p-fine" data-testid="exact-note">
          Anonymous reports are off for this website: the tables show exact counts.
        </p>
      ) : null}
      {breakdowns.error ? (
        <ErrorState error={breakdowns.error} onRetry={() => void breakdowns.refetch()} />
      ) : null}
      {breakdowns.isLoading && ok ? <LoadingState block /> : null}
      {breakdowns.data ? (
        <section className="um-grid um-g3" aria-label="Breakdowns">
          {breakdowns.data.map((b, i) => {
            const d = DIMENSIONS[i];
            if (!d) return null;
            return (
              <BreakdownTable
                key={d.id}
                title={d.title}
                dimension={d.id}
                valueHeader={d.valueHeader}
                rows={(verified ? b.verified : b.raw) ?? []}
                truncated={b.truncated === true}
              />
            );
          })}
          <HowCard exportHref={exportHref} />
        </section>
      ) : null}
      <p className="um-p-fine">Figures: {DASH} means not available for this range.</p>
      <PrivacyCard compact />
    </>
  );
}

/** "How these numbers are made": the privacy rules behind the tables and the CSV export. */
function HowCard({ exportHref }: { exportHref: string | null }) {
  return (
    <Card title="How these numbers are made" headingLevel={3}>
      <ul className="um-p-mlist">
        <li>
          <Icon name="check" size="sm" />
          <span>No cookies. Visitors are counted with a daily salt that is thrown away.</span>
        </li>
        <li>
          <Icon name="check" size="sm" />
          <span>
            No visitor's Stellar address is ever collected: wallet activity is counted by wallet
            type only.
          </span>
        </li>
        <li>
          <Icon name="check" size="sm" />
          <span>IP addresses and user-agent strings are never stored.</span>
        </li>
        <li>
          <Icon name="check" size="sm" />
          <span>No visitor lists, replays or journeys of one person: aggregates only.</span>
        </li>
      </ul>
      {exportHref ? (
        <p className="um-p-fine">
          <a className="um-link" href={exportHref} download>
            <Icon name="download" size="sm" />
            Download daily figures (CSV)
          </a>{" "}
          One row per UTC day, verified and raw.
        </p>
      ) : null}
    </Card>
  );
}

function axisLabel(iso: string, unit: Unit): string {
  const d = new Date(iso);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (unit === "hour") return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  if (unit === "month") return `${mon[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${mon[d.getUTCMonth()]}`;
}
