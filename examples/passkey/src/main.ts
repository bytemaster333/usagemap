// SPDX-License-Identifier: Apache-2.0
// A vanilla dApp with a passkey smart account (smart-account-kit 0.10.0, testnet): create a wallet, connect to it.
import { init } from "@usagemap/tracker";
import { attachSmartAccountKit } from "@usagemap/tracker/passkey";
import { SmartAccountKit } from "smart-account-kit";

const env = import.meta.env;
const kit = new SmartAccountKit({
  rpcUrl: env.VITE_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  // stellar-accounts v0.8.0 account build and the testnet WebAuthn verifier (smart-account-kit README, deployments)
  accountWasmHash:
    env.VITE_ACCOUNT_WASM_HASH ??
    "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1",
  webauthnVerifierAddress: env.VITE_WEBAUTHN_VERIFIER ?? "",
});

// UsageMap: page views, plus passkey ceremonies, smart-wallet creation, connects and signatures (never the C… address)
init({ site: env.VITE_USAGEMAP_SITE ?? "" });
attachSmartAccountKit(kit);

const $ = (id: string) => document.getElementById(id) as HTMLButtonElement;
const step = (name: string, f: () => Promise<unknown>) => async () => {
  try {
    await f();
    $("log").textContent = `${name}: ok`;
  } catch {
    $("log").textContent = `${name}: failed`;
  }
};

$("create").onclick = step("create", () => kit.createWallet("UsageMap example", "demo user"));
$("connect").onclick = step("connect", () => kit.connectWallet({ prompt: true }));
