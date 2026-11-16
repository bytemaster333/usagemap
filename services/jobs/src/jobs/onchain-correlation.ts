// SPDX-License-Identifier: Apache-2.0
// Job `onchain_correlation` (daily, default 06:00 UTC; data-model §6.3, §8.10; ADR-0028; C-42, C-128, C-136). PRIMARY
// data source `ledger_files` (decision D3, C-136; Hubble is the secondary source and not built): per verified declared
// contract of an opted-in tenant and UTC day, the top-level invocation counts from the public ledger, computed by
// `services/onchain-reader` over a local mirror of ledger data files (SCF_ONCHAIN_LEDGER_DIR). Rows land in
// `scf.onchain_daily`, which the control plane's `getOnchainDaily` and job `trust_scoring` (A3 badge) read.
//
// Step 1 — fetch (wire-formats §p.1, plan A1): `onchain-reader fetch` fills the mirror from the public ledger-data
// store (SCF_ONCHAIN_LEDGER_SOURCE_URL) for the days the count still needs (D−1 and the missing days of the window).
// A failed fetch (exit 1) is counted and the run continues: the reader then marks the affected days incomplete and
// nothing is stored for them. Without a source URL the mirror is filled elsewhere (an operator's sync).
// Step 2 — count.
//
// Which contracts: tenants with `onchain_correlation_enabled` that are not removed, contracts with status `verified`
// (ADR-0028: only verified identifiers count), not removed, without an open footprint conflict (`conflict_since`,
// C-137: a contract verified for two tenants is counted for neither), on this deployment's network
// (SCF_STELLAR_NETWORK). Footprint accounts and WASM hashes are not counted yet.
// Which days: the `lookbackDays` days before today; a day is read only while some target contract still lacks a
// `ledger_files` row for it, so a day is never read twice once stored, and a mirror that lags is caught up on the next
// run. A `hubble` row does not count as present: a complete `ledger_files` day replaces it (C-136, D3); a `hubble` row
// never replaces a `ledger_files` row (that writer is not built).
// Complete days only: the reader marks a day `complete` when its ledgers are contiguous and the neighbouring days'
// boundary ledgers were seen; partial days are not stored (counted as `day_incomplete`).
// Day anchors (register C-144): the reader checks every ledger against its header and the chain between them, which a
// store serving a whole forged but self-consistent chain would pass. So before a complete day is used, its anchor —
// the first ledger after the day, whose hash commits through the verified chain to every ledger of the day — is
// compared with Horizon's `/ledgers/{seq}` hash. A mismatch refuses the day (nothing stored), logs
// `onchain_anchor_mismatch`, sets `scf_onchain_anchor_mismatch_days` (alert OnchainLedgerAnchorMismatch) and fails the
// run (`OnchainAnchorMismatch`); a Horizon that cannot answer leaves the day unverified (not stored, retried next run,
// `scf_onchain_anchor_unverified_days`; the run fails with `OnchainAnchorUnverified`). `ledgerHashes: null` (testnet
// development lake only, SCF_ONCHAIN_LEDGER_HASH_CHECK=off) skips the check and logs `onchain_anchor_check_off`. When the oldest day of the
// window is still missing after the run it will never be retried, so the run fails (alertable through
// scf_job_runs_total{outcome="failure"}).
// Writes: one transaction per tenant under its context, an idempotent upsert (a `hubble` row of the same contract
// and day is replaced). Reads are cross-tenant with the tenant unset (policies: onchain_correlation).
// Privacy: the reader never outputs invokers (its lines are parsed strictly); this job logs counts, days and ids only.

import type { ScfDb } from "../db.ts";
import { errorFields } from "../log.ts";
import { type LedgerHashSource, LedgerHashUnavailableError } from "../onchain/ledger-hashes.ts";
import type {
  FetchResult,
  LedgerMirrorFetcher,
  OnchainSource,
  ReaderRow,
  StellarNetwork,
} from "../onchain/reader.ts";
import { ReaderError } from "../onchain/reader.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import { utcDay } from "../schedule.ts";
import { NETWORK_PASSPHRASE } from "../stellar/xdr.ts";

const JOB = "onchain_correlation" as const;
const DAY_MS = 86_400_000;

export interface OnchainOptions {
  network: StellarNetwork;
  lookbackDays: number;
  /** The fetch step (§p.1); null/absent: the mirror is filled outside this job. */
  fetcher?: LedgerMirrorFetcher | null;
  /** The network's copy of ledger hashes for the day-anchor check (C-144); null only for the testnet dev lake. */
  ledgerHashes: LedgerHashSource | null;
}

export interface OnchainResult {
  targets: number;
  daysRead: string[];
  upserted: number;
  incompleteDays: string[];
  unavailableDays: string[];
  /** Complete days refused because their anchor hash differs from Horizon's (C-144). */
  anchorMismatchDays: string[];
  /** Complete days not used because Horizon could not confirm their anchor (retried next run). */
  anchorUnverifiedDays: string[];
  /** Outcome of the fetch step: null when it did not run. */
  fetch: { fromDay: string; toDay: string; complete: boolean } | null;
}

interface Target {
  tenant_id: string;
  contract_ref: string;
  contract_id: string;
}

/** The `lookback` UTC days before the day of `now`, oldest first. */
export function planDays(now: Date, lookback: number): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let i = lookback; i >= 1; i--) out.push(utcDay(new Date(today - i * DAY_MS)));
  return out;
}

export function onchainCorrelationJob(
  db: ScfDb,
  source: OnchainSource,
  opts: OnchainOptions & { dailyAt: { hour: number; minute: number } },
): JobDef {
  return {
    name: JOB,
    triggers: [{ schedule: { kind: "daily", ...opts.dailyAt }, mode: "daily" }],
    run: async (ctx) => {
      await runOnchainCorrelation(db, source, opts, ctx);
    },
  };
}

export async function runOnchainCorrelation(
  db: ScfDb,
  source: OnchainSource,
  opts: OnchainOptions,
  ctx: JobContext,
): Promise<OnchainResult> {
  const days = planDays(ctx.now, opts.lookbackDays);
  const { targets, present } = await db.tx(JOB, null, async (tx) => ({
    targets: await tx.query<Target>(
      `SELECT c.tenant_id, c.contract_ref, c.contract_id
         FROM scf.declared_contracts c JOIN scf.tenants t USING (tenant_id)
        WHERE t.onchain_correlation_enabled AND t.status <> 'removed'
          AND c.status = 'verified' AND c.removed_at IS NULL AND c.conflict_since IS NULL AND c.network = $1
        ORDER BY c.tenant_id, c.contract_ref`,
      [opts.network],
    ),
    present: await tx.query<{ tenant_id: string; contract_ref: string; day: string }>(
      `SELECT tenant_id, contract_ref, day::text AS day FROM scf.onchain_daily
        WHERE day = ANY($1::date[]) AND data_source = 'ledger_files'`,
      [days],
    ),
  }));
  const have = new Set(present.map((p) => `${p.tenant_id}/${p.contract_ref}/${p.day}`));
  const missing = days.filter((d) =>
    targets.some((t) => !have.has(`${t.tenant_id}/${t.contract_ref}/${d}`)),
  );
  const res: OnchainResult = {
    targets: targets.length,
    daysRead: [],
    upserted: 0,
    incompleteDays: [],
    unavailableDays: [],
    anchorMismatchDays: [],
    anchorUnverifiedDays: [],
    fetch: null,
  };
  if (targets.length === 0 || missing.length === 0) {
    // Nothing left to check: no refused day remains in the window.
    if (opts.ledgerHashes) {
      ctx.metrics.onchain.anchorMismatchDays.set({ network: opts.network }, 0);
      ctx.metrics.onchain.anchorUnverifiedDays.set({ network: opts.network }, 0);
    }
    ctx.log.info("onchain_correlation_done", {
      job: JOB,
      targets: targets.length,
      days_read: 0,
      upserted: 0,
    });
    return res;
  }
  checkAborted(ctx.signal);

  const contracts = [...new Set(targets.map((t) => t.contract_id))].sort();
  const fromDay = missing[0] as string;
  const toDay = missing[missing.length - 1] as string;

  // Step 1: fetch the days the count needs into the mirror (§p.1). Exit 1 → continue; the count stores complete days
  // only. Any other failure (usage, spawn, timeout) fails the run before the count.
  let fetched: FetchResult | null = null;
  if (opts.fetcher) {
    try {
      fetched = await opts.fetcher.fetch(
        { passphrase: NETWORK_PASSPHRASE[opts.network], fromDay, toDay },
        ctx.signal,
      );
    } catch (err) {
      ctx.log.error("onchain_fetch_failed", {
        job: JOB,
        from_day: fromDay,
        to_day: toDay,
        ...errorFields(err),
      });
      throw err;
    }
    res.fetch = { fromDay, toDay, complete: fetched.complete };
    ctx.metrics.units.inc({
      job: JOB,
      outcome: fetched.complete ? "fetch_complete" : "fetch_incomplete",
    });
    ctx.log.info("onchain_fetch_done", {
      job: JOB,
      from_day: fromDay,
      to_day: toDay,
      complete: fetched.complete,
      files: fetched.summary.files ?? null,
      bytes: fetched.summary.bytes ?? null,
    });
    checkAborted(ctx.signal);
  }
  const { rows, summary } = await source.read(
    { network: opts.network, fromDay, toDay, contracts },
    ctx.signal,
  );
  checkAborted(ctx.signal);

  const wantedDays = new Set(missing);
  const complete = new Map<string, ReaderRow>(); // contract/day → row
  const seenDays = new Set<string>();
  const incomplete = new Set<string>();
  const anchors = new Map<string, { ledger: number; hash: string }>(); // day → anchor
  for (const r of rows) {
    if (!wantedDays.has(r.day)) continue;
    seenDays.add(r.day);
    if (!r.complete) {
      incomplete.add(r.day);
      continue;
    }
    complete.set(`${r.contract}/${r.day}`, r);
    const a = anchors.get(r.day);
    // Every row of a day names the same anchor; anything else is not the reader's output.
    if (a && (a.ledger !== r.anchor_ledger || a.hash !== r.anchor_hash))
      throw new ReaderError("invalid_output");
    anchors.set(r.day, { ledger: r.anchor_ledger as number, hash: r.anchor_hash as string });
  }
  res.daysRead = [...seenDays].sort();
  res.incompleteDays = [...incomplete].sort();
  res.unavailableDays = missing.filter((d) => !seenDays.has(d));

  // Day anchors against Horizon (C-144) before any count of the day is used.
  const refuse = (day: string): void => {
    for (const k of [...complete.keys()]) if (k.endsWith(`/${day}`)) complete.delete(k);
  };
  if (opts.ledgerHashes) {
    for (const [day, a] of [...anchors].sort(([x], [y]) => x.localeCompare(y))) {
      checkAborted(ctx.signal);
      let network: string | null;
      try {
        network = await opts.ledgerHashes.ledgerHash(a.ledger, ctx.signal);
      } catch (err) {
        if (!(err instanceof LedgerHashUnavailableError)) throw err;
        network = null;
        ctx.log.warn("onchain_anchor_unverified", {
          job: JOB,
          day,
          ledger: a.ledger,
          reason: err.message,
        });
      }
      if (network === null) {
        res.anchorUnverifiedDays.push(day);
        refuse(day);
      } else if (network !== a.hash) {
        res.anchorMismatchDays.push(day);
        refuse(day);
        ctx.log.error("onchain_anchor_mismatch", {
          job: JOB,
          day,
          ledger: a.ledger,
          store_hash: a.hash,
          network_hash: network,
        });
      }
    }
    ctx.metrics.onchain.anchorMismatchDays.set(
      { network: opts.network },
      res.anchorMismatchDays.length,
    );
    ctx.metrics.onchain.anchorUnverifiedDays.set(
      { network: opts.network },
      res.anchorUnverifiedDays.length,
    );
    ctx.metrics.units.inc(
      { job: JOB, outcome: "day_anchor_verified" },
      anchors.size - res.anchorMismatchDays.length - res.anchorUnverifiedDays.length,
    );
    ctx.metrics.units.inc(
      { job: JOB, outcome: "day_anchor_mismatch" },
      res.anchorMismatchDays.length,
    );
    ctx.metrics.units.inc(
      { job: JOB, outcome: "day_anchor_unverified" },
      res.anchorUnverifiedDays.length,
    );
  } else if (anchors.size > 0) {
    ctx.log.warn("onchain_anchor_check_off", { job: JOB, days: anchors.size });
  }

  const byTenant = new Map<string, Target[]>();
  for (const t of targets) byTenant.set(t.tenant_id, [...(byTenant.get(t.tenant_id) ?? []), t]);
  for (const [tenantId, ts] of byTenant) {
    checkAborted(ctx.signal);
    const refs: string[] = [];
    const ds: string[] = [];
    const inv: number[] = [];
    const ok: number[] = [];
    const who: number[] = [];
    for (const t of ts) {
      for (const d of missing) {
        if (have.has(`${tenantId}/${t.contract_ref}/${d}`)) continue;
        const r = complete.get(`${t.contract_id}/${d}`);
        if (!r) continue;
        refs.push(t.contract_ref);
        ds.push(d);
        inv.push(r.invocations);
        ok.push(r.successful_invocations);
        who.push(r.distinct_invokers);
      }
    }
    if (refs.length === 0) continue;
    res.upserted += await db.tx(JOB, tenantId, (tx) =>
      tx.exec(
        `INSERT INTO scf.onchain_daily AS o (tenant_id, contract_ref, day, invocations, successful_invocations,
                                             distinct_invokers, data_source, computed_at)
         SELECT $1::uuid, x.ref, x.day, x.inv, x.ok, x.who, 'ledger_files', now()
           FROM unnest($2::uuid[], $3::date[], $4::bigint[], $5::bigint[], $6::bigint[]) AS x(ref, day, inv, ok, who)
         ON CONFLICT (tenant_id, contract_ref, day) DO UPDATE
            SET invocations = EXCLUDED.invocations, successful_invocations = EXCLUDED.successful_invocations,
                distinct_invokers = EXCLUDED.distinct_invokers, data_source = 'ledger_files',
                computed_at = EXCLUDED.computed_at`,
        [tenantId, refs, ds, inv, ok, who],
      ),
    );
  }

  ctx.metrics.rows.inc({ job: JOB, relation: "onchain_daily", action: "upserted" }, res.upserted);
  ctx.metrics.units.inc(
    { job: JOB, outcome: "day_incomplete" },
    res.incompleteDays.length + res.unavailableDays.length,
  );
  ctx.log.info("onchain_correlation_done", {
    job: JOB,
    targets: targets.length,
    contracts: contracts.length,
    from_day: fromDay,
    to_day: toDay,
    days_read: res.daysRead.length,
    upserted: res.upserted,
    days_incomplete: res.incompleteDays.length,
    days_unavailable: res.unavailableDays.length,
    days_anchor_mismatch: res.anchorMismatchDays.length,
    days_anchor_unverified: res.anchorUnverifiedDays.length,
    ledgers: summary.ledgers ?? null,
    transactions: summary.transactions ?? null,
  });
  // A forged store is the most serious outcome: it fails the run before anything else is reported.
  if (res.anchorMismatchDays.length > 0) {
    throw Object.assign(
      new Error("ledger store disagrees with Horizon on a day anchor; the day was refused"),
      { name: "OnchainAnchorMismatch" },
    );
  }
  const oldest = days[0] as string;
  const oldestStored =
    !missing.includes(oldest) ||
    targets.every(
      (t) =>
        have.has(`${t.tenant_id}/${t.contract_ref}/${oldest}`) ||
        complete.has(`${t.contract_id}/${oldest}`),
    );
  if (!oldestStored) {
    ctx.log.warn("onchain_correlation_day_lost", { job: JOB, day: oldest });
    throw Object.assign(new Error("oldest day of the window has no complete ledger data"), {
      name: "OnchainDayIncomplete",
    });
  }
  // A fetch that could not complete while some day is still not stored is alertable (the next run retries).
  if (fetched && !fetched.complete && res.incompleteDays.length + res.unavailableDays.length > 0) {
    throw Object.assign(new Error("ledger files could not be fetched for every day"), {
      name: "OnchainFetchIncomplete",
    });
  }
  if (res.anchorUnverifiedDays.length > 0) {
    throw Object.assign(new Error("Horizon could not confirm every day anchor; retried next run"), {
      name: "OnchainAnchorUnverified",
    });
  }
  return res;
}
