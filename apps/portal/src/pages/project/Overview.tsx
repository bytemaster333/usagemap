// SPDX-License-Identifier: Apache-2.0
// Project overview (approved design; plan D-1): "is my project used, and how sure are we?". Four headline numbers
// with their provenance (verified web visitors, self-reported API requests, verified wallet connects, ledger-checked
// contract calls) for the range in the top bar, the trust strip (verification level, 28-day trust score, public
// stats), the visitors chart (verified against everything received, with the project's notes), "Your sources", the
// top pages / busiest routes / DeFi protocols, then the verified-usage summary with the methodology's confidence,
// open anomaly flags and the first-event panel of any website still waiting. Every number comes from the API.

import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { FirstEventPanel } from "../../components/FirstEventPanel.tsx";
import { PrivacyCard } from "../../components/PrivacyCard.tsx";
import {
  BarList,
  Card,
  Chart,
  Chip,
  EmptyState,
  ErrorState,
  fmtCompact,
  Icon,
  Kpi,
  Legend,
  LoadingState,
  Note,
  PageHeader,
  partialLast,
  type SourceItem,
  SourceList,
  Spark,
  StatusBadge,
  Tag,
} from "../../components/ui/index.ts";
import {
  anomalyFlags,
  BAND_TEXT,
  CONFIDENCE_REASON_TEXT,
  type ConfidenceLevel,
  confidence,
  latestWindowScore,
  onchainTotals,
  openFlagCount,
  type TrustBand,
  trustBand,
} from "../../lib/usage.ts";
import {
  axisLabel,
  completeDays,
  deltaOf,
  fmtN,
  fmtPctN,
  MetricDef,
  ProjectFrame,
  type ProjectRange,
  parseProjectRange,
  RANGE_SUB,
  RangePicker,
  rangeDays,
  useServiceList,
  useSites,
  useTenant,
  withPrevious,
} from "./common.tsx";

export const CONFIDENCE_TEXT: Record<ConfidenceLevel, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  insufficient: "Not enough data",
};

export function parseOverviewSearch(s: Record<string, unknown>): { range?: ProjectRange } {
  return s.range === undefined ? {} : { range: parseProjectRange(s.range) };
}

/** "Trust 84 · high": the band of a 28-day score. */
export function BandBadge({ band, score }: { band: TrustBand; score: number | null }) {
  const kind =
    band === "high" ? "live" : band === "medium" ? "wait" : band === "low" ? "bad" : "off";
  return (
    <span data-testid="trust-band" className="um-p-band">
      <StatusBadge status={kind}>
        Trust {score === null ? "—" : score} · {BAND_TEXT[band]}
      </StatusBadge>
    </span>
  );
}

const sumOf = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, v) => a + (v ?? 0), 0);

export function OverviewPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId" });
  const search = useSearch({ from: "/app/t/$tenantId" });
  const navigate = useNavigate();
  const range = search.range ?? "30d";
  const tenant = useTenant(tenantId);
  const sites = useSites(tenantId);
  useTitle("Overview");
  const setRange = (r: ProjectRange) =>
    void navigate({
      to: "/t/$tenantId",
      params: { tenantId },
      search: { range: r },
      replace: true,
    });
  return (
    <ProjectFrame tenantId={tenantId}>
      <PageHeader title="Overview" sub={`${RANGE_SUB[range]} · compared with the period before`} />
      <RangePicker value={range} onChange={setRange} />
      {tenant.data?.status === "pending" ? (
        <Note tone="warn" icon="clock">
          <p>
            <b>Waiting for approval.</b> This project is awaiting approval by an SCF operator. You
            can set up websites now; events are counted as rejected (<code>tenant_pending</code>)
            until then.
          </p>
        </Note>
      ) : null}
      {tenant.data?.status === "suspended" ? (
        <Note tone="bad">
          <p>
            <b>This project is suspended.</b> Events are rejected until it is reinstated.
          </p>
        </Note>
      ) : null}
      {tenant.error || sites.error ? (
        <ErrorState
          error={tenant.error ?? sites.error}
          onRetry={() => {
            void tenant.refetch();
            void sites.refetch();
          }}
        />
      ) : tenant.data && sites.data ? (
        <ProjectOverview tenant={tenant.data} sites={sites.data} range={range} />
      ) : (
        <LoadingState block label="Loading the overview…" />
      )}
    </ProjectFrame>
  );
}

function ProjectOverview({
  tenant,
  sites,
  range,
}: {
  tenant: ControlPlane.Tenant;
  sites: ControlPlane.Site[];
  range: ProjectRange;
}) {
  const tenantId = tenant.tenant_id;
  const n = rangeDays(range);
  const days = withPrevious(n);
  const trustSpan = completeDays(30);
  const services = useServiceList(tenantId);

  // web: totals with the period before, and the chart series
  const stats = useQueries({
    queries: sites.map((s) => ({
      queryKey: ["web-stats", tenantId, s.site_id, range, "both", "previous"],
      queryFn: () =>
        api.call("getWebStats", {
          path: { tenantId, siteId: s.site_id },
          query: { range, variant: "both", compare: "previous" },
        }),
    })),
  });
  const series = useQueries({
    queries: sites.map((s) => ({
      queryKey: ["web-ts", tenantId, s.site_id, range, "both"],
      queryFn: () =>
        api.call("getWebTimeseries", {
          path: { tenantId, siteId: s.site_id },
          query: { range, variant: "both", metrics: ["pageviews", "visitors"] },
        }),
    })),
  });
  const installs = useQueries({
    queries: sites.map((s) => ({
      queryKey: ["installation", tenantId, s.site_id, "30d"],
      queryFn: () =>
        api.call("getInstallationCheck", {
          path: { tenantId, siteId: s.site_id },
          query: { range: "30d" },
        }),
    })),
  });
  const trust = useQueries({
    queries: sites.map((s) => ({
      queryKey: ["trust-scores", tenantId, s.site_id, trustSpan.start, trustSpan.end],
      queryFn: () =>
        api.call("listSiteTrustScores", {
          path: { tenantId, siteId: s.site_id },
          query: trustSpan,
        }),
    })),
  });
  const wallets = useQueries({
    queries: sites.map((s) => ({
      queryKey: ["wallet-funnel", tenantId, s.site_id, days.both.start, days.both.end, "mainnet"],
      queryFn: () =>
        api.call("getSiteWalletFunnel", {
          path: { tenantId, siteId: s.site_id },
          query: {
            start: days.both.start,
            end: days.both.end,
            network: "mainnet",
            variant: "verified",
          },
        }),
    })),
  });
  const apiSummaries = useQueries({
    queries: (services.data ?? []).map((s) => ({
      queryKey: ["api-summary", tenantId, s.service_id, { range }],
      queryFn: () =>
        api.call("getApiSummary", {
          path: { tenantId, serviceId: s.service_id },
          query: { range },
        }),
    })),
  });
  const apiSeries = useQueries({
    queries: (services.data ?? []).map((s) => ({
      queryKey: ["api-ts-spark", tenantId, s.service_id, range],
      queryFn: () =>
        api.call("getApiTimeseries", {
          path: { tenantId, serviceId: s.service_id },
          query: { range, resolution: range === "24h" ? "1h" : "1d" },
        }),
    })),
  });
  const firstService = services.data?.[0];
  const routes = useQuery({
    queryKey: ["api-routes", tenantId, firstService?.service_id, range, "-requests", 4],
    queryFn: () =>
      api.call("listApiRoutes", {
        path: { tenantId, serviceId: firstService?.service_id as string },
        query: { range, sort: "-requests", limit: 4 },
      }),
    enabled: !!firstService,
  });
  const firstSite = sites[0];
  const pages = useQuery({
    queryKey: ["web-breakdown", tenantId, firstSite?.site_id, range, "verified", "path", 4],
    queryFn: () =>
      api.call("getWebBreakdown", {
        path: { tenantId, siteId: firstSite?.site_id as string },
        query: { range, variant: "verified", dimension: "path", limit: 4 },
      }),
    enabled: !!firstSite,
  });
  const annotations = useQuery({
    queryKey: ["annotations", tenantId],
    queryFn: () => api.call("listAnnotations", { path: { tenantId } }),
  });
  const onchain = useQuery({
    queryKey: ["onchain-daily", tenantId, days.current.start, days.current.end],
    queryFn: () => api.call("getOnchainDaily", { path: { tenantId }, query: days.current }),
  });
  const onchainPrev = useQuery({
    queryKey: ["onchain-daily", tenantId, days.previous.start, days.previous.end],
    queryFn: () => api.call("getOnchainDaily", { path: { tenantId }, query: days.previous }),
    enabled: range !== "24h",
  });
  const protocols = useQuery({
    queryKey: ["tenant-protocols", tenantId, days.current.start, days.current.end, "mainnet"],
    queryFn: () =>
      api.call("getTenantProtocols", {
        path: { tenantId },
        query: { ...days.current, network: "mainnet" },
      }),
  });
  const footprint = useQuery({
    queryKey: ["footprint", tenantId],
    queryFn: () => api.call("listFootprint", { path: { tenantId } }),
  });
  const integration = useQuery({
    queryKey: ["integration-status", tenantId],
    queryFn: () => api.call("getIntegrationStatus", { path: { tenantId }, query: {} }),
  });

  // ---- web figures ----
  const webReady = stats.every((q) => q.data) || sites.length === 0;
  const visitors = sumOf(stats.map((q) => q.data?.verified?.visitors));
  const prevVisitors = stats.every((q) => q.data?.previous)
    ? sumOf(stats.map((q) => q.data?.previous?.verified?.visitors))
    : null;
  const pvVerified = sumOf(stats.map((q) => q.data?.verified?.pageviews));
  const pvRaw = sumOf(stats.map((q) => q.data?.raw?.pageviews));
  const filtered = Math.max(0, pvRaw - pvVerified);
  const unit = series.find((q) => q.data)?.data?.unit ?? "day";
  const buckets = series.find((q) => q.data?.verified)?.data?.verified?.map((p) => p.t) ?? [];
  const sumBucket = (key: "verified" | "raw") =>
    buckets.map((t) =>
      series.reduce((a, q) => a + (q.data?.[key]?.find((p) => p.t === t)?.visitors ?? 0), 0),
    );
  const verifiedVisitors = sumBucket("verified");
  const rawVisitors = sumBucket("raw");
  const notes = (annotations.data ?? [])
    .map((a) => ({
      index: buckets.findIndex((t) => t.slice(0, 10) === a.start.slice(0, 10)),
      label: a.body,
    }))
    .filter((a) => a.index >= 0);

  // ---- API ----
  const hasServices = (services.data?.length ?? 0) > 0;
  const apiReady = !services.isPending && apiSummaries.every((q) => q.data || q.error);
  const requests = sumOf(apiSummaries.map((q) => q.data?.requests));
  const s5 = sumOf(apiSummaries.map((q) => q.data?.status.s5xx));
  const p95s = apiSummaries
    .map((q) => q.data?.latency.p95_ms)
    .filter((v): v is number => typeof v === "number");
  const apiBuckets = apiSeries.find((q) => q.data)?.data?.points.map((p) => p.t) ?? [];
  const apiDaily = apiBuckets.map((t) =>
    apiSeries.reduce((a, q) => a + (q.data?.points.find((p) => p.t === t)?.requests ?? 0), 0),
  );
  const levels = apiSummaries
    .map((q) => q.data?.assurance_level)
    .filter((l): l is "A0" | "A1" | "A2" => !!l);
  const lowestLevel = levels.length > 0 ? [...levels].sort()[0] : null;

  // ---- wallets (complete UTC days, mainnet) ----
  const curDays = new Set(dayList(days.current.start, days.current.end));
  const walletDaily = dayList(days.current.start, days.current.end).map((d) =>
    sumOf(wallets.map((q) => q.data?.daily.find((x) => x.day === d)?.wallet_connect)),
  );
  const walletSum = (
    pick: (d: ControlPlane.WalletFunnel["daily"][number]) => number,
    inCur: boolean,
  ) =>
    sumOf(
      wallets.flatMap((q) =>
        (q.data?.daily ?? []).filter((d) => curDays.has(d.day) === inCur).map(pick),
      ),
    );
  const connects = walletSum((d) => d.wallet_connect, true);
  const connectsPrev = walletSum((d) => d.wallet_connect, false);
  const signatures = walletSum((d) => d.sign_approved, true);
  const walletsReady = wallets.every((q) => q.data) && sites.length > 0;

  // ---- on-chain (complete UTC days, mainnet, verified contracts) ----
  const rows = onchain.data ?? [];
  const cur = onchainTotals(rows, "mainnet");
  const prev = onchainTotals(onchainPrev.data ?? [], "mainnet");
  const chainTestnet = onchainTotals(rows, "testnet");
  const chainDaily = dayList(days.current.start, days.current.end).map((d) =>
    sumOf(
      rows
        .filter(
          (r) =>
            r.day === d &&
            r.contract_status === "verified" &&
            (r.network === "mainnet" || r.network === "public"),
        )
        .map((r) => r.invocations),
    ),
  );

  // ---- trust ----
  const scored = trust
    .map((q) => latestWindowScore(q.data ?? []))
    .filter((s): s is ControlPlane.TrustScore => !!s);
  const minScore = scored.reduce<number | null>(
    (m, s) => (s.score === null ? m : m === null ? s.score : Math.min(m, s.score)),
    null,
  );
  const flags = anomalyFlags(
    trust.flatMap((q) => q.data ?? []),
    annotations.data ?? [],
  );
  const openFlags = openFlagCount(flags);
  const explained = flags.filter((f) => f.explained).length;
  const verifiedContracts = (footprint.data ?? []).filter(
    (f) => f.kind === "contract" && f.status === "verified" && !f.conflict_since,
  ).length;
  const daysWithEvents = Math.max(
    0,
    ...series.map((q) => (q.data?.raw ?? []).filter((p) => (p.pageviews ?? 0) > 0).length),
  );
  const suspect = pvRaw > 0 ? filtered / pvRaw : null;
  const conf = confidence({
    days: n,
    rawPageviews: pvRaw,
    daysWithEvents: unit === "hour" ? n : daysWithEvents,
    suspectShare: suspect,
    openFlags,
    level: tenant.verification_level,
    hasApi: hasServices && requests > 0,
    onchainEnabled: tenant.onchain_correlation_enabled,
    verifiedContracts,
  });
  const waiting = sites.filter((_s, i) => {
    const inst = installs[i]?.data;
    return inst
      ? inst.verdicts.verified + inst.verdicts.suspect + inst.verdicts.rejected === 0
      : false;
  });

  const webLink = firstSite
    ? ({
        to: "/t/$tenantId/sites/$siteId",
        params: { tenantId, siteId: firstSite.site_id },
        search: { range, variant: "verified", compare: false },
      } as const)
    : null;

  return (
    <>
      <section className="um-grid um-g4" aria-label="Summary">
        <Kpi
          testId="ov-visitors"
          tone="web"
          icon="globe"
          label="Visitors"
          chip="verified"
          loading={!webReady}
          value={sites.length === 0 ? null : fmtN(visitors)}
          delta={deltaOf(visitors, prevVisitors)}
          foot={
            <>
              <Spark
                values={verifiedVisitors}
                color="webmid"
                partial={!!partialLast(buckets, unit)}
              />
              <span data-testid="ov-verified">{fmtN(pvVerified)} verified page views</span>
              <MetricDef metric="visitors_sum" />
            </>
          }
        />
        <Kpi
          testId="ov-requests"
          tone="api"
          icon="server"
          label="API requests"
          chip="self"
          loading={hasServices && !apiReady}
          value={hasServices ? fmtCompact(requests) : null}
          foot={
            hasServices ? (
              <>
                <Spark
                  values={apiDaily}
                  color="api"
                  partial={!!partialLast(apiBuckets, range === "24h" ? "hour" : "day")}
                />
                {(services.data?.length ?? 0) > 1 ? `All ${services.data?.length} services · ` : ""}
                {requests > 0 ? `${fmtPctN(s5 / requests, 1)} server errors` : "No requests yet"}
                {p95s.length > 0 ? ` · p95 ${Math.round(Math.max(...p95s))} ms` : ""}
                <MetricDef metric="api_requests" />
              </>
            ) : (
              <>
                No API service yet
                <MetricDef metric="api_requests" />
              </>
            )
          }
        />
        <Kpi
          testId="ov-wallets"
          tone="wallet"
          icon="wallet"
          label="Wallet connects"
          chip="verified"
          loading={sites.length > 0 && !walletsReady}
          value={sites.length === 0 ? null : fmtN(connects)}
          delta={range === "24h" ? undefined : deltaOf(connects, connectsPrev)}
          foot={
            <>
              <Spark values={walletDaily} color="ink" />
              {fmtN(signatures)} signatures approved · mainnet
              <MetricDef
                term="Wallet connects"
                text="wallet_connect events the tracker's wallet adapter sends from your website, verified, counted per UTC day on mainnet. No wallet address is collected."
              />
            </>
          }
        />
        <Kpi
          testId="ov-onchain"
          tone="chain"
          icon="layers"
          label="Contract calls"
          chip="ledger"
          loading={onchain.isPending}
          value={tenant.onchain_correlation_enabled ? fmtN(cur.invocations) : null}
          delta={
            range === "24h" || !onchainPrev.data
              ? undefined
              : deltaOf(cur.invocations, prev.invocations)
          }
          foot={
            tenant.onchain_correlation_enabled ? (
              <>
                <Spark values={chainDaily} color="yellowdeep" />
                {cur.invocations > 0
                  ? `${fmtPctN(cur.successful / cur.invocations)} successful · `
                  : ""}
                {verifiedContracts} verified contract{verifiedContracts === 1 ? "" : "s"}
                <MetricDef metric="onchain_invocations" />
              </>
            ) : (
              <>
                On-chain matching is off
                <MetricDef metric="onchain_invocations" />
              </>
            )
          }
        />
      </section>

      <section className="um-p-tstrip" aria-label="Proof">
        <Link to="/t/$tenantId/trust" params={{ tenantId }} className="um-p-ts">
          <span className="um-tile um-tone-web">
            <Icon name="shield" />
          </span>
          <span>
            <small>Verification</small>
            <b>Level {tenant.verification_level}</b>
            <em>{LEVEL_NEXT[tenant.verification_level] ?? ""}</em>
          </span>
        </Link>
        <Link to="/t/$tenantId/trust" params={{ tenantId }} className="um-p-ts">
          <span className="um-tile um-tone-web">
            <Icon name="activity" />
          </span>
          <span>
            <small>Trust score · 28 days</small>
            <b>{minScore === null ? "Not scored yet" : `${minScore} / 100`}</b>
            <em>
              {flags.length === 0
                ? "No flagged days"
                : `${flags.length} flagged day${flags.length === 1 ? "" : "s"} · ${explained} explained`}
            </em>
          </span>
        </Link>
        <Link to="/t/$tenantId/sharing" params={{ tenantId }} className="um-p-ts">
          <span className="um-tile um-tone-neutral">
            <Icon name={tenant.public_stats_enabled ? "globe" : "lock"} />
          </span>
          <span>
            <small>Public stats</small>
            <b>{tenant.public_stats_enabled ? "On" : "Off"}</b>
            <em>
              {tenant.public_stats_enabled ? "Anyone with the link" : "Only your team sees this"}
            </em>
          </span>
        </Link>
      </section>

      <section className="um-grid um-g21">
        <Card
          title="Visitors"
          sub="Verified visitors against everything received"
          actions={
            <Legend
              items={[
                { label: "Verified", color: "web" },
                { label: "All received", color: "grey", dash: true },
                ...(notes.length > 0
                  ? [{ label: "Note", color: "yellow" as const, dot: true }]
                  : []),
              ]}
            />
          }
        >
          {sites.length === 0 ? (
            <EmptyState
              title="No website yet"
              icon="globe"
              action={
                <Link
                  to="/t/$tenantId/integrations"
                  params={{ tenantId }}
                  search={{ group: "web" }}
                  className="um-btn um-btn--secondary um-btn--sm"
                >
                  <Icon name="plug" />
                  Add a website
                </Link>
              }
            >
              Add your website and its page views appear here, checked for automated traffic.
            </EmptyState>
          ) : series.some((q) => q.isPending) ? (
            <LoadingState block label="Loading visitors…" />
          ) : series.find((q) => q.error) ? (
            <ErrorState error={series.find((q) => q.error)?.error} plain />
          ) : (
            <>
              <Chart
                partial={partialLast(buckets, unit)}
                labels={buckets.map((t) => axisLabel(t, unit))}
                label={`Verified visitors and all received visitors, ${RANGE_SUB[range]}`}
                series={[
                  { name: "Verified visitors", color: "web", data: verifiedVisitors, area: true },
                  {
                    name: "All received",
                    color: "grey",
                    data: rawVisitors,
                    dash: true,
                    thin: true,
                  },
                ]}
                annotations={notes}
                height={240}
                testId="ov-chart"
              />
              {pvRaw > 0 ? (
                <Note icon="filter">
                  <p>
                    {fmtN(filtered)} page views were set aside as likely automated (
                    {fmtPctN(suspect)}). Each keeps its reason.{" "}
                    <Link className="um-link" to="/t/$tenantId/trust" params={{ tenantId }}>
                      See why
                    </Link>
                  </p>
                </Note>
              ) : null}
            </>
          )}
        </Card>
        <Card title="Your sources" sub="What is connected and reporting">
          <Sources
            tenant={tenant}
            sites={sites}
            services={services.data ?? []}
            footprint={footprint.data ?? []}
            status={integration.data}
            loading={services.isPending || footprint.isPending}
          />
          <Link
            className="um-link"
            to="/t/$tenantId/integrations"
            params={{ tenantId }}
            search={{}}
          >
            Add an integration <Icon name="arrow" size="sm" />
          </Link>
        </Card>
      </section>

      <section className="um-grid um-g3">
        <Card
          tone="web"
          title="Top pages"
          headingLevel={3}
          actions={
            webLink ? (
              <Link className="um-link" {...webLink}>
                Web <Icon name="arrow" size="sm" />
              </Link>
            ) : null
          }
        >
          {!firstSite ? (
            <EmptyState plain title="No website yet" />
          ) : pages.isPending ? (
            <LoadingState />
          ) : pages.error ? (
            <ErrorState error={pages.error} plain />
          ) : (pages.data?.verified ?? []).length === 0 ? (
            <EmptyState plain title="No page views yet" />
          ) : (
            <BarList
              tone="web"
              label="Top pages"
              rows={(pages.data?.verified ?? []).map((r) => ({
                key: r.value,
                label: r.is_other ? "Other" : <code>{r.value}</code>,
                value: fmtCompact(r.visitors ?? r.pageviews ?? 0),
                share: r.share_pct ?? null,
                other: r.is_other,
              }))}
            />
          )}
        </Card>
        <Card
          tone="api"
          title="Busiest routes"
          headingLevel={3}
          actions={
            firstService ? (
              <Link
                className="um-link"
                to="/t/$tenantId/services/$serviceId"
                params={{ tenantId, serviceId: firstService.service_id }}
                search={{
                  range: range === "24h" ? "24h" : range,
                  compare: false,
                  sort: "-requests",
                }}
              >
                API <Icon name="arrow" size="sm" />
              </Link>
            ) : null
          }
        >
          {!firstService ? (
            <EmptyState plain title="No API service yet" />
          ) : routes.isPending ? (
            <LoadingState />
          ) : routes.error ? (
            <ErrorState error={routes.error} plain />
          ) : (routes.data?.items ?? []).length === 0 ? (
            <EmptyState plain title="No requests yet" />
          ) : (
            <BarList
              tone="api"
              label="Busiest routes"
              rows={(routes.data?.items ?? []).map((r) => {
                const total = apiSummaries[0]?.data?.requests ?? 0;
                return {
                  key: `${r.route}${r.rpc_method ?? ""}`,
                  label: (
                    <code>
                      {r.route}
                      {r.rpc_method ? ` · ${r.rpc_method}` : ""}
                    </code>
                  ),
                  value: fmtCompact(r.requests),
                  share: total > 0 ? (r.requests / total) * 100 : null,
                };
              })}
            />
          )}
        </Card>
        <Card
          tone="chain"
          title="DeFi protocols your users touch"
          headingLevel={3}
          actions={
            <Link
              className="um-link"
              to="/t/$tenantId/protocols"
              params={{ tenantId }}
              search={{ range: "30d" }}
            >
              On-chain <Icon name="arrow" size="sm" />
            </Link>
          }
        >
          {protocols.isPending ? (
            <LoadingState />
          ) : protocols.error ? (
            <ErrorState error={protocols.error} plain />
          ) : (protocols.data?.protocols ?? []).every((p) => p.transactions === 0) ? (
            <EmptyState plain title="No protocol interactions yet">
              Shown once a verified contract of yours meets a known DeFi protocol.
            </EmptyState>
          ) : (
            <BarList
              tone="chain"
              label="DeFi protocols"
              rows={(protocols.data?.protocols ?? []).slice(0, 4).map((p) => ({
                key: p.protocol,
                label: p.name,
                value: fmtN(p.transactions),
                share: p.share === null ? null : p.share * 100,
              }))}
            />
          )}
        </Card>
      </section>

      <Card
        title="Verified usage"
        sub="“Verified” names a measurement class: web events that passed our bot checks, contracts whose ownership we checked. It is not an endorsement by anyone."
        data-testid="verified-usage"
      >
        <ul className="um-p-usage">
          <li data-testid="usage-web">
            <span className="um-label">Web</span>
            <div>
              <p>
                <b>{fmtN(pvVerified)}</b> verified of {fmtN(pvRaw)} raw page views (
                {pvRaw > 0 ? fmtPctN(pvVerified / pvRaw) : "—"} verified) · {fmtPctN(suspect)}{" "}
                suspect{" "}
                {scored.length > 0 ? (
                  <BandBadge band={trustBand(minScore)} score={minScore} />
                ) : (
                  <StatusBadge status="off">Trust not scored yet</StatusBadge>
                )}
              </p>
              <small>
                Measured in the visitor's browser: a challenge and proof per page view. Trust is the
                lowest 28-day score of the project's websites.
              </small>
            </div>
          </li>
          <li data-testid="usage-api">
            <span className="um-label">API</span>
            <div>
              {!hasServices ? (
                <p className="um-muted">No API service registered.</p>
              ) : (
                <>
                  <p>
                    <b>{fmtN(requests)}</b> requests ·{" "}
                    <Chip kind="self">self-attested telemetry</Chip>{" "}
                    {lowestLevel ? (
                      <span data-testid="assurance-level">
                        <Tag>assurance {lowestLevel}</Tag>
                      </span>
                    ) : null}
                  </p>
                  <small>
                    Reported by the project's own servers; assurance A0–A2 says how far our checks
                    go.
                  </small>
                </>
              )}
            </div>
          </li>
          <li data-testid="usage-chain">
            <span className="um-label">On-chain</span>
            <div>
              {!tenant.onchain_correlation_enabled ? (
                <p className="um-muted">On-chain correlation is off for this project.</p>
              ) : (
                <>
                  <p>
                    <b>{fmtN(cur.invocations)}</b> invocations on mainnet (
                    {cur.invocations > 0 ? fmtPctN(cur.successful / cur.invocations) : "—"}{" "}
                    successful), {fmtN(cur.invokersDailySum)} daily invokers (sum) ·{" "}
                    {verifiedContracts} verified contract
                    {verifiedContracts === 1 ? "" : "s"}
                  </p>
                  {chainTestnet.invocations > 0 ? (
                    <small data-testid="usage-chain-testnet">
                      Testnet: {fmtN(chainTestnet.invocations)} invocations (not counted as usage).
                    </small>
                  ) : null}
                </>
              )}
            </div>
          </li>
          <li data-testid="usage-confidence">
            <span className="um-label">Confidence</span>
            <div>
              <p>
                <b data-testid="confidence-level">{CONFIDENCE_TEXT[conf.level]}</b>
                {conf.reasons.length > 0
                  ? `: ${conf.reasons.map((r) => CONFIDENCE_REASON_TEXT[r]).join("; ")}`
                  : null}
              </p>
              <small>
                Methodology scf-methodology/1.0.0, the rule your signed snapshots use (project level{" "}
                {tenant.verification_level}).
              </small>
            </div>
          </li>
          <li data-testid="overview-flags">
            <span className="um-label">Flags</span>
            <div>
              {flags.length === 0 ? (
                <p className="um-muted">No anomaly flags in the last 30 days.</p>
              ) : (
                <p>
                  <b data-testid="open-flags">{openFlags}</b> open ({flags.length} flagged day
                  {flags.length === 1 ? "" : "s"}).{" "}
                  <Link className="um-link" to="/t/$tenantId/trust" params={{ tenantId }}>
                    See reasons and explain
                  </Link>
                </p>
              )}
            </div>
          </li>
        </ul>
      </Card>

      <PrivacyCard />

      {waiting.map((s) => (
        <FirstEventPanel key={s.site_id} tenantId={tenantId} site={s} headingLevel={2} />
      ))}
    </>
  );
}

const LEVEL_NEXT: Record<string, string> = {
  L0: "Next: verify your domain",
  L1: "Next: link a Stellar account",
  L2: "Next: SCF registry match",
  L3: "Next: operator approval",
  L4: "Highest level",
};

function dayList(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function Sources({
  tenant,
  sites,
  services,
  footprint,
  status,
  loading,
}: {
  tenant: ControlPlane.Tenant;
  sites: ControlPlane.Site[];
  services: ControlPlane.Service[];
  footprint: ControlPlane.FootprintItem[];
  status: ControlPlane.IntegrationStatusReport | undefined;
  loading: boolean;
}) {
  if (loading) return <LoadingState />;
  const site = status?.signals.site;
  const svc = status?.signals.service;
  const live = (b: boolean | undefined) =>
    b ? (
      <StatusBadge status="live">Live</StatusBadge>
    ) : (
      <StatusBadge status="set">Set up</StatusBadge>
    );
  const items: SourceItem[] = [
    ...sites.map((s) => ({
      key: s.site_id,
      icon: "globe" as const,
      tone: "web" as const,
      title: s.domains?.[0]?.host ?? s.name,
      sub: `Website · ${s.tracker_profile} profile${s.domains && s.domains.length > 1 ? ` · ${s.domains.length} domains` : ""}`,
      status:
        site && site.site_id === s.site_id ? (
          site.counted_7d ? (
            live(true)
          ) : site.dev_events_24h > 0 ? (
            <StatusBadge status="wait">Test received</StatusBadge>
          ) : (
            live(false)
          )
        ) : (
          <StatusBadge status="set">Added</StatusBadge>
        ),
    })),
    ...(site && (site.wallet_counted_7d || site.wallets_kit_seen_7d)
      ? [
          {
            key: "wallets",
            icon: "wallet" as const,
            tone: "wallet" as const,
            title: site.wallets_kit_seen_7d ? "Stellar Wallets Kit" : "Wallet events",
            sub: "Connects and signatures",
            status: live(site.wallet_counted_7d),
          },
        ]
      : []),
    ...services.map((s) => ({
      key: s.service_id,
      icon: "server" as const,
      tone: "api" as const,
      title: s.display_name ?? s.service_name,
      sub: `OpenTelemetry · ${s.registration === "auto" ? "registered on first data" : "registered in the portal"}`,
      status:
        svc && svc.service_id === s.service_id ? (
          live(svc.counted_7d)
        ) : (
          <StatusBadge status="set">Added</StatusBadge>
        ),
    })),
    ...(footprint.length > 0
      ? [
          {
            key: "footprint",
            icon: "layers" as const,
            tone: "chain" as const,
            title:
              plural(footprint.filter((f) => f.kind === "contract").length, "contract") +
              (footprint.some((f) => f.kind !== "contract")
                ? `, ${plural(footprint.filter((f) => f.kind !== "contract").length, "account or hash", "accounts or hashes")}`
                : ""),
            sub: `Registered footprint · ${footprint.filter((f) => f.status === "verified").length} verified`,
            status: tenant.onchain_correlation_enabled ? (
              live(true)
            ) : (
              <StatusBadge status="off">Off</StatusBadge>
            ),
          },
        ]
      : []),
  ];
  if (items.length === 0)
    return (
      <EmptyState plain title="Nothing connected yet" icon="plug">
        Pick an integration to start measuring.
      </EmptyState>
    );
  return <SourceList items={items} label="Your sources" />;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
