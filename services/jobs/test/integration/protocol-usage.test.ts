// SPDX-License-Identifier: Apache-2.0
// Acceptance (protocol interactions, migration 0082): job protocol_usage runs the real `onchain-reader protocols`
// (built from source) over a synthetic ledger lake written by the reader's lakegen (keys derived from labels, no real
// account) and stores, as scf_jobs through PgBouncer, per registry project and per opted-in tenant (its verified
// contracts) and UTC day how many of their transactions also touched a protocol of the registry — through the
// footprint, the authorization trees or the top-level call — plus the protocols' network totals; idempotently (a
// second run reads nothing); a day whose anchor Horizon disputes is refused and fails the run; nothing stored names a
// contract of a transaction or an account.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScfDb } from "../../src/db.ts";
import { type ProtocolUsageOptions, runProtocolUsage } from "../../src/jobs/protocol-usage.ts";
import { HorizonLedgerHashes } from "../../src/onchain/ledger-hashes.ts";
import { LedgerProtocolReader, type ProtoSource } from "../../src/onchain/protocols/reader.ts";
import { type ProtocolRegistry, validateRegistry } from "../../src/onchain/protocols/registry.ts";
import { capture, jobsDb, seedSite, superClient } from "../support/harness.ts";

const READER_SRC = resolve(import.meta.dirname, "../../../onchain-reader");
const P_APP = "019a7000-0000-7000-8000-0000000000e1";

let su: pg.Pool;
let db: ScfDb;
let work: string;
let bin: string;
let lake: string;
let C: Record<string, string>;
let registry: ProtocolRegistry;
let tenantId: string;
const NETWORK = new Map<number, string>();
const forged = new Set<number>();
let horizon: Server;
let horizonUrl: string;

const noon = (d: number) => `2026-11-${String(d).padStart(2, "0")}T12:00:00Z`;
const LEDGERS = [
  { seq: 4000, closed_at: "2026-11-12T23:59:55Z", txs: [] },
  {
    seq: 4001,
    closed_at: noon(13),
    v2: true,
    txs: [
      // the app reads the oracle and supplies to the Blend pool (footprint only)
      {
        source: "alice",
        contract: "app",
        function: "deposit",
        success: true,
        footprint: ["app", "blend-pool", "reflector-oracle"],
      },
      // Blend used without the app: network total only
      {
        source: "bob",
        contract: "blend-pool",
        function: "submit",
        success: true,
        footprint: ["blend-pool"],
      },
      { source: "carol", success: true }, // payment
    ],
  },
  {
    seq: 4002,
    closed_at: noon(14),
    txs: [
      // a failed, fee-bumped swap through the router that calls the app (authorization tree)
      {
        source: "carol",
        contract: "soroswap-router",
        function: "swap",
        success: false,
        fee_bump: true,
        auth: [
          {
            contract: "soroswap-router",
            function: "swap",
            sub: [{ contract: "app", function: "hook" }],
          },
        ],
      },
    ],
  },
  { seq: 4003, closed_at: noon(15), txs: [] },
  { seq: 4004, closed_at: "2026-11-16T00:00:00Z", txs: [] },
];
const NOW = new Date("2026-11-16T07:45:00Z");

beforeAll(async () => {
  su = superClient("scf");
  db = jobsDb();
  work = mkdtempSync(join(tmpdir(), "scf-proto-it-"));
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
  const entry = (id: string, label: string) => ({
    id,
    name: id,
    website: "https://example.org",
    contracts: [
      {
        network: "testnet",
        contract_id: C[label],
        role: "main",
        status: "VERIFIED",
        source: "https://example.org/x",
      },
    ],
  });
  registry = validateRegistry({
    version: "2026-11-19.9",
    retrieved: "2026-11-19",
    note: "test",
    protocols: [
      entry("blend", "blend-pool"),
      entry("soroswap", "soroswap-router"),
      entry("reflector", "reflector-oracle"),
    ],
  });
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

  await su.query("DELETE FROM scf.protocol_usage_days");
  await su.query("DELETE FROM scf.protocol_usage_tenant_daily");
  await su.query("DELETE FROM scf.registry_projects WHERE registry_project_id = $1", [P_APP]);
  await su.query(
    `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, contract_ids,
                                        fetched_at, content_sha256, raw)
     VALUES ($1::uuid, 'stellarlight', 'proto-app', 'Protocol app', true, $2::text[], now(), sha256(convert_to('proto-app', 'UTF8')), '{}')`,
    [P_APP, [C.app]],
  );
  const t = await seedSite(su);
  tenantId = t.tenantId;
  const ev = await su.query<{ evidence_id: string }>(
    `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, status)
     VALUES ($1, 'stellar_account', 'G' || repeat('P', 55), 'valid') RETURNING evidence_id`,
    [tenantId],
  );
  await su.query(
    `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, created_by, status, verified_role,
                                         verified_by_evidence, verified_at)
     VALUES ($1, $2, 'testnet', $3, 'verified', 'deployer', $4, now())`,
    [tenantId, C.app, t.userId, ev.rows[0]?.evidence_id],
  );
  await su.query("UPDATE scf.tenants SET onchain_correlation_enabled = true WHERE tenant_id = $1", [
    tenantId,
  ]);
}, 300_000);

afterAll(async () => {
  await new Promise<void>((ok) => (horizon ? horizon.close(() => ok()) : ok()));
  if (su) {
    await su.query("DELETE FROM scf.protocol_usage_days");
    await su.query("DELETE FROM scf.protocol_usage_tenant_daily");
    if (tenantId)
      await su.query(
        "UPDATE scf.tenants SET onchain_correlation_enabled = false WHERE tenant_id = $1",
        [tenantId],
      );
    await su.query("DELETE FROM scf.registry_projects WHERE registry_project_id = $1", [P_APP]);
    await su.end();
  }
  await db?.pool.end();
  if (work) rmSync(work, { recursive: true, force: true });
});

function counting(src: ProtoSource): ProtoSource & { calls: number } {
  const s = {
    calls: 0,
    read: (req: Parameters<ProtoSource["read"]>[0], sig: AbortSignal) => {
      s.calls++;
      return src.read(req, sig);
    },
  };
  return s;
}

const opts = (): ProtocolUsageOptions => ({
  network: "testnet",
  lookbackDays: 3,
  ledgerHashes: new HorizonLedgerHashes({ horizonUrl }),
  registry,
});

async function q<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
  return (await su.query(sql, args)).rows as T[];
}

describe("job protocol_usage", () => {
  it("stores per project, tenant and network the transactions that touch each protocol", async () => {
    const src = counting(new LedgerProtocolReader({ bin, ledgerDir: lake, timeoutMs: 120_000 }));
    const r = await runProtocolUsage(db, src, opts(), capture().ctx({ now: NOW }));
    expect(r).toMatchObject({
      fromDay: "2026-11-13",
      toDay: "2026-11-15",
      daysStored: ["2026-11-13", "2026-11-14", "2026-11-15"],
      incompleteDays: [],
      anchorMismatchDays: [],
    });
    expect(r.tenants).toBeGreaterThanOrEqual(1);
    const days = await q<{ day: string; v: string }>(
      `SELECT day::text, concat_ws(',', anchor_ledger, anchor_checked, registry_version) AS v
         FROM scf.protocol_usage_days WHERE network = 'testnet' ORDER BY day`,
    );
    expect(days.map((d) => `${d.day} ${d.v}`)).toEqual([
      "2026-11-13 4002,t,2026-11-19.9",
      "2026-11-14 4003,t,2026-11-19.9",
      "2026-11-15 4004,t,2026-11-19.9",
    ]);
    const project = await q<{ v: string }>(
      `SELECT concat_ws(' ', day, protocol, transactions, successful_transactions) AS v
         FROM scf.protocol_usage_project_daily WHERE registry_project_id = $1 ORDER BY day, protocol`,
      [P_APP],
    );
    const want = [
      "2026-11-13 any 1 1",
      "2026-11-13 blend 1 1",
      "2026-11-13 reflector 1 1",
      "2026-11-14 any 1 0",
      "2026-11-14 soroswap 1 0",
      "2026-11-15 any 0 0",
    ];
    expect(project.map((x) => x.v)).toEqual(want);
    const tenant = await q<{ v: string }>(
      `SELECT concat_ws(' ', day, protocol, transactions, successful_transactions) AS v
         FROM scf.protocol_usage_tenant_daily WHERE tenant_id = $1 ORDER BY day, protocol`,
      [tenantId],
    );
    expect(tenant.map((x) => x.v)).toEqual(want);
    const network = await q<{ v: string }>(
      `SELECT concat_ws(' ', day, protocol, transactions, successful_transactions) AS v
         FROM scf.protocol_usage_network_daily WHERE transactions > 0 ORDER BY day, protocol`,
    );
    expect(network.map((x) => x.v)).toEqual([
      "2026-11-13 blend 2 2",
      "2026-11-13 reflector 1 1",
      "2026-11-14 soroswap 1 0",
    ]);
    // Only protocol labels and counts are stored: no contract of a transaction, no account.
    const dump = JSON.stringify(
      await q(
        `SELECT row_to_json(x)::text AS j FROM scf.protocol_usage_project_daily x
         UNION ALL SELECT row_to_json(y)::text FROM scf.protocol_usage_tenant_daily y
         UNION ALL SELECT row_to_json(z)::text FROM scf.protocol_usage_network_daily z
         UNION ALL SELECT row_to_json(d)::text FROM scf.protocol_usage_days d`,
      ),
    );
    for (const label of ["blend-pool", "soroswap-router", "reflector-oracle", "app"])
      expect(dump).not.toContain(C[label]);
    expect(dump).not.toMatch(/G[A-Z2-7]{55}/);

    // Idempotent: nothing is missing, the reader is not started again.
    const again = counting(new LedgerProtocolReader({ bin, ledgerDir: lake, timeoutMs: 120_000 }));
    const r2 = await runProtocolUsage(db, again, opts(), capture().ctx({ now: NOW }));
    expect(again.calls).toBe(0);
    expect(r2.daysStored).toEqual([]);
  }, 120_000);

  it("refuses a day whose anchor Horizon disputes and fails the run; the next run fills it", async () => {
    await su.query(
      "DELETE FROM scf.protocol_usage_days WHERE network = 'testnet' AND day = '2026-11-14'",
    );
    await su.query("DELETE FROM scf.protocol_usage_tenant_daily WHERE day = '2026-11-14'");
    forged.add(4003);
    const src = new LedgerProtocolReader({ bin, ledgerDir: lake, timeoutMs: 120_000 });
    await expect(
      runProtocolUsage(db, src, opts(), capture().ctx({ now: NOW })),
    ).rejects.toMatchObject({
      name: "ProtocolUsageAnchorMismatch",
    });
    expect(
      await q(
        "SELECT 1 FROM scf.protocol_usage_days WHERE network = 'testnet' AND day = '2026-11-14'",
      ),
    ).toHaveLength(0);
    forged.clear();
    const r = await runProtocolUsage(db, src, opts(), capture().ctx({ now: NOW }));
    expect(r.daysStored).toEqual(["2026-11-14"]);
    const tenant = await q<{ v: string }>(
      `SELECT concat_ws(' ', protocol, transactions) AS v FROM scf.protocol_usage_tenant_daily
        WHERE tenant_id = $1 AND day = '2026-11-14' ORDER BY protocol`,
      [tenantId],
    );
    expect(tenant.map((x) => x.v)).toEqual(["any 1", "soroswap 1"]);
  }, 120_000);
});
