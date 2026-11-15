// SPDX-License-Identifier: Apache-2.0
// Direct wallet APIs (plan B2, C-135): Freighter, Albedo, xBull, LOBSTR, Hana, HOT, injected providers (D'CENT …), and
// transaction submission (Horizon, RPC) — against mocks shaped like the upstream APIs (never a real wallet). Each
// adapter's flows end with the outbound canary check.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachHorizonServer,
  attachRpcServer,
  detectInjectedWallet,
  wrapAlbedo,
  wrapFreighter,
  wrapHana,
  wrapHot,
  wrapInjected,
  wrapLobstr,
  wrapXBull,
} from "../src/wallets.ts";
import { until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";
import { assertNoCanary, CANARY, stellarSent, tick, waitStellar } from "./stellar-helpers.ts";
import { makeFreighter, PUBLIC, TESTNET } from "./wallet-mocks.ts";

const ctx = trackerHarness();
const g = globalThis as Record<string, unknown>;
afterEach(() => {
  for (const k of ["dcentStellarProvider", "stellar", "rabet", "hanaWallet"]) delete g[k];
});

describe("Freighter", () => {
  it("requestAccess → sign (approved, {error} result, thrown) → getNetwork; the module is not modified", async () => {
    const { gw } = ctx;
    ctx.start();
    const api = makeFreighter();
    const before = { ...api };
    const freighter = wrapFreighter(api);
    expect(await freighter.getAddress()).toEqual({ address: "" }); // not allowed yet: no connect
    expect(await freighter.requestAccess()).toEqual({ address: CANARY.G });
    await freighter.getAddress(); // already connected: once until disconnect
    await freighter.getNetwork(); // → testnet for later events
    await freighter.signTransaction(CANARY.XDR, { networkPassphrase: TESTNET, address: CANARY.G });
    api.signTransaction = async () => ({
      signedTxXdr: "",
      signerAddress: "",
      error: { code: -4, message: CANARY.MESSAGE },
    });
    const res = await freighter.signTransaction(CANARY.XDR, { submit: true });
    expect(res).toMatchObject({ error: { code: -4 } }); // returned unchanged
    api.signTransaction = () => Promise.reject(new Error(CANARY.MESSAGE));
    await expect(freighter.signTransaction(CANARY.XDR)).rejects.toThrow(CANARY.MESSAGE);
    await freighter.signAuthEntry(CANARY.XDR, { networkPassphrase: PUBLIC });
    await freighter.signMessage(CANARY.MESSAGE);
    expect(Object.keys(api)).toEqual(Object.keys(before));
    expect(api.requestAccess).toBe(before.requestAccess);
    const ev = await waitStellar(gw, 11);
    expect(ev).toEqual([
      { n: "wallet_connect", wt: "freighter", net: "unknown", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "freighter", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "tx_submit" },
      {
        n: "sign_rejected",
        wt: "freighter",
        net: "testnet",
        sk: "tx_submit",
        dur: "lt5s",
        ec: "user_rejected",
      },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "tx" },
      { n: "sign_rejected", wt: "freighter", net: "testnet", sk: "tx", dur: "lt5s", ec: "unknown" },
      { n: "sign_requested", wt: "freighter", net: "mainnet", sk: "auth_entry" },
      { n: "sign_approved", wt: "freighter", net: "mainnet", sk: "auth_entry", dur: "lt5s" },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "message" },
      { n: "sign_approved", wt: "freighter", net: "testnet", sk: "message", dur: "lt5s" },
    ]);
    assertNoCanary(gw);
  });

  it("getAddress of an already-allowed site is a restored session", async () => {
    const { gw } = ctx;
    ctx.start();
    const api = makeFreighter();
    api.allowed = true;
    await wrapFreighter(api, { networkPassphrase: PUBLIC }).getAddress();
    expect(await waitStellar(gw, 1)).toEqual([
      { n: "wallet_connect", wt: "freighter", net: "mainnet", ck: "restored", wc: "none" },
    ]);
    assertNoCanary(gw);
  });

  it("keeps non-function exports and calls unwrapped methods on the original", async () => {
    ctx.start();
    const api = { ...makeFreighter(), VERSION: "6.0.1" };
    const f = wrapFreighter(api);
    expect(f.VERSION).toBe("6.0.1");
    expect(await f.isConnected()).toEqual({ isConnected: true });
    expect(f.signTransaction).toBe(f.signTransaction); // stable identity
  });

  it("Scaffold-style re-exports of the wrapped object's methods are counted (the original module is never patched)", async () => {
    const { gw } = ctx;
    ctx.start();
    const api = makeFreighter();
    api.signTransaction = async () => ({ error: { code: -4, message: CANARY.MESSAGE } }); // the user declines
    const freighter = wrapFreighter(api);
    // wallet.ts: `export const { requestAccess, signTransaction } = wrapFreighter(freighterApi)`
    const { requestAccess, signTransaction } = freighter;
    await requestAccess();
    await signTransaction(CANARY.XDR, { networkPassphrase: TESTNET });
    expect(await waitStellar(gw, 3)).toEqual([
      { n: "wallet_connect", wt: "freighter", net: "unknown", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "tx" },
      {
        n: "sign_rejected",
        wt: "freighter",
        net: "testnet",
        sk: "tx",
        dur: "lt5s",
        ec: "user_rejected",
      },
    ]);
    // documented limit: a reference taken from the unwrapped module bypasses the wrapper by design
    await api.requestAccess();
    await tick();
    expect(stellarSent(gw)).toHaveLength(3);
    assertNoCanary(gw);
  });
});

describe("Albedo", () => {
  it("publicKey → tx (network names, submit) → signMessage; intent errors by SEP-43 code", async () => {
    const { gw } = ctx;
    ctx.start();
    const albedo = {
      publicKey: async () => ({ pubkey: CANARY.G, signed_message: CANARY.SIGNED_MESSAGE }),
      tx: vi.fn(async (_p: { xdr: string; network?: string; submit?: boolean }) => ({
        signed_envelope_xdr: CANARY.XDR,
        tx_hash: CANARY.HASH,
      })),
      signMessage: async () => Promise.reject({ code: -4, message: CANARY.MESSAGE }),
    };
    const a = wrapAlbedo(albedo);
    await a.publicKey();
    await a.tx({ xdr: CANARY.XDR, network: "testnet" });
    await a.tx({ xdr: CANARY.XDR, network: "public", submit: true });
    await a.signMessage().catch(() => {});
    expect(albedo.tx).toHaveBeenCalledTimes(2);
    expect(await waitStellar(gw, 7)).toEqual([
      { n: "wallet_connect", wt: "albedo", net: "unknown", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "albedo", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "albedo", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "albedo", net: "mainnet", sk: "tx_submit" },
      { n: "sign_approved", wt: "albedo", net: "mainnet", sk: "tx_submit", dur: "lt5s" },
      { n: "sign_requested", wt: "albedo", net: "unknown", sk: "message" },
      {
        n: "sign_rejected",
        wt: "albedo",
        net: "unknown",
        sk: "message",
        dur: "lt5s",
        ec: "user_rejected",
      },
    ]);
    assertNoCanary(gw);
  });
});

describe("xBull", () => {
  it("injected xBullSDK: connect → signXDR; xBullWalletConnect: sign({network})", async () => {
    const { gw } = ctx;
    ctx.start();
    const sdk = {
      connect: async () => CANARY.G,
      getPublicKey: async () => CANARY.G,
      signXDR: async (_x: string, _o?: { network?: string }) => CANARY.XDR,
    };
    const x = wrapXBull(sdk);
    await x.connect();
    await x.signXDR(CANARY.XDR, { network: TESTNET });
    class XBullWalletConnect {
      #secret = CANARY.S; // private state must keep working through the wrapper
      async connect() {
        return this.#secret ? CANARY.G : "";
      }
      async sign(_p: { xdr: string; network?: string }) {
        return this.#secret ? CANARY.XDR : "";
      }
      closeConnections() {
        return this.#secret.length;
      }
    }
    const bridge = wrapXBull(new XBullWalletConnect(), { networkPassphrase: PUBLIC });
    await bridge.sign({ xdr: CANARY.XDR, network: PUBLIC });
    expect(bridge.closeConnections()).toBe(56);
    expect(await waitStellar(gw, 5)).toEqual([
      { n: "wallet_connect", wt: "xbull", net: "unknown", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "xbull", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "xbull", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "xbull", net: "mainnet", sk: "tx" },
      { n: "sign_approved", wt: "xbull", net: "mainnet", sk: "tx", dur: "lt5s" },
    ]);
    assertNoCanary(gw);
  });
});

describe("LOBSTR", () => {
  it("getPublicKey → signTransaction; no network argument → the configured or unknown network", async () => {
    const { gw } = ctx;
    ctx.start();
    const lobstr = Object.freeze({
      isConnected: async () => true,
      getPublicKey: async () => CANARY.G,
      signTransaction: async (_x: string) => CANARY.XDR,
      signMessage: async (_m: string) => ({
        signedMessage: CANARY.SIGNED_MESSAGE,
        signerAddress: CANARY.G,
      }),
    }); // like an ES module namespace: cannot be modified
    const l = wrapLobstr(lobstr, { networkPassphrase: PUBLIC });
    await l.getPublicKey();
    await l.signTransaction(CANARY.XDR);
    await l.signMessage(CANARY.MESSAGE);
    expect(await waitStellar(gw, 5)).toEqual([
      { n: "wallet_connect", wt: "lobstr", net: "mainnet", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "lobstr", net: "mainnet", sk: "tx" },
      { n: "sign_approved", wt: "lobstr", net: "mainnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "lobstr", net: "mainnet", sk: "message" },
      { n: "sign_approved", wt: "lobstr", net: "mainnet", sk: "message", dur: "lt5s" },
    ]);
    assertNoCanary(gw);
  });
});

describe("Hana", () => {
  it("getPublicKey → signTransaction({networkPassphrase}) → signAuthEntry; a thrown non-SEP-43 error", async () => {
    const { gw } = ctx;
    ctx.start();
    const hana = {
      getPublicKey: async () => CANARY.G,
      signTransaction: async (_p: object) => CANARY.XDR,
      signAuthEntry: (_p: object): Promise<string> => {
        throw new Error(CANARY.MESSAGE); // synchronous throw
      },
    };
    const h = wrapHana(hana);
    await h.getPublicKey();
    await h.signTransaction({
      xdr: CANARY.XDR,
      accountToSign: CANARY.G,
      networkPassphrase: TESTNET,
    });
    expect(() => h.signAuthEntry({ xdr: CANARY.XDR })).toThrow(CANARY.MESSAGE);
    expect(await waitStellar(gw, 5)).toEqual([
      { n: "wallet_connect", wt: "hana", net: "unknown", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "hana", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "hana", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "hana", net: "unknown", sk: "auth_entry" },
      {
        n: "sign_rejected",
        wt: "hana",
        net: "unknown",
        sk: "auth_entry",
        dur: "lt5s",
        ec: "unknown",
      },
    ]);
    assertNoCanary(gw);
  });
});

describe("HOT", () => {
  it("request(method) classified by the method name; other methods pass through untouched", async () => {
    const { gw } = ctx;
    ctx.start();
    const HOT = {
      request: vi.fn(async (method: string, _p: object) =>
        method === "stellar:getAddress" ? { address: CANARY.G } : { signedTxXdr: CANARY.XDR },
      ),
    };
    const hot = wrapHot(HOT);
    await hot.request("stellar:getAddress", {});
    await hot.request("stellar:signTransaction", { xdr: CANARY.XDR, accountToSign: CANARY.G });
    await hot.request("near:signMessage", { message: CANARY.MESSAGE });
    expect(HOT.request).toHaveBeenCalledTimes(3);
    expect(await waitStellar(gw, 3)).toEqual([
      { n: "wallet_connect", wt: "hot", net: "unknown", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "hot", net: "unknown", sk: "tx" },
      { n: "sign_approved", wt: "hot", net: "unknown", sk: "tx", dur: "lt5s" },
    ]);
    await tick();
    expect(stellarSent(gw)).toHaveLength(3);
    assertNoCanary(gw);
  });
});

describe("injected providers", () => {
  it("D'CENT is detected by its documented global; resolves {error} like Freighter", async () => {
    const { gw } = ctx;
    ctx.start();
    const provider = {
      requestAccess: async () => ({ address: CANARY.G }),
      getAddress: async () => ({ address: CANARY.G }),
      signTransaction: async (_xdr: string, _opts?: object) => ({
        signedTxXdr: "",
        error: { code: -1, message: CANARY.MESSAGE },
      }),
      getNetwork: async () => ({ network: "PUBLIC", networkPassphrase: PUBLIC }),
    };
    g.dcentStellarProvider = provider;
    g.stellar = Object.freeze({ provider: "dcent", platform: "extension" });
    expect(detectInjectedWallet(provider)).toBe("dcent");
    const d = wrapInjected(provider);
    await d.requestAccess();
    await d.getNetwork();
    await d.signTransaction(CANARY.XDR, { networkPassphrase: TESTNET });
    expect(await waitStellar(gw, 3)).toEqual([
      { n: "wallet_connect", wt: "dcent", net: "unknown", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "dcent", net: "testnet", sk: "tx" },
      { n: "sign_rejected", wt: "dcent", net: "testnet", sk: "tx", dur: "lt5s", ec: "internal" },
    ]);
    assertNoCanary(gw);
  });

  it("a provider without a documented global is injected_other; an explicit wallet name wins", () => {
    expect(detectInjectedWallet({ getAddress() {} })).toBe("injected_other");
    expect(detectInjectedWallet(undefined)).toBe("unknown");
    const sentinel = Object.freeze({ provider: "freighter", platform: "mobile" });
    g.stellar = sentinel;
    expect(detectInjectedWallet(sentinel)).toBe("freighter");
    g.hanaWallet = { stellar: {} };
    expect(detectInjectedWallet((g.hanaWallet as { stellar: object }).stellar)).toBe("hana");
  });

  it("Rabet: connect resolves {publicKey}; sign(xdr, network-name)", async () => {
    const { gw } = ctx;
    ctx.start();
    const rabet = {
      connect: async () => ({ publicKey: CANARY.G }),
      sign: async (_x: string, _n: string) => ({ xdr: CANARY.XDR }),
      disconnect: async () => {},
    };
    g.rabet = rabet;
    const r = wrapInjected(rabet);
    await r.connect();
    await r.sign(CANARY.XDR, "testnet");
    await r.disconnect();
    expect(await waitStellar(gw, 4)).toEqual([
      { n: "wallet_connect", wt: "rabet", net: "unknown", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "rabet", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "rabet", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "wallet_disconnect", wt: "rabet", net: "unknown" },
    ]);
    assertNoCanary(gw);
  });

  it("an explicit, unknown wallet name becomes unknown (never free text)", async () => {
    const { gw } = ctx;
    ctx.start();
    const p = wrapInjected({ getPublicKey: async () => CANARY.G }, { wallet: "My Cool Wallet" });
    await p.getPublicKey();
    expect(await waitStellar(gw, 1)).toEqual([
      { n: "wallet_connect", wt: "unknown", net: "unknown", ck: "new", wc: "none" },
    ]);
  });
});

describe("transaction submission", () => {
  const tx = (passphrase = TESTNET) => ({
    networkPassphrase: passphrase,
    hash: () => CANARY.HASH,
    fee: "100",
  });

  it("Horizon submitTransaction: 200 success, 400 tx_failed failed, 504 pending, other error", async () => {
    const { gw } = ctx;
    ctx.start();
    const answers: unknown[] = [
      { hash: CANARY.HASH, successful: true, envelope_xdr: CANARY.XDR },
      {
        response: {
          status: 400,
          extras: { result_codes: { transaction: "tx_failed" }, envelope_xdr: CANARY.XDR },
        },
      },
      { response: { status: 504, title: "Timeout" } },
      new TypeError("Failed to fetch"),
    ];
    let i = 0;
    const server = {
      submitTransaction(_t: unknown) {
        const a = answers[i++];
        return i === 1 ? Promise.resolve(a) : Promise.reject(a);
      },
    };
    const detach = attachHorizonServer(server, { wallet: "varial" });
    for (let n = 0; n < 4; n++)
      await server.submitTransaction(tx(n === 0 ? PUBLIC : TESTNET)).catch(() => {});
    expect(await waitStellar(gw, 4)).toEqual([
      { n: "tx_submitted", rc: "success", net: "mainnet", wt: "freighter" },
      { n: "tx_submitted", rc: "failed", net: "testnet", wt: "freighter" },
      { n: "tx_submitted", rc: "pending", net: "testnet", wt: "freighter" },
      { n: "tx_submitted", rc: "error", net: "testnet", wt: "freighter" },
    ]);
    detach();
    expect(Object.keys(server)).toEqual(["submitTransaction"]);
    assertNoCanary(gw);
  });

  it("RPC sendTransaction: ERROR, TRY_AGAIN_LATER, PENDING → app's poll SUCCESS, DUPLICATE → poll FAILED", async () => {
    const { gw } = ctx;
    ctx.start();
    const statuses = ["ERROR", "TRY_AGAIN_LATER", "PENDING", "DUPLICATE"];
    let i = 0;
    const server = {
      sendTransaction: async (_t: unknown) => ({
        status: statuses[i++],
        hash: `${CANARY.HASH.slice(0, 63)}${i}`,
        errorResult: CANARY.XDR,
        latestLedger: 1,
      }),
      getTransaction: async (h: string) => ({
        status: h.endsWith("3") ? "SUCCESS" : "FAILED",
        resultXdr: CANARY.XDR,
        envelopeXdr: CANARY.XDR,
      }),
      pollTransaction: async (h: string) => ({ status: h.endsWith("4") ? "FAILED" : "NOT_FOUND" }),
    };
    attachRpcServer(server);
    for (let n = 0; n < 4; n++) await server.sendTransaction(tx());
    await server.getTransaction(`${CANARY.HASH.slice(0, 63)}9`); // not a followed submission: ignored
    await server.getTransaction(`${CANARY.HASH.slice(0, 63)}3`);
    await server.pollTransaction(`${CANARY.HASH.slice(0, 63)}4`);
    expect(await waitStellar(gw, 4)).toEqual([
      { n: "tx_submitted", rc: "error", net: "testnet" },
      { n: "tx_submitted", rc: "try_again_later", net: "testnet" },
      { n: "tx_submitted", rc: "success", net: "testnet" },
      { n: "tx_submitted", rc: "failed", net: "testnet" },
    ]);
    assertNoCanary(gw);
  });

  it("RPC PENDING without a finished poll within the bound → pending; a thrown send → error", async () => {
    const { gw } = ctx;
    ctx.start();
    const server = {
      sendTransaction: vi
        .fn()
        .mockResolvedValueOnce({ status: "PENDING", hash: CANARY.HASH })
        .mockRejectedValueOnce(new Error(CANARY.MESSAGE)),
      getTransaction: async (_hash: string) => ({ status: "NOT_FOUND" }),
    };
    attachRpcServer(server, { networkPassphrase: PUBLIC, pollBoundMs: 30 });
    await server.sendTransaction({});
    await server.getTransaction(CANARY.HASH);
    await server.sendTransaction({}).catch(() => {});
    await until(() => stellarSent(gw).length === 2);
    expect(stellarSent(gw)).toEqual([
      { n: "tx_submitted", rc: "error", net: "mainnet" },
      { n: "tx_submitted", rc: "pending", net: "mainnet" },
    ]);
    assertNoCanary(gw);
  });
});
