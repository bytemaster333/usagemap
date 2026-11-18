// SPDX-License-Identifier: Apache-2.0
// Wallet funnel by wallet type (plan D-6; Stellar event schema v1, wire-formats §a.3.1; `getSiteWalletFunnel`): the
// daily property rollup counts each event per UTC day of receipt, by network and wallet type. The tenant's own view
// is exact; a figure the API withholds (null, a count below the small-count floor in an output that leaves the
// tenant, C-137) is shown as "withheld", never as zero. The on-chain step is not a conversion: the browser never sees
// a transaction hash, so ledger counts are day-level and never joined to visitors (decision D5); they are shown beside
// the funnel, not inside it.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../api/client.ts";
import { useTitle } from "../components/AppShell.tsx";
import {
  BarList,
  Card,
  Chart,
  EmptyState,
  ErrorState,
  Funnel as FunnelBars,
  Kpi,
  Legend,
  LoadingState,
  Note,
  partialLast,
  Segmented,
  TableScroll,
} from "../components/ui/index.ts";
import { DAY_PRESETS, type DayPreset, presetSpan } from "../lib/days.ts";
import { fmtDay, fmtInt, fmtRange, fmtShare } from "../lib/format.ts";
import { onchainTotals } from "../lib/usage.ts";
import { axisLabel, Coming, RangePicker } from "./project/common.tsx";
import { useSite } from "./SiteLayout.tsx";

type Funnel = ControlPlane.WalletFunnel;
type Step = Funnel["steps"][number];
export type FunnelNetwork = "mainnet" | "testnet" | "all";

export interface WalletSearch {
  network: FunnelNetwork;
  range: DayPreset;
  variant: "verified" | "raw";
}

export function parseWalletSearch(s: Record<string, unknown>): WalletSearch {
  return {
    network: s.network === "testnet" || s.network === "all" ? s.network : "mainnet",
    range: (DAY_PRESETS as readonly unknown[]).includes(s.range) ? (s.range as DayPreset) : "30d",
    variant: s.variant === "raw" ? "raw" : "verified",
  };
}

/** The funnel order; the other events are listed below it. */
export const FUNNEL_ORDER: Step["event"][] = [
  "wallet_modal_opened",
  "wallet_selected",
  "wallet_connect",
  "sign_requested",
  "sign_approved",
  "tx_submitted",
];

export const EVENT_TEXT: Record<Step["event"], string> = {
  wallet_modal_opened: "Wallet dialog opened",
  wallet_modal_closed: "Wallet dialog closed",
  wallet_selected: "Wallet chosen",
  wallet_connect: "Wallet connected",
  wallet_disconnect: "Wallet disconnected",
  sign_requested: "Signature requested",
  sign_approved: "Signature approved",
  sign_rejected: "Signature rejected",
  tx_submitted: "Transaction submitted",
  smart_wallet_created: "Smart wallet created",
  passkey_used: "Passkey used",
};

export const WALLET_TEXT: Record<string, string> = {
  freighter: "Freighter",
  albedo: "Albedo",
  xbull: "xBull",
  lobstr: "LOBSTR",
  hana: "Hana",
  hot: "HOT",
  rabet: "Rabet",
  walletconnect: "WalletConnect",
  ledger: "Ledger",
  trezor: "Trezor",
  fordefi: "Fordefi",
  klever: "Klever",
  onekey: "OneKey",
  bitget: "Bitget",
  cactuslink: "CactusLink",
  dcent: "D'CENT",
  scopuly: "Scopuly",
  metamask: "MetaMask (Snap)",
  ghostsig: "GhostSig",
  passkey: "Passkey / smart wallet",
  injected_other: "Other injected wallet",
  unknown: "Unknown",
};

/** A count the API may withhold (null) shown as such — never as 0. */
export function fmtCount(n: number | null | undefined): string {
  return n === null || n === undefined ? "withheld" : fmtInt(n);
}

export interface FunnelRow {
  event: Step["event"];
  count: number | null;
  /** share of the first step with a count */
  share: number | null;
}

/** The funnel steps in order; `tx_submitted` counts successful transaction submissions only (`result_class` success). */
export function funnelRows(f: Funnel): FunnelRow[] {
  const by = new Map(f.steps.map((s) => [s.event, s]));
  const rows = FUNNEL_ORDER.map((event) => {
    const s = by.get(event);
    let count: number | null = s ? (s.count as number | null) : 0;
    if (event === "tx_submitted" && s) {
      const rc = s.by_property?.result_class;
      count = rc ? ((rc.success as number | null | undefined) ?? null) : count;
    }
    return { event, count };
  });
  const base = rows.find((r) => r.count !== null && r.count > 0)?.count ?? null;
  return rows.map((r) => ({
    ...r,
    share: base === null || r.count === null ? null : r.count / base,
  }));
}

/** Wallet types with any count, sorted by connections. */
export function walletRows(f: Funnel): { wallet: string; counts: Record<string, number | null> }[] {
  const events: Step["event"][] = [
    "wallet_connect",
    "sign_requested",
    "sign_approved",
    "sign_rejected",
  ];
  const wallets = new Set<string>();
  for (const s of f.steps) for (const w of Object.keys(s.by_wallet ?? {})) wallets.add(w);
  const rows = [...wallets].map((wallet) => {
    const counts: Record<string, number | null> = {};
    for (const e of events) {
      const s = f.steps.find((x) => x.event === e);
      counts[e] = s ? ((s.by_wallet?.[wallet] as number | null | undefined) ?? 0) : 0;
    }
    return { wallet, counts };
  });
  return rows.sort((a, b) => (b.counts.wallet_connect ?? -1) - (a.counts.wallet_connect ?? -1));
}

export function WalletFunnelView({ funnel }: { funnel: Funnel }) {
  const rows = funnelRows(funnel);
  const wallets = walletRows(funnel);
  const rejected = funnel.steps.find((s) => s.event === "sign_rejected");
  const errorClasses = Object.entries(rejected?.by_property?.error_class ?? {});
  const others = funnel.steps.filter(
    (s) => !FUNNEL_ORDER.includes(s.event) && s.event !== "sign_rejected",
  );
  const get = (e: Step["event"]) => rows.find((r) => r.event === e)?.count ?? null;
  const connects = get("wallet_connect");
  const requested = get("sign_requested");
  const approved = get("sign_approved");
  const submitted = get("tx_submitted");
  const totalConnects = wallets.reduce((a, w) => a + (w.counts.wallet_connect ?? 0), 0);
  const rejTotal = errorClasses.reduce((a, [, v]) => a + ((v as number | null) ?? 0), 0);
  return (
    <>
      <section className="um-grid um-g4" aria-label="Summary">
        <Kpi tone="wallet" icon="link" label="Connects" value={fmtCount(connects)} />
        <Kpi
          tone="wallet"
          icon="pen"
          label="Signatures approved"
          value={fmtCount(approved)}
          foot={
            requested && approved !== null
              ? `${fmtShare(approved / requested)} of requests`
              : undefined
          }
        />
        <Kpi
          tone="wallet"
          icon="alert"
          label="Connect failures"
          value={null}
          foot={
            <>
              Failed connects by reason <Coming what="Wallet connect failures" />
            </>
          }
        />
        <Kpi
          tone="wallet"
          icon="activity"
          label="Transactions submitted"
          value={fmtCount(submitted)}
          foot="Successful transaction submissions"
        />
      </section>
      {funnel.daily.length > 0 ? (
        <Card
          title="Over time"
          sub="Daily counts, per UTC day"
          actions={
            <Legend
              items={[
                { label: "Connects", color: "ink" },
                { label: "Signatures", color: "yellowdeep" },
                { label: "Transactions", color: "webmid", dash: true },
              ]}
            />
          }
        >
          <Chart
            partial={partialLast(funnel.daily.map((d) => d.day))}
            height={220}
            label="Wallet connects, signatures approved and successful transactions per day"
            labels={funnel.daily.map((d) => axisLabel(d.day))}
            series={[
              {
                name: "Connects",
                color: "ink",
                data: funnel.daily.map((d) => d.wallet_connect),
                area: true,
              },
              {
                name: "Signatures approved",
                color: "yellowdeep",
                data: funnel.daily.map((d) => d.sign_approved),
              },
              {
                name: "Transactions",
                color: "webmid",
                data: funnel.daily.map((d) => d.tx_submitted_success),
                dash: true,
                thin: true,
              },
            ]}
            table={{
              title: "Daily counts",
              firstColumn: "Day (UTC)",
              rows: funnel.daily.map((d) => fmtDay(`${d.day}T00:00:00Z`)),
              format: (v) => fmtCount(v),
            }}
            testId="funnel-daily"
          />
        </Card>
      ) : null}
      <section className="um-grid um-g21">
        <Card
          title="Connect funnel"
          sub="From opening the wallet picker to a submitted transaction"
          data-testid="funnel"
        >
          <FunnelBars
            label="Wallet funnel"
            color="ink"
            dropWord="dropped"
            steps={rows.map((r) => ({
              key: r.event,
              name: EVENT_TEXT[r.event],
              code: r.event,
              value: r.count,
              nullText: "withheld",
              testId: `funnel-${r.event}`,
            }))}
          />
          <p className="um-p-fine">
            Each step is a count of events per UTC day, summed over the range — not the same people
            moving through every step. “Transaction submitted” counts only transactions that
            succeeded.
          </p>
        </Card>
        <Card title="By wallet" sub="Share of connects" data-testid="funnel-wallets">
          {wallets.length === 0 ? (
            <EmptyState plain title="No wallet events with a wallet type in this range" />
          ) : (
            <BarList
              label="Connects by wallet"
              rows={wallets.map((w) => ({
                key: w.wallet,
                label: WALLET_TEXT[w.wallet] ?? w.wallet,
                value: fmtCount(w.counts.wallet_connect),
                share:
                  totalConnects > 0 ? ((w.counts.wallet_connect ?? 0) / totalConnects) * 100 : null,
              }))}
            />
          )}
        </Card>
      </section>
      {wallets.length > 0 ? (
        <Card title="Signatures by wallet" flush>
          <TableScroll label="Wallet events by wallet type">
            <table className="um-table">
              <caption className="um-sr">Wallet events by wallet type</caption>
              <thead>
                <tr>
                  <th scope="col">Wallet</th>
                  <th scope="col" className="um-r">
                    Connected
                  </th>
                  <th scope="col" className="um-r">
                    Signatures requested
                  </th>
                  <th scope="col" className="um-r">
                    Approved
                  </th>
                  <th scope="col" className="um-r">
                    Rejected
                  </th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((w) => (
                  <tr key={w.wallet} data-testid={`wallet-${w.wallet}`}>
                    <th scope="row">{WALLET_TEXT[w.wallet] ?? w.wallet}</th>
                    <td className="um-r">{fmtCount(w.counts.wallet_connect)}</td>
                    <td className="um-r">{fmtCount(w.counts.sign_requested)}</td>
                    <td className="um-r">{fmtCount(w.counts.sign_approved)}</td>
                    <td className="um-r">{fmtCount(w.counts.sign_rejected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}
      <section className="um-grid um-g3">
        <Card
          title="Why signatures are rejected"
          sub={`${fmtCount(rejected?.count as number | null)} rejected`}
        >
          {errorClasses.length === 0 ? (
            <EmptyState plain title="No rejected signatures" />
          ) : (
            <>
              <BarList
                label="Rejection reasons"
                rows={errorClasses.map(([k, v]) => ({
                  key: k,
                  label: k.replaceAll("_", " "),
                  value: fmtCount(v as number | null),
                  share: rejTotal > 0 ? (((v as number | null) ?? 0) / rejTotal) * 100 : null,
                }))}
              />
              <p className="um-sr" data-testid="funnel-rejections">
                Signatures rejected: {fmtCount(rejected?.count as number | null)} (
                {errorClasses
                  .map(([k, v]) => `${k.replaceAll("_", " ")} ${fmtCount(v as number | null)}`)
                  .join(" · ")}
                )
              </p>
            </>
          )}
        </Card>
        <Card title="Why connects fail" actions={<Coming what="Failed connects by reason" />}>
          <EmptyState plain title="Coming to the API" icon="clock">
            The tracker records failed connects with their reason; the dashboard shows them once the
            API serves them.
          </EmptyState>
        </Card>
        <Card
          title="WalletConnect funnel"
          sub="Mobile wallets connecting through a QR code or deep link"
          actions={<Coming what="WalletConnect funnel" />}
        >
          <EmptyState plain title="Coming to the API" icon="clock">
            WalletConnect sessions and requests are recorded; this funnel appears once the API
            serves them.
          </EmptyState>
        </Card>
      </section>
      {others.length > 0 ? (
        <Card title="Other wallet events" headingLevel={3}>
          <ul className="um-p-mlist">
            {others.map((s) => (
              <li key={s.event}>
                <span />
                <span>
                  {EVENT_TEXT[s.event]}: <b>{fmtCount(s.count as number | null)}</b>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

const NETWORK_TEXT: Record<FunnelNetwork, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
  all: "All networks",
};

export function WalletFunnelPage() {
  const { tenantId, siteId } = useParams({ from: "/app/t/$tenantId/sites/$siteId/wallets" });
  const search = useSearch({ from: "/app/t/$tenantId/sites/$siteId/wallets" });
  const navigate = useNavigate();
  const site = useSite(tenantId, siteId);
  useTitle(site.data ? `Wallets · ${site.data.name}` : "Wallets");
  const span = presetSpan(search.range);
  const set = (s: Partial<WalletSearch>) =>
    void navigate({
      to: "/t/$tenantId/sites/$siteId/wallets",
      params: { tenantId, siteId },
      search: { ...search, ...s },
      replace: true,
    });
  const funnel = useQuery({
    queryKey: [
      "wallet-funnel",
      tenantId,
      siteId,
      span.start,
      span.end,
      search.network,
      search.variant,
    ],
    queryFn: () =>
      api.call("getSiteWalletFunnel", {
        path: { tenantId, siteId },
        query: {
          start: span.start,
          end: span.end,
          network: search.network,
          variant: search.variant,
        },
      }),
  });
  const onchain = useQuery({
    queryKey: ["onchain-daily", tenantId, span.start, span.end],
    enabled: search.network !== "all",
    queryFn: () =>
      api.call("getOnchainDaily", {
        path: { tenantId },
        query: { start: span.start, end: span.end },
      }),
  });
  const chain = search.network === "all" ? null : onchainTotals(onchain.data ?? [], search.network);
  return (
    <>
      <RangePicker value={search.range} options={DAY_PRESETS} onChange={(r) => set({ range: r })} />
      <div className="um-p-tools">
        <Segmented
          label="Network"
          value={search.network}
          onChange={(v) => set({ network: v })}
          options={(["mainnet", "testnet", "all"] as const).map((n) => ({
            value: n,
            label: NETWORK_TEXT[n],
          }))}
        />
        <Segmented
          label="Events"
          value={search.variant}
          onChange={(v) => set({ variant: v })}
          options={[
            { value: "verified", label: "Verified" },
            { value: "raw", label: "Verified and suspect" },
          ]}
        />
        {funnel.data ? (
          <span className="um-p-fine" data-testid="funnel-range">
            <b>{fmtRange(funnel.data.range.start, funnel.data.range.end)}</b> ·{" "}
            {NETWORK_TEXT[funnel.data.network as FunnelNetwork] ?? funnel.data.network}
          </span>
        ) : null}
      </div>
      {funnel.error ? (
        <ErrorState error={funnel.error} onRetry={() => void funnel.refetch()} />
      ) : funnel.data ? (
        <WalletFunnelView funnel={funnel.data} />
      ) : (
        <LoadingState block />
      )}
      {chain ? (
        <Card
          title={`On the ledger (${NETWORK_TEXT[search.network]}), beside the funnel`}
          tone="chain"
          data-testid="funnel-onchain"
        >
          {onchain.error ? <ErrorState error={onchain.error} plain /> : null}
          {chain.verifiedContracts === 0 ? (
            <p className="um-muted">
              No verified contract with activity on this network in this range.
            </p>
          ) : (
            <p>
              {fmtInt(chain.invocations)} invocations of {chain.verifiedContracts} verified contract
              {chain.verifiedContracts === 1 ? "" : "s"}, {fmtInt(chain.invokersDailySum)} daily
              invokers (sum).
            </p>
          )}
          <p className="um-p-fine">
            Day-level counts from the public ledger, never joined to visitors: they are not a step
            of the funnel above.
          </p>
        </Card>
      ) : null}
      <Note icon="shield">
        <p data-testid="funnel-note">
          <b>Daily counts.</b> Wallet events are counted per UTC day, by wallet type and network —
          no wallet address, transaction hash or amount is ever collected. Signing, sending,
          smart-wallet and passkey events are counted only; they never enter a visit. Events from
          dev origins are never counted.
        </p>
      </Note>
    </>
  );
}
