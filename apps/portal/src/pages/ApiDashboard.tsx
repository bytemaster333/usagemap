// SPDX-License-Identifier: Apache-2.0
// Tenant API dashboard (dashboard.api-*, isolation.api-dashboard). What is shown and how, per contract:
//   - volume, status-class distribution with per-code breakdown and 4xx/5xx error rates, p50/p95/p99 — each percentile
//     with its accuracy class (mandatory, C-103), first-bucket values of explicit layouts as "≤ 5 ms" (C-110(9));
//   - per normalised route (ADR-0012), sortable, with `{unknown}` and `{overflow}` explained (C-16, C-24, C-101);
//     choosing a route narrows every figure to it;
//   - time series at the resolution the control plane chose (1m/1h/1d, `ApiRangeEcho.resolution`);
//   - ranges as on the web dashboard (presets or whole UTC days) and a comparison with the previous period of the same
//     length, asked for as an explicit custom range;
//   - "self-attested telemetry" stated, stream-group and sampling caveats (C-22, wire-formats §g.5);
//   - data-quality counters (dropped points) with the reason in plain language (wire-formats §h.3).

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { type ReactNode, useEffect, useId, useState } from "react";
import { api, operationUrl } from "../api/client.ts";
import { useTenants, useTitle } from "../components/AppShell.tsx";
import {
  AnchorFunnelPanel,
  PartnerCallsPanel,
  PaymentsPanel,
} from "../components/IntegrationPanels.tsx";
import { StellarClientPanel } from "../components/StellarClientPanel.tsx";
import { TopBarSlot } from "../components/shell/TopBarSlot.tsx";
import {
  Button,
  Card,
  Chart,
  ErrorState,
  fmtCompact,
  Icon,
  Kpi,
  Legend,
  LoadingState,
  Note,
  partialLast,
  Segmented,
  ShareBar,
  TableScroll,
  Tag,
} from "../components/ui/index.ts";
import {
  ACCURACY_TEXT,
  accuracyLabel,
  DQ_BY_DESIGN,
  dqReasonText,
  fmtMs,
  fmtRate,
  isRoutePlaceholder,
  ROUTE_PLACEHOLDER_TEXT,
  statusShares,
} from "../lib/apiFormat.ts";
import { previousSpan } from "../lib/days.ts";
import type { MetricKey } from "../lib/definitions.gen.ts";
import { fmtBucket, fmtDelta, fmtInt, fmtRange } from "../lib/format.ts";
import { customRange, dayString, type RangeKind, type Unit } from "../lib/range.ts";
import type { ApiDashboardSearch, RouteSort } from "../lib/search.ts";
import { SloCard, SurfacesTable } from "./ApiSurfaces.tsx";
import { ApiAssurancePanel } from "./project/ApiQuality.tsx";
import { MetricDef } from "./project/common.tsx";
import { useService } from "./ServiceLayout.tsx";
import { STREAM_KIND_TEXT } from "./Services.tsx";
import { rangeQuery } from "./SiteDashboard.tsx";

type ApiSummary = ControlPlane.ApiSummary;
type ApiRangeEcho = ControlPlane.ApiRangeEcho;
type ApiRouteRow = ControlPlane.ApiRouteRow;

export const RESOLUTION_UNIT: Record<ApiRangeEcho["resolution"], Unit> = {
  "1m": "hour",
  "1h": "hour",
  "1d": "day",
};

const RESOLUTION_TEXT: Record<ApiRangeEcho["resolution"], string> = {
  "1m": "per minute",
  "1h": "per hour",
  "1d": "per UTC day",
};

export function SelfAttested({ range }: { range: ApiRangeEcho }) {
  return (
    <Note icon="info">
      <span data-testid="self-attested">
        <b>Self-attested telemetry.</b> Self-reported means your own servers send these numbers.
        UsageMap normalises and checks them for consistency, but cannot prove every request happened
        or that none was left out.
        {range.stream_group?.warning ? (
          <span data-testid="stream-warning">
            {" "}
            {range.stream_group.kind ? `${STREAM_KIND_TEXT[range.stream_group.kind]}: ` : ""}
            {range.stream_group.warning}
          </span>
        ) : null}
        {range.sampled_lower_bound ? (
          <span data-testid="sampled-lower-bound">
            {" "}
            Derived from sampled spans without sampling weights: request counts are a lower bound.
          </span>
        ) : null}
      </span>
    </Note>
  );
}

function Tile({
  metric,
  icon,
  label,
  value,
  sub,
  testId,
}: {
  metric: MetricKey;
  icon: "activity" | "alert" | "clock";
  label: string;
  value: string;
  sub?: string | undefined;
  testId: string;
}) {
  return (
    <Kpi
      testId={testId}
      tone="api"
      icon={icon}
      label={label}
      value={value === "—" ? null : value}
      foot={
        <>
          {sub ? <span className="um-p-kpisub">{sub}</span> : null}
          <MetricDef metric={metric} />
        </>
      }
    />
  );
}

function ppDelta(cur: number | null | undefined, prev: number | null | undefined): string | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  const d = (cur - prev) * 100;
  const a = Math.abs(d).toFixed(2);
  if (a === "0.00") return "0.00 pp";
  return d > 0 ? `+${a} pp` : `−${a} pp`;
}

const vs = (d: string | null) => (d === null ? "No comparison" : `${d} vs previous period`);

export function ApiSummaryTiles({
  summary,
  previous,
}: {
  summary: Omit<ApiSummary, "range">;
  previous?: Omit<ApiSummary, "range"> | null | undefined;
}) {
  const l = summary.latency;
  const a = l.accuracy_class;
  const cmp = previous !== undefined;
  const pl = previous?.latency;
  return (
    <>
      <section className="um-grid um-p-g6" aria-label="Summary">
        <Tile
          metric="api_requests"
          icon="activity"
          testId="tile-requests"
          label="Requests"
          value={fmtInt(summary.requests)}
          sub={cmp ? vs(fmtDelta(summary.requests, previous?.requests)) : undefined}
        />
        <Tile
          metric="error_rate_5xx"
          icon="alert"
          testId="tile-5xx"
          label="Server errors (5xx)"
          value={fmtRate(summary.error_rate_5xx)}
          sub={
            cmp
              ? vs(ppDelta(summary.error_rate_5xx, previous?.error_rate_5xx))
              : `${fmtInt(summary.status.s5xx)} requests`
          }
        />
        <Tile
          metric="error_rate_4xx"
          icon="alert"
          testId="tile-4xx"
          label="Client errors (4xx)"
          value={fmtRate(summary.error_rate_4xx)}
          sub={
            cmp
              ? vs(ppDelta(summary.error_rate_4xx, previous?.error_rate_4xx))
              : `${fmtInt(summary.status.s4xx)} requests`
          }
        />
        <Tile
          metric="latency_percentiles"
          icon="clock"
          testId="tile-p50"
          label="p50"
          value={fmtMs(l.p50_ms, a)}
          sub={`accuracy: ${accuracyLabel(a)}${cmp ? ` · ${vs(fmtDelta(l.p50_ms, pl?.p50_ms))}` : ""}`}
        />
        <Tile
          metric="latency_percentiles"
          icon="clock"
          testId="tile-p95"
          label="p95"
          value={fmtMs(l.p95_ms, a)}
          sub={`accuracy: ${accuracyLabel(a)}${cmp ? ` · ${vs(fmtDelta(l.p95_ms, pl?.p95_ms))}` : ""}`}
        />
        <Tile
          metric="latency_percentiles"
          icon="clock"
          testId="tile-p99"
          label="p99"
          value={fmtMs(l.p99_ms, a)}
          sub={`accuracy: ${accuracyLabel(a)}${cmp ? ` · ${vs(fmtDelta(l.p99_ms, pl?.p99_ms))}` : ""}`}
        />
      </section>
      <p className="um-p-fine" data-testid="accuracy-note">
        {a ? ACCURACY_TEXT[a] : "No latency data in this range."} Percentiles come from merged
        histograms, never from individual requests.
      </p>
    </>
  );
}

const CLASS_COLOR = ["apilight", "apipale", "api", "bad", "line"] as const;

export function StatusDistribution({ codes }: { codes: ControlPlane.ApiStatusCodes }) {
  const shares = statusShares(codes.classes);
  const total = shares.reduce((a, s) => a + s.count, 0);
  return (
    <Card title="Status codes" sub="Share of all requests" data-testid="status-distribution">
      {total > 0 ? (
        <ShareBar
          label="Share of requests per status class; the table below lists the values."
          parts={shares.map((s, i) => ({
            label: s.label,
            share: s.share * 100,
            color: CLASS_COLOR[i] ?? "line",
            value: fmtRate(s.share),
          }))}
        />
      ) : null}
      <table className="um-table">
        <caption className="um-sr">Requests per status class</caption>
        <thead>
          <tr>
            <th scope="col">Class</th>
            <th scope="col" className="um-r">
              Requests
            </th>
            <th scope="col" className="um-r">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {shares.map((s) => (
            <tr key={s.key} data-testid={`class-${s.key}`}>
              <td>{s.label}</td>
              <td className="um-r">{fmtInt(s.count)}</td>
              <td className="um-r">{fmtRate(s.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {codes.codes.length > 0 ? (
        <details className="um-p-details">
          <summary>Per status code</summary>
          <table className="um-table" data-testid="status-codes">
            <caption className="um-sr">Requests per status code</caption>
            <thead>
              <tr>
                <th scope="col">Status code</th>
                <th scope="col" className="um-r">
                  Requests
                </th>
              </tr>
            </thead>
            <tbody>
              {codes.codes.map((c) => (
                <tr key={c.status_code}>
                  <td>
                    <code>{c.status_code === 0 ? "none reported" : c.status_code}</code>
                  </td>
                  <td className="um-r">{fmtInt(c.requests)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </Card>
  );
}

const SORT_COLUMNS: { key: string; label: string; asc: RouteSort; desc: RouteSort }[] = [
  { key: "route", label: "Route", asc: "route", desc: "route" },
  { key: "requests", label: "Requests", asc: "requests", desc: "-requests" },
  { key: "error_rate_5xx", label: "5xx rate", asc: "error_rate_5xx", desc: "-error_rate_5xx" },
  { key: "p95_ms", label: "p95", asc: "p95_ms", desc: "-p95_ms" },
];

export function RouteTable({
  rows,
  total,
  sort,
  onSort,
  onPick,
  actions,
}: {
  rows: ApiRouteRow[];
  total: number;
  sort: RouteSort;
  onSort: (s: RouteSort) => void;
  onPick: (route: string) => void;
  actions?: ReactNode;
}) {
  const key = sort.replace(/^-/, "");
  const ariaSort = (k: string): "ascending" | "descending" | "none" =>
    k !== key ? "none" : sort.startsWith("-") ? "descending" : "ascending";
  const header = (k: string) => {
    const c = SORT_COLUMNS.find((x) => x.key === k);
    if (!c) return null;
    const next = k === key && sort === c.desc ? c.asc : c.desc;
    return (
      <button type="button" className="um-sort" onClick={() => onSort(next)}>
        {c.label}
        <span className="um-sr">, sort</span>
      </button>
    );
  };
  const placeholders = rows.filter((r) => isRoutePlaceholder(r.route));
  return (
    <Card
      title="Routes"
      sub="Normalised: IDs, accounts and amounts become placeholders before anything is stored"
      flush
      actions={actions}
      data-testid="route-table"
    >
      <TableScroll label="Requests and latency per route" stickyFirst>
        <table className="um-table">
          <caption className="um-sr">Requests and latency per route</caption>
          <thead>
            <tr>
              <th scope="col" aria-sort={ariaSort("route")}>
                {header("route")}
              </th>
              <th scope="col" className="um-r" aria-sort={ariaSort("requests")}>
                {header("requests")}
              </th>
              <th scope="col" className="um-r">
                Share
              </th>
              <th scope="col" className="um-r" aria-sort={ariaSort("error_rate_5xx")}>
                {header("error_rate_5xx")}
              </th>
              <th scope="col" className="um-r">
                p50
              </th>
              <th scope="col" className="um-r" aria-sort={ariaSort("p95_ms")}>
                {header("p95_ms")}
              </th>
              <th scope="col" className="um-r">
                p99
              </th>
              <th scope="col">Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="um-muted">
                  No requests in this range.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const a = r.latency.accuracy_class;
                const hot = (r.error_rate_5xx ?? 0) >= 0.01;
                return (
                  <tr key={`${r.route} ${r.rpc_method ?? ""}`}>
                    <td>
                      <button
                        type="button"
                        className="um-p-routebtn"
                        onClick={() => onPick(r.route)}
                      >
                        <code>{r.route}</code>
                        {r.rpc_method ? <span> · {r.rpc_method}</span> : null}
                      </button>
                      {isRoutePlaceholder(r.route) ? (
                        <Tag>
                          {r.route === "{unknown}" ? "no route reported" : "over route limit"}
                        </Tag>
                      ) : null}
                    </td>
                    <td className="um-r">{fmtInt(r.requests)}</td>
                    <td className="um-r">{total > 0 ? fmtRate(r.requests / total) : "—"}</td>
                    <td className={hot ? "um-r um-p-hot" : "um-r"}>{fmtRate(r.error_rate_5xx)}</td>
                    <td className="um-r">{fmtMs(r.latency.p50_ms, a)}</td>
                    <td className="um-r">{fmtMs(r.latency.p95_ms, a)}</td>
                    <td className="um-r">{fmtMs(r.latency.p99_ms, a)}</td>
                    <td className="um-muted">{accuracyLabel(a)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </TableScroll>
      <div className="um-p-cardfoot">
        {placeholders.length > 0 ? (
          <dl className="um-kv" data-testid="placeholder-help">
            {placeholders.map((r) => (
              <div key={r.route}>
                <dt>
                  <code>{r.route}</code>
                </dt>
                <dd>{ROUTE_PLACEHOLDER_TEXT[r.route]}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p>
          Routes are normalised templates (IDs, hashes and account keys replaced by placeholders
          such as <code>{"{account_id}"}</code>); raw paths and query strings are never stored.
        </p>
      </div>
    </Card>
  );
}

export function DataQualityTable({ dq }: { dq: ControlPlane.DataQuality }) {
  const issues = dq.reasons.filter((r) => !DQ_BY_DESIGN.has(r.reason));
  const design = dq.reasons.filter((r) => DQ_BY_DESIGN.has(r.reason));
  const table = (rows: typeof dq.reasons, caption: string, testId: string) => (
    <table className="um-table" data-testid={testId}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">What happened</th>
          <th scope="col">Code</th>
          <th scope="col" className="um-r">
            Points
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={3} className="um-muted">
              None.
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr key={r.reason}>
              <td>{dqReasonText(r.reason)}</td>
              <td>
                <code>{r.reason}</code>
              </td>
              <td className="um-r">{fmtInt(r.count)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
  return (
    <>
      {table(issues, "Dropped or changed — worth a look", "dq-issues")}
      {table(design, "Filtered by design", "dq-design")}
    </>
  );
}

function DataQuality({ tenantId, serviceId }: { tenantId: string; serviceId: string }) {
  const [range, setRange] = useState<"24h" | "7d" | "30d">("7d");
  const dq = useQuery({
    queryKey: ["api-dq", tenantId, serviceId, range],
    queryFn: () =>
      api.call("getServiceDataQuality", { path: { tenantId, serviceId }, query: { range } }),
  });
  return (
    <Card
      title="Data points set aside"
      sub="Points received for this service but not stored, or stored changed, with the reason"
      data-testid="data-quality"
      actions={
        <Segmented
          label="Period"
          value={range}
          onChange={setRange}
          options={[
            { value: "24h", label: "24h" },
            { value: "7d", label: "7d" },
            { value: "30d", label: "30d" },
          ]}
        />
      }
    >
      {dq.error ? (
        <ErrorState error={dq.error} plain onRetry={() => void dq.refetch()} />
      ) : dq.data ? (
        <TableScroll label="Data quality">
          <div className="um-p-stack">
            <DataQualityTable dq={dq.data} />
          </div>
        </TableScroll>
      ) : (
        <LoadingState />
      )}
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

function ApiRangeControls({
  search,
  onChange,
}: {
  search: ApiDashboardSearch;
  onChange: (s: ApiDashboardSearch) => void;
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
  const pick = (r: RangeKind) => {
    const { from: _f, to: _t, ...rest } = search;
    if (r === "custom") {
      const end = new Date();
      const start = new Date(end.getTime() - 6 * 86_400_000);
      onChange({ ...rest, range: "custom", from: dayString(start), to: dayString(end) });
    } else onChange({ ...rest, range: r });
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
          onChange({ ...search, range: "custom", from, to });
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

export function ApiDashboardPage() {
  const { tenantId, serviceId } = useParams({ from: "/app/t/$tenantId/services/$serviceId/" });
  const search = useSearch({ from: "/app/t/$tenantId/services/$serviceId/" });
  const navigate = useNavigate();
  const svc = useService(tenantId, serviceId);
  const tab = search.tab ?? "traffic";
  useTitle(svc.data ? `API · ${svc.data.service_name}` : "API");
  const path = { tenantId, serviceId };
  const rq = rangeQuery(search);
  const ok = !("error" in rq);
  const base = ok ? rq.query : { range: "7d" as const };
  const route = search.route;
  const q = { ...base, ...(route ? { route } : {}) };
  const traffic = tab === "traffic";

  const summary = useQuery({
    queryKey: ["api-summary", tenantId, serviceId, q],
    enabled: ok && (traffic || tab === "surfaces"),
    queryFn: () => api.call("getApiSummary", { path, query: q }),
  });
  const prevSpan = summary.data ? previousSpan(summary.data.range) : null;
  const previous = useQuery({
    queryKey: ["api-summary-prev", tenantId, serviceId, prevSpan, route],
    enabled: ok && traffic && search.compare && prevSpan !== null,
    queryFn: () =>
      api.call("getApiSummary", {
        path,
        query: {
          range: "custom",
          start: prevSpan?.start as string,
          end: prevSpan?.end as string,
          ...(route ? { route } : {}),
        },
      }),
  });
  const series = useQuery({
    queryKey: ["api-ts", tenantId, serviceId, q],
    enabled: ok && (traffic || tab === "surfaces"),
    queryFn: () =>
      api.call("getApiTimeseries", {
        path,
        query: { ...q, resolution: rq && !("error" in rq) && (rq.days ?? 99) > 7 ? "1d" : "auto" },
      }),
  });
  const codes = useQuery({
    queryKey: ["api-codes", tenantId, serviceId, q],
    enabled: ok && traffic,
    queryFn: () => api.call("getApiStatusCodes", { path, query: q }),
  });
  const surfaces = useQuery({
    queryKey: ["api-surfaces", tenantId, serviceId, base],
    enabled: ok && !route && tab === "surfaces",
    queryFn: () => api.call("getApiSurfaces", { path, query: base }),
  });
  const role = useTenants().data?.find((t) => t.tenant_id === tenantId)?.role;
  const routesCsv = ok ? operationUrl("exportApiRoutes", { path, query: base }) : null;
  const routes = useQuery({
    queryKey: ["api-routes", tenantId, serviceId, base, search.sort],
    enabled: ok && !route && traffic,
    queryFn: () =>
      api.call("listApiRoutes", { path, query: { ...base, sort: search.sort, limit: 200 } }),
  });

  const go = (s: ApiDashboardSearch) =>
    void navigate({
      to: "/t/$tenantId/services/$serviceId",
      params: path,
      search: s,
      replace: true,
    });

  const range = summary.data?.range;
  const ts = series.data;
  const unit = ts ? RESOLUTION_UNIT[ts.range.resolution] : "day";
  const acc = ts?.accuracy_class ?? null;
  const pts = ts?.points ?? [];
  const label = (t: string) => {
    const d = new Date(t);
    const mon = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return unit === "hour"
      ? `${String(d.getUTCHours()).padStart(2, "0")}:00`
      : `${d.getUTCDate()} ${mon[d.getUTCMonth()]}`;
  };

  const controls = <ApiRangeControls search={search} onChange={go} />;
  if (tab === "sdk")
    return (
      <>
        {controls}
        {ok ? <StellarClientPanel tenantId={tenantId} serviceId={serviceId} query={base} /> : null}
      </>
    );
  if (tab === "partners")
    return (
      <>
        {controls}
        {ok ? <PartnerCallsPanel tenantId={tenantId} serviceId={serviceId} query={base} /> : null}
      </>
    );
  if (tab === "payments")
    return (
      <>
        {controls}
        {ok ? <PaymentsPanel tenantId={tenantId} serviceId={serviceId} query={base} /> : null}
      </>
    );
  if (tab === "anchors")
    return (
      <>
        {controls}
        {ok ? <AnchorFunnelPanel tenantId={tenantId} query={base} /> : null}
      </>
    );
  if (tab === "quality")
    return (
      <section className="um-grid um-g2">
        <ApiAssurancePanel tenantId={tenantId} serviceId={serviceId} />
        <DataQuality tenantId={tenantId} serviceId={serviceId} />
      </section>
    );
  if (tab === "surfaces")
    return (
      <>
        {controls}
        {summary.error ? (
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        ) : null}
        {summary.data && svc.data && ts ? (
          <SloCard
            tenantId={tenantId}
            service={svc.data}
            summary={summary.data}
            points={ts.points}
            canEdit={role === "owner" || role === "admin" || role === "member"}
          />
        ) : summary.isLoading ? (
          <LoadingState block />
        ) : null}
        {surfaces.error ? (
          <ErrorState error={surfaces.error} onRetry={() => void surfaces.refetch()} />
        ) : null}
        {surfaces.data ? (
          <SurfacesTable data={surfaces.data} />
        ) : surfaces.isLoading ? (
          <LoadingState block />
        ) : null}
      </>
    );

  return (
    <>
      {controls}
      {!ok ? (
        <Note tone="bad" role="alert">
          {rq.error}
        </Note>
      ) : null}
      {route ? (
        <Note>
          <span data-testid="route-filter">
            Showing route <code>{route}</code> only.{" "}
            <Button
              size="sm"
              onClick={() => {
                const { route: _r, ...rest } = search;
                go(rest);
              }}
            >
              Show all routes
            </Button>
          </span>
        </Note>
      ) : null}
      {summary.error ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : null}
      {range ? (
        <p className="um-p-fine" data-testid="range-text">
          <b>{fmtRange(range.start, range.end)}</b> (UTC) · data {RESOLUTION_TEXT[range.resolution]}
        </p>
      ) : null}
      {summary.data ? (
        <ApiSummaryTiles
          summary={summary.data}
          previous={search.compare ? (previous.data ?? null) : undefined}
        />
      ) : summary.isLoading && ok ? (
        <LoadingState block label="Loading figures…" />
      ) : null}
      {search.compare && prevSpan ? (
        <p className="um-p-fine" data-testid="previous-range">
          Previous period: {fmtRange(prevSpan.start, prevSpan.end)} (UTC).
        </p>
      ) : null}
      {previous.error ? <ErrorState error={previous.error} plain /> : null}

      <section className="um-grid um-g21">
        <Card
          title="Request volume"
          sub={`Per ${unit === "hour" ? "hour" : "day"}, by status class`}
          actions={
            <Legend
              items={[
                { label: "2xx / 3xx", color: "apilight" },
                { label: "4xx", color: "api" },
                { label: "5xx", color: "bad" },
              ]}
            />
          }
        >
          {series.error ? (
            <ErrorState error={series.error} plain />
          ) : ts ? (
            <Chart
              partial={partialLast(
                pts.map((p) => p.t),
                unit,
              )}
              type="bar"
              stack
              height={240}
              label="Requests by status class"
              labels={pts.map((p) => label(p.t))}
              series={[
                {
                  name: "2xx / 3xx",
                  color: "apilight",
                  data: pts.map((p) => Math.max(0, p.requests - (p.s4xx ?? 0) - (p.s5xx ?? 0))),
                },
                { name: "4xx", color: "api", data: pts.map((p) => p.s4xx ?? 0) },
                { name: "5xx", color: "bad", data: pts.map((p) => p.s5xx ?? 0) },
              ]}
              format={fmtCompact}
              table={{
                title: "Requests",
                firstColumn: unit === "hour" ? "Hour (UTC)" : "Day (UTC)",
                rows: pts.map((p) => fmtBucket(p.t, unit)),
                format: (v) => fmtInt(v),
              }}
            />
          ) : (
            <LoadingState block />
          )}
        </Card>
        {codes.error ? (
          <ErrorState error={codes.error} />
        ) : codes.data ? (
          <StatusDistribution codes={codes.data} />
        ) : (
          <LoadingState block />
        )}
      </section>

      {ts ? (
        <Card
          title="Latency"
          sub={`p50 · p95 · p99, accuracy: ${accuracyLabel(acc)}`}
          actions={
            <Legend
              items={[
                { label: "p50", color: "apilight" },
                { label: "p95", color: "api" },
                { label: "p99", color: "bad", dash: true },
              ]}
            />
          }
        >
          <Chart
            partial={partialLast(
              pts.map((p) => p.t),
              unit,
            )}
            height={200}
            label={`Latency percentiles (accuracy: ${accuracyLabel(acc)})`}
            labels={pts.map((p) => label(p.t))}
            format={(v) => `${Math.round(v)} ms`}
            series={[
              { name: "p50", color: "apilight", data: pts.map((p) => p.p50_ms ?? null) },
              { name: "p95", color: "api", data: pts.map((p) => p.p95_ms ?? null) },
              {
                name: "p99",
                color: "bad",
                data: pts.map((p) => p.p99_ms ?? null),
                dash: true,
                thin: true,
              },
            ]}
          />
        </Card>
      ) : null}

      {route ? null : routes.error ? (
        <ErrorState error={routes.error} onRetry={() => void routes.refetch()} />
      ) : routes.data ? (
        <RouteTable
          rows={routes.data.items}
          total={summary.data?.requests ?? 0}
          sort={search.sort}
          onSort={(sort) => go({ ...search, sort })}
          onPick={(r) => go({ ...search, route: r })}
          actions={
            routesCsv ? (
              <a
                className="um-btn um-btn--secondary um-btn--sm"
                href={routesCsv}
                download
                data-testid="routes-csv"
              >
                <Icon name="download" />
                Download the route table (CSV)
              </a>
            ) : null
          }
        />
      ) : routes.isLoading ? (
        <LoadingState block />
      ) : null}
      {range ? <SelfAttested range={range} /> : null}
    </>
  );
}
