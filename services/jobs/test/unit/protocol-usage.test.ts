// SPDX-License-Identifier: Apache-2.0
// Job protocol_usage (protocol interactions, migration 0082): configuration, the curated registry (valid, versioned,
// one protocol per contract, the closed protocol enum), the strict parser of `onchain-reader protocols` lines (no
// unknown field: never a contract, an account or the "dev" label of a local Quickstart) and the process wrapper.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";
import { projectGroup, tenantGroup } from "../../src/jobs/protocol-usage.ts";
import {
  LedgerProtocolReader,
  parseProtoLine,
  protoArgs,
  protoInput,
} from "../../src/onchain/protocols/reader.ts";
import {
  PROTOCOL_IDS,
  protocolContracts,
  REGISTRY,
  validateRegistry,
} from "../../src/onchain/protocols/registry.ts";
import { ReaderError } from "../../src/onchain/reader.ts";
import { strkeyEncode } from "../../src/stellar/xdr.ts";

const base = {
  SCF_JOBS_DATABASE_URL: "postgres://scf_jobs@pgbouncer:6432/scf",
  SCF_UMAMI_RO_URL: "postgres://scf_umami_ro@pgbouncer:6432/umami",
  SCF_UMAMI_MAINT_URL: "postgres://scf_umami_maint@pgbouncer:6432/umami",
};
const C1 = strkeyEncode(Buffer.alloc(32, 1), 2 << 3);
const C2 = strkeyEncode(Buffer.alloc(32, 2), 2 << 3);
const P = projectGroup("019a0000-0000-7000-8000-000000000001");
const T = tenantGroup("019a0000-0000-7000-8000-0000000000aa");
const G = new Set([P, T]);
const PR = new Set(["blend", "reflector"]);

describe("protocol_usage configuration", () => {
  it("is left out without a mirror and refused when named", () => {
    const c = loadConfig(base);
    expect(c.enabled).not.toContain("protocol_usage");
    expect(c.disabled).toContainEqual({ job: "protocol_usage", missing: "SCF_ONCHAIN_LEDGER_DIR" });
    expect(c.protocolUsage).toBeNull();
    expect(() => loadConfig({ ...base, SCF_JOBS_ENABLED: "protocol_usage" })).toThrow(ConfigError);
  });
  it("reads its schedule, lookback (≤ 7) and timeout", () => {
    const env = {
      ...base,
      SCF_ONCHAIN_LEDGER_DIR: "/data/ledgers",
      SCF_HORIZON_URL: "https://horizon.stellar.org",
    };
    expect(loadConfig(env).protocolUsage).toEqual({
      dailyAt: { hour: 7, minute: 45 },
      lookbackDays: 3,
      timeoutMs: 7_200_000,
    });
    expect(loadConfig(env).enabled).toContain("protocol_usage");
    expect(
      loadConfig({
        ...env,
        SCF_PROTOCOL_USAGE_DAILY_AT: "09:10",
        SCF_PROTOCOL_USAGE_LOOKBACK_DAYS: "7",
        SCF_PROTOCOL_USAGE_READER_TIMEOUT_S: "60",
      }).protocolUsage,
    ).toEqual({ dailyAt: { hour: 9, minute: 10 }, lookbackDays: 7, timeoutMs: 60_000 });
    expect(() => loadConfig({ ...env, SCF_PROTOCOL_USAGE_LOOKBACK_DAYS: "8" })).toThrow(
      ConfigError,
    );
  });
});

describe("protocol registry", () => {
  it("covers the five protocols on both networks with sourced, checksummed contract ids", () => {
    expect(REGISTRY.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(REGISTRY.protocols.map((p) => p.id).sort()).toEqual([...PROTOCOL_IDS].sort());
    for (const net of ["mainnet", "testnet"] as const) {
      const pairs = protocolContracts(REGISTRY, net);
      expect(new Set(pairs.map((p) => p.protocol))).toEqual(new Set(PROTOCOL_IDS));
      expect(new Set(pairs.map((p) => p.contract)).size).toBe(pairs.length);
    }
    for (const p of REGISTRY.protocols)
      for (const c of p.contracts) {
        expect(c.source).toMatch(/^https:\/\//);
        // A VERIFIED id comes from a repository file at a pinned commit.
        if (c.status === "VERIFIED") expect(c.source).toMatch(/\/blob\/[0-9a-f]{40}\//);
      }
  });
  it("refuses a bad registry", () => {
    const ok = {
      version: "2026-11-19.1",
      retrieved: "2026-11-19",
      note: "",
      protocols: [
        {
          id: "blend",
          name: "Blend",
          website: "https://www.blend.capital",
          contracts: [
            {
              network: "mainnet",
              contract_id: C1,
              role: "pool",
              status: "VERIFIED",
              source: "https://x",
            },
          ],
        },
      ],
    };
    expect(() => validateRegistry(ok)).not.toThrow();
    const variants: unknown[] = [
      { ...ok, version: "1" },
      { ...ok, protocols: [{ ...ok.protocols[0], id: "phoenix" }] },
      { ...ok, protocols: [ok.protocols[0], ok.protocols[0]] },
      {
        ...ok,
        protocols: [
          ok.protocols[0],
          { ...ok.protocols[0], id: "soroswap" }, // the same contract in two protocols
        ],
      },
      {
        ...ok,
        protocols: [
          {
            ...ok.protocols[0],
            contracts: [{ ...ok.protocols[0]?.contracts[0], contract_id: `${C1.slice(0, -1)}A` }],
          },
        ],
      },
      {
        ...ok,
        protocols: [
          {
            ...ok.protocols[0],
            contracts: [{ ...ok.protocols[0]?.contracts[0], status: "GUESS" }],
          },
        ],
      },
    ];
    for (const v of variants) expect(() => validateRegistry(v)).toThrow(/protocol registry/);
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
    group: P,
    day: "2026-11-16",
    transactions: 10,
    successful_transactions: 9,
    ...o,
  });
const proto = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "protocol",
    group: T,
    day: "2026-11-16",
    protocol: "blend",
    transactions: 3,
    successful_transactions: 3,
    ...o,
  });
const network = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "network",
    day: "2026-11-16",
    protocol: "reflector",
    transactions: 0,
    successful_transactions: 0,
    ...o,
  });

describe("parseProtoLine", () => {
  it("accepts the four kinds", () => {
    for (const l of [day(), group(), proto(), network()])
      expect(() => parseProtoLine(l, G, PR)).not.toThrow();
  });
  it("refuses a dev-labelled line, a contract, an account, unknown groups or protocols, bad counts", () => {
    const bad = [
      group({ dev: true }), // a local Quickstart's figures are never stored
      proto({ contract: C2 }),
      group({ invoker: `G${"A".repeat(55)}` }),
      group({ group: "p-019a0000-0000-7000-8000-000000000999" }),
      proto({ protocol: "soroswap" }), // not requested in this run
      proto({ protocol: "phoenix" }),
      proto({ transactions: 0, successful_transactions: 0 }),
      network({ successful_transactions: 1 }),
      day({ complete: true, anchor_hash: null }),
      JSON.stringify({ kind: "week" }),
      "not json",
    ];
    for (const l of bad) expect(() => parseProtoLine(l, G, PR), l).toThrow(ReaderError);
  });
});

function fakeBin(body: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "scf-proto-fake-"));
  const bin = join(dir, "reader");
  writeFileSync(
    bin,
    `#!${process.execPath}\nconst fs=require('node:fs');const dir=${JSON.stringify(dir)};\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

describe("LedgerProtocolReader", () => {
  const req = {
    network: "testnet" as const,
    fromDay: "2026-11-14",
    toDay: "2026-11-16",
    members: [
      { group: T, contract: C2 },
      { group: P, contract: C1 },
    ],
    protocols: [
      { protocol: "reflector" as const, contract: C1 },
      { protocol: "blend" as const, contract: C2 },
    ],
  };
  it("passes arguments and sorted input lines, and splits the output by kind", async () => {
    const { bin, dir } = fakeBin(`
      let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
        fs.writeFileSync(dir+'/seen.json', JSON.stringify({args:process.argv.slice(2), input}));
        process.stdout.write(${JSON.stringify(`${day()}\n${group()}\n${proto()}\n${network()}\n`)});
        process.stderr.write('onchain-reader protocols: files=3 ledgers=51840 duplicate_ledgers=0 out_of_range_ledgers=2 transactions=9 soroban_transactions=5 group_transactions=4 protocol_transactions=2\\n');
      });`);
    const out = await new LedgerProtocolReader({
      bin,
      ledgerDir: "/ledgers",
      timeoutMs: 10_000,
    }).read(req, new AbortController().signal);
    expect([out.days.length, out.groups.length, out.protocols.length, out.network.length]).toEqual([
      1, 1, 1, 1,
    ]);
    expect(out.summary).toMatchObject({ ledgers: 51840, protocol_transactions: 2 });
    const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
    expect(seen.args).toEqual(protoArgs("testnet", "2026-11-14", "2026-11-16", "/ledgers"));
    expect(seen.args.slice(0, 3)).toEqual(["protocols", "-network", "testnet"]);
    expect(seen.input).toBe(protoInput(req));
    expect(seen.input).toBe(
      `group ${P} ${C1}\ngroup ${T} ${C2}\nprotocol blend ${C2}\nprotocol reflector ${C1}\n`,
    );
  });
  it("fails on a dev-labelled line (a Quickstart mirror) and on a non-zero exit", async () => {
    const dev = fakeBin(
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(`${group({ dev: true })}\n`)}));`,
    );
    await expect(
      new LedgerProtocolReader({ bin: dev.bin, ledgerDir: "/l", timeoutMs: 10_000 }).read(
        req,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "invalid_output" });
    const exit = fakeBin("process.stdin.resume();process.stdin.on('end',()=>process.exit(2));");
    await expect(
      new LedgerProtocolReader({ bin: exit.bin, ledgerDir: "/l", timeoutMs: 10_000 }).read(
        req,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "exit_nonzero", exitCode: 2 });
  });
});
