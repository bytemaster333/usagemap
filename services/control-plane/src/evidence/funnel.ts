// SPDX-License-Identifier: Apache-2.0
// The usage funnel of the SCF Evidence Link (traction snapshot v3, C-137 small-count floor): web visitors → wallet
// connects → signatures → on-chain calls, verified and raw, per UTC day. Wallet figures come from the Stellar event
// rollup `web_event_property_daily` (its `_total`/`all` rows, the deployment's network only); web figures from
// `web_daily_totals`; on-chain calls from `onchain_daily` of the verified footprint (the v2 document's `onchain.daily`).
//
// The document is public, so the C-137 floor binds it (data-model §8, `web_event_property_daily`): every per-day cell
// and every wallet total below `op_min_count` (but above 0) is published as null and counted in `suppressed_cells`.
// Web and on-chain period totals stay exact like the rest of the document (C-95). Counts are events, not people: a
// wallet connect includes restored sessions, a signature is an approved signing request of any kind.

import type { Tx } from "../db/database.ts";
import { DAY, isoZ } from "../programme/figures.ts";

export type FunnelStage = "web_visitors" | "wallet_connects" | "signatures" | "onchain_calls";
export const FUNNEL_STAGES: FunnelStage[] = [
  "web_visitors",
  "wallet_connects",
  "signatures",
  "onchain_calls",
];

export interface FunnelDayInput {
  day: string; // YYYY-MM-DD
  web_visitors_verified: number;
  web_visitors_raw: number;
  wallet_connects_verified: number;
  wallet_connects_raw: number;
  signatures_verified: number;
  signatures_raw: number;
  /** null when the document has no on-chain figures (no verified contract or correlation off) */
  onchain_calls: number | null;
  onchain_calls_successful: number | null;
}

type Cell = number | null;
export interface FunnelDay {
  day: string;
  web_visitors_verified: Cell;
  web_visitors_raw: Cell;
  wallet_connects_verified: Cell;
  wallet_connects_raw: Cell;
  signatures_verified: Cell;
  signatures_raw: Cell;
  onchain_calls: Cell;
  onchain_calls_successful: Cell;
}

export interface FunnelStageTotal {
  stage: FunnelStage;
  verified: Cell;
  raw: Cell;
}

export interface Funnel {
  network: "mainnet" | "testnet";
  min_count: number;
  stages: FunnelStageTotal[];
  /**
   * verified stage ÷ previous verified stage, rounded to 4 digits; null when either side is null or 0. On-chain calls
   * get no ratio: they are day-level ledger counts never joined to visitors or signatures (decision D5).
   */
  conversion: {
    connects_per_visitor: number | null;
    signatures_per_connect: number | null;
  };
  daily: FunnelDay[];
  suppressed_cells: number;
}

/** C-137 floor: 0 stays 0 (it names nobody), 1 … k−1 becomes null. */
export function floorCell(n: number | null, k: number): Cell {
  if (n === null) return null;
  return n > 0 && n < k ? null : n;
}

const ratio = (a: Cell, b: Cell) =>
  a === null || b === null || b === 0 ? null : Math.round((a / b) * 10_000) / 10_000;

export function shapeFunnel(
  days: FunnelDayInput[],
  totals: {
    web_visitors_verified: number;
    web_visitors_raw: number;
    onchain: null | { calls: number };
  },
  network: "mainnet" | "testnet",
  k: number,
): Funnel {
  let suppressed = 0;
  const cell = (n: number | null) => {
    const v = floorCell(n, k);
    if (v === null && n !== null) suppressed++;
    return v;
  };
  const daily = days.map((d) => ({
    day: d.day,
    web_visitors_verified: cell(d.web_visitors_verified),
    web_visitors_raw: cell(d.web_visitors_raw),
    wallet_connects_verified: cell(d.wallet_connects_verified),
    wallet_connects_raw: cell(d.wallet_connects_raw),
    signatures_verified: cell(d.signatures_verified),
    signatures_raw: cell(d.signatures_raw),
    onchain_calls: cell(d.onchain_calls),
    onchain_calls_successful: cell(d.onchain_calls_successful),
  }));
  const sum = (f: (d: FunnelDayInput) => number) => days.reduce((a, d) => a + f(d), 0);
  const connects = {
    verified: cell(sum((d) => d.wallet_connects_verified)),
    raw: cell(sum((d) => d.wallet_connects_raw)),
  };
  const signatures = {
    verified: cell(sum((d) => d.signatures_verified)),
    raw: cell(sum((d) => d.signatures_raw)),
  };
  const calls = totals.onchain ? totals.onchain.calls : null;
  const stages: FunnelStageTotal[] = [
    { stage: "web_visitors", verified: totals.web_visitors_verified, raw: totals.web_visitors_raw },
    { stage: "wallet_connects", ...connects },
    { stage: "signatures", ...signatures },
    // on-chain calls are public ledger facts: not bot-filtered, so verified and raw are the same figure
    { stage: "onchain_calls", verified: calls, raw: calls },
  ];
  return {
    network,
    min_count: k,
    stages,
    conversion: {
      connects_per_visitor: ratio(connects.verified, totals.web_visitors_verified),
      signatures_per_connect: ratio(signatures.verified, connects.verified),
    },
    daily,
    suppressed_cells: suppressed,
  };
}

/** Every UTC day of [start, end) as YYYY-MM-DD. */
export function periodDays(start: number, end: number): string[] {
  const out: string[] = [];
  for (let d = start; d < end; d += DAY) out.push(isoZ(d).slice(0, 10));
  return out;
}

/**
 * The funnel's inputs under the tenant's context (job public_metrics). `onchainDaily` is the v2 document's
 * `onchain.daily` (complete days only) or null.
 */
export async function loadFunnel(
  tx: Tx,
  tenantId: string,
  start: number,
  end: number,
  network: "mainnet" | "testnet",
  k: number,
  onchainDaily: null | Array<{ day: string; invocations: number; successful_invocations: number }>,
  onchainTotal: number | null,
): Promise<Funnel> {
  const startDay = isoZ(start).slice(0, 10);
  const endDay = isoZ(end).slice(0, 10);
  const web = await tx.query<{ day: string; v: string; r: string }>(
    `SELECT day::text AS day, sum(visitors_verified)::text AS v, sum(visitors_raw)::text AS r
       FROM scf.web_daily_totals WHERE tenant_id = $1 AND day >= $2::date AND day < $3::date GROUP BY day`,
    [tenantId, startDay, endDay],
  );
  const wallet = await tx.query<{ day: string; event_name: string; verdict: string; n: string }>(
    `SELECT day::text AS day, event_name, verdict, sum(count)::text AS n
       FROM scf.web_event_property_daily
      WHERE tenant_id = $1 AND day >= $2::date AND day < $3::date AND network = $4
        AND prop_key = '_total' AND event_name IN ('wallet_connect', 'sign_approved')
      GROUP BY 1, 2, 3`,
    [tenantId, startDay, endDay, network],
  );
  const byDay = new Map<string, FunnelDayInput>();
  const days = periodDays(start, end);
  for (const day of days)
    byDay.set(day, {
      day,
      web_visitors_verified: 0,
      web_visitors_raw: 0,
      wallet_connects_verified: 0,
      wallet_connects_raw: 0,
      signatures_verified: 0,
      signatures_raw: 0,
      onchain_calls: onchainDaily ? 0 : null,
      onchain_calls_successful: onchainDaily ? 0 : null,
    });
  let wv = 0;
  let wr = 0;
  for (const w of web) {
    const d = byDay.get(w.day);
    if (!d) continue;
    d.web_visitors_verified = Number(w.v);
    d.web_visitors_raw = Number(w.r);
    wv += d.web_visitors_verified;
    wr += d.web_visitors_raw;
  }
  for (const w of wallet) {
    const d = byDay.get(w.day);
    if (!d) continue;
    const n = Number(w.n);
    if (w.event_name === "wallet_connect") {
      d.wallet_connects_raw += n;
      if (w.verdict === "verified") d.wallet_connects_verified += n;
    } else {
      d.signatures_raw += n;
      if (w.verdict === "verified") d.signatures_verified += n;
    }
  }
  if (onchainDaily) {
    // days without a complete on-chain row stay null (they are not 0: the data is missing)
    const complete = new Set(onchainDaily.map((o) => o.day));
    for (const d of byDay.values()) {
      if (!complete.has(d.day)) {
        d.onchain_calls = null;
        d.onchain_calls_successful = null;
      }
    }
    for (const o of onchainDaily) {
      const d = byDay.get(o.day);
      if (!d) continue;
      d.onchain_calls = o.invocations;
      d.onchain_calls_successful = o.successful_invocations;
    }
  }
  return shapeFunnel(
    [...byDay.values()],
    {
      web_visitors_verified: wv,
      web_visitors_raw: wr,
      onchain: onchainTotal === null ? null : { calls: onchainTotal },
    },
    network,
    k,
  );
}
