// SPDX-License-Identifier: Apache-2.0
// "RPC calls from your users' browsers (daily totals)" on the site dashboard (tracker 1.2.0, `/stellar-rpc`;
// wire-formats §a.3.2; getSiteBrowserRpc, migration 0086): the Stellar RPC and Horizon calls the site's own web app
// made from its visitors' browsers, per UTC day, per RPC method or Horizon route, with outcome classes and latency
// buckets. Aggregate only — there is no visitor, session, page, URL or address behind these numbers — and stated as
// never page views and never API usage.

import { useQuery } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { api } from "../api/client.ts";
import { fmtInt, fmtPct } from "../lib/format.ts";
import {
  Card,
  Chart,
  CodeBlock,
  EmptyState,
  ErrorState,
  fmtCompact,
  Kpi,
  Legend,
  LoadingState,
  Note,
  partialLast,
  TableScroll,
} from "./ui/index.ts";

type Report = ControlPlane.BrowserRpcReport;
type Operation = Report["operations"][number];

const DAY_MS = 86_400_000;
/** The endpoint serves at most 400 days. */
export const MAX_DAYS = 400;

const OUTCOME_TEXT: Record<string, string> = {
  ok: "ok",
  rpc_error: "JSON-RPC error",
  http_4xx: "HTTP 4xx",
  http_429: "HTTP 429 (rate limited)",
  http_5xx: "HTTP 5xx",
  timeout: "timeout",
  network_error: "network error",
};
export const rpcOutcomeLabel = (o: string): string => OUTCOME_TEXT[o] ?? o;

const LATENCY: Array<[keyof Operation["latency"], string]> = [
  ["lt100ms", "< 100 ms"],
  ["100_500ms", "100–500 ms"],
  ["500_2000ms", "0.5–2 s"],
  ["gt2000ms", "> 2 s"],
];

/** Horizon path segments that contain an underscore (or are written with a hyphen in the URL). */
const SEGMENTS: Record<string, string> = {
  claimable_balances: "claimable_balances",
  liquidity_pools: "liquidity_pools",
  fee_stats: "fee_stats",
  order_book: "order_book",
  trade_aggregations: "trade_aggregations",
  transactions_async: "transactions_async",
  strict_receive: "strict-receive",
  strict_send: "strict-send",
};

/** `send_transaction` → `sendTransaction`; Horizon `accounts_id_data_key` → `/accounts/{id}/data/{key}`. */
export function operationLabel(api: "rpc" | "horizon", op: string): string {
  if (op === "other") return api === "rpc" ? "other methods" : "other routes";
  if (api === "rpc") return op.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  if (op === "root") return "/";
  const words = op.split("_");
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = `${words[i]}_${words[i + 1]}`;
    if (i + 1 < words.length && SEGMENTS[pair]) {
      out.push(SEGMENTS[pair]);
      i++;
    } else
      out.push(words[i] === "id" ? "{id}" : words[i] === "key" ? "{key}" : (words[i] as string));
  }
  return `/${out.join("/")}`;
}

/** Whole UTC days around a dashboard range, at most MAX_DAYS ending at the range's end. */
export function dayWindow(
  start: string,
  end: string,
): { start: string; end: string; clipped: boolean } {
  const e = Math.ceil(Date.parse(end) / DAY_MS) * DAY_MS;
  let s = Math.floor(Date.parse(start) / DAY_MS) * DAY_MS;
  if (e <= s) s = e - DAY_MS;
  const clipped = e - s > MAX_DAYS * DAY_MS;
  if (clipped) s = e - MAX_DAYS * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { start: iso(s), end: iso(e), clipped };
}

const LAT_CLASS = ["um-c-webmid", "um-c-weblight", "um-c-apilight", "um-c-bad"];

function LatencySplit({ l }: { l: Operation["latency"] }) {
  const total = LATENCY.reduce((a, [k]) => a + l[k], 0);
  let acc = 0;
  return (
    <span className="um-p-lat">
      <svg className="um-p-latbar" aria-hidden="true" preserveAspectRatio="none">
        {total > 0
          ? LATENCY.map(([k], i) => {
              const w = (l[k] / total) * 100;
              const r = (
                <rect
                  key={k}
                  className={LAT_CLASS[i]}
                  x={`${acc}%`}
                  width={`${w}%`}
                  height="100%"
                />
              );
              acc += w;
              return r;
            })
          : null}
      </svg>
      <span className="um-p-fine" aria-hidden="true">
        {LATENCY.map(([k]) => fmtInt(l[k])).join(" · ")}
      </span>
      <span className="um-sr">{LATENCY.map(([k, t]) => `${t} ${fmtInt(l[k])}`).join(" · ")}</span>
    </span>
  );
}

function OperationTable({
  caption,
  rows,
  testId,
}: {
  caption: string;
  rows: Operation[];
  testId: string;
}) {
  if (rows.length === 0) return null;
  return (
    <Card title={caption} flush data-testid={testId}>
      <TableScroll label={caption}>
        <table className="um-table">
          <caption className="um-sr">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{rows[0]?.api === "rpc" ? "Method" : "Route"}</th>
              <th scope="col" className="um-r">
                Calls
              </th>
              <th scope="col" className="um-r">
                Errors
              </th>
              <th scope="col">Outcomes</th>
              <th scope="col">Latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.api}|${r.operation}`}>
                <td>
                  <code>{operationLabel(r.api, r.operation)}</code>
                </td>
                <td className="um-r">{fmtInt(r.calls)}</td>
                <td className="um-r">{r.calls > 0 ? fmtPct(r.errors / r.calls) : "—"}</td>
                <td className="um-p-fine">
                  {r.outcomes.map((o, i) => (
                    <span key={o.outcome}>
                      {i > 0 ? " · " : null}
                      {rpcOutcomeLabel(o.outcome)} {fmtInt(o.count)}
                    </span>
                  ))}
                </td>
                <td>
                  <LatencySplit l={r.latency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Card>
  );
}

export const RPC_SNIPPET = `import { attachRpcTelemetry, attachHorizonTelemetry } from "@usagemap/tracker/stellar-rpc";
attachRpcTelemetry(rpcServer, { network: "testnet" });
attachHorizonTelemetry(horizonServer, { network: "testnet" });`;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;

export function BrowserRpcView({ data }: { data: Report }) {
  if (data.totals.calls === 0)
    return (
      <Card>
        <div data-testid="browser-rpc-empty">
          <EmptyState title="No Stellar calls from browsers yet" icon="network">
            No Stellar RPC or Horizon calls from your visitors' browsers in this range. With tracker
            1.2.0, attach the aggregate counter to the SDK servers your web app already uses:
          </EmptyState>
          <CodeBlock title="src/stellar.ts" code={RPC_SNIPPET} />
          <p className="um-p-fine">
            The tracker sends one aggregate per page: counts per method or route, outcome and
            latency bucket. No URL (provider API keys stay in the browser), address, page or visitor
            is ever sent.
          </p>
        </div>
      </Card>
    );
  const { totals } = data;
  return (
    <>
      <section className="um-grid um-g4" aria-label="Totals" data-testid="browser-rpc-totals">
        <Kpi tone="neutral" icon="activity" label="Calls" value={fmtInt(totals.calls)} />
        <Kpi tone="neutral" icon="server" label="Stellar RPC" value={fmtInt(totals.rpc)} />
        <Kpi tone="neutral" icon="landmark" label="Horizon" value={fmtInt(totals.horizon)} />
        <Kpi
          tone="neutral"
          icon="alert"
          label="Errors"
          value={fmtPct(totals.errors / totals.calls).replace(/ ?%$/, "")}
          unit="%"
          foot={data.networks.map((n) => `${n.network} ${fmtInt(n.calls)}`).join(" · ")}
        />
      </section>
      <Card
        title="Calls per day"
        sub="Made by visitors' browsers. Totals only, never per visitor."
        actions={
          <Legend
            items={[
              { label: "RPC", color: "ink2" },
              { label: "Horizon", color: "line" },
            ]}
          />
        }
      >
        <Chart
          partial={partialLast(data.daily.map((d) => d.day))}
          type="bar"
          stack
          height={210}
          label="Stellar RPC and Horizon calls per day from browsers"
          labels={data.daily.map((d) => dayLabel(d.day))}
          series={[
            { name: "Stellar RPC", color: "ink2", data: data.daily.map((d) => d.rpc) },
            { name: "Horizon", color: "line", data: data.daily.map((d) => d.horizon) },
          ]}
          format={fmtCompact}
        />
      </Card>
      <OperationTable
        caption="Stellar RPC methods"
        rows={data.operations.filter((o) => o.api === "rpc")}
        testId="browser-rpc-methods"
      />
      <OperationTable
        caption="Horizon routes"
        rows={data.operations.filter((o) => o.api === "horizon")}
        testId="browser-rpc-routes"
      />
      <Note>
        Errors: every outcome but ok (JSON-RPC error, HTTP 4xx/429/5xx, timeout, network failure).
        Latency split: under 100 ms · 100–500 ms · 0.5–2 s · over 2 s, measured in the visitor's
        browser, so it includes their connection.
      </Note>
    </>
  );
}

/** The "Stellar calls from the browser" tab of the Web page. */
export function BrowserRpcPanel({
  tenantId,
  siteId,
  range,
  variant,
}: {
  tenantId: string;
  siteId: string;
  /** whole UTC days, or a range the panel widens to them */
  range: { start: string; end: string };
  variant: "verified" | "raw";
}) {
  const w = dayWindow(range.start, range.end);
  const q = useQuery({
    queryKey: ["browser-rpc", tenantId, siteId, w.start, w.end, variant],
    queryFn: () =>
      api.call("getSiteBrowserRpc", {
        path: { tenantId, siteId },
        query: { start: w.start, end: w.end, variant },
      }),
  });
  return (
    <section
      className="um-p-stack"
      aria-label="RPC calls from your users' browsers (daily totals)"
      data-testid="browser-rpc"
    >
      <h2 className="um-sr">RPC calls from your users' browsers (daily totals)</h2>
      <p className="um-p-fine">
        Stellar RPC and Horizon calls your web app made from visitors' browsers, counted by the
        tracker as daily totals per method or route — never linked to a visitor, session or page.
        These are not page views and not API usage.
        {w.clipped ? ` Showing the last ${MAX_DAYS} days of the range.` : ""}
      </p>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <BrowserRpcView data={q.data} />
      ) : (
        <LoadingState block />
      )}
    </section>
  );
}
