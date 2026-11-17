// SPDX-License-Identifier: Apache-2.0
// Tracker 1.2.0 browser paths through the whole stack (inventory/86-tracker-paths.e2e.test.ts; integration
// verification 2026-11-19, gap 4). Canaries, the tenant pages and the expected rollup of the wallet events.
//
// Each page loads the tracker's npm build (and, for the RPC page, js-stellar-sdk 17.4.0's own browser bundle) and runs
// one path against stand-ins that hand the adapters canary values wherever the real thing would: addresses, signed
// XDR, hashes, signatures, a Privy user id, e-mail and wallet id, a WalletConnect session topic, provider API keys in
// the RPC and Horizon URLs. Shapes follow the adapters' structural types (tracker/src/stellar-rpc.ts, privy.ts,
// wallets-kit.ts, wallets.ts) and the libraries' documented results.

import { tag } from "./canaries.ts";
import type { Canary } from "./privacy-scan.ts";
import { randomStrKey } from "./stellar.ts";

export const TESTNET = "Test SDF Network ; September 2015";

export interface PathCanaries {
  account: string;
  account2: string;
  xdr: string;
  hash: string;
  signature: string;
  message: string;
  /** Provider API key in the RPC URL path (paid RPC providers put keys there). */
  rpcKey: string;
  /** The same in the RPC URL's query string. */
  rpcQuery: string;
  /** Provider API key in the Horizon base path. */
  horizonKey: string;
  privyUserId: string;
  privyEmail: string;
  privyWalletId: string;
  wcTopic: string;
  wcProjectId: string;
}

export function pathCanaries(): PathCanaries {
  return {
    account: randomStrKey("G"),
    account2: randomStrKey("G"),
    xdr: `AAAAAgAAAA${Buffer.from(`canary-xdr-${tag()}${tag()}`).toString("base64")}`,
    hash: `${tag()}${tag()}${tag()}${tag()}${tag()}${tag()}`.slice(0, 64),
    signature: Buffer.from(`canary-sig-${tag()}${tag()}`).toString("base64"),
    message: `CanaryPathError${tag()}`,
    rpcKey: `rpckey${tag()}${tag()}`,
    rpcQuery: `rpcq${tag()}${tag()}`,
    horizonKey: `hzkey${tag()}${tag()}`,
    privyUserId: `did:privy:canary${tag()}`,
    privyEmail: `canary.privy.${tag()}@example.org`,
    privyWalletId: `canarywallet${tag()}`,
    wcTopic: `${tag()}${tag()}${tag()}${tag()}${tag()}`.slice(0, 64),
    wcProjectId: `wcproj${tag()}`,
  };
}

export function asPathCanaries(c: PathCanaries): Canary[] {
  return [
    { label: "tracker 1.2 path: end-user G-address", value: c.account },
    { label: "tracker 1.2 path: second G-address", value: c.account2 },
    { label: "tracker 1.2 path: signed XDR", value: c.xdr },
    { label: "tracker 1.2 path: transaction hash", value: c.hash },
    { label: "tracker 1.2 path: signature", value: c.signature },
    { label: "tracker 1.2 path: wallet error message", value: c.message },
    { label: "tracker 1.2 path: RPC provider key (URL path)", value: c.rpcKey },
    { label: "tracker 1.2 path: RPC provider key (query string)", value: c.rpcQuery },
    { label: "tracker 1.2 path: Horizon provider key (base path)", value: c.horizonKey },
    { label: "tracker 1.2 path: Privy user id", value: c.privyUserId },
    { label: "tracker 1.2 path: Privy login e-mail", value: c.privyEmail },
    { label: "tracker 1.2 path: Privy wallet id", value: c.privyWalletId },
    { label: "tracker 1.2 path: WalletConnect session topic", value: c.wcTopic },
    { label: "tracker 1.2 path: WalletConnect project id", value: c.wcProjectId },
  ];
}

/** The stand-in RPC and Horizon origins (served by request interception, never fetched). */
export const RPC_ORIGIN = "https://rpc.provider.wsl.test";
export const HORIZON_ORIGIN = "https://horizon.provider.wsl.test";

/** A wallet event as it left the browser: name and v1 fields (`id`, `k`, `sv`, `u` removed). */
export type SentEvent = { n: string } & Record<string, string>;

/** Stable text of an event for multiset comparison. */
export const eventKey = (e: SentEvent): string =>
  JSON.stringify(Object.fromEntries(Object.entries(e).sort(([a], [b]) => (a < b ? -1 : 1))));

// §a.3.1: wire key → rollup key (`net` is the network column, not a property).
const ROLLUP_KEY: Record<string, string> = {
  wt: "wallet",
  ck: "connect_kind",
  sk: "sign_kind",
  ec: "error_class",
  rc: "result_class",
  dur: "duration",
  out: "outcome",
  po: "passkey_op",
  fr: "failure_reason",
  wc: "wallet_context",
  ws: "wc_state",
  wm: "wc_method",
};

/**
 * The rows of `scf.web_event_property_daily` that the sent v1 events must produce (wire-formats §a.3.1, §d.3
 * `props`): per event `<name>/_total/all`, and one `<name>/<rollup key>/<value>` per field but `net`, all in the
 * event's network. Keys `event|network|key|value`. The events here always carry `wt` and `net` where the placement
 * allows them, so the gateway's `unknown` fill-ins do not occur.
 */
export function expectedRollup(events: readonly SentEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (k: string) => {
    out[k] = (out[k] ?? 0) + 1;
  };
  for (const e of events) {
    const net = e.net ?? "unknown";
    add(`${e.n}|${net}|_total|all`);
    for (const [k, v] of Object.entries(e)) {
      if (k === "n" || k === "net") continue;
      const rk = ROLLUP_KEY[k];
      if (!rk) throw new Error(`unexpected wire field ${k} on ${e.n}`);
      add(`${e.n}|${net}|${rk}|${v}`);
    }
  }
  return out;
}

/** Shared page frame: optional classic scripts, the import map and the scenario module. */
function frame(
  title: string,
  importMap: Record<string, string>,
  script: string,
  head = "",
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}
<script type="importmap">${JSON.stringify({ imports: importMap })}</script>
<script type="module">
const log = (window.__steps = []);
window.__step = async (name, fn) => { try { await fn(); log.push(name); } catch (e) { log.push(name + ": " + e); } };
${script}
</script></head><body><h1>${title}</h1></body></html>`;
}

const prelude = (siteKey: string, c: PathCanaries) => `
const C = ${JSON.stringify(c)};
const TESTNET = ${JSON.stringify(TESTNET)};
const step = window.__step;
const settle = (p) => Promise.resolve(p).then(() => "ok", () => "failed");
init({ site: ${JSON.stringify(siteKey)} });
`;

/**
 * Browser RPC / Horizon telemetry with the real js-stellar-sdk 17.4.0 browser bundle (`window.StellarSdk`) against
 * stand-in providers whose URLs carry API keys. Phase 1 is handed over by `flushRpcTelemetry()` (`__flushed`), phase 2
 * by the hide flush (`visibilitychange` to hidden) that the test triggers.
 */
export function rpcPage(
  siteKey: string,
  c: PathCanaries,
  importMap: Record<string, string>,
  sdkSrc: string,
): string {
  return frame(
    "Browser RPC",
    importMap,
    `
import { init } from "@usagemap/tracker";
import { attachRpcTelemetry, attachHorizonTelemetry, flushRpcTelemetry, rpcTelemetryCells } from "@usagemap/tracker/stellar-rpc";
${prelude(siteKey, c)}
const S = window.StellarSdk;
const rpc = new S.rpc.Server(${JSON.stringify(RPC_ORIGIN)} + "/" + C.rpcKey + "/?apikey=" + C.rpcQuery);
const hz = new S.Horizon.Server(${JSON.stringify(HORIZON_ORIGIN)} + "/" + C.horizonKey + "/");
const attached = [attachRpcTelemetry(rpc, { network: "testnet" }).attached, attachHorizonTelemetry(hz, { network: "testnet" }).attached];
const results = (window.__results = []);
await step("phase1", async () => {
  if (!attached.every(Boolean)) throw new Error("not attached " + attached);
  for (let i = 0; i < 3; i++) results.push(["getHealth", await settle(rpc.getHealth())]);
  for (let i = 0; i < 2; i++) results.push(["getNetwork", await settle(rpc.getNetwork())]);
  results.push(["getTransaction", await settle(rpc.getTransaction(C.hash))]);
  results.push(["getFeeStats", await settle(rpc.getFeeStats())]);
  results.push(["getVersionInfo", await settle(rpc.getVersionInfo())]);
  for (let i = 0; i < 2; i++) results.push(["ledgers", await settle(hz.ledgers().call())]);
  results.push(["account", await settle(hz.accounts().accountId(C.account).call())]);
  results.push(["transaction", await settle(hz.transactions().transaction(C.hash).call())]);
  window.__cells1 = rpcTelemetryCells();
  window.__flushed = flushRpcTelemetry();
});
await step("phase2", async () => {
  results.push(["getHealth", await settle(rpc.getHealth())]);
  results.push(["ledgers", await settle(hz.ledgers().call())]);
  window.__cells2 = rpcTelemetryCells();
});
window.__done = true;
`,
    `<script src="${sdkSrc}"></script>`,
  );
}

/**
 * `wallet_connect_failed`, the wallet context `wc` and the WalletConnect funnel: the direct Freighter wrapper (a
 * rejected and a locked connect, then a connect inside Varial Mobile's in-app browser) and the Wallets Kit
 * WalletConnect module wrapped by `wrapWalletsKitModules` (a rejected session proposal; an approved one inside
 * D'CENT's in-app browser; an approved and a rejected WalletConnect request; a disconnect).
 */
export function walletsPage(
  siteKey: string,
  c: PathCanaries,
  importMap: Record<string, string>,
): string {
  return frame(
    "Wallet connect failures and WalletConnect",
    importMap,
    `
import { init } from "@usagemap/tracker";
import { wrapFreighter } from "@usagemap/tracker/wallets";
import { wrapWalletsKitModules } from "@usagemap/tracker/wallets-kit";
${prelude(siteKey, c)}
await step("freighter", async () => {
  const answers = [
    { address: "", error: { code: -4, message: C.message + " " + C.account } },
    { address: "" },
    { address: C.account },
  ];
  const fr = wrapFreighter({
    async requestAccess() { return answers.shift(); },
    async getAddress() { return { address: C.account }; },
  }, { networkPassphrase: TESTNET });
  await fr.requestAccess();
  await fr.requestAccess();
  window.stellar = { provider: "freighter", platform: "mobile" };
  await fr.requestAccess();
  delete window.stellar;
});
await step("walletconnect", async () => {
  const answers = [
    () => Promise.reject({ code: 5000, message: C.message, topic: C.wcTopic }),
    () => Promise.resolve({ address: C.account2, topic: C.wcTopic }),
  ];
  const mod = {
    productId: "wallet_connect",
    productName: "Wallet Connect",
    wcParams: { projectId: C.wcProjectId, allowedChains: ["stellar:testnet"] },
    async isAvailable() { return true; },
    getAddress() { return answers.shift()(); },
    async signTransaction() { return { signedTxXdr: C.xdr, signerAddress: C.account2 }; },
    async signMessage() { throw { code: 5000, message: C.message, topic: C.wcTopic }; },
    async disconnect() {},
  };
  const original = mod.getAddress;
  const [wc] = wrapWalletsKitModules([mod], { networkPassphrase: TESTNET });
  if (wc === mod || mod.getAddress !== original) throw new Error("the module itself was modified");
  await settle(wc.getAddress());
  window.stellar = { provider: "dcent", platform: "mobile" };
  await wc.getAddress();
  await wc.signTransaction(C.xdr, { networkPassphrase: TESTNET, address: C.account2 });
  await settle(wc.signMessage("hello " + C.account2, { networkPassphrase: TESTNET, address: C.account2 }));
  await wc.disconnect();
  delete window.stellar;
});
window.__done = true;
`,
  );
}

/**
 * Privy embedded Stellar wallets through `@usagemap/tracker/privy`, against stand-ins of the hook results of
 * `@privy-io/react-auth` 3.52.0 (`useCreateWallet`, `useSignRawHash`, `usePrivy`) and of the `useLogin` callbacks.
 */
export function privyPage(
  siteKey: string,
  c: PathCanaries,
  importMap: Record<string, string>,
): string {
  return frame(
    "Privy",
    importMap,
    `
import { init } from "@usagemap/tracker";
import { privyLoginCallbacks, wrapPrivyStellar } from "@usagemap/tracker/privy";
${prelude(siteKey, c)}
const user = {
  id: C.privyUserId,
  email: { address: C.privyEmail },
  linkedAccounts: [
    { type: "email", address: C.privyEmail },
    { type: "wallet", chainType: "stellar", address: C.account, id: C.privyWalletId },
  ],
};
const wallet = { id: C.privyWalletId, address: C.account, chainType: "stellar", publicKey: C.account };
await step("privy", async () => {
  const appCalls = [];
  const cb = privyLoginCallbacks({
    onComplete: () => appCalls.push("complete"),
    onError: () => appCalls.push("error"),
  }, { networkPassphrase: TESTNET });
  cb.onError({ code: "exited_auth_flow", message: C.message + " " + C.privyEmail });
  const { createWallet } = wrapPrivyStellar({
    async createWallet(o) { return o.chainType === "stellar" ? { user, wallet } : { user, wallet: { address: "0xcanary" } }; },
  }, { networkPassphrase: TESTNET });
  await createWallet({ chainType: "ethereum" });
  await createWallet({ chainType: "stellar" });
  const signs = [
    () => Promise.resolve({ signature: C.signature }),
    () => Promise.reject({ code: "exited_auth_flow", message: C.message }),
  ];
  const { signRawHash } = wrapPrivyStellar({ signRawHash() { return signs.shift()(); } }, { networkPassphrase: TESTNET });
  await signRawHash({ address: C.account, chainType: "stellar", hash: "0x" + C.hash });
  await settle(signRawHash({ address: C.account, chainType: "stellar", hash: "0x" + C.hash }));
  const { logout } = wrapPrivyStellar({ user, async logout() {} });
  await logout();
  cb.onComplete({ user, isNewUser: false, wasAlreadyAuthenticated: true, loginMethod: "email", loginAccount: { type: "email", address: C.privyEmail } });
  if (appCalls.join(",") !== "error,complete") throw new Error("app callbacks " + appCalls);
});
window.__done = true;
`,
  );
}

/**
 * The Wallets Kit module wrapper `wrapWalletsKitModules(defaultModules())`, without `attachWalletsKit`: an xBull module
 * that reports itself unavailable and then fails to connect, a LOBSTR module that connects, signs (approved, rejected,
 * sign-and-submit) and disconnects, and a Freighter module that connects.
 */
export function modulesPage(
  siteKey: string,
  c: PathCanaries,
  importMap: Record<string, string>,
): string {
  return frame(
    "Wallets Kit modules",
    importMap,
    `
import { init } from "@usagemap/tracker";
import { wrapWalletsKitModules } from "@usagemap/tracker/wallets-kit";
${prelude(siteKey, c)}
await step("modules", async () => {
  const modules = [
    { productId: "xbull", productName: "xBull",
      async isAvailable() { return false; },
      async getAddress() { throw { code: -3, message: C.message }; } },
    { productId: "lobstr", productName: "LOBSTR",
      async isAvailable() { return true; },
      async getAddress() { return { address: C.account }; },
      async getNetwork() { return { network: "testnet", networkPassphrase: TESTNET }; },
      async signTransaction() { return { signedTxXdr: C.xdr, signerAddress: C.account }; },
      async signAuthEntry() { throw { code: -4, message: C.message + " " + C.account }; },
      async signAndSubmitTransaction() { return { status: "success", hash: C.hash }; },
      async disconnect() {} },
    { productId: "freighter", productName: "Freighter",
      async getAddress() { return { address: C.account2 }; } },
  ];
  const originals = modules.map((m) => m.getAddress);
  const [xbull, lobstr, freighter] = wrapWalletsKitModules(modules, { networkPassphrase: TESTNET });
  if (modules.some((m, i) => m.getAddress !== originals[i])) throw new Error("a module was modified");
  await xbull.isAvailable();
  await settle(xbull.getAddress());
  await lobstr.isAvailable();
  await lobstr.getAddress();
  await lobstr.getNetwork();
  await lobstr.signTransaction(C.xdr, { networkPassphrase: TESTNET, address: C.account });
  await settle(lobstr.signAuthEntry(C.xdr, { networkPassphrase: TESTNET, address: C.account }));
  await lobstr.signAndSubmitTransaction(C.xdr, { networkPassphrase: TESTNET, address: C.account });
  await lobstr.disconnect();
  await freighter.getAddress();
});
window.__done = true;
`,
  );
}
