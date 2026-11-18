// SPDX-License-Identifier: Apache-2.0
// Read-only smoke test against the public Stellar TESTNET (nothing is submitted; simulateTransaction does not
// submit). Skipped unless STELLAR_OTEL_TESTNET=1 (`pnpm --filter @usagemap/stellar-otel test:testnet`).
// RPC_URL / HORIZON_URL override the public endpoints.
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { instrumentHorizon, instrumentStellarRpc } from "../src/index.ts";
import { assertClean, assertKeys, points, setup } from "./helpers.ts";

const RPC = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";

describe.skipIf(process.env.STELLAR_OTEL_TESTNET !== "1")("public testnet, read-only", () => {
  it("records RPC and Horizon calls with closed attributes only", { timeout: 60_000 }, async () => {
    const { reader, meter } = setup();
    const server = new rpc.Server(RPC);
    instrumentStellarRpc(server, { meter });
    const horizon = new Horizon.Server(HORIZON);
    instrumentHorizon(horizon, { meter, network: "testnet" });

    await server.getNetwork();
    await server.getHealth();
    await server.getLatestLedger();
    const g = await server.getTransaction(
      Buffer.from(Keypair.random().rawPublicKey()).toString("hex"),
    );
    expect(g.status).toBe("NOT_FOUND");
    const sac = new Contract(Asset.native().contractId(Networks.TESTNET));
    const sim = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(sac.call("decimals"))
      .setTimeout(30)
      .build();
    await server.simulateTransaction(sim);
    await horizon.feeStats();
    await horizon.loadAccount(Keypair.random().publicKey()).catch(() => undefined);

    const p = await points(reader);
    assertKeys(p);
    assertClean(JSON.stringify(p));
    const methods = p
      .filter((x) => x.name === "rpc.client.call.duration")
      .map((x) => `${x.attrs["rpc.method"]}/${x.attrs["stellar.network"]}`)
      .sort();
    expect(methods).toEqual([
      "getHealth/testnet",
      "getLatestLedger/testnet",
      "getNetwork/testnet",
      "getTransaction/testnet",
      "simulateTransaction/testnet",
    ]);
    expect(p.find((x) => x.name === "stellar.tx.polls")?.attrs["stellar.tx.status"]).toBe(
      "NOT_FOUND",
    );
    expect(p.find((x) => x.name === "stellar.tx.simulations")?.attrs["stellar.sim.outcome"]).toBe(
      "success",
    );
    const routes = p
      .filter((x) => x.name === "http.client.request.duration")
      .map((x) => `${x.attrs["url.template"]} ${x.attrs["http.response.status_code"]}`)
      .sort();
    expect(routes).toEqual(["/accounts/{id} 404", "/fee_stats 200"]);
  });
});
