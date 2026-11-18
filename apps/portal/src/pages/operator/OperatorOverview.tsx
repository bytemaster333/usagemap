// SPDX-License-Identifier: Apache-2.0
// SCF operator overview (approved design 2026-11-20): enrolment counts (operatorOverview), ecosystem web and API
// totals against the previous window of the same length, daily page views verified vs. received before filtering,
// what needs attention (projects waiting for approval, high suspect share, running erasures, unused operator keys),
// the biggest gains and drops, and one row per project with web and API figures side by side. Every figure comes from
// the audited operator reads; nothing is estimated.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  buttonClass,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Kpi,
  LoadingState,
  TableScroll,
} from "../../components/ui/index.ts";
import { daysOf, previousSpan } from "../../lib/days.ts";
import { OVERVIEW_FLAGS, overviewRows, sumApiDays, sumWebDays } from "../../lib/opAgg.ts";
import type { OperatorSearch } from "../../lib/search.ts";
import { filterQuery, spanOf } from "./common.tsx";
import {
  CalmError,
  DeltaPill,
  deltaProps,
  kpiErr,
  Legend,
  LineChart,
  Lvl,
  Num,
  OpIntro,
  OpQueryState,
  PName,
  PrivacyFloor,
  Spark,
  TopActions,
} from "./kit.tsx";
import { awardLine, CATEGORY_SHORT, changePct, fmtCompact, fmtShareD } from "./model.ts";
import { OPERATOR_DEFAULT_SEARCH } from "./OperatorLayout.tsx";

const DAY_MS = 86_400_000;

export function OperatorOverviewPage() {
  useTitle("Overview");
  const search = useSearch({ from: "/app/operator/overview" });
  const navigate = useNavigate();
  const go = (s: Partial<OperatorSearch>) =>
    void navigate({ to: "/operator/overview", search: { ...search, ...s }, replace: true });
  const span = spanOf(search);
  const ok = !("error" in span);
  const base = ok ? filterQuery(search, span) : null;
  const prev = ok ? previousSpan(span) : null;
  const days = ok ? daysOf(span) : [];

  const overview = useQuery({
    queryKey: ["op-overview"],
    queryFn: () => api.call("operatorOverview", {}),
  });
  const web = useQuery({
    queryKey: ["op-web-summary", base, "verified"],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorWebSummary", {
        query: { ...(base as NonNullable<typeof base>), variant: "verified" },
      }),
  });
  const raw = useQuery({
    queryKey: ["op-web-summary", base, "raw"],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorWebSummary", {
        query: { ...(base as NonNullable<typeof base>), variant: "raw" },
      }),
  });
  const webPrev = useQuery({
    queryKey: ["op-web-summary", base, "verified", "prev"],
    enabled: !!base && !!prev,
    queryFn: () =>
      api.json("operatorWebSummary", {
        query: {
          ...(base as NonNullable<typeof base>),
          ...(prev as NonNullable<typeof prev>),
          variant: "verified",
        },
      }),
  });
  const apiSum = useQuery({
    queryKey: ["op-api-summary", base],
    enabled: !!base,
    queryFn: () => api.json("operatorApiSummary", { query: base as NonNullable<typeof base> }),
  });
  const apiPrev = useQuery({
    queryKey: ["op-api-summary", base, "prev"],
    enabled: !!base && !!prev,
    queryFn: () =>
      api.json("operatorApiSummary", {
        query: { ...(base as NonNullable<typeof base>), ...(prev as NonNullable<typeof prev>) },
      }),
  });
  const projects = useQuery({
    queryKey: ["op-web-projects", base, "verified", "overview"],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorWebProjects", {
        query: {
          ...(base as NonNullable<typeof base>),
          variant: "verified",
          compare: "previous",
          sort: "-pageviews",
          limit: 200,
        },
      }),
  });
  // API-only projects have no name on their service rows: take it from the project list
  const tenantNames = useQuery({
    queryKey: ["op-tenants", "names"],
    queryFn: () =>
      api.call("operatorListTenants", {
        query: {
          status: ["pending", "active", "suspended", "removed"],
          min_level: "L0",
          limit: 200,
        },
      }),
    staleTime: 60_000,
  });
  const services = useQuery({
    queryKey: ["op-api-services", base, "overview"],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorApiServices", {
        query: { ...(base as NonNullable<typeof base>), sort: "-requests", limit: 200 },
      }),
  });

  const w = web.data ? sumWebDays(web.data.days) : null;
  const wp = webPrev.data ? sumWebDays(webPrev.data.days) : null;
  const a = apiSum.data ? sumApiDays(apiSum.data.days) : null;
  const ap = apiPrev.data ? sumApiDays(apiPrev.data.days) : null;
  const ov = overview.data;

  return (
    <>
      <TopActions
        range={search.range}
        onRange={(r) => go({ range: r })}
        csv={
          base
            ? {
                file: "scf-web-projects.csv",
                fetch: () =>
                  api.csv("operatorWebProjects", {
                    query: { ...base, variant: "verified", sort: "-pageviews", limit: 200 },
                  }),
              }
            : undefined
        }
      />
      <OpIntro
        title="Overview"
        lead="Every Stellar ecosystem project enrolled in UsageMap, added up. Web figures are filtered for bots and inflation; API figures are what each project reports about itself."
        aside={<PrivacyFloor privacy={projects.data?.privacy} />}
      />
      {!ok ? <ErrorState error={new Error(span.error)} /> : null}
      <div className="um-grid um-g4 um-op-kg2">
        <Kpi
          tone="chain"
          icon="list"
          label="Stellar ecosystem projects"
          loading={overview.isPending}
          value={ov ? ov.enrolled.value : null}
          testId="ov-enrolled"
          foot={
            ov ? (
              <>
                <DeltaPillAbs n={ov.new_this_month.value} /> new this month ·{" "}
                {ov.removed_this_month.value} removed
              </>
            ) : overview.error ? (
              "Could not load the enrolment counts."
            ) : undefined
          }
          {...kpiErr(overview)}
        />
        <Kpi
          tone="web"
          icon="globe"
          label="Page views"
          chip="verified"
          loading={web.isPending}
          value={w ? fmtCompact(w.pageviews) : null}
          delta={
            w && wp
              ? deltaProps(w.pageviews, wp.pageviews, "against the previous window")
              : undefined
          }
          foot={`vs previous ${days.length} days`}
          testId="eco-pageviews"
          {...kpiErr(web)}
        />
        <Kpi
          tone="web"
          icon="users"
          label="Visitors"
          loading={web.isPending}
          value={w ? fmtCompact(w.visitors_sum) : null}
          delta={
            w && wp
              ? deltaProps(w.visitors_sum, wp.visitors_sum, "against the previous window")
              : undefined
          }
          foot="Sum of daily visitors"
          testId="eco-visitors"
          {...kpiErr(web)}
        />
        <Kpi
          tone="api"
          icon="server"
          label="API requests"
          chip="self"
          loading={apiSum.isPending}
          value={a ? fmtCompact(a.requests) : null}
          delta={
            a && ap ? deltaProps(a.requests, ap.requests, "against the previous window") : undefined
          }
          foot={`vs previous ${days.length} days`}
          testId="eco-requests"
          {...kpiErr(apiSum)}
        />
      </div>
      <div className="um-grid um-g21">
        <Card
          title="Daily page views, all Stellar ecosystem projects"
          actions={
            <Legend
              items={[
                { name: "Verified", color: "#111111" },
                { name: "Received before filtering", color: "#8b9198", dash: true },
              ]}
            />
          }
        >
          <OpQueryState
            query={web}
            loading={<LoadingState block label="Loading the daily page views…" />}
            isEmpty={(d) => d.days.length === 0}
            empty={<EmptyState plain title="No page views in this window" />}
          >
            {(d) => (
              <LineChart
                label="Verified page views and page views received before filtering, per day"
                days={d.days.map((x) => x.day)}
                series={[
                  ...(raw.data
                    ? [
                        {
                          name: "Received before filtering",
                          color: "#8b9198",
                          dash: true,
                          values: d.days.map(
                            (x) => raw.data?.days.find((r) => r.day === x.day)?.pageviews ?? null,
                          ),
                        },
                      ]
                    : []),
                  {
                    name: "Verified",
                    color: "#111111",
                    area: true,
                    values: d.days.map((x) => x.pageviews),
                  },
                ]}
              />
            )}
          </OpQueryState>
        </Card>
        <NeedsAttention base={base} projects={projects.data?.items} />
      </div>
      <GainsAndDrops query={projects} base={base} />
      <Card
        title="Stellar ecosystem projects"
        flush
        className="um-op-card-flush"
        actions={
          <Link
            to="/operator/web"
            search={{ ...OPERATOR_DEFAULT_SEARCH, range: search.range }}
            className="um-op-tlink"
          >
            Compare in detail <Icon name="columns" />
          </Link>
        }
        data-testid="op-overview"
      >
        <OpQueryState<{
          p: ControlPlane.OperatorWebProjectPage;
          s: ControlPlane.OperatorApiServicePage;
        }>
          query={{
            data:
              projects.data && services.data ? { p: projects.data, s: services.data } : undefined,
            error: projects.error ?? services.error,
            isPending: projects.isPending || services.isPending,
            refetch: (() => {
              void projects.refetch();
              void services.refetch();
            }) as never,
          }}
          isEmpty={(d) => d.p.items.length === 0 && d.s.items.length === 0}
          empty={
            <EmptyState plain title="No Stellar ecosystem projects with data in this window" />
          }
          plain
        >
          {(d) => (
            <AllProjects
              web={d.p.items}
              svc={d.s.items}
              names={new Map((tenantNames.data?.items ?? []).map((t) => [t.tenant_id, t.name]))}
            />
          )}
        </OpQueryState>
      </Card>
    </>
  );
}

function DeltaPillAbs({ n }: { n: number }) {
  return (
    <span className={`um-delta um-delta--${n > 0 ? "up" : "flat"}`}>{n > 0 ? `+${n}` : n}</span>
  );
}

function NeedsAttention({
  base,
  projects,
}: {
  base: ReturnType<typeof filterQuery> | null;
  projects: ControlPlane.OpWebProjectRow[] | undefined;
}) {
  const pending = useQuery({
    queryKey: ["op-tenants", { status: ["pending"], attention: true }],
    queryFn: () =>
      api.call("operatorListTenants", {
        query: { status: ["pending"], min_level: "L0", sort: "-created_at", limit: 50 },
      }),
  });
  const erasures = useQuery({
    queryKey: ["op-erasures", "running"],
    queryFn: () =>
      api.call("operatorListErasureRequests", { query: { status: ["running"], limit: 50 } }),
  });
  const keys = useQuery({
    queryKey: ["op-keys"],
    queryFn: () => api.call("operatorListApiKeys", {}),
  });
  const suspect = (projects ?? []).filter(
    (p) => (p.suspect_pageview_share ?? 0) >= OVERVIEW_FLAGS.suspectShare,
  );
  const now = Date.now();
  const unused = (keys.data ?? []).filter(
    (k) =>
      !k.revoked_at &&
      (k.flagged_for_review ||
        (k.last_used_at
          ? now - Date.parse(k.last_used_at) > 60 * DAY_MS
          : now - Date.parse(k.created_at) > 60 * DAY_MS)),
  );
  const loading = pending.isPending || erasures.isPending;
  const items: {
    key: string;
    tile: string;
    icon: Parameters<typeof Icon>[0]["name"];
    title: string;
    sub: string;
    to: "/operator/tenants" | "/operator/web" | "/operator/erasure" | "/operator/api-keys";
  }[] = [];
  const p = pending.data?.items ?? [];
  if (p.length)
    items.push({
      key: "pending",
      tile: "um-op-tile-y",
      icon: "userplus",
      title: `${p.length} ${p.length === 1 ? "Stellar ecosystem project" : "Stellar ecosystem projects"} waiting for approval`,
      sub:
        p
          .slice(0, 3)
          .map((t) => t.name)
          .join(" · ") + (p.length > 3 ? " …" : ""),
      to: "/operator/tenants",
    });
  if (suspect.length)
    items.push({
      key: "suspect",
      tile: "um-op-tile-o",
      icon: "alert",
      title: `${suspect.length} ${suspect.length === 1 ? "Stellar ecosystem project" : "Stellar ecosystem projects"} with high suspect traffic`,
      sub: `${fmtShareD(OVERVIEW_FLAGS.suspectShare, 0)} or more of page views marked suspect`,
      to: "/operator/web",
    });
  const running = erasures.data?.items ?? [];
  if (running.length)
    items.push({
      key: "erasure",
      tile: "",
      icon: "eraser",
      title: `${running.length} ${running.length === 1 ? "erasure" : "erasures"} running`,
      sub: running
        .map((e) => e.slug)
        .slice(0, 3)
        .join(" · "),
      to: "/operator/erasure",
    });
  if (unused.length)
    items.push({
      key: "keys",
      tile: "",
      icon: "key",
      title: `${unused.length} API ${unused.length === 1 ? "key" : "keys"} to review`,
      sub: unused
        .map((k) => k.label)
        .slice(0, 3)
        .join(" · "),
      to: "/operator/api-keys",
    });
  return (
    <Card title="Needs attention" tone="chain" data-testid="needs-attention">
      {loading ? (
        <LoadingState />
      ) : pending.error ? (
        <CalmError error={pending.error} onRetry={() => void pending.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState plain icon="check" title="Nothing needs attention">
          No projects waiting, no high suspect traffic{base ? " in this window" : ""}, no running
          erasures.
        </EmptyState>
      ) : (
        <ul className="um-op-attn">
          {items.map((i) => (
            <li key={i.key}>
              <span className={`um-tile um-op-tile-sm ${i.tile}`}>
                <Icon name={i.icon} />
              </span>
              <div>
                <b>{i.title}</b>
                <small>{i.sub}</small>
              </div>
              {i.to === "/operator/tenants" ? (
                <Link
                  to="/operator/tenants"
                  search={{ status: "pending", sort: "name" }}
                  className={buttonClass("secondary", { size: "sm" })}
                >
                  Review
                </Link>
              ) : i.to === "/operator/web" ? (
                <Link
                  to="/operator/web"
                  search={{ ...OPERATOR_DEFAULT_SEARCH, sort: "-suspect_pageview_share" }}
                  className={buttonClass("secondary", { size: "sm" })}
                >
                  Open
                </Link>
              ) : (
                <Link to={i.to} className={buttonClass("secondary", { size: "sm" })}>
                  Open
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GainsAndDrops({
  query,
  base,
}: {
  query: {
    data?: ControlPlane.OperatorWebProjectPage | undefined;
    error: unknown;
    isPending: boolean;
    refetch: () => Promise<unknown>;
  };
  base: ReturnType<typeof filterQuery> | null;
}) {
  const rows = (query.data?.items ?? [])
    .filter((r) => (r.pageviews_prev ?? 0) > 0 || r.pageviews > 0)
    .map((r) => ({ r, pct: changePct(r.pageviews, r.pageviews_prev) }))
    .filter((x): x is { r: ControlPlane.OpWebProjectRow; pct: number } => x.pct !== null)
    .sort((x, y) => y.pct - x.pct);
  const gains = rows.filter((x) => x.pct > 0).slice(0, 4);
  const drops = rows
    .filter((x) => x.pct < 0)
    .slice(-4)
    .reverse();
  const ids = [...gains, ...drops].map((x) => x.r.tenant_id);
  const cmp = useQuery({
    queryKey: ["op-web-compare", base?.start, base?.end, ids],
    enabled: !!base && ids.length >= 2,
    queryFn: () =>
      api.json("operatorWebCompare", {
        query: {
          start: (base as NonNullable<typeof base>).start,
          end: (base as NonNullable<typeof base>).end,
          tenant_ids: ids,
          variant: "verified",
        },
      }),
  });
  const spark = (id: string) =>
    cmp.data?.series.find((s) => s.tenant_id === id)?.days.map((d) => d.pageviews);
  const list = (xs: typeof gains, color: string, empty: string) =>
    query.isPending ? (
      <LoadingState />
    ) : query.error ? (
      <CalmError error={query.error} onRetry={() => void query.refetch()} />
    ) : xs.length === 0 ? (
      <EmptyState plain title={empty} />
    ) : (
      <ul className="um-op-rows">
        {xs.map(({ r, pct }) => {
          const s = spark(r.tenant_id);
          return (
            <li key={r.tenant_id}>
              <PName
                sub={
                  <>
                    <Num value={r.pageviews} /> page views
                    {r.categories?.[0] ? ` · ${CATEGORY_SHORT[r.categories[0]]}` : ""}
                  </>
                }
              >
                <Link to="/operator/tenants/$tenantId" params={{ tenantId: r.tenant_id }}>
                  {r.name}
                </Link>
              </PName>
              {s ? (
                <Spark
                  values={s}
                  days={cmp.data?.series[0]?.days.map((x) => x.day)}
                  color={color}
                  label={`Daily page views of ${r.name}`}
                />
              ) : (
                <span />
              )}
              <DeltaPill pct={pct} label="against the previous window" />
            </li>
          );
        })}
      </ul>
    );
  return (
    <div className="um-grid um-g2">
      <Card title="Biggest gains" icon="up" sub="Verified page views against the previous window">
        {list(gains, "#1b6e45", "No project grew in this window")}
      </Card>
      <Card title="Biggest drops" icon="down" sub="Verified page views against the previous window">
        {list(drops, "#b42318", "No project dropped in this window")}
      </Card>
    </div>
  );
}

function AllProjects({
  web,
  svc,
  names,
}: {
  web: ControlPlane.OpWebProjectRow[];
  svc: ControlPlane.OpApiServiceRow[];
  names: ReadonlyMap<string, string>;
}) {
  const rows = overviewRows([], web, svc);
  const byId = new Map(web.map((w) => [w.tenant_id, w]));
  const mismatch = new Set(
    svc.filter((s) => s.onchain_badge === "inconsistent").map((s) => s.tenant_id),
  );
  return (
    <TableScroll label="All projects" stickyFirst>
      <table className="um-table um-op-table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Level</th>
            <th scope="col" className="um-r">
              Page views
            </th>
            <th scope="col" className="um-r">
              Visitors
            </th>
            <th scope="col" className="um-r">
              Suspect share
            </th>
            <th scope="col" className="um-r um-op-gs">
              API services
            </th>
            <th scope="col" className="um-r">
              Requests
            </th>
            <th scope="col" className="um-r">
              5xx rate
            </th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const w = byId.get(r.tenant_id);
            const high = r.suspect_share !== null && r.suspect_share >= OVERVIEW_FLAGS.suspectShare;
            return (
              <tr key={r.tenant_id} data-testid={`ov-row-${r.slug}`}>
                <th scope="row">
                  <PName sub={w ? awardLine(w) : r.slug}>
                    <Link to="/operator/tenants/$tenantId" params={{ tenantId: r.tenant_id }}>
                      {names.get(r.tenant_id) ?? r.name}
                    </Link>
                  </PName>
                </th>
                <td>
                  <Lvl level={r.verification_level} />
                </td>
                <td className="um-r">{w ? <Num value={r.pageviews} /> : "—"}</td>
                <td className="um-r">{w ? <Num value={r.visitors_sum} /> : "—"}</td>
                <td className="um-r">
                  {r.suspect_share === null ? (
                    "—"
                  ) : high ? (
                    <span className="um-op-chip-org">{fmtShareD(r.suspect_share)}</span>
                  ) : (
                    fmtShareD(r.suspect_share)
                  )}
                </td>
                <td className="um-r um-op-gs">{r.services || "—"}</td>
                <td className="um-r">{r.services ? <Num value={r.requests} /> : "—"}</td>
                <td className="um-r">{r.services ? fmtShareD(r.error_rate_5xx, 2) : "—"}</td>
                <td data-testid={`ov-flags-${r.slug}`}>
                  <span className="um-op-flags">
                    {mismatch.has(r.tenant_id) ? (
                      <span
                        className="um-op-chip-org"
                        title="Reported API activity does not match what the ledger shows for this project."
                      >
                        <Icon name="chain" />
                        On-chain mismatch
                      </span>
                    ) : null}
                    {w?.trust_score_28d !== null &&
                    w?.trust_score_28d !== undefined &&
                    w.trust_score_28d < 50 ? (
                      <Chip kind="filtered">Low trust</Chip>
                    ) : null}
                    {r.error_rate_5xx !== null && r.error_rate_5xx >= OVERVIEW_FLAGS.errorRate ? (
                      <span className="um-op-chip-org">High 5xx</span>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
