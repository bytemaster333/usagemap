// SPDX-License-Identifier: Apache-2.0
// "Stellar RPC & Horizon (from your backend)" on the tenant API dashboard (register C-153): the calls the tenant's
// backend made to Stellar RPC and Horizon, recorded by @usagemap/stellar-otel — per RPC method and Horizon route
// template: calls, errors, p50/p95 with their accuracy class, outcome classes — plus transaction submission, poll and
// simulation outcomes. Dependency health of the backend: stated as never API usage, never in the request figures.

import { useQuery } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import { useId } from "react";
import { api } from "../api/client.ts";
import { accuracyLabel, fmtMs, fmtRate } from "../lib/apiFormat.ts";
import { fmtInt } from "../lib/format.ts";
import { ProblemAlert } from "./ProblemAlert.tsx";

type Metrics = ControlPlane.StellarClientMetrics;
type Calls = ControlPlane.StellarClientCalls;
type TxCount = ControlPlane.StellarClientTxCount;

/** Plain-language outcome labels; anything else is shown as its code. */
const OUTCOME_TEXT: Record<string, string> = {
  ok: "ok",
  timeout: "timeout",
  network: "network error",
  _OTHER: "other",
  "-32700": "parse error (-32700)",
  "-32600": "invalid request (-32600)",
  "-32601": "method not found (-32601)",
  "-32602": "invalid params (-32602)",
  "-32603": "internal error (-32603)",
};
export function outcomeLabel(o: string): string {
  return OUTCOME_TEXT[o] ?? (/^\d{3}$/.test(o) ? `HTTP ${o}` : o);
}

function Outcomes({ items }: { items: Calls["outcomes"] }) {
  return (
    <span className="small">
      {items.map((o, i) => (
        <span key={o.outcome}>
          {i > 0 ? " · " : null}
          {outcomeLabel(o.outcome)} {fmtInt(o.count)}
        </span>
      ))}
    </span>
  );
}

function CallsCells({ r }: { r: Calls }) {
  return (
    <>
      <td className="num">{fmtInt(r.calls)}</td>
      <td className="num">{fmtRate(r.error_rate)}</td>
      <td className="num">{fmtMs(r.p50_ms, r.accuracy_class)}</td>
      <td className="num">{fmtMs(r.p95_ms, r.accuracy_class)}</td>
      <td>
        <Outcomes items={r.outcomes} />
      </td>
    </>
  );
}

const CALL_HEADERS = ["Calls", "Errors", "p50", "p95"];

function CallHead({ first }: { first: string[] }) {
  return (
    <thead>
      <tr>
        {first.map((h) => (
          <th scope="col" key={h}>
            {h}
          </th>
        ))}
        {CALL_HEADERS.map((h) => (
          <th scope="col" className="num" key={h}>
            {h}
          </th>
        ))}
        <th scope="col">Outcomes</th>
      </tr>
    </thead>
  );
}

function TxTable({ caption, rows, testId }: { caption: string; rows: TxCount[]; testId: string }) {
  if (rows.length === 0) return null;
  return (
    <table data-testid={testId}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Network</th>
          <th scope="col">Via</th>
          <th scope="col">Status</th>
          <th scope="col">Result</th>
          <th scope="col" className="num">
            Count
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.network}|${r.via}|${r.status}|${r.result_class}`}>
            <td>{r.network}</td>
            <td>{r.via ?? "—"}</td>
            <td>
              <code>{r.status}</code>
            </td>
            <td>{r.result_class ? <code>{r.result_class}</code> : "—"}</td>
            <td className="num">{fmtInt(r.count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StellarClientView({ data }: { data: Metrics }) {
  const { submissions, polls, simulations } = data.transactions;
  const empty =
    data.rpc_methods.length === 0 &&
    data.horizon_routes.length === 0 &&
    submissions.length + polls.length + simulations.length === 0;
  if (empty)
    return (
      <div data-testid="stellar-client-empty">
        <p className="muted">
          No Stellar RPC or Horizon calls from this service in the range. Add{" "}
          <code>@usagemap/stellar-otel</code> to your backend and wrap your SDK servers:
        </p>
        <pre>
          <code>{`import { instrumentStellarRpc, instrumentHorizon } from "@usagemap/stellar-otel";
instrumentStellarRpc(rpcServer, { network: "testnet" });
instrumentHorizon(horizonServer, { network: "testnet" });`}</code>
        </pre>
        <p className="small muted">
          It records with your own OpenTelemetry MeterProvider and the same OTLP export as your API
          metrics; no URL, address, hash, key or error text is ever recorded.
        </p>
      </div>
    );
  const multiNet = data.networks.length > 1;
  return (
    <>
      {data.rpc_methods.length > 0 ? (
        <table data-testid="stellar-rpc-table">
          <caption>Stellar RPC methods</caption>
          <CallHead first={multiNet ? ["Network", "Method"] : ["Method"]} />
          <tbody>
            {data.rpc_methods.map((r) => (
              <tr key={`${r.network}|${r.method}`}>
                {multiNet ? <td>{r.network}</td> : null}
                <td>
                  <code>{r.method}</code>
                </td>
                <CallsCells r={r} />
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {data.horizon_routes.length > 0 ? (
        <table data-testid="stellar-horizon-table">
          <caption>Horizon routes</caption>
          <CallHead first={multiNet ? ["Network", "Route"] : ["Route"]} />
          <tbody>
            {data.horizon_routes.map((r) => (
              <tr key={`${r.network}|${r.http_method}|${r.route}`}>
                {multiNet ? <td>{r.network}</td> : null}
                <td>
                  <code>
                    {r.http_method ? `${r.http_method} ` : ""}
                    {r.route}
                  </code>
                </td>
                <CallsCells r={r} />
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <TxTable caption="Transaction submissions" rows={submissions} testId="stellar-submissions" />
      <TxTable caption="Transaction polls (getTransaction)" rows={polls} testId="stellar-polls" />
      {simulations.length > 0 ? (
        <table data-testid="stellar-simulations">
          <caption>Simulations</caption>
          <thead>
            <tr>
              <th scope="col">Network</th>
              <th scope="col">Outcome</th>
              <th scope="col">Error class</th>
              <th scope="col" className="num">
                Count
              </th>
            </tr>
          </thead>
          <tbody>
            {simulations.map((r) => (
              <tr key={`${r.network}|${r.outcome}|${r.error_class}`}>
                <td>{r.network}</td>
                <td>
                  <code>{r.outcome}</code>
                </td>
                <td>{r.error_class ? <code>{r.error_class}</code> : "—"}</td>
                <td className="num">{fmtInt(r.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="small muted">
        Percentile accuracy:{" "}
        {[...new Set([...data.rpc_methods, ...data.horizon_routes].map((r) => r.accuracy_class))]
          .map((a) => accuracyLabel(a))
          .join(", ") || accuracyLabel(null)}
        . Errors: any JSON-RPC error, HTTP status ≥ 400, timeout or network failure.
      </p>
    </>
  );
}

export function StellarClientPanel({
  tenantId,
  serviceId,
  query,
}: {
  tenantId: string;
  serviceId: string;
  query: Record<string, string | undefined>;
}) {
  const id = useId();
  const q = useQuery({
    queryKey: ["stellar-client", tenantId, serviceId, query],
    queryFn: () =>
      api.call("getStellarClientMetrics", {
        path: { tenantId, serviceId },
        query: query as never,
      }),
  });
  return (
    <section className="card" aria-labelledby={`${id}-h`} data-testid="stellar-client">
      <h2 id={`${id}-h`}>Stellar RPC &amp; Horizon (from your backend)</h2>
      <p className="small muted">
        Calls this service made to Stellar RPC and Horizon, as your backend saw them (self-attested
        telemetry). This is the health of your Stellar dependencies — it is not API usage and is
        never counted in the request figures above.
      </p>
      <ProblemAlert error={q.error} />
      {q.data ? (
        <StellarClientView data={q.data} />
      ) : q.isLoading ? (
        <p className="muted">Loading…</p>
      ) : null}
    </section>
  );
}
