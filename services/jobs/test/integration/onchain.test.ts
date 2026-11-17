// SPDX-License-Identifier: Apache-2.0
// Acceptance (repo.application-code, ADR-0028, C-42, C-128): job onchain_correlation runs the real `services/onchain-reader` binary
// (built from source here) over a fixture ledger lake (written by the reader's own `internal/fixture/lakegen`, keys
// derived from labels, no real account) and stores daily per-contract counts in scf.onchain_daily as scf_jobs through
// PgBouncer under each tenant's context — only for opted-in tenants' verified contracts on the deployment's network
// without an open footprint conflict (C-137), only complete days, idempotently; a complete ledger_files day replaces a
// `hubble` row (C-136, D3: ledger files primary); a partial day is stored once the next day's boundary ledger
// arrives; a window whose oldest day stays missing fails the run; a reader failure writes nothing. The fetch step
// (wire-formats §p.1) runs `onchain-reader fetch` first with exactly the §p.1 arguments for the days the count needs;
// exit 1 lets the count store what is complete and fails the run, exit 2 stops before the count.
// The rows are what the control plane's getOnchainDaily reads (same join).

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb } from "../../src/db.ts";
import { runOnchainCorrelation } from "../../src/jobs/onchain-correlation.ts";
import { HorizonLedgerHashes } from "../../src/onchain/ledger-hashes.ts";
import { LedgerFileFetcher, LedgerFileReader, ReaderError } from "../../src/onchain/reader.ts";
import { capture, jobsDb, seedSite, superClient } from "../support/harness.ts";

const READER_SRC = resolve(import.meta.dirname, "../../../onchain-reader");

let su: pg.Pool;
let db: ScfDb;
let work: string;
let bin: string;
let lake: string;
let C: Record<string, string>;
/** The network's ledger hashes (what a Horizon serves at /ledgers/{seq}); lakegen reports them for what it writes. */
const NETWORK = new Map<number, string>();
let horizon: Server;
let horizonUrl: string;
let horizonDown = false;

interface LedgerSpec {
  seq: number;
  closed_at: string;
  v2?: boolean;
  txs: {
    source: string;
    muxed?: number;
    contract?: string;
    success: boolean;
    fee_bump?: boolean;
  }[];
}

/** Writes ledgers into a lake; `network: true` also records their hashes as the network's (the genuine chain). */
function lakegen(dir: string, ledgers: LedgerSpec[], network = true): Record<string, string> {
  const out = execFileSync("go", ["run", "./internal/fixture/lakegen", dir], {
    cwd: READER_SRC,
    input: JSON.stringify({ ledgers }),
    env: { ...process.env, GOWORK: "off", GOFLAGS: "-mod=readonly" },
  });
  const r = JSON.parse(out.toString()) as {
    contracts: Record<string, string>;
    ledgers: Record<string, string>;
  };
  if (network) for (const [seq, h] of Object.entries(r.ledgers)) NETWORK.set(Number(seq), h);
  return r.contracts;
}

// Days 2026-11-11 and -12 are complete (bounded by ledgers 1000 and 1005); 2026-11-13 has no ledger after it yet.
const LEDGERS: LedgerSpec[] = [
  { seq: 1000, closed_at: "2026-11-10T23:59:55Z", txs: [] },
  {
    seq: 1001,
    closed_at: "2026-11-11T00:00:00Z",
    v2: true,
    txs: [
      { source: "alice", contract: "c1", success: true },
      { source: "bob", muxed: 7, contract: "c1", success: false, fee_bump: true },
      { source: "carol", contract: "c2", success: true },
      { source: "dave", contract: "c-unverified", success: true },
      { source: "carol", success: true }, // payment
    ],
  },
  {
    seq: 1002,
    closed_at: "2026-11-11T12:00:00Z",
    txs: [{ source: "alice", contract: "c1", success: true }],
  },
  {
    seq: 1003,
    closed_at: "2026-11-12T00:00:00Z",
    txs: [{ source: "bob", contract: "c1", success: true }],
  },
  { seq: 1004, closed_at: "2026-11-12T23:59:59Z", txs: [] },
  {
    seq: 1005,
    closed_at: "2026-11-13T00:00:00Z",
    v2: true,
    txs: [
      { source: "alice", contract: "c1", success: true },
      { source: "erin", contract: "c2", success: false },
    ],
  },
];

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  work = mkdtempSync(join(tmpdir(), "scf-onchain-it-"));
  bin = join(work, "onchain-reader");
  execFileSync("go", ["build", "-trimpath", "-o", bin, "./cmd/onchain-reader"], {
    cwd: READER_SRC,
    env: { ...process.env, CGO_ENABLED: "0", GOWORK: "off", GOFLAGS: "-mod=readonly" },
    stdio: "inherit",
  });
  lake = join(work, "ledgers");
  mkdirSync(lake);
  C = lakegen(lake, LEDGERS);
  // A stand-in Horizon: GET /ledgers/{seq} → {sequence, hash} of the genuine chain; 404 for a ledger it does not know.
  horizon = createServer((req, res) => {
    const seq = Number(/^\/ledgers\/(\d+)$/.exec(req.url ?? "")?.[1]);
    const hash = NETWORK.get(seq);
    res.writeHead(horizonDown ? 503 : hash ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(hash && !horizonDown ? { sequence: seq, hash } : { status: 404 }));
  });
  await new Promise<void>((r) => horizon.listen(0, "127.0.0.1", r));
  horizonUrl = `http://127.0.0.1:${(horizon.address() as AddressInfo).port}`;
  // Tenants of earlier runs (or of earlier suites on the same stack) would be targets too: start clean. Purged
  // tenants are immutable (scf.tenants_guard raises "tenant purged") and never targets (their status is removed).
  await su.query("DELETE FROM scf.onchain_daily");
  await su.query(
    "UPDATE scf.tenants SET onchain_correlation_enabled = false WHERE onchain_correlation_enabled AND purged_at IS NULL",
  );
}, 300_000);

afterAll(async () => {
  await new Promise<void>((r) => (horizon ? horizon.close(() => r()) : r()));
  await su?.end();
  await db?.pool.end();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function evidence(tenantId: string): Promise<string> {
  const g = `G${randomBytes(34)
    .toString("hex")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "A")
    .slice(0, 55)}`;
  const r = await su.query<{ evidence_id: string }>(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, status) VALUES ($1, 'stellar_account', $2, 'valid')
     RETURNING evidence_id`,
    [tenantId, g],
  );
  return r.rows[0]?.evidence_id as string;
}

async function declare(
  t: { tenantId: string; userId: string },
  contract: string,
  o: { verified: boolean; network?: string; ev?: string },
): Promise<string> {
  const ev = o.verified ? (o.ev ?? (await evidence(t.tenantId))) : null;
  const r = await su.query<{ contract_ref: string }>(
    `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, created_by, status, verified_role,
                                         verified_by_evidence, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 = 'verified' THEN now() END) RETURNING contract_ref`,
    [
      t.tenantId,
      contract,
      o.network ?? "testnet",
      t.userId,
      o.verified ? "verified" : "declared",
      o.verified ? "deployer" : null,
      ev,
    ],
  );
  return r.rows[0]?.contract_ref as string;
}

async function optIn(tenantId: string, on = true): Promise<void> {
  await su.query("UPDATE scf.tenants SET onchain_correlation_enabled = $2 WHERE tenant_id = $1", [
    tenantId,
    on,
  ]);
}

/** The control plane's getOnchainDaily query (services/control-plane/src/trust/handlers.ts), run for one tenant. */
async function daily(tenantId: string) {
  const r = await su.query<{
    contract_id: string;
    network: string;
    day: string;
    invocations: string;
    successful_invocations: string;
    distinct_invokers: string;
    data_source: string;
  }>(
    `SELECT c.contract_id, c.network, o.day::text AS day, o.invocations::text, o.successful_invocations::text,
            o.distinct_invokers::text, o.data_source
       FROM scf.onchain_daily o
       JOIN scf.declared_contracts c ON c.tenant_id = o.tenant_id AND c.contract_ref = o.contract_ref
      WHERE o.tenant_id = $1 ORDER BY o.day, c.network, c.contract_id`,
    [tenantId],
  );
  return r.rows.map(
    (x) =>
      `${x.contract_id === C.c1 ? "c1" : x.contract_id === C.c2 ? "c2" : "c?"}/${x.network}/${x.day}=${x.invocations},${x.successful_invocations},${x.distinct_invokers}/${x.data_source}`,
  );
}

const hashes = () => new HorizonLedgerHashes({ horizonUrl });
const opts = {
  network: "testnet" as const,
  lookbackDays: 3,
  get ledgerHashes() {
    return hashes();
  },
};
const at = (iso: string) => new Date(iso);

describe("onchain_correlation", () => {
  it("stores complete days for opted-in tenants' verified contracts, idempotently, and catches up a partial day", async () => {
    const A = await seedSite(su);
    const B = await seedSite(su);
    const Cx = await seedSite(su); // not opted in
    await optIn(A.tenantId);
    await optIn(B.tenantId);
    const evA = await evidence(A.tenantId);
    await declare(A, C.c1 as string, { verified: true, ev: evA });
    await declare(A, C.c2 as string, { verified: true, ev: evA });
    await declare(A, C["c-unverified"] as string, { verified: false }); // declared only: not counted
    await declare(A, C.c1 as string, { verified: true, ev: evA, network: "public" }); // other network
    const b1 = await declare(B, C.c1 as string, { verified: true });
    await declare(Cx, C.c1 as string, { verified: true });
    // B has a Hubble figure for 2026-11-12: the complete ledger_files day replaces it (C-136, D3).
    await su.query(
      `INSERT INTO scf.onchain_daily (tenant_id, contract_ref, day, invocations, successful_invocations,
                                      distinct_invokers, data_source)
       VALUES ($1, $2, '2026-11-12', 99, 98, 97, 'hubble')`,
      [B.tenantId, b1],
    );

    const reader = new LedgerFileReader({ bin, ledgerDir: lake, timeoutMs: 120_000 });
    const cap = capture();
    const r1 = await runOnchainCorrelation(
      db,
      reader,
      opts,
      cap.ctx({ now: at("2026-11-14T06:00:00Z") }),
    );
    expect(r1).toMatchObject({
      daysRead: ["2026-11-11", "2026-11-12", "2026-11-13"],
      incompleteDays: ["2026-11-13"],
      unavailableDays: [],
      upserted: 6, // A: c1, c2 × 11, 12; B: c1 × 11, 12 (the hubble row replaced)
    });
    expect(await daily(A.tenantId)).toEqual([
      "c1/testnet/2026-11-11=3,2,2/ledger_files",
      "c2/testnet/2026-11-11=1,1,1/ledger_files",
      "c1/testnet/2026-11-12=1,1,1/ledger_files",
      "c2/testnet/2026-11-12=0,0,0/ledger_files",
    ]);
    expect(await daily(B.tenantId)).toEqual([
      "c1/testnet/2026-11-11=3,2,2/ledger_files",
      "c1/testnet/2026-11-12=1,1,1/ledger_files",
    ]);
    expect(await daily(Cx.tenantId)).toEqual([]);

    // Second run, same day: only the partial day is read again; nothing changes.
    const r2 = await runOnchainCorrelation(
      db,
      reader,
      opts,
      cap.ctx({ now: at("2026-11-14T07:00:00Z") }),
    );
    expect(r2).toMatchObject({ daysRead: ["2026-11-13"], upserted: 0 });

    // The mirror catches up: the first ledger of 2026-11-14 completes 2026-11-13.
    lakegen(lake, [{ seq: 1006, closed_at: "2026-11-14T00:00:01Z", txs: [] }]);
    const r3 = await runOnchainCorrelation(
      db,
      reader,
      opts,
      cap.ctx({ now: at("2026-11-14T08:00:00Z") }),
    );
    expect(r3).toMatchObject({ daysRead: ["2026-11-13"], incompleteDays: [], upserted: 3 });
    expect((await daily(A.tenantId)).filter((x) => x.includes("2026-11-13"))).toEqual([
      "c1/testnet/2026-11-13=1,1,1/ledger_files",
      "c2/testnet/2026-11-13=1,0,1/ledger_files",
    ]);

    // Logs carry counts and days only: no account, no contract id.
    const logs = cap.lines.join("\n");
    expect(logs).not.toMatch(/[GMC][A-Z2-7]{55}/);
    expect(logs).toContain('"event":"onchain_correlation_done"');

    // Window moved past the mirror: its oldest day can no longer be stored → the run fails.
    const err = await runOnchainCorrelation(
      db,
      reader,
      opts,
      cap.ctx({ now: at("2026-11-18T06:00:00Z") }),
    ).catch((e) => e);
    expect(err.name).toBe("OnchainDayIncomplete");
  });

  it("writes nothing when the reader fails, and does not run the reader without targets", async () => {
    const T = await seedSite(su);
    await optIn(T.tenantId);
    await declare(T, C.c2 as string, { verified: true });
    const empty = join(work, "empty");
    mkdirSync(empty);
    const broken = new LedgerFileReader({ bin, ledgerDir: empty, timeoutMs: 60_000 });
    const err = await runOnchainCorrelation(
      db,
      broken,
      opts,
      capture().ctx({ now: at("2026-11-14T06:00:00Z") }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ReaderError);
    expect(err.exitCode).toBe(1);
    expect(await daily(T.tenantId)).toEqual([]);

    // Opted out: nothing to read, the reader is not started (a missing binary would otherwise fail the run).
    await su.query(
      "UPDATE scf.tenants SET onchain_correlation_enabled = false WHERE onchain_correlation_enabled AND purged_at IS NULL",
    );
    const none = new LedgerFileReader({ bin: "/nonexistent", ledgerDir: lake, timeoutMs: 1000 });
    const r = await runOnchainCorrelation(
      db,
      none,
      opts,
      capture().ctx({ now: at("2026-11-14T06:00:00Z") }),
    );
    expect(r).toMatchObject({ targets: 0, daysRead: [], upserted: 0 });
  });
});

describe("onchain_correlation fetch step and conflicts", () => {
  function fakeFetcher(exit: number) {
    const dir = mkdtempSync(join(work, "fetch-"));
    const bin = join(dir, "onchain-reader");
    const argsFile = join(dir, "args");
    // A stand-in for `onchain-reader fetch` (built by WS A1): records its arguments, prints a counts-only summary.
    writeFileSync(
      bin,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${argsFile}\necho 'onchain-reader fetch: files=3 bytes=1024' >&2\nexit ${exit}\n`,
    );
    chmodSync(bin, 0o755);
    return {
      fetcher: new LedgerFileFetcher({
        bin,
        sourceUrl: "https://ledgers.example.org/v1.1/stellar/ledgers/testnet/2025-12-18",
        ledgerDir: lake,
        timeoutMs: 30_000,
      }),
      args: () => readFileSync(argsFile, "utf8").trim().split("\n"),
    };
  }

  it("fetches the needed days first (§p.1 arguments) and never counts a contract in conflict", async () => {
    await su.query("DELETE FROM scf.onchain_daily");
    const T = await seedSite(su);
    const U = await seedSite(su);
    await optIn(T.tenantId);
    await optIn(U.tenantId);
    await declare(T, C.c1 as string, { verified: true });
    const u1 = await declare(U, C.c2 as string, { verified: true });
    // U's contract is verified for another tenant too (contract_verification flagged it): counted nowhere.
    await su.query(
      "UPDATE scf.declared_contracts SET conflict_since = now() WHERE contract_ref = $1",
      [u1],
    );
    const f = fakeFetcher(0);
    const reader = new LedgerFileReader({ bin, ledgerDir: lake, timeoutMs: 120_000 });
    const r = await runOnchainCorrelation(
      db,
      reader,
      { ...opts, fetcher: f.fetcher },
      capture().ctx({ now: at("2026-11-14T06:00:00Z") }),
    );
    expect(f.args()).toEqual([
      "fetch",
      "-source",
      "https://ledgers.example.org/v1.1/stellar/ledgers/testnet/2025-12-18",
      "-dest",
      lake,
      "-from-day",
      "2026-11-11",
      "-to-day",
      "2026-11-13",
      "-network",
      "Test SDF Network ; September 2015",
    ]);
    expect(r).toMatchObject({
      targets: 1,
      fetch: { complete: true, fromDay: "2026-11-11", toDay: "2026-11-13" },
    });
    expect(await daily(T.tenantId)).toEqual([
      "c1/testnet/2026-11-11=3,2,2/ledger_files",
      "c1/testnet/2026-11-12=1,1,1/ledger_files",
      "c1/testnet/2026-11-13=1,1,1/ledger_files",
    ]);
    expect(await daily(U.tenantId)).toEqual([]);
  });

  it("stores the complete days and fails the run when the fetch is incomplete; stops on a usage error", async () => {
    const V = await seedSite(su);
    await optIn(V.tenantId);
    await declare(V, C.c2 as string, { verified: true });
    const reader = new LedgerFileReader({ bin, ledgerDir: lake, timeoutMs: 120_000 });
    // Window 2026-11-12…14: the 14th has only its first ledger in the mirror (incomplete).
    const err = await runOnchainCorrelation(
      db,
      reader,
      { ...opts, fetcher: fakeFetcher(1).fetcher },
      capture().ctx({ now: at("2026-11-15T06:00:00Z") }),
    ).catch((e) => e);
    expect(err.name).toBe("OnchainFetchIncomplete");
    expect(await daily(V.tenantId)).toEqual([
      "c2/testnet/2026-11-12=0,0,0/ledger_files",
      "c2/testnet/2026-11-13=1,0,1/ledger_files",
    ]);

    const W = await seedSite(su);
    await optIn(W.tenantId);
    await declare(W, C.c1 as string, { verified: true });
    const usage = await runOnchainCorrelation(
      db,
      new LedgerFileReader({ bin: "/nonexistent", ledgerDir: lake, timeoutMs: 1000 }),
      { ...opts, fetcher: fakeFetcher(2).fetcher },
      capture().ctx({ now: at("2026-11-15T06:00:00Z") }),
    ).catch((e) => e);
    expect(usage).toBeInstanceOf(ReaderError);
    expect(usage.exitCode).toBe(2);
    expect(await daily(W.tenantId)).toEqual([]);
  });
});

describe("onchain_correlation day anchors against Horizon (C-144)", () => {
  // The same ledgers 1000…1005, except that 1004 (the last ledger of 2026-11-12) carries a forged invocation. lakegen
  // seals the chain again, so every hash and link is consistent: the reader's integrity checks pass, and only the
  // comparison of the day anchor (ledger 1005 for 2026-11-12) with the network's copy catches it. 2026-11-11's anchor
  // (ledger 1003) is genuine, so that day is used.
  const FORGED: LedgerSpec[] = LEDGERS.map((l) =>
    l.seq === 1004 ? { ...l, txs: [{ source: "mallory", contract: "c1", success: true }] } : l,
  );

  it("refuses a day whose anchor differs from Horizon's, alerts and fails the run; stores the genuine day", async () => {
    await su.query("DELETE FROM scf.onchain_daily");
    await su.query(
      "UPDATE scf.tenants SET onchain_correlation_enabled = false WHERE onchain_correlation_enabled AND purged_at IS NULL",
    );
    const forged = join(work, "forged");
    mkdirSync(forged);
    lakegen(forged, FORGED, false);
    const T = await seedSite(su);
    await optIn(T.tenantId);
    await declare(T, C.c1 as string, { verified: true });
    const cap = capture();
    const err = await runOnchainCorrelation(
      db,
      new LedgerFileReader({ bin, ledgerDir: forged, timeoutMs: 120_000 }),
      opts,
      cap.ctx({ now: at("2026-11-14T06:00:00Z") }),
    ).catch((e) => e);
    expect(err.name).toBe("OnchainAnchorMismatch");
    // 2026-11-11 is genuine (its anchor matches); 2026-11-12 is refused; 2026-11-13 is incomplete in this lake.
    expect(await daily(T.tenantId)).toEqual(["c1/testnet/2026-11-11=3,2,2/ledger_files"]);
    const logs = cap.lines.join("\n");
    expect(logs).toContain('"event":"onchain_anchor_mismatch"');
    expect(logs).toContain('"day":"2026-11-12"');
    expect(logs).not.toMatch(/[GMC][A-Z2-7]{55}/);
    const metrics = cap.registry.render();
    expect(metrics).toContain('scf_onchain_anchor_mismatch_days{network="testnet"} 1');
    expect(metrics).toContain(
      'scf_job_units_total{job="onchain_correlation",outcome="day_anchor_mismatch"} 1',
    );

    // The genuine lake for the same window: every complete day's anchor matches, the gauge returns to 0.
    const ok = capture();
    const r = await runOnchainCorrelation(
      db,
      new LedgerFileReader({ bin, ledgerDir: lake, timeoutMs: 120_000 }),
      opts,
      ok.ctx({ now: at("2026-11-14T06:00:00Z") }),
    );
    expect(r).toMatchObject({ anchorMismatchDays: [], anchorUnverifiedDays: [] });
    expect(await daily(T.tenantId)).toEqual([
      "c1/testnet/2026-11-11=3,2,2/ledger_files",
      "c1/testnet/2026-11-12=1,1,1/ledger_files",
      "c1/testnet/2026-11-13=1,1,1/ledger_files",
    ]);
    expect(ok.registry.render()).toContain('scf_onchain_anchor_mismatch_days{network="testnet"} 0');
  });

  it("does not use a day Horizon cannot confirm (down, or ledger unknown) and retries it next run", async () => {
    await su.query("DELETE FROM scf.onchain_daily");
    await su.query(
      "UPDATE scf.tenants SET onchain_correlation_enabled = false WHERE onchain_correlation_enabled AND purged_at IS NULL",
    );
    const T = await seedSite(su);
    await optIn(T.tenantId);
    await declare(T, C.c2 as string, { verified: true });
    const reader = new LedgerFileReader({ bin, ledgerDir: lake, timeoutMs: 120_000 });
    horizonDown = true;
    const cap = capture();
    const err = await runOnchainCorrelation(
      db,
      reader,
      opts,
      cap.ctx({ now: at("2026-11-13T06:00:00Z") }), // window 2026-11-10…12: 10 has no ledgers here
    )
      .catch((e) => e)
      .finally(() => {
        horizonDown = false;
      });
    // The oldest day of the window (11-10) is never complete in this lake → OnchainDayIncomplete wins; nothing stored.
    expect(["OnchainAnchorUnverified", "OnchainDayIncomplete"]).toContain(err.name);
    expect(await daily(T.tenantId)).toEqual([]);
    expect(cap.lines.join("\n")).toContain('"event":"onchain_anchor_unverified"');
    expect(cap.registry.render()).toContain(
      'scf_onchain_anchor_unverified_days{network="testnet"} 2',
    );

    // Horizon back: the same days are read again and stored.
    const r = await runOnchainCorrelation(
      db,
      reader,
      opts,
      capture().ctx({ now: at("2026-11-14T06:00:00Z") }),
    );
    expect(r.anchorUnverifiedDays).toEqual([]);
    expect(await daily(T.tenantId)).toEqual([
      "c2/testnet/2026-11-11=1,1,1/ledger_files",
      "c2/testnet/2026-11-12=0,0,0/ledger_files",
      "c2/testnet/2026-11-13=1,0,1/ledger_files",
    ]);
  });

  it("skips the check only when configured off (testnet development lake) and says so", async () => {
    await su.query("DELETE FROM scf.onchain_daily");
    await su.query(
      "UPDATE scf.tenants SET onchain_correlation_enabled = false WHERE onchain_correlation_enabled AND purged_at IS NULL",
    );
    const T = await seedSite(su);
    await optIn(T.tenantId);
    await declare(T, C.c1 as string, { verified: true });
    const cap = capture();
    await runOnchainCorrelation(
      db,
      new LedgerFileReader({ bin, ledgerDir: lake, timeoutMs: 120_000 }),
      { network: "testnet", lookbackDays: 3, ledgerHashes: null },
      cap.ctx({ now: at("2026-11-14T06:00:00Z") }),
    );
    expect(cap.lines.join("\n")).toContain('"event":"onchain_anchor_check_off"');
    expect(await daily(T.tenantId)).toHaveLength(3);
  });
});
