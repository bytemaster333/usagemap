// SPDX-License-Identifier: Apache-2.0
// Job onchain_correlation (repo.application-code, C-42, C-128): configuration (disabled cleanly without a ledger-file directory),
// day planning, the strict parser of the reader's JSON lines, and the reader process wrapper (arguments, contracts on
// stdin, exit codes, timeout, output bound) against a stand-in executable.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";
import { planDays } from "../../src/jobs/onchain-correlation.ts";
import {
  LedgerFileReader,
  parseReaderLine,
  parseSummary,
  ReaderError,
  readerArgs,
} from "../../src/onchain/reader.ts";

const base = {
  SCF_JOBS_DATABASE_URL: "postgres://scf_jobs@pgbouncer:6432/scf",
  SCF_UMAMI_RO_URL: "postgres://scf_umami_ro@pgbouncer:6432/umami",
  SCF_UMAMI_MAINT_URL: "postgres://scf_umami_maint@pgbouncer:6432/umami",
};
const C1 = `C${"A".repeat(55)}`;
const C2 = `C${"B".repeat(55)}`;

describe("onchain_correlation configuration", () => {
  it("is left out of the default set, named, when SCF_ONCHAIN_LEDGER_DIR is unset", () => {
    const c = loadConfig({ ...base, SCF_JOBS_ENABLED: "" });
    expect(c.enabled).not.toContain("onchain_correlation");
    expect(c.disabled).toContainEqual({
      job: "onchain_correlation",
      missing: "SCF_ONCHAIN_LEDGER_DIR",
    });
  });
  it("refuses to be named explicitly without the directory", () => {
    expect(() => loadConfig({ ...base, SCF_JOBS_ENABLED: "onchain_correlation" })).toThrow(
      ConfigError,
    );
  });
  it("reads its settings, with defaults", () => {
    const c = loadConfig({
      ...base,
      SCF_ONCHAIN_LEDGER_DIR: "/data/ledgers",
      SCF_HORIZON_URL: "https://horizon.stellar.org/",
    });
    expect(c.enabled).toContain("onchain_correlation");
    expect(c.onchain).toEqual({
      ledgerDir: "/data/ledgers",
      readerBin: "/usr/local/bin/onchain-reader",
      network: "public",
      dailyAt: { hour: 6, minute: 0 },
      lookbackDays: 3,
      timeoutMs: 3_600_000,
      // §p.1 fetch step: the AWS Open Data pubnet store by default on `public`.
      sourceUrl: "https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/pubnet",
      fetchTimeoutMs: 21_600_000,
      // day-anchor check (C-144): SCF_HORIZON_URL unless SCF_ONCHAIN_HORIZON_URL is set
      horizonUrl: "https://horizon.stellar.org",
    });
    const d = loadConfig({
      ...base,
      SCF_ONCHAIN_LEDGER_DIR: "/data/ledgers",
      SCF_ONCHAIN_READER_BIN: "/opt/reader",
      SCF_STELLAR_NETWORK: "testnet",
      SCF_ONCHAIN_DAILY_AT: "07:15",
      SCF_ONCHAIN_LOOKBACK_DAYS: "7",
      SCF_ONCHAIN_READER_TIMEOUT_S: "600",
      SCF_HORIZON_URL: "https://horizon-testnet.stellar.org",
      SCF_ONCHAIN_HORIZON_URL: "https://horizon-testnet.example.org",
    });
    expect(d.onchain).toMatchObject({
      horizonUrl: "https://horizon-testnet.example.org",
      readerBin: "/opt/reader",
      network: "testnet",
      dailyAt: { hour: 7, minute: 15 },
      lookbackDays: 7,
      timeoutMs: 600_000,
      sourceUrl: null, // testnet: no default store (it moves on every reset)
    });
    const t = loadConfig({
      ...base,
      SCF_ONCHAIN_LEDGER_DIR: "/data/ledgers",
      SCF_STELLAR_NETWORK: "testnet",
      SCF_ONCHAIN_LEDGER_SOURCE_URL:
        "https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/testnet/2025-12-18",
      SCF_ONCHAIN_FETCH_TIMEOUT_S: "900",
      SCF_ONCHAIN_LEDGER_HASH_CHECK: "off",
    });
    expect(t.onchain).toMatchObject({
      sourceUrl: expect.stringContaining("/testnet/"),
      fetchTimeoutMs: 900_000,
    });
    expect(t.onchain?.horizonUrl).toBeNull();
    expect(
      loadConfig({
        ...base,
        SCF_ONCHAIN_LEDGER_DIR: "/d",
        SCF_ONCHAIN_LEDGER_SOURCE_URL: "none",
        SCF_HORIZON_URL: "https://h.example",
      }).onchain?.sourceUrl,
    ).toBeNull();
    expect(() =>
      loadConfig({
        ...base,
        SCF_ONCHAIN_LEDGER_DIR: "/d",
        SCF_ONCHAIN_LEDGER_SOURCE_URL: "http://x.example",
      }),
    ).toThrow(ConfigError);
  });
  it("is disabled, named, without a Horizon for the day-anchor check (C-144); off only on testnet", () => {
    const c = loadConfig({
      ...base,
      SCF_ONCHAIN_LEDGER_DIR: "/data/ledgers",
      SCF_JOBS_ENABLED: "",
    });
    expect(c.enabled).not.toContain("onchain_correlation");
    expect(c.disabled).toContainEqual({
      job: "onchain_correlation",
      missing: "SCF_ONCHAIN_HORIZON_URL|SCF_HORIZON_URL",
    });
    expect(() =>
      loadConfig({
        ...base,
        SCF_ONCHAIN_LEDGER_DIR: "/data/ledgers",
        SCF_JOBS_ENABLED: "onchain_correlation",
      }),
    ).toThrow(ConfigError);
    // Public: the check cannot be switched off.
    expect(() =>
      loadConfig({
        ...base,
        SCF_ONCHAIN_LEDGER_DIR: "/d",
        SCF_ONCHAIN_LEDGER_HASH_CHECK: "off",
        SCF_HORIZON_URL: "https://h.example",
      }),
    ).toThrow(/testnet only/);
    expect(() =>
      loadConfig({
        ...base,
        SCF_ONCHAIN_LEDGER_DIR: "/d",
        SCF_STELLAR_NETWORK: "testnet",
        SCF_ONCHAIN_LEDGER_HASH_CHECK: "maybe",
      }),
    ).toThrow(ConfigError);
    const dev = loadConfig({
      ...base,
      SCF_ONCHAIN_LEDGER_DIR: "/d",
      SCF_STELLAR_NETWORK: "testnet",
      SCF_ONCHAIN_LEDGER_HASH_CHECK: "off",
    });
    expect(dev.enabled).toContain("onchain_correlation");
    expect(dev.onchain?.horizonUrl).toBeNull();
  });
  it("rejects out-of-range values and a relative directory", () => {
    const dir = { ...base, SCF_ONCHAIN_LEDGER_DIR: "/data", SCF_HORIZON_URL: "https://h.example" };
    expect(() => loadConfig({ ...dir, SCF_ONCHAIN_LOOKBACK_DAYS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...dir, SCF_ONCHAIN_LOOKBACK_DAYS: "31" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...dir, SCF_ONCHAIN_READER_TIMEOUT_S: "5" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SCF_ONCHAIN_LEDGER_DIR: "data" })).toThrow(ConfigError);
  });
});

describe("planDays", () => {
  it("lists the lookback days before today, oldest first", () => {
    expect(planDays(new Date("2026-11-14T06:00:00Z"), 3)).toEqual([
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
    ]);
    expect(planDays(new Date("2026-01-01T00:00:00Z"), 1)).toEqual(["2025-12-31"]);
  });
});

const line = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    contract: C1,
    day: "2026-11-10",
    invocations: 3,
    successful_invocations: 2,
    distinct_invokers: 2,
    data_source: "ledger_files",
    ledgers_in_day: 17280,
    ledger_first: 100,
    ledger_last: 17379,
    complete: true,
    anchor_ledger: 17380,
    anchor_hash: "ab".repeat(32),
    ...o,
  });

describe("parseReaderLine", () => {
  const wanted = new Set([C1]);
  it("accepts a well-formed line", () => {
    expect(parseReaderLine(line(), wanted)).toMatchObject({ contract: C1, invocations: 3 });
    expect(
      parseReaderLine(line({ complete: false, anchor_ledger: null, anchor_hash: null }), wanted),
    ).toMatchObject({ complete: false, anchor_ledger: null });
  });
  it.each([
    ["not JSON", "{"],
    ["an extra field (e.g. an account)", line({ invoker: `G${"A".repeat(55)}` })],
    ["a missing field", JSON.stringify({ contract: C1 })],
    ["a contract that was not asked for", line({ contract: C2 })],
    ["a bad day", line({ day: "2026-13-01" })],
    ["a negative count", line({ invocations: -1 })],
    ["successful above invocations", line({ successful_invocations: 4 })],
    ["invokers above invocations", line({ distinct_invokers: 4 })],
    ["another data source", line({ data_source: "hubble" })],
    ["a non-integer", line({ invocations: 1.5 })],
    ["ledger bounds out of order", line({ ledger_first: 10, ledger_last: 9 })],
    ["complete not boolean", line({ complete: "yes" })],
    ["a complete day without its anchor", line({ anchor_ledger: null, anchor_hash: null })],
    ["an anchor that is not the ledger after the day", line({ anchor_ledger: 17379 })],
    ["an anchor hash that is not 64 hex", line({ anchor_hash: "AB".repeat(32) })],
    ["an incomplete day with an anchor", line({ complete: false })],
    [
      "a line without the anchor fields",
      JSON.stringify({ ...JSON.parse(line()), anchor_ledger: undefined }),
    ],
  ])("rejects %s", (_n, l) => {
    expect(() => parseReaderLine(l, wanted)).toThrow(ReaderError);
  });
});

describe("parseSummary", () => {
  it("keeps the counters of the reader's summary line only", () => {
    expect(
      parseSummary(
        "noise\nonchain-reader: files=3 ledgers=12 duplicate_ledgers=0 out_of_range_ledgers=2 transactions=40 unmatched_results=0 invocations=5\n",
      ),
    ).toEqual({
      files: 3,
      ledgers: 12,
      duplicate_ledgers: 0,
      out_of_range_ledgers: 2,
      transactions: 40,
      unmatched_results: 0,
      invocations: 5,
    });
    expect(parseSummary("onchain-reader: open /x: no such file")).toEqual({});
  });
});

describe("readerArgs", () => {
  it("passes the network, the day bounds and the directory; contracts go on stdin", () => {
    expect(readerArgs("public", "2026-11-10", "2026-11-12", "/data")).toEqual([
      "-network",
      "pubnet",
      "-contracts",
      "-",
      "-from-day",
      "2026-11-10",
      "-to-day",
      "2026-11-12",
      "/data",
    ]);
    expect(readerArgs("testnet", "2026-11-10", "2026-11-10", "/d")[1]).toBe("testnet");
  });
});

/** A stand-in reader: a Node script that echoes its arguments and stdin into a file and prints what it is told. */
function fakeBin(body: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "scf-onchain-fake-"));
  const bin = join(dir, "reader");
  writeFileSync(
    bin,
    `#!${process.execPath}\nconst fs=require('node:fs');const dir=${JSON.stringify(dir)};\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

describe("LedgerFileReader", () => {
  const req = { network: "testnet" as const, fromDay: "2026-11-10", toDay: "2026-11-10" };
  it("runs the binary with the arguments, writes the contracts to stdin and parses its lines", async () => {
    const { bin, dir } = fakeBin(`
      let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
        fs.writeFileSync(dir+'/seen.json', JSON.stringify({args:process.argv.slice(2), input}));
        process.stdout.write(${JSON.stringify(`${line()}\n${line({ contract: C2, invocations: 0, successful_invocations: 0, distinct_invokers: 0 })}\n`)});
        process.stderr.write('onchain-reader: files=1 ledgers=2 duplicate_ledgers=0 out_of_range_ledgers=0 transactions=3 unmatched_results=0 invocations=3\\n');
      });`);
    const r = new LedgerFileReader({ bin, ledgerDir: "/ledgers", timeoutMs: 10_000 });
    const out = await r.read({ ...req, contracts: [C2, C1] }, new AbortController().signal);
    expect(out.rows.map((x) => x.contract)).toEqual([C1, C2]);
    expect(out.summary.ledgers).toBe(2);
    const { readFileSync } = await import("node:fs");
    const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
    expect(seen.args).toEqual(readerArgs("testnet", "2026-11-10", "2026-11-10", "/ledgers"));
    expect(seen.input).toBe(`${C1}\n${C2}\n`);
  });
  it("turns a non-zero exit into a ReaderError carrying the exit code only", async () => {
    const { bin } = fakeBin(
      "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('onchain-reader: open /secret/path: denied\\n');process.exit(1);});",
    );
    const r = new LedgerFileReader({ bin, ledgerDir: "/l", timeoutMs: 10_000 });
    const err = await r
      .read({ ...req, contracts: [C1] }, new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReaderError);
    expect(err.exitCode).toBe(1);
    expect(err.message).not.toContain("/secret/path");
  });
  it("rejects output for a contract it did not ask for", async () => {
    const { bin } = fakeBin(
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(`${line({ contract: C2 })}\n`)}));`,
    );
    const r = new LedgerFileReader({ bin, ledgerDir: "/l", timeoutMs: 10_000 });
    await expect(
      r.read({ ...req, contracts: [C1] }, new AbortController().signal),
    ).rejects.toBeInstanceOf(ReaderError);
  });
  it("kills the process at the timeout and on abort", async () => {
    const { bin } = fakeBin("setInterval(()=>{},1000);");
    const slow = new LedgerFileReader({ bin, ledgerDir: "/l", timeoutMs: 300 });
    const t0 = Date.now();
    const err = await slow
      .read({ ...req, contracts: [C1] }, new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReaderError);
    expect(err.reason).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(5_000);
    const ac = new AbortController();
    const p = new LedgerFileReader({ bin, ledgerDir: "/l", timeoutMs: 60_000 })
      .read({ ...req, contracts: [C1] }, ac.signal)
      .catch((e) => e);
    setTimeout(() => ac.abort(), 100);
    expect((await p).name).toBe("AbortError");
  });
  it("refuses output larger than the bound", async () => {
    const { bin } = fakeBin(
      "process.stdin.resume();process.stdin.on('end',()=>{const s='x'.repeat(1<<16);let n=0;const w=()=>{while(n<200){n++;if(!process.stdout.write(s))return process.stdout.once('drain',w);}};w();});",
    );
    const r = new LedgerFileReader({
      bin,
      ledgerDir: "/l",
      timeoutMs: 10_000,
      maxOutputBytes: 1 << 20,
    });
    const err = await r
      .read({ ...req, contracts: [C1] }, new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReaderError);
    expect(err.reason).toBe("output_too_large");
  });
  it("reports a missing binary as a ReaderError", async () => {
    const r = new LedgerFileReader({
      bin: "/nonexistent/reader",
      ledgerDir: "/l",
      timeoutMs: 1000,
    });
    const err = await r
      .read({ ...req, contracts: [C1] }, new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReaderError);
    expect(err.reason).toBe("spawn_failed");
  });
});
