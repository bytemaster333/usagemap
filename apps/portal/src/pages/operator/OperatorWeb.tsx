// SPDX-License-Identifier: Apache-2.0
// SCF-operator web analytics (operator.web-*; approved design 2026-11-20). Three tabs:
// - Projects: ecosystem tiles, the same web figures for every project (sort any column; filter by SCF round, award
//   type, category, name, level and trust band; verified or before filtering), 2–4 projects side by side on identical
//   days, a breakdown across projects with the hidden values counted, and why traffic was filtered;
// - Campaigns: a campaign window against a baseline window, per day (WebCampaigns.tsx);
// - Trust scores: the advisory 0–100 score per website with its signals and reason codes (WebTrust.tsx).
// Every figure comes from the audited operator reads (C-17); breakdown rows carry the minimum count and rounding,
// everything else is exact (C-91, C-95).

import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  Kpi,
  LoadingState,
  Segmented,
  TableScroll,
  Tabs,
  tabPanelProps,
} from "../../components/ui/index.ts";
import { webReasonText } from "../../lib/apiFormat.ts";
import { previousSpan } from "../../lib/days.ts";
import { countryName } from "../../lib/format.ts";
import { sumWebDays } from "../../lib/opAgg.ts";
import { filterQuery, SortTh, settingNumber, spanOf, toggleId, useOpSettings } from "./common.tsx";
import { FilterBar } from "./filters.tsx";
import {
  BarList,
  DeltaPill,
  deltaProps,
  Hid,
  kpiErr,
  Legend,
  LineChart,
  Lvl,
  NotAvailable,
  Num,
  OpQueryState,
  PName,
  PrivacyFloor,
  ScrollIntoView,
  TopActions,
  TrustCell,
} from "./kit.tsx";
import {
  awardLine,
  changePct,
  fmtCompact,
  fmtMinSec,
  fmtShareD,
  MAX_PICKS,
  type OpSearch,
  PICK_COLORS,
  pickColorClass,
  sortBy,
  WEB_DIMS,
  type WebDim,
  type WebTab,
  withOp,
} from "./model.ts";
import { WebCampaigns } from "./WebCampaigns.tsx";
import { WebTrust } from "./WebTrust.tsx";

type Row = ControlPlane.OpWebProjectRow;

const TAB_ITEMS: { id: WebTab; label: string }[] = [
  { id: "projects", label: "Stellar ecosystem projects" },
  { id: "campaigns", label: "Campaigns" },
  { id: "trust", label: "Trust scores" },
];

export function useOpWebNav(from: "/app/operator/web" | "/app/operator/api") {
  const search = useSearch({ from }) as OpSearch;
  const navigate = useNavigate();
  const to = from === "/app/operator/web" ? "/operator/web" : "/operator/api";
  const set = (change: Partial<Record<keyof OpSearch, unknown>>) =>
    void navigate({ to, search: withOp(search, change), replace: true });
  return { search, set };
}

export function OperatorWebPage() {
  useTitle("Web");
  const { search, set } = useOpWebNav("/app/operator/web");
  const tab: WebTab = search.tab ?? "projects";
  const span = spanOf(search);
  const ok = !("error" in span);
  const base = ok ? filterQuery(search, span) : null;
  const projectsQuery = base
    ? {
        ...base,
        variant: search.variant,
        compare: "previous" as const,
        sort: "-pageviews" as const,
        ...(search.round ? { award_round: search.round } : {}),
        ...(search.stage ? { award_stage: search.stage } : {}),
        ...(search.cat ? { category: search.cat } : {}),
        ...(search.min ? { min_pageviews: search.min } : {}),
        limit: 200,
      }
    : null;
  return (
    <>
      <TopActions
        range={search.range}
        onRange={(r) => set({ range: r, from: undefined, to: undefined })}
        csv={
          projectsQuery && tab === "projects"
            ? {
                file: "scf-web-projects.csv",
                fetch: () => api.csv("operatorWebProjects", { query: projectsQuery }),
              }
            : undefined
        }
      />
      <h1 className="um-sr">Web</h1>
      <Tabs
        label="Web views"
        idBase="op-web"
        items={TAB_ITEMS}
        value={tab}
        onChange={(t) => set({ tab: t === "projects" ? undefined : t })}
      />
      <div {...tabPanelProps("op-web", tab)} className="um-op-panel">
        {!ok ? (
          <ErrorState error={new Error(span.error)} />
        ) : tab === "campaigns" ? (
          <WebCampaigns search={search} />
        ) : tab === "trust" ? (
          <WebTrust search={search} />
        ) : (
          <WebProjects search={search} set={set} base={base} projectsQuery={projectsQuery} />
        )}
      </div>
    </>
  );
}

function WebProjects({
  search,
  set,
  base,
  projectsQuery,
}: {
  search: OpSearch;
  set: (c: Partial<Record<keyof OpSearch, unknown>>) => void;
  base: ReturnType<typeof filterQuery> | null;
  projectsQuery: Record<string, unknown> | null;
}) {
  const settings = useOpSettings();
  const rankMin =
    (settings.data?.find((s) => s.key === "op_rank_min_level")?.value as string) ?? "L1";
  const summary = useQuery({
    queryKey: ["op-web-summary", base, search.variant],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorWebSummary", {
        query: { ...(base as NonNullable<typeof base>), variant: search.variant },
      }),
  });
  const prev = base ? previousSpan(base) : null;
  const summaryPrev = useQuery({
    queryKey: ["op-web-summary", base, search.variant, "prev"],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorWebSummary", {
        query: {
          ...(base as NonNullable<typeof base>),
          ...(prev as NonNullable<typeof prev>),
          variant: search.variant,
        },
      }),
  });
  const projects = useQuery({
    queryKey: ["op-web-projects", projectsQuery],
    enabled: !!projectsQuery,
    queryFn: () =>
      api.json("operatorWebProjects", {
        query: projectsQuery as Parameters<typeof api.json<"operatorWebProjects">>[1]["query"] &
          object,
      }),
  });
  // SCF rounds offered in the filter: those of the projects loaded without a round filter.
  const allRows = useQuery({
    queryKey: ["op-web-projects", "rounds", base],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorWebProjects", {
        query: { ...(base as NonNullable<typeof base>), variant: "verified", limit: 200 },
      }),
    staleTime: 60_000,
  });
  const rounds = [
    ...new Set((allRows.data?.items ?? []).flatMap((r) => (r.award_round ? [r.award_round] : []))),
  ].sort((a, b) => b - a);
  const t = summary.data ? sumWebDays(summary.data.days) : null;
  const tp = summaryPrev.data ? sumWebDays(summaryPrev.data.days) : null;
  const sort = search.sort ?? "-pageviews";
  const q = (search.q ?? "").toLowerCase();
  const all = projects.data?.items ?? [];
  const rows = sortBy(
    all.filter((r) => !q || r.name.toLowerCase().includes(q) || r.slug.includes(q)),
    sort,
    (r, k) =>
      k === "name"
        ? r.name.toLowerCase()
        : k === "pageviews_change"
          ? changePct(r.pageviews, r.pageviews_prev)
          : (r as unknown as Record<string, number | null>)[k],
  );
  const picked = search.ids;
  const pickedRows = picked
    .map((id) => all.find((r) => r.tenant_id === id))
    .filter((r): r is Row => !!r);
  return (
    <>
      <div className="um-op-lead-row">
        <p className="um-op-lead">
          The same web figures for every Stellar ecosystem project. Sort any column, then pick 2 to
          4 projects to see them side by side.
        </p>
        <PrivacyFloor privacy={projects.data?.privacy} />
      </div>
      <div className="um-grid um-g4 um-op-kg2">
        <Kpi
          tone="web"
          icon="users"
          label="Visits"
          loading={summary.isPending}
          value={t ? fmtCompact(t.visits) : null}
          delta={
            t && tp ? deltaProps(t.visits, tp.visits, "against the previous window") : undefined
          }
          foot="vs previous window"
          testId="eco-visits"
          {...kpiErr(summary)}
        />
        <Kpi
          tone="web"
          icon="repeat"
          label="Bounce rate"
          loading={summary.isPending}
          value={t?.bounce_rate_pct === null || !t ? null : `${t.bounce_rate_pct.toFixed(1)}%`}
          foot={t ? `${fmtCompact(t.bounces)} single-page visits · lower is better` : undefined}
          testId="eco-bounce"
          {...kpiErr(summary)}
        />
        <Kpi
          tone="web"
          icon="clock"
          label="Avg visit"
          loading={summary.isPending}
          value={t?.avg_visit_duration_s === null || !t ? null : fmtMinSec(t.avg_visit_duration_s)}
          delta={
            t && tp
              ? deltaProps(
                  t.avg_visit_duration_s,
                  tp.avg_visit_duration_s,
                  "against the previous window",
                )
              : undefined
          }
          foot="vs previous window"
          testId="eco-duration"
          {...kpiErr(summary)}
        />
        <Kpi
          tone="chain"
          icon="shield"
          label="Suspect page views"
          loading={summary.isPending}
          value={
            t?.suspect_pageview_share === null || !t ? null : fmtShareD(t.suspect_pageview_share)
          }
          foot="Marked suspect and left out of verified"
          testId="eco-suspect"
          {...kpiErr(summary)}
        />
      </div>
      {search.sbs && picked.length >= 2 && base ? (
        <SideBySide
          ids={picked}
          rows={pickedRows}
          base={base}
          variant={search.variant}
          onClose={() => set({ sbs: undefined })}
        />
      ) : null}
      <Card
        title="Stellar ecosystem projects"
        flush
        className="um-op-card-flush um-op-cmp"
        actions={
          <Segmented
            label="Web figures"
            value={search.variant}
            onChange={(v) => set({ variant: v })}
            options={[
              { value: "verified", label: "Verified" },
              { value: "raw", label: "Before filtering" },
            ]}
          />
        }
      >
        <FilterBar
          search={search}
          set={set}
          rounds={rounds}
          shown={projects.data ? rows.length : null}
          total={projects.data ? all.length : null}
          placeholder="Find a project"
          rankMin={rankMin}
          minLabel="Minimum page views"
        />
        <OpQueryState
          query={projects}
          plain
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState plain title="No Stellar ecosystem projects match these filters">
              Try another SCF round, award type or category, or lower the verification level under
              More filters.
            </EmptyState>
          }
        >
          {() => (
            <WebProjectTable
              rows={rows}
              variant={search.variant}
              sort={sort}
              onSort={(s) => set({ sort: s })}
              picked={picked}
              onPick={(id) =>
                set({
                  ids: toggleId(picked, id, MAX_PICKS),
                  ...(picked.length <= 2 && picked.includes(id) ? { sbs: undefined } : {}),
                })
              }
            />
          )}
        </OpQueryState>
        <PickBar
          kind="projects"
          picked={picked.map((id) => ({
            id,
            name: all.find((r) => r.tenant_id === id)?.name ?? "Project",
          }))}
          onRemove={(id) =>
            set({
              ids: picked.filter((x) => x !== id),
              ...(picked.length <= 2 ? { sbs: undefined } : {}),
            })
          }
          onCompare={() => set({ sbs: true })}
        />
      </Card>
      {base ? (
        <div className="um-grid um-g21">
          <Breakdown
            base={base}
            variant={search.variant}
            dim={search.dim ?? "referrer"}
            onDim={(d) => set({ dim: d })}
          />
          <Verdicts base={base} />
        </div>
      ) : null}
    </>
  );
}

export function WebProjectTable({
  rows,
  variant,
  sort,
  onSort,
  picked,
  onPick,
}: {
  rows: Row[];
  variant: "verified" | "raw";
  sort: string;
  onSort: (s: string) => void;
  picked: string[];
  onPick: (id: string) => void;
}) {
  const full = picked.length >= MAX_PICKS;
  const th = (label: string, field: string, ascFirst = false, cls?: string) => (
    <SortTh
      label={label}
      field={field}
      sort={sort}
      onSort={onSort}
      ascFirst={ascFirst}
      {...(cls ? { className: cls } : {})}
    />
  );
  return (
    <TableScroll label="Projects" stickyFirst>
      <table className="um-table um-op-table" data-testid="web-projects">
        <thead>
          <tr className="um-op-grp">
            <td colSpan={3} />
            <th colSpan={7} className="um-op-gs">
              <span className="um-op-grp-l">
                <Icon name="globe" />
                Web · {variant === "raw" ? "before filtering" : "verified"}
              </span>
            </th>
          </tr>
          <tr>
            <th scope="col" className="um-op-c0">
              <span className="um-sr">Pick</span>
            </th>
            <SortTh
              label="Project"
              field="name"
              sort={sort}
              onSort={onSort}
              num={false}
              ascFirst
              className="um-op-c1"
            />
            <th scope="col">Level</th>
            {th("Page views", "pageviews", false, "um-op-gs")}
            {th("Change", "pageviews_change")}
            {th("Visitors", "visitors_sum")}
            {th("Bounce", "bounce_rate_pct", true)}
            {th("Avg visit", "avg_visit_duration_s")}
            {th("Suspect", "suspect_pageview_share", true)}
            {th("Trust", "trust_score_28d")}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="um-op-empty">
                No Stellar ecosystem projects match these filters.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const on = picked.includes(r.tenant_id);
              return (
                <tr
                  key={r.tenant_id}
                  className={on ? "um-op-picked" : undefined}
                  data-testid={`web-row-${r.slug}`}
                >
                  <td className="um-op-c0">
                    <input
                      type="checkbox"
                      className="um-op-cb"
                      checked={on}
                      disabled={!on && full}
                      title={!on && full ? `Up to ${MAX_PICKS}` : undefined}
                      aria-label={`Compare ${r.name}`}
                      onChange={() => onPick(r.tenant_id)}
                    />
                  </td>
                  <th scope="row" className="um-op-c1">
                    <PName sub={awardLine(r)}>
                      <Link to="/operator/tenants/$tenantId" params={{ tenantId: r.tenant_id }}>
                        {r.name}
                      </Link>
                    </PName>
                  </th>
                  <td>
                    <Lvl level={r.verification_level} />
                  </td>
                  <td className="um-r um-op-gs">
                    <Num value={r.pageviews} />
                  </td>
                  <td className="um-r">
                    <DeltaPill
                      pct={changePct(r.pageviews, r.pageviews_prev)}
                      label="against the previous window"
                    />
                  </td>
                  <td className="um-r">
                    <Num value={r.visitors_sum} />
                  </td>
                  <td className="um-r">
                    {r.bounce_rate_pct === null ? (
                      <NotAvailable why="No visits in this window." />
                    ) : (
                      `${Math.round(r.bounce_rate_pct)}%`
                    )}
                  </td>
                  <td className="um-r">
                    {r.avg_visit_duration_s === null ? (
                      <NotAvailable why="No visits in this window." />
                    ) : (
                      fmtMinSec(r.avg_visit_duration_s)
                    )}
                  </td>
                  <td className="um-r">
                    {r.suspect_pageview_share === null ? (
                      <NotAvailable why="No page views in this window." />
                    ) : (
                      fmtShareD(r.suspect_pageview_share)
                    )}
                  </td>
                  <td className="um-r">
                    <TrustCell score={r.trust_score_28d} />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function PickBar({
  kind,
  picked,
  onRemove,
  onCompare,
}: {
  kind: "projects" | "services";
  picked: { id: string; name: string }[];
  onRemove: (id: string) => void;
  onCompare: () => void;
}) {
  const n = picked.length;
  return (
    <div className="um-op-pickbar">
      {n === 0 ? (
        <p className="um-op-picks">
          Pick 2 to {MAX_PICKS} {kind} to compare them side by side.
        </p>
      ) : (
        <ul className="um-op-picks" aria-label={`Picked ${kind}`}>
          {picked.map((p, i) => (
            <li key={p.id} className="um-op-pk">
              <i className={`um-op-csw ${pickColorClass(i)}`} aria-hidden="true" />
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onRemove(p.id)}>
                <Icon name="x" />
              </button>
            </li>
          ))}
          {n < 2 ? <li>Pick {2 - n} more</li> : null}
        </ul>
      )}
      <Button variant="primary" size="sm" icon="columns" disabled={n < 2} onClick={onCompare}>
        Compare side by side
      </Button>
    </div>
  );
}

function best(vals: (number | null)[], v: number | null, higher: boolean) {
  const xs = vals.filter((x): x is number => x !== null);
  return v !== null && xs.length > 1 && v === (higher ? Math.max(...xs) : Math.min(...xs));
}

function MetricRow({
  k,
  v,
  all,
  shown,
  higher,
}: {
  k: string;
  v: number | null;
  all: (number | null)[];
  shown: string;
  higher: boolean;
}) {
  const mx = Math.max(0, ...all.filter((x): x is number => x !== null));
  const w = v === null || mx === 0 ? 0 : Math.max(2, (v / mx) * 100);
  return (
    <div className="um-op-mrow">
      <dt>{k}</dt>
      <dd className={best(all, v, higher) ? "um-op-best" : undefined}>
        {v === null ? "—" : shown}
      </dd>
      <svg className="um-op-mbar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
        <rect className="um-op-mbar-bg" x="0" y="0" width="100" height="4" />
        <rect className="um-op-mbar-f" x="0" y="0" width={w} height="4" />
      </svg>
    </div>
  );
}

function SideBySide({
  ids,
  rows,
  base,
  variant,
  onClose,
}: {
  ids: string[];
  rows: Row[];
  base: ReturnType<typeof filterQuery>;
  variant: "verified" | "raw";
  onClose: () => void;
}) {
  const q = { start: base.start, end: base.end, tenant_ids: ids, variant };
  const cmp = useQuery({
    queryKey: ["op-web-compare", q],
    queryFn: () => api.json("operatorWebCompare", { query: q }),
  });
  const countries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["op-web-breakdown", base.start, base.end, variant, "country", id],
      queryFn: () =>
        api.call("operatorWebBreakdown", {
          query: {
            start: base.start,
            end: base.end,
            min_level: "L0" as const,
            tenant_ids: [id],
            variant,
            dimension: "country" as const,
            limit: 4,
          },
        }),
    })),
  });
  const metrics = (r: Row | undefined, s: ControlPlane.OpWebDay[] | undefined) => {
    const t = s ? sumWebDays(s) : null;
    return {
      pageviews: t?.pageviews ?? r?.pageviews ?? null,
      visitors: t?.visitors_sum ?? r?.visitors_sum ?? null,
      bounce: t ? t.bounce_rate_pct : (r?.bounce_rate_pct ?? null),
      avg: t ? t.avg_visit_duration_s : (r?.avg_visit_duration_s ?? null),
      suspect: t ? t.suspect_pageview_share : (r?.suspect_pageview_share ?? null),
      trust: r?.trust_score_28d ?? null,
    };
  };
  const cards = ids.map((id, i) => {
    const r = rows.find((x) => x.tenant_id === id);
    const s = cmp.data?.series.find((x) => x.tenant_id === id);
    return { id, i, r, s, m: metrics(r, s?.days), name: r?.name ?? s?.slug ?? "Project" };
  });
  const col = (k: keyof ReturnType<typeof metrics>) => cards.map((c) => c.m[k]);
  return (
    <ScrollIntoView>
      <Card
        title="Side by side"
        data-testid="web-compare"
        actions={
          <Button variant="ghost" size="sm" icon="x" onClick={onClose}>
            Close
          </Button>
        }
      >
        <OpQueryState query={cmp} loading={<LoadingState block label="Loading the comparison…" />}>
          {(d) => (
            <div>
              <Legend
                items={cards.map((c) => ({ name: c.name, color: PICK_COLORS[c.i] ?? "#111111" }))}
              />
              <LineChart
                height={200}
                label={`Daily ${variant === "raw" ? "page views before filtering" : "verified page views"} of the picked projects`}
                days={d.series[0]?.days.map((x) => x.day) ?? []}
                series={cards.map((c) => ({
                  name: c.name,
                  color: PICK_COLORS[c.i] ?? "#111111",
                  values: c.s?.days.map((x) => x.pageviews) ?? [],
                }))}
              />
            </div>
          )}
        </OpQueryState>
        <div className="um-op-sbs-cols">
          {cards.map((c, k) => {
            const bd = countries[k];
            return (
              <section
                key={c.id}
                className={`um-op-sbs-card ${pickColorClass(c.i)}`}
                aria-label={c.name}
                data-testid={`cmp-${c.r?.slug ?? c.id}`}
              >
                <span className="um-op-sbs-bar" aria-hidden="true" />
                <div className="um-op-sbs-h">
                  <h3>
                    <i className={`um-op-csw ${pickColorClass(c.i)}`} aria-hidden="true" />
                    {c.name}
                  </h3>
                  <div className="um-op-meta">
                    {c.r ? <Lvl level={c.r.verification_level} /> : null}
                    {c.r ? awardLine(c.r) : null}
                  </div>
                </div>
                <dl className="um-op-mrows">
                  <MetricRow
                    k="Page views"
                    v={c.m.pageviews}
                    all={col("pageviews")}
                    shown={fmtCompact(c.m.pageviews)}
                    higher
                  />
                  <MetricRow
                    k="Visitors"
                    v={c.m.visitors}
                    all={col("visitors")}
                    shown={fmtCompact(c.m.visitors)}
                    higher
                  />
                  <MetricRow
                    k="Bounce rate"
                    v={c.m.bounce}
                    all={col("bounce")}
                    shown={`${Math.round(c.m.bounce ?? 0)}%`}
                    higher={false}
                  />
                  <MetricRow
                    k="Avg visit"
                    v={c.m.avg}
                    all={col("avg")}
                    shown={fmtMinSec(c.m.avg)}
                    higher
                  />
                  <MetricRow
                    k="Suspect share"
                    v={c.m.suspect}
                    all={col("suspect")}
                    shown={fmtShareD(c.m.suspect)}
                    higher={false}
                  />
                  <MetricRow
                    k="Trust score"
                    v={c.m.trust}
                    all={col("trust")}
                    shown={`${c.m.trust} / 100`}
                    higher
                  />
                  <div className="um-op-mrow um-op-mrow--h">
                    <dt className="um-label">Top countries · visitors</dt>
                    <dd />
                  </div>
                  {!bd || bd.isPending ? (
                    <div className="um-op-mrow">
                      <dt>Loading…</dt>
                      <dd />
                    </div>
                  ) : bd.error ? (
                    <div className="um-op-mrow">
                      <dt>Could not load the countries</dt>
                      <dd />
                    </div>
                  ) : (
                    <>
                      {(bd.data?.rows ?? []).map((row) => (
                        <div className="um-op-mrow" key={row.value}>
                          <dt>{countryName(row.value)}</dt>
                          <dd>{fmtCompact(row.visitors_sum)}</dd>
                        </div>
                      ))}
                      {(bd.data?.rows.length ?? 0) === 0 ? (
                        <div className="um-op-mrow">
                          <dt>No country at or above the privacy minimum</dt>
                          <dd>
                            <Hid min={bd.data?.privacy.min_count ?? 10} />
                          </dd>
                        </div>
                      ) : null}
                    </>
                  )}
                </dl>
              </section>
            );
          })}
        </div>
      </Card>
    </ScrollIntoView>
  );
}

const DIM_LABEL: Record<WebDim, string> = {
  referrer: "Referrer",
  country: "Country",
  device: "Device",
  browser: "Browser",
  os: "OS",
  path: "Path",
  event: "Event",
};

function Breakdown({
  base,
  variant,
  dim,
  onDim,
}: {
  base: ReturnType<typeof filterQuery>;
  variant: "verified" | "raw";
  dim: WebDim;
  onDim: (d: WebDim) => void;
}) {
  const bd = useQuery({
    queryKey: ["op-web-breakdown", base, variant, dim],
    queryFn: () =>
      api.call("operatorWebBreakdown", { query: { ...base, variant, dimension: dim, limit: 50 } }),
  });
  return (
    <Card
      title="Breakdown across projects"
      tone="web"
      data-testid="web-breakdown"
      actions={
        <Segmented
          label="Dimension"
          value={dim}
          onChange={onDim}
          options={WEB_DIMS.map((d) => ({ value: d, label: DIM_LABEL[d] }))}
        />
      }
    >
      <OpQueryState
        query={bd}
        isEmpty={(d) => d.rows.length === 0}
        empty={
          <EmptyState plain icon="eyeoff" title="No values at or above the privacy minimum">
            {bd.data
              ? `Values under ${bd.data.privacy.min_count} are hidden so they cannot point to one project or person.`
              : null}
          </EmptyState>
        }
      >
        {(d) => {
          const key = (r: (typeof d.rows)[number]) =>
            dim === "event" ? (r.events ?? 0) : (r.visitors_sum ?? 0);
          const agg = new Map<string, number>();
          for (const r of d.rows) agg.set(r.value, (agg.get(r.value) ?? 0) + key(r));
          const list = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
          const total = [...agg.values()].reduce((a, b) => a + b, 0);
          return (
            <>
              <BarList
                tint="web"
                head={[DIM_LABEL[dim], dim === "event" ? "Events" : "Visitors", "Share"]}
                rows={list.map(([v, n]) => ({
                  key: v,
                  label:
                    dim === "path" || dim === "event" ? (
                      <code>{v}</code>
                    ) : dim === "country" ? (
                      countryName(v)
                    ) : (
                      v
                    ),
                  value: n,
                  aside: total > 0 ? fmtShareD(n / total) : "—",
                }))}
              />
              <p className="um-op-hidden-n">
                <Icon name="eyeoff" size="sm" />
                {d.hidden_rows !== null && d.hidden_rows !== undefined
                  ? `${d.hidden_rows} values hidden (privacy minimum of ${d.privacy.min_count})`
                  : `Values under ${d.privacy.min_count} are hidden; figures rounded to ${d.privacy.round_to}`}
              </p>
            </>
          );
        }}
      </OpQueryState>
    </Card>
  );
}

/** Why traffic was filtered: the gateway's reason counters added up over every project (exact, no minimum). */
function Verdicts({ base }: { base: ReturnType<typeof filterQuery> }) {
  const v = useQuery({
    queryKey: ["op-web-verdicts", base],
    queryFn: () => api.call("operatorWebVerdicts", { query: base }),
  });
  return (
    <Card
      title="Why traffic was filtered"
      tone="chain"
      sub="In this window"
      data-testid="web-verdicts"
    >
      <OpQueryState
        query={v}
        isEmpty={(d) => !d.rows.some((r) => r.counter === "reason" && r.count > 0)}
        empty={<EmptyState plain icon="check" title="No filtered traffic in this window" />}
      >
        {(d) => {
          const agg = new Map<string, number>();
          for (const r of d.rows) {
            if (r.counter !== "reason") continue;
            const code = r.label.split(/[:/]/).pop() ?? r.label;
            agg.set(code, (agg.get(code) ?? 0) + r.count);
          }
          const list = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
          return (
            <>
              <BarList
                tint="chain"
                wrap
                rows={list.map(([code, n]) => ({
                  key: code,
                  label: webReasonText(code).replace(/\.$/, ""),
                  value: n,
                  hint: code,
                }))}
              />
              <p className="um-op-hint">
                Added up from every project’s daily verdicts. Verdict counts carry no privacy
                minimum, so nothing is hidden here.
              </p>
            </>
          );
        }}
      </OpQueryState>
    </Card>
  );
}

export { settingNumber };
