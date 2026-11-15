// SPDX-License-Identifier: Apache-2.0
// Schema v1 minor additions (tracker 1.2.0): `wallet_connect_failed` with its closed
// reason enum, the wallet context `wc`, the WalletConnect funnel and the Privy adapter. Every flow ends with the
// outbound canary check (no address, hash, XDR, error text or passphrase ever leaves the browser).

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { attachPasskeyKit, attachSmartAccountKit, passkeyFailReason } from "../src/passkey.ts";
import { privyLoginCallbacks, resetPrivyState, wrapPrivyStellar } from "../src/privy.ts";
import { failReason, TIMEOUT, walletContext } from "../src/stellar.ts";
import { wrapFreighter } from "../src/wallets.ts";
import { attachWalletsKit, wrapWalletsKitModules } from "../src/wallets-kit.ts";
import { type Gateway, setProp, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";
import { assertNoCanary, CANARY, stellarSent, tick, waitStellar } from "./stellar-helpers.ts";
import {
  approve,
  MockKitModule,
  makeFreighter,
  makeKitV2,
  makePasskeyKit,
  makeSmartAccountKit,
  never,
  PUBLIC,
  reject,
  TESTNET,
} from "./wallet-mocks.ts";

const ctx = trackerHarness();

/** The `wallet_connect_failed` events once `n` were sent (or what was sent after 1.5 s). */
async function failedSent(gw: Gateway, n: number) {
  const f = () => stellarSent(gw).filter((e) => e.n === "wallet_connect_failed");
  await until(() => f().length >= n, 1500).catch(() => {});
  return f();
}

/** The Stellar events once `n` were sent (or what was sent after 1.5 s, so a diff shows what is missing). */
async function sent(gw: Gateway, n: number) {
  await until(() => stellarSent(gw).length >= n, 1500).catch(() => {});
  return stellarSent(gw);
}
const g = globalThis as Record<string, unknown>;
afterEach(() => {
  for (const k of ["stellar", "scopuly"]) delete g[k];
});

describe("failReason / passkeyFailReason (closed enum, code or DOMException name only)", () => {
  it.each([
    [TIMEOUT, undefined, "timeout"],
    [{ code: -4, message: CANARY.MESSAGE }, undefined, "user_rejected"],
    [{ code: 5000, message: "User rejected." }, undefined, "user_rejected"], // WalletConnect USER_REJECTED
    [{ code: -1 }, { installed: false }, "wallet_not_installed"],
    [{ code: -4 }, { installed: false }, "user_rejected"],
    [new Error(CANARY.MESSAGE), undefined, "error_other"],
    [{ code: -3 }, { installed: true }, "error_other"],
    [undefined, undefined, "error_other"],
  ])("%o → %s", (e, st, want) => {
    expect(failReason(e, st as never)).toBe(want);
  });
  it.each([
    [new DOMException(CANARY.MESSAGE, "NotAllowedError"), "user_rejected"],
    [new DOMException(CANARY.MESSAGE, "NotSupportedError"), "wallet_not_installed"],
    [new DOMException(CANARY.MESSAGE, "InvalidStateError"), "error_other"],
    [new Error(CANARY.MESSAGE), "error_other"],
  ])("passkey %o → %s", (e, want) => {
    expect(passkeyFailReason(e)).toBe(want);
  });
});

describe("wallet context `wc` (four documented sentinel properties only)", () => {
  it.each([
    [undefined, undefined, "none"],
    [{ provider: "freighter", platform: "mobile" }, undefined, "varial_inapp"],
    [{ provider: "varial", platform: "mobile" }, undefined, "varial_inapp"],
    [{ provider: "dcent", platform: "mobile" }, undefined, "dcent_inapp"],
    [{ provider: "lobstr", platform: "mobile" }, undefined, "other_inapp"],
    [{ provider: "freighter", platform: "extension" }, undefined, "none"],
    [{ provider: "freighter" }, undefined, "unknown"],
    [undefined, { isScopuly: true, platform: "mobile" }, "scopuly_inapp"],
    [undefined, { isScopuly: true, platform: "extension" }, "none"],
    [undefined, { isScopuly: true }, "unknown"],
  ])("window.stellar=%o window.scopuly=%o → %s", (stellar, scopuly, want) => {
    if (stellar) g.stellar = Object.freeze({ ...stellar, version: CANARY.MESSAGE });
    if (scopuly) g.scopuly = { ...scopuly, version: CANARY.MESSAGE };
    expect(walletContext()).toBe(want);
  });

  it("a throwing sentinel is unknown; the version and the User-Agent are never read", () => {
    const read: string[] = [];
    g.stellar = new Proxy(
      { provider: "freighter", platform: "mobile" },
      {
        get(t, k) {
          read.push(String(k));
          return Reflect.get(t, k);
        },
      },
    );
    expect(walletContext()).toBe("varial_inapp");
    expect(read.sort()).toEqual(["platform", "provider"]);
    Object.defineProperty(g, "stellar", {
      get() {
        throw new Error("hostile");
      },
      configurable: true,
    });
    expect(walletContext()).toBe("unknown");
    delete g.stellar;
  });

  it("is attached to wallet_connect inside an in-app browser", async () => {
    const { gw } = ctx;
    ctx.start();
    g.stellar = Object.freeze({ provider: "freighter", platform: "mobile" });
    await wrapFreighter(makeFreighter()).requestAccess();
    expect(await waitStellar(gw, 1)).toEqual([
      { n: "wallet_connect", wt: "freighter", net: "unknown", ck: "new", wc: "varial_inapp" },
    ]);
    assertNoCanary(gw);
  });
});

describe("wallet_connect_failed — Freighter wrapper", () => {
  it("rejected (-4), not installed, locked, thrown; a silent restore that finds nothing reports nothing", async () => {
    const { gw } = ctx;
    ctx.start();
    const api = makeFreighter();
    const freighter = wrapFreighter(api, { networkPassphrase: TESTNET });
    await freighter.getAddress(); // not allowed yet: restored read, no event
    setProp(api, "requestAccess", async () => ({
      address: "",
      error: { code: -4, message: CANARY.MESSAGE },
    }));
    expect(await freighter.requestAccess()).toMatchObject({ error: { code: -4 } });
    setProp(api, "requestAccess", async () => ({ address: "" })); // answered, no error, no address
    await freighter.requestAccess();
    setProp(api, "requestAccess", () => Promise.reject(new Error(CANARY.MESSAGE)));
    await expect(freighter.requestAccess()).rejects.toThrow(CANARY.MESSAGE);
    setProp(api, "isConnected", async () => ({ isConnected: false })); // extension not installed
    await freighter.isConnected();
    setProp(api, "requestAccess", async () => ({ address: "", error: { code: -1 } }));
    await freighter.requestAccess();
    expect(await waitStellar(gw, 4)).toEqual([
      {
        n: "wallet_connect_failed",
        wt: "freighter",
        net: "testnet",
        fr: "user_rejected",
        wc: "none",
      },
      {
        n: "wallet_connect_failed",
        wt: "freighter",
        net: "testnet",
        fr: "wallet_locked",
        wc: "none",
      },
      {
        n: "wallet_connect_failed",
        wt: "freighter",
        net: "testnet",
        fr: "error_other",
        wc: "none",
      },
      {
        n: "wallet_connect_failed",
        wt: "freighter",
        net: "testnet",
        fr: "wallet_not_installed",
        wc: "none",
      },
    ]);
    assertNoCanary(gw);
  });

  it("network mismatch is a failure, not a connection; the next connect on the right network counts", async () => {
    const { gw } = ctx;
    ctx.start();
    const api = makeFreighter(); // wallet reports TESTNET
    const freighter = wrapFreighter(api, { networkPassphrase: PUBLIC });
    await freighter.getNetwork();
    await freighter.requestAccess();
    setProp(api, "getNetwork", async () => ({ network: "PUBLIC", networkPassphrase: PUBLIC }));
    await freighter.getNetwork();
    await freighter.requestAccess();
    expect(await waitStellar(gw, 2)).toEqual([
      {
        n: "wallet_connect_failed",
        wt: "freighter",
        net: "mainnet",
        fr: "network_mismatch",
        wc: "none",
      },
      { n: "wallet_connect", wt: "freighter", net: "mainnet", ck: "new", wc: "none" },
    ]);
    // connected: a later failing requestAccess is not a connect failure
    setProp(api, "requestAccess", () => Promise.reject({ code: -4 }));
    await freighter.requestAccess().catch(() => {});
    await tick();
    expect(stellarSent(gw)).toHaveLength(2);
    assertNoCanary(gw);
  });

  it("an explicit connect that never answers is a timeout; a late answer is ignored", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { gw } = ctx;
    ctx.start();
    const api = makeFreighter();
    let late: (v: unknown) => void = () => {};
    setProp(api, "requestAccess", () => new Promise((r) => (late = r)));
    const freighter = wrapFreighter(api, { timeoutMs: 1000 });
    void freighter.requestAccess();
    vi.advanceTimersByTime(1001);
    late({ address: CANARY.G });
    vi.useRealTimers();
    await tick();
    expect(await waitStellar(gw, 1)).toEqual([
      { n: "wallet_connect_failed", wt: "freighter", net: "unknown", fr: "timeout", wc: "none" },
    ]);
    await tick();
    expect(stellarSent(gw)).toHaveLength(1);
  });
});

describe("wallet_connect_failed — Wallets Kit", () => {
  it("modal: a wallet error after a pick is a failure once; closing the modal before a pick is not", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    const detach = attachWalletsKit(Kit);
    onTestFinished(detach);
    const m1 = Kit.authModal();
    Kit.closeModal();
    await m1.catch(() => {});
    const m2 = Kit.authModal();
    Kit.setWallet("lobstr");
    Kit.module.getAddress = reject(-4) as never;
    Kit.pick("lobstr");
    await m2.catch(() => {});
    const m3 = Kit.authModal();
    Kit.module.getAddress = reject() as never; // kit's parseError gives an error without a code -1
    Kit.pick("lobstr");
    await m3.catch(() => {});
    expect(await failedSent(gw, 3)).toEqual([
      { n: "wallet_connect_failed", wt: "lobstr", net: "mainnet", fr: "user_rejected", wc: "none" },
      { n: "wallet_connect_failed", wt: "lobstr", net: "mainnet", fr: "error_other", wc: "none" },
    ]);
    assertNoCanary(gw);
  });

  it("wrapped modules: an unavailable module's failed getAddress is wallet_not_installed, reported once with the modal", async () => {
    const { gw } = ctx;
    ctx.start();
    const Kit = makeKitV2();
    const mod = new MockKitModule("albedo");
    mod.isAvailable = async () => false;
    mod.getAddress = reject(-1) as never;
    const [view] = wrapWalletsKitModules([mod]);
    Kit.init({ modules: [view as MockKitModule] });
    const detach = attachWalletsKit(Kit);
    onTestFinished(detach);
    await (view as MockKitModule).isAvailable();
    const m = Kit.authModal();
    Kit.pick("albedo");
    await m.catch(() => {});
    expect(await failedSent(gw, 2)).toEqual([
      {
        n: "wallet_connect_failed",
        wt: "albedo",
        net: "mainnet",
        fr: "wallet_not_installed",
        wc: "none",
      },
    ]);
    assertNoCanary(gw);
  });
});

describe("wallet_connect_failed — passkey kits", () => {
  it("passkey-kit: a cancelled WebAuthn prompt is user_rejected", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makePasskeyKit();
    kit.connectWallet = () => Promise.reject(new DOMException(CANARY.MESSAGE, "NotAllowedError"));
    attachPasskeyKit(kit);
    await kit.connectWallet().catch(() => {});
    expect(await waitStellar(gw, 1)).toEqual([
      {
        n: "wallet_connect_failed",
        wt: "passkey",
        net: "testnet",
        fr: "user_rejected",
        wc: "none",
      },
    ]);
    assertNoCanary(gw);
  });

  it("smart-account-kit: a prompted connect that fails is reported, a silent restore that fails is not", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makeSmartAccountKit();
    const fail = () => Promise.reject(new DOMException(CANARY.MESSAGE, "NotSupportedError"));
    kit.connectWallet = fail;
    attachSmartAccountKit(kit);
    await (kit.connectWallet as (o?: object) => Promise<unknown>)().catch(() => {});
    await (kit.connectWallet as (o?: object) => Promise<unknown>)({ prompt: true }).catch(() => {});
    expect(await waitStellar(gw, 1)).toEqual([
      {
        n: "wallet_connect_failed",
        wt: "passkey",
        net: "testnet",
        fr: "wallet_not_installed",
        wc: "none",
      },
    ]);
    assertNoCanary(gw);
  });
});

describe("WalletConnect funnel (kit module `wallet_connect`)", () => {
  const wcModule = (chains?: string[]) => {
    const m = new MockKitModule("wallet_connect") as MockKitModule & { wcParams?: unknown };
    m.wcParams = { projectId: CANARY.HASH, ...(chains && { allowedChains: chains }) };
    return m;
  };

  it("session proposed → approved / rejected; requests per method and chain; address-free", async () => {
    const { gw } = ctx;
    ctx.start();
    const m = wcModule(["stellar:testnet"]);
    const [wc] = wrapWalletsKitModules([m]) as [typeof m];
    await wc.getAddress();
    await wc.signTransaction(CANARY.XDR, { networkPassphrase: PUBLIC });
    await wc.signAndSubmitTransaction?.(CANARY.XDR, { networkPassphrase: TESTNET });
    await wc.signMessage(CANARY.MESSAGE, { networkPassphrase: TESTNET });
    m.signAuthEntry = reject(5000);
    await wc.signAuthEntry(CANARY.XDR, { networkPassphrase: TESTNET }).catch(() => {});
    const wcEvents = (await waitStellar(gw, 14)).filter((e) =>
      String(e.n).startsWith("walletconnect"),
    );
    expect(wcEvents).toEqual([
      { n: "walletconnect_session", ws: "proposed", net: "testnet", wc: "none" },
      { n: "walletconnect_session", ws: "approved", net: "testnet", wc: "none" },
      { n: "walletconnect_request", wm: "sign_xdr", net: "mainnet", ws: "approved" },
      { n: "walletconnect_request", wm: "sign_submit_xdr", net: "testnet", ws: "approved" },
      { n: "walletconnect_request", wm: "sign_message", net: "testnet", ws: "approved" },
      { n: "walletconnect_request", wm: "sign_auth_entry", net: "testnet", ws: "rejected" },
    ]);
    assertNoCanary(gw);
  });

  it("a rejected proposal; the default chain is pubnet; several chains are unknown", async () => {
    const { gw } = ctx;
    ctx.start();
    const a = wcModule();
    a.getAddress = reject(5000) as never;
    const b = wcModule(["stellar:pubnet", "stellar:testnet"]);
    b.getAddress = never as never;
    const [va, vb] = wrapWalletsKitModules([a, b]) as [typeof a, typeof b];
    await va.getAddress().catch(() => {});
    void vb.getAddress();
    const ev = await sent(gw, 4);
    expect(ev).toEqual([
      { n: "walletconnect_session", ws: "proposed", net: "mainnet", wc: "none" },
      {
        n: "wallet_connect_failed",
        wt: "walletconnect",
        net: "unknown",
        fr: "user_rejected",
        wc: "none",
      },
      { n: "walletconnect_session", ws: "rejected", net: "mainnet", wc: "none" },
      { n: "walletconnect_session", ws: "proposed", net: "unknown", wc: "none" },
    ]);
    assertNoCanary(gw);
  });
});

describe("Privy adapter (`@privy-io/react-auth` 3.52.0 shapes)", () => {
  beforeEach(() => resetPrivyState());
  const wallet = { id: CANARY.HASH, address: CANARY.G, chainType: "stellar" };

  it("createWallet / signRawHash for stellar only; logout; nothing else is read", async () => {
    const { gw } = ctx;
    ctx.start();
    const create = vi.fn(async (_i: { chainType: string }) => ({
      user: { email: CANARY.MESSAGE },
      wallet,
    }));
    const sign = vi.fn(async (_i: object) => ({ signature: `0x${CANARY.HASH}` }));
    const logout = vi.fn(async () => {});
    const { createWallet } = wrapPrivyStellar(
      { createWallet: create },
      { networkPassphrase: TESTNET },
    );
    const { signRawHash } = wrapPrivyStellar({ signRawHash: sign });
    await createWallet({ chainType: "solana" }); // another chain: untouched
    await expect(createWallet({ chainType: "stellar" })).resolves.toEqual({
      user: { email: CANARY.MESSAGE },
      wallet,
    });
    const input = { address: CANARY.G, chainType: "stellar", hash: `0x${CANARY.HASH}` };
    await signRawHash(input);
    expect(sign).toHaveBeenLastCalledWith(input);
    sign.mockRejectedValueOnce(new Error(CANARY.MESSAGE));
    await signRawHash(input).catch(() => {});
    await wrapPrivyStellar({ logout }).logout();
    expect(await waitStellar(gw, 6)).toEqual([
      { n: "wallet_connect", wt: "privy", net: "testnet", ck: "new", wc: "none" },
      { n: "sign_requested", wt: "privy", net: "testnet", sk: "tx" },
      { n: "sign_approved", wt: "privy", net: "testnet", sk: "tx", dur: "lt5s" },
      { n: "sign_requested", wt: "privy", net: "testnet", sk: "tx" },
      { n: "sign_rejected", wt: "privy", net: "testnet", sk: "tx", dur: "lt5s", ec: "unknown" },
      { n: "wallet_disconnect", wt: "privy", net: "testnet" },
    ]);
    assertNoCanary(gw);
  });

  it("login callbacks: a returning user with a Stellar wallet is restored; exited_auth_flow is user_rejected", async () => {
    const { gw } = ctx;
    ctx.start();
    const app = { onComplete: vi.fn(), onError: vi.fn() };
    const cb = privyLoginCallbacks(app);
    cb.onError?.("exited_auth_flow");
    cb.onError?.("unknown_auth_error");
    const params = {
      user: {
        email: { address: CANARY.MESSAGE },
        linkedAccounts: [{ type: "email" }, { ...wallet, type: "wallet" }],
      },
      isNewUser: false,
      wasAlreadyAuthenticated: true,
      loginMethod: "email",
      loginAccount: { address: CANARY.G },
    };
    cb.onComplete?.(params);
    expect(app.onComplete).toHaveBeenCalledWith(params);
    expect(app.onError).toHaveBeenCalledTimes(2);
    expect(await sent(gw, 3)).toEqual([
      { n: "wallet_connect_failed", wt: "privy", net: "unknown", fr: "user_rejected", wc: "none" },
      { n: "wallet_connect_failed", wt: "privy", net: "unknown", fr: "error_other", wc: "none" },
      { n: "wallet_connect", wt: "privy", net: "unknown", ck: "restored", wc: "none" },
    ]);
    assertNoCanary(gw);
  });

  it("a login without a Stellar wallet sends nothing; a failed createWallet is a connect failure", async () => {
    const { gw } = ctx;
    ctx.start();
    privyLoginCallbacks().onComplete?.({
      user: { linkedAccounts: [{ type: "wallet", chainType: "ethereum" }] },
      isNewUser: true,
      wasAlreadyAuthenticated: false,
      loginMethod: "email",
      loginAccount: null,
    });
    const { createWallet } = wrapPrivyStellar({
      createWallet: approve({ user: {}, wallet: { id: "x" } }),
    });
    await createWallet({ chainType: "stellar" });
    expect(await waitStellar(gw, 1)).toEqual([
      { n: "wallet_connect_failed", wt: "privy", net: "unknown", fr: "error_other", wc: "none" },
    ]);
  });
});
