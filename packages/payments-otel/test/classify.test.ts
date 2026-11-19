// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assetOf, networkOf } from "../src/classify.ts";
import {
  amountBucket,
  MPP_ERROR_TYPES,
  mppError,
  REASON_CLASSES,
  X402_ERROR_TYPES,
  x402ReasonClass,
} from "../src/index.ts";

describe("closed sets", () => {
  it("classifies every known x402 reason into a specific class", () => {
    for (const r of X402_ERROR_TYPES) {
      if (r === "_OTHER") continue;
      const c = x402ReasonClass(r);
      expect(REASON_CLASSES).toContain(c);
      expect(c, r).not.toBe("other");
    }
  });

  it("maps x402 reasons to the expected classes", () => {
    const cases: Record<string, string> = {
      invalid_exact_stellar_payload_wrong_amount: "wrong_amount",
      invalid_exact_stellar_payload_event_wrong_amount: "wrong_amount",
      invalid_exact_stellar_payload_wrong_asset: "wrong_asset",
      invalid_exact_stellar_payload_event_wrong_to: "wrong_recipient",
      invalid_exact_stellar_payload_wrong_recipient: "wrong_recipient",
      invalid_exact_stellar_payload_missing_payer_signature: "bad_signature",
      invalid_exact_stellar_signature_expiration_too_far: "invalid_payload",
      invalid_exact_stellar_payload_simulation_failed: "simulation_failed",
      invalid_exact_stellar_payload_malformed: "invalid_payload",
      invalid_network: "network_mismatch",
      network_mismatch: "network_mismatch",
      unsupported_scheme: "unsupported",
      settle_exact_stellar_transaction_failed: "settle_failed",
      settle_exact_stellar_transaction_submission_retryable: "settle_retryable",
      settle_exact_stellar_fee_bump_signing_failed: "server_signing",
      settlement_preflight_failed: "preflight_failed",
      before_verify_hook_error: "hook_aborted",
      after_verify_aborted: "hook_aborted",
      handler_threw: "handler_failed",
      unexpected_verify_error: "facilitator_error",
      timeout: "timeout",
      // another chain's reasons still get a class
      insufficient_funds: "insufficient_funds",
      invalid_exact_evm_payload_signature: "bad_signature",
      something_new: "other",
    };
    for (const [r, c] of Object.entries(cases)) expect(x402ReasonClass(r), r).toBe(c);
    expect(x402ReasonClass(undefined)).toBe("other");
    expect(x402ReasonClass("x".repeat(500))).toBe("other");
  });

  it("maps every mppx problem type and nothing else", () => {
    for (const t of MPP_ERROR_TYPES) {
      if (t === "_OTHER" || t === "credential-replayed") continue;
      const r = mppError({ type: `https://paymentauth.org/problems/${t}`, name: "X" });
      expect(r.errorType).toBe(t);
      expect(r.reasonClass, t).not.toBe("other");
    }
    expect(
      mppError({
        type: "https://paymentauth.org/problems/verification-failed",
        name: "CredentialReplayedError",
      }),
    ).toEqual({
      errorType: "credential-replayed",
      reasonClass: "replayed",
    });
    expect(mppError({ type: "https://evil.example/problems/verification-failed" }).errorType).toBe(
      "_OTHER",
    );
    expect(
      mppError(new Error("GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3")).errorType,
    ).toBe("_OTHER");
    const hostile = Object.defineProperty({}, "type", {
      get() {
        throw new Error("boom");
      },
    });
    expect(mppError(hostile).reasonClass).toBe("other");
    expect(mppError(null).errorType).toBe("_OTHER");
  });

  it("keeps only the two public Stellar networks by name", () => {
    expect(networkOf("stellar:pubnet")).toBe("stellar:pubnet");
    expect(networkOf("STELLAR:TESTNET")).toBe("stellar:testnet");
    expect(networkOf("eip155:8453")).toBe("other");
    expect(networkOf("stellar:futurenet")).toBe("other");
    expect(networkOf(undefined)).toBe("unknown");
    expect(networkOf("")).toBe("unknown");
  });

  it("names public assets only, from verified contract ids", () => {
    expect(assetOf("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75")?.symbol).toBe(
      "USDC",
    );
    expect(assetOf("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")?.symbol).toBe(
      "USDC",
    );
    expect(assetOf("CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA")?.symbol).toBe("XLM");
    expect(assetOf("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC")?.symbol).toBe("XLM");
    expect(assetOf("native")?.symbol).toBe("XLM");
    expect(assetOf("usd")).toEqual({ symbol: "USD", decimals: undefined });
    // @stellar/mpp 0.7.1 constants.js ships a truncated (invalid) mainnet USDC id; it is not recognised
    expect(assetOf("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI")?.symbol).toBe(
      "_OTHER",
    );
    expect(assetOf("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")?.symbol).toBe("_OTHER");
    expect(assetOf(undefined)).toBeUndefined();
  });

  it("buckets amounts at decade boundaries and refuses anything that is not a plain integer", () => {
    const d = 7;
    expect(amountBucket("0", d)).toBe("lt_0.001");
    expect(amountBucket("9999", d)).toBe("lt_0.001");
    expect(amountBucket("10000", d)).toBe("0.001_0.01");
    expect(amountBucket("100000", d)).toBe("0.01_0.1");
    expect(amountBucket("1000000", d)).toBe("0.1_1");
    expect(amountBucket("10000000", d)).toBe("1_10");
    expect(amountBucket("99999999", d)).toBe("1_10");
    expect(amountBucket("100000000", d)).toBe("ge_10");
    expect(amountBucket(10n ** 30n, d)).toBe("ge_10");
    expect(amountBucket("1.5", d)).toBeUndefined();
    expect(amountBucket("-1", d)).toBeUndefined();
    expect(amountBucket(100, d)).toBeUndefined();
    expect(amountBucket("100", undefined)).toBeUndefined();
    expect(amountBucket("1".repeat(41), d)).toBeUndefined();
  });
});
