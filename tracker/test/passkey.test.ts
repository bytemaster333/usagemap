// SPDX-License-Identifier: Apache-2.0
// Passkey / smart-account adapters (plan B3, C-136): passkey-kit 0.20.0 and smart-account-kit 0.10.0, against
// mocks whose events carry the C-address, key ids and hashes the real kits emit. Event name only: the canary check
// proves none of it leaves the browser.

import { describe, expect, it } from "vitest";
import { attachPasskeyKit, attachPasskeyServer, attachSmartAccountKit } from "../src/passkey.ts";
import { until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";
import { assertNoCanary, CANARY, stellarSent, tick, waitStellar } from "./stellar-helpers.ts";
import { makePasskeyKit, makeSmartAccountKit, PUBLIC, reject } from "./wallet-mocks.ts";

const ctx = trackerHarness();

describe("passkey-kit", () => {
  it("create → confirm → connect → sign (approved, rejected) → disconnect; payloads never read", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makePasskeyKit();
    const detach = attachPasskeyKit(kit);
    await kit.createWallet("app", "user"); // calls this.createKey → register
    await kit.confirmWalletCreation(); // emits walletCreated
    await kit.connectWallet();
    await kit.sign(CANARY.XDR);
    kit.signBehaviour = () => Promise.reject(new DOMException(CANARY.MESSAGE, "NotAllowedError"));
    await kit.signAuthEntry(CANARY.XDR).catch(() => {});
    kit.disconnect();
    const ev = await waitStellar(gw, 10);
    expect(ev).toEqual([
      { n: "passkey_used", po: "register", net: "testnet" },
      { n: "smart_wallet_created", net: "testnet", wt: "passkey" },
      { n: "wallet_connect", wt: "passkey", net: "testnet", ck: "new", wc: "none" },
      { n: "passkey_used", po: "authenticate", net: "testnet" },
      { n: "sign_requested", wt: "passkey", net: "testnet", sk: "auth_entry" },
      { n: "sign_approved", wt: "passkey", net: "testnet", sk: "auth_entry", dur: "lt5s" },
      { n: "passkey_used", po: "sign", net: "testnet" },
      { n: "sign_requested", wt: "passkey", net: "testnet", sk: "auth_entry" },
      {
        n: "sign_rejected",
        wt: "passkey",
        net: "testnet",
        sk: "auth_entry",
        dur: "lt5s",
        ec: "unknown",
      },
      { n: "wallet_disconnect", wt: "passkey", net: "testnet" },
    ]);
    detach();
    expect(kit.events.count("walletCreated")).toBe(0);
    expect(Object.hasOwn(kit, "sign")).toBe(false);
    assertNoCanary(gw);
  });

  it("PasskeyServer.send → tx_submitted success / failed / error", async () => {
    const { gw } = ctx;
    ctx.start();
    const results: unknown[] = [
      { success: true, hash: CANARY.HASH },
      { success: false, error: { code: 3001, message: CANARY.MESSAGE }, hash: CANARY.HASH },
    ];
    let i = 0;
    const server = {
      send: (_tx: unknown) =>
        i < 2 ? Promise.resolve(results[i++]) : Promise.reject(new Error(CANARY.MESSAGE)),
    };
    attachPasskeyServer(server, { networkPassphrase: PUBLIC });
    await server.send(CANARY.XDR);
    await server.send(CANARY.XDR);
    await server.send(CANARY.XDR).catch(() => {});
    expect(await waitStellar(gw, 3)).toEqual([
      { n: "tx_submitted", rc: "success", net: "mainnet", wt: "passkey" },
      { n: "tx_submitted", rc: "failed", net: "mainnet", wt: "passkey" },
      { n: "tx_submitted", rc: "error", net: "mainnet", wt: "passkey" },
    ]);
    assertNoCanary(gw);
  });

  it("refuses an object that is not a kit", () => {
    expect(() => attachPasskeyKit({} as never)).toThrow(/PasskeyKit/);
  });
});

describe("smart-account-kit", () => {
  it("silent restore is ck=restored; prompt is new; createWallet(autoSubmit) is created + connected", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makeSmartAccountKit();
    attachSmartAccountKit(kit);
    expect(await kit.connectWallet()).toBeNull(); // no stored session: nothing
    await kit.createWallet("app", "user", { autoSubmit: true });
    await kit.disconnect();
    kit.remember();
    await kit.connectWallet(); // silent restore
    await kit.disconnect();
    await kit.connectWallet({ fresh: true });
    const ev = await waitStellar(gw, 8);
    expect(ev).toEqual([
      { n: "passkey_used", po: "register", net: "testnet" },
      { n: "wallet_connect", wt: "passkey", net: "testnet", ck: "new", wc: "none" },
      { n: "smart_wallet_created", net: "testnet", wt: "passkey" },
      { n: "wallet_disconnect", wt: "passkey", net: "testnet" },
      { n: "wallet_connect", wt: "passkey", net: "testnet", ck: "restored", wc: "none" },
      { n: "wallet_disconnect", wt: "passkey", net: "testnet" },
      { n: "wallet_connect", wt: "passkey", net: "testnet", ck: "new", wc: "none" },
      { n: "passkey_used", po: "authenticate", net: "testnet" },
    ]);
    assertNoCanary(gw);
  });

  it("createWallet without autoSubmit: registered, not created", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makeSmartAccountKit();
    attachSmartAccountKit(kit);
    await kit.createWallet("app", "user");
    await until(() => stellarSent(gw).length === 1);
    await tick();
    expect(stellarSent(gw)).toEqual([{ n: "passkey_used", po: "register", net: "testnet" }]);
  });

  it("signAndSubmit (also via transfer): a failed submission is approved + failed, not a rejection", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makeSmartAccountKit(PUBLIC);
    attachSmartAccountKit(kit);
    await kit.transfer();
    kit.submitResult = {
      success: false,
      error: { code: 4, message: CANARY.MESSAGE },
      hash: CANARY.HASH,
    };
    await kit.signAndSubmit(CANARY.XDR);
    const ev = await waitStellar(gw, 8);
    expect(ev).toEqual([
      { n: "sign_requested", wt: "passkey", net: "mainnet", sk: "tx_submit" },
      { n: "sign_approved", wt: "passkey", net: "mainnet", sk: "tx_submit", dur: "lt5s" },
      { n: "passkey_used", po: "sign", net: "mainnet" },
      { n: "tx_submitted", rc: "success", net: "mainnet", wt: "passkey" },
      { n: "sign_requested", wt: "passkey", net: "mainnet", sk: "tx_submit" },
      { n: "sign_approved", wt: "passkey", net: "mainnet", sk: "tx_submit", dur: "lt5s" },
      { n: "passkey_used", po: "sign", net: "mainnet" },
      { n: "tx_submitted", rc: "failed", net: "mainnet", wt: "passkey" },
    ]);
    assertNoCanary(gw);
  });

  it("a passkey prompt the user cancels is sign_rejected and no tx_submitted", async () => {
    const { gw } = ctx;
    ctx.start();
    const kit = makeSmartAccountKit();
    (kit as { signAndSubmit: unknown }).signAndSubmit = reject(); // WebAuthn NotAllowedError-like, no SEP-43 code
    attachSmartAccountKit(kit);
    await kit.signAndSubmit(CANARY.XDR).catch(() => {});
    const ev = await waitStellar(gw, 2);
    expect(ev).toEqual([
      { n: "sign_requested", wt: "passkey", net: "testnet", sk: "tx_submit" },
      {
        n: "sign_rejected",
        wt: "passkey",
        net: "testnet",
        sk: "tx_submit",
        dur: "lt5s",
        ec: "unknown",
      },
    ]);
    await tick();
    expect(stellarSent(gw)).toHaveLength(2);
    assertNoCanary(gw);
  });
});
