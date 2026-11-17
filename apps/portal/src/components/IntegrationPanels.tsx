// SPDX-License-Identifier: Apache-2.0
// Integration panels (migration 0085 / 0084):
//   - "Partner APIs" and "Payments" on the API dashboard of a service (@usagemap/partner-otel, payments-otel);
//   - "Anchor funnel" (wallet side from @usagemap/anchor-otel, anchor side from tools/ap-listener) and
//     "App events (self-attested)" (native apps, Mini Apps) on the project overview.
// All of it is self-attested telemetry of the tenant's own systems, stated as such and never part of the API or web
// figures. The tenant's own view is exact (nothing leaves the tenant, so no small-count floor). Charts reuse the
// hand-made LineChart; every chart has its data table as the text alternative there, every list is a table here.

import { useQuery } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { type ReactNode, useId } from "react";
import { api } from "../api/client.ts";
import { accuracyLabel, fmtMs, fmtRate } from "../lib/apiFormat.ts";
import { fmtInt } from "../lib/format.ts";
import { LineChart } from "./LineChart.tsx";
import { ProblemAlert } from "./ProblemAlert.tsx";

type Query = Record<string, string | undefined>;
type PartnerCalls = ControlPlane.PartnerCalls;
type PaymentEvents = ControlPlane.PaymentEvents;
type AnchorFunnel = ControlPlane.AnchorFunnel;
type AppEvents = ControlPlane.AppEvents;

const fmtInt0 = (v: number | null) => (v === null ? "—" : fmtInt(v));

/** Seconds as a short human duration (mean time in a status, transfer duration). */
export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86_400).toFixed(1)} d`;
}

/** Share of the first step, for a funnel row (counts of events, not of people). */
export function shareOf(n: number, first: number): string {
  return first > 0 ? `${Math.round((n / first) * 100)} %` : "—";
}

function Panel({
  testId,
  title,
  intro,
  error,
  loading,
  children,
}: {
  testId: string;
  title: string;
  intro: ReactNode;
  error: unknown;
  loading: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-h`} data-testid={testId}>
      <h2 id={`${id}-h`}>{title}</h2>
      <p className="small muted">{intro}</p>
      <ProblemAlert error={error} />
      {loading ? <p className="muted">Loading…</p> : children}
    </section>
  );
}

function Empty({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <p className="muted" data-testid={testId}>
      {children}
    </p>
  );
}

// ------------------------------------------------------------------------------------------------ partner APIs

export function PartnerCallsView({ data }: { data: PartnerCalls }) {
  if (data.operations.length === 0)
    return (
      <Empty testId="partner-calls-empty">
        No partner-API calls reported in this range. Wrap your backend's <code>fetch</code> with{" "}
        <code>@usagemap/partner-otel</code> to see them here.
      </Empty>
    );
  const unit = data.range.resolution === "1h" ? "hour" : "day";
  return (
    <>
      <LineChart
        title="Partner-API calls and errors"
        unit={unit}
        format={fmtInt0}
        series={[
          { name: "Calls", points: data.series.map((p) => ({ t: p.t, v: p.calls })) },
          { name: "Errors", points: data.series.map((p) => ({ t: p.t, v: p.errors })) },
        ]}
      />
      <table data-testid="partner-calls-table">
        <caption className="sr-only">Calls per partner route</caption>
        <thead>
          <tr>
            <th scope="col">Partner</th>
            <th scope="col">Route</th>
            <th scope="col">Network</th>
            <th scope="col" className="num">
              Calls
            </th>
            <th scope="col" className="num">
              Error rate
            </th>
            <th scope="col" className="num">
              p50
            </th>
            <th scope="col" className="num">
              p95
            </th>
            <th scope="col">Outcomes</th>
          </tr>
        </thead>
        <tbody>
          {data.operations.map((o) => (
            <tr key={`${o.partner}|${o.operation}|${o.network}`}>
              <td>{o.partner}</td>
              <td>
                <code>{o.operation}</code>
              </td>
              <td>{o.network}</td>
              <td className="num">{fmtInt(o.calls)}</td>
              <td className="num">{fmtRate(o.error_rate)}</td>
              <td className="num">{fmtMs(o.p50_ms, o.accuracy_class)}</td>
              <td className="num">{fmtMs(o.p95_ms, o.accuracy_class)}</td>
              <td className="small">
                {o.outcomes
                  .map((x) => `${x.outcome.replaceAll("_", " ")} ${fmtInt(x.count)}`)
                  .join(" · ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        Percentile accuracy: {accuracyLabel(data.operations[0]?.accuracy_class ?? null)}. Errors:
        every outcome but success (4xx, auth, not found, rate limited, 5xx, timeout, network).
      </p>
    </>
  );
}

export function PartnerCallsPanel({
  tenantId,
  serviceId,
  query,
}: {
  tenantId: string;
  serviceId: string;
  query: Query;
}) {
  const q = useQuery({
    queryKey: ["partner-calls", tenantId, serviceId, query],
    queryFn: () =>
      api.call("getPartnerCalls", { path: { tenantId, serviceId }, query: query as never }),
  });
  return (
    <Panel
      testId="partner-calls"
      title="Partner APIs (from your backend)"
      intro="Calls this service made to partner APIs of the SCF Integration List, as your backend saw them (self-attested telemetry). Dependency health — never API usage, never in the request figures above."
      error={q.error}
      loading={q.isLoading}
    >
      {q.data ? <PartnerCallsView data={q.data} /> : null}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ payments

const STAGE_TEXT: Record<string, string> = {
  required: "Payment required (402 sent)",
  verified: "Verified",
  settled: "Settled (x402)",
  paid: "Paid (MPP)",
  failed: "Failed",
  canceled: "Canceled",
};

export function PaymentsView({ data }: { data: PaymentEvents }) {
  if (data.totals.events === 0)
    return (
      <Empty testId="payments-empty">
        No payment events reported in this range. Instrument your x402 or MPP server with{" "}
        <code>@usagemap/payments-otel</code> to see them here.
      </Empty>
    );
  const unit = data.range.resolution === "1h" ? "hour" : "day";
  const stages = (
    ["required", "verified", "settled", "paid", "failed", "canceled"] as const
  ).filter((s) => data.stages[s] > 0);
  return (
    <>
      <p data-testid="payments-totals">
        <strong>{fmtInt(data.totals.completed)}</strong> completed payments ·{" "}
        {fmtInt(data.totals.failed)} failed or canceled · success rate{" "}
        {fmtRate(data.totals.success_rate)}
      </p>
      <LineChart
        title="Payment events and failures"
        unit={unit}
        format={fmtInt0}
        series={[
          { name: "Events", points: data.series.map((p) => ({ t: p.t, v: p.events })) },
          { name: "Failed or canceled", points: data.series.map((p) => ({ t: p.t, v: p.failed })) },
        ]}
      />
      <div className="grid-2">
        <table data-testid="payments-stages">
          <caption>Stages</caption>
          <tbody>
            {stages.map((s) => (
              <tr key={s}>
                <th scope="row">{STAGE_TEXT[s]}</th>
                <td className="num">{fmtInt(data.stages[s])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table data-testid="payments-rails">
          <caption>Completed payments per rail</caption>
          <tbody>
            {data.rails.map((r) => (
              <tr key={`${r.protocol}|${r.rail}|${r.intent}|${r.network}`}>
                <th scope="row">
                  {r.protocol} {r.rail ?? ""} {r.intent ?? ""}{" "}
                  <span className="small muted">{r.network}</span>
                </th>
                <td className="num">{fmtInt(r.count)}</td>
              </tr>
            ))}
            {data.assets.map((a) => (
              <tr key={`asset-${a.asset}`}>
                <th scope="row">Asset {a.asset}</th>
                <td className="num">{fmtInt(a.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.amount_buckets.length > 0 ? (
        <p className="small" data-testid="payments-amounts">
          Amount classes (USD-equivalent, only when your server opted in):{" "}
          {data.amount_buckets
            .map(
              (b) =>
                `${b.bucket.replace("_", "–").replace("lt–", "< ").replace("ge–", "≥ ")} ${fmtInt(b.count)}`,
            )
            .join(" · ")}
        </p>
      ) : null}
      {data.failures.length > 0 ? (
        <table data-testid="payments-failures">
          <caption>Failures</caption>
          <thead>
            <tr>
              <th scope="col">Protocol</th>
              <th scope="col">Stage</th>
              <th scope="col">Reason</th>
              <th scope="col">Error type</th>
              <th scope="col" className="num">
                Events
              </th>
            </tr>
          </thead>
          <tbody>
            {data.failures.map((f) => (
              <tr key={`${f.protocol}|${f.stage}|${f.reason_class}|${f.error_type}`}>
                <td>{f.protocol}</td>
                <td>{f.stage}</td>
                <td>{f.reason_class.replaceAll("_", " ")}</td>
                <td>{f.error_type ? <code>{f.error_type}</code> : "—"}</td>
                <td className="num">{fmtInt(f.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

export function PaymentsPanel({
  tenantId,
  serviceId,
  query,
}: {
  tenantId: string;
  serviceId: string;
  query: Query;
}) {
  const q = useQuery({
    queryKey: ["payments", tenantId, serviceId, query],
    queryFn: () =>
      api.call("getPaymentEvents", { path: { tenantId, serviceId }, query: query as never }),
  });
  return (
    <Panel
      testId="payments"
      title="Payments (x402, MPP)"
      intro="Agent-payment events of this service's server (self-attested telemetry): no amount, payer, recipient or transaction is ever recorded. Not API usage."
      error={q.error}
      loading={q.isLoading}
    >
      {q.data ? <PaymentsView data={q.data} /> : null}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ anchor funnel

export function AnchorFunnelView({ data }: { data: AnchorFunnel }) {
  const w = data.wallet;
  const a = data.anchor;
  if (!w.reported && !a.reported)
    return (
      <Empty testId="anchor-funnel-empty">
        No anchor metrics reported in this range. Wallets: <code>@usagemap/anchor-otel</code>,
        anchors on Anchor Platform: <code>tools/ap-listener</code>.
      </Empty>
    );
  const flows = w.funnels.filter((f) => f.steps.some((s) => s.count > 0));
  return (
    <>
      {w.reported ? (
        <div data-testid="anchor-wallet">
          <h3>Wallet side</h3>
          {flows.map((f) => {
            const first = f.steps[0]?.count ?? 0;
            return (
              <table key={f.flow} data-testid={`anchor-funnel-${f.flow}`}>
                <caption>{f.flow[0]?.toUpperCase() + f.flow.slice(1)} funnel</caption>
                <tbody>
                  {f.steps.map((s) => (
                    <tr key={s.step}>
                      <th scope="row">{s.step}</th>
                      <td className="num">{fmtInt(s.count)}</td>
                      <td className="num small muted">{shareOf(s.count, first)}</td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">failed · refunded · expired</th>
                    <td className="num" colSpan={2}>
                      {fmtInt(f.failed)} · {fmtInt(f.refunded)} · {fmtInt(f.expired)}
                    </td>
                  </tr>
                </tbody>
              </table>
            );
          })}
          {w.anchors.length > 0 ? (
            <table data-testid="anchor-wallet-anchors">
              <caption>Per anchor</caption>
              <thead>
                <tr>
                  <th scope="col">Home domain</th>
                  <th scope="col" className="num">
                    Funnel events
                  </th>
                  <th scope="col" className="num">
                    SEP requests
                  </th>
                  <th scope="col" className="num">
                    Error rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {w.anchors.map((x) => (
                  <tr key={x.home_domain}>
                    <td>{x.home_domain === "_OTHER" ? "other anchors" : x.home_domain}</td>
                    <td className="num">{fmtInt(x.events)}</td>
                    <td className="num">{fmtInt(x.requests)}</td>
                    <td className="num">{fmtRate(x.error_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
      {a.reported ? (
        <div data-testid="anchor-side">
          <h3>Anchor side (Anchor Platform)</h3>
          <p>
            <strong>{fmtInt(a.transfers_created)}</strong> transfers created ·{" "}
            {fmtInt(a.quotes_created)} firm quotes
          </p>
          <div className="grid-2">
            <table>
              <caption>Statuses entered</caption>
              <tbody>
                {a.statuses.map((s) => (
                  <tr key={s.status}>
                    <th scope="row">{s.status.replaceAll("_", " ")}</th>
                    <td className="num">{fmtInt(s.entered)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>Mean time in status</caption>
              <tbody>
                {a.time_in_status.map((s) => (
                  <tr key={s.status}>
                    <th scope="row">{s.status.replaceAll("_", " ")}</th>
                    <td className="num">{fmtSeconds(s.mean_s)}</td>
                  </tr>
                ))}
                {a.durations.map((d) => (
                  <tr key={`${d.kind}|${d.final_status}`}>
                    <th scope="row">
                      {d.kind} start → {d.final_status}
                    </th>
                    <td className="num">{fmtSeconds(d.mean_s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {a.clients.length > 0 ? (
            <table data-testid="anchor-clients">
              <caption>Per client wallet</caption>
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col" className="num">
                    Transfers
                  </th>
                  <th scope="col" className="num">
                    Quotes
                  </th>
                  <th scope="col" className="num">
                    KYC updates
                  </th>
                </tr>
              </thead>
              <tbody>
                {a.clients.map((c) => (
                  <tr key={c.client ?? "_none"}>
                    <td>{c.client ?? "no client named"}</td>
                    <td className="num">{fmtInt(c.transfers)}</td>
                    <td className="num">{fmtInt(c.quotes)}</td>
                    <td className="num">{fmtInt(c.customer_updates)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
      <p className="small muted">
        Counts of events, not of people: nothing links two events of one user. Shares are of the
        first step.
      </p>
    </>
  );
}

export function AnchorFunnelPanel({ tenantId, query }: { tenantId: string; query: Query }) {
  const q = useQuery({
    queryKey: ["anchor-funnel", tenantId, query],
    queryFn: () => api.call("getAnchorFunnel", { path: { tenantId }, query: query as never }),
  });
  return (
    <Panel
      testId="anchor-funnel"
      title="Anchor funnel"
      intro="SEP-6/24/31 deposits and withdrawals as your wallet or your Anchor Platform reported them (self-attested telemetry): no amount, account, memo or KYC field is ever recorded."
      error={q.error}
      loading={q.isLoading}
    >
      {q.data ? <AnchorFunnelView data={q.data} /> : null}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ app events

export function AppEventsView({ data }: { data: AppEvents }) {
  if (data.totals.events === 0 && data.totals.sessions === 0)
    return (
      <Empty testId="app-events-empty">
        No app events in this range. Native apps and Telegram Mini Apps send them with the React
        Native or Flutter package.
      </Empty>
    );
  return (
    <>
      <p data-testid="app-events-totals">
        <strong>{fmtInt(data.totals.events)}</strong> events · {fmtInt(data.totals.sessions)}{" "}
        sessions (summed per day and edge node, an upper bound)
        {data.totals.dropped > 0 ? ` · ${fmtInt(data.totals.dropped)} dropped at the edge` : ""}
      </p>
      <LineChart
        title="App events and sessions per day"
        unit="day"
        format={fmtInt0}
        series={[
          {
            name: "Events",
            points: data.daily.map((d) => ({ t: `${d.day}T00:00:00Z`, v: d.events })),
          },
          {
            name: "Sessions",
            points: data.daily.map((d) => ({ t: `${d.day}T00:00:00Z`, v: d.sessions })),
          },
        ]}
      />
      <table data-testid="app-events-table">
        <caption className="sr-only">Events per platform</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col" className="num">
              iOS
            </th>
            <th scope="col" className="num">
              Android
            </th>
            <th scope="col" className="num">
              Web (Mini App)
            </th>
            <th scope="col" className="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {data.events.map((e) => (
            <tr key={e.event}>
              <td>
                <code>{e.event}</code>
              </td>
              <td className="num">{fmtInt(e.platforms.ios)}</td>
              <td className="num">{fmtInt(e.platforms.android)}</td>
              <td className="num">{fmtInt(e.platforms.web)}</td>
              <td className="num">{fmtInt(e.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.app_versions.length > 0 ? (
        <p className="small">
          App versions (sessions):{" "}
          {data.app_versions.map((v) => `${v.version} ${fmtInt(v.count)}`).join(" · ")}
        </p>
      ) : null}
    </>
  );
}

export function AppEventsPanel({ tenantId, query }: { tenantId: string; query: Query }) {
  const q = useQuery({
    queryKey: ["app-events", tenantId, query],
    queryFn: () => api.call("getAppEvents", { path: { tenantId }, query: query as never }),
  });
  return (
    <Panel
      testId="app-events"
      title="App events (self-attested)"
      intro="Events your native apps and Mini Apps sent. An app cannot run the browser's proof of work, so none of this is verified and none of it counts in the web figures, the trust score or snapshots."
      error={q.error}
      loading={q.isLoading}
    >
      {q.data ? <AppEventsView data={q.data} /> : null}
    </Panel>
  );
}
