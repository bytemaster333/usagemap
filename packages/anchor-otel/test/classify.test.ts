// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  EVENTS,
  eventsOf,
  homeDomainOf,
  kindOf,
  lifecycleOf,
  networkOf,
  OTHER,
  outcomeOfError,
  outcomeOfStatus,
  RULES,
  STEPS,
  stepOf,
} from "../src/index.ts";
import { Registry } from "../src/registry.ts";

describe("homeDomainOf", () => {
  it.each([
    ["testanchor.stellar.org", "testanchor.stellar.org"],
    ["TestAnchor.Stellar.ORG.", "testanchor.stellar.org"],
    ["anchor.example.org:8443", "anchor.example.org"],
    ["https://api.anchor.io/sep24?token=x", "api.anchor.io"],
    ["xn--bcher-kva.example", OTHER], // reserved TLD
    ["localhost", OTHER],
    ["localhost:8000", OTHER],
    ["anchor.local", OTHER],
    ["anchor.internal", OTHER],
    ["127.0.0.1", OTHER],
    ["10.0.0.1:443", OTHER],
    ["[::1]:443", OTHER],
    ["single", OTHER],
    ["", OTHER],
    ["a..b.org", OTHER],
    ["-bad.org", OTHER],
    ["under_score.org", OTHER],
    [`${"gabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvw"}.org`, OTHER], // StrKey-like label
    [`${"a".repeat(64)}.org`, OTHER], // label > 63
    [`${"ab.".repeat(90)}org`, OTHER], // > 253
    ["user@anchor.org", OTHER],
  ])("%s → %s", (input, want) => {
    expect(homeDomainOf(input)).toBe(want);
  });
  it("rejects non-strings", () => {
    expect(homeDomainOf(undefined)).toBe(OTHER);
    expect(homeDomainOf(42)).toBe(OTHER);
  });
});

describe("outcomes", () => {
  it.each([
    [200, "ok"],
    [202, "ok"],
    [304, "ok"],
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "client_error"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
    [99, "invalid_response"],
  ])("status %i → %s", (s, want) => {
    expect(outcomeOfStatus(s)).toBe(want);
  });
  it("classifies errors without copying their text", () => {
    expect(outcomeOfError({ response: { status: 502 } })).toBe("server_error");
    expect(outcomeOfError({ code: "ECONNABORTED", message: "timeout of 5000ms exceeded" })).toBe(
      "timeout",
    );
    expect(outcomeOfError({ code: "ERR_CANCELED" })).toBe("canceled");
    expect(outcomeOfError({ code: "ENOTFOUND" })).toBe("network");
    expect(outcomeOfError({ code: "ERR_NETWORK" })).toBe("network");
    expect(outcomeOfError(Object.assign(new TypeError("fetch failed"), { cause: {} }))).toBe(
      "network",
    );
    expect(outcomeOfError({ cause: { code: "ECONNREFUSED" } })).toBe("network");
    expect(outcomeOfError(new SyntaxError("Unexpected token in TOML"))).toBe("invalid_response");
    expect(outcomeOfError("boom")).toBe("invalid_response");
  });
});

describe("steps", () => {
  it.each([
    ["10", "GET", "", "challenge"],
    ["10", "POST", "", "token"],
    ["10", "PUT", "", "other"],
    ["6", "GET", "/deposit", "deposit"],
    ["6", "GET", "/withdraw-exchange", "withdraw_exchange"],
    ["6", "GET", "/transaction", "transaction"],
    ["6", "GET", "/fee", "fee"],
    ["12", "GET", "/customer", "customer_get"],
    ["12", "PUT", "/customer", "customer_put"],
    ["12", "PUT", "/customer/callback", "customer_callback"],
    ["12", "PUT", "/customer/verification", "customer_verification"],
    ["12", "POST", "/customer/files", "customer_files"],
    ["12", "DELETE", "/customer/GABC", "customer_delete"],
    ["24", "POST", "/transactions/deposit/interactive", "deposit_interactive"],
    ["24", "POST", "/transactions/withdraw/interactive", "withdraw_interactive"],
    ["24", "GET", "/transactions", "transactions"],
    ["24", "GET", "/kyc", "other"],
    ["31", "POST", "/transactions", "transaction_create"],
    ["31", "GET", "/transactions/abc", "transaction"],
    ["31", "PATCH", "/transactions/abc", "transaction_update"],
    ["31", "PUT", "/transactions/abc/callback", "transaction_callback"],
    ["38", "GET", "/prices", "prices"],
    ["38", "post", "/quote", "quote_create"],
    ["38", "GET", "/quote/q1", "quote"],
  ] as const)("SEP-%s %s %s → %s", (sep, method, rest, want) => {
    expect(stepOf(sep, method, rest)).toBe(want);
  });
  it("every rule's step is in STEPS", () => {
    for (const rules of Object.values(RULES))
      for (const [, , step] of rules) expect(STEPS).toContain(step);
  });
});

describe("lifecycle, kind, network", () => {
  it("maps every Anchor Platform 5.x status", () => {
    // SepTransactionStatus @ stellar/anchor-platform 5.0.0 (be20b62).
    const ap = [
      "pending_anchor",
      "pending_trust",
      "pending_user",
      "pending_user_transfer_start",
      "pending_user_transfer_complete",
      "incomplete",
      "no_market",
      "too_small",
      "too_large",
      "pending_sender",
      "pending_receiver",
      "pending_transaction_info_update",
      "pending_customer_info_update",
      "completed",
      "refunded",
      "expired",
      "error",
      "pending_external",
      "pending_stellar",
      "on_hold",
    ];
    for (const s of ap) expect(lifecycleOf(s)).toBeDefined();
    expect(lifecycleOf("COMPLETED")).toBeUndefined();
    expect(lifecycleOf(undefined)).toBeUndefined();
  });
  it("folds exchange kinds", () => {
    expect(kindOf("deposit-exchange")).toBe("deposit");
    expect(kindOf("withdrawal")).toBe("withdraw");
    expect(kindOf("withdrawal-exchange")).toBe("withdraw");
    expect(kindOf("receive")).toBe("receive");
    expect(kindOf("teleport")).toBeUndefined();
  });
  it("names networks", () => {
    expect(networkOf("Test SDF Network ; September 2015")).toBe("testnet");
    expect(networkOf("Public Global Stellar Network ; September 2015")).toBe("mainnet");
    expect(networkOf("mainnet")).toBe("mainnet");
    expect(networkOf("My private net")).toBe("unknown");
    expect(networkOf(undefined)).toBe("unknown");
  });
  it("has 44 distinct funnel events", () => {
    expect(new Set(EVENTS).size).toBe(EVENTS.length);
    expect(EVENTS.length).toBe(44);
  });
});

describe("eventsOf", () => {
  const m = (sep: "6" | "10" | "12" | "24" | "31" | "38", step: (typeof STEPS)[number]) => ({
    sep,
    step,
    domain: "a.org",
  });
  it("derives funnel events from closed values only", () => {
    expect(eventsOf(m("12", "customer_get"), "ok", { status: "ACCEPTED", id: "x" })).toEqual([
      "customer_accepted",
    ]);
    expect(eventsOf(m("12", "customer_get"), "ok", { status: "Jane" })).toEqual([]);
    expect(eventsOf(m("6", "withdraw"), "forbidden", { type: "customer_info_status" })).toEqual([
      "kyc_required",
    ]);
    expect(eventsOf(m("6", "deposit_exchange"), "forbidden", { type: "other" })).toEqual([
      "deposit_request_failed",
    ]);
    expect(eventsOf(m("10", "token"), "unauthorized", undefined)).toEqual(["auth_failed"]);
    expect(eventsOf(m("38", "price"), "server_error", undefined)).toEqual([]);
    expect(eventsOf(m("31", "transaction_create"), "ok", { id: "x" })).toEqual([
      "receive_requested",
    ]);
  });
});

describe("Registry", () => {
  const toml = {
    WEB_AUTH_ENDPOINT: "https://anchor.org/auth",
    TRANSFER_SERVER: "https://anchor.org/sep6/",
    TRANSFER_SERVER_SEP0024: "https://anchor.org/sep24",
    KYC_SERVER: "https://anchor.org/sep6", // shared with SEP-6, as SEP-12 allows
    ANCHOR_QUOTE_SERVER: "https://quotes.anchor.org",
    FEDERATION_SERVER: "https://anchor.org/federation",
    SIGNING_KEY: "GABC",
  };
  it("registers the SEP servers and classifies by base and path", () => {
    const r = new Registry();
    expect(r.register("anchor.org", toml)).toBe(5);
    expect(r.match("GET", "https://anchor.org/auth?account=G")).toEqual({
      sep: "10",
      step: "challenge",
      domain: "anchor.org",
    });
    expect(r.match("GET", "https://anchor.org/sep6/customer?id=1")?.sep).toBe("12");
    expect(r.match("GET", "https://anchor.org/sep6/deposit?asset_code=X")?.step).toBe("deposit");
    expect(r.match("GET", "https://anchor.org/sep6/unknown")).toMatchObject({ step: "other" });
    expect(r.match("POST", "https://quotes.anchor.org/quote")?.step).toBe("quote_create");
    expect(r.match("GET", "https://anchor.org/sep24x/info")).toBeUndefined();
    expect(r.match("GET", "https://anchor.org/federation?q=x")).toBeUndefined();
    expect(r.match("GET", "https://elsewhere.org/sep24/info")).toBeUndefined();
    expect(r.match("GET", "not a url")).toBeUndefined();
  });
  it("accepts the Wallet SDK's TomlInfo names and replaces on re-register", () => {
    const r = new Registry();
    r.register("anchor.org", { transferServerSep24: "https://anchor.org/sep24" });
    r.register("anchor.org", { transferServerSep24: "https://anchor.org/sep24" });
    expect(r.size).toBe(1);
  });
  it("caps and allow-lists home domains", () => {
    const r = new Registry({ maxHomeDomains: 2 });
    expect(r.domain("a.org")).toBe("a.org");
    expect(r.domain("b.org")).toBe("b.org");
    expect(r.domain("c.org")).toBe(OTHER);
    expect(r.domain("a.org")).toBe("a.org");
    const allow = new Registry({ homeDomains: ["A.org"] });
    expect(allow.domain("a.org:443")).toBe("a.org");
    expect(allow.domain("b.org")).toBe(OTHER);
  });
  it("ignores non-http server URLs", () => {
    const r = new Registry();
    expect(r.register("a.org", { TRANSFER_SERVER: "ftp://a.org/x", KYC_SERVER: 5 })).toBe(0);
  });
});
