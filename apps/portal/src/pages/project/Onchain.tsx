// SPDX-License-Identifier: Apache-2.0
// On-chain (approved design): read from Stellar's public ledger. One page header and route tabs over the four
// sections — Activity (this file: contract calls of the registered footprint per day, getOnchainDaily), Usage map
// (/usage-map), DeFi protocols (/protocols) and Footprint (/footprint).

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../../api/client.ts";
import { useTitle } from "../../components/AppShell.tsx";
import {
  BarList,
  buttonClass,
  Card,
  Chart,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Kpi,
  Legend,
  LoadingState,
  Note,
  PageHeader,
  partialLast,
  Segmented,
  StatusBadge,
  TableScroll,
} from "../../components/ui/index.ts";
import { networkName } from "../../lib/usage.ts";
import {
  axisLabel,
  Coming,
  dayList,
  deltaOf,
  fmtN,
  fmtPctN,
  ProjectFrame,
  type ProjectRange,
  parseProjectRange,
  RANGE_SUB,
  RangePicker,
  rangeDays,
  withPrevious,
} from "./common.tsx";

type Net = "mainnet" | "testnet";

export function OnchainHeader({ sub }: { sub?: string | undefined }) {
  return (
    <PageHeader
      title="On-chain"
      sub={sub ?? "read from Stellar's public ledger"}
      badges={<Chip kind="ledger" />}
    />
  );
}

/** The On-chain section tabs (routes). */
export function OnchainTabs({ tenantId }: { tenantId: string }) {
  const params = { tenantId };
  const cur = { "aria-current": "page" as const };
  return (
    <nav aria-label="On-chain sections">
      <ul className="um-tabs">
        <li>
          <Link
            to="/t/$tenantId/onchain"
            params={params}
            search={{ range: "30d" }}
            activeOptions={{ includeSearch: false }}
            activeProps={cur}
          >
            Activity
          </Link>
        </li>
        <li>
          <Link
            to="/t/$tenantId/usage-map"
            params={params}
            search={{ range: "30d" }}
            activeOptions={{ includeSearch: false }}
            activeProps={cur}
          >
            Usage map
          </Link>
        </li>
        <li>
          <Link
            to="/t/$tenantId/protocols"
            params={params}
            search={{ range: "30d" }}
            activeOptions={{ includeSearch: false }}
            activeProps={cur}
          >
            DeFi protocols
          </Link>
        </li>
        <li>
          <Link to="/t/$tenantId/footprint" params={params} activeProps={cur}>
            Footprint
          </Link>
        </li>
      </ul>
    </nav>
  );
}

export function parseOnchainSearch(s: Record<string, unknown>): {
  range: ProjectRange;
  network?: Net;
} {
  return s.network === "testnet"
    ? { range: parseProjectRange(s.range), network: "testnet" }
    : { range: parseProjectRange(s.range) };
}

const KIND_TEXT: Record<string, string> = {
  contract: "Contract",
  issuing_account: "Issuing account",
  app_account: "App account",
  wasm_hash: "WASM hash",
};

const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

export function OnchainPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/onchain" });
  const search = useSearch({ from: "/app/t/$tenantId/onchain" });
  const navigate = useNavigate();
  useTitle("On-chain");
  const n = Math.max(1, rangeDays(search.range));
  const w = withPrevious(n);
  const net: Net = search.network ?? "mainnet";
  const daily = useQuery({
    queryKey: ["onchain-daily", tenantId, w.both.start, w.both.end],
    queryFn: () => api.call("getOnchainDaily", { path: { tenantId }, query: w.both }),
  });
  const protocols = useQuery({
    queryKey: ["tenant-protocols", tenantId, w.current.start, w.current.end, net],
    queryFn: () =>
      api.call("getTenantProtocols", { path: { tenantId }, query: { ...w.current, network: net } }),
  });
  const footprint = useQuery({
    queryKey: ["footprint", tenantId],
    queryFn: () => api.call("listFootprint", { path: { tenantId } }),
  });
  const set = (s: Partial<typeof search>) =>
    void navigate({
      to: "/t/$tenantId/onchain",
      params: { tenantId },
      search: { ...search, ...s },
      replace: true,
    });

  const days = dayList(w.current.start, w.current.end);
  const curDays = new Set(days);
  const mine = (daily.data ?? []).filter(
    (r) => r.contract_status === "verified" && networkName(r.network) === net,
  );
  const sum = (rows: ControlPlane.OnchainDay[], k: "invocations" | "successful_invocations") =>
    rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const cur = mine.filter((r) => curDays.has(r.day));
  const prev = mine.filter((r) => !curDays.has(r.day));
  const calls = sum(cur, "invocations");
  const ok = sum(cur, "successful_invocations");
  const perDay = days.map((d) =>
    sum(
      cur.filter((r) => r.day === d),
      "invocations",
    ),
  );
  const okPerDay = days.map((d) =>
    sum(
      cur.filter((r) => r.day === d),
      "successful_invocations",
    ),
  );

  return (
    <ProjectFrame tenantId={tenantId}>
      <OnchainHeader sub={`${RANGE_SUB[search.range]} · read from Stellar's public ledger`} />
      <RangePicker value={search.range} onChange={(r) => set({ range: r })} />
      <div className="um-p-tools">
        <Segmented
          label="Network"
          value={net}
          onChange={(v) => set({ network: v })}
          options={[
            { value: "mainnet", label: "Mainnet" },
            { value: "testnet", label: "Testnet" },
          ]}
        />
      </div>
      <OnchainTabs tenantId={tenantId} />
      {daily.error ? (
        <ErrorState error={daily.error} onRetry={() => void daily.refetch()} />
      ) : daily.isPending ? (
        <LoadingState block />
      ) : (
        <>
          <section className="um-grid um-g4" aria-label="Summary">
            <Kpi
              tone="chain"
              icon="layers"
              label="Contract calls"
              value={fmtN(calls)}
              delta={search.range === "24h" ? undefined : deltaOf(calls, sum(prev, "invocations"))}
              foot="Verified contracts only"
            />
            <Kpi
              tone="chain"
              icon="check"
              label="Successful"
              value={calls > 0 ? (100 * (ok / calls)).toFixed(1) : null}
              unit="%"
            />
            <Kpi
              tone="chain"
              icon="users"
              label="Distinct callers"
              value={null}
              foot={
                <>
                  Over the range <Coming what="Distinct callers over a range" />
                </>
              }
            />
            <Kpi
              tone="chain"
              icon="network"
              label="DeFi interactions"
              loading={protocols.isPending}
              value={
                protocols.data && protocols.data.days_covered > 0
                  ? fmtN(protocols.data.protocols.reduce((a, p) => a + p.transactions, 0))
                  : null
              }
              foot={
                protocols.data
                  ? protocols.data.days_covered > 0
                    ? `${protocols.data.protocols.filter((p) => p.transactions > 0).length} protocols`
                    : "Not computed for this range yet"
                  : undefined
              }
            />
          </section>
          <Card
            title="Contract calls"
            sub={`All verified contracts, per day · ${net}`}
            actions={
              <Legend
                items={[
                  { label: "Calls", color: "yellow" },
                  { label: "Successful", color: "web" },
                ]}
              />
            }
          >
            {calls === 0 ? (
              <EmptyState plain title="No contract calls in this range" icon="layers">
                Calls of your verified contracts on {net} appear here, one bar per day.
              </EmptyState>
            ) : (
              <Chart
                partial={partialLast(days)}
                type="bar"
                label={`Contract calls per day on ${net}`}
                labels={days.map((d) => axisLabel(d))}
                series={[
                  { name: "Contract calls", color: "yellow", data: perDay },
                  { name: "Successful", color: "web", data: okPerDay },
                ]}
                height={230}
              />
            )}
          </Card>
        </>
      )}
      <section className="um-grid um-g2">
        <Card
          title="Registered footprint"
          sub="The contracts and accounts that count as your project"
          flush
          actions={
            <Link
              to="/t/$tenantId/footprint"
              params={{ tenantId }}
              className={buttonClass("secondary", { size: "sm" })}
            >
              <Icon name="plus" />
              Register
            </Link>
          }
        >
          {footprint.error ? (
            <ErrorState error={footprint.error} plain />
          ) : footprint.isPending ? (
            <LoadingState />
          ) : footprint.data.length === 0 ? (
            <EmptyState plain title="Nothing registered yet" icon="layers" />
          ) : (
            <TableScroll label="Registered footprint">
              <table className="um-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {footprint.data.map((f) => (
                    <tr key={f.item_id}>
                      <td>
                        <b>{f.label ?? short(f.subject ?? "")}</b>
                        <br />
                        <code className="um-muted">{short(f.subject ?? "")}</code>{" "}
                        <span className="um-tag">{f.network}</span>
                      </td>
                      <td>{KIND_TEXT[f.kind] ?? f.kind}</td>
                      <td>
                        {f.status === "verified" ? (
                          <StatusBadge status="live">Verified</StatusBadge>
                        ) : f.status === "rejected" ? (
                          <StatusBadge status="bad">Rejected</StatusBadge>
                        ) : (
                          <StatusBadge status="set">Checking</StatusBadge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </Card>
        <Card
          title="DeFi protocol interactions"
          sub="Transactions where your contracts and a known protocol meet"
        >
          {protocols.error ? (
            <ErrorState error={protocols.error} plain />
          ) : protocols.isPending ? (
            <LoadingState />
          ) : protocols.data.protocols.every((p) => p.transactions === 0) ? (
            <EmptyState plain title="No protocol interactions yet" />
          ) : (
            <BarList
              tone="chain"
              head={["Protocol", "Transactions"]}
              label="DeFi protocols"
              rows={protocols.data.protocols.map((p) => ({
                key: p.protocol,
                label: p.name,
                value: fmtN(p.transactions),
                share: p.share === null ? null : p.share * 100,
              }))}
            />
          )}
          {protocols.data ? (
            <Note>
              Matched against the protocol registry
              {protocols.data.registry_version
                ? `, version ${protocols.data.registry_version}`
                : ""}
              . Days covered: {protocols.data.days_covered} of {days.length}. Successful share:{" "}
              {fmtPctN(
                protocols.data.transactions > 0
                  ? protocols.data.successful_transactions / protocols.data.transactions
                  : null,
              )}
              .
            </Note>
          ) : null}
        </Card>
      </section>
    </ProjectFrame>
  );
}
