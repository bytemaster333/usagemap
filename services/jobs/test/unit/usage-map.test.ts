// SPDX-License-Identifier: Apache-2.0
// Job usage_map (Ecosystem Usage Map, migration 0075): configuration (follows onchain_correlation's requirements),
// week planning (ISO weeks wholly inside the window), registry contract validation, the strict parser of
// `onchain-reader usage` lines (no unknown field, so never an account) and the process wrapper against a stand-in.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";
import { validContract, weekDays, wholeWeeks } from "../../src/jobs/usage-map.ts";
import { ReaderError } from "../../src/onchain/reader.ts";
import { LedgerUsageReader, parseUsageLine, usageArgs } from "../../src/onchain/usage.ts";
import { strkeyEncode } from "../../src/stellar/xdr.ts";

const base = {
  SCF_JOBS_DATABASE_URL: "postgres://scf_jobs@pgbouncer:6432/scf",
  SCF_UMAMI_RO_URL: "postgres://scf_umami_ro@pgbouncer:6432/umami",
  SCF_UMAMI_MAINT_URL: "postgres://scf_umami_maint@pgbouncer:6432/umami",
};
const C1 = strkeyEncode(Buffer.alloc(32, 1), 2 << 3);
const C2 = strkeyEncode(Buffer.alloc(32, 2), 2 << 3);
const P1 = "019a0000-0000-7000-8000-000000000001";
const G = new Set([P1]);
const K = new Set([C1, C2]);

describe("usage_map configuration", () => {
  it("is left out with onchain_correlation when there is no mirror, and refused when named", () => {
    const c = loadConfig(base);
    expect(c.enabled).not.toContain("usage_map");
    expect(c.disabled).toContainEqual({ job: "usage_map", missing: "SCF_ONCHAIN_LEDGER_DIR" });
    expect(c.usageMap).toBeNull();
    expect(() => loadConfig({ ...base, SCF_JOBS_ENABLED: "usage_map" })).toThrow(ConfigError);
  });
  it("reads its schedule, lookback (at most the mirror's 7 days) and timeout", () => {
    const env = {
      ...base,
      SCF_ONCHAIN_LEDGER_DIR: "/data/ledgers",
      SCF_HORIZON_URL: "https://horizon.stellar.org",
    };
    expect(loadConfig(env).usageMap).toEqual({
      dailyAt: { hour: 7, minute: 30 },
      lookbackDays: 7,
      timeoutMs: 14_400_000,
    });
    expect(loadConfig(env).enabled).toContain("usage_map");
    expect(
      loadConfig({
        ...env,
        SCF_USAGE_MAP_DAILY_AT: "08:05",
        SCF_USAGE_MAP_LOOKBACK_DAYS: "3",
        SCF_USAGE_MAP_READER_TIMEOUT_S: "60",
      }).usageMap,
    ).toEqual({ dailyAt: { hour: 8, minute: 5 }, lookbackDays: 3, timeoutMs: 60_000 });
    expect(() => loadConfig({ ...env, SCF_USAGE_MAP_LOOKBACK_DAYS: "8" })).toThrow(ConfigError);
  });
});

describe("week planning", () => {
  it("takes only ISO weeks (Monday–Sunday) whose seven days are all in the window", () => {
    const window = [
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
    ];
    expect(wholeWeeks(window)).toEqual([]); // Thu…Wed: no whole week
    const monday = [
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ];
    expect(wholeWeeks(monday)).toEqual(["2026-11-09"]);
    expect(weekDays("2026-11-09")).toEqual(monday);
    expect(wholeWeeks(monday.slice(0, 6))).toEqual([]);
  });
});

describe("registry contract ids", () => {
  it("accepts a checksummed contract strkey only", () => {
    expect(validContract(C1)).toBe(true);
    expect(validContract(`C${"A".repeat(55)}`)).toBe(false); // bad checksum
    expect(validContract(strkeyEncode(Buffer.alloc(32, 1), 6 << 3))).toBe(false); // a G… account
    expect(validContract("not a key")).toBe(false);
  });
});

const day = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "day",
    day: "2026-11-16",
    ledgers_in_day: 17280,
    ledger_first: 100,
    ledger_last: 17379,
    complete: true,
    anchor_ledger: 17380,
    anchor_hash: "ab".repeat(32),
    ...o,
  });
const group = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "group",
    group: P1,
    day: "2026-11-16",
    invocations: 10,
    successful_invocations: 9,
    distinct_invokers: 4,
    contract_calls: 2,
    contracts_invoked: 2,
    ...o,
  });
const fn = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "function",
    contract: C1,
    day: "2026-11-16",
    function: "swap",
    caller_kind: "account",
    calls: 3,
    successful_calls: 3,
    ...o,
  });
const week = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "week",
    group: P1,
    week_start: "2026-11-09",
    active_accounts: 5,
    active_accounts_successful: 4,
    invocations: 30,
    successful_invocations: 28,
    contract_calls: 1,
    ...o,
  });

describe("parseUsageLine", () => {
  it("accepts every kind of the reader's output", () => {
    for (const l of [
      day(),
      group(),
      fn(),
      week(),
      fn({ function: "(other)", caller_kind: "contract" }),
    ])
      expect(() => parseUsageLine(l, G, K)).not.toThrow();
    expect(
      parseUsageLine(day({ complete: false, anchor_ledger: null, anchor_hash: null }), G, K),
    ).toMatchObject({ complete: false });
  });
  it("refuses anything else: unknown fields (an account), unknown groups or contracts, bad values", () => {
    const bad = [
      group({ invoker: `G${"A".repeat(55)}` }),
      week({ accounts: ["x"] }),
      group({ group: "019a0000-0000-7000-8000-000000000999" }),
      fn({ contract: `C${"Z".repeat(55)}` }),
      fn({ function: "drop table" }),
      fn({ caller_kind: "relayer" }),
      fn({ calls: 0, successful_calls: 0 }),
      week({ week_start: "2026-11-10" }), // not a Monday
      week({ active_accounts: 31 }), // more accounts than invocations
      group({ distinct_invokers: 11 }),
      day({ anchor_ledger: 17381 }),
      day({ complete: true, anchor_hash: null }),
      JSON.stringify({ kind: "unknown" }),
      "not json",
    ];
    for (const l of bad) expect(() => parseUsageLine(l, G, K), l).toThrow(ReaderError);
  });
});

function fakeBin(body: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "scf-usage-fake-"));
  const bin = join(dir, "reader");
  writeFileSync(
    bin,
    `#!${process.execPath}\nconst fs=require('node:fs');const dir=${JSON.stringify(dir)};\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

describe("LedgerUsageReader", () => {
  const req = {
    network: "public" as const,
    fromDay: "2026-11-09",
    toDay: "2026-11-15",
    members: [
      { group: P1, contract: C2 },
      { group: P1, contract: C1 },
    ],
  };
  it("passes the arguments and the sorted group pairs on stdin, and splits the lines by kind", async () => {
    const { bin, dir } = fakeBin(`
      let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
        fs.writeFileSync(dir+'/seen.json', JSON.stringify({args:process.argv.slice(2), input}));
        process.stdout.write(${JSON.stringify(`${day()}\n${group()}\n${fn()}\n${week()}\n`)});
        process.stderr.write('onchain-reader usage: files=7 ledgers=120960 duplicate_ledgers=0 out_of_range_ledgers=2 transactions=9 invocations=30 contract_calls=1 weeks=1\\n');
      });`);
    const r = new LedgerUsageReader({ bin, ledgerDir: "/ledgers", timeoutMs: 10_000 });
    const out = await r.read(req, new AbortController().signal);
    expect([out.days.length, out.groups.length, out.functions.length, out.weeks.length]).toEqual([
      1, 1, 1, 1,
    ]);
    expect(out.summary).toMatchObject({ ledgers: 120960, contract_calls: 1, weeks: 1 });
    const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
    expect(seen.args).toEqual(usageArgs("public", "2026-11-09", "2026-11-15", "/ledgers"));
    expect(seen.args.slice(0, 3)).toEqual(["usage", "-network", "pubnet"]);
    expect(seen.input).toBe([`${P1} ${C1}\n`, `${P1} ${C2}\n`].sort().join(""));
  });
  it("fails on a non-zero exit and on a line naming an account", async () => {
    const exit = fakeBin("process.stdin.resume();process.stdin.on('end',()=>process.exit(1));");
    await expect(
      new LedgerUsageReader({ bin: exit.bin, ledgerDir: "/l", timeoutMs: 10_000 }).read(
        req,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "exit_nonzero", exitCode: 1 });
    const leak = fakeBin(
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(`${group({ who: "GABC" })}\n`)}));`,
    );
    await expect(
      new LedgerUsageReader({ bin: leak.bin, ledgerDir: "/l", timeoutMs: 10_000 }).read(
        req,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "invalid_output" });
  });
});
