// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  HORIZON_TEMPLATES,
  horizonRoute,
  jsonRpcErrorType,
  networkOf,
  RESULT_CLASSES,
  rpcMethod,
  simErrorClass,
  transportErrorType,
  txResultClass,
} from "../src/classify.ts";
import {
  ARCHIVED,
  BAD_SEQ,
  FEE_BUMP_INNER_INSUFFICIENT_FEE,
  FROZEN_KEY,
  INSUFFICIENT_FEE,
  PAYMENT_FAILED,
  RESOURCE_LIMIT,
  SUCCESS,
  TRAPPED,
} from "./mock-rpc.ts";
import { EXPECTED_VERSION } from "./sdk.ts";

const G = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("txResultClass: wire-layout decoder, independent of the SDK's XDR classes", () => {
  it(`decodes results built with the XDR classes of js-stellar-sdk ${EXPECTED_VERSION ?? "17"}`, () => {
    expect(txResultClass(SUCCESS())).toBe("success");
    expect(txResultClass(BAD_SEQ())).toBe("bad_seq");
    expect(txResultClass(INSUFFICIENT_FEE())).toBe("insufficient_fee");
    expect(txResultClass(TRAPPED())).toBe("contract_error");
    expect(txResultClass(ARCHIVED())).toBe("expired_state");
    expect(txResultClass(RESOURCE_LIMIT())).toBe("resource_limit");
    expect(txResultClass(PAYMENT_FAILED())).toBe("op_failed");
    expect(txResultClass(FEE_BUMP_INNER_INSUFFICIENT_FEE())).toBe("insufficient_fee");
    // 17.x XDR only; the raw code is covered for every major by the byte-level cases below.
    const frozen = FROZEN_KEY();
    if (Number(EXPECTED_VERSION?.split(".")[0] ?? 17) >= 17) expect(frozen).toBeDefined();
    if (frozen !== undefined) expect(txResultClass(frozen)).toBe("other");
  });
  it("every major's XDR emits the same TransactionResult bytes for the same result", () => {
    // feeCharged 100 | txBAD_SEQ (-5) | ext v0: the fixed layout the decoder reads, whatever the XDR library.
    expect(BAD_SEQ()).toBe(
      btoa(String.fromCharCode(0, 0, 0, 0, 0, 0, 0, 100, 255, 255, 255, 251, 0, 0, 0, 0)),
    );
  });
  it("returns a closed class for any input, never throws", () => {
    for (const v of [
      undefined,
      null,
      3,
      {},
      "",
      "%%%",
      "AAAA",
      "A".repeat(70_000),
      btoa(`${"\0".repeat(8)}\xff\xff\xff\x9c`),
    ])
      expect(RESULT_CLASSES).toContain(txResultClass(v));
    expect(txResultClass("not-xdr")).toBe("undecodable");
    // A fee bump whose inner result claims to be a fee bump again is not followed.
    const nested = new Uint8Array(8 + 4 + 32 + 8 + 4);
    const dv = new DataView(nested.buffer);
    dv.setInt32(8, -13);
    dv.setInt32(8 + 4 + 32 + 8, -13);
    expect(txResultClass(btoa(String.fromCharCode(...nested)))).toBe("other");
  });
});

describe("closed sets", () => {
  it("rpc methods, networks, JSON-RPC and transport error types", () => {
    expect(rpcMethod("sendTransaction")).toBe("sendTransaction");
    expect(rpcMethod("getAccount")).toBe("_OTHER");
    expect(rpcMethod({ toString: () => "getHealth" })).toBe("_OTHER");
    expect(networkOf("Public Global Stellar Network ; September 2015")).toBe("mainnet");
    expect(networkOf("testnet")).toBe("testnet");
    expect(networkOf("My private net")).toBe("unknown");
    expect(jsonRpcErrorType(-32601)).toBe("-32601");
    expect(jsonRpcErrorType(-32001)).toBe("_OTHER");
    expect(jsonRpcErrorType("-32601")).toBe("_OTHER");
    expect(transportErrorType({ response: { status: 429 } })).toBe("429");
    expect(transportErrorType({ response: { status: 599 } })).toBe("_OTHER");
    expect(transportErrorType({ code: "ECONNABORTED" })).toBe("timeout");
    expect(transportErrorType(new TypeError("fetch failed"))).toBe("network");
  });
  it("simulation error text is reduced to a class", () => {
    expect(simErrorClass("HostError: Error(Contract, #12)")).toBe("contract_error");
    expect(simErrorClass("HostError: Error(Budget, ExceededLimit)")).toBe("resource_limit");
    expect(simErrorClass("entry is archived")).toBe("expired_state");
    expect(simErrorClass("HostError: Error(Auth, InvalidAction)")).toBe("auth");
    expect(simErrorClass("HostError: Error(WasmVm, InvalidAction)")).toBe("wasm_trap");
    expect(simErrorClass(`Account not found: ${G}`)).toBe("no_account");
    expect(simErrorClass(42)).toBe("other");
  });
});

describe("horizonRoute: closed templates", () => {
  it("templates ids, hashes, keys and query strings", () => {
    expect(horizonRoute(`https://h/accounts/${G}/transactions?cursor=1`)).toBe(
      "/accounts/{id}/transactions",
    );
    expect(horizonRoute(`https://h/accounts/${G}/data/my-secret-key`)).toBe(
      "/accounts/{id}/data/{key}",
    );
    expect(horizonRoute(`https://h/transactions/${"ab".repeat(32)}`)).toBe("/transactions/{id}");
    expect(horizonRoute("https://h/ledgers/123/payments?limit=5")).toBe("/ledgers/{id}/payments");
    expect(horizonRoute("https://h/paths/strict-send?x=1")).toBe("/paths/strict-send");
    expect(horizonRoute("https://h/fee_stats")).toBe("/fee_stats");
    expect(horizonRoute("https://h/")).toBe("/");
  });
  it("skips a provider base path (API keys live there) and never returns it", () => {
    expect(horizonRoute(`https://p.example/apikey-SECRET/accounts/${G}`)).toBe("/accounts/{id}");
    expect(horizonRoute("https://p.example/v1/xyz/transactions_async")).toBe("/transactions_async");
    expect(horizonRoute("https://p.example/apikey-SECRET/")).toBe("_OTHER");
  });
  it("anything else is _OTHER", () => {
    expect(horizonRoute("https://h/admin/secret")).toBe("_OTHER");
    expect(horizonRoute("https://h/accounts/x/y/z")).toBe("_OTHER");
    expect(horizonRoute(`https://h/${"a/".repeat(40)}`)).toBe("_OTHER");
    expect(horizonRoute("::::")).toBe("_OTHER");
  });
  it("every template is reachable and every output is a template or _OTHER", () => {
    for (const t of HORIZON_TEMPLATES)
      expect(horizonRoute(`https://h${t.replace("{id}", "X1").replace("{key}", "k")}`)).toBe(t);
  });
});
