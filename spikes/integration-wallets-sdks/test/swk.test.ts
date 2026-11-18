// SPDX-License-Identifier: Apache-2.0
// Real Stellar Wallets Kit 2.8.0 core (`/sdk`, Preact signals) in Node, with fake wallet modules standing in for
// browser extensions. Proves: (1) a module wrapper sees connect/sign/submit events address-free; (2) it also sees
// calls made through a method reference copied *before* instrumentation (the Scaffold Stellar `wallet.ts` pattern),
// which patching the kit's static methods (tracker 1.1.0 `attachWalletsKit`) cannot.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { withUsageMap } from "../src/swk-analytics-module.ts";
import { assertClean } from "./helpers.ts";

const { StellarWalletsKit } = await import("../vendor-swk/package/esm/sdk/mod.js");
const { KitEventType } = await import("../vendor-swk/package/esm/types/mod.js");

const G = Keypair.random().publicKey();
const XDR = `AAAAAgAAAAA${"A".repeat(120)}`;

/** A module shaped like the kit's own (class with a private field, so `this` must stay the original). */
class FakeVarial {
  #addr = G;
  moduleType = "HOT_WALLET";
  productId = "varial";
  productName = "Varial";
  productUrl = "https://example.invalid";
  productIcon = "";
  async isAvailable() {
    return true;
  }
  async getAddress() {
    return { address: this.#addr };
  }
  async signTransaction(xdr: string, _o?: unknown) {
    return { signedTxXdr: `${xdr}SIGNED`, signerAddress: this.#addr };
  }
  async signAuthEntry() {
    throw { code: -3, message: `bad entry for ${this.#addr}` };
  }
  async signMessage() {
    throw { code: -4, message: "The user rejected this request" };
  }
  async getNetwork() {
    return { network: "TESTNET", networkPassphrase: Networks.TESTNET };
  }
  async disconnect() {}
}
class FakeWalletConnect extends FakeVarial {
  override productId = "wallet_connect";
  async signAndSubmitTransaction() {
    return { status: "pending" as const };
  }
}

describe("Stellar Wallets Kit 2.8.0: analytics module wrapper", () => {
  it("captures connect / sign / reject / submit / disconnect, address-free, including pre-copied method refs", async () => {
    const earlySign = StellarWalletsKit.signTransaction; // copied at "module load", before analytics exists
    const events: [string, Record<string, string>][] = [];
    StellarWalletsKit.init({
      modules: withUsageMap([new FakeVarial(), new FakeWalletConnect()], {
        emit: (n, f) => events.push([n, f]),
        networkPassphrase: Networks.TESTNET,
      }),
      network: Networks.TESTNET,
    });
    // The kit's own events carry the address; the wrapper never subscribes to them.
    const seen: unknown[] = [];
    const off = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (e: unknown) => seen.push(e));

    StellarWalletsKit.setWallet("varial");
    await StellarWalletsKit.fetchAddress();
    await earlySign(XDR, { address: G });
    await assert.rejects(StellarWalletsKit.signMessage("hello", { address: G }));
    await assert.rejects(StellarWalletsKit.signAuthEntry(XDR));
    StellarWalletsKit.setWallet("wallet_connect");
    const r = await StellarWalletsKit.signAndSubmitTransaction(XDR);
    assert.equal(r.status, "pending", "the app still gets the wallet's result");
    await StellarWalletsKit.disconnect();
    off();

    assert.deepEqual(events, [
      ["wallet_connect", { wt: "freighter", net: "testnet", ck: "new" }],
      ["sign_requested", { wt: "freighter", net: "testnet", sk: "tx" }],
      ["sign_approved", { wt: "freighter", net: "testnet", sk: "tx", dur: "lt5s" }],
      ["sign_requested", { wt: "freighter", net: "testnet", sk: "message" }],
      ["sign_rejected", { wt: "freighter", net: "testnet", sk: "message", dur: "lt5s", ec: "user_rejected" }],
      ["sign_requested", { wt: "freighter", net: "testnet", sk: "auth_entry" }],
      ["sign_rejected", { wt: "freighter", net: "testnet", sk: "auth_entry", dur: "lt5s", ec: "invalid_request" }],
      ["sign_requested", { wt: "walletconnect", net: "testnet", sk: "tx_submit" }],
      ["sign_approved", { wt: "walletconnect", net: "testnet", sk: "tx_submit", dur: "lt5s" }],
      ["tx_submitted", { rc: "pending", net: "testnet", wt: "walletconnect" }],
      ["wallet_disconnect", { wt: "walletconnect", net: "testnet" }],
    ]);
    assertClean(JSON.stringify(events));
    assert.ok(JSON.stringify(seen).includes(G), "control: the kit's own STATE_UPDATE payload does carry the address");
  });

  it("control: tracker 1.1.0 attachWalletsKit (class patching) misses a pre-copied signTransaction reference", async () => {
    const got: [string, Record<string, string>][] = [];
    (globalThis as Record<string, unknown>).window = {
      [Symbol.for("scf.tracker")]: { stellar: (n: string, f: Record<string, string>) => (got.push([n, f]), true) },
    };
    try {
      const { attachWalletsKit } = await import("../../../tracker/dist/npm/wallets-kit.js");
      StellarWalletsKit.init({ modules: [new FakeVarial()], network: Networks.TESTNET });
      StellarWalletsKit.setWallet("varial");
      const earlySign = StellarWalletsKit.signTransaction; // copied before attach
      const detach = attachWalletsKit(StellarWalletsKit, { networkPassphrase: Networks.TESTNET });
      await earlySign(XDR, { address: G });
      const missed = got.filter(([n]) => n.startsWith("sign_")).length;
      await StellarWalletsKit.signTransaction(XDR, { address: G }); // through the patched static
      const caught = got.filter(([n]) => n.startsWith("sign_")).length - missed;
      detach();
      assert.equal(missed, 0, "the pre-copied reference bypasses the patched static method");
      assert.equal(caught, 2, "the patched static itself works (sign_requested + sign_approved)");
      assertClean(JSON.stringify(got));
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});
