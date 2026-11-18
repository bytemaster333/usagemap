// SPDX-License-Identifier: Apache-2.0
// SCF operator: one registry project in the Ecosystem Usage Map (operatorUsageMapProject, audited) — daily
// invocations, weekly active accounts (SCF Growth Hack definition), the listed contracts with whether the claimant
// proved them, and calls per contract function by caller kind (account: top-level invocations; contract: calls by
// other contracts, a lower bound).

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { api } from "../../../api/client.ts";
import { useTitle } from "../../../components/AppShell.tsx";
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Kpi,
  LoadingState,
  StatusBadge,
  TableScroll,
  Tag,
} from "../../../components/ui/index.ts";
import { DAY_PRESETS, type DayPreset, presetSpan } from "../../../lib/days.ts";
import { Hid, Legend, LineChart, Num, PName, TopActions } from "../kit.tsx";
import { CATEGORY_SHORT, fmtCompact, fmtShareD } from "../model.ts";
import { STATUS_TEXT, shortContract } from "./model.ts";
import { STATUS_KIND } from "./UsageMap.tsx";

export interface UsageProjectSearch {
  range: DayPreset;
  network?: "mainnet" | "testnet";
}

export function parseUsageProjectSearch(s: Record<string, unknown>): UsageProjectSearch {
  const out: UsageProjectSearch = {
    range: (DAY_PRESETS as readonly unknown[]).includes(s.range) ? (s.range as DayPreset) : "30d",
  };
  if (s.network === "mainnet" || s.network === "testnet") out.network = s.network;
  return out;
}

export function UsageMapProjectPage() {
  const { registryProjectId } = useParams({ from: "/app/operator/usage-map/$registryProjectId" });
  const search = useSearch({
    from: "/app/operator/usage-map/$registryProjectId",
  }) as UsageProjectSearch;
  const navigate = useNavigate();
  const span = presetSpan(search.range);
  const q = useQuery({
    queryKey: [
      "op-usage-map-project",
      registryProjectId,
      span.start,
      span.end,
      search.network ?? null,
    ],
    queryFn: () =>
      api.call("operatorUsageMapProject", {
        path: { registryProjectId },
        query: {
          start: span.start,
          end: span.end,
          ...(search.network ? { network: search.network } : {}),
        },
      }),
  });
  const d = q.data;
  useTitle(d ? `${d.project.name} · Usage map` : "Usage map");
  const total = d ? d.daily.reduce((a, x) => a + x.invocations, 0) : 0;
  const calls = d ? d.daily.reduce((a, x) => a + x.contract_calls, 0) : 0;
  const nDays = d ? d.daily.length : 0;
  const share = (n: number) => (total > 0 ? fmtShareD(n / total, 0) : "—");
  return (
    <>
      <TopActions
        range={search.range}
        onRange={(r) =>
          void navigate({
            to: "/operator/usage-map/$registryProjectId",
            params: { registryProjectId },
            search: { ...search, range: r },
            replace: true,
          })
        }
      />
      <Link
        to="/operator/usage-map"
        search={{
          range: search.range,
          sort: "invocations",
          dir: "desc",
          awarded: false,
          active: false,
        }}
        className="um-op-back"
      >
        <Icon name="left" />
        Usage map
      </Link>
      {q.isPending ? (
        <LoadingState label="Loading the project…" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : d ? (
        <>
          <div className="um-op-dhead">
            <span className="um-op-dtile um-op-tile-y" aria-hidden="true">
              {d.project.name.slice(0, 1)}
            </span>
            <div>
              <h1 className="um-h1">{d.project.name}</h1>
              <div className="um-op-dmeta" data-testid="usage-project-status">
                <span title={d.label}>
                  <StatusBadge status={STATUS_KIND[d.status]}>{STATUS_TEXT[d.status]}</StatusBadge>
                </span>
                {[
                  d.project.award_round !== null ? `Round ${d.project.award_round}` : null,
                  d.project.categories[0] ? CATEGORY_SHORT[d.project.categories[0]] : null,
                  d.network === "mainnet" ? "Mainnet" : "Testnet",
                  d.project.sources.length ? `sources: ${d.project.sources.join(", ")}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </div>
          <div className="um-grid um-g4 um-op-kg2">
            <Kpi
              tone="chain"
              icon="coins"
              label="Invocations"
              value={fmtCompact(total)}
              foot="Calls to listed contracts"
            />
            <Kpi
              tone="chain"
              icon="check"
              label="Success rate"
              value={d.success_rate === null ? null : fmtShareD(d.success_rate)}
              foot="Successful of all calls"
            />
            <Kpi
              tone="chain"
              icon="chain"
              label={
                <span title="Calls to the listed contracts made by other contracts (not by accounts directly). A lower bound: some routed calls are not seen.">
                  Calls from other contracts
                </span>
              }
              value={fmtCompact(calls)}
              foot="Made by other contracts · lower bound"
            />
            <Kpi
              tone="chain"
              icon="clock"
              label="Days covered"
              value={String(d.days_covered)}
              foot={`of ${nDays} in the window`}
            />
          </div>
          <Card
            title="Daily invocations"
            tone="chain"
            actions={<Legend items={[{ name: "Invocations", color: "#c9a000" }]} />}
          >
            {d.daily.length === 0 ? (
              <EmptyState plain title="No ledger days computed in this window" />
            ) : (
              <LineChart
                label={`Daily invocations of ${d.project.name}`}
                days={d.daily.map((x) => x.day)}
                series={[
                  {
                    name: "Invocations",
                    color: "#c9a000",
                    area: true,
                    values: d.daily.map((x) => x.invocations),
                  },
                ]}
              />
            )}
          </Card>
          <div className="um-grid um-g2">
            <Card title="Listed contracts" flush className="um-op-card-flush">
              {d.contracts.length === 0 ? (
                <EmptyState plain title="No contracts listed" />
              ) : (
                <TableScroll label="Listed contracts">
                  <table className="um-table um-op-table" data-testid="usage-project-contracts">
                    <thead>
                      <tr>
                        <th scope="col">Contract</th>
                        <th scope="col">Ownership</th>
                        <th scope="col" className="um-r">
                          Invocations
                        </th>
                        <th scope="col" className="um-r">
                          Share of calls
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.contracts.map((c) => (
                        <tr key={c.contract_id}>
                          <td>
                            <PName sub={`${c.days_active} active days`}>
                              <code title={c.contract_id}>{shortContract(c.contract_id)}</code>
                            </PName>
                          </td>
                          <td>
                            {c.footprint_verified ? (
                              <Chip kind="verified" />
                            ) : (
                              <Chip kind="none">Listed only</Chip>
                            )}
                          </td>
                          <td className="um-r">
                            <Num value={c.invocations} />
                          </td>
                          <td className="um-r">{share(c.invocations)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </Card>
            <Card title="Top functions" flush className="um-op-card-flush">
              {d.functions.length === 0 ? (
                <EmptyState plain title="No function calls in this window" />
              ) : (
                <TableScroll label="Top functions">
                  <table className="um-table um-op-table" data-testid="usage-project-functions">
                    <thead>
                      <tr>
                        <th scope="col">Function</th>
                        <th scope="col">Caller</th>
                        <th scope="col" className="um-r">
                          Calls
                        </th>
                        <th scope="col" className="um-r">
                          Success
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...d.functions]
                        .sort((a, b) => b.calls - a.calls)
                        .slice(0, 12)
                        .map((f) => (
                          <tr key={`${f.contract_id}-${f.function}-${f.caller_kind}`}>
                            <td>
                              <code>{f.function}</code>
                            </td>
                            <td>
                              <Tag>{f.caller_kind}</Tag>
                            </td>
                            <td className="um-r">
                              <Num value={f.calls} />
                            </td>
                            <td className="um-r">
                              {f.calls ? fmtShareD(f.successful_calls / f.calls) : "—"}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </Card>
          </div>
          {d.weekly.length ? (
            <Card
              title="Weekly active accounts"
              sub="Accounts that started at least one operation; ISO weeks, UTC"
              flush
              className="um-op-card-flush"
            >
              <TableScroll label="Weekly active accounts">
                <table className="um-table um-op-table" data-testid="usage-project-weekly">
                  <thead>
                    <tr>
                      <th scope="col">Week of</th>
                      <th scope="col" className="um-r">
                        Active accounts
                      </th>
                      <th scope="col" className="um-r">
                        With a successful call
                      </th>
                      <th scope="col" className="um-r">
                        Invocations
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.weekly.map((w) => (
                      <tr key={w.week_start}>
                        <td className="um-op-mono">{w.week_start.slice(0, 10)}</td>
                        <td className="um-r">
                          {w.active_accounts === null ? (
                            <Hid min={d.min_count} />
                          ) : (
                            <Num value={w.active_accounts} />
                          )}
                        </td>
                        <td className="um-r">
                          {w.active_accounts_successful === null ? (
                            <Hid min={d.min_count} />
                          ) : (
                            <Num value={w.active_accounts_successful} />
                          )}
                        </td>
                        <td className="um-r">
                          <Num value={w.invocations} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
