// SPDX-License-Identifier: Apache-2.0
// End to end through the real Wallet SDK 6.0.0 against an in-process anchor: every SEP step a wallet runs is timed and
// classified, funnel events are counted once, and nothing personal or secret reaches an attribute.

import { Keypair } from "@stellar/stellar-sdk";
import {
  ApplicationConfiguration,
  DefaultSigner,
  SigningKeypair,
  StellarConfiguration,
  Wallet,
} from "@stellar/typescript-wallet-sdk";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTR_HOME_DOMAIN,
  ATTR_NETWORK,
  instrumentAnchorClient,
  instrumentWalletSdk,
  METRIC_EVENTS,
  METRIC_REQUEST_DURATION,
} from "../src/index.ts";
import { assertClean, assertClosed, ev, points, req, setup, sum } from "./helpers.ts";
import { ANCHOR_HOST, type MockAnchor, startMockAnchor } from "./mock-anchor.ts";

let anchorSrv: MockAnchor;
beforeEach(async () => {
  anchorSrv = await startMockAnchor();
});
afterEach(async () => {
  await anchorSrv.close();
});

let lastClient = axios.create();
function testnetWallet() {
  // A fresh axios instance per wallet (the SDK's DefaultClient is module-wide).
  lastClient = axios.create();
  return new Wallet({
    stellarConfiguration: StellarConfiguration.TestNet(),
    applicationConfiguration: new ApplicationConfiguration(DefaultSigner, lastClient as never),
  });
}

describe("Wallet SDK 6.x", () => {
  it("records every SEP step, the funnel and the transfer lifecycle", async () => {
    const { reader, meter } = setup();
    const wallet = testnetWallet();
    const t = instrumentWalletSdk(wallet, { meter });
    expect(t.instrumented).toBe(true);

    const anchor = wallet.anchor({ homeDomain: anchorSrv.homeDomain, allowHttp: true });
    const kp = SigningKeypair.fromSecret(Keypair.random().secret());
    const auth = await anchor.sep10();
    const authToken = await auth.authenticate({ accountKp: kp });

    const sep12 = await anchor.sep12(authToken);
    await sep12.getCustomer({ type: "sep31-sender" });
    await sep12.add({
      sep9Info: { first_name: "Jane", last_name: "Doe", email_address: "example@x.org" },
    });

    const sep24 = anchor.sep24();
    const started = await sep24.deposit({ assetCode: "USDC", authToken });
    expect(started.id).toBe("tx-dep");
    await expect(sep24.withdraw({ assetCode: "USDC", authToken })).rejects.toThrow();

    // Polling: the same status twice counts once; each new lifecycle class counts once.
    await sep24.getTransactionBy({ authToken, id: "tx-dep" });
    await sep24.getTransactionBy({ authToken, id: "tx-dep" });
    anchorSrv.depositStatus = "pending_user_transfer_start";
    await sep24.getTransactionBy({ authToken, id: "tx-dep" });
    await sep24.getTransactionsForAsset({ authToken, assetCode: "USDC" });
    anchorSrv.depositStatus = "completed";
    await sep24.getTransactionBy({ authToken, id: "tx-dep" });

    const sep6 = anchor.sep6();
    const kyc = await sep6.deposit({
      authToken,
      params: { asset_code: "USDC", account: kp.publicKey },
    });
    expect((kyc as { type?: string }).type).toBe("non_interactive_customer_info_needed");
    await sep6.withdraw({ authToken, params: { asset_code: "USDC", type: "bank_account" } });

    const sep38 = anchor.sep38(authToken);
    await sep38.info();
    await sep38.prices({ sellAsset: "iso4217:USD", sellAmount: "5", sellDeliveryMethod: "ACH" });
    await expect(
      sep38.requestQuote({
        sell_asset: "iso4217:USD",
        buy_asset: "stellar:USDC",
        sell_amount: "100000",
        context: "sep6",
      } as never),
    ).rejects.toThrow();

    // A call on the same client to a URL that is not a registered anchor server is not observed.
    await expect(
      lastClient.get(`http://${ANCHOR_HOST}:1/elsewhere`, { timeout: 500 }),
    ).rejects.toThrow();

    const ps = await points(reader);
    assertClosed(ps);
    assertClean(JSON.stringify(ps.map((p) => p.attrs)));

    // Requests by step and outcome.
    expect(req(ps, "1", "toml", "ok")).toBe(1); // cached afterwards: one fetch only
    expect(req(ps, "10", "challenge", "ok")).toBe(1);
    expect(req(ps, "10", "token", "ok")).toBe(1);
    expect(req(ps, "12", "customer_get", "ok")).toBe(1);
    expect(req(ps, "12", "customer_put", "ok")).toBe(1);
    expect(req(ps, "24", "info", "ok")).toBe(1); // the SDK caches info as well
    expect(req(ps, "24", "deposit_interactive", "ok")).toBe(1);
    expect(req(ps, "24", "withdraw_interactive", "server_error")).toBe(1);
    expect(req(ps, "24", "transaction", "ok")).toBe(4);
    expect(req(ps, "24", "transactions", "ok")).toBe(1);
    expect(req(ps, "6", "deposit", "forbidden")).toBe(1);
    expect(req(ps, "6", "withdraw", "ok")).toBe(1);
    expect(req(ps, "38", "info", "ok")).toBe(1);
    expect(req(ps, "38", "prices", "ok")).toBe(1);
    expect(req(ps, "38", "quote_create", "bad_request")).toBe(1);
    expect(sum(ps, METRIC_REQUEST_DURATION)).toBe(18);

    // Funnel.
    expect(ev(ps, "toml_resolved", "1")).toBe(1);
    expect(ev(ps, "challenge_received", "10")).toBe(1);
    expect(ev(ps, "authenticated", "10")).toBe(1);
    expect(ev(ps, "customer_needs_info", "12")).toBe(1);
    expect(ev(ps, "customer_submitted", "12")).toBe(1);
    expect(ev(ps, "deposit_interactive_started", "24")).toBe(1);
    expect(ev(ps, "withdraw_request_failed", "24")).toBe(1);
    expect(ev(ps, "deposit_started", "24")).toBe(1);
    expect(ev(ps, "deposit_pending_user", "24")).toBe(1);
    expect(ev(ps, "deposit_completed", "24")).toBe(1);
    expect(ev(ps, "withdraw_failed", "24")).toBe(1);
    expect(ev(ps, "kyc_required", "6")).toBe(1);
    expect(ev(ps, "withdraw_requested", "6")).toBe(1);
    expect(ev(ps, "price_quoted", "38")).toBe(1);
    expect(ev(ps, "quote_failed", "38")).toBe(1);
    expect(sum(ps, METRIC_EVENTS)).toBe(15);

    // The anchor is named by its public home domain only (port dropped); the network comes from the wallet.
    for (const p of ps) {
      expect(p.attrs[ATTR_HOME_DOMAIN]).toBe(ANCHOR_HOST);
      expect(p.attrs[ATTR_NETWORK]).toBe("testnet");
    }

    t.detach();
    t.detach();
  });

  it("times a failed SEP-1 lookup and keeps the error for the caller", async () => {
    const { reader, meter } = setup();
    const wallet = testnetWallet();
    instrumentWalletSdk(wallet, { meter });
    const port = Number(anchorSrv.homeDomain.split(":")[1]);
    await anchorSrv.close();
    anchorSrv = await startMockAnchor(); // a different port; the old one is closed
    const anchor = wallet.anchor({ homeDomain: `${ANCHOR_HOST}:${port}`, allowHttp: true });
    await expect(anchor.sep1()).rejects.toThrow();
    const ps = await points(reader);
    expect(req(ps, "1", "toml", "network")).toBe(1);
    expect(ev(ps, "toml_failed", "1")).toBe(1);
  });

  it("is idempotent per client and detach restores the wallet", async () => {
    const { reader, meter } = setup();
    const wallet = testnetWallet();
    const ownBefore = Object.hasOwn(wallet, "anchor");
    const a = instrumentWalletSdk(wallet, { meter });
    const b = instrumentWalletSdk(wallet, { meter });
    expect(b).toBe(a);
    const anchor = wallet.anchor({ homeDomain: anchorSrv.homeDomain, allowHttp: true });
    await anchor.sep24().info();
    a.detach();
    expect(Object.hasOwn(wallet, "anchor")).toBe(ownBefore);
    expect(Object.hasOwn(anchor, "sep1")).toBe(false);
    // After detach nothing more is recorded, and the calls still work.
    await anchor.sep24().info(true);
    const ps = await points(reader);
    expect(req(ps, "24", "info")).toBe(1);
    expect(req(ps, "1", "toml")).toBe(1);
  });

  it("reports a non-public home domain as _OTHER and honours the allow-list and cap", async () => {
    const { reader, meter } = setup();
    const wallet = testnetWallet();
    instrumentWalletSdk(wallet, { meter, homeDomains: ["anchor.other.org"] });
    await wallet.anchor({ homeDomain: anchorSrv.homeDomain, allowHttp: true }).sep24().info();
    const ps = await points(reader);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) expect(p.attrs[ATTR_HOME_DOMAIN]).toBe("_OTHER");
  });
});

describe("plain axios client (SEP-31 sender, which the Wallet SDK does not implement)", () => {
  it("classifies SEP-31 calls after manual registration", async () => {
    const { reader, meter } = setup();
    const client = axios.create();
    const t = instrumentAnchorClient(client, {
      meter,
      network: "Public Global Stellar Network ; September 2015",
    });
    expect(
      t.register(anchorSrv.homeDomain, { DIRECT_PAYMENT_SERVER: `${anchorSrv.base}/sep31` }),
    ).toBe(1);
    await expect(
      client.post(`${anchorSrv.base}/sep31/transactions`, { amount: "10" }),
    ).rejects.toThrow();
    await expect(client.get(`${anchorSrv.base}/sep31/transactions/abc`)).rejects.toThrow();
    const ps = await points(reader);
    expect(req(ps, "31", "transaction_create", "not_found")).toBe(1);
    expect(req(ps, "31", "transaction", "not_found")).toBe(1);
    expect(ev(ps, "receive_request_failed", "31")).toBe(1);
    for (const p of ps) expect(p.attrs[ATTR_NETWORK]).toBe("mainnet");
    t.detach();
  });

  it("reports a client without interceptors as not instrumented", () => {
    const t = instrumentAnchorClient({});
    expect(t.instrumented).toBe(false);
    t.detach();
  });
});
