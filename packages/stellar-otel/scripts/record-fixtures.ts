// SPDX-License-Identifier: Apache-2.0
// Re-records test/fixtures/testnet-rpc.json: raw JSON-RPC responses of read-only calls against the public Stellar
// TESTNET RPC. Nothing is submitted; getLatestLedger is left out (its metadata XDR carries other users' ledger data).
// The mock RPC in the unit tests replays them, so the classifiers are tested against real response shapes.
// Run: node scripts/record-fixtures.ts [RPC_URL]
import { writeFileSync } from "node:fs";
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const RPC = process.argv[2] ?? process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";

const call = async (method: string, params?: unknown) => {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
  return (await r.json()) as unknown;
};

const sac = new Contract(Asset.native().contractId(Networks.TESTNET));
const sim = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(sac.call("decimals"))
  .setTimeout(30)
  .build();
// A call the contract rejects: `balance` without its argument → a host error in the simulation response.
const simErr = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(sac.call("balance"))
  .setTimeout(30)
  .build();

const out: Record<string, unknown> = {
  recordedAt: new Date().toISOString(),
  rpcHost: new URL(RPC).host,
  getNetwork: await call("getNetwork"),
  getHealth: await call("getHealth"),
  getFeeStats: await call("getFeeStats"),
  getVersionInfo: await call("getVersionInfo"),
  getTransactionNotFound: await call("getTransaction", { hash: "00".repeat(32) }),
  simulateSuccess: await call("simulateTransaction", { transaction: sim.toXDR() }),
  simulateError: await call("simulateTransaction", { transaction: simErr.toXDR() }),
  unknownMethod: await call("getSomethingElse"),
};
writeFileSync(
  new URL("../test/fixtures/testnet-rpc.json", import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log("recorded", Object.keys(out).length - 2, "responses from", out.rpcHost);
