// SPDX-License-Identifier: Apache-2.0
// Acceptance (Ecosystem Usage Map, migration 0075): job usage_map runs the real `onchain-reader usage` (built from
// source) over a synthetic ledger lake written by the reader's own lakegen (keys derived from labels, no real account)
// and stores, as scf_jobs through PgBouncer, per registry project that lists contracts — tenant or not — the daily
// figures, per contract and per function and caller kind, and the Growth Hack weekly active accounts of a whole ISO
// week; idempotently (a second run reads nothing); a project added to the registry is filled in; registry rows that
// are missing or list only invalid contract ids are skipped; a day whose anchor Horizon disputes is refused and fails
// the run; nothing stored names an account.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb } from "../../src/db.ts";
import { runUsageMap, type UsageMapOptions } from "../../src/jobs/usage-map.ts";
import { HorizonLedgerHashes } from "../../src/onchain/ledger-hashes.ts";
import { LedgerUsageReader, type UsageSource } from "../../src/onchain/usage.ts";
import { capture, jobsDb, superClient } from "../support/harness.ts";

const READER_SRC = resolve(import.meta.dirname, "../../../onchain-reader");
const P_DEX = "019a7000-0000-7000-8000-0000000000d1";
const P_TOK = "019a7000-0000-7000-8000-0000000000d2";
const P_BAD = "019a7000-0000-7000-8000-0000000000d3"; // lists an invalid id only
const P_GONE = "019a7000-0000-7000-8000-0000000000d4"; // missing from the source
const P_NEW = "019a7000-0000-7000-8000-0000000000d5"; // added to the registry later
const MINE = [P_DEX, P_TOK, P_BAD, P_GONE, P_NEW];

let su: pg.Pool;
let db: ScfDb;
let work: string;
let bin: string;
let lake: string;
let C: Record<string, string>;
const NETWORK = new Map<number, string>();
let horizon: Server;
let horizonUrl: string;
const forged = new Set<number>();

// Week Monday 2026-11-09 … Sunday 2026-11-15, bounded by ledgers 3000 (Sunday 2026-11-08) and 3008 (Monday 2026-11-16).
const noon = (d: number) => `2026-11-${String(d).padStart(2, "0")}T12:00:00Z`;
const LEDGERS = [
  { seq: 3000, closed_at: "2026-11-08T23:59:55Z", txs: [] },
  {
    seq: 3001,
    closed_at: noon(9),
    v2: true,
    txs: [
      {
        source: "alice",
        contract: "u-dex",
        function: "swap",
        success: true,
        auth: [
          {
            contract: "u-dex",
            function: "swap",
            sub: [{ contract: "u-token", function: "transfer", args: [1] }],
          },
        ],
      },
      { source: "bob", contract: "u-dex", function: "swap", success: false },
      { source: "carol", success: true }, // payment
    ],
  },
  { seq: 3002, closed_at: noon(10), txs: [] },
  {
    seq: 3003,
    closed_at: noon(11),
    txs: [
      {
        source: "alice",
        contract: "u-router",
        function: "route",
        success: true,
        auth: [{ contract: "u-token", function: "transfer", args: [2] }],
      },
      { source: "carol", contract: "u-token", function: "mint", success: true },
    ],
  },
  { seq: 3004, closed_at: noon(12), txs: [] },
  { seq: 3005, closed_at: noon(13), txs: [] },
  {
    seq: 3006,
    closed_at: noon(14),
    txs: [{ source: "erin", contract: "u-new", function: "f", success: true }],
  },
  {
    seq: 3007,
    closed_at: noon(15),
    txs: [
      { source: "dave", contract: "u-dex", function: "deposit", success: true, fee_bump: true },
    ],
  },
  { seq: 3008, closed_at: "2026-11-16T00:00:00Z", txs: [] },
];

const NOW = new Date("2026-11-16T07:30:00Z");

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  work = mkdtempSync(join(tmpdir(), "scf-usage-it-"));
  bin = join(work, "onchain-reader");
  execFileSync("go", ["build", "-trimpath", "-o", bin, "./cmd/onchain-reader"], {
    cwd: READER_SRC,
    env: { ...process.env, CGO_ENABLED: "0", GOWORK: "off", GOFLAGS: "-mod=readonly" },
    stdio: "inherit",
  });
  lake = join(work, "ledgers");
  mkdirSync(lake);
  const out = execFileSync("go", ["run", "./internal/fixture/lakegen", lake], {
    cwd: READER_SRC,
    input: JSON.stringify({ ledgers: LEDGERS }),
    env: { ...process.env, GOWORK: "off", GOFLAGS: "-mod=readonly" },
  });
  const r = JSON.parse(out.toString()) as {
    contracts: Record<string, string>;
    ledgers: Record<string, string>;
  };
  C = r.contracts;
  for (const [seq, h] of Object.entries(r.ledgers)) NETWORK.set(Number(seq), h);
  horizon = createServer((req, res) => {
    const seq = Number(/^\/ledgers\/(\d+)$/.exec(req.url ?? "")?.[1]);
    const hash = NETWORK.get(seq);
    res.writeHead(hash ? 200 : 404, { "content-type": "application/json" });
    res.end(
      JSON.stringify(hash ? { sequence: seq, hash: forged.has(seq) ? "ff".repeat(32) : hash } : {}),
    );
  });
  await new Promise<void>((ok) => horizon.listen(0, "127.0.0.1", ok));
  horizonUrl = `http://127.0.0.1:${(horizon.address() as AddressInfo).port}`;

  await su.query("DELETE FROM scf.usage_map_days");
  await su.query("DELETE FROM scf.usage_map_project_weekly");
  await su.query("DELETE FROM scf.registry_projects WHERE registry_project_id = ANY($1::uuid[])", [
    MINE,
  ]);
  const reg = (id: string, contracts: string[], missing = false) =>
    su.query(
      `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, contract_ids,
                                          fetched_at, content_sha256, raw, missing_since)
       VALUES ($1::uuid, 'stellarlight', $4, 'usage ' || $4, true, $2::text[], now(), sha256(convert_to($4, 'UTF8')), '{}',
               CASE WHEN $3::boolean THEN now() END)`,
      [id, contracts, missing, id],
    );
  await reg(P_DEX, [C["u-dex"] as string, C["u-router"] as string]);
  await reg(P_TOK, [C["u-token"] as string]);
  await reg(P_BAD, [`C${"A".repeat(55)}`]);
  await reg(P_GONE, [C["u-dex"] as string], true);
}, 300_000);

afterAll(async () => {
  await new Promise<void>((ok) => (horizon ? horizon.close(() => ok()) : ok()));
  if (su) {
    await su.query("DELETE FROM scf.usage_map_days");
    await su.query("DELETE FROM scf.usage_map_project_weekly");
    await su.query(
      "DELETE FROM scf.registry_projects WHERE registry_project_id = ANY($1::uuid[])",
      [MINE],
    );
    await su.end();
  }
  await db?.pool.end();
  if (work) rmSync(work, { recursive: true, force: true });
});

function counting(src: UsageSource): UsageSource & { calls: number } {
  const s = {
    calls: 0,
    read: (req: Parameters<UsageSource["read"]>[0], sig: AbortSignal) => {
      s.calls++;
      return src.read(req, sig);
    },
  };
  return s;
}

const opts = (): UsageMapOptions => ({
  network: "testnet",
  lookbackDays: 7,
  ledgerHashes: new HorizonLedgerHashes({ horizonUrl }),
});

async function q<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
  return (await su.query(sql, args)).rows as T[];
}

describe("job usage_map", () => {
  it("stores daily, contract, function and weekly figures for every registry project with contracts", async () => {
    const cap = capture();
    const src = counting(new LedgerUsageReader({ bin, ledgerDir: lake, timeoutMs: 120_000 }));
    const r = await runUsageMap(db, src, opts(), cap.ctx({ now: NOW }));
    expect(r.projects).toBeGreaterThanOrEqual(2); // other suites' registry rows may list contracts too
    expect(r.invalidContracts).toBeGreaterThanOrEqual(1);
    expect(r).toMatchObject({
      fromDay: "2026-11-09",
      toDay: "2026-11-15",
      weeksStored: ["2026-11-09"],
      incompleteDays: [],
      anchorMismatchDays: [],
    });
    expect(r.daysStored).toHaveLength(7);

    const days = await q<{ day: string; anchor_ledger: number; anchor_checked: boolean }>(
      "SELECT day::text, anchor_ledger::int, anchor_checked FROM scf.usage_map_days WHERE network = 'testnet' ORDER BY day",
    );
    expect(days.map((d) => d.day)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(days[0]).toMatchObject({ anchor_ledger: 3002, anchor_checked: true });

    const pd = await q<{ p: string; day: string; v: string }>(
      `SELECT registry_project_id::text AS p, day::text,
              concat_ws(',', invocations, successful_invocations, distinct_invokers, contract_calls, contracts_listed,
                        contracts_invoked) AS v
         FROM scf.usage_map_project_daily WHERE registry_project_id = ANY($1::uuid[]) AND invocations + contract_calls > 0
        ORDER BY 2, 1`,
      [MINE],
    );
    expect(pd.map((x) => `${x.p === P_DEX ? "dex" : "tok"} ${x.day} ${x.v}`)).toEqual([
      "dex 2026-11-09 2,1,2,0,2,1", // alice ok, bob failed
      "tok 2026-11-09 0,0,0,1,1,1", // the swap's authorised transfer: a contract call
      "dex 2026-11-11 1,1,1,0,2,1", // alice via the router
      "tok 2026-11-11 1,1,1,1,1,1", // carol's mint + the router's transfer
      "dex 2026-11-15 1,1,1,0,2,1", // dave, fee-bumped
    ]);
    // Every listed project has a row for every day (zeros included); skipped rows have none.
    const counts = await q<{ p: string; n: number }>(
      `SELECT registry_project_id::text AS p, count(*)::int AS n FROM scf.usage_map_project_daily
        WHERE registry_project_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`,
      [MINE],
    );
    expect(counts).toEqual([
      { p: P_DEX, n: 7 },
      { p: P_TOK, n: 7 },
    ]);

    const fns = await q<{ v: string }>(
      `SELECT concat_ws(' ', day, CASE contract_id WHEN $1 THEN 'dex' WHEN $2 THEN 'router' WHEN $3 THEN 'token' END,
                        function_name, caller_kind, calls, successful_calls) AS v
         FROM scf.usage_map_function_daily ORDER BY day, contract_id, function_name, caller_kind`,
      [C["u-dex"], C["u-router"], C["u-token"]],
    );
    expect(fns.map((f) => f.v).sort()).toEqual(
      [
        "2026-11-09 dex swap account 2 1",
        "2026-11-09 token transfer contract 1 1",
        "2026-11-11 router route account 1 1",
        "2026-11-11 token mint account 1 1",
        "2026-11-11 token transfer contract 1 1",
        "2026-11-15 dex deposit account 1 1",
      ].sort(),
    );

    // SCF Growth Hack WAA: distinct initiating accounts over the ISO week, not a sum of daily counts.
    const wk = await q<{ p: string; v: string }>(
      `SELECT registry_project_id::text AS p, concat_ws(',', active_accounts, active_accounts_successful, invocations,
              successful_invocations, contract_calls) AS v
         FROM scf.usage_map_project_weekly WHERE registry_project_id = ANY($1::uuid[]) ORDER BY 1`,
      [MINE],
    );
    expect(wk).toEqual([
      { p: P_DEX, v: "3,2,4,3,0" }, // alice (twice), bob (failed only), dave
      { p: P_TOK, v: "1,1,1,1,2" }, // carol; two authorised transfers by contracts
    ]);
    // Nothing stored names an account (the tables have no such column; no text value is a G… key either).
    const text = await q<{ t: string }>(
      `SELECT string_agg(x::text, ' ') AS t FROM (
         SELECT row_to_json(d)::text AS x FROM scf.usage_map_project_daily d
         UNION ALL SELECT row_to_json(c)::text FROM scf.usage_map_contract_daily c
         UNION ALL SELECT row_to_json(f)::text FROM scf.usage_map_function_daily f
         UNION ALL SELECT row_to_json(w)::text FROM scf.usage_map_project_weekly w) s`,
    );
    expect(text[0]?.t ?? "").not.toMatch(/\bG[A-Z2-7]{55}\b/);
    expect(cap.lines.join("\n")).not.toMatch(/\bG[A-Z2-7]{55}\b/);
  });

  it("is idempotent: a second run reads nothing; a project added to the registry is filled in", async () => {
    const src = counting(new LedgerUsageReader({ bin, ledgerDir: lake, timeoutMs: 120_000 }));
    const again = await runUsageMap(db, src, opts(), capture().ctx({ now: NOW }));
    expect(src.calls).toBe(0);
    expect(again.daysStored).toEqual([]);

    await su.query(
      `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, contract_ids,
                                          fetched_at, content_sha256, raw)
       VALUES ($1::uuid, 'stellarlight', $3, 'usage new', true, $2::text[], now(), sha256(convert_to($3, 'UTF8')), '{}')`,
      [P_NEW, [C["u-new"]], P_NEW],
    );
    const r = await runUsageMap(db, src, opts(), capture().ctx({ now: NOW }));
    expect(src.calls).toBe(1);
    expect(r.daysStored).toHaveLength(7);
    expect(r.weeksStored).toEqual(["2026-11-09"]);
    const nw = await q<{ v: string }>(
      `SELECT concat_ws(',', active_accounts, invocations) AS v FROM scf.usage_map_project_weekly
        WHERE registry_project_id = $1`,
      [P_NEW],
    );
    expect(nw).toEqual([{ v: "1,1" }]);
    // The earlier projects' figures are unchanged by the rewrite.
    const dex = await q<{ v: string }>(
      "SELECT concat_ws(',', active_accounts, invocations) AS v FROM scf.usage_map_project_weekly WHERE registry_project_id = $1",
      [P_DEX],
    );
    expect(dex).toEqual([{ v: "3,4" }]);
  });

  it("refuses a day whose anchor Horizon disputes, keeps the rest and fails the run", async () => {
    await su.query("DELETE FROM scf.usage_map_days WHERE day = '2026-11-12'");
    forged.add(3005); // the anchor of 2026-11-12 (first ledger after the day)
    try {
      const src = new LedgerUsageReader({ bin, ledgerDir: lake, timeoutMs: 120_000 });
      const cap = capture();
      await expect(runUsageMap(db, src, opts(), cap.ctx({ now: NOW }))).rejects.toMatchObject({
        name: "UsageMapAnchorMismatch",
      });
      expect(cap.lines.join("\n")).toContain("usage_map_anchor_mismatch");
      const d = await q<{ day: string }>(
        "SELECT day::text FROM scf.usage_map_days WHERE network = 'testnet' ORDER BY day",
      );
      expect(d.map((x) => x.day)).not.toContain("2026-11-12");
      expect(d).toHaveLength(6);
      // Without a whole verified week the weekly rows are not rewritten (they stay as stored).
      const w = await q(
        "SELECT 1 FROM scf.usage_map_project_weekly WHERE registry_project_id = $1",
        [P_DEX],
      );
      expect(w).toHaveLength(1);
    } finally {
      forged.clear();
    }
  });

  it("only job usage_map reads the rows as scf_jobs", async () => {
    const r = await su.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scf.usage_map_project_daily WHERE registry_project_id = $1`,
      [P_DEX],
    );
    expect(r.rows[0]?.n).toBe(6); // 2026-11-12 was refused above
    // scf_jobs under another job name sees nothing.
    const other = await db.tx("trust_scoring", null, (tx) =>
      tx.query<{ n: number }>("SELECT count(*)::int AS n FROM scf.usage_map_project_daily"),
    );
    expect(other[0]?.n).toBe(0);
  });
});
