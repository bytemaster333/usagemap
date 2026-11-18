// SPDX-License-Identifier: Apache-2.0
// SCF-operator API analytics (operator.api-*; approved design 2026-11-20): ecosystem requests, server errors and latency,
// one row per service (sort any column; filter by SCF round, award type, category, name, level and trust band),
// 2–4 services side by side, requests per route of one service, and the status-code mix. API figures are
// self-reported telemetry: the same normalisation, route rules and windows apply to every project, but SCF cannot
// prove a project reported every request. Assurance (A0–A2) and the on-chain badge are indicators, never corrections.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Kpi,
  LoadingState,
  Note,
  TableScroll,
  Tag,
} from "../../components/ui/index.ts";
import { fmtMs } from "../../lib/apiFormat.ts";
import { previousSpan } from "../../lib/days.ts";
import { sumApiDays, usageFlag } from "../../lib/opAgg.ts";
import { filterQuery, SortTh, spanOf, toggleId, useOpSettings } from "./common.tsx";
import { FilterBar } from "./filters.tsx";
import {
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
  ScrollIntoView,
  Sel,
  StackBar,
  TopActions,
} from "./kit.tsx";
import {
  awardLine,
  changePct,
  fmtCompact,
  fmtShareD,
  MAX_PICKS,
  type OpSearch,
  PICK_COLORS,
  pickColorClass,
  sortBy,
} from "./model.ts";
import { PickBar, useOpWebNav } from "./OperatorWeb.tsx";

type SvcRow = ControlPlane.OpApiServiceRow;

export const ASSURANCE_TEXT: Record<"A0" | "A1" | "A2", string> = {
  A0: "A0 · reported only",
  A1: "A1 · signed by the project’s collector",
  A2: "A2 · also matched against the ledger",
};

const SELF_TIP =
  "API figures are telemetry each project sends about itself. UsageMap cannot prove they are genuine.";

export function SelfChip() {
  return <Chip kind="self" title={SELF_TIP} />;
}

export function OperatorApiPage() {
  useTitle("API");
  const { search, set } = useOpWebNav("/app/operator/api");
  const span = spanOf(search);
  const ok = !("error" in span);
  const base = ok ? filterQuery(search, span) : null;
  const prev = ok ? previousSpan(span) : null;
  const settings = useOpSettings();
  const rankMin =
    (settings.data?.find((s) => s.key === "op_rank_min_level")?.value as string) ?? "L1";
  const svcQuery = base
    ? {
        ...base,
        compare: "previous" as const,
        sort: "-requests" as const,
        ...(search.round ? { award_round: search.round } : {}),
        ...(search.stage ? { award_stage: search.stage } : {}),
        ...(search.cat ? { category: search.cat } : {}),
        ...(search.min ? { min_requests: search.min } : {}),
        limit: 200,
      }
    : null;
  const summary = useQuery({
    queryKey: ["op-api-summary", base],
    enabled: !!base,
    queryFn: () => api.json("operatorApiSummary", { query: base as NonNullable<typeof base> }),
  });
  const summaryPrev = useQuery({
    queryKey: ["op-api-summary", base, "prev"],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorApiSummary", {
        query: { ...(base as NonNullable<typeof base>), ...(prev as NonNullable<typeof prev>) },
      }),
  });
  const services = useQuery({
    queryKey: ["op-api-services", svcQuery],
    enabled: !!svcQuery,
    queryFn: () =>
      api.json("operatorApiServices", { query: svcQuery as NonNullable<typeof svcQuery> }),
  });
  const allRows = useQuery({
    queryKey: ["op-api-services", "rounds", base],
    enabled: !!base,
    queryFn: () =>
      api.json("operatorApiServices", {
        query: { ...(base as NonNullable<typeof base>), limit: 200 },
      }),
    staleTime: 60_000,
  });
  const rounds = [
    ...new Set((allRows.data?.items ?? []).flatMap((r) => (r.award_round ? [r.award_round] : []))),
  ].sort((a, b) => b - a);
  const t = summary.data ? sumApiDays(summary.data.days) : null;
  const tp = summaryPrev.data ? sumApiDays(summaryPrev.data.days) : null;
  const lastDay = summary.data
    ? [...summary.data.days].reverse().find((d) => d.requests > 0)
    : undefined;
  const all = services.data?.items ?? [];
  const sort = search.sort ?? "-requests";
  const q = (search.q ?? "").toLowerCase();
  const rows = sortBy(
    all.filter((r) => !q || r.service_name.toLowerCase().includes(q) || r.slug.includes(q)),
    sort,
    (r, k) =>
      k === "name"
        ? r.service_name.toLowerCase()
        : k === "requests_change"
          ? changePct(r.requests, r.requests_prev)
          : (r as unknown as Record<string, number | string | null>)[k],
  );
  const days = ok ? span.days : 0;
  const activeAvg = all.length
    ? all.reduce((a, r) => a + (r.active_days ?? 0), 0) / all.length
    : null;
  const picked = search.ids;
  const pickedRows = picked
    .map((id) => all.find((r) => r.service_id === id))
    .filter((r): r is SvcRow => !!r);

  return (
    <>
      <TopActions
        range={search.range}
        onRange={(r) => set({ range: r, from: undefined, to: undefined })}
        csv={
          svcQuery
            ? {
                file: "scf-api-services.csv",
                fetch: () => api.csv("operatorApiServices", { query: svcQuery }),
              }
            : undefined
        }
      />
      <OpIntro
        title="API"
        lead="API usage each Stellar ecosystem project reports through its collector. Sort any column, pick services to compare, or open a service’s routes."
        aside={<PrivacyFloor privacy={services.data?.privacy} />}
      />
      {!ok ? <ErrorState error={new Error(span.error)} /> : null}
      <div className="um-grid um-g4 um-op-kg2">
        <Kpi
          tone="api"
          icon="server"
          label="Requests"
          chip="self"
          loading={summary.isPending}
          value={t ? fmtCompact(t.requests) : null}
          delta={
            t && tp ? deltaProps(t.requests, tp.requests, "against the previous window") : undefined
          }
          foot="vs previous window"
          testId="eco-requests"
          {...kpiErr(summary)}
        />
        <Kpi
          tone="api"
          icon="alert"
          label="Server errors (5xx)"
          loading={summary.isPending}
          value={t?.error_rate_5xx === null || !t ? null : fmtShareD(t.error_rate_5xx, 2)}
          delta={
            t && tp
              ? deltaProps(t.error_rate_5xx, tp.error_rate_5xx, "against the previous window")
              : undefined
          }
          foot={t ? `${fmtCompact(t.s5xx)} requests · lower is better` : undefined}
          testId="eco-5xx"
          {...kpiErr(summary)}
        />
        <Kpi
          tone="api"
          icon="clock"
          label="p95 latency"
          loading={summary.isPending}
          value={
            lastDay?.p95_ms === null || !lastDay
              ? null
              : fmtMs(lastDay.p95_ms, lastDay.accuracy_class)
          }
          foot={
            lastDay
              ? `Latest day with traffic, ${lastDay.day.slice(5)} · merged across services`
              : undefined
          }
          testId="eco-p95"
          {...kpiErr(summary)}
        />
        <Kpi
          tone="neutral"
          icon="activity"
          label="Days with traffic"
          loading={services.isPending}
          value={activeAvg === null ? null : activeAvg.toFixed(1)}
          foot={`Average per service, of ${days}`}
          testId="eco-active"
          {...kpiErr(services)}
        />
      </div>
      {search.sbs && pickedRows.length >= 2 && base ? (
        <ApiSideBySide rows={pickedRows} base={base} onClose={() => set({ sbs: undefined })} />
      ) : null}
      <Card title="Services" flush className="um-op-card-flush um-op-cmp" actions={<SelfChip />}>
        <FilterBar
          search={search}
          set={set}
          rounds={rounds}
          shown={services.data ? rows.length : null}
          total={services.data ? all.length : null}
          placeholder="Project or service"
          rankMin={rankMin}
          minLabel="Minimum requests"
        />
        <OpQueryState
          query={services}
          plain
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState plain title="No services match these filters">
              Stellar ecosystem projects appear here once their collector sends API telemetry.
            </EmptyState>
          }
        >
          {() => (
            <ApiServiceTable
              rows={rows}
              days={days}
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
          kind="services"
          picked={picked.map((id) => ({
            id,
            name: all.find((r) => r.service_id === id)?.service_name ?? "Service",
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
          <Routes base={base} services={all} svc={search.svc} onSvc={(s) => set({ svc: s })} />
          <Card
            title="Status codes, all services"
            tone="api"
            actions={<SelfChip />}
            data-testid="api-status"
          >
            <OpQueryState
              query={summary}
              isEmpty={(d) => sumApiDays(d.days).requests === 0}
              empty={<EmptyState plain title="No requests in this window" />}
            >
              {(d) => {
                const s = d.days.reduce(
                  (a, x) => ({
                    s2: a.s2 + (x.s2xx ?? 0),
                    s3: a.s3 + (x.s3xx ?? 0),
                    s4: a.s4 + (x.s4xx ?? 0),
                    s5: a.s5 + (x.s5xx ?? 0),
                    r: a.r + x.requests,
                  }),
                  { s2: 0, s3: 0, s4: 0, s5: 0, r: 0 },
                );
                const sh = (n: number) => fmtShareD(s.r ? n / s.r : null);
                return (
                  <>
                    <StackBar
                      label="Status codes"
                      parts={[
                        {
                          key: "2xx",
                          value: s.s2,
                          cls: "um-op-f-good",
                          label: "2xx",
                          shown: sh(s.s2),
                        },
                        {
                          key: "3xx",
                          value: s.s3,
                          cls: "um-op-f-3xx",
                          label: "3xx",
                          shown: sh(s.s3),
                        },
                        {
                          key: "4xx",
                          value: s.s4,
                          cls: "um-op-f-low",
                          label: "4xx",
                          shown: sh(s.s4),
                        },
                        {
                          key: "5xx",
                          value: s.s5,
                          cls: "um-op-f-bad",
                          label: "5xx",
                          shown: sh(s.s5),
                        },
                      ]}
                    />
                    <p className="um-op-hint">
                      {fmtCompact(s.r)} requests from {all.length} services. Latency percentiles
                      come from merged histograms; each service states its accuracy.
                    </p>
                  </>
                );
              }}
            </OpQueryState>
          </Card>
        </div>
      ) : null}
    </>
  );
}

const FLAG_TEXT = {
  highest: "highest volume",
  inactive: "no requests in range",
  low: "active on few days",
} as const;

function UsageFlag({ flag, name }: { flag: keyof typeof FLAG_TEXT | null; name: string }) {
  if (!flag) return null;
  return (
    <span
      className={flag === "highest" ? "um-op-uflag um-op-uflag--top" : "um-op-uflag"}
      data-testid={`flag-${name}`}
    >
      {FLAG_TEXT[flag]}
    </span>
  );
}

export function ApiServiceTable({
  rows,
  days,
  sort,
  onSort,
  picked,
  onPick,
}: {
  rows: SvcRow[];
  days: number;
  sort: string;
  onSort: (s: string) => void;
  picked: string[];
  onPick: (id: string) => void;
}) {
  const full = picked.length >= MAX_PICKS;
  const maxReq = Math.max(0, ...rows.map((r) => r.requests));
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
    <TableScroll label="Services" stickyFirst>
      <table className="um-table um-op-table" data-testid="api-services">
        <thead>
          <tr className="um-op-grp">
            <td colSpan={3} />
            <th colSpan={7} className="um-op-gs">
              <span className="um-op-grp-l">
                <Icon name="server" />
                API · self-reported
              </span>
            </th>
          </tr>
          <tr>
            <th scope="col" className="um-op-c0">
              <span className="um-sr">Pick</span>
            </th>
            <SortTh
              label="Service"
              field="name"
              sort={sort}
              onSort={onSort}
              num={false}
              ascFirst
              className="um-op-c1"
            />
            <th scope="col">Level</th>
            {th("Requests", "requests", false, "um-op-gs")}
            {th("Change", "requests_change")}
            {th("5xx rate", "error_rate_5xx", true)}
            {th("p50", "p50_ms", true)}
            {th("p95", "p95_ms", true)}
            {th("Active days", "active_days")}
            <th scope="col">Assurance</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="um-op-empty">
                No services match these filters.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const on = picked.includes(r.service_id);
              return (
                <tr
                  key={r.service_id}
                  className={on ? "um-op-picked" : undefined}
                  data-testid={`api-row-${r.service_name}`}
                >
                  <td className="um-op-c0">
                    <input
                      type="checkbox"
                      className="um-op-cb"
                      checked={on}
                      disabled={!on && full}
                      aria-label={`Compare ${r.service_name} (${r.slug})`}
                      onChange={() => onPick(r.service_id)}
                    />
                  </td>
                  <th scope="row" className="um-op-c1">
                    <PName sub={`${r.slug} · ${awardLine(r)}`}>
                      <b>
                        {r.service_name}
                        <UsageFlag flag={usageFlag(r, maxReq, days)} name={r.service_name} />
                      </b>
                    </PName>
                  </th>
                  <td>
                    <Lvl level={r.verification_level} />
                  </td>
                  <td className="um-r um-op-gs">
                    <Num value={r.requests} />
                  </td>
                  <td className="um-r">
                    <DeltaPill
                      pct={changePct(r.requests, r.requests_prev)}
                      label="against the previous window"
                    />
                  </td>
                  <td className="um-r">{fmtShareD(r.error_rate_5xx, 2)}</td>
                  <td className="um-r">{fmtMs(r.p50_ms, r.accuracy_class)}</td>
                  <td className="um-r">{fmtMs(r.p95_ms, r.accuracy_class)}</td>
                  <td className="um-r">
                    {r.active_days === undefined ? "—" : `${r.active_days} / ${days}`}
                  </td>
                  <td>
                    <span className="um-op-flags">
                      {r.assurance_level ? (
                        <span title={ASSURANCE_TEXT[r.assurance_level]}>
                          <Tag>{r.assurance_level}</Tag>
                        </span>
                      ) : (
                        <span className="um-op-na" title="Not assessed yet">
                          —
                        </span>
                      )}
                      {r.onchain_badge === "inconsistent" ? (
                        <span
                          className="um-op-chip-org"
                          title="Reported API activity does not match what the ledger shows for this project."
                        >
                          <Icon name="chain" />
                          On-chain mismatch
                        </span>
                      ) : r.onchain_badge === "consistent" ? (
                        <Chip kind="ledger" title="Reported API activity matches the ledger.">
                          On-chain
                        </Chip>
                      ) : null}
                    </span>
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

function ApiSideBySide({
  rows,
  base,
  onClose,
}: {
  rows: SvcRow[];
  base: ReturnType<typeof filterQuery>;
  onClose: () => void;
}) {
  const tenants = [...new Set(rows.map((r) => r.tenant_id))];
  const q = { start: base.start, end: base.end, tenant_ids: tenants };
  const cmp = useQuery({
    queryKey: ["op-api-compare", q],
    enabled: tenants.length >= 2,
    queryFn: () => api.json("operatorApiCompare", { query: q }),
  });
  const M: {
    k: string;
    f: (r: SvcRow) => number | null | undefined;
    show: (r: SvcRow) => string;
    higher: boolean;
  }[] = [
    { k: "Requests", f: (r) => r.requests, show: (r) => fmtCompact(r.requests), higher: true },
    {
      k: "5xx rate",
      f: (r) => r.error_rate_5xx,
      show: (r) => fmtShareD(r.error_rate_5xx, 2),
      higher: false,
    },
    { k: "p50", f: (r) => r.p50_ms, show: (r) => fmtMs(r.p50_ms, r.accuracy_class), higher: false },
    { k: "p95", f: (r) => r.p95_ms, show: (r) => fmtMs(r.p95_ms, r.accuracy_class), higher: false },
    { k: "p99", f: (r) => r.p99_ms, show: (r) => fmtMs(r.p99_ms, r.accuracy_class), higher: false },
    {
      k: "Active days",
      f: (r) => r.active_days,
      show: (r) => String(r.active_days ?? "—"),
      higher: true,
    },
  ];
  return (
    <ScrollIntoView>
      <Card
        title="Side by side"
        data-testid="api-compare"
        actions={
          <span className="um-op-btns">
            <SelfChip />
            <Button variant="ghost" size="sm" icon="x" onClick={onClose}>
              Close
            </Button>
          </span>
        }
      >
        {tenants.length >= 2 ? (
          <OpQueryState query={cmp} loading={<LoadingState block />}>
            {(d) => (
              <div>
                <Legend
                  items={d.series.map((s, i) => ({
                    name: s.slug,
                    color: PICK_COLORS[i] ?? "#111111",
                  }))}
                />
                <LineChart
                  height={200}
                  label="Daily requests of the picked services’ projects"
                  days={d.series[0]?.days.map((x) => x.day) ?? []}
                  series={d.series.map((s, i) => ({
                    name: s.slug,
                    color: PICK_COLORS[i] ?? "#111111",
                    values: s.days.map((x) => x.requests),
                  }))}
                />
              </div>
            )}
          </OpQueryState>
        ) : (
          <Note>
            The picked services belong to one project, so there is no per-project chart; their
            figures follow.
          </Note>
        )}
        <div className="um-op-sbs-cols">
          {rows.map((r, i) => (
            <section
              key={r.service_id}
              className={`um-op-sbs-card ${pickColorClass(i)}`}
              aria-label={r.service_name}
              data-testid={`acmp-${r.slug}`}
            >
              <span className="um-op-sbs-bar" aria-hidden="true" />
              <div className="um-op-sbs-h">
                <h3>
                  <i className={`um-op-csw ${pickColorClass(i)}`} aria-hidden="true" />
                  {r.service_name}
                </h3>
                <div className="um-op-meta">
                  <Lvl level={r.verification_level} />
                  {r.slug} · {awardLine(r)}
                </div>
              </div>
              <dl className="um-op-mrows">
                {M.map((m) => {
                  const vals = rows.map((x) => m.f(x) ?? null);
                  const v = m.f(r) ?? null;
                  const xs = vals.filter((x): x is number => x !== null);
                  const best =
                    v !== null &&
                    xs.length > 1 &&
                    v === (m.higher ? Math.max(...xs) : Math.min(...xs));
                  const mx = Math.max(0, ...xs);
                  return (
                    <div className="um-op-mrow" key={m.k}>
                      <dt>{m.k}</dt>
                      <dd className={best ? "um-op-best" : undefined}>
                        {v === null ? "—" : m.show(r)}
                      </dd>
                      <svg
                        className="um-op-mbar"
                        viewBox="0 0 100 4"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <rect className="um-op-mbar-bg" x="0" y="0" width="100" height="4" />
                        <rect
                          className="um-op-mbar-f"
                          x="0"
                          y="0"
                          width={v === null || !mx ? 0 : Math.max(2, (v / mx) * 100)}
                          height="4"
                        />
                      </svg>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}
        </div>
      </Card>
    </ScrollIntoView>
  );
}

function Routes({
  base,
  services,
  svc,
  onSvc,
}: {
  base: ReturnType<typeof filterQuery>;
  services: SvcRow[];
  svc: string | undefined;
  onSvc: (id: string) => void;
}) {
  const s = services.find((x) => x.service_id === svc) ?? services[0];
  const q = s
    ? {
        start: base.start,
        end: base.end,
        tenant_id: s.tenant_id,
        service_id: s.service_id,
        limit: 50,
      }
    : null;
  const routes = useQuery({
    queryKey: ["op-api-routes", q],
    enabled: !!q,
    queryFn: () => api.call("operatorApiRoutes", { query: q as NonNullable<typeof q> }),
  });
  return (
    <Card
      title="Requests per route"
      tone="api"
      flush
      className="um-op-card-flush"
      data-testid="op-routes"
      actions={
        services.length ? (
          <Sel label="Service" value={s?.service_id ?? ""} onChange={onSvc}>
            {services.map((x) => (
              <option key={x.service_id} value={x.service_id}>
                {x.service_name} · {x.slug}
              </option>
            ))}
          </Sel>
        ) : null
      }
    >
      {!s ? (
        <EmptyState plain title="No services in this window" />
      ) : (
        <OpQueryState
          query={routes}
          plain
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState plain title="No routes reported for this service" />}
        >
          {(d) => (
            <TableScroll label="Routes">
              <table className="um-table um-op-table">
                <thead>
                  <tr>
                    <th scope="col">Route</th>
                    <th scope="col" className="um-r">
                      Requests
                    </th>
                    <th scope="col" className="um-r">
                      5xx
                    </th>
                    <th scope="col" className="um-r">
                      p95
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={`${r.route} ${r.rpc_method ?? ""}`}>
                      <td>
                        <code>{r.route}</code> {r.rpc_method ? <Tag>{r.rpc_method}</Tag> : null}
                      </td>
                      <td className="um-r">
                        <Num value={r.requests} />
                      </td>
                      <td className="um-r">{fmtShareD(r.error_rate_5xx, 2)}</td>
                      <td className="um-r">{fmtMs(r.p95_ms, r.accuracy_class)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </OpQueryState>
      )}
      {s ? (
        <p className="um-op-hint um-op-pad">
          <Link
            to="/operator/tenants/$tenantId"
            params={{ tenantId: s.tenant_id }}
            className="um-link"
          >
            Open {s.slug}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

export type { OpSearch };
