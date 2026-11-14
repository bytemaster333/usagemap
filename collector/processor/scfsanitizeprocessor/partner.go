// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import "go.opentelemetry.io/collector/pdata/pcommon"

// Step 4b (wire-formats §f.5): outbound calls of a tenant backend to SCF
// Integration List partner APIs, emitted by @usagemap/partner-otel
// (packages/partner-otel/src/partners.ts holds the same table;
// TestPartnerTableMatchesPackage keeps them identical). Enabled by
// client_metric_sets: [partner]. Outbound dependency health, never API usage.
//
//	stellar.partner.call.duration  histogram, unit s or ms (→ s)
//	  marker  stellar.partner (a string)
//	  stellar.partner            ∈ partnerOps keys, else _OTHER
//	  stellar.partner.operation  ∈ that partner's templates, else _OTHER (always _OTHER for an unknown partner)
//	  stellar.partner.outcome    ∈ partnerOutcomes, else _OTHER
//	  stellar.network            ∈ mainnet|testnet|futurenet|local|unknown, else unknown
//
// Series per resource and scope ≤ (Σ templates + partners + 1) × 9 outcomes ×
// 5 networks (TestPartnerCardinalityBound). Nothing from a URL, query, id,
// key or body can be an output value: every value is a constant of this file.
const (
	ClientSetPartner      = "partner"
	MetricPartnerDuration = "stellar.partner.call.duration"

	keyPartner          = "stellar.partner"
	keyPartnerOperation = "stellar.partner.operation"
	keyPartnerOutcome   = "stellar.partner.outcome"
)

var (
	partnerOutcomes = newSet("success", "client_error", "auth_error", "not_found", "rate_limited", "server_error",
		"timeout", "network", stellarOther)
	// partnerOps: partner id → its route templates (packages/partner-otel/src/partners.ts, sources listed there).
	partnerOps = map[string]set{
		"soroswap": newSet("/quote", "/quote/build", "/send", "/pools", "/pools/{id}/{id}", "/liquidity/add",
			"/liquidity/remove", "/liquidity/positions/{id}", "/asset-list", "/price", "/balances/{id}", "/protocols",
			"/health"),
		"defindex": newSet("/health", "/factory/address", "/factory/create-vault", "/factory/create-vault-deposit",
			"/vault/{id}", "/vault/{id}/balance", "/vault/{id}/apy", "/vault/{id}/report", "/vault/{id}/deposit",
			"/vault/{id}/withdraw", "/vault/{id}/withdraw-shares", "/vault/{id}/rebalance", "/send"),
		"trustless_work": newSet("/deployer/{type}", "/escrow/{type}/update-escrow", "/escrow/{type}/fund-escrow",
			"/escrow/{type}/approve-milestone", "/escrow/{type}/change-milestone-status", "/escrow/{type}/release-funds",
			"/escrow/{type}/resolve-dispute", "/escrow/{type}/dispute-escrow", "/helper/get-escrows-by-signer",
			"/helper/get-escrows-by-role", "/helper/get-multiple-escrow-balance", "/helper/send-transaction",
			"/indexer/update-from-txHash"),
		"stellar_broker": newSet("/quote"),
		"etherfuse": newSet("/organization", "/organization/{id}/quote", "/organization/{id}/order",
			"/organization/{id}/order/{id}", "/organization/{id}/order/{id}/cancel",
			"/organization/{id}/order/{id}/fiat_received", "/organization/{id}/payment_account",
			"/organization/{id}/payment_accounts", "/organization/{id}/kyc", "/orders", "/me", "/supported_assets"),
		"alfredpay": newSet("/customers", "/customers/{id}", "/customers/{id}/quotes", "/quotes", "/conversions",
			"/conversions/{id}", "/payouts/fiat", "/payouts/fiat/{id}", "/linked_accounts", "/balances",
			"/countries/{id}", "/countries/{id}/banks"),
		"blindpay": newSet("/quotes", "/payouts", "/payouts/{id}", "/payouts/stellar", "/payouts/stellar/authorize",
			"/payin-quotes", "/payins", "/payins/{id}", "/customers", "/customers/{id}", "/customers/{id}/bank-accounts",
			"/customers/{id}/blockchain-wallets", "/transfers", "/webhook-endpoints", "/create-asset-trustline"),
		"bridge": newSet("/customers", "/customers/{id}", "/customers/{id}/kyc_link", "/customers/tos_links",
			"/customers/{id}/external_accounts", "/customers/{id}/liquidation_addresses",
			"/customers/{id}/liquidation_addresses/{id}/drains", "/customers/{id}/virtual_accounts", "/transfers",
			"/transfers/{id}", "/wallets"),
		"mercuryo": newSet("/lib/currencies", "/widget/buy/rate", "/widget/sell/rate", "/public/rates",
			"/public/convert", "/public/currencies-buy", "/public/currency-limits", "/sdk-partner/sign-up",
			"/sdk-partner/user/sign-in", "/sdk-partner/user/kyc-status", "/sdk-partner/transactions"),
		"koywe": newSet("/auth/sign-in", "/auth/me", "/organizations/{id}", "/organizations/{id}/merchants/{id}/quotes",
			"/organizations/{id}/webhooks", "/quotes/{id}", "/orders", "/orders/{id}", "/deals", "/deals/{id}/confirm",
			"/accounts", "/contacts/{id}/accounts", "/virtual-accounts"),
		"abroad": newSet("/quote", "/quote/reverse", "/quote/onramp", "/transaction", "/transaction/{id}",
			"/transactions/list", "/kyc", "/kyc/status", "/payments/banks", "/payments/liquidity", "/payments/notify",
			"/public/corridors"),
		"allbridge": newSet("/token-info", "/chain/{id}/{id}", "/check/{id}/{id}", "/receive-fee", "/near-intents/quote",
			"/near-intents/deposit", "/near-intents/deposit/submit", "/lifi-intents/quote", "/lifi-intents/order"),
		"sodax": newSet("/swaps/quote", "/swaps/tokens", "/swaps/intents", "/swaps/intents/{id}", "/swaps/intents/submit",
			"/swaps/intents/status", "/swaps/submit-tx", "/bridge/tokens", "/bridge/fee", "/bridge/submit-tx",
			"/sponsorships/stellar/config", "/sponsorships/stellar/accounts", "/intent/{id}", "/intent/user/{id}"),
		"aquarius": newSet("/find-path", "/find-path-strict-receive", "/pools", "/pools/user/{id}", "/statistics/totals",
			"/statistics/all-time"),
	}
)

type partnerRule struct{}

func (partnerRule) name() string           { return MetricPartnerDuration }
func (partnerRule) unit() string           { return "s" }
func (partnerRule) histogram() bool        { return true }
func (partnerRule) unmarkedReason() string { return ReasonMetricNotAllowed }
func (partnerRule) wrongShapeReason() string {
	return ReasonMalformedPoint
}

func (partnerRule) marked(src pcommon.Map) bool {
	_, ok := strAttr(src, keyPartner)
	return ok
}

func (partnerRule) attrs(src, dst pcommon.Map) {
	p, _ := strAttr(src, keyPartner)
	op, _ := strAttr(src, keyPartnerOperation)
	ops, known := partnerOps[p]
	if known && len(p) <= maxStellarValueLen {
		dst.PutStr(keyPartner, p)
		dst.PutStr(keyPartnerOperation, ops.pick(op, stellarOther))
	} else {
		dst.PutStr(keyPartner, stellarOther)
		dst.PutStr(keyPartnerOperation, stellarOther)
	}
	out, _ := strAttr(src, keyPartnerOutcome)
	dst.PutStr(keyPartnerOutcome, partnerOutcomes.pick(out, stellarOther))
	net, _ := strAttr(src, keyStellarNetwork)
	dst.PutStr(keyStellarNetwork, stellarNetworks.pick(net, stellarUnknownNet))
}
