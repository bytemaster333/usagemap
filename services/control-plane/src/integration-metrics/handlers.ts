// SPDX-License-Identifier: Apache-2.0
// Integration client metrics (migration 0085; wire-formats §f.5 steps 4b–4d, §g.8): what a tenant's own systems
// reported through the integration packages —
//   - partner-API calls of a service (@usagemap/partner-otel): volume, errors, p50/p95 per partner route;
//   - agent-payment events of a service (@usagemap/payments-otel, x402 and MPP): stages, rails, assets,
//     amount classes and failure classes;
//   - the anchor funnel of the tenant (all services): the wallet side (@usagemap/anchor-otel: SEP steps and
//     funnel events per anchor) and the anchor side (tools/ap-listener: transfers, status transitions, time in
//     status, KYC status updates, firm quotes, per client wallet).
// All of it is self-attested telemetry of the tenant's own systems: never API usage, never part of the API figures,
// the trust score, public metrics, snapshots or the Usage Map. Reads run under the tenant's context (scf_app, RLS)
// with an explicit tenant filter. The tenant's own view is exact: nothing of it leaves the tenant, so no small-count
// floor applies (C-137). Histograms are explicit15, merged before the percentile (C-103).

import { loadService, visibleTenant } from "../api/services.ts";
import type { Tx } from "../db/database.ts";
import type { Handler, RequestContext } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { DAY, HOUR, iso, resolveWebRange, type Span, utcMidnight } from "../web/range.ts";

export const LABEL = "self-attested telemetry";
export type IntegrationResolution = "1h" | "1d";
const TABLE: Record<IntegrationResolution, string> = {
  "1h": "scf.integration_metrics_1h",
  "1d": "scf.integration_metrics_1d",
};
/** The hour table is kept 35 days (0085); one day of margin so a range never reads half-deleted hours. */
const HOUR_RETENTION_DAYS = 34;
/** Rows per list (the closed sets bound them; the caps bound a hostile sender). */
export const MAX_ROWS = 200;

const PARTNER = "stellar.partner.call.duration";
const PAYMENT = "payment.server.events";
const ANCHOR_REQ = "stellar.anchor.request.duration";
const ANCHOR_EV = "stellar.anchor.events";

/**
 * The resolution of a span: hourly while the whole span is a ≤ 31-day window inside the hour table's retention,
 * else daily. The span is aligned outward to the resolution's grid (pure).
 */
export function planIntegrationRange(
  raw: Span,
  now: number,
): { span: Span; res: IntegrationResolution } {
  const hourly =
    raw.end - raw.start <= 31 * DAY && raw.start >= utcMidnight(now) - HOUR_RETENTION_DAYS * DAY;
  const res: IntegrationResolution = hourly ? "1h" : "1d";
  const step = hourly ? HOUR : DAY;
  return {
    span: { start: Math.floor(raw.start / step) * step, end: Math.ceil(raw.end / step) * step },
    res,
  };
}

const ms = (s: number | null | undefined): number | null =>
  s === null || s === undefined ? null : Math.round(s * 1e6) / 1e3;
const rate = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null;
const orNull = (s: string): string | null => (s === "" ? null : s);

interface DurationRow extends Record<string, unknown> {
  network: string;
  d1: string;
  d2: string;
  calls: string;
  errors: string;
  sum_s: number;
  p50_s: number | null;
  p95_s: number | null;
  accuracy_class: string | null;
  outcomes: Array<{ outcome: string; count: number }>;
}

/**
 * Duration rows grouped by (network, d1, d2) with the outcome (d3) breakdown. An error is any outcome but `okValue`.
 * `scope` restricts the rows (one service, or the whole tenant).
 */
function durationSql(table: string, scope: string, okValue: string): string {
  return `
  WITH m AS (
    SELECT * FROM ${table}
     WHERE tenant_id = $1 AND ${scope} AND bucket_start >= $2 AND bucket_start < $3 AND metric = $4),
  o AS (SELECT network, d1, d2, d3 AS outcome, sum(count)::bigint AS n FROM m GROUP BY 1, 2, 3, 4),
  a AS (
    SELECT network, d1, d2, sum(count)::bigint AS calls,
           COALESCE(sum(count) FILTER (WHERE d3 <> '${okValue}'), 0)::bigint AS errors,
           sum(duration_sum) AS sum_s, scf.hist_sum(hist) AS h, max(hist_quality)::smallint AS q
      FROM m GROUP BY 1, 2, 3)
  SELECT a.network, a.d1, a.d2, a.calls::text AS calls, a.errors::text AS errors, a.sum_s,
         scf.hist_quantile('explicit15', a.h, 0.50) AS p50_s, scf.hist_quantile('explicit15', a.h, 0.95) AS p95_s,
         scf.accuracy_class(false, true, a.q) AS accuracy_class,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('outcome', o.outcome, 'count', o.n)
                                    ORDER BY o.n DESC, o.outcome), '[]'::jsonb)
            FROM o WHERE o.network = a.network AND o.d1 = a.d1 AND o.d2 = a.d2) AS outcomes
    FROM a WHERE a.calls > 0
   ORDER BY a.calls DESC, a.network, a.d1, a.d2
   LIMIT ${MAX_ROWS}`;
}

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

interface CountRow extends Record<string, unknown> {
  metric: string;
  network: string;
  d1: string;
  d2: string;
  d3: string;
  d4: string;
  d5: string;
  d6: string;
  d7: string;
  n: string;
  sum_s: number;
}

/** Counter (and long-duration) cells summed over the span, all dimensions kept. */
function countSql(table: string, scope: string, metrics: string): string {
  return `
  SELECT metric, network, d1, d2, d3, d4, d5, d6, d7, sum(count)::text AS n, sum(duration_sum) AS sum_s
    FROM ${table}
   WHERE tenant_id = $1 AND ${scope} AND bucket_start >= $2 AND bucket_start < $3 AND metric IN (${metrics})
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
  HAVING sum(count) > 0`;
}

/** Adds n to key in a map. */
function bump<K>(m: Map<K, number>, k: K, n: number): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

/** Sorted [{…key fields, count}] from a map keyed by a JSON array, largest first, capped. */
function ranked<T extends Record<string, unknown>>(
  m: Map<string, number>,
  fields: (keyof T & string)[],
): Array<T & { count: number }> {
  return [...m.entries()]
    .map(([k, count]) => {
      const vals = JSON.parse(k) as unknown[];
      const o: Record<string, unknown> = {};
      fields.forEach((f, i) => {
        o[f] = vals[i];
      });
      return { ...(o as T), count };
    })
    .sort((a, b) => b.count - a.count || JSON.stringify(a).localeCompare(JSON.stringify(b)))
    .slice(0, MAX_ROWS);
}

/**
 * One point per bucket of the span (zero-filled): `total` = sum(count), `bad` = the error / failure part. `badSql` is
 * a boolean SQL expression over d1 … d7.
 */
async function series(
  tx: Tx,
  table: string,
  scope: string,
  params: unknown[],
  span: Span,
  res: IntegrationResolution,
  badSql: string,
): Promise<Array<{ t: string; total: number; bad: number }>> {
  const rows = await tx.query<{ b: Date; total: string; bad: string }>(
    `SELECT bucket_start AS b, sum(count)::text AS total,
            COALESCE(sum(count) FILTER (WHERE ${badSql}), 0)::text AS bad
       FROM ${table} WHERE tenant_id = $1 AND ${scope} AND bucket_start >= $2 AND bucket_start < $3 AND metric = $4
      GROUP BY 1`,
    params,
  );
  const by = new Map(rows.map((r) => [r.b.getTime(), r]));
  const step = res === "1h" ? HOUR : DAY;
  const out: Array<{ t: string; total: number; bad: number }> = [];
  for (let t = span.start; t < span.end; t += step) {
    const r = by.get(t);
    out.push({ t: iso(t), total: r ? Number(r.total) : 0, bad: r ? Number(r.bad) : 0 });
  }
  return out;
}

function rangeBody(span: Span, res: IntegrationResolution) {
  return { start: iso(span.start), end: iso(span.end), resolution: res, label: LABEL };
}

// ------------------------------------------------------------------------------------------------ partner calls

/** One service's partner-API calls over a span (exported for the chain test). */
export async function readPartnerCalls(
  tx: Tx,
  tenantId: string,
  serviceId: string,
  span: Span,
  res: IntegrationResolution,
) {
  const params = [tenantId, new Date(span.start), new Date(span.end), PARTNER, serviceId];
  const rows = await tx.query<DurationRow>(
    durationSql(TABLE[res], "service_id = $5", "success"),
    params,
  );
  const points = await series(
    tx,
    TABLE[res],
    "service_id = $5",
    params,
    span,
    res,
    "d3 <> 'success'",
  );
  const partners = new Map<string, { calls: number; errors: number }>();
  for (const r of rows) {
    const p = partners.get(r.d1) ?? { calls: 0, errors: 0 };
    p.calls += Number(r.calls);
    p.errors += Number(r.errors);
    partners.set(r.d1, p);
  }
  return {
    range: rangeBody(span, res),
    networks: [...new Set(rows.map((r) => r.network))].sort(),
    partners: [...partners.entries()]
      .map(([partner, p]) => ({ partner, ...p, error_rate: rate(p.errors, p.calls) }))
      .sort((a, b) => b.calls - a.calls || a.partner.localeCompare(b.partner)),
    operations: rows.map((r) => ({ partner: r.d1, operation: r.d2, ...duration(r) })),
    series: points.map((x) => ({ t: x.t, calls: x.total, errors: x.bad })),
  };
}

// ------------------------------------------------------------------------------------------------ payments

export const PAYMENT_STAGES = [
  "required",
  "verified",
  "settled",
  "paid",
  "failed",
  "canceled",
] as const;
const COMPLETED = new Set(["settled", "paid"]);
const FAILED = new Set(["failed", "canceled"]);

/** Shapes summed payment cells (d1 protocol … d7 error.type) into the response (pure; exported for tests). */
export function shapePayments(rows: readonly CountRow[]) {
  const stages = new Map<string, number>();
  const networks = new Map<string, number>();
  const rails = new Map<string, number>();
  const assets = new Map<string, number>();
  const amounts = new Map<string, number>();
  const failures = new Map<string, number>();
  const byProtocol = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const n = Number(r.n);
    const [protocol, stage, rail, intent, asset, bucketOrReason, errorType] = [
      r.d1,
      r.d2,
      r.d3,
      r.d4,
      r.d5,
      r.d6,
      r.d7,
    ];
    bump(stages, stage, n);
    bump(networks, r.network, n);
    const p = byProtocol.get(protocol) ?? new Map<string, number>();
    bump(p, stage, n);
    byProtocol.set(protocol, p);
    if (COMPLETED.has(stage)) {
      bump(rails, JSON.stringify([protocol, orNull(rail), orNull(intent), r.network]), n);
      if (asset) bump(assets, JSON.stringify([asset]), n);
      if (bucketOrReason) bump(amounts, bucketOrReason, n);
    }
    if (FAILED.has(stage))
      bump(
        failures,
        JSON.stringify([protocol, stage, bucketOrReason || "other", orNull(errorType)]),
        n,
      );
  }
  const stageCounts = Object.fromEntries(
    PAYMENT_STAGES.map((s) => [s, stages.get(s) ?? 0]),
  ) as Record<(typeof PAYMENT_STAGES)[number], number>;
  const other = [...stages.entries()]
    .filter(([s]) => !(PAYMENT_STAGES as readonly string[]).includes(s))
    .reduce((a, [, n]) => a + n, 0);
  const completed = stageCounts.settled + stageCounts.paid;
  const failed = stageCounts.failed + stageCounts.canceled;
  const AMOUNT_ORDER = ["lt_0.001", "0.001_0.01", "0.01_0.1", "0.1_1", "1_10", "ge_10"];
  return {
    totals: {
      events: [...stages.values()].reduce((a, b) => a + b, 0),
      required: stageCounts.required,
      completed,
      failed,
      // completed ÷ (completed + failed): of the payments that reached an end, how many succeeded
      success_rate: rate(completed, completed + failed),
    },
    stages: { ...stageCounts, other },
    protocols: [...byProtocol.entries()]
      .map(([protocol, m]) => ({
        protocol,
        events: [...m.values()].reduce((a, b) => a + b, 0),
        stages: Object.fromEntries(PAYMENT_STAGES.map((s) => [s, m.get(s) ?? 0])),
      }))
      .sort((a, b) => b.events - a.events || a.protocol.localeCompare(b.protocol)),
    networks: [...networks.entries()]
      .map(([network, count]) => ({ network, count }))
      .sort((a, b) => b.count - a.count || a.network.localeCompare(b.network)),
    rails: ranked<{
      protocol: string;
      rail: string | null;
      intent: string | null;
      network: string;
    }>(rails, ["protocol", "rail", "intent", "network"]),
    assets: ranked<{ asset: string }>(assets, ["asset"]),
    amount_buckets: AMOUNT_ORDER.filter((b) => amounts.has(b)).map((bucket) => ({
      bucket,
      count: amounts.get(bucket) ?? 0,
    })),
    failures: ranked<{
      protocol: string;
      stage: string;
      reason_class: string;
      error_type: string | null;
    }>(failures, ["protocol", "stage", "reason_class", "error_type"]),
  };
}

export async function readPayments(
  tx: Tx,
  tenantId: string,
  serviceId: string,
  span: Span,
  res: IntegrationResolution,
) {
  const rows = await tx.query<CountRow>(countSql(TABLE[res], "service_id = $4", `'${PAYMENT}'`), [
    tenantId,
    new Date(span.start),
    new Date(span.end),
    serviceId,
  ]);
  // events per bucket and the failed / canceled part
  const points = await series(
    tx,
    TABLE[res],
    "service_id = $5",
    [tenantId, new Date(span.start), new Date(span.end), PAYMENT, serviceId],
    span,
    res,
    "d2 IN ('failed', 'canceled')",
  );
  return {
    range: rangeBody(span, res),
    ...shapePayments(rows),
    series: points.map((x) => ({ t: x.t, events: x.total, failed: x.bad })),
  };
}

// ------------------------------------------------------------------------------------------------ anchor funnel

export const FLOWS = ["deposit", "withdraw", "receive"] as const;
type Flow = (typeof FLOWS)[number];

const ANCHOR_SIDE = [
  "stellar.anchor.transfer.created",
  "stellar.anchor.transfer.transitions",
  "stellar.anchor.transfer.status.duration",
  "stellar.anchor.transfer.duration",
  "stellar.anchor.customer.updates",
  "stellar.anchor.quotes.created",
];

/**
 * Wallet-side funnel of one flow from the event counts (pure): authenticated (all flows share it) → requested
 * (SEP-6 `<flow>_requested` + SEP-24 `<flow>_interactive_started`) → started → completed; and the other endings.
 * Counts of events, not of people: the packages count each transfer's lifecycle event once, but nothing links two
 * events of one user.
 */
export function walletFunnel(events: ReadonlyMap<string, number>, flow: Flow) {
  const n = (e: string) => events.get(e) ?? 0;
  return {
    flow,
    steps: [
      { step: "authenticated", count: n("authenticated") },
      { step: "requested", count: n(`${flow}_requested`) + n(`${flow}_interactive_started`) },
      { step: "started", count: n(`${flow}_started`) },
      { step: "completed", count: n(`${flow}_completed`) },
    ],
    pending_user: n(`${flow}_pending_user`),
    pending_anchor: n(`${flow}_pending_anchor`),
    failed: n(`${flow}_failed`) + n(`${flow}_request_failed`),
    refunded: n(`${flow}_refunded`),
    expired: n(`${flow}_expired`),
  };
}

/** Shapes the anchor-side cells (pure; exported for tests). */
export function shapeAnchorSide(rows: readonly CountRow[]) {
  const created = new Map<string, number>();
  const transitions = new Map<string, number>();
  const entered = new Map<string, number>();
  const timeIn = new Map<string, { count: number; sum: number }>();
  const durations = new Map<string, { count: number; sum: number }>();
  const customers = new Map<string, number>();
  const clients = new Map<
    string,
    { transfers: number; quotes: number; customer_updates: number }
  >();
  let quotes = 0;
  const client = (c: string) => {
    const x = clients.get(c) ?? { transfers: 0, quotes: 0, customer_updates: 0 };
    clients.set(c, x);
    return x;
  };
  for (const r of rows) {
    const n = Number(r.n);
    switch (r.metric) {
      case "stellar.anchor.transfer.created":
        bump(created, JSON.stringify([r.d1, r.d2]), n);
        client(r.d5).transfers += n;
        break;
      case "stellar.anchor.transfer.transitions":
        bump(transitions, JSON.stringify([r.d3, r.d4]), n);
        bump(entered, r.d4, n);
        break;
      case "stellar.anchor.transfer.status.duration": {
        const t = timeIn.get(r.d4) ?? { count: 0, sum: 0 };
        t.count += n;
        t.sum += r.sum_s;
        timeIn.set(r.d4, t);
        break;
      }
      case "stellar.anchor.transfer.duration": {
        const k = JSON.stringify([r.d2, r.d4]);
        const t = durations.get(k) ?? { count: 0, sum: 0 };
        t.count += n;
        t.sum += r.sum_s;
        durations.set(k, t);
        break;
      }
      case "stellar.anchor.customer.updates":
        bump(customers, r.d4, n);
        client(r.d5).customer_updates += n;
        break;
      case "stellar.anchor.quotes.created":
        quotes += n;
        client(r.d5).quotes += n;
        break;
    }
  }
  const mean = (t: { count: number; sum: number }) =>
    t.count > 0 ? Math.round((t.sum / t.count) * 1000) / 1000 : null;
  const createdList = ranked<{ sep: string; kind: string }>(created, ["sep", "kind"]);
  return {
    transfers_created: createdList.reduce((a, r) => a + r.count, 0),
    created: createdList,
    statuses: [...entered.entries()]
      .map(([status, count]) => ({ status, entered: count }))
      .sort((a, b) => b.entered - a.entered || a.status.localeCompare(b.status)),
    transitions: ranked<{ from: string; to: string }>(transitions, ["from", "to"]),
    time_in_status: [...timeIn.entries()]
      .map(([status, t]) => ({ status, count: t.count, mean_s: mean(t) }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
    durations: [...durations.entries()]
      .map(([k, t]) => {
        const [kind, status] = JSON.parse(k) as [string, string];
        return { kind, final_status: status, count: t.count, mean_s: mean(t) };
      })
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    customers: [...customers.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
    quotes_created: quotes,
    clients: [...clients.entries()]
      .map(([c, x]) => ({ client: c === "_none" ? null : c, ...x }))
      .sort(
        (a, b) =>
          b.transfers +
            b.quotes +
            b.customer_updates -
            (a.transfers + a.quotes + a.customer_updates) ||
          String(a.client).localeCompare(String(b.client)),
      )
      .slice(0, 50),
  };
}

export async function readAnchorFunnel(
  tx: Tx,
  tenantId: string,
  span: Span,
  res: IntegrationResolution,
) {
  const p = [tenantId, new Date(span.start), new Date(span.end)];
  const t = TABLE[res];
  const requests = await tx.query<DurationRow>(durationSql(t, "true", "ok"), [...p, ANCHOR_REQ]);
  const evRows = await tx.query<CountRow>(countSql(t, "true", `'${ANCHOR_EV}'`), p);
  const apRows = await tx.query<CountRow>(
    countSql(t, "true", ANCHOR_SIDE.map((m) => `'${m}'`).join(", ")),
    p,
  );
  const events = new Map<string, number>();
  const anchors = new Map<string, { events: number; requests: number; errors: number }>();
  const anchor = (d: string) => {
    const a = anchors.get(d) ?? { events: 0, requests: 0, errors: 0 };
    anchors.set(d, a);
    return a;
  };
  const kyc = new Map<string, number>();
  for (const r of evRows) {
    const n = Number(r.n);
    bump(events, r.d1, n);
    if (r.d1.startsWith("customer_") || r.d1 === "kyc_required") bump(kyc, r.d1, n);
    if (r.d3) anchor(r.d3).events += n;
  }
  // request rows are grouped by (network, sep, step); the home domain is d4 — read it per row separately
  const perAnchor = await tx.query<{ d4: string; calls: string; errors: string }>(
    `SELECT d4, sum(count)::text AS calls, COALESCE(sum(count) FILTER (WHERE d3 <> 'ok'), 0)::text AS errors
       FROM ${t} WHERE tenant_id = $1 AND bucket_start >= $2 AND bucket_start < $3 AND metric = $4 AND d4 <> ''
      GROUP BY 1`,
    [...p, ANCHOR_REQ],
  );
  for (const r of perAnchor) {
    const a = anchor(r.d4);
    a.requests += Number(r.calls);
    a.errors += Number(r.errors);
  }
  const networks = new Set<string>();
  for (const r of [...requests, ...evRows, ...apRows]) networks.add(r.network as string);
  const walletHas = requests.length > 0 || evRows.length > 0;
  return {
    range: rangeBody(span, res),
    networks: [...networks].sort(),
    wallet: {
      reported: walletHas,
      funnels: FLOWS.map((f) => walletFunnel(events, f)),
      kyc: [...kyc.entries()]
        .map(([event, count]) => ({ event, count }))
        .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event)),
      events: [...events.entries()]
        .map(([event, count]) => ({ event, count }))
        .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event)),
      requests: requests.map((r) => ({ sep: r.d1, step: r.d2, ...duration(r) })),
      anchors: [...anchors.entries()]
        .map(([home_domain, a]) => ({ home_domain, ...a, error_rate: rate(a.errors, a.requests) }))
        .sort(
          (a, b) =>
            b.events + b.requests - (a.events + a.requests) ||
            a.home_domain.localeCompare(b.home_domain),
        )
        .slice(0, 50),
    },
    anchor: { reported: apRows.length > 0, ...shapeAnchorSide(apRows) },
  };
}

// ------------------------------------------------------------------------------------------------ handlers

async function serviceScope(ctx: RequestContext, tx: Tx) {
  const tenantId = visibleTenant(ctx);
  const serviceId = ctx.params.serviceId as string;
  const s = await loadService(tx, tenantId, serviceId);
  return { tenantId, serviceId, createdAt: s.registered_at.getTime() };
}

async function tenantCreatedAt(tx: Tx, tenantId: string): Promise<number> {
  const r = await tx.maybeOne<{ created_at: Date }>(
    `SELECT created_at FROM scf.tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!r) throw new ApiError("not_found");
  return r.created_at.getTime();
}

export function integrationMetricsHandlers(
  deps: { now?: () => number } = {},
): Record<string, Handler> {
  const clock = deps.now ?? Date.now;
  const getPartnerCalls: Handler = async (ctx) => {
    const now = clock();
    const body = await ctx.tx(async (tx) => {
      const s = await serviceScope(ctx, tx);
      const { span, res } = planIntegrationRange(resolveWebRange(ctx.query, now, s.createdAt), now);
      return readPartnerCalls(tx, s.tenantId, s.serviceId, span, res);
    });
    return { status: 200, body };
  };
  const getPaymentEvents: Handler = async (ctx) => {
    const now = clock();
    const body = await ctx.tx(async (tx) => {
      const s = await serviceScope(ctx, tx);
      const { span, res } = planIntegrationRange(resolveWebRange(ctx.query, now, s.createdAt), now);
      return readPayments(tx, s.tenantId, s.serviceId, span, res);
    });
    return { status: 200, body };
  };
  const getAnchorFunnel: Handler = async (ctx) => {
    const now = clock();
    const tenantId = visibleTenant(ctx);
    const body = await ctx.tx(async (tx) => {
      const created = await tenantCreatedAt(tx, tenantId);
      const { span, res } = planIntegrationRange(resolveWebRange(ctx.query, now, created), now);
      return readAnchorFunnel(tx, tenantId, span, res);
    });
    return { status: 200, body };
  };
  return { getPartnerCalls, getPaymentEvents, getAnchorFunnel };
}
