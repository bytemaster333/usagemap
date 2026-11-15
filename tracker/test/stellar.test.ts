// SPDX-License-Identifier: Apache-2.0
// Stellar event schema v1 (wire-formats §a.3.1, C-136, C-137): the closed vocabulary, the mappings (wallet alias,
// passphrase → network, SEP-43 code → class, RPC/Horizon → result class), the allow-list serialiser, and the core's
// `stellar()` re-check — against the contract's JSON Schema, both profiles.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  duration,
  ENUMS,
  EVENTS,
  errorClass,
  horizonErrorClass,
  NETWORKS,
  networkOf,
  observeStellarEvents,
  PLACEMENT,
  rpcPollClass,
  rpcSendClass,
  stellarEvent,
  TIMEOUT,
  UNSUPPORTED,
  WALLET_TYPES,
  walletType,
} from "../src/stellar.ts";
import { sentEvents, setProp, until } from "./gateway.ts";
import { trackerHarness } from "./setup.ts";
import { assertNoCanary, CANARY, stellarSent, waitStellar } from "./stellar-helpers.ts";

const ctx = trackerHarness();
afterEach(() => observeStellarEvents(undefined));

const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "event-batch.schema.json"), "utf8"),
) as { $defs: { stellar: { properties: Record<string, { enum?: string[]; const?: unknown }> } } };
const props = schema.$defs.stellar.properties;

describe("vocabulary = the contract's schema (§a.3.1)", () => {
  it("event names and every closed list equal the JSON Schema enums", () => {
    expect([...EVENTS]).toEqual(props.n?.enum);
    expect([...WALLET_TYPES]).toEqual(props.wt?.enum);
    expect([...NETWORKS]).toEqual(props.net?.enum);
    for (const [k, values] of Object.entries(ENUMS)) {
      expect([...values], k).toEqual(props[k]?.enum);
    }
    expect(props.sv?.const).toBe(1);
  });

  it("places fields exactly as the §a.3.1 table", () => {
    expect(PLACEMENT).toEqual({
      wallet_modal_opened: [],
      wallet_modal_closed: ["out", "wt"],
      wallet_selected: ["wt"],
      wallet_connect: ["wt", "net", "ck", "wc"],
      wallet_disconnect: ["wt", "net"],
      sign_requested: ["wt", "net", "sk"],
      sign_approved: ["wt", "net", "sk", "dur"],
      sign_rejected: ["wt", "net", "sk", "dur", "ec"],
      tx_submitted: ["rc", "net", "wt"],
      smart_wallet_created: ["net", "wt"],
      passkey_used: ["po", "net"],
      wallet_connect_failed: ["wt", "net", "fr", "wc"],
      walletconnect_session: ["ws", "net", "wc"],
      walletconnect_request: ["wm", "net", "ws"],
    });
  });
});

describe("mappings", () => {
  it.each([
    ["varial", "freighter"], // Wallets Kit 2.8.0 id of Freighter
    ["freighter", "freighter"], // ≤ 2.7.1
    ["wallet_connect", "walletconnect"],
    ["hot-wallet", "hot"], // the kit's actual HOT id
    ["hot_wallet", "hot"],
    ["BitgetWallet", "bitget"],
    ["LEDGER", "ledger"],
    ["TREZOR", "trezor"],
    ["albedo", "albedo"],
    ["dcent", "dcent"],
    ["ghostsig", "ghostsig"],
    ["passkey", "passkey"],
    ["some-new-wallet", "unknown"],
    [CANARY.G, "unknown"],
    [undefined, "unknown"],
    [42, "unknown"],
  ])("wallet id %s → %s", (id, wt) => {
    expect(walletType(id)).toBe(wt);
  });

  it.each([
    ["Public Global Stellar Network ; September 2015", "mainnet"],
    ["Test SDF Network ; September 2015", "testnet"],
    ["Test SDF Future Network ; October 2022", "futurenet"],
    ["Standalone Network ; February 2017", "local"],
    ["PUBLIC", "mainnet"], // Freighter getNetwork().network
    ["TESTNET", "testnet"],
    ["public", "mainnet"], // Albedo
    ["My Private Network ; 2026", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
  ])("network %s → %s", (p, net) => {
    expect(networkOf(p)).toBe(net);
  });

  it.each([
    [{ code: -4, message: CANARY.MESSAGE }, "user_rejected"],
    [{ code: -3 }, "invalid_request"],
    [{ code: -2 }, "external_service"],
    [{ code: -1, ext: [CANARY.G] }, "internal"],
    [{ code: 5000, message: CANARY.MESSAGE }, "user_rejected"],
    [{ code: "exited_auth_flow" }, "user_rejected"],
    [{ code: 4001 }, "unknown"],
    [{ code: "-4" }, "unknown"],
    [new Error(CANARY.MESSAGE), "unknown"],
    [CANARY.MESSAGE, "unknown"],
    [undefined, "unknown"],
    [TIMEOUT, "timeout"],
    [UNSUPPORTED, "unsupported"],
  ])("SEP-43 error %# → %s", (e, ec) => {
    expect(errorClass(e)).toBe(ec);
  });

  it("RPC sendTransaction status → result class, DUPLICATE polled like PENDING", () => {
    expect(rpcSendClass("PENDING")).toBe("pending");
    expect(rpcSendClass("DUPLICATE")).toBe("pending");
    expect(rpcSendClass("TRY_AGAIN_LATER")).toBe("try_again_later");
    expect(rpcSendClass("ERROR")).toBe("error");
    expect(rpcSendClass(undefined)).toBe("error");
    expect(rpcPollClass("SUCCESS")).toBe("success");
    expect(rpcPollClass("FAILED")).toBe("failed");
    expect(rpcPollClass("NOT_FOUND")).toBeUndefined();
  });

  it("Horizon submit failure → result class from the problem status and result codes only", () => {
    const problem = (status: number, codes?: object) => ({
      response: { status, extras: codes && { result_codes: codes, envelope_xdr: CANARY.XDR } },
    });
    expect(horizonErrorClass(problem(504))).toBe("pending");
    expect(horizonErrorClass(problem(400, { transaction: "tx_failed" }))).toBe("failed");
    expect(
      horizonErrorClass(
        problem(400, { transaction: "tx_x", operations: ["op_success", "op_underfunded"] }),
      ),
    ).toBe("failed");
    expect(horizonErrorClass(problem(400, { transaction: "tx_bad_seq" }))).toBe("error");
    expect(horizonErrorClass({ response: { data: { status: 504 } } })).toBe("pending"); // axios-shaped
    expect(horizonErrorClass(new Error("network"))).toBe("error");
  });

  it("duration buckets", () => {
    expect(duration(0)).toBe("lt5s");
    expect(duration(4999)).toBe("lt5s");
    expect(duration(5000)).toBe("5_30s");
    expect(duration(30_000)).toBe("5_30s");
    expect(duration(30_001)).toBe("gt30s");
  });
});

describe("allow-list serialiser → core → gateway", () => {
  it("sends a schema-valid v1 event with only the fields placed on it", async () => {
    const { gw } = ctx;
    ctx.start();
    stellarEvent("sign_rejected", {
      wt: "freighter",
      net: "mainnet",
      sk: "tx",
      dur: "lt5s",
      ec: "user_rejected",
      rc: "success", // not placed on sign_rejected
      po: "sign", // not placed
    });
    stellarEvent("tx_submitted", { rc: "try_again_later", net: "testnet", wt: "freighter" });
    const ev = await waitStellar(gw, 2);
    expect(ev).toEqual([
      {
        n: "sign_rejected",
        wt: "freighter",
        net: "mainnet",
        sk: "tx",
        dur: "lt5s",
        ec: "user_rejected",
      },
      { n: "tx_submitted", rc: "try_again_later", net: "testnet", wt: "freighter" },
    ]);
    const raw = sentEvents(gw).filter((e) => e.k === "wl");
    for (const e of raw) {
      expect(e).toMatchObject({
        k: "wl",
        sv: 1,
        u: "/start",
        id: expect.stringMatching(/^[\w-]{22}$/),
      });
    }
    expect(gw.schemaErrors).toEqual([]);
  });

  it("drops values outside the closed lists (an address, a hash, an amount, free text)", async () => {
    const { gw } = ctx;
    ctx.start();
    const seen: unknown[] = [];
    observeStellarEvents((n, f) => seen.push([n, f]));
    stellarEvent("wallet_connect", {
      wt: CANARY.G as never,
      net: CANARY.PASSPHRASE as never,
      ck: "new",
    });
    stellarEvent("tx_submitted", { rc: CANARY.HASH as never, net: CANARY.AMOUNT as never });
    stellarEvent("wallet_modal_closed", { out: "dismissed", wt: "xbull" }); // wt only when connected
    const ev = await waitStellar(gw, 3);
    expect(ev).toEqual([
      { n: "wallet_connect", ck: "new", wc: "none" },
      { n: "tx_submitted" },
      { n: "wallet_modal_closed", out: "dismissed" },
    ]);
    expect(seen).toHaveLength(3);
    assertNoCanary(gw);
  });

  it("refuses unknown event names", () => {
    ctx.start();
    expect(stellarEvent("wallet_hacked" as never, {})).toBe(false);
  });

  it("sends nothing without a running tracker", () => {
    expect(stellarEvent("wallet_modal_opened")).toBe(false);
    expect(ctx.gw.requests).toEqual([]);
  });

  it("sends nothing under Global Privacy Control (Brave's default)", async () => {
    const { gw } = ctx;
    setProp(navigator, "globalPrivacyControl", true);
    ctx.start();
    stellarEvent("wallet_modal_opened");
    await new Promise((r) => setTimeout(r, 20));
    expect(gw.requests).toEqual([]);
  });

  it("sends nothing in consent-gated mode before grantConsent()", async () => {
    const { gw } = ctx;
    const t = ctx.start({ consent: "required" });
    stellarEvent("wallet_modal_opened");
    await new Promise((r) => setTimeout(r, 20));
    expect(gw.requests).toEqual([]);
    t.grantConsent();
    stellarEvent("wallet_selected", { wt: "albedo" });
    expect(await waitStellar(gw, 1)).toEqual([{ n: "wallet_selected", wt: "albedo" }]);
  });
});

describe("core stellar(): shape re-check (no StrKey, hash, amount or free text can pass)", () => {
  it.each([
    ["an address as name", CANARY.G, {}],
    ["an upper-case name", "WALLET_CONNECT", {}],
    ["a name with digits", "sign2", {}],
    ["an address value", "wallet_connect", { wt: CANARY.G }],
    ["a hash value", "tx_submitted", { rc: CANARY.HASH }],
    ["an amount value", "tx_submitted", { rc: CANARY.AMOUNT }],
    ["free text", "wallet_connect", { wt: "my wallet" }],
    ["an unknown key", "wallet_connect", { address: "x" }],
    ["an id override", "wallet_connect", { id: "x" }],
    ["a number value", "wallet_connect", { wt: 5 }],
    ["an object value", "wallet_connect", { wt: { toString: (): string => "albedo" } }],
    ["a non-string name", { toString: (): string => "wallet_connect" }, {}],
  ])("refuses %s", async (_why, name, fields) => {
    const { gw } = ctx;
    const t = ctx.start();
    expect(t.stellar(name as string, fields as Record<string, string>)).toBe(false);
    await until(() => gw.events().length === 1); // the page view only
    expect(stellarSent(gw)).toEqual([]);
  });

  it("accepts the longest enum values", async () => {
    const { gw } = ctx;
    const t = ctx.start();
    expect(t.stellar("sign_rejected", { ec: "external_service" })).toBe(true);
    expect(t.stellar("tx_submitted", { rc: "try_again_later" })).toBe(true);
    expect(t.stellar("smart_wallet_created", { wt: "injected_other" })).toBe(true);
    expect(await waitStellar(gw, 3)).toHaveLength(3);
    expect(gw.schemaErrors).toEqual([]);
  });

  it("is also reachable from the classic command queue after load (window.scf.stellar)", () => {
    const t = ctx.start();
    expect(typeof t.stellar).toBe("function");
  });
});
