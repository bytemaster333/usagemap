// SPDX-License-Identifier: Apache-2.0
// getSiteBrowserRpc (migration 0086, wire-formats §a.3.2): daily totals of the Stellar RPC and Horizon calls the
// tenant's own web app made from its visitors' browsers, as counted by the tracker's `/stellar-rpc` subpath — per RPC
// method or Horizon route template, outcome class and latency bucket, per UTC day of receipt. Read from
// scf.web_rpc_client_daily under the tenant's context with an explicit tenant filter; a foreign or unknown site is
// the same 404 (C-87). The tenant's own view is exact: nothing of it leaves the tenant, so no small-count floor
// applies (C-137). Never API usage and never traffic: no other figure, score or snapshot reads these rows.

import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { DAY, dayString, iso } from "../web/range.ts";
import { type RPC_LATENCIES, RPC_OUTCOMES, type RpcApi } from "./cells.ts";

const MAX_DAYS = 400;

export interface BrowserRpcRow {
  day: string;
  api: RpcApi;
  operation: string;
  network: string;
  outcome: string;
  latency: string;
  n: number;
}

type Latency = (typeof RPC_LATENCIES)[number];

export interface BrowserRpcOperation {
  api: RpcApi;
  operation: string;
  calls: number;
  errors: number;
  outcomes: Array<{ outcome: string; count: number }>;
  latency: Record<Latency, number>;
}

export interface BrowserRpcShape {
  totals: { calls: number; errors: number; rpc: number; horizon: number };
  networks: Array<{ network: string; calls: number }>;
  operations: BrowserRpcOperation[];
  daily: Array<{ day: string; rpc: number; horizon: number; errors: number }>;
}

const OUTCOME_ORDER = new Map<string, number>(RPC_OUTCOMES.map((o, i) => [o, i]));

/** An error is every outcome but `ok` (JSON-RPC error, HTTP 4xx/429/5xx, timeout, network failure). */
export const isError = (outcome: string): boolean => outcome !== "ok";

/** Shapes summed rows into totals, per-operation figures and one daily point per day of the range (pure). */
export function shapeBrowserRpc(
  rows: readonly BrowserRpcRow[],
  days: readonly string[],
): BrowserRpcShape {
  const totals = { calls: 0, errors: 0, rpc: 0, horizon: 0 };
  const networks = new Map<string, number>();
  const ops = new Map<string, BrowserRpcOperation & { _o: Map<string, number> }>();
  const daily = new Map(days.map((d) => [d, { day: d, rpc: 0, horizon: 0, errors: 0 }]));
  for (const r of rows) {
    const err = isError(r.outcome);
    totals.calls += r.n;
    totals[r.api] += r.n;
    if (err) totals.errors += r.n;
    networks.set(r.network, (networks.get(r.network) ?? 0) + r.n);
    const k = `${r.api}|${r.operation}`;
    let o = ops.get(k);
    if (!o) {
      o = {
        api: r.api,
        operation: r.operation,
        calls: 0,
        errors: 0,
        outcomes: [],
        latency: { lt100ms: 0, "100_500ms": 0, "500_2000ms": 0, gt2000ms: 0 },
        _o: new Map(),
      };
      ops.set(k, o);
    }
    o.calls += r.n;
    if (err) o.errors += r.n;
    o._o.set(r.outcome, (o._o.get(r.outcome) ?? 0) + r.n);
    if (r.latency in o.latency) o.latency[r.latency as Latency] += r.n;
    const d = daily.get(r.day);
    if (d) {
      d[r.api] += r.n;
      if (err) d.errors += r.n;
    }
  }
  const operations = [...ops.values()]
    .map(({ _o, ...o }) => ({
      ...o,
      outcomes: [..._o.entries()]
        .map(([outcome, count]) => ({ outcome, count }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            (OUTCOME_ORDER.get(a.outcome) ?? 99) - (OUTCOME_ORDER.get(b.outcome) ?? 99),
        ),
    }))
    .sort(
      (a, b) =>
        b.calls - a.calls ||
        a.api.localeCompare(b.api) ||
        // `other` last among equals
        Number(a.operation === "other") - Number(b.operation === "other") ||
        a.operation.localeCompare(b.operation),
    );
  return {
    totals,
    networks: [...networks.entries()]
      .map(([network, calls]) => ({ network, calls }))
      .sort((a, b) => b.calls - a.calls || a.network.localeCompare(b.network)),
    operations,
    daily: [...daily.values()],
  };
}

function bad(pointer: string, detail: string): ApiError {
  return new ApiError("validation_failed", detail, { errors: [{ pointer, detail }] });
}

async function siteExists(tx: Tx, tenantId: string, siteId: string): Promise<void> {
  const s = await tx.maybeOne(`SELECT 1 FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`, [
    tenantId,
    siteId,
  ]);
  if (!s) throw new ApiError("not_found");
}

export function browserRpcHandlers(): Record<string, Handler> {
  const getSiteBrowserRpc: Handler = async (ctx) => {
    const tenantId = ctx.params.tenantId as string;
    const siteId = ctx.params.siteId as string;
    const q = ctx.query as { start: string; end: string; network?: string; variant?: string };
    const start = Date.parse(q.start);
    const end = Date.parse(q.end);
    const network = q.network ?? "all";
    const variant = q.variant === "raw" ? "raw" : "verified";
    const rows = await ctx.tx(async (tx) => {
      // a foreign or unknown site is 404 before anything about the request is judged (C-87)
      await siteExists(tx, tenantId, siteId);
      if (!(end > start)) throw bad("/end", "end must be after start");
      if (end - start > MAX_DAYS * DAY) throw bad("/end", `the range is at most ${MAX_DAYS} days`);
      return tx.query<Omit<BrowserRpcRow, "n"> & { n: string }>(
        `SELECT day::text AS day, api, operation, network, outcome, latency, sum(count)::text AS n
           FROM scf.web_rpc_client_daily
          WHERE tenant_id = $1 AND site_id = $2 AND day >= $3::date AND day < $4::date
            AND ($5::text IS NULL OR network = $5) AND verdict = ANY ($6::text[])
          GROUP BY 1, 2, 3, 4, 5, 6`,
        [
          tenantId,
          siteId,
          dayString(start),
          dayString(end),
          network === "all" ? null : network,
          variant === "raw" ? ["verified", "suspect"] : ["verified"],
        ],
      );
    });
    const days: string[] = [];
    for (let d = start; d < end; d += DAY) days.push(dayString(d));
    return {
      status: 200,
      body: {
        range: { start: iso(start), end: iso(end) },
        network,
        variant,
        ...shapeBrowserRpc(
          rows.map((r) => ({ ...r, n: Number(r.n) })),
          days,
        ),
      },
    };
  };
  return { getSiteBrowserRpc };
}
