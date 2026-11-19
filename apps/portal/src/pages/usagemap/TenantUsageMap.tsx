// SPDX-License-Identifier: Apache-2.0
// The tenant's own Usage Map (getTenantUsageMap, tenant:viewer): for every registry project this tenant has a
// CONFIRMED registry link to, the on-chain usage counted from the public Stellar ledger files — daily and SCF Growth
// Hack weekly series, every listed contract with this tenant's footprint state, calls per contract function. The
// figures are the tenant's own view and exact. Projects without a confirmed link never appear; this page is never
// public. Without any confirmed link it says so and points to the registry claim (/onboard) and Verification.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useId } from "react";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import { Sparkline } from "../../components/BandChart.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import { DAY_PRESET_LABELS, DAY_PRESETS, type DayPreset, presetSpan } from "../../lib/days.ts";
import { fmtInt, fmtShare } from "../../lib/format.ts";
import { STATUS_BADGE, STATUS_TEXT, shortContract } from "../operator/usagemap/model.ts";
import { OnchainHeader, OnchainTabs } from "../project/Onchain.tsx";
import { TenantNav } from "../TenantNav.tsx";
import {
  dailySeries,
  FOOTPRINT_BADGE,
  FOOTPRINT_HINT,
  FOOTPRINT_TEXT,
  hasUndeclared,
  projectTotals,
  type TenantUsageProject,
  type TenantUsageSearch,
} from "./model.ts";
import { UsageFunctionsTable, UsageWeeklyTable } from "./tables.tsx";

/** One claimed registry project: totals, daily series and table, weekly series, contracts, functions. */
export function TenantUsageProjectView({
  project: p,
  start,
  end,
}: {
  project: TenantUsageProject;
  start: string;
  end: string;
}) {
  const t = projectTotals(p);
  const hid = `usage-${p.registry_project_id}-h`;
  return (
    <section
      className="card"
      aria-labelledby={hid}
      data-testid={`tenant-usage-${p.registry_project_id}`}
    >
      <h2 id={hid}>{p.name}</h2>
      <p data-testid="tenant-usage-status">
        <span className={STATUS_BADGE[p.status]}>{STATUS_TEXT[p.status]}</span> {p.label} ·{" "}
        {p.contracts_verified} of {p.contracts_listed} listed contract
        {p.contracts_listed === 1 ? "" : "s"} verified
      </p>
      <dl className="usage-summary" data-testid="tenant-usage-totals">
        <div>
          <dt>Invocations</dt>
          <dd>{fmtInt(t.invocations)}</dd>
        </div>
        <div>
          <dt>Success rate</dt>
          <dd>{fmtShare(t.success_rate)}</dd>
        </div>
        <div>
          <dt>Contract calls (lower bound)</dt>
          <dd>{fmtInt(t.contract_calls)}</dd>
        </div>
        <div>
          <dt>Days with data</dt>
          <dd>{fmtInt(t.days_with_data)}</dd>
        </div>
      </dl>
      <figure>
        <figcaption>Daily invocations</figcaption>
        <Sparkline values={dailySeries(p, start, end)} label={`Daily invocations of ${p.name}`} />
      </figure>
      <details>
        <summary>Per day</summary>
        <div className="table-wrap">
          <table data-testid="tenant-usage-daily">
            <caption>Per UTC day (days without ledger data are left out)</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="num">
                  Invocations
                </th>
                <th scope="col" className="num">
                  Successful
                </th>
                <th scope="col" className="num">
                  Distinct invokers
                </th>
                <th scope="col" className="num">
                  Contract calls
                </th>
                <th scope="col" className="num">
                  Contracts invoked
                </th>
              </tr>
            </thead>
            <tbody>
              {p.daily.length === 0 ? (
                <tr>
                  <td colSpan={6}>No on-chain activity in this window.</td>
                </tr>
              ) : (
                p.daily.map((d) => (
                  <tr key={d.day}>
                    <th scope="row">{d.day}</th>
                    <td className="num">{fmtInt(d.invocations)}</td>
                    <td className="num">{fmtInt(d.successful_invocations)}</td>
                    <td className="num">{fmtInt(d.distinct_invokers)}</td>
                    <td className="num">{fmtInt(d.contract_calls)}</td>
                    <td className="num">
                      {fmtInt(d.contracts_invoked)} of {fmtInt(d.contracts_listed)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </details>
      <UsageWeeklyTable
        weekly={p.weekly}
        testId="tenant-usage-weekly"
        caption="Weekly active accounts (SCF Growth Hack: accounts that initiated at least one operation; ISO weeks, UTC)"
      />
      <div className="table-wrap">
        <table data-testid="tenant-usage-contracts">
          <caption>Listed contracts and your footprint</caption>
          <thead>
            <tr>
              <th scope="col">Contract</th>
              <th scope="col" className="num">
                Invocations
              </th>
              <th scope="col" className="num">
                Successful
              </th>
              <th scope="col" className="num">
                Contract calls
              </th>
              <th scope="col" className="num">
                Active days
              </th>
              <th scope="col">Footprint</th>
            </tr>
          </thead>
          <tbody>
            {p.contracts.map((c) => (
              <tr key={c.contract_id} data-testid={`tenant-usage-contract-${c.contract_id}`}>
                <th scope="row">
                  <code title={c.contract_id}>{shortContract(c.contract_id)}</code>
                </th>
                <td className="num">{fmtInt(c.invocations)}</td>
                <td className="num">{fmtInt(c.successful_invocations)}</td>
                <td className="num">{fmtInt(c.contract_calls)}</td>
                <td className="num">{fmtInt(c.days_active)}</td>
                <td>
                  <span className={FOOTPRINT_BADGE[c.footprint]}>
                    {FOOTPRINT_TEXT[c.footprint]}
                  </span>
                  <div className="small muted">{FOOTPRINT_HINT[c.footprint]}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <UsageFunctionsTable functions={p.functions} testId="tenant-usage-functions" />
    </section>
  );
}

export function TenantUsageMapPage() {
  const id = useId();
  const { tenantId } = useParams({ from: "/app/t/$tenantId/usage-map" });
  const search = useSearch({ from: "/app/t/$tenantId/usage-map" }) as TenantUsageSearch;
  const navigate = useNavigate();
  useTitle("Usage Map");
  const span = presetSpan(search.range);
  const set = (s: { range?: DayPreset; network?: TenantUsageSearch["network"] | undefined }) => {
    const next: TenantUsageSearch = { range: s.range ?? search.range };
    const network = "network" in s ? s.network : search.network;
    if (network) next.network = network;
    void navigate({
      to: "/t/$tenantId/usage-map",
      params: { tenantId },
      search: next,
      replace: true,
    });
  };
  const q = useQuery({
    queryKey: ["tenant-usage-map", tenantId, span.start, span.end, search.network ?? null],
    queryFn: () =>
      api.call("getTenantUsageMap", {
        path: { tenantId },
        query: {
          start: span.start,
          end: span.end,
          ...(search.network ? { network: search.network } : {}),
        },
      }),
  });
  const d = q.data;
  return (
    <>
      <TenantNav tenantId={tenantId} />
      <OnchainHeader sub="Usage map · registry projects you have a confirmed link to, from the public ledger" />
      <OnchainTabs tenantId={tenantId} />
      <h2 className="um-sr">Usage Map</h2>
      <p>
        On-chain usage of the registry projects your project has a confirmed registry link to,
        counted by UsageMap from the public Stellar ledger files. These are your own figures, exact;
        accounts are counted and discarded, never stored. This page is never public.
      </p>
      <form className="card" aria-label="Usage map filters" onSubmit={(e) => e.preventDefault()}>
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
                  network: (e.target.value || undefined) as TenantUsageSearch["network"],
                })
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
        <p className="muted" data-testid="tenant-usage-loading">
          Loading the Usage Map…
        </p>
      ) : null}
      {d && d.projects.length === 0 ? (
        <section className="card" data-testid="tenant-usage-empty" aria-labelledby={`${id}-none`}>
          <h2 id={`${id}-none`}>No confirmed SCF registry link</h2>
          <p>
            The Usage Map shows the registry projects your project has a confirmed link to (and that
            list contract ids in the registry). Claim your registry entry, then prove your domain:
            the link is confirmed once the domain is verified.
          </p>
          <p>
            <Link to="/onboard" search={{}} className="button">
              Find your project
            </Link>{" "}
            <Link to="/t/$tenantId/verification" params={{ tenantId }}>
              Check your verification and registry links
            </Link>
          </p>
        </section>
      ) : null}
      {d && d.projects.length > 0 ? (
        <>
          <p className="small muted" data-testid="tenant-usage-window">
            {d.network === "mainnet" ? "Mainnet" : "Testnet"} · {d.start.slice(0, 10)} to{" "}
            {d.end.slice(0, 10)} (end exclusive, UTC)
          </p>
          {hasUndeclared(d.projects) ? (
            <p className="alert warn" data-testid="tenant-usage-undeclared">
              Some contracts the registry lists for your project are not in your footprint.{" "}
              <Link to="/t/$tenantId/setup/footprint" params={{ tenantId }}>
                Declare and verify your contracts
              </Link>
              .
            </p>
          ) : null}
          {d.projects.map((p) => (
            <TenantUsageProjectView
              key={p.registry_project_id}
              project={p}
              start={d.start}
              end={d.end}
            />
          ))}
          <details className="card">
            <summary>How these figures are counted</summary>
            <dl>
              {Object.entries(d.definitions).map(([k, v]) => (
                <div key={k}>
                  <dt>{k.replaceAll("_", " ")}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      ) : null}
    </>
  );
}
