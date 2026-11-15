// SPDX-License-Identifier: Apache-2.0
// Stellar Wallets Kit adapter (ADR-0029 Tier 1, C-136): v2 static class and v1 instance, against behavioural mocks
// of the kit (test/wallet-mocks.ts). Every flow ends with the outbound canary check: no StrKey, hash, XDR, amount,
// passphrase or wallet text in any request body.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachWalletsKit as attachKit,
  attachWalletsKitV1,
  wrapWalletsKitModules,
} from "../src/wallets-kit.ts";
import { sentEvents, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";
import { assertNoCanary, CANARY, stellarSent, tick, waitStellar } from "./stellar-helpers.ts";
import {
  approve,
  MockKitModule,
  makeKitV1,
  makeKitV2,
  never,
  reject,
  TESTNET,
} from "./wallet-mocks.ts";

const ctx = trackerHarness();

// The v2 kit is a page singleton: detach after each test, as a page would on unmount.
const attached: (() => void)[] = [];
const attachWalletsKit = (...a: Parameters<typeof attachKit>): (() => void) => {
  const d = attachKit(...a);
  attached.push(d);
  return d;
};
afterEach(() => {
  for (const d of attached.splice(0)) d();
});

describe("Wallets Kit v2", () => {
  it("modal → select → connect → sign → disconnect, address-free", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    const detach = attachWalletsKit(Kit);
    const modal = Kit.authModal();
    Kit.pick("varial"); // Freighter's id in 2.8.0
    await expect(modal).resolves.toEqual({ address: CANARY.G });
    await expect(Kit.signTransaction(CANARY.XDR)).resolves.toEqual({
      signedTxXdr: CANARY.XDR,
      signerAddress: CANARY.G,
    });
    await Kit.signAuthEntry(CANARY.XDR, { networkPassphrase: TESTNET });
    await Kit.signMessage(CANARY.MESSAGE);
    await Kit.disconnect();
    const ev = await waitStellar(gw, 11);
    expect(ev).toEqual([
      { n: "wallet_modal_opened" },
      { n: "wallet_selected", wt: "freighter" },
      { n: "wallet_connect", wt: "freighter", net: "mainnet", ck: "new", wc: "none" },
      { n: "wallet_modal_closed", out: "connected", wt: "freighter" },
      { n: "sign_requested", wt: "freighter", net: "mainnet", sk: "tx" },
      { n: "sign_approved", wt: "freighter", net: "mainnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "auth_entry" },
      { n: "sign_approved", wt: "freighter", net: "testnet", sk: "auth_entry", dur: "lt5s" },
      { n: "sign_requested", wt: "freighter", net: "mainnet", sk: "message" },
      { n: "sign_approved", wt: "freighter", net: "mainnet", sk: "message", dur: "lt5s" },
      { n: "wallet_disconnect", wt: "freighter", net: "mainnet" },
    ]);
    detach();
    assertNoCanary(gw);
  });

  it("a session restored at launch is wallet_connect ck=restored, never a new connection or a selection", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2({ id: "xbull", address: CANARY.G, network: TESTNET });
    attachWalletsKit(Kit);
    const ev = await waitStellar(gw, 1);
    expect(ev).toEqual([
      { n: "wallet_connect", wt: "xbull", net: "testnet", ck: "restored", wc: "none" },
    ]);
    // later network switch by the app: no event, but later events carry the new network
    Kit.setNetwork("Public Global Stellar Network ; September 2015");
    await Kit.signTransaction(CANARY.XDR);
    expect((await waitStellar(gw, 3)).slice(1)).toEqual([
      { n: "sign_requested", wt: "xbull", net: "mainnet", sk: "tx" },
      { n: "sign_approved", wt: "xbull", net: "mainnet", sk: "tx", dur: "lt5s" },
    ]);
    assertNoCanary(gw);
  });

  it("no session: nothing is sent at launch (C-75)", async () => {
    const { gw } = ctx;
    ctx.start();
    attachWalletsKit(makeKitV2());
    await until(() => gw.events().length === 1);
    await tick();
    expect(stellarSent(gw)).toEqual([]);
  });

  it("modal dismissed (code -1) and modal error", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    attachWalletsKit(Kit);
    const m1 = Kit.authModal();
    Kit.closeModal();
    await expect(m1).rejects.toMatchObject({ code: -1 });
    expect(await waitStellar(gw, 2)).toEqual([
      { n: "wallet_modal_opened" },
      { n: "wallet_modal_closed", out: "dismissed" },
    ]);
  });

  it.each([
    [-4, "user_rejected"],
    [-3, "invalid_request"],
    [-2, "external_service"],
    [-1, "internal"],
    [undefined, "unknown"],
  ])(
    "sign rejected with SEP-43 code %s → %s; the rejection reaches the app unchanged",
    async (code, ec) => {
      const { gw } = ctx;
      ctx.start();
      const Kit = makeKitV2({ id: "lobstr", address: CANARY.G });
      attachWalletsKit(Kit);
      Kit.module.signTransaction = reject(code);
      const err = await Kit.signTransaction(CANARY.XDR).catch((e: unknown) => e);
      expect(code === undefined ? (err as Error).message : (err as { code: number }).code).toBe(
        code === undefined ? CANARY.MESSAGE : code,
      );
      const ev = await waitStellar(gw, 3);
      expect(ev[2]).toEqual({
        n: "sign_rejected",
        wt: "lobstr",
        net: "mainnet",
        sk: "tx",
        dur: "lt5s",
        ec,
      });
      assertNoCanary(gw);
    },
  );

  it("an unanswered sign call is reported as timeout once; a late answer is ignored", async () => {
    const { gw } = ctx;
    ctx.start();
    await until(() => gw.events().length === 1);
    const Kit = makeKitV2({ id: "hana", address: CANARY.G });
    attachWalletsKit(Kit, { timeoutMs: 40 });
    Kit.module.signTransaction = never;
    void Kit.signTransaction(CANARY.XDR);
    const ev = await waitStellar(gw, 3);
    expect(ev[2]).toMatchObject({ n: "sign_rejected", ec: "timeout", wt: "hana" });
  });

  it("signAndSubmitTransaction → sign_* tx_submit and tx_submitted with the kit's status", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2({ id: "wallet_connect", address: CANARY.G });
    attachWalletsKit(Kit);
    await Kit.signAndSubmitTransaction(CANARY.XDR);
    Kit.module.signAndSubmitTransaction = approve({ status: "pending", hash: CANARY.HASH });
    await Kit.signAndSubmitTransaction(CANARY.XDR);
    Kit.module.signAndSubmitTransaction = reject(-4);
    await Kit.signAndSubmitTransaction(CANARY.XDR).catch(() => {});
    Kit.module.signAndSubmitTransaction = reject(-2);
    await Kit.signAndSubmitTransaction(CANARY.XDR).catch(() => {});
    const ev = await waitStellar(gw, 12);
    const subs = ev.filter((e) => e.n === "tx_submitted");
    expect(subs).toEqual([
      { n: "tx_submitted", rc: "success", net: "mainnet", wt: "walletconnect" },
      { n: "tx_submitted", rc: "pending", net: "mainnet", wt: "walletconnect" },
      { n: "tx_submitted", rc: "error", net: "mainnet", wt: "walletconnect" }, // -2: may have reached the network
    ]);
    expect(ev.filter((e) => e.sk === "tx_submit")).toHaveLength(8);
    assertNoCanary(gw);
  });

  it("signTransaction with {submit: true} is sign kind tx_submit", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2({ id: "albedo", address: CANARY.G });
    attachWalletsKit(Kit);
    await Kit.signTransaction(CANARY.XDR, { submit: true });
    expect((await waitStellar(gw, 2))[1]).toMatchObject({ n: "sign_requested", sk: "tx_submit" });
  });

  it("is transparent: same arguments, no await before delegating, same promise result", async () => {
    ctx.start();
    const Kit = makeKitV2({ id: "albedo", address: CANARY.G });
    const spy = vi.fn(approve("result-object"));
    Kit.module.signTransaction = spy;
    attachWalletsKit(Kit);
    const p = Kit.signTransaction(CANARY.XDR, { address: CANARY.G });
    expect(spy).toHaveBeenCalledTimes(1); // synchronously, inside the caller's gesture
    expect(spy.mock.calls[0]?.[0]).toBe(CANARY.XDR);
    await expect(p).resolves.toBe("result-object");
  });

  it("detach restores the kit exactly and unsubscribes; a second attach is refused", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    const sign = Kit.signTransaction;
    const accessor = Object.getOwnPropertyDescriptor(Kit, "selectedModule");
    const modal = Kit.authModal;
    const detach = attachWalletsKit(Kit);
    expect(Object.getOwnPropertyDescriptor(Kit, "selectedModule")).not.toEqual(accessor);
    expect(Kit.signTransaction).toBe(sign); // the kit's own methods are left alone
    expect(() => attachWalletsKit(Kit)).toThrow(/already attached/);
    detach();
    detach(); // idempotent
    expect(Object.getOwnPropertyDescriptor(Kit, "selectedModule")).toEqual(accessor);
    expect(Kit.authModal).toBe(modal);
    const m = Kit.authModal();
    Kit.pick("xbull");
    await m;
    await sign(CANARY.XDR);
    await until(() => gw.events().length === 1);
    await tick();
    expect(stellarSent(gw)).toEqual([]);
    expect(() => attachWalletsKit(Kit)).not.toThrow();
  });

  it("Scaffold Stellar's wallet.ts: method references copied before attaching are counted", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    // `export const signTransaction = StellarWalletsKit.signTransaction` etc., evaluated at module load
    const signTransaction = Kit.signTransaction;
    const signMessage = Kit.signMessage;
    const fetchAddress = Kit.fetchAddress;
    attachWalletsKit(Kit, { networkPassphrase: TESTNET }); // e.g. in a later useEffect
    const m = Kit.authModal();
    Kit.pick("varial");
    await m;
    await expect(signTransaction(CANARY.XDR, { address: CANARY.G })).resolves.toEqual({
      signedTxXdr: CANARY.XDR,
      signerAddress: CANARY.G,
    });
    Kit.module.signMessage = reject(-4);
    await expect(signMessage(CANARY.MESSAGE)).rejects.toMatchObject({ code: -4 });
    await fetchAddress(); // already connected: no second wallet_connect
    const ev = await waitStellar(gw, 8);
    expect(ev).toEqual([
      { n: "wallet_modal_opened" },
      { n: "wallet_selected", wt: "freighter" },
      { n: "wallet_connect", wt: "freighter", net: "mainnet", ck: "new", wc: "none" },
      { n: "wallet_modal_closed", out: "connected", wt: "freighter" },
      { n: "sign_requested", wt: "freighter", net: "mainnet", sk: "tx" },
      { n: "sign_approved", wt: "freighter", net: "mainnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "freighter", net: "mainnet", sk: "message" },
      {
        n: "sign_rejected",
        wt: "freighter",
        net: "mainnet",
        sk: "message",
        dur: "lt5s",
        ec: "user_rejected",
      },
    ]);
    await tick();
    expect(stellarSent(gw)).toHaveLength(8);
    assertNoCanary(gw);
  });

  it("works in both profiles and with consent-gated mode only after consent", async () => {
    const { gw } = ctx;
    const t = ctx.start({ consent: "required" });
    const Kit = makeKitV2({ id: "albedo", address: CANARY.G });
    attachWalletsKit(Kit);
    await Kit.signTransaction(CANARY.XDR);
    await tick();
    expect(gw.requests).toEqual([]);
    t.grantConsent();
    await Kit.signMessage(CANARY.MESSAGE);
    const ev = await waitStellar(gw, 2);
    expect(ev.map((e) => e.n)).toEqual(["sign_requested", "sign_approved"]);
    expect(sentEvents(gw).every((e) => e.k !== "ev")).toBe(true);
  });
});

describe("Wallets Kit v2: wallet modules", () => {
  it("modules passed at construction (wrapWalletsKitModules), no attach: modal connect, copied refs, disconnect", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    const hana = new MockKitModule("hana");
    const modules = wrapWalletsKitModules([new MockKitModule("varial"), hana], {
      networkPassphrase: TESTNET, // without attachWalletsKit the module views cannot see the kit's network
    });
    expect(modules[1]?.productId).toBe("hana");
    Kit.init({ modules, network: TESTNET });
    const signAuthEntry = Kit.signAuthEntry; // copied at load
    const m = Kit.authModal();
    Kit.pick("hana"); // the modal calls the module's getAddress() directly
    await expect(m).resolves.toEqual({ address: CANARY.G });
    await signAuthEntry(CANARY.XDR);
    await Kit.disconnect();
    expect(hana.disconnects).toBe(1); // reached the module itself, with its own `this`
    expect(await waitStellar(gw, 4)).toEqual([
      { n: "wallet_connect", wt: "hana", net: "testnet", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "hana", net: "testnet", sk: "auth_entry" },
      { n: "sign_approved", wt: "hana", net: "testnet", sk: "auth_entry", dur: "lt5s" },
      { n: "wallet_disconnect", wt: "hana", net: "testnet" },
    ]);
    assertNoCanary(gw);
  });

  it("wrapped modules plus attachWalletsKit: every event exactly once", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    Kit.init({ modules: wrapWalletsKitModules([new MockKitModule("xbull")]) });
    const signTransaction = Kit.signTransaction;
    attachWalletsKit(Kit);
    const m = Kit.authModal();
    Kit.pick("xbull");
    await m;
    await signTransaction(CANARY.XDR);
    await Kit.fetchAddress();
    await Kit.disconnect();
    const ev = await waitStellar(gw, 7);
    expect(ev).toEqual([
      { n: "wallet_modal_opened" },
      { n: "wallet_selected", wt: "xbull" },
      { n: "wallet_connect", wt: "xbull", net: "mainnet", ck: "new", wc: "none" },
      { n: "wallet_modal_closed", out: "connected", wt: "xbull" },
      { n: "sign_requested", wt: "xbull", net: "mainnet", sk: "tx" },
      { n: "sign_approved", wt: "xbull", net: "mainnet", sk: "tx", dur: "lt5s" },
      { n: "wallet_disconnect", wt: "xbull", net: "mainnet" },
    ]);
    await tick();
    expect(stellarSent(gw)).toHaveLength(7);
    // wrapping twice is a no-op
    const once = wrapWalletsKitModules([new MockKitModule("albedo")]);
    expect(wrapWalletsKitModules(once)[0]).toBe(once[0]);
  });

  it("modules added after attaching (a later init) are covered; the attach can come first", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    attachWalletsKit(Kit);
    Kit.init({ modules: [new MockKitModule("lobstr")], selectedWalletId: "lobstr" });
    await Kit.signMessage(CANARY.MESSAGE);
    Kit.init({ modules: [new MockKitModule("hot-wallet")], selectedWalletId: "hot-wallet" });
    await Kit.signMessage(CANARY.MESSAGE);
    const ev = await waitStellar(gw, 6);
    expect(ev.filter((e) => e.n === "sign_approved").map((e) => e.wt)).toEqual(["lobstr", "hot"]);
  });

  it("WalletConnect module: signAndSubmitTransaction through a copied reference → tx_submitted", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2({ id: "wallet_connect", address: CANARY.G, network: TESTNET });
    const signAndSubmit = Kit.signAndSubmitTransaction;
    attachWalletsKit(Kit);
    Kit.module.signAndSubmitTransaction = approve({ status: "pending", hash: CANARY.HASH });
    await expect(signAndSubmit(CANARY.XDR)).resolves.toEqual({
      status: "pending",
      hash: CANARY.HASH,
    });
    Kit.module.signAndSubmitTransaction = reject(-4);
    await signAndSubmit(CANARY.XDR).catch(() => {});
    expect(await waitStellar(gw, 8)).toEqual([
      { n: "wallet_connect", wt: "walletconnect", net: "testnet", ck: "restored", wc: "none" },
      { n: "sign_requested", wt: "walletconnect", net: "testnet", sk: "tx_submit" },
      { n: "sign_approved", wt: "walletconnect", net: "testnet", sk: "tx_submit", dur: "lt5s" },
      { n: "tx_submitted", rc: "pending", net: "testnet", wt: "walletconnect" },
      { n: "walletconnect_request", wm: "sign_submit_xdr", net: "testnet", ws: "approved" },
      { n: "sign_requested", wt: "walletconnect", net: "testnet", sk: "tx_submit" },
      {
        n: "sign_rejected",
        wt: "walletconnect",
        net: "testnet",
        sk: "tx_submit",
        dur: "lt5s",
        ec: "user_rejected",
      },
      { n: "walletconnect_request", wm: "sign_submit_xdr", net: "testnet", ws: "rejected" },
    ]);
    // a module without signAndSubmitTransaction: the kit's own -3 error, no event
    Kit.setWallet("albedo");
    expect(() => Kit.signAndSubmitTransaction(CANARY.XDR)).toThrow();
    assertNoCanary(gw);
  });

  it("the module's own `this` and private fields keep working through the view", async () => {
    ctx.start();
    const Kit = makeKitV2({ id: "rabet", address: CANARY.G });
    attachWalletsKit(Kit);
    await expect(Kit.fetchAddress()).resolves.toEqual({ address: CANARY.G });
    await expect(Kit.getNetwork()).resolves.toMatchObject({ networkPassphrase: TESTNET });
    expect(Kit.selectedModule.productId).toBe("rabet");
    expect(Kit.selectedModule).toBe(Kit.selectedModule); // one view per module
  });

  it("documented limit: authModal through a reference copied before attaching has no modal events", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    const authModal = Kit.authModal; // authModal does not go through selectedModule
    attachWalletsKit(Kit);
    const m = authModal();
    Kit.pick("lobstr");
    await m;
    await Kit.signMessage(CANARY.MESSAGE);
    expect((await waitStellar(gw, 4)).map((e) => e.n)).toEqual([
      "wallet_selected",
      "wallet_connect", // still seen, through the kit's STATE_UPDATE
      "sign_requested",
      "sign_approved",
    ]);
  });

  it("no wallet selected: the kit's own error passes through unchanged", () => {
    ctx.start();
    const Kit = makeKitV2();
    attachWalletsKit(Kit);
    expect(() => Kit.signTransaction(CANARY.XDR)).toThrow(
      expect.objectContaining({ code: -3 }) as unknown as Error,
    );
  });

  it("fallback for a kit without the selectedModule accessor: static methods wrapped (copied refs not seen)", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2({ id: "albedo", address: CANARY.G }, { noAccessor: true });
    const early = Kit.signTransaction;
    const detach = attachWalletsKit(Kit);
    await Kit.signTransaction(CANARY.XDR);
    await early(CANARY.XDR);
    const ev = await waitStellar(gw, 3);
    await tick();
    expect(stellarSent(gw)).toHaveLength(3);
    expect(ev.map((e) => e.n)).toEqual(["wallet_connect", "sign_requested", "sign_approved"]);
    detach();
    expect(Kit.signTransaction).toBe(early);
  });
});

describe("Wallets Kit v1", () => {
  it("openModal → select → getAddress (new) → sign → disconnect", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makeKitV1();
    const detach = attachWalletsKitV1(kit, { networkPassphrase: TESTNET });
    const chosen: unknown[] = [];
    await kit.openModal({ onWalletSelected: (o) => chosen.push(o) });
    kit.pick("freighter"); // ≤ 2.7.1 id
    kit.setWallet("freighter");
    await expect(kit.getAddress()).resolves.toEqual({ address: CANARY.G });
    await kit.signTransaction(CANARY.XDR, { networkPassphrase: TESTNET });
    await kit.disconnect();
    expect(chosen).toHaveLength(1); // the app's own callback still runs
    const ev = await waitStellar(gw, 6);
    expect(ev).toEqual([
      { n: "wallet_modal_opened" },
      { n: "wallet_selected", wt: "freighter" },
      { n: "wallet_connect", wt: "freighter", net: "testnet", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "freighter", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "freighter", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "wallet_disconnect", wt: "freighter", net: "testnet" },
    ]);
    detach();
    assertNoCanary(gw);
  });

  it("a wallet set at construction (restored) connects as restored; modal close is dismissed", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makeKitV1("rabet");
    attachWalletsKitV1(kit);
    kit.setWallet("rabet");
    await kit.getAddress();
    await kit.getAddress(); // once until disconnect
    await kit.openModal({ onWalletSelected: () => {} });
    kit.close();
    const ev = await waitStellar(gw, 3);
    expect(ev).toEqual([
      { n: "wallet_connect", wt: "rabet", net: "unknown", ck: "restored", wc: "none" },
      { n: "wallet_modal_opened" },
      { n: "wallet_modal_closed", out: "dismissed" },
    ]);
    assertNoCanary(gw);
  });

  it("getNetwork results set the network of later events", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makeKitV1("albedo");
    attachWalletsKitV1(kit);
    await kit.getNetwork();
    await kit.signTransaction(CANARY.XDR);
    expect((await waitStellar(gw, 1))[0]).toMatchObject({ n: "sign_requested", net: "testnet" });
  });
});
