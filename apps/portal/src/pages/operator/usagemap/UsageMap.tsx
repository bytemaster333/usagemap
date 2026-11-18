// SPDX-License-Identifier: Apache-2.0
// SCF operator: the Ecosystem Usage Map (operatorUsageMap, audited) — on-chain usage of every registry project that
// lists contract ids, computed from the public Stellar ledger files whether or not the project uses UsageMap. Sortable
// by every figure, filterable by network, claim status, category, round and name, a sparkline per project, CSV of the
// filtered list. Unclaimed projects are public chain data whose ownership nobody has proven: the page says so and never
// shows them anywhere public. Distinct-account figures under the minimum count come back null and show as hidden.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../../../api/client.ts";
import { useTitle } from "../../../components/AppShell.tsx";
import {
  Card,
  Chip,
  EmptyState,
  Kpi,
  Note,
  QueryState,
  Segmented,
  StatusBadge,
  TableScroll,
} from "../../../components/ui/index.ts";
import { presetSpan } from "../../../lib/days.ts";
import { SortTh } from "../common.tsx";
import { DeltaPill, Hid, Num, OpIntro, PName, SearchBox, Sel, Spark, TopActions } from "../kit.tsx";
import { CATEGORY_SHORT, fmtCompact, fmtShareD } from "../model.ts";
import {
  CATEGORIES,
  nextSort,
  roundsOf,
  type SortKey,
  STATUS_TEXT,
  STATUSES,
  sortUsage,
  type UsageMapSearch,
  type UsageStatus,
  waaChange,
  withSearch,
} from "./model.ts";

export function fmtChange(r: number | null): string {
  if (r === null) return "—";
  const p = Math.round(r * 1000) / 10;
  return `${p > 0 ? "+" : ""}${p}%`;
}

export const STATUS_KIND: Record<UsageStatus, "off" | "wait" | "live"> = {
  unclaimed: "off",
  claimed: "wait",
  verified: "live",
};
export const STATUS_TIP: Record<UsageStatus, string> = {
  unclaimed: "Listed in the SCF registry; nobody has claimed it in UsageMap yet.",
  claimed: "A project team claimed it; contract ownership not proven yet.",
  verified: "The team proved it controls these contracts.",
};

export function UsageMapPage() {
  useTitle("Usage map");
  const search = useSearch({ from: "/app/operator/usage-map" }) as UsageMapSearch;
  const navigate = useNavigate();
  const span = presetSpan(search.range);
  const set = (s: Parameters<typeof withSearch>[1]) =>
    void navigate({ to: "/operator/usage-map", search: withSearch(search, s), replace: true });
  const query = {
    start: span.start,
    end: span.end,
    ...(search.network ? { network: search.network } : {}),
    ...(search.round ? { round: search.round } : {}),
    ...(search.category ? { category: search.category } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(search.q ? { q: search.q } : {}),
    ...(search.awarded ? { awarded_only: true } : {}),
    ...(search.active ? { active_only: true } : {}),
  };
  const list = useQuery({
    queryKey: ["op-usage-map", query],
    queryFn: () => api.json("operatorUsageMap", { query }),
  });
  // Round options come from the unfiltered list of the same window, so choosing one never hides the others.
  const all = useQuery({
    queryKey: ["op-usage-map-rounds", span.start, span.end, search.network ?? null],
    queryFn: () =>
      api.json("operatorUsageMap", {
        query: {
          start: span.start,
          end: span.end,
          ...(search.network ? { network: search.network } : {}),
        },
      }),
  });
  const d = list.data;
  const rows = d ? sortUsage(d.items, search.sort, search.dir) : [];
  const rounds = all.data ? roundsOf(all.data.items) : [];
  const sortStr = `${search.dir === "desc" ? "-" : ""}${search.sort}`;
  const onSort = (s: string) => {
    const k = s.replace(/^-/, "") as SortKey;
    set(nextSort(search, k));
  };
  const th = (label: string, k: SortKey) => (
    <SortTh label={label} field={k} sort={sortStr} onSort={onSort} />
  );
  const network = d?.network ?? search.network ?? "mainnet";
  return (
    <>
      <TopActions
        range={search.range}
        onRange={(r) => set({ range: r })}
        csv={{
          file: `usage-map-${span.start.slice(0, 10)}.csv`,
          fetch: () => api.csv("operatorUsageMap", { query }),
        }}
      />
      <OpIntro
        title="Usage map"
        lead="Contract activity of every SCF-registry project, read from public ledger data. It works before a project enrols."
        aside={
          <span data-testid="usage-map-caveat">
            <Chip kind="ledger">Public chain data · ownership not verified unless marked</Chip>
          </span>
        }
      />
      <div className="um-grid um-g4 um-op-kg2" data-testid="usage-map-totals">
        <Kpi
          tone="chain"
          icon="map"
          label="Projects with contracts"
          loading={list.isPending}
          value={d ? fmtCompact(d.totals.projects) : null}
          foot={d ? `${d.totals.unclaimed} unclaimed · ${d.totals.claimed} claimed` : undefined}
        />
        <Kpi
          tone="chain"
          icon="activity"
          label="Active in the window"
          loading={list.isPending}
          value={d ? fmtCompact(d.totals.active) : null}
          foot="At least one successful call"
        />
        <Kpi
          tone="chain"
          icon="coins"
          label="Contract invocations"
          loading={list.isPending}
          value={d ? fmtCompact(d.items.reduce((a, i) => a + i.invocations, 0)) : null}
          foot="Listed projects, this window"
        />
        <Kpi
          tone="chain"
          icon="check"
          label="Verified projects"
          loading={list.isPending}
          value={d ? fmtCompact(d.totals.verified) : null}
          foot="Proved they control a listed contract"
          testId="usage-map-verified"
        />
      </div>
      <Card
        title="Projects"
        flush
        className="um-op-card-flush"
        actions={
          <Segmented
            label="Network"
            value={network}
            onChange={(n) => set({ network: n })}
            options={[
              { value: "mainnet", label: "Mainnet" },
              { value: "testnet", label: "Testnet" },
            ]}
          />
        }
      >
        <div className="um-op-filters">
          <Sel
            label="Claim status"
            value={search.status ?? ""}
            onChange={(v) => set({ status: (v || undefined) as UsageStatus | undefined })}
          >
            <option value="">Any claim status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_TEXT[s]}
              </option>
            ))}
          </Sel>
          <Sel
            label="Category"
            value={search.category ?? ""}
            onChange={(v) => set({ category: (v || undefined) as UsageMapSearch["category"] })}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_SHORT[c]}
              </option>
            ))}
          </Sel>
          <Sel
            label="SCF round"
            value={search.round ? String(search.round) : ""}
            onChange={(v) => set({ round: v ? Number(v) : undefined })}
          >
            <option value="">All SCF rounds</option>
            {rounds.map((r) => (
              <option key={r} value={r}>
                Round {r}
              </option>
            ))}
          </Sel>
          <SearchBox
            value={search.q ?? ""}
            onChange={(v) => set({ q: v || undefined })}
            placeholder="Project name"
            label="Project name"
          />
          <span className="um-op-grow" />
          {d ? <span className="um-op-fcount">{rows.length} projects</span> : null}
        </div>
        <QueryState
          query={list}
          plain
          isEmpty={(x) => x.items.length === 0}
          empty={
            <EmptyState plain title="No projects match">
              No registry project with listed contracts matches these filters on {network}.
            </EmptyState>
          }
        >
          {(x) => (
            <TableScroll label="Usage map projects" stickyFirst>
              <table className="um-table um-op-table" data-testid="usage-map-table">
                <thead>
                  <tr>
                    <SortTh
                      label="Project"
                      field="name"
                      sort={sortStr}
                      onSort={onSort}
                      num={false}
                    />
                    <th scope="col">Status</th>
                    <th scope="col" className="um-r">
                      Contracts
                    </th>
                    {th("Invocations", "invocations")}
                    {th("Success", "success_rate")}
                    {th("Weekly active", "waa")}
                    {th("Change", "waa_change")}
                    <th scope="col">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr
                      key={i.registry_project_id}
                      data-testid={`usage-row-${i.registry_project_id}`}
                    >
                      <th scope="row">
                        <PName
                          sub={
                            [
                              i.award_round !== null ? `Round ${i.award_round}` : null,
                              i.categories[0] ? CATEGORY_SHORT[i.categories[0]] : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "No SCF award on record"
                          }
                        >
                          <Link
                            to="/operator/usage-map/$registryProjectId"
                            params={{ registryProjectId: i.registry_project_id }}
                            search={{
                              range: search.range,
                              ...(search.network ? { network: search.network } : {}),
                            }}
                          >
                            {i.name}
                          </Link>
                        </PName>
                      </th>
                      <td>
                        <span title={STATUS_TIP[i.status]}>
                          <StatusBadge status={STATUS_KIND[i.status]}>
                            {STATUS_TEXT[i.status]}
                          </StatusBadge>
                        </span>
                      </td>
                      <td
                        className="um-r"
                        title={`${i.contracts_verified} of ${i.contracts_listed} listed contracts verified`}
                      >
                        {i.contracts_verified}/{i.contracts_listed}
                      </td>
                      <td className="um-r">
                        <Num value={i.invocations} />
                      </td>
                      <td className="um-r">{fmtShareD(i.success_rate)}</td>
                      <td className="um-r">
                        {i.weekly_active_accounts === null ? (
                          <Hid min={x.min_count} />
                        ) : (
                          <Num value={i.weekly_active_accounts} />
                        )}
                      </td>
                      <td className="um-r">
                        {(() => {
                          const c = waaChange(i);
                          return (
                            <DeltaPill
                              pct={c === null ? null : c * 100}
                              label="against the previous week"
                            />
                          );
                        })()}
                      </td>
                      <td>
                        <Spark
                          values={i.daily_invocations}
                          days={x.days}
                          label={`Daily invocations of ${i.name}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </QueryState>
      </Card>
      {d ? (
        <Note tone="warn" icon="alert">
          <b>How these figures are counted.</b> Invocations are calls to contracts listed for the
          project. Calls from other contracts (made by other contracts, not by accounts directly)
          are a lower bound. Weekly active accounts are distinct invoking accounts; values under{" "}
          {d.min_count} are hidden. Source: {d.source}.
        </Note>
      ) : null}
    </>
  );
}
