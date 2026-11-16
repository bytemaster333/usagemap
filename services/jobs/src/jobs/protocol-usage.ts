// SPDX-License-Identifier: Apache-2.0
// Job `protocol_usage` (daily, default 07:45 UTC, after usage_map; migration 0082): the
// DeFi protocols the users of a project interact with. Per UTC day, for every registry project that lists contract ids
// and every opted-in tenant's verified contracts (the §p list of onchain_correlation), how many transactions touching
// the subject's contracts also touch the public contracts of Blend, Soroswap, DeFindex, Aquarius or Reflector (the
// curated registry src/onchain/protocols/registry.json, versioned; the version is stored with every row), plus each
// protocol's network-wide transaction count. Computed by `onchain-reader protocols` from the same local mirror of
// public ledger files as onchain_correlation and usage_map (SCF_ONCHAIN_LEDGER_DIR); only the protocol label of a
// transaction is kept — no contract of the transaction and no account ever reaches this job.
//
// Days: the `lookbackDays` (1…7) UTC days before today; a day is read while it is not stored or a subject lacks its
// row for it (a new registry project or a newly verified tenant contract is filled in for the window). Day anchors as
// usage_map (C-144): a complete day is used only when its anchor equals Horizon's; a mismatch refuses the day and fails
// the run; an unanswered Horizon leaves the day for the next run; `ledgerHashes: null` (testnet dev lake) stores
// anchor_checked = false.
// Writes, per verified day: one global transaction (DELETE the scf.protocol_usage_days row — network and project rows
// cascade — and INSERT afresh), then one transaction per tenant under its context (DELETE + INSERT of its rows of the
// day). Idempotent. Retention: 25 months (global days cascade; tenant rows per tenant under its context).

import type { ScfDb } from "../db.ts";
import { errorFields } from "../log.ts";
import { type LedgerHashSource, LedgerHashUnavailableError } from "../onchain/ledger-hashes.ts";
import type { ProtoOutput, ProtoSource } from "../onchain/protocols/reader.ts";
import {
  type ProtocolRegistry,
  protocolContracts,
  REGISTRY,
} from "../onchain/protocols/registry.ts";
import type { LedgerMirrorFetcher, StellarNetwork } from "../onchain/reader.ts";
import { ReaderError } from "../onchain/reader.ts";
import type { JobContext, JobDef } from "../runner.ts";
import { checkAborted } from "../runner.ts";
import { utcDay } from "../schedule.ts";
import { NETWORK_PASSPHRASE } from "../stellar/xdr.ts";
import { planDays } from "./onchain-correlation.ts";
import { RETAIN_MONTHS, storedNetwork, validContract } from "./usage-map.ts";

const JOB = "protocol_usage" as const;

export interface ProtocolUsageOptions {
  network: StellarNetwork;
  lookbackDays: number;
  fetcher?: LedgerMirrorFetcher | null;
  ledgerHashes: LedgerHashSource | null;
  /** The protocol registry (tests pass their own; production the curated registry.json). */
  registry?: ProtocolRegistry;
}

export interface ProtocolUsageResult {
  projects: number;
  tenants: number;
  fromDay: string | null;
  toDay: string | null;
  daysStored: string[];
  incompleteDays: string[];
  anchorMismatchDays: string[];
  anchorUnverifiedDays: string[];
  pruned: number;
}

/** Group labels: the reader's groups are opaque; the subject kind is in the prefix. */
export const projectGroup = (id: string) => `p-${id}`;
export const tenantGroup = (id: string) => `t-${id}`;

export function protocolUsageJob(
  db: ScfDb,
  source: ProtoSource,
  opts: ProtocolUsageOptions & { dailyAt: { hour: number; minute: number } },
): JobDef {
  return {
    name: JOB,
    triggers: [{ schedule: { kind: "daily", ...opts.dailyAt }, mode: "daily" }],
    run: async (ctx) => {
      await runProtocolUsage(db, source, opts, ctx);
    },
  };
}

export async function runProtocolUsage(
  db: ScfDb,
  source: ProtoSource,
  opts: ProtocolUsageOptions,
  ctx: JobContext,
): Promise<ProtocolUsageResult> {
  if (!Number.isInteger(opts.lookbackDays) || opts.lookbackDays < 1 || opts.lookbackDays > 7)
    throw new RangeError("protocol_usage lookback must be 1…7 days (the mirror keeps 7)");
  const registry = opts.registry ?? REGISTRY;
  const net = storedNetwork(opts.network);
  const days = planDays(ctx.now, opts.lookbackDays);
  const loaded = await db.tx(JOB, null, async (tx) => ({
    projects: await tx.query<{ registry_project_id: string; contract_ids: string[] }>(
      `SELECT registry_project_id::text, contract_ids FROM scf.registry_projects
        WHERE missing_since IS NULL AND cardinality(contract_ids) > 0 ORDER BY registry_project_id`,
    ),
    tenants: await tx.query<{ tenant_id: string; contract_id: string }>(
      `SELECT c.tenant_id::text, c.contract_id
         FROM scf.declared_contracts c JOIN scf.tenants t USING (tenant_id)
        WHERE t.onchain_correlation_enabled AND t.status <> 'removed'
          AND c.status = 'verified' AND c.removed_at IS NULL AND c.conflict_since IS NULL AND c.network = $1
        ORDER BY c.tenant_id, c.contract_id`,
      [opts.network],
    ),
    storedDays: await tx.query<{ day: string }>(
      `SELECT day::text AS day FROM scf.protocol_usage_days WHERE network = $1 AND day = ANY($2::date[])`,
      [net, days],
    ),
    projectDays: await tx.query<{ id: string; day: string }>(
      `SELECT registry_project_id::text AS id, day::text AS day FROM scf.protocol_usage_project_daily
        WHERE network = $1 AND day = ANY($2::date[]) AND protocol = 'any'`,
      [net, days],
    ),
    tenantDays: await tx.query<{ id: string; day: string }>(
      `SELECT tenant_id::text AS id, day::text AS day FROM scf.protocol_usage_tenant_daily
        WHERE network = $1 AND day = ANY($2::date[]) AND protocol = 'any'`,
      [net, days],
    ),
  }));

  const members: { group: string; contract: string }[] = [];
  const projectContracts = new Map<string, number>();
  for (const p of loaded.projects) {
    const valid = [...new Set(p.contract_ids)].filter(validContract);
    if (valid.length === 0) continue;
    projectContracts.set(p.registry_project_id, valid.length);
    for (const c of valid)
      members.push({ group: projectGroup(p.registry_project_id), contract: c });
  }
  const tenantContracts = new Map<string, number>();
  for (const t of loaded.tenants) {
    if (!validContract(t.contract_id)) continue;
    tenantContracts.set(t.tenant_id, (tenantContracts.get(t.tenant_id) ?? 0) + 1);
    members.push({ group: tenantGroup(t.tenant_id), contract: t.contract_id });
  }
  const protocols = protocolContracts(registry, net);
  const res: ProtocolUsageResult = {
    projects: projectContracts.size,
    tenants: tenantContracts.size,
    fromDay: null,
    toDay: null,
    daysStored: [],
    incompleteDays: [],
    anchorMismatchDays: [],
    anchorUnverifiedDays: [],
    pruned: 0,
  };

  const haveDay = new Set(loaded.storedDays.map((d) => d.day));
  const havePD = new Set(loaded.projectDays.map((r) => `${r.id}/${r.day}`));
  const haveTD = new Set(loaded.tenantDays.map((r) => `${r.id}/${r.day}`));
  const missing = days.filter(
    (d) =>
      !haveDay.has(d) ||
      [...projectContracts.keys()].some((p) => !havePD.has(`${p}/${d}`)) ||
      [...tenantContracts.keys()].some((t) => !haveTD.has(`${t}/${d}`)),
  );
  if (members.length === 0 || protocols.length === 0 || missing.length === 0) {
    res.pruned = await prune(db, net, ctx.now);
    ctx.log.info("protocol_usage_done", {
      job: JOB,
      projects: res.projects,
      tenants: res.tenants,
      days_stored: 0,
      pruned: res.pruned,
    });
    return res;
  }
  const fromDay = missing[0] as string;
  const toDay = missing[missing.length - 1] as string;
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
    } catch (err) {
      ctx.log.error("protocol_usage_fetch_failed", {
        job: JOB,
        from_day: fromDay,
        to_day: toDay,
        ...errorFields(err),
      });
      throw err;
    }
    checkAborted(ctx.signal);
  }

  const out = await source.read(
    { network: opts.network, fromDay, toDay, members, protocols },
    ctx.signal,
  );
  checkAborted(ctx.signal);

  const dayLine = new Map(out.days.map((d) => [d.day, d]));
  const verified = new Set<string>();
  for (const d of missing) {
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
    let hash: string | null;
    try {
      hash = await opts.ledgerHashes.ledgerHash(line.anchor_ledger as number, ctx.signal);
    } catch (err) {
      if (!(err instanceof LedgerHashUnavailableError)) throw err;
      hash = null;
    }
    if (hash === null) res.anchorUnverifiedDays.push(d);
    else if (hash !== line.anchor_hash) {
      res.anchorMismatchDays.push(d);
      ctx.log.error("protocol_usage_anchor_mismatch", {
        job: JOB,
        day: d,
        ledger: line.anchor_ledger,
        store_hash: line.anchor_hash,
        network_hash: hash,
      });
    } else verified.add(d);
  }

  for (const d of missing) {
    if (!verified.has(d)) continue;
    checkAborted(ctx.signal);
    await writeDay(db, net, d, out, projectContracts, tenantContracts, registry.version, opts);
    res.daysStored.push(d);
  }
  res.pruned = await prune(db, net, ctx.now);

  ctx.metrics.units.inc({ job: JOB, outcome: "day_stored" }, res.daysStored.length);
  ctx.metrics.units.inc({ job: JOB, outcome: "day_incomplete" }, res.incompleteDays.length);
  ctx.metrics.units.inc(
    { job: JOB, outcome: "day_anchor_mismatch" },
    res.anchorMismatchDays.length,
  );
  ctx.metrics.units.inc(
    { job: JOB, outcome: "day_anchor_unverified" },
    res.anchorUnverifiedDays.length,
  );
  ctx.log.info("protocol_usage_done", {
    job: JOB,
    projects: res.projects,
    tenants: res.tenants,
    registry_version: registry.version,
    from_day: fromDay,
    to_day: toDay,
    days_stored: res.daysStored.length,
    days_incomplete: res.incompleteDays.length,
    days_anchor_mismatch: res.anchorMismatchDays.length,
    days_anchor_unverified: res.anchorUnverifiedDays.length,
    pruned: res.pruned,
    ledgers: out.summary.ledgers ?? null,
    protocol_transactions: out.summary.protocol_transactions ?? null,
  });

  if (res.anchorMismatchDays.length > 0)
    throw Object.assign(
      new Error("ledger store disagrees with Horizon on a day anchor; the day was refused"),
      { name: "ProtocolUsageAnchorMismatch" },
    );
  const oldest = days[0] as string;
  if (missing.includes(oldest) && !verified.has(oldest)) {
    ctx.log.warn("protocol_usage_day_lost", { job: JOB, day: oldest });
    throw Object.assign(new Error("oldest day of the window has no verified ledger data"), {
      name: "ProtocolUsageDayIncomplete",
    });
  }
  if (fetchComplete === false && res.incompleteDays.length > 0)
    throw Object.assign(new Error("ledger files could not be fetched for every day"), {
      name: "ProtocolUsageFetchIncomplete",
    });
  if (res.anchorUnverifiedDays.length > 0)
    throw Object.assign(new Error("Horizon could not confirm every day anchor; retried next run"), {
      name: "ProtocolUsageAnchorUnverified",
    });
  return res;
}

interface Row {
  id: string;
  protocol: string;
  tx: number;
  ok: number;
}

/** The day's rows of one subject kind: the 'any' row from its group line, one row per protocol line. */
function rowsOf(
  out: ProtoOutput,
  day: string,
  prefix: "p-" | "t-",
  ids: ReadonlyMap<string, number>,
): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const g of out.groups) {
    if (g.day !== day || !g.group.startsWith(prefix)) continue;
    const id = g.group.slice(2);
    if (!ids.has(id)) continue;
    seen.add(id);
    rows.push({ id, protocol: "any", tx: g.transactions, ok: g.successful_transactions });
  }
  if (seen.size !== ids.size) throw new ReaderError("invalid_output"); // one group line per subject and day
  for (const p of out.protocols) {
    if (p.day !== day || !p.group.startsWith(prefix)) continue;
    const id = p.group.slice(2);
    if (!ids.has(id)) continue;
    rows.push({ id, protocol: p.protocol, tx: p.transactions, ok: p.successful_transactions });
  }
  return rows;
}

async function writeDay(
  db: ScfDb,
  net: string,
  day: string,
  out: ProtoOutput,
  projects: ReadonlyMap<string, number>,
  tenants: ReadonlyMap<string, number>,
  version: string,
  opts: ProtocolUsageOptions,
): Promise<void> {
  const line = out.days.find((d) => d.day === day) as ProtoOutput["days"][number];
  const pRows = rowsOf(out, day, "p-", projects);
  const tRows = rowsOf(out, day, "t-", tenants);
  const network = out.network.filter((x) => x.day === day);
  await db.tx(JOB, null, async (tx) => {
    await tx.exec("DELETE FROM scf.protocol_usage_days WHERE network = $1 AND day = $2", [
      net,
      day,
    ]);
    await tx.exec(
      `INSERT INTO scf.protocol_usage_days (network, day, ledgers, ledger_first, ledger_last, anchor_ledger, anchor_hash,
                                            anchor_checked, registry_version, projects, tenants)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        net,
        day,
        line.ledgers_in_day,
        line.ledger_first,
        line.ledger_last,
        line.anchor_ledger,
        line.anchor_hash,
        opts.ledgerHashes !== null,
        version,
        projects.size,
        tenants.size,
      ],
    );
    if (network.length > 0)
      await tx.exec(
        `INSERT INTO scf.protocol_usage_network_daily (network, day, protocol, transactions, successful_transactions)
         SELECT $1, $2::date, x.p, x.n, x.ok FROM unnest($3::text[], $4::bigint[], $5::bigint[]) AS x(p, n, ok)`,
        [
          net,
          day,
          network.map((x) => x.protocol),
          network.map((x) => x.transactions),
          network.map((x) => x.successful_transactions),
        ],
      );
    if (pRows.length > 0)
      await tx.exec(
        `INSERT INTO scf.protocol_usage_project_daily (registry_project_id, network, day, protocol, transactions,
                                                       successful_transactions)
         SELECT x.id, $1, $2::date, x.p, x.n, x.ok
           FROM unnest($3::uuid[], $4::text[], $5::bigint[], $6::bigint[]) AS x(id, p, n, ok)`,
        [
          net,
          day,
          pRows.map((r) => r.id),
          pRows.map((r) => r.protocol),
          pRows.map((r) => r.tx),
          pRows.map((r) => r.ok),
        ],
      );
  });
  const byTenant = new Map<string, Row[]>();
  for (const r of tRows) byTenant.set(r.id, [...(byTenant.get(r.id) ?? []), r]);
  for (const [tenantId, rows] of byTenant) {
    await db.tx(JOB, tenantId, async (tx) => {
      await tx.exec(
        "DELETE FROM scf.protocol_usage_tenant_daily WHERE tenant_id = $1 AND network = $2 AND day = $3",
        [tenantId, net, day],
      );
      await tx.exec(
        `INSERT INTO scf.protocol_usage_tenant_daily (tenant_id, network, day, protocol, transactions,
                                                      successful_transactions, contracts, registry_version)
         SELECT $1::uuid, $2, $3::date, x.p, x.n, x.ok, $7, $8
           FROM unnest($4::text[], $5::bigint[], $6::bigint[]) AS x(p, n, ok)`,
        [
          tenantId,
          net,
          day,
          rows.map((r) => r.protocol),
          rows.map((r) => r.tx),
          rows.map((r) => r.ok),
          tenants.get(tenantId) as number,
          version,
        ],
      );
    });
  }
}

async function prune(db: ScfDb, net: string, now: Date): Promise<number> {
  const cutoff = utcDay(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETAIN_MONTHS, now.getUTCDate())),
  );
  const { global, tenants } = await db.tx(JOB, null, async (tx) => ({
    global: await tx.exec("DELETE FROM scf.protocol_usage_days WHERE network = $1 AND day < $2", [
      net,
      cutoff,
    ]),
    tenants: await tx.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text FROM scf.protocol_usage_tenant_daily WHERE network = $1 AND day < $2`,
      [net, cutoff],
    ),
  }));
  let n = global;
  for (const t of tenants) {
    n += await db.tx(JOB, t.tenant_id, (tx) =>
      tx.exec(
        "DELETE FROM scf.protocol_usage_tenant_daily WHERE tenant_id = $1 AND network = $2 AND day < $3",
        [t.tenant_id, net, cutoff],
      ),
    );
  }
  return n;
}
