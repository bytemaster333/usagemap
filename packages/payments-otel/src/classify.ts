// SPDX-License-Identifier: Apache-2.0
// Closed attribute sets and the functions that map protocol values onto them. Every output value is a constant of
// this file, chosen by comparing the input with it: nothing derived from an address, transaction hash, amount,
// credential, URL or error text can become an attribute value. The UsageMap Collector applies the same sets again on
// ingest; keep both lists identical (collector/processor/scfsanitizeprocessor).

export const OTHER = "_OTHER";

/** `payment.protocol` */
export const PROTOCOLS = ["x402", "mpp"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/**
 * `payment.stage`
 * - `required`: a 402 challenge was issued (x402: protected request without a payment header; mpp: challenge created)
 * - `verified`: x402 facilitator verified the signed payment (not yet settled)
 * - `settled`: x402 settlement succeeded on chain (after-settle hook)
 * - `paid`: mpp payment succeeded (mppx `payment.success`: the method verified the credential; for a push or pull
 *   charge that includes the on-chain transfer, for a session it is an accepted voucher)
 * - `failed`: verification or settlement failed (`error.type` and `payment.reason_class` say why)
 * - `canceled`: x402 verified payment canceled before settlement (handler failed, hook aborted, preflight failed)
 */
export const STAGES = ["required", "verified", "settled", "paid", "failed", "canceled"] as const;
export type Stage = (typeof STAGES)[number];

/** `payment.scheme` (x402 only). */
export const X402_SCHEMES = ["exact", "upto", OTHER] as const;

/** `payment.method` (mpp only): the payment method names of mppx 0.19 and `@stellar/mpp`. */
export const MPP_METHODS = ["stellar", "tempo", "stripe", "evm", OTHER] as const;
/** `payment.intent` (mpp only). */
export const MPP_INTENTS = ["charge", "session", "channel", "subscription", OTHER] as const;

/**
 * `payment.network`: the two public Stellar networks by CAIP-2 id (as `@x402/stellar` and `@stellar/mpp` name them),
 * `other` for any other chain (EVM, Solana, Tempo, card rails), `unknown` when the event carries no network.
 */
export const NETWORKS = ["stellar:pubnet", "stellar:testnet", "other", "unknown"] as const;
export type PaymentNetwork = (typeof NETWORKS)[number];

/**
 * `payment.asset`: public asset symbols. Stellar assets are recognised by their Stellar Asset Contract id (derived
 * with js-stellar-sdk `Asset#contractId`, identical to `@x402/stellar` 2.31.0 `USDC_PUBNET_ADDRESS` /
 * `USDC_TESTNET_ADDRESS`), by `native`, or by the classic `CODE:ISSUER` form; fiat currencies by ISO 4217 code.
 */
export const ASSETS = ["USDC", "XLM", "USD", "EUR", OTHER] as const;
export type AssetSymbol = (typeof ASSETS)[number];

const SAC: Record<string, { symbol: AssetSymbol; decimals: number }> = {
  // USDC (Circle) mainnet: Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN").contractId(PUBLIC)
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: { symbol: "USDC", decimals: 7 },
  // USDC testnet: Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5").contractId(TESTNET)
  CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA: { symbol: "USDC", decimals: 7 },
  // native XLM: Asset.native().contractId(PUBLIC) and (TESTNET)
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: { symbol: "XLM", decimals: 7 },
  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC: { symbol: "XLM", decimals: 7 },
};
const CLASSIC: Record<string, { symbol: AssetSymbol; decimals: number }> = {
  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": { symbol: "USDC", decimals: 7 },
  "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5": { symbol: "USDC", decimals: 7 },
  native: { symbol: "XLM", decimals: 7 },
};
const FIAT: Record<string, AssetSymbol> = { usd: "USD", eur: "EUR" };

/**
 * `payment.amount_bucket` (opt-in): the amount in whole asset units, bucketed. Only for assets whose decimals are
 * known here (USDC and XLM on Stellar, 7 decimals); never the amount itself.
 */
export const AMOUNT_BUCKETS = [
  "lt_0.001",
  "0.001_0.01",
  "0.01_0.1",
  "0.1_1",
  "1_10",
  "ge_10",
] as const;
export type AmountBucket = (typeof AMOUNT_BUCKETS)[number];

/** `payment.reason_class` on `failed` and `canceled`: a coarse, protocol-neutral class. */
export const REASON_CLASSES = [
  "invalid_payload",
  "invalid_challenge",
  "verification_failed",
  "wrong_amount",
  "wrong_asset",
  "wrong_recipient",
  "bad_signature",
  "expired",
  "replayed",
  "network_mismatch",
  "unsupported",
  "simulation_failed",
  "insufficient_funds",
  "missing_payment",
  "action_required",
  "channel_closed",
  "settle_failed",
  "settle_retryable",
  "outcome_unknown",
  "server_signing",
  "server_error",
  "facilitator_error",
  "timeout",
  "hook_aborted",
  "handler_failed",
  "preflight_failed",
  "other",
] as const;
export type ReasonClass = (typeof REASON_CLASSES)[number];

/**
 * `error.type` for x402: the reason codes of `@x402/core` 2.31.0 and `@x402/stellar` 2.31.0 (read in their published
 * `dist/esm`), plus `timeout` and `facilitator_error` for a thrown facilitator call without a reason. Anything else
 * (another chain's scheme, a newer version) is `_OTHER`; its `payment.reason_class` is still derived.
 */
export const X402_ERROR_TYPES = [
  // @x402/core server
  "after_verify_aborted",
  "before_settle_hook_error",
  "before_verify_hook_error",
  "extension_echo_mismatch",
  "handler_failed",
  "handler_threw",
  "missing_facilitator",
  "missing_scheme",
  "settle_failed",
  "settlement_pending",
  "settlement_preflight_failed",
  "unsupported_asset_transfer_method",
  "unsupported_payment_flow",
  // @x402/stellar exact scheme (facilitator side, surfaced to the resource server)
  "invalid_exact_stellar_payload_event_missing_contract_id",
  "invalid_exact_stellar_payload_event_not_transfer",
  "invalid_exact_stellar_payload_event_wrong_amount",
  "invalid_exact_stellar_payload_event_wrong_asset",
  "invalid_exact_stellar_payload_event_wrong_from",
  "invalid_exact_stellar_payload_event_wrong_to",
  "invalid_exact_stellar_payload_facilitator_in_auth",
  "invalid_exact_stellar_payload_facilitator_is_payer",
  "invalid_exact_stellar_payload_fee_exceeds_maximum",
  "invalid_exact_stellar_payload_has_subinvocations",
  "invalid_exact_stellar_payload_malformed",
  "invalid_exact_stellar_payload_missing_payer_signature",
  "invalid_exact_stellar_payload_multiple_transfers",
  "invalid_exact_stellar_payload_no_auth_entries",
  "invalid_exact_stellar_payload_no_transfer_events",
  "invalid_exact_stellar_payload_simulation_failed",
  "invalid_exact_stellar_payload_unexpected_pending_signatures",
  "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
  "invalid_exact_stellar_payload_unsupported_credential_type",
  "invalid_exact_stellar_payload_wrong_amount",
  "invalid_exact_stellar_payload_wrong_asset",
  "invalid_exact_stellar_payload_wrong_function_name",
  "invalid_exact_stellar_payload_wrong_operation",
  "invalid_exact_stellar_payload_wrong_recipient",
  "invalid_exact_stellar_signature_expiration_too_far",
  "invalid_network",
  "network_mismatch",
  "settle_exact_stellar_fee_bump_signing_failed",
  "settle_exact_stellar_signer_selection_failed",
  "settle_exact_stellar_transaction_failed",
  "settle_exact_stellar_transaction_signing_failed",
  "settle_exact_stellar_transaction_submission_failed",
  "settle_exact_stellar_transaction_submission_retryable",
  "unexpected_settle_error",
  "unexpected_verify_error",
  "unsupported_scheme",
  "verification_failed",
  // ours, for thrown facilitator calls
  "timeout",
  "facilitator_error",
  OTHER,
] as const;

/**
 * `error.type` for mpp: the RFC 9457 problem type slug of the mppx `PaymentError` (`https://paymentauth.org/problems/
 * <slug>`, the 19 types of mppx 0.19.0 `Errors.d.ts`), `credential-replayed` for `CredentialReplayedError` (same type
 * URI as verification-failed), or `_OTHER`.
 */
export const MPP_ERROR_TYPES = [
  "bad-request",
  "internal-payment-error",
  "invalid-challenge",
  "invalid-payload",
  "malformed-credential",
  "method-unsupported",
  "payment-action-required",
  "payment-expired",
  "payment-insufficient",
  "payment-outcome-unknown",
  "payment-required",
  "session/amount-exceeds-deposit",
  "session/channel-finalized",
  "session/channel-not-found",
  "session/delta-too-small",
  "session/insufficient-balance",
  "session/invalid-signature",
  "session/signer-mismatch",
  "verification-failed",
  "credential-replayed",
  OTHER,
] as const;

const MAX_LEN = 128;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_LEN ? v : undefined;

/** Pick `v` when it is a member of `set`, else `def`. */
export function closed<T extends string>(set: readonly T[], v: unknown, def: T): T {
  const s = str(v);
  return s !== undefined && (set as readonly string[]).includes(s) ? (s as T) : def;
}

/** CAIP-2 network id (or nothing) → `payment.network`. */
export function networkOf(v: unknown): PaymentNetwork {
  const s = str(v)?.toLowerCase();
  if (s === undefined) return "unknown";
  if (s === "stellar:pubnet") return "stellar:pubnet";
  if (s === "stellar:testnet") return "stellar:testnet";
  return "other";
}

interface AssetInfo {
  readonly symbol: AssetSymbol;
  readonly decimals: number | undefined;
}
/** Asset / currency identifier → symbol and, for known Stellar assets, decimals. Undefined when absent. */
export function assetOf(v: unknown): AssetInfo | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const sac = SAC[s] ?? CLASSIC[s];
  if (sac) return sac;
  const fiat = FIAT[s.toLowerCase()];
  if (fiat) return { symbol: fiat, decimals: undefined };
  return { symbol: OTHER, decimals: undefined };
}

/** Base-unit amount string + decimals → bucket. Undefined when the amount is not a plain non-negative integer. */
export function amountBucket(
  amount: unknown,
  decimals: number | undefined,
): AmountBucket | undefined {
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 3 || decimals > 30)
    return undefined;
  const s = typeof amount === "string" ? amount : typeof amount === "bigint" ? `${amount}` : "";
  if (!/^\d{1,40}$/.test(s)) return undefined;
  const v = BigInt(s);
  const unit = 10n ** BigInt(decimals);
  // thresholds in base units: 0.001, 0.01, 0.1, 1, 10 whole units
  if (v * 1000n < unit) return "lt_0.001";
  if (v * 100n < unit) return "0.001_0.01";
  if (v * 10n < unit) return "0.01_0.1";
  if (v < unit) return "0.1_1";
  if (v < unit * 10n) return "1_10";
  return "ge_10";
}

/** x402 reason code (or thrown-error marker) → `payment.reason_class`. Order matters: specific before generic. */
export function x402ReasonClass(reason: unknown): ReasonClass {
  const r = str(reason)?.toLowerCase();
  if (r === undefined) return "other";
  const has = (...xs: string[]) => xs.some((x) => r.includes(x));
  if (r === "timeout") return "timeout";
  if (r === "facilitator_error" || has("unexpected_verify_error", "unexpected_settle_error"))
    return "facilitator_error";
  if (has("submission_retryable", "settlement_pending")) return "settle_retryable";
  if (has("signing_failed", "signer_selection")) return "server_signing";
  if (has("preflight")) return "preflight_failed";
  if (has("hook_error", "aborted")) return "hook_aborted";
  if (has("handler_threw", "handler_failed")) return "handler_failed";
  if (has("simulation_failed")) return "simulation_failed";
  if (has("insufficient")) return "insufficient_funds";
  if (has("wrong_amount")) return "wrong_amount";
  if (has("wrong_asset")) return "wrong_asset";
  if (has("wrong_to", "wrong_recipient")) return "wrong_recipient";
  if (has("expiration_too_far")) return "invalid_payload";
  if (has("expired", "expiration")) return "expired";
  if (has("signature", "no_auth_entries")) return "bad_signature";
  if (has("network_mismatch", "invalid_network")) return "network_mismatch";
  if (has("unsupported", "missing_scheme", "missing_facilitator")) return "unsupported";
  if (r.startsWith("settle")) return "settle_failed";
  if (r.startsWith("invalid_") || has("malformed", "echo_mismatch")) return "invalid_payload";
  if (has("verification_failed")) return "verification_failed";
  return "other";
}

/** x402 reason → `error.type` (closed). */
export const x402ErrorType = (reason: unknown) =>
  closed<(typeof X402_ERROR_TYPES)[number]>(X402_ERROR_TYPES, reason, OTHER);

const MPP_PROBLEM_PREFIX = "https://paymentauth.org/problems/";
const MPP_CLASS: Record<string, ReasonClass> = {
  "bad-request": "invalid_payload",
  "internal-payment-error": "server_error",
  "invalid-challenge": "invalid_challenge",
  "invalid-payload": "invalid_payload",
  "malformed-credential": "invalid_payload",
  "method-unsupported": "unsupported",
  "payment-action-required": "action_required",
  "payment-expired": "expired",
  "payment-insufficient": "wrong_amount",
  "payment-outcome-unknown": "outcome_unknown",
  "payment-required": "missing_payment",
  "session/amount-exceeds-deposit": "wrong_amount",
  "session/channel-finalized": "channel_closed",
  "session/channel-not-found": "channel_closed",
  "session/delta-too-small": "wrong_amount",
  "session/insufficient-balance": "insufficient_funds",
  "session/invalid-signature": "bad_signature",
  "session/signer-mismatch": "bad_signature",
  "verification-failed": "verification_failed",
  "credential-replayed": "replayed",
};

/** mppx `PaymentError` (structural: `type`, `name`) → `error.type` and `payment.reason_class`. */
export function mppError(err: unknown): {
  errorType: (typeof MPP_ERROR_TYPES)[number];
  reasonClass: ReasonClass;
} {
  let type: unknown;
  let name: unknown;
  try {
    if (err && typeof err === "object") {
      type = (err as { type?: unknown }).type;
      name = (err as { name?: unknown }).name;
    }
  } catch {
    /* hostile getter: unclassified */
  }
  let slug: string | undefined;
  if (name === "CredentialReplayedError") slug = "credential-replayed";
  else if (typeof type === "string" && type.startsWith(MPP_PROBLEM_PREFIX))
    slug = type.slice(MPP_PROBLEM_PREFIX.length);
  const errorType = closed<(typeof MPP_ERROR_TYPES)[number]>(MPP_ERROR_TYPES, slug, OTHER);
  return { errorType, reasonClass: MPP_CLASS[errorType] ?? "other" };
}
