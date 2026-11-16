// SPDX-License-Identifier: Apache-2.0
// The versioned route → Stellar surface mapping (src/api/stellar-surfaces.ts, stellar-surfaces/1.0.0).
import { describe, expect, it } from "vitest";
import { SURFACE_MAPPING_VERSION, surfaceOf } from "../../src/api/stellar-surfaces.ts";

describe("surfaceOf", () => {
  it.each([
    ["{unknown}", null, "placeholder", "{unknown}"],
    ["{overflow}", null, "placeholder", "{overflow}"],
    ["/rpc", "getLedgerEntries", "soroban_rpc", "getLedgerEntries"],
    ["/", "sendTransaction", "soroban_rpc", "sendTransaction"],
    ["/soroban/rpc", null, "soroban_rpc", "(method not reported)"],
    ["/.well-known/stellar.toml", null, "sep1", "/.well-known/stellar.toml"],
    ["/sep24/transactions/deposit/interactive", null, "sep24", "/transactions/deposit/interactive"],
    ["/sep-6/deposit", null, "sep6", "/deposit"],
    ["/sep31/transactions/{uuid}", null, "sep31", "/transactions/{uuid}"],
    ["/sep12/customer", null, "sep12", "/customer"],
    ["/SEP38/prices", null, "sep38", "/prices"],
    ["/sep45/auth", null, "sep_other", "/auth"],
    ["/transactions/withdraw/interactive", null, "sep24", "/transactions/withdraw/interactive"],
    ["/auth", null, "sep10", "/auth"],
    ["/customer/{id}", null, "sep12", "/customer/{id}"],
    ["/deposit-exchange", null, "sep6", "/deposit-exchange"],
    ["/quote/{uuid}", null, "sep38", "/quote/{uuid}"],
    ["/info", null, "sep_shared", "/info"],
    ["/transaction", null, "sep_shared", "/transaction"],
    ["/accounts/{account}", null, "horizon", "accounts"],
    ["/accounts/{account_id}/payments", null, "horizon", "accounts"],
    ["/transactions/{hash}", null, "horizon", "transactions"],
    ["/paths/strict-send", null, "horizon", "paths"],
    ["/", null, "horizon", "/"],
    ["/health", null, "other", "health"],
    ["/v1/users/{id}", null, "other", "v1"],
  ])("%s (method %s) → %s / %s", (route, method, surface, group) => {
    expect(surfaceOf(route, method)).toEqual({ surface, group });
  });

  it("is versioned", () => {
    expect(SURFACE_MAPPING_VERSION).toMatch(/^stellar-surfaces\/\d+\.\d+\.\d+$/);
  });
});
