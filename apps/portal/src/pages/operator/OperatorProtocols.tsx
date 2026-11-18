// SPDX-License-Identifier: Apache-2.0
// SCF operators: DeFi protocol interactions across the ecosystem (operatorProtocols → scf.op_protocol_usage, audited;
// migration 0082). Each protocol's network-wide transactions for context, then every registry project that lists
// contracts (public chain data, ownership not verified) and every enrolled project with verified contracts: the share
// of its transactions that also used Blend, Soroswap, DeFindex, Aquarius or Reflector. Public ledger counts, exact,
// lower bounds. Never on a public page.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  Card,
  Chip,
  EmptyState,
  Note,
  QueryState,
  Segmented,
  TableScroll,
  Tag,
} from "../../components/ui/index.ts";
import { DAY_PRESETS, type DayPreset, presetSpan } from "../../lib/days.ts";
import { BarList, OpIntro, PName, TopActions } from "./kit.tsx";
import { fmtShareD } from "./model.ts";

export interface OperatorProtocolsSearch {
  range: DayPreset;
  network?: "mainnet" | "testnet";
  active: boolean;
}

export function parseOperatorProtocolsSearch(s: Record<string, unknown>): OperatorProtocolsSearch {
  const out: OperatorProtocolsSearch = {
    range: (DAY_PRESETS as readonly unknown[]).includes(s.range) ? (s.range as DayPreset) : "30d",
    active: s.active === true || s.active === "true",
  };
  if (s.network === "mainnet" || s.network === "testnet") out.network = s.network;
  return out;
}

export function OperatorProtocolsPage() {
  useTitle("Protocols");
  const search = useSearch({ from: "/app/operator/protocols" }) as OperatorProtocolsSearch;
  const navigate = useNavigate();
  const span = presetSpan(search.range);
  const set = (s: Partial<OperatorProtocolsSearch>) => {
    const next: OperatorProtocolsSearch = {
      range: s.range ?? search.range,
      active: s.active ?? search.active,
    };
    const network = "network" in s ? s.network : search.network;
    if (network) next.network = network;
    void navigate({ to: "/operator/protocols", search: next, replace: true });
  };
  const q = useQuery({
    queryKey: ["operator-protocols", span.start, span.end, search.network ?? null, search.active],
    queryFn: () =>
      api.call("operatorProtocols", {
        query: {
          start: span.start,
          end: span.end,
          ...(search.network ? { network: search.network } : {}),
          ...(search.active ? { active_only: true } : {}),
        },
      }),
  });
  return (
    <>
      <TopActions range={search.range} onRange={(r) => set({ range: r })} />
      <OpIntro
        title="Protocols"
        lead="How projects use the main DeFi protocols on the network, from public ledger data. Counts are lower bounds: calls routed through other contracts can be missed."
        aside={<Chip kind="ledger">Public chain data</Chip>}
      />
      <QueryState query={q}>
        {(d) => {
          const totals = [...d.network_totals].sort((a, b) => b.transactions - a.transactions);
          const order = totals.map((t) => t.protocol);
          return (
            <>
              <Card
                title="Network totals per protocol"
                tone="chain"
                sub={`Transactions in this window · ${d.network === "mainnet" ? "mainnet" : "testnet"} · ${d.days_covered} days computed`}
                actions={
                  <Segmented
                    label="Network"
                    value={d.network}
                    onChange={(n) => set({ network: n })}
                    options={[
                      { value: "mainnet", label: "Mainnet" },
                      { value: "testnet", label: "Testnet" },
                    ]}
                  />
                }
              >
                {totals.length === 0 ? (
                  <EmptyState plain title="No protocol transactions in this window" />
                ) : (
                  <BarList
                    tint="chain"
                    testId="op-protocols-network"
                    head={["Protocol", "Transactions", "Success"]}
                    rows={totals.map((t) => ({
                      key: t.protocol,
                      label: (
                        <>
                          {t.name}
                          <small>{t.days_active} days active</small>
                        </>
                      ),
                      value: t.transactions,
                      aside: t.transactions
                        ? fmtShareD(t.successful_transactions / t.transactions)
                        : "—",
                    }))}
                  />
                )}
              </Card>
              <Card
                title="Projects and the protocols they use"
                sub="Share of each project’s transactions"
                flush
                className="um-op-card-flush"
                actions={
                  <label className="um-op-check">
                    <input
                      type="checkbox"
                      checked={search.active}
                      onChange={(e) => set({ active: e.target.checked })}
                    />
                    Only projects with protocol use
                  </label>
                }
              >
                {d.subjects.length === 0 ? (
                  <EmptyState plain title="No projects with figures in this window" />
                ) : (
                  <TableScroll label="Projects and protocols" stickyFirst>
                    <table className="um-table um-op-table" data-testid="op-protocols-subjects">
                      <thead>
                        <tr>
                          <th scope="col">Project</th>
                          <th scope="col">Kind</th>
                          {order.map((p) => (
                            <th key={p} scope="col" className="um-r">
                              {totals.find((t) => t.protocol === p)?.name ?? p}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {d.subjects.map((s) => (
                          <tr key={`${s.kind}/${s.id}`} data-testid={`op-protocols-${s.id}`}>
                            <th scope="row">
                              <PName sub={s.label}>
                                {s.kind === "project" ? (
                                  <Link
                                    to="/operator/usage-map/$registryProjectId"
                                    params={{ registryProjectId: s.id }}
                                    search={{ range: search.range }}
                                  >
                                    {s.name ?? s.id}
                                  </Link>
                                ) : (
                                  <Link
                                    to="/operator/tenants/$tenantId"
                                    params={{ tenantId: s.id }}
                                  >
                                    {s.name ?? "Enrolled project"}
                                  </Link>
                                )}
                              </PName>
                            </th>
                            <td>
                              <span
                                title={
                                  s.kind === "tenant"
                                    ? "Enrolled in UsageMap"
                                    : "In the SCF registry, not enrolled"
                                }
                              >
                                <Tag>{s.kind === "tenant" ? "Enrolled" : "Registry"}</Tag>
                              </span>
                            </td>
                            {order.map((p) => {
                              const e = s.protocols.find((x) => x.protocol === p);
                              return (
                                <td
                                  key={p}
                                  className="um-r"
                                  title={e ? `${e.transactions} transactions` : undefined}
                                >
                                  {e && e.transactions > 0 ? (
                                    fmtShareD(e.share ?? null, 0)
                                  ) : (
                                    <span className="um-op-na">—</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                )}
              </Card>
              <Note>{d.definition}</Note>
            </>
          );
        }}
      </QueryState>
    </>
  );
}
