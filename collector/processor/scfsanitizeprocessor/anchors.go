// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"regexp"
	"strings"

	"go.opentelemetry.io/collector/pdata/pcommon"
)

// Step 4d (wire-formats §f.5): anchor metrics, enabled by
// client_metric_sets: [anchors]. Two sources, both outbound/back-office
// aggregates of a tenant, never API usage:
//   - @usagemap/anchor-otel (a wallet's calls to anchors through the SDF
//     Wallet SDK): stellar.anchor.request.duration, stellar.anchor.events;
//   - tools/ap-listener (an anchor's own Anchor Platform event stream):
//     stellar.anchor.transfer.{created,transitions,status.duration,duration},
//     stellar.anchor.customer.updates, stellar.anchor.quotes.created.
//
// The closed sets are those of packages/anchor-otel/src/classify.ts and
// tools/ap-listener/classify.go (TestAnchorSetsMatchSources keeps them
// identical). Marker: a string stellar.network (both sources always send it).
// The two open-valued keys — stellar.anchor.home_domain and
// stellar.anchor.client — are kept only when they are a public DNS name (the
// sources' own rule: lower case, ≤ 253 bytes, ≥ 2 labels, no key-like label,
// no numeric or reserved TLD) that the Collector's sensitive-value classifier
// does not flag, or (client only) a short configured client name; else
// "_OTHER". They are business identifiers of anchors and wallets, never of
// end users; their cardinality is bounded by the sources (per-process caps)
// and, against hostile senders, by the writer's per-tenant series cap.
const (
	ClientSetAnchors = "anchors"

	MetricAnchorRequestDuration  = "stellar.anchor.request.duration"
	MetricAnchorEvents           = "stellar.anchor.events"
	MetricAnchorTransferCreated  = "stellar.anchor.transfer.created"
	MetricAnchorTransitions      = "stellar.anchor.transfer.transitions"
	MetricAnchorStatusDuration   = "stellar.anchor.transfer.status.duration"
	MetricAnchorTransferDuration = "stellar.anchor.transfer.duration"
	MetricAnchorCustomerUpdates  = "stellar.anchor.customer.updates"
	MetricAnchorQuotesCreated    = "stellar.anchor.quotes.created"

	keySep              = "stellar.sep"
	keyAnchorStep       = "stellar.anchor.step"
	keyAnchorOutcome    = "stellar.anchor.outcome"
	keyAnchorHomeDomain = "stellar.anchor.home_domain"
	keyAnchorEvent      = "stellar.anchor.event"
	keyAnchorKind       = "stellar.anchor.kind"
	keyAnchorStatus     = "stellar.anchor.status"
	keyAnchorStatusFrom = "stellar.anchor.status_from"
	keyAnchorClient     = "stellar.anchor.client"
	anchorNone          = "_none"
	maxDomainLen        = 253
)

var (
	anchorSeps     = newSet("1", "6", "10", "12", "24", "31", "38")
	anchorTxSeps   = newSet("6", "24", "31")
	anchorSteps    = newSet("toml", "challenge", "token", "info", "fee", "deposit", "withdraw", "deposit_exchange", "withdraw_exchange", "transactions", "transaction", "customer_get", "customer_put", "customer_delete", "customer_callback", "customer_verification", "customer_files", "deposit_interactive", "withdraw_interactive", "transaction_create", "transaction_update", "transaction_callback", "prices", "price", "quote_create", "quote", "other")
	anchorOutcomes = newSet("ok", "bad_request", "unauthorized", "forbidden", "not_found", "rate_limited", "client_error", "server_error", "timeout", "network", "canceled", "invalid_response")
	anchorEvents   = func() set {
		s := newSet("toml_resolved", "toml_failed", "challenge_received", "authenticated", "auth_failed",
			"customer_needs_info", "customer_processing", "customer_accepted", "customer_rejected", "customer_submitted",
			"customer_deleted", "kyc_required", "deposit_requested", "withdraw_requested", "deposit_interactive_started",
			"withdraw_interactive_started", "deposit_request_failed", "withdraw_request_failed", "receive_requested",
			"receive_request_failed", "price_quoted", "quote_created", "quote_failed")
		for _, k := range []string{"deposit", "withdraw", "receive"} {
			for _, l := range []string{"started", "pending_user", "pending_anchor", "completed", "refunded", "expired", "failed"} {
				s[k+"_"+l] = struct{}{}
			}
		}
		return s
	}()
	anchorKinds    = newSet("deposit", "deposit-exchange", "withdrawal", "withdrawal-exchange", "receive")
	anchorStatuses = newSet("pending_anchor", "pending_trust", "pending_user", "pending_user_transfer_start",
		"pending_user_transfer_complete", "incomplete", "no_market", "too_small", "too_large", "pending_sender",
		"pending_receiver", "pending_transaction_info_update", "pending_customer_info_update", "completed", "refunded",
		"expired", "error", "pending_external", "pending_stellar", "on_hold")
	anchorStatusFrom    = func() set { s := newSet("_new", "_unknown"); mergeSet(s, anchorStatuses); return s }()
	anchorCustomerState = newSet("NEEDS_INFO", "ACCEPTED", "PROCESSING", "REJECTED")

	domainLabelRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	secretishRE   = regexp.MustCompile(`^(?:[a-z2-7]{52,}|[0-9a-f]{32,})$`)
	clientNameRE  = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)
	strkeyRE      = regexp.MustCompile(`(?i)[gcmsb][a-z2-7]{55}`)
	nonPublicTLD  = newSet("localhost", "local", "internal", "test", "example", "invalid", "lan", "home", "corp",
		"onion", "arpa")
)

func mergeSet(dst, src set) {
	for k := range src {
		dst[k] = struct{}{}
	}
}

// publicDomain returns v when it already is a lower-case public DNS name
// (nothing is normalised: the sources normalise; a value needing it is not
// theirs) that the sensitive-value classifier does not flag, else "".
func publicDomain(v string) string {
	if v == "" || len(v) > maxDomainLen || v != strings.ToLower(v) {
		return ""
	}
	labels := strings.Split(v, ".")
	if len(labels) < 2 {
		return ""
	}
	for _, l := range labels {
		if !domainLabelRE.MatchString(l) || secretishRE.MatchString(l) {
			return ""
		}
	}
	tld := labels[len(labels)-1]
	if _, reserved := nonPublicTLD[tld]; reserved || strings.Trim(tld, "0123456789") == "" || sensitiveValue(v) {
		return ""
	}
	return v
}

// anchorClient: a public domain, a configured client name (not key-like), or "_none".
func anchorClient(v string) string {
	if v == anchorNone {
		return anchorNone
	}
	if d := publicDomain(v); d != "" {
		return d
	}
	if clientNameRE.MatchString(v) && !strkeyRE.MatchString(v) && !secretishRE.MatchString(v) && !sensitiveValue(v) {
		return v
	}
	return stellarOther
}

// attrSpec rebuilds one output key. out returns the value to write and
// whether to write it; present tells whether the input carried a string.
type attrSpec struct {
	key string
	out func(v string, present bool) (string, bool)
}

// required: always written; v from s, else def.
func required(key string, s set, def string) attrSpec {
	return attrSpec{key, func(v string, _ bool) (string, bool) { return s.pick(v, def), true }}
}

// optional: written only when sent; v from s, else def.
func optional(key string, s set, def string) attrSpec {
	return attrSpec{key, func(v string, ok bool) (string, bool) { return s.pick(v, def), ok }}
}

func custom(key string, f func(string) string) attrSpec {
	return attrSpec{key, func(v string, ok bool) (string, bool) { return f(v), ok }}
}

var networkSpec = required(keyStellarNetwork, stellarNetworks, stellarUnknownNet)

// specRule is a table-driven clientRule: marker stellar.network (a string).
type specRule struct {
	metric, u string
	hist      bool
	specs     []attrSpec
}

func (r specRule) name() string              { return r.metric }
func (r specRule) unit() string              { return r.u }
func (r specRule) histogram() bool           { return r.hist }
func (specRule) unmarkedReason() string      { return ReasonMetricNotAllowed }
func (specRule) wrongShapeReason() string    { return ReasonMalformedPoint }
func (specRule) marked(src pcommon.Map) bool { _, ok := strAttr(src, keyStellarNetwork); return ok }
func (r specRule) attrs(src, dst pcommon.Map) {
	for _, s := range r.specs {
		v, ok := strAttr(src, s.key)
		if out, write := s.out(v, ok); write {
			dst.PutStr(s.key, out)
		}
	}
}

var (
	homeDomainSpec = custom(keyAnchorHomeDomain, func(v string) string {
		if d := publicDomain(v); d != "" {
			return d
		}
		return stellarOther
	})
	// stellar.anchor.client is always present at the source ("_none" when the event names no client).
	clientSpec = attrSpec{keyAnchorClient, func(v string, ok bool) (string, bool) {
		if !ok {
			return anchorNone, true
		}
		return anchorClient(v), true
	}}
	txBase = []attrSpec{required(keySep, anchorTxSeps, stellarOther), required(keyAnchorKind, anchorKinds, stellarOther), networkSpec}
)

func init() {
	with := func(base []attrSpec, more ...attrSpec) []attrSpec {
		return append(append([]attrSpec{}, base...), more...)
	}
	clientMetricSets[ClientSetAnchors] = map[string]clientRule{}
	for _, r := range []specRule{
		{MetricAnchorRequestDuration, "s", true, []attrSpec{required(keySep, anchorSeps, stellarOther),
			required(keyAnchorStep, anchorSteps, "other"), required(keyAnchorOutcome, anchorOutcomes, stellarOther),
			homeDomainSpec, networkSpec}},
		{MetricAnchorEvents, "{event}", false, []attrSpec{required(keyAnchorEvent, anchorEvents, stellarOther),
			optional(keySep, anchorSeps, stellarOther), homeDomainSpec, networkSpec}},
		{MetricAnchorTransferCreated, "{transaction}", false, with(txBase, clientSpec)},
		{MetricAnchorTransitions, "{transition}", false, with(txBase,
			required(keyAnchorStatusFrom, anchorStatusFrom, stellarOther), required(keyAnchorStatus, anchorStatuses, stellarOther))},
		{MetricAnchorStatusDuration, "s", true, with(txBase, required(keyAnchorStatus, anchorStatuses, stellarOther))},
		{MetricAnchorTransferDuration, "s", true, with(txBase, required(keyAnchorStatus, anchorStatuses, stellarOther))},
		{MetricAnchorCustomerUpdates, "{update}", false, []attrSpec{
			required(keyAnchorStatus, anchorCustomerState, stellarOther), clientSpec, networkSpec}},
		{MetricAnchorQuotesCreated, "{quote}", false, []attrSpec{clientSpec, networkSpec}},
	} {
		clientMetricSets[ClientSetAnchors][r.metric] = r
	}
}
