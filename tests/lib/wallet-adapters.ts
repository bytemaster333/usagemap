// SPDX-License-Identifier: Apache-2.0
// Wallet-adapter canaries and the tenant page that exercises every adapter of the tracker's npm build against
// stand-in wallet objects (used by inventory/85-wallet-adapters.e2e.test.ts). The stand-ins hand the adapters canary
// values wherever a real wallet would: the user's G-address, a smart wallet's C-address, signed XDR, a transaction
// hash, a passkey key id and an error message carrying the address. Shapes follow the adapters' structural types
// (tracker/src/wallets-kit.ts, wallets.ts, passkey.ts) and the wallets' documented results.

import { tag } from "./canaries.ts";
import type { Canary } from "./privacy-scan.ts";
import { randomStrKey } from "./stellar.ts";

export interface WalletCanaries {
  account: string;
  account2: string;
  contract: string;
  contract2: string;
  xdr: string;
  hash: string;
  keyId: string;
  message: string;
}

export function walletCanaries(): WalletCanaries {
  return {
    account: randomStrKey("G"),
    account2: randomStrKey("G"),
    contract: randomStrKey("C"),
    contract2: randomStrKey("C"),
    // base64 XDR-shaped (a TransactionEnvelope starts with AAAAAg…)
    xdr: `AAAAAgAAAA${Buffer.from(`canary-xdr-${tag()}${tag()}`).toString("base64")}`,
    hash: `${tag()}${tag()}${tag()}${tag()}${tag()}`.padEnd(64, "0").slice(0, 64),
    keyId: Buffer.from(`canary-key-${tag()}`).toString("base64url"),
    message: `CanaryWalletError${tag()}`,
  };
}

export function asWalletCanaries(c: WalletCanaries): Canary[] {
  return [
    { label: "wallet adapter: end-user G-address", value: c.account },
    { label: "wallet adapter: second G-address", value: c.account2 },
    { label: "wallet adapter: smart-wallet C-address", value: c.contract },
    { label: "wallet adapter: smart-account C-address", value: c.contract2 },
    { label: "wallet adapter: signed XDR", value: c.xdr },
    { label: "wallet adapter: transaction hash", value: c.hash },
    { label: "wallet adapter: passkey key id", value: c.keyId },
    { label: "wallet adapter: wallet error message", value: c.message },
  ];
}

/** The tenant page: the npm tracker and every adapter, exercised against stand-in wallets (plain browser JS). */
export function adapterPage(
  siteKey: string,
  c: WalletCanaries,
  importMap: Record<string, string>,
): string {
  const script = `
import { init } from "@usagemap/tracker";
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
import { wrapFreighter, wrapInjected, attachRpcServer } from "@usagemap/tracker/wallets";
import { attachPasskeyKit, attachSmartAccountKit } from "@usagemap/tracker/passkey";
const C = ${JSON.stringify(c)};
const TESTNET = "Test SDF Network ; September 2015";
const log = (window.__adapters = []);
const step = async (name, fn) => { try { await fn(); log.push(name); } catch (e) { log.push(name + ": " + e); } };
const emitter = () => { const l = {}; return {
  on(n, f) { (l[n] ??= []).push(f); return () => { l[n] = l[n].filter((x) => x !== f); }; },
  emit(n, p) { for (const f of l[n] ?? []) f(p); } }; };
init({ site: ${JSON.stringify(siteKey)} });

await step("wallets-kit", async () => {
  const ev = emitter();
  const kit = {
    on(t, cb) { const off = ev.on(t, cb); if (t === "STATE_UPDATE") cb({ eventType: t, payload: { address: undefined, networkPassphrase: TESTNET } }); return off; },
    async authModal() { return { address: C.account }; },
    async signTransaction() { return { signedTxXdr: C.xdr, signerAddress: C.account }; },
    async signAuthEntry() { return { signedAuthEntry: C.xdr, signerAddress: C.account }; },
    async signMessage() { throw { code: -4, message: C.message + " " + C.account }; },
    async signAndSubmitTransaction() { return { status: "success", hash: C.hash }; },
    async getNetwork() { return { network: "testnet", networkPassphrase: TESTNET }; },
  };
  attachWalletsKit(kit, { networkPassphrase: TESTNET });
  await kit.authModal();
  ev.emit("WALLET_SELECTED", { eventType: "WALLET_SELECTED", payload: { id: "freighter" } });
  ev.emit("STATE_UPDATE", { eventType: "STATE_UPDATE", payload: { address: C.account, networkPassphrase: TESTNET } });
  await kit.signTransaction(C.xdr, { networkPassphrase: TESTNET, address: C.account });
  await kit.signAuthEntry(C.xdr, { networkPassphrase: TESTNET, address: C.account });
  await kit.signMessage("hello " + C.account, { address: C.account }).catch(() => {});
  await kit.signAndSubmitTransaction(C.xdr, { networkPassphrase: TESTNET, address: C.account });
  ev.emit("STATE_UPDATE", { eventType: "STATE_UPDATE", payload: { address: undefined, networkPassphrase: TESTNET } });
  ev.emit("DISCONNECT", { eventType: "DISCONNECT", payload: {} });
});

await step("freighter", async () => {
  const fr = wrapFreighter({
    async requestAccess() { return { address: C.account2 }; },
    async getAddress() { return { address: C.account2 }; },
    async getNetworkDetails() { return { network: "TESTNET", networkPassphrase: TESTNET, networkUrl: "https://horizon-testnet.stellar.org" }; },
    async signTransaction() { return { signedTxXdr: C.xdr, signerAddress: C.account2 }; },
    async signMessage() { return { error: { code: -4, message: C.message + " " + C.account2 } }; },
  }, { networkPassphrase: TESTNET });
  await fr.requestAccess();
  await fr.getNetworkDetails();
  await fr.signTransaction(C.xdr, { networkPassphrase: TESTNET, address: C.account2 });
  await fr.signMessage("hello", { address: C.account2 });
});

await step("injected", async () => {
  const p = wrapInjected({
    async getAddress() { return { address: C.account }; },
    async signTransaction() { return { signedTxXdr: C.xdr, signerAddress: C.account }; },
  }, { networkPassphrase: TESTNET });
  await p.getAddress();
  await p.signTransaction(C.xdr, { networkPassphrase: TESTNET });
});

await step("rpc", async () => {
  const server = {
    async sendTransaction() { return { status: "PENDING", hash: C.hash }; },
    async getTransaction(h) { return { status: "SUCCESS", txHash: h, envelopeXdr: C.xdr, resultXdr: C.xdr }; },
  };
  attachRpcServer(server, { networkPassphrase: TESTNET });
  await server.sendTransaction({ networkPassphrase: TESTNET, toXDR: () => C.xdr, hash: () => C.hash });
  await server.getTransaction(C.hash);
});

await step("passkey-kit", async () => {
  const events = emitter();
  const kit = {
    networkPassphrase: TESTNET, events,
    async createKey() { return { keyId: C.keyId, publicKey: C.xdr }; },
    async connectWallet() { return { contractId: C.contract, keyIdBase64: C.keyId }; },
    async sign(t) { return t; },
  };
  attachPasskeyKit(kit);
  await kit.createKey("app", "user");
  events.emit("walletCreated", { contractId: C.contract, keyId: C.keyId });
  await kit.connectWallet({ keyId: C.keyId });
  events.emit("walletConnected", { contractId: C.contract, keyId: C.keyId });
  await kit.sign(C.xdr, { keyId: C.keyId });
  events.emit("walletDisconnected", { contractId: C.contract });
});

await step("smart-account-kit", async () => {
  const events = emitter();
  const kit = {
    networkPassphrase: TESTNET, events,
    async createWallet() { return { contractId: C.contract2, credentialId: C.keyId, submitResult: { success: true, hash: C.hash } }; },
    async signAndSubmit() { return { success: true, hash: C.hash, ledger: 1 }; },
  };
  attachSmartAccountKit(kit);
  events.emit("credentialCreated", { credentialId: C.keyId });
  await kit.createWallet("app", "user");
  events.emit("walletConnected", { contractId: C.contract2, credentialId: C.keyId });
  await kit.signAndSubmit(C.xdr);
});
window.__done = true;
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wallet adapters</title>
<script type="importmap">${JSON.stringify({ imports: importMap })}</script>
<script type="module">${script}</script></head><body><h1>Wallet adapters</h1></body></html>`;
}
