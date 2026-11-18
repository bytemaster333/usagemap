// SPDX-License-Identifier: Apache-2.0
// Read-only run against public TESTNET (no transaction is submitted; simulateTransaction does not submit).
// Writes results/testnet-<date>.json with the collected metric points (names, attributes, counts, sums).
import { mkdirSync, writeFileSync } from "node:fs";
import { Account, Asset, BASE_FEE, Contract, Horizon, Keypair, Networks, rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { instrumentHorizon } from "../src/instrument-horizon.ts";
import { instrumentStellarRpc } from "../src/instrument-stellar-rpc.ts";
import { assertClean, setup } from "../test/helpers.ts";

const RPC = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";

const { reader, meter } = setup();
const server = new rpc.Server(RPC);
instrumentStellarRpc(server, { meter }); // network learnt from getNetwork
const horizon = new Horizon.Server(HORIZON);
instrumentHorizon(horizon as never, { meter, network: "testnet" });

const log: string[] = [];
const step = async (name: string, f: () => Promise<unknown>) => {
  try {
    const r = await f();
    log.push(`${name}: ok${r && typeof r === "object" && "status" in r ? ` (${String((r as { status: unknown }).status)})` : ""}`);
  } catch (e) {
    log.push(`${name}: threw ${(e as { code?: unknown })?.code ?? (e as Error)?.name ?? "error"}`);
  }
};

await step("getNetwork", () => server.getNetwork());
for (let i = 0; i < 3; i++) await step("getHealth", () => server.getHealth());
await step("getLatestLedger", () => server.getLatestLedger());
await step("getFeeStats", () => server.getFeeStats());
await step("getVersionInfo", () => server.getVersionInfo());
await step("getTransaction(random hash)", () => server.getTransaction(Buffer.from(Keypair.random().rawPublicKey()).toString("hex")));
// Simulate a read-only call on the native asset's SAC from a fresh (unfunded) key: shows the simulation error class.
const sac = new Contract(Asset.native().contractId(Networks.TESTNET));
const sim = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(sac.call("decimals"))
  .setTimeout(30)
  .build();
await step("simulateTransaction(SAC.decimals)", () => server.simulateTransaction(sim));
await step("horizon.feeStats", () => horizon.feeStats());
await step("horizon.ledgers.limit(1)", () => horizon.ledgers().order("desc").limit(1).call());
await step("horizon.loadAccount(random)", () => horizon.loadAccount(Keypair.random().publicKey()));

const { resourceMetrics } = await reader.collect();
const out: unknown[] = [];
for (const sm of resourceMetrics.scopeMetrics)
  for (const m of sm.metrics)
    for (const dp of m.dataPoints as { attributes: Record<string, unknown>; value: number | { count: number; sum?: number; min?: number; max?: number } }[])
      out.push({
        metric: m.descriptor.name,
        unit: m.descriptor.unit,
        attributes: dp.attributes,
        ...(typeof dp.value === "number"
          ? { value: dp.value }
          : { count: dp.value.count, sum_s: Number(dp.value.sum?.toFixed(4)), min_s: dp.value.min, max_s: dp.value.max }),
      });
const json = JSON.stringify({ date: new Date().toISOString(), rpc_host: new URL(RPC).host, horizon_host: new URL(HORIZON).host, steps: log, points: out }, null, 2);
// The points themselves must be address-free (hosts are recorded only in this local evidence header, not in metrics).
assertClean(JSON.stringify(out));
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/testnet-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url);
writeFileSync(file, `${json}\n`);
console.log(log.join("\n"));
console.log(JSON.stringify(out, null, 1));
