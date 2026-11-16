// SPDX-License-Identifier: Apache-2.0
// Job `usage_map` (daily, default 07:30 UTC, after onchain_correlation; migration 0075): the Ecosystem
// Usage Map — daily on-chain usage of EVERY registry project that lists contract ids (scf.registry_projects, synced by
// registry_sync from the public sources), computed by `onchain-reader usage` from the same local mirror of public
// ledger files that onchain_correlation reads (SCF_ONCHAIN_LEDGER_DIR), whether or not the project is a tenant.
//
// Per project and UTC day: invocations, successful invocations, distinct invokers (over all its contracts), contract
// calls; per contract and day the same; per contract, function and caller kind (account | contract) and day: calls;
// per project and ISO week: the weekly active accounts of the SCF Growth Hack definition (both readings: any included
// operation, successful only — see the reader's README "Usage map"). Accounts are counted in the reader's memory and
// discarded; this job never sees one.
//
// Which days: the `lookbackDays` (1…7, the mirror keeps 7) UTC days before today. A day is read while it is not stored
// or some listed project lacks a row for it (a project added to the registry is filled in for the window); weeks: the
// ISO weeks whose seven days all lie in the window, read while some project lacks the week's row. One reader run
// covers the union (a week needs its seven days in ONE run: distinct accounts cannot be summed across runs). Backfill
// is therefore bounded by the ledger data the mirror holds; older history is not reconstructed.
// Fetch: as onchain_correlation, `onchain-reader fetch` fills the mirror for the range first (optional).
// Day anchors (C-144): a complete day is used only when its anchor hash equals Horizon's; a mismatch refuses it and
// fails the run (`UsageMapAnchorMismatch`); a Horizon that cannot answer leaves the day for the next run
// (`UsageMapAnchorUnverified`). `ledgerHashes: null` (testnet development lake only) stores `anchor_checked = false`.
// Writes: per day one transaction: DELETE its scf.usage_map_days row (every figure of the day cascades) and INSERT the
// day afresh — idempotent; per week DELETE + INSERT of its rows. Retention: days and weeks older than 25 months.
// Visibility of the stored rows (operators only for unclaimed projects; claimed projects to their tenant) is RLS and
// the op_* functions of 0075, not this job's concern.

import type { ScfDb } from "../db.ts";
import { errorFields } from "../log.ts";
import { type LedgerHashSource, LedgerHashUnavailableError } from "../onchain/ledger-hashes.ts";
import type { LedgerMirrorFetcher, StellarNetwork } from "../onchain/reader.ts";
import { ReaderError } from "../onchain/reader.ts";
import type { UsageMember, UsageOutput, UsageSource } from "../onchain/usage.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import { utcDay } from "../schedule.ts";
import { NETWORK_PASSPHRASE, strkeyDecode } from "../stellar/xdr.ts";
import { planDays } from "./onchain-correlation.ts";

const JOB = "usage_map" as const;
const DAY_MS = 86_400_000;
const CONTRACT_VERSION = 2 << 3; // strkey version byte of a contract (C…)
export const RETAIN_MONTHS = 25;

export interface UsageMapOptions {
  network: StellarNetwork;
  lookbackDays: number;
  fetcher?: LedgerMirrorFetcher | null;
  /** The network's copy of ledger hashes for the day-anchor check (C-144); null only for the testnet dev lake. */
  ledgerHashes: LedgerHashSource | null;
}

export interface UsageMapResult {
  projects: number;
  contracts: number;
  /** Registry contract ids that are not valid C… strkeys (skipped). */
  invalidContracts: number;
  fromDay: string | null;
  toDay: string | null;
  daysStored: string[];
  weeksStored: string[];
  incompleteDays: string[];
  anchorMismatchDays: string[];
  anchorUnverifiedDays: string[];
  pruned: number;
}

/** The ISO weeks (their Mondays) whose seven days are all in `days` (ascending, consecutive UTC days). */
export function wholeWeeks(days: readonly string[]): string[] {
  const set = new Set(days);
  const out: string[] = [];
  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);
    if (new Date(t).getUTCDay() !== 1) continue;
    let all = true;
    for (let i = 0; i < 7 && all; i++) all = set.has(utcDay(new Date(t + i * DAY_MS)));
    if (all) out.push(d);
  }
  return out;
}

export function weekDays(monday: string): string[] {
  const t = Date.parse(`${monday}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => utcDay(new Date(t + i * DAY_MS)));
}

/** True for a valid contract strkey (checksum included): registry data is third-party input. */
export function validContract(s: string): boolean {
  try {
    strkeyDecode(s, CONTRACT_VERSION);
    return s.startsWith("C");
  } catch {
    return false;
  }
}

export const storedNetwork = (n: StellarNetwork): "mainnet" | "testnet" =>
  n === "public" ? "mainnet" : "testnet";

interface Project {
  registry_project_id: string;
  contract_ids: string[];
}

export function usageMapJob(
  db: ScfDb,
  source: UsageSource,
  opts: UsageMapOptions & { dailyAt: { hour: number; minute: number } },
): JobDef {
  return {
    name: JOB,
    triggers: [{ schedule: { kind: "daily", ...opts.dailyAt }, mode: "daily" }],
    run: async (ctx) => {
      await runUsageMap(db, source, opts, ctx);
    },
  };
}

export async function runUsageMap(
  db: ScfDb,
  source: UsageSource,
  opts: UsageMapOptions,
  ctx: JobContext,
): Promise<UsageMapResult> {
  if (!Number.isInteger(opts.lookbackDays) || opts.lookbackDays < 1 || opts.lookbackDays > 7)
    throw new RangeError("usage_map lookback must be 1…7 days (the mirror keeps 7)");
  const net = storedNetwork(opts.network);
  const days = planDays(ctx.now, opts.lookbackDays);
  const weeks = wholeWeeks(days);
  const { rows, storedDays, projectDays, projectWeeks } = await db.tx(JOB, null, async (tx) => ({
    rows: await tx.query<Project>(
      `SELECT registry_project_id::text, contract_ids FROM scf.registry_projects
        WHERE missing_since IS NULL AND cardinality(contract_ids) > 0 ORDER BY registry_project_id`,
    ),
    storedDays: await tx.query<{ day: string }>(
      `SELECT day::text AS day FROM scf.usage_map_days WHERE network = $1 AND day = ANY($2::date[])`,
      [net, days],
    ),
    projectDays: await tx.query<{ registry_project_id: string; day: string }>(
      `SELECT registry_project_id::text, day::text AS day FROM scf.usage_map_project_daily
        WHERE network = $1 AND day = ANY($2::date[])`,
      [net, days],
    ),
    projectWeeks: await tx.query<{ registry_project_id: string; week_start: string }>(
      `SELECT registry_project_id::text, week_start::text AS week_start FROM scf.usage_map_project_weekly
        WHERE network = $1 AND week_start = ANY($2::date[])`,
      [net, weeks],
    ),
  }));

  const res: UsageMapResult = {
    projects: 0,
    contracts: 0,
    invalidContracts: 0,
    fromDay: null,
    toDay: null,
    daysStored: [],
    weeksStored: [],
    incompleteDays: [],
    anchorMismatchDays: [],
    anchorUnverifiedDays: [],
    pruned: 0,
  };
  const members: UsageMember[] = [];
  const listed = new Map<string, number>(); // project → valid contracts listed
  const invalid = new Set<string>();
  for (const p of rows) {
    const valid = [...new Set(p.contract_ids)].filter((c) => {
      const ok = validContract(c);
      if (!ok) invalid.add(c);
      return ok;
    });
    if (valid.length === 0) continue;
    listed.set(p.registry_project_id, valid.length);
    for (const c of valid) members.push({ group: p.registry_project_id, contract: c });
  }
  res.projects = listed.size;
  res.contracts = new Set(members.map((m) => m.contract)).size;
  res.invalidContracts = invalid.size;

  const haveDay = new Set(storedDays.map((d) => d.day));
  const havePD = new Set(projectDays.map((r) => `${r.registry_project_id}/${r.day}`));
  const havePW = new Set(projectWeeks.map((r) => `${r.registry_project_id}/${r.week_start}`));
  const projects = [...listed.keys()];
  const missingDays = days.filter(
    (d) => !haveDay.has(d) || projects.some((p) => !havePD.has(`${p}/${d}`)),
  );
  const missingWeeks = weeks.filter((w) => projects.some((p) => !havePW.has(`${p}/${w}`)));
  const needed = new Set([...missingDays, ...missingWeeks.flatMap(weekDays)]);

  if (members.length === 0 || needed.size === 0) {
    res.pruned = await prune(db, net, ctx.now);
    ctx.log.info("usage_map_done", {
      job: JOB,
      projects: res.projects,
      contracts: res.contracts,
      days_stored: 0,
      weeks_stored: 0,
      pruned: res.pruned,
    });
    return res;
  }
  const sorted = [...needed].sort();
  const fromDay = sorted[0] as string;
  const toDay = sorted[sorted.length - 1] as string;
  res.fromDay = fromDay;
  res.toDay = toDay;
  checkAborted(ctx.signal);

  let fetchComplete: boolean | null = null;
  if (opts.fetcher) {
    try {
      const f = await opts.fetcher.fetch(
        { passphrase: NETWORK_PASSPHRASE[opts.network], fromDay, toDay },
        ctx.signal,
      );
      fetchComplete = f.complete;
      ctx.metrics.units.inc({
        job: JOB,
        outcome: f.complete ? "fetch_complete" : "fetch_incomplete",
      });
    } catch (err) {
      ctx.log.error("usage_map_fetch_failed", {
        job: JOB,
        from_day: fromDay,
        to_day: toDay,
        ...errorFields(err),
      });
      throw err;
    }
    checkAborted(ctx.signal);
  }

  const out = await source.read({ network: opts.network, fromDay, toDay, members }, ctx.signal);
  checkAborted(ctx.signal);

  // Days: complete, then anchored against Horizon.
  const verified = new Set<string>();
  const dayLine = new Map(out.days.map((d) => [d.day, d]));
  for (const d of sorted) {
    const line = dayLine.get(d);
    if (!line?.complete) {
      res.incompleteDays.push(d);
      continue;
    }
    if (!opts.ledgerHashes) {
      verified.add(d);
      continue;
    }
    checkAborted(ctx.signal);
    let network: string | null;
    try {
      network = await opts.ledgerHashes.ledgerHash(line.anchor_ledger as number, ctx.signal);
    } catch (err) {
      if (!(err instanceof LedgerHashUnavailableError)) throw err;
      network = null;
    }
    if (network === null) res.anchorUnverifiedDays.push(d);
    else if (network !== line.anchor_hash) {
      res.anchorMismatchDays.push(d);
      ctx.log.error("usage_map_anchor_mismatch", {
        job: JOB,
        day: d,
        ledger: line.anchor_ledger,
        store_hash: line.anchor_hash,
        network_hash: network,
      });
    } else verified.add(d);
  }
  if (!opts.ledgerHashes && verified.size > 0)
    ctx.log.warn("usage_map_anchor_check_off", { job: JOB, days: verified.size });

  // Every verified day of the range is (re)written: idempotent, and new projects are filled in.
  for (const d of sorted) {
    if (!verified.has(d)) continue;
    checkAborted(ctx.signal);
    await writeDay(db, net, d, out, listed, dayLine.get(d) as UsageOutput["days"][number], opts);
    res.daysStored.push(d);
  }
  for (const w of weeks) {
    if (!weekDays(w).every((d) => verified.has(d))) continue;
    const lines = out.weeks.filter((x) => x.week_start === w);
    if (lines.length === 0) continue; // the reader saw the week incomplete (cannot happen when every day verified)
    checkAborted(ctx.signal);
    await db.tx(JOB, null, async (tx) => {
      await tx.exec(
        "DELETE FROM scf.usage_map_project_weekly WHERE network = $1 AND week_start = $2",
        [net, w],
      );
      await tx.exec(
        `INSERT INTO scf.usage_map_project_weekly (registry_project_id, network, week_start, active_accounts,
                       active_accounts_successful, invocations, successful_invocations, contract_calls)
         SELECT x.p, $1, $2::date, x.aa, x.aas, x.inv, x.ok, x.calls
           FROM unnest($3::uuid[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[])
                AS x(p, aa, aas, inv, ok, calls)`,
        [
          net,
          w,
          lines.map((l) => l.group),
          lines.map((l) => l.active_accounts),
          lines.map((l) => l.active_accounts_successful),
          lines.map((l) => l.invocations),
          lines.map((l) => l.successful_invocations),
          lines.map((l) => l.contract_calls),
        ],
      );
    });
    res.weeksStored.push(w);
  }
  res.pruned = await prune(db, net, ctx.now);

  ctx.metrics.units.inc({ job: JOB, outcome: "day_stored" }, res.daysStored.length);
  ctx.metrics.units.inc({ job: JOB, outcome: "week_stored" }, res.weeksStored.length);
  ctx.metrics.units.inc({ job: JOB, outcome: "day_incomplete" }, res.incompleteDays.length);
  ctx.metrics.units.inc(
    { job: JOB, outcome: "day_anchor_mismatch" },
    res.anchorMismatchDays.length,
  );
  ctx.metrics.units.inc(
    { job: JOB, outcome: "day_anchor_unverified" },
    res.anchorUnverifiedDays.length,
  );
  ctx.log.info("usage_map_done", {
    job: JOB,
    projects: res.projects,
    contracts: res.contracts,
    invalid_contracts: res.invalidContracts,
    from_day: fromDay,
    to_day: toDay,
    days_stored: res.daysStored.length,
    weeks_stored: res.weeksStored.length,
    days_incomplete: res.incompleteDays.length,
    days_anchor_mismatch: res.anchorMismatchDays.length,
    days_anchor_unverified: res.anchorUnverifiedDays.length,
    pruned: res.pruned,
    ledgers: out.summary.ledgers ?? null,
    invocations: out.summary.invocations ?? null,
    contract_calls: out.summary.contract_calls ?? null,
  });

  if (res.anchorMismatchDays.length > 0)
    throw Object.assign(
      new Error("ledger store disagrees with Horizon on a day anchor; the day was refused"),
      { name: "UsageMapAnchorMismatch" },
    );
  // The oldest day of the window leaves the mirror before the next run: if it is still missing it is lost.
  const oldest = days[0] as string;
  if (missingDays.includes(oldest) && !verified.has(oldest)) {
    ctx.log.warn("usage_map_day_lost", { job: JOB, day: oldest });
    throw Object.assign(new Error("oldest day of the window has no verified ledger data"), {
      name: "UsageMapDayIncomplete",
    });
  }
  if (fetchComplete === false && res.incompleteDays.length > 0)
    throw Object.assign(new Error("ledger files could not be fetched for every day"), {
      name: "UsageMapFetchIncomplete",
    });
  if (res.anchorUnverifiedDays.length > 0)
    throw Object.assign(new Error("Horizon could not confirm every day anchor; retried next run"), {
      name: "UsageMapAnchorUnverified",
    });
  return res;
}

async function writeDay(
  db: ScfDb,
  net: string,
  day: string,
  out: UsageOutput,
  listed: ReadonlyMap<string, number>,
  line: UsageOutput["days"][number],
  opts: UsageMapOptions,
): Promise<void> {
  const groups = out.groups.filter((g) => g.day === day && listed.has(g.group));
  const contracts = out.contracts.filter((c) => c.day === day);
  const fns = out.functions.filter((f) => f.day === day);
  if (groups.length !== listed.size) throw new ReaderError("invalid_output"); // one line per group and day
  await db.tx(JOB, null, async (tx) => {
    await tx.exec("DELETE FROM scf.usage_map_days WHERE network = $1 AND day = $2", [net, day]);
    await tx.exec(
      `INSERT INTO scf.usage_map_days (network, day, ledgers, ledger_first, ledger_last, anchor_ledger, anchor_hash,
                                       anchor_checked, projects, contracts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        net,
        day,
        line.ledgers_in_day,
        line.ledger_first,
        line.ledger_last,
        line.anchor_ledger,
        line.anchor_hash,
        opts.ledgerHashes !== null,
        groups.length,
        contracts.length,
      ],
    );
    await tx.exec(
      `INSERT INTO scf.usage_map_project_daily (registry_project_id, network, day, invocations, successful_invocations,
                     distinct_invokers, contract_calls, contracts_listed, contracts_invoked)
       SELECT x.p, $1, $2::date, x.inv, x.ok, x.who, x.calls, x.listed, x.invoked
         FROM unnest($3::uuid[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::int[], $9::int[])
              AS x(p, inv, ok, who, calls, listed, invoked)`,
      [
        net,
        day,
        groups.map((g) => g.group),
        groups.map((g) => g.invocations),
        groups.map((g) => g.successful_invocations),
        groups.map((g) => g.distinct_invokers),
        groups.map((g) => g.contract_calls),
        groups.map((g) => listed.get(g.group) as number),
        groups.map((g) => g.contracts_invoked),
      ],
    );
    await tx.exec(
      `INSERT INTO scf.usage_map_contract_daily (network, day, contract_id, invocations, successful_invocations,
                     distinct_invokers, contract_calls, successful_contract_calls)
       SELECT $1, $2::date, x.c, x.inv, x.ok, x.who, x.calls, x.okc
         FROM unnest($3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[])
              AS x(c, inv, ok, who, calls, okc)`,
      [
        net,
        day,
        contracts.map((c) => c.contract),
        contracts.map((c) => c.invocations),
        contracts.map((c) => c.successful_invocations),
        contracts.map((c) => c.distinct_invokers),
        contracts.map((c) => c.contract_calls),
        contracts.map((c) => c.successful_contract_calls),
      ],
    );
    if (fns.length > 0)
      await tx.exec(
        `INSERT INTO scf.usage_map_function_daily (network, day, contract_id, function_name, caller_kind, calls,
                       successful_calls)
         SELECT $1, $2::date, x.c, x.f, x.k, x.calls, x.ok
           FROM unnest($3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[]) AS x(c, f, k, calls, ok)`,
        [
          net,
          day,
          fns.map((f) => f.contract),
          fns.map((f) => f.function),
          fns.map((f) => f.caller_kind),
          fns.map((f) => f.calls),
          fns.map((f) => f.successful_calls),
        ],
      );
  });
}

async function prune(db: ScfDb, net: string, now: Date): Promise<number> {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETAIN_MONTHS, now.getUTCDate()),
  );
  const day = utcDay(cutoff);
  return db.tx(JOB, null, async (tx) => {
    const a = await tx.exec("DELETE FROM scf.usage_map_days WHERE network = $1 AND day < $2", [
      net,
      day,
    ]);
    const b = await tx.exec(
      "DELETE FROM scf.usage_map_project_weekly WHERE network = $1 AND week_start < $2",
      [net, day],
    );
    return a + b;
  });
}
