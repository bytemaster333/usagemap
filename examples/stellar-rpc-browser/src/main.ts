// SPDX-License-Identifier: Apache-2.0
// A vanilla page that calls Stellar RPC from the browser with js-stellar-sdk.

import { rpc } from "@stellar/stellar-sdk";
import { init } from "@usagemap/tracker";
import { attachRpcTelemetry } from "@usagemap/tracker/stellar-rpc";

const server = new rpc.Server(
  import.meta.env.VITE_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
);

// UsageMap: page views, plus one daily aggregate of RPC calls (method, outcome class, latency bucket)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
attachRpcTelemetry(server, { network: "testnet" });

const $ = (id: string) => document.getElementById(id) as HTMLButtonElement;
const step = (name: string, f: () => Promise<unknown>) => async () => {
  try {
    await f();
    $("log").textContent = `${name}: ok`;
  } catch {
    $("log").textContent = `${name}: failed`;
  }
};

$("health").onclick = step("health", () => server.getHealth());
$("network").onclick = step("network", () => server.getNetwork());
