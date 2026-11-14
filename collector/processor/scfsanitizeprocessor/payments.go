// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import "go.opentelemetry.io/collector/pdata/pcommon"

// Step 4c (wire-formats §f.5): agent-payment lifecycle events on a tenant's
// server (x402, MPP), emitted by @usagemap/payments-otel
// (packages/payments-otel/src/classify.ts and common.ts hold the same sets;
// TestPaymentSetsMatchPackage keeps them identical). Enabled by
// client_metric_sets: [payments] — only once the writer stores the metric.
//
//	payment.server.events  monotonic sum, int (or integral double ≤ 2^53), unit {event}
//	  marker  payment.protocol (a string)
//	  payment.protocol       ∈ x402|mpp, else _OTHER
//	  payment.stage          ∈ required|verified|settled|paid|failed|canceled, else _OTHER
//	  payment.network        ∈ stellar:pubnet|stellar:testnet|other|unknown, else unknown
//	  (an unknown protocol keeps only the three keys above)
//	  payment.scheme         (x402, when sent) ∈ exact|upto, else _OTHER
//	  payment.method         (mpp, when sent) ∈ stellar|tempo|stripe|evm, else _OTHER
//	  payment.intent         (mpp, when sent) ∈ charge|session|channel|subscription, else _OTHER
//	  payment.asset          (when sent) ∈ USDC|XLM|USD|EUR, else _OTHER
//	  payment.amount_bucket  (when sent, stage not failed/canceled) ∈ the 6 buckets, else dropped
//	  payment.reason_class   (stage failed/canceled only, default other) ∈ the 27 classes, else other
//	  error.type             (stage failed/canceled, when sent) ∈ the x402 (53) or MPP (21) set of the
//	                         protocol, else _OTHER
//
// TestClientRuleCardinalityBound computes the bound per resource and scope:
// ≈ 1.34 M attribute sets in the worst case, because reason_class and
// error.type are independent closed sets here (the package derives one from the
// other; a hostile sender need not). Genuine traffic stays far below; storage
// must apply a per-tenant series cap, as for step 4a.
// Nothing derived from an amount, address, payload, URL or error text can be
// an output value: every value is a constant of this file.
const (
	ClientSetPayments   = "payments"
	MetricPaymentEvents = "payment.server.events"

	keyPayProtocol     = "payment.protocol"
	keyPayStage        = "payment.stage"
	keyPayScheme       = "payment.scheme"
	keyPayMethod       = "payment.method"
	keyPayIntent       = "payment.intent"
	keyPayNetwork      = "payment.network"
	keyPayAsset        = "payment.asset"
	keyPayAmountBucket = "payment.amount_bucket"
	keyPayReasonClass  = "payment.reason_class"
)

var (
	payProtocols = newSet("x402", "mpp")
	payStages    = newSet("required", "verified", "settled", "paid", "failed", "canceled")
	paySchemes   = newSet("exact", "upto")
	payMethods   = newSet("stellar", "tempo", "stripe", "evm")
	payIntents   = newSet("charge", "session", "channel", "subscription")
	payNetworks  = newSet("stellar:pubnet", "stellar:testnet", "other", "unknown")
	payAssets    = newSet("USDC", "XLM", "USD", "EUR")
	payAmounts   = newSet("lt_0.001", "0.001_0.01", "0.01_0.1", "0.1_1", "1_10", "ge_10")
	payReasons   = newSet("invalid_payload", "invalid_challenge", "verification_failed", "wrong_amount", "wrong_asset",
		"wrong_recipient", "bad_signature", "expired", "replayed", "network_mismatch", "unsupported", "simulation_failed",
		"insufficient_funds", "missing_payment", "action_required", "channel_closed", "settle_failed", "settle_retryable",
		"outcome_unknown", "server_signing", "server_error", "facilitator_error", "timeout", "hook_aborted",
		"handler_failed", "preflight_failed", "other")
	payX402Errors = newSet("after_verify_aborted", "before_settle_hook_error", "before_verify_hook_error",
		"extension_echo_mismatch", "handler_failed", "handler_threw", "missing_facilitator", "missing_scheme",
		"settle_failed", "settlement_pending", "settlement_preflight_failed", "unsupported_asset_transfer_method",
		"unsupported_payment_flow",
		"invalid_exact_stellar_payload_event_missing_contract_id", "invalid_exact_stellar_payload_event_not_transfer",
		"invalid_exact_stellar_payload_event_wrong_amount", "invalid_exact_stellar_payload_event_wrong_asset",
		"invalid_exact_stellar_payload_event_wrong_from", "invalid_exact_stellar_payload_event_wrong_to",
		"invalid_exact_stellar_payload_facilitator_in_auth", "invalid_exact_stellar_payload_facilitator_is_payer",
		"invalid_exact_stellar_payload_fee_exceeds_maximum", "invalid_exact_stellar_payload_has_subinvocations",
		"invalid_exact_stellar_payload_malformed", "invalid_exact_stellar_payload_missing_payer_signature",
		"invalid_exact_stellar_payload_multiple_transfers", "invalid_exact_stellar_payload_no_auth_entries",
		"invalid_exact_stellar_payload_no_transfer_events", "invalid_exact_stellar_payload_simulation_failed",
		"invalid_exact_stellar_payload_unexpected_pending_signatures",
		"invalid_exact_stellar_payload_unsafe_tx_or_op_source",
		"invalid_exact_stellar_payload_unsupported_credential_type", "invalid_exact_stellar_payload_wrong_amount",
		"invalid_exact_stellar_payload_wrong_asset", "invalid_exact_stellar_payload_wrong_function_name",
		"invalid_exact_stellar_payload_wrong_operation", "invalid_exact_stellar_payload_wrong_recipient",
		"invalid_exact_stellar_signature_expiration_too_far", "invalid_network", "network_mismatch",
		"settle_exact_stellar_fee_bump_signing_failed", "settle_exact_stellar_signer_selection_failed",
		"settle_exact_stellar_transaction_failed", "settle_exact_stellar_transaction_signing_failed",
		"settle_exact_stellar_transaction_submission_failed", "settle_exact_stellar_transaction_submission_retryable",
		"unexpected_settle_error", "unexpected_verify_error", "unsupported_scheme", "verification_failed", "timeout",
		"facilitator_error", stellarOther)
	payMPPErrors = newSet("bad-request", "internal-payment-error", "invalid-challenge", "invalid-payload",
		"malformed-credential", "method-unsupported", "payment-action-required", "payment-expired",
		"payment-insufficient", "payment-outcome-unknown", "payment-required", "session/amount-exceeds-deposit",
		"session/channel-finalized", "session/channel-not-found", "session/delta-too-small",
		"session/insufficient-balance", "session/invalid-signature", "session/signer-mismatch", "verification-failed",
		"credential-replayed", stellarOther)
)

type paymentRule struct{}

func (paymentRule) name() string             { return MetricPaymentEvents }
func (paymentRule) unit() string             { return "{event}" }
func (paymentRule) histogram() bool          { return false }
func (paymentRule) unmarkedReason() string   { return ReasonMetricNotAllowed }
func (paymentRule) wrongShapeReason() string { return ReasonMalformedPoint }

func (paymentRule) marked(src pcommon.Map) bool {
	_, ok := strAttr(src, keyPayProtocol)
	return ok
}

func (paymentRule) attrs(src, dst pcommon.Map) {
	str := func(k string) (string, bool) { return strAttr(src, k) }
	opt := func(k string, s set) {
		if v, ok := str(k); ok {
			dst.PutStr(k, s.pick(v, stellarOther))
		}
	}
	proto, _ := str(keyPayProtocol)
	proto = payProtocols.pick(proto, stellarOther)
	dst.PutStr(keyPayProtocol, proto)
	stage, _ := str(keyPayStage)
	stage = payStages.pick(stage, stellarOther)
	dst.PutStr(keyPayStage, stage)
	net, _ := str(keyPayNetwork)
	dst.PutStr(keyPayNetwork, payNetworks.pick(net, "unknown"))
	// The protocol's own keys only (x402: scheme; MPP: method, intent); an
	// unknown protocol keeps protocol, stage and network, nothing else.
	switch proto {
	case "x402":
		opt(keyPayScheme, paySchemes)
	case "mpp":
		opt(keyPayMethod, payMethods)
		opt(keyPayIntent, payIntents)
	default:
		return
	}
	opt(keyPayAsset, payAssets)
	failed := stage == "failed" || stage == "canceled"
	if !failed {
		if v, ok := str(keyPayAmountBucket); ok {
			if b := payAmounts.pick(v, ""); b != "" {
				dst.PutStr(keyPayAmountBucket, b)
			}
		}
		return
	}
	r, _ := str(keyPayReasonClass)
	dst.PutStr(keyPayReasonClass, payReasons.pick(r, "other"))
	if v, ok := str(keyErrorType); ok {
		if proto == "x402" {
			dst.PutStr(keyErrorType, payX402Errors.pick(v, stellarOther))
		} else {
			dst.PutStr(keyErrorType, payMPPErrors.pick(v, stellarOther))
		}
	}
}
