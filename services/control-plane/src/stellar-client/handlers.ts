// SPDX-License-Identifier: Apache-2.0
// Stellar SDK client metrics of one service (register C-153; migration 0080; wire-formats §f.5 step 4a, §g.7): what
// the tenant's backend saw when it called Stellar RPC and Horizon through @usagemap/stellar-otel — volume,
// p50/p95 and outcome classes per RPC method and per Horizon route template, and the transaction submission, poll
// and simulation outcomes. Outbound dependency health of the tenant's backend: never API usage, never part of the
// API figures, the trust score or any snapshot.
//
// Reads run under the tenant's context (scf_app, RLS) over scf.stellar_client_{1m,1h,1d}. Histograms are explicit15
// (data-model §9.1) and merged before the percentile is computed (C-103), with the same quantile function and
// accuracy classes as the API metrics.

import { planApiRange, type Resolution } from "../api/metrics.ts";
import { loadService, visibleTenant } from "../api/services.ts";
import type { Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { iso, type Span } from "../web/range.ts";

const TABLE: Record<Resolution, string> = {
  "1m": "scf.stellar_client_1m",
  "1h": "scf.stellar_client_1h",
  "1d": "scf.stellar_client_1d",
};
export const LABEL = "self-attested telemetry";
/** Rows per list: the closed sets give at most 14 RPC methods and 51 Horizon templates per network. */
export const MAX_ROWS = 200;

const RPC = "rpc.client.call.duration";
const HTTP = "http.client.request.duration";

interface DurationRow extends Record<string, unknown> {
  network: string;
  operation: string;
  variant: string;
  calls: string;
  errors: string;
  sum_s: number;
  p50_s: number | null;
  p95_s: number | null;
  accuracy_class: string | null;
  outcomes: Array<{ outcome: string; count: number }>;
}

interface CounterRow extends Record<string, unknown> {
  metric: string;
  network: string;
  operation: string;
  variant: string;
  outcome: string;
  n: string;
}

/**
 * Per (network, operation, variant): calls, errors, merged-histogram p50/p95 and the outcome breakdown. An error is
 * any non-empty outcome for RPC (a JSON-RPC code, an HTTP status ≥ 400, `timeout`, `network`, `_OTHER`), and for
 * Horizon an outcome that is not a 1xx–3xx status.
 */
const DURATION_SQL = (table: string) => `
  WITH m AS (
    SELECT * FROM ${table}
     WHERE tenant_id = $1 AND service_id = $2 AND bucket_start >= $3 AND bucket_start < $4 AND metric = $5),
  o AS (
    SELECT network, operation, variant, outcome, sum(count)::bigint AS n FROM m GROUP BY 1, 2, 3, 4),
  a AS (
    SELECT network, operation, variant, sum(count)::bigint AS calls,
           COALESCE(sum(count) FILTER (WHERE CASE WHEN $5 = '${RPC}' THEN outcome <> ''
                                                 ELSE outcome !~ '^[123][0-9][0-9]$' END), 0)::bigint AS errors,
           sum(duration_sum) AS sum_s, scf.hist_sum(hist) AS h, max(hist_quality)::smallint AS q
      FROM m GROUP BY 1, 2, 3)
  SELECT a.network, a.operation, a.variant, a.calls::text AS calls, a.errors::text AS errors, a.sum_s,
         scf.hist_quantile('explicit15', a.h, 0.50) AS p50_s, scf.hist_quantile('explicit15', a.h, 0.95) AS p95_s,
         scf.accuracy_class(false, true, a.q) AS accuracy_class,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('outcome', CASE WHEN o.outcome = '' THEN 'ok' ELSE o.outcome END,
                                                       'count', o.n) ORDER BY o.n DESC, o.outcome), '[]'::jsonb)
            FROM o WHERE o.network = a.network AND o.operation = a.operation AND o.variant = a.variant) AS outcomes
    FROM a WHERE a.calls > 0
   ORDER BY a.calls DESC, a.network, a.operation, a.variant
   LIMIT ${MAX_ROWS}`;

const COUNTER_SQL = (table: string) => `
  SELECT metric, network, operation, variant, outcome, sum(count)::text AS n FROM ${table}
   WHERE tenant_id = $1 AND service_id = $2 AND bucket_start >= $3 AND bucket_start < $4
     AND metric IN ('stellar.tx.submissions', 'stellar.tx.polls', 'stellar.tx.simulations')
   GROUP BY 1, 2, 3, 4, 5
  HAVING sum(count) > 0
   ORDER BY 1, sum(count) DESC, 2, 3, 4, 5
   LIMIT ${3 * MAX_ROWS}`;

const ms = (s: number | null | undefined): number | null =>
  s === null || s === undefined ? null : Math.round(s * 1e6) / 1e3;
const rate = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null;

function duration(r: DurationRow) {
  const calls = Number(r.calls);
  const errors = Number(r.errors);
  return {
    network: r.network,
    calls,
    errors,
    error_rate: rate(errors, calls),
    p50_ms: ms(r.p50_s),
    p95_ms: ms(r.p95_s),
    mean_ms: calls > 0 ? ms(r.sum_s / calls) : null,
    accuracy_class: r.accuracy_class,
    outcomes: r.outcomes.map((o) => ({ outcome: o.outcome, count: Number(o.count) })),
  };
}

/** Reads one service's Stellar client metrics over a span (exported for the chain test and the evidence tools). */
export async function readStellarClient(
  tx: Tx,
  tenantId: string,
  serviceId: string,
  span: Span,
  res: Resolution,
) {
  const p = [tenantId, serviceId, new Date(span.start), new Date(span.end)];
  const t = TABLE[res];
  const rpc = await tx.query<DurationRow>(DURATION_SQL(t), [...p, RPC]);
  const http = await tx.query<DurationRow>(DURATION_SQL(t), [...p, HTTP]);
  const counters = await tx.query<CounterRow>(COUNTER_SQL(t), p);
  const submissions = [];
  const polls = [];
  const simulations = [];
  for (const c of counters) {
    const n = Number(c.n);
    if (c.metric === "stellar.tx.submissions")
      submissions.push({
        network: c.network,
        via: c.operation || null,
        status: c.variant,
        result_class: c.outcome || null,
        count: n,
      });
    else if (c.metric === "stellar.tx.polls")
      polls.push({
        network: c.network,
        via: c.operation || null,
        status: c.variant,
        result_class: c.outcome || null,
        count: n,
      });
    else
      simulations.push({
        network: c.network,
        outcome: c.variant,
        error_class: c.outcome || null,
        count: n,
      });
  }
  const networks = [
    ...new Set([...rpc, ...http, ...counters].map((r) => r.network as string)),
  ].sort();
  return {
    range: { start: iso(span.start), end: iso(span.end), resolution: res, label: LABEL },
    networks,
    rpc_methods: rpc.map((r) => ({ method: r.operation, ...duration(r) })),
    horizon_routes: http.map((r) => ({
      route: r.operation,
      http_method: r.variant || null,
      ...duration(r),
    })),
    transactions: { submissions, polls, simulations },
  };
}

async function load(ctx: RequestContext, tx: Tx) {
  const tenantId = visibleTenant(ctx);
  const serviceId = ctx.params.serviceId as string;
  const s = await loadService(tx, tenantId, serviceId);
  return { tenantId, serviceId, createdAt: s.registered_at.getTime() };
}

export function stellarClientHandlers(deps: { now?: () => number } = {}): Record<string, Handler> {
  const clock = deps.now ?? Date.now;
  const getStellarClientMetrics: Handler = async (ctx) => {
    const now = clock();
    const body = await ctx.tx(async (tx) => {
      const s = await load(ctx, tx);
      const { span, res } = planApiRange(ctx.query, now, s.createdAt);
      return readStellarClient(tx, s.tenantId, s.serviceId, span, res);
    });
    return { status: 200, body };
  };
  return { getStellarClientMetrics };
}
