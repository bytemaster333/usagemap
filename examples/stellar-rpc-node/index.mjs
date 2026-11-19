// SPDX-License-Identifier: Apache-2.0
// A backend that talks to Stellar RPC and Horizon with js-stellar-sdk. Two calls make every RPC method and Horizon
// route it uses measurable in UsageMap (latency, outcome class, network); no URL, address, hash or XDR is recorded.

import { Horizon, rpc } from "@stellar/stellar-sdk";
import { instrumentHorizon, instrumentStellarRpc } from "@usagemap/stellar-otel";
import { shutdown } from "./otel.mjs";

const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const allowHttp = (u) => u.startsWith("http://"); // only for a local node

const server = new rpc.Server(RPC_URL, { allowHttp: allowHttp(RPC_URL) });
const horizon = new Horizon.Server(HORIZON_URL, { allowHttp: allowHttp(HORIZON_URL) });

// UsageMap: one line per server object.
const r = instrumentStellarRpc(server, { network: "testnet" });
const h = instrumentHorizon(horizon, { network: "testnet" });
if (!r.instrumented || !h.instrumented) console.warn("stellar-otel: SDK without interceptors");

const health = await server.getHealth();
const network = await server.getNetwork();
const fees = await horizon.feeStats();
console.log(
  `rpc ${health.status}, protocol ${network.protocolVersion}, fee p50 ${fees.fee_charged.p50}`,
);

await shutdown(); // export now; a long-running server exports every 60 s instead
