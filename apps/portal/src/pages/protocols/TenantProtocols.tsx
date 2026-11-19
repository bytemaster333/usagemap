// SPDX-License-Identifier: Apache-2.0
// "Protocols your users interact with" (getTenantProtocols, tenant:viewer; migration 0082, job protocol_usage): per
// DeFi protocol of the curated registry (Blend, Soroswap, DeFindex, Aquarius, Reflector), how many transactions that
// touched this project's verified contracts also touched the protocol, and the share of all its transactions, from the
// public Stellar ledger files. Counts are exact and lower bounds; only the protocol of a transaction is kept. The
// project's verified contracts are listed with explorer links (public chain objects). Never a public page.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useId } from "react";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { ExplorerLinks } from "../../components/ExplorerLinks.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import { DAY_PRESET_LABELS, DAY_PRESETS, type DayPreset, presetSpan } from "../../lib/days.ts";
import { fmtInt, fmtShare } from "../../lib/format.ts";
import { shortContract } from "../operator/usagemap/model.ts";
import { OnchainHeader, OnchainTabs } from "../project/Onchain.tsx";
import { TenantNav } from "../TenantNav.tsx";
import type { TenantUsageSearch } from "../usagemap/model.ts";

export type ProtocolEntry = ControlPlane.TenantProtocols["protocols"][number];

/** Protocols ordered by transactions (most first), ties in registry order. */
export function byUse(ps: readonly ProtocolEntry[]): ProtocolEntry[] {
  return ps
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.transactions - a.p.transactions || a.i - b.i)
    .map((x) => x.p);
}

export function TenantProtocolsPage() {
  const id = useId();
  const { tenantId } = useParams({ from: "/app/t/$tenantId/protocols" });
  const search = useSearch({ from: "/app/t/$tenantId/protocols" }) as TenantUsageSearch;
  const navigate = useNavigate();
  useTitle("Protocols");
  const span = presetSpan(search.range);
  const set = (s: { range?: DayPreset; network?: TenantUsageSearch["network"] | undefined }) => {
    const next: TenantUsageSearch = { range: s.range ?? search.range };
    const network = "network" in s ? s.network : search.network;
    if (network) next.network = network;
    void navigate({
      to: "/t/$tenantId/protocols",
      params: { tenantId },
      search: next,
      replace: true,
    });
  };
  const q = useQuery({
    queryKey: ["tenant-protocols", tenantId, span.start, span.end, search.network ?? null],
    queryFn: () =>
      api.call("getTenantProtocols", {
        path: { tenantId },
        query: {
          start: span.start,
          end: span.end,
          ...(search.network ? { network: search.network } : {}),
        },
      }),
  });
  const d = q.data;
  const used = d ? byUse(d.protocols).filter((p) => p.transactions > 0) : [];
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <OnchainHeader sub="DeFi protocols · transactions where your verified contracts and a known protocol meet" />
      <OnchainTabs tenantId={tenantId} />
      <h2 className="um-h2">Protocols your users interact with</h2>
      <p>
        Of the transactions that touched your verified contracts, how many also used a DeFi protocol
        — Blend, Soroswap, DeFindex, Aquarius or Reflector — counted by UsageMap from the public
        Stellar ledger files. Only the protocol of a transaction is kept; no account and no other
        contract is stored. This page is never public.
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
                set({ network: (e.target.value || undefined) as TenantUsageSearch["network"] })
              }
            >
              <option value="">Default</option>
              <option value="mainnet">Mainnet</option>
              <option value="testnet">Testnet</option>
            </select>
          </div>
        </div>
      </form>
      <ProblemAlert error={q.error} />
      {q.isPending ? (
        <p className="muted" data-testid="protocols-loading">
          Loading…
        </p>
      ) : null}
      {d && d.days_with_data === 0 ? (
        <section className="card" data-testid="protocols-empty" aria-labelledby={`${id}-none`}>
          <h2 id={`${id}-none`}>No figures yet</h2>
          <p>
            The figures need at least one verified contract on {d.network} and the on-chain
            correlation switched on; they are computed once a day from the previous days' ledgers.
          </p>
          <p>
            <Link to="/t/$tenantId/setup/footprint" params={{ tenantId }}>
              Declare and verify your contracts
            </Link>
          </p>
        </section>
      ) : null}
      {d && d.days_with_data > 0 ? (
        <>
          <p className="small muted" data-testid="protocols-window">
            {d.network === "mainnet" ? "Mainnet" : "Testnet"} · {d.start.slice(0, 10)} to{" "}
            {d.end.slice(0, 10)} (end exclusive, UTC) · {fmtInt(d.days_with_data)} day
            {d.days_with_data === 1 ? "" : "s"} with figures · registry {d.registry_version}
          </p>
          <dl className="usage-summary" data-testid="protocols-totals">
            <div>
              <dt>Transactions touching your contracts</dt>
              <dd>{fmtInt(d.transactions)}</dd>
            </div>
            <div>
              <dt>…of which used a listed protocol (most used)</dt>
              <dd>{used[0] ? `${used[0].name}: ${fmtShare(used[0].share)}` : "none"}</dd>
            </div>
          </dl>
          <div className="table-wrap">
            <table data-testid="protocols-table">
              <caption>Per protocol (a transaction can use several)</caption>
              <thead>
                <tr>
                  <th scope="col">Protocol</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="num">
                    Transactions
                  </th>
                  <th scope="col" className="num">
                    Successful
                  </th>
                  <th scope="col" className="num">
                    Share of yours
                  </th>
                  <th scope="col" className="num">
                    Active days
                  </th>
                </tr>
              </thead>
              <tbody>
                {byUse(d.protocols).map((p) => (
                  <tr key={p.protocol} data-testid={`protocols-row-${p.protocol}`}>
                    <th scope="row">
                      <a href={p.website} target="_blank" rel="noopener noreferrer">
                        {p.name}
                      </a>
                    </th>
                    <td>{p.kind}</td>
                    <td className="num">{fmtInt(p.transactions)}</td>
                    <td className="num">{fmtInt(p.successful_transactions)}</td>
                    <td className="num">{fmtShare(p.share)}</td>
                    <td className="num">{fmtInt(p.days_active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {d && d.contracts.length > 0 ? (
        <section
          className="card"
          aria-labelledby={`${id}-contracts`}
          data-testid="protocols-contracts"
        >
          <h2 id={`${id}-contracts`}>Your verified contracts counted</h2>
          <ul>
            {d.contracts.map((c) => (
              <li key={c}>
                <code title={c}>{shortContract(c)}</code>{" "}
                <ExplorerLinks
                  kind="contract"
                  id={c}
                  network={d.network}
                  testId={`protocols-explorers-${c}`}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {d ? (
        <details className="card">
          <summary>How these figures are counted</summary>
          <p data-testid="protocols-definition">{d.definition}</p>
        </details>
      ) : null}
    </>
  );
}
