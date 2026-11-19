// SPDX-License-Identifier: Apache-2.0
// SCF operators: DeFi protocol interactions across the ecosystem (operatorProtocols → scf.op_protocol_usage, audited;
// migration 0082). For every registry project that lists contracts (public chain data — ownership not verified) and
// every tenant with verified contracts: the transactions touching its contracts that also used Blend, Soroswap,
// DeFindex, Aquarius or Reflector, and the share of its transactions; above the list, each protocol's network-wide
// transaction count for context. Public ledger counts, exact, lower bounds. Never on a public page.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useId } from "react";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import { DAY_PRESET_LABELS, DAY_PRESETS, type DayPreset, presetSpan } from "../../lib/days.ts";
import { fmtInt, fmtShare } from "../../lib/format.ts";

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

const PROTOCOL_ORDER = ["blend", "soroswap", "defindex", "aquarius", "reflector"] as const;

export function OperatorProtocolsPage() {
  const id = useId();
  const search = useSearch({ from: "/app/operator/protocols" }) as OperatorProtocolsSearch;
  const navigate = useNavigate();
  useTitle("Protocols");
  const span = presetSpan(search.range);
  const set = (s: {
    range?: DayPreset;
    active?: boolean;
    network?: OperatorProtocolsSearch["network"] | undefined;
  }) => {
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
  const d = q.data;
  return (
    <>
      <h1>Protocol interactions</h1>
      <p>
        Which DeFi protocols the users of each registry project and tenant interact with:
        transactions touching the subject's contracts that also touched a protocol's public
        contracts, from the public Stellar ledger files. Registry projects are public chain data —
        ownership not verified. Every read is audited.
      </p>
      <form className="card" aria-label="Protocol filters" onSubmit={(e) => e.preventDefault()}>
        <div className="row">
          <div>
            <label htmlFor={`${id}-range`}>Window</label>
            <select
              id={`${id}-range`}
              value={search.range}
              onChange={(e) => set({ range: e.target.value as DayPreset })}
            >
              {DAY_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {DAY_PRESET_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-net`}>Network</label>
            <select
              id={`${id}-net`}
              value={search.network ?? ""}
              onChange={(e) =>
                set({
                  network: (e.target.value || undefined) as OperatorProtocolsSearch["network"],
                })
              }
            >
              <option value="">Default</option>
              <option value="mainnet">Mainnet</option>
              <option value="testnet">Testnet</option>
            </select>
          </div>
          <div>
            <label>
              <input
                type="checkbox"
                checked={search.active}
                onChange={(e) => set({ active: e.target.checked })}
              />{" "}
              Only subjects with protocol use
            </label>
          </div>
        </div>
      </form>
      <ProblemAlert error={q.error} />
      {q.isPending ? <p className="muted">Loading…</p> : null}
      {d ? (
        <>
          <p className="small muted" data-testid="op-protocols-window">
            {d.network === "mainnet" ? "Mainnet" : "Testnet"} · {d.start.slice(0, 10)} to{" "}
            {d.end.slice(0, 10)} (end exclusive, UTC) · {fmtInt(d.days_covered)} day
            {d.days_covered === 1 ? "" : "s"} computed
          </p>
          <div className="table-wrap">
            <table data-testid="op-protocols-network">
              <caption>Network-wide transactions touching each protocol</caption>
              <thead>
                <tr>
                  {d.network_totals.map((n) => (
                    <th key={n.protocol} scope="col" className="num">
                      {n.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {d.network_totals.map((n) => (
                    <td key={n.protocol} className="num">
                      {fmtInt(n.transactions)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table data-testid="op-protocols-subjects">
              <caption>
                Per registry project and tenant (transactions · share of the subject's)
              </caption>
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  <th scope="col" className="num">
                    All transactions
                  </th>
                  {PROTOCOL_ORDER.map((p) => (
                    <th key={p} scope="col" className="num">
                      {d.network_totals.find((n) => n.protocol === p)?.name ?? p}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.subjects.length === 0 ? (
                  <tr>
                    <td colSpan={2 + PROTOCOL_ORDER.length}>No figures in this window.</td>
                  </tr>
                ) : (
                  d.subjects.map((s) => (
                    <tr key={`${s.kind}/${s.id}`} data-testid={`op-protocols-${s.id}`}>
                      <th scope="row">
                        {s.kind === "project" ? (
                          <Link
                            to="/operator/usage-map/$registryProjectId"
                            params={{ registryProjectId: s.id }}
                            search={{ range: search.range }}
                          >
                            {s.name ?? s.id}
                          </Link>
                        ) : (
                          <code>{s.id}</code>
                        )}
                        <div className="small muted">{s.label}</div>
                      </th>
                      <td className="num">{fmtInt(s.transactions)}</td>
                      {PROTOCOL_ORDER.map((p) => {
                        const e = s.protocols.find((x) => x.protocol === p);
                        return (
                          <td key={p} className="num">
                            {e && e.transactions > 0
                              ? `${fmtInt(e.transactions)} · ${fmtShare(e.share)}`
                              : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <details className="card">
            <summary>How these figures are counted</summary>
            <p>{d.definition}</p>
          </details>
        </>
      ) : null}
    </>
  );
}
