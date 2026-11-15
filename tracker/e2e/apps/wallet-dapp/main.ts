// SPDX-License-Identifier: Apache-2.0
// A dApp as a tenant writes it: the tracker from npm, the Wallets Kit adapter on the kit class, the Freighter wrapper
// on the freighter-api module, and the RPC submission adapter on the app's RPC server. The kit, Freighter and the RPC
// server are the unit-test mocks (test/wallet-mocks.ts), whose results carry canary addresses, hashes and XDR —
// never a real wallet. `__PROFILE__` selects the npm entry (standard or strict) at fixture build time.

import { init as initStandard } from "@usagemap/tracker";
import { attachRpcTelemetry } from "@usagemap/tracker/stellar-rpc";
import { init as initStrict } from "@usagemap/tracker/strict";
import { attachRpcServer, wrapFreighter } from "@usagemap/tracker/wallets";
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
import { CANARY } from "../../../test/canary.ts";
import { makeFreighter, makeKitV2, reject, TESTNET } from "../../../test/wallet-mocks.ts";

declare const __PROFILE__: "standard" | "strict";

const site = document.documentElement.dataset.site ?? "Q4mZ8bS1pTn0aR7cLx2VwE";
const tracker = (__PROFILE__ === "strict" ? initStrict : initStandard)({ site });
window.fixture = { trackers: [tracker] };

// --- Stellar Wallets Kit v2 (mock of the static class), adapter attached at start-up -------------------------------
// Scaffold Stellar's `wallet.ts` pattern: references copied off the kit at module load, before the adapter attaches
const StellarWalletsKit = makeKitV2();
const signTransaction = StellarWalletsKit.signTransaction;
const signWithKit = StellarWalletsKit.signTransaction;
attachWalletsKit(StellarWalletsKit);

const log = (s: string): void => {
  const el = document.getElementById("log");
  if (el) el.textContent = s;
};
const on = (id: string, fn: () => unknown): void => {
  document.getElementById(id)?.addEventListener("click", () => {
    void Promise.resolve(fn()).then(
      () => log(`${id}: ok`),
      () => log(`${id}: failed`),
    );
  });
};

on("kit-connect", () => {
  // the kit renders its modal under <body> (v2 marker) and the user picks Freighter (kit id `varial` in 2.8.0)
  const modal = StellarWalletsKit.authModal();
  const section = document.createElement("section");
  section.className = "stellar-wallets-kit";
  const pick = document.createElement("button");
  pick.id = "kit-pick-freighter";
  pick.textContent = "Freighter";
  pick.addEventListener("click", () => {
    section.remove();
    StellarWalletsKit.pick("varial");
  });
  section.append(pick);
  document.body.append(section);
  return modal;
});
on("kit-sign", () => signTransaction(CANARY.XDR, { networkPassphrase: TESTNET }));
on("kit-reject", () => {
  StellarWalletsKit.module.signTransaction = reject(-4);
  return signWithKit(CANARY.XDR);
});
on("kit-disconnect", () => StellarWalletsKit.disconnect());

// --- Freighter called directly (mock of the @stellar/freighter-api namespace) --------------------------------------
const freighter = wrapFreighter(makeFreighter());
on("fr-connect", () => freighter.requestAccess());
on("fr-sign", () =>
  freighter.signTransaction(CANARY.XDR, { networkPassphrase: TESTNET, address: CANARY.G }),
);

// --- the app's RPC server (mock of rpc.Server): PENDING, then the app polls ----------------------------------------
const rpcServer = {
  sendTransaction: async (_tx: unknown) => ({
    status: "PENDING",
    hash: CANARY.HASH,
    latestLedger: 1,
  }),
  pollTransaction: async (_hash: string) => ({ status: "SUCCESS", resultXdr: CANARY.XDR }),
};
attachRpcServer(rpcServer);
on("fr-submit", async () => {
  const sent = await rpcServer.sendTransaction({ networkPassphrase: TESTNET });
  return rpcServer.pollTransaction(sent.hash);
});

// --- connect failures (tracker 1.2.0): the user rejects the Freighter access request -------------------------------
const rejecting = makeFreighter();
rejecting.requestAccess = async () =>
  ({ address: "", error: { code: -4, message: CANARY.MESSAGE } }) as never;
const freighterRejects = wrapFreighter(rejecting);
on("fr-connect-rejected", () => freighterRejects.requestAccess());

// --- browser RPC telemetry (tracker 1.2.0, aggregate only): a js-stellar-sdk-shaped HttpClient with interceptors ---
type H = [(v: unknown) => unknown, ((e: unknown) => unknown) | undefined];
const reqH = new Map<number, H>();
const resH = new Map<number, H>();
let hid = 0;
const mgr = (m: Map<number, H>) => ({
  use: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
    m.set(++hid, [f, r]);
    return hid;
  },
  eject: (i: number) => void m.delete(i),
});
const httpClient = { interceptors: { request: mgr(reqH), response: mgr(resH) } };
attachRpcTelemetry({ httpClient }, { network: "testnet" });
const rpcCall = async (method: string): Promise<unknown> => {
  let c: unknown = {
    method: "post",
    url: `https://rpc.example/${CANARY.HASH}/`, // a provider API key in the path: never sent
    data: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { hash: CANARY.HASH } }),
  };
  for (const [f] of reqH.values()) c = await f(c);
  let r: unknown = { status: 200, data: { result: { hash: CANARY.HASH } }, config: c };
  for (const [f] of resH.values()) r = await f(r);
  return r;
};
on("rpc-calls", async () => {
  await rpcCall("getLatestLedger");
  await rpcCall("getLatestLedger");
  await rpcCall("getTransaction");
});
