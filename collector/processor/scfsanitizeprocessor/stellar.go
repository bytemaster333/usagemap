// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"math"
	"strconv"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

// Stellar client metrics (wire-formats §f.5 step 4a), emitted by the
// @usagemap/stellar-otel package for js-stellar-sdk: outbound dependency
// health of a tenant's backend (its calls to Stellar RPC and Horizon), never
// API usage. Accepted only when Config.StellarClientMetrics is on; otherwise
// they keep the step-4 treatment (client_metric_ignored / metric_not_allowed).
//
// Every output attribute is one of the closed sets below (the same lists as
// packages/stellar-otel/src/classify.ts); keys outside them are not copied and
// values outside them become "_OTHER" (or "unknown", "other"). The closed sets
// are the cardinality caps: per resource and scope at most
//
//	rpc.client.call.duration      14 methods × 28 error types × 5 networks         =  1,960 series
//	http.client.request.duration  3 methods × 51 templates × 32 status/error × 5   = 24,480 series
//	stellar.tx.submissions        3 via × (6 statuses + 2 × 15 classes + _OTHER) × 5 =    555 series
//	stellar.tx.polls              (3 statuses + 15 classes + _OTHER) × 5              =     95 series
//	stellar.tx.simulations        (3 outcomes + 9 classes + _OTHER) × 5               =     65 series
//
// (TestStellarCardinalityBound enumerates them; "51 templates" = 50 + _OTHER,
// "14 methods" = 13 + _OTHER; "32 status/error" = 28 kept
// statuses, each with its derived error.type, plus no status with error.type
// absent, timeout, network or _OTHER.) Nothing derived from a URL,
// address, hash, XDR or error text can be an output value: every value is a
// constant of this file, chosen by comparing the input with it.
const (
	MetricRPCClientDuration  = "rpc.client.call.duration"
	MetricHTTPClientDuration = "http.client.request.duration"
	MetricStellarSubmissions = "stellar.tx.submissions"
	MetricStellarPolls       = "stellar.tx.polls"
	MetricStellarSimulations = "stellar.tx.simulations"

	keyStellarNetwork  = "stellar.network"
	keyStellarVia      = "stellar.tx.via"
	keyStellarStatus   = "stellar.tx.status"
	keyStellarResult   = "stellar.tx.result_class"
	keySimOutcome      = "stellar.sim.outcome"
	keySimErrorClass   = "stellar.sim.error_class"
	keyErrorType       = "error.type"
	keyRPCStatusCode   = "rpc.status_code"
	keyURLTemplate     = "url.template"
	stellarOther       = "_OTHER"
	stellarUnknownNet  = "unknown"
	stellarOtherClass  = "other"
	stellarJSONRPC     = "jsonrpc"
	maxStellarValueLen = 64
)

type set map[string]struct{}

func newSet(vs ...string) set {
	s := make(set, len(vs))
	for _, v := range vs {
		s[v] = struct{}{}
	}
	return s
}

// pick returns v when it is a member of s (byte-for-byte equal to one of the
// constants above), else def.
func (s set) pick(v string, def string) string {
	if len(v) > maxStellarValueLen {
		return def
	}
	if _, ok := s[v]; ok {
		return v
	}
	return def
}

var (
	stellarRPCMethods = newSet("getHealth", "getNetwork", "getLatestLedger", "getLedgers", "getLedgerEntries",
		"getEvents", "getFeeStats", "getVersionInfo", "getTransaction", "getTransactions", "simulateTransaction",
		"sendTransaction", "queryEvents")
	stellarNetworks  = newSet("mainnet", "testnet", "futurenet", "local", stellarUnknownNet)
	stellarJSONCodes = newSet("-32700", "-32600", "-32601", "-32602", "-32603")
	// HTTP statuses kept in http.response.status_code (all) and error.type (≥ 400).
	stellarHTTPStatuses = []int64{200, 201, 202, 204, 301, 302, 304, 307, 308, 400, 401, 403, 404, 405, 406, 408,
		409, 410, 413, 414, 415, 422, 429, 500, 501, 502, 503, 504}
	stellarHTTPStatusSet = func() map[int64]struct{} {
		m := map[int64]struct{}{}
		for _, s := range stellarHTTPStatuses {
			m[s] = struct{}{}
		}
		return m
	}()
	stellarTransportErrors = newSet("timeout", "network")
	stellarRPCErrorTypes   = func() set {
		s := newSet("timeout", "network", stellarOther, "-32700", "-32600", "-32601", "-32602", "-32603")
		for _, c := range stellarHTTPStatuses {
			if c >= 400 {
				s[strconv.FormatInt(c, 10)] = struct{}{}
			}
		}
		return s
	}()
	stellarHorizonTemplates = newSet("/", "/accounts", "/accounts/{id}", "/accounts/{id}/data/{key}",
		"/accounts/{id}/effects", "/accounts/{id}/offers", "/accounts/{id}/operations", "/accounts/{id}/payments",
		"/accounts/{id}/trades", "/accounts/{id}/transactions", "/assets", "/claimable_balances",
		"/claimable_balances/{id}", "/claimable_balances/{id}/operations", "/claimable_balances/{id}/transactions",
		"/effects", "/fee_stats", "/friendbot", "/health", "/ledgers", "/ledgers/{id}", "/ledgers/{id}/effects",
		"/ledgers/{id}/operations", "/ledgers/{id}/payments", "/ledgers/{id}/transactions", "/liquidity_pools",
		"/liquidity_pools/{id}", "/liquidity_pools/{id}/effects", "/liquidity_pools/{id}/operations",
		"/liquidity_pools/{id}/trades", "/liquidity_pools/{id}/transactions", "/offers", "/offers/{id}",
		"/offers/{id}/trades", "/operations", "/operations/{id}", "/operations/{id}/effects", "/order_book", "/paths",
		"/paths/strict-receive", "/paths/strict-send", "/payments", "/trade_aggregations", "/trades", "/transactions",
		"/transactions/{id}", "/transactions/{id}/effects", "/transactions/{id}/operations",
		"/transactions/{id}/payments", "/transactions_async")
	stellarVia            = newSet("rpc", "horizon")
	stellarSubmitStatuses = newSet("PENDING", "DUPLICATE", "TRY_AGAIN_LATER", "ERROR", "SUCCESS", "FAILED")
	stellarPollStatuses   = newSet("SUCCESS", "FAILED", "NOT_FOUND")
	stellarResultClasses  = newSet("success", "bad_seq", "insufficient_fee", "insufficient_balance", "bad_auth",
		"time_bounds", "no_account", "malformed", "soroban_invalid", "resource_limit", "expired_state",
		"contract_error", "op_failed", "undecodable", stellarOtherClass)
	stellarSimOutcomes    = newSet("success", "error", "restore_required")
	stellarSimErrorClases = newSet("contract_error", "resource_limit", "expired_state", "auth", "wasm_trap",
		"value_error", "storage", "no_account", stellarOtherClass)
)

type stellarKind uint8

const (
	stellarNone stellarKind = iota
	stellarRPCDuration
	stellarHTTPDuration
	stellarSubmissions
	stellarPolls
	stellarSimulations
)

func classifyStellar(name string) stellarKind {
	switch name {
	case MetricRPCClientDuration:
		return stellarRPCDuration
	case MetricHTTPClientDuration:
		return stellarHTTPDuration
	case MetricStellarSubmissions:
		return stellarSubmissions
	case MetricStellarPolls:
		return stellarPolls
	case MetricStellarSimulations:
		return stellarSimulations
	}
	return stellarNone
}

// name returns the output name constant; unit returns the output unit.
func (k stellarKind) name() string {
	switch k {
	case stellarRPCDuration:
		return MetricRPCClientDuration
	case stellarHTTPDuration:
		return MetricHTTPClientDuration
	case stellarSubmissions:
		return MetricStellarSubmissions
	case stellarPolls:
		return MetricStellarPolls
	}
	return MetricStellarSimulations
}

func (k stellarKind) unit() string {
	switch k {
	case stellarRPCDuration, stellarHTTPDuration:
		return "s"
	case stellarSubmissions:
		return "{transaction}"
	}
	return "{call}"
}

func (k stellarKind) histogram() bool { return k == stellarRPCDuration || k == stellarHTTPDuration }

// stellarMarked reports whether a duration point comes from a Stellar
// instrumentation: it carries stellar.network, and an RPC point is JSON-RPC.
// Other client metrics (any HTTP or gRPC client) stay client_metric_ignored.
func stellarMarked(k stellarKind, src pcommon.Map) bool {
	if _, ok := strAttr(src, keyStellarNetwork); !ok {
		return false
	}
	switch k {
	case stellarRPCDuration:
		v, _ := strAttr(src, keyRPCSystemName)
		return v == stellarJSONRPC
	case stellarHTTPDuration:
		_, ok := strAttr(src, keyURLTemplate)
		return ok
	}
	return true
}

// stellarAttrs writes the closed attribute set of kind k from src into dst (an
// empty map).
func stellarAttrs(k stellarKind, src, dst pcommon.Map) {
	str := func(key string) (string, bool) { return strAttr(src, key) }
	pickOpt := func(key string, s set, def string) {
		if v, ok := str(key); ok {
			dst.PutStr(key, s.pick(v, def))
		}
	}
	net, _ := str(keyStellarNetwork)
	switch k {
	case stellarRPCDuration:
		dst.PutStr(keyRPCSystemName, stellarJSONRPC)
		m, _ := str(keyRPCMethod)
		dst.PutStr(keyRPCMethod, stellarRPCMethods.pick(m, stellarOther))
		if v, ok := str(keyErrorType); ok {
			t := stellarRPCErrorTypes.pick(v, stellarOther)
			dst.PutStr(keyErrorType, t)
			// rpc.status_code is derived, never copied: it is the JSON-RPC code of error.type.
			if _, isCode := stellarJSONCodes[t]; isCode {
				dst.PutStr(keyRPCStatusCode, t)
			}
		}
	case stellarHTTPDuration:
		m, _ := canonicalMethod(src)
		if m != "GET" && m != "POST" {
			m = stellarOther
		}
		dst.PutStr(keyMethod, m)
		tpl, _ := str(keyURLTemplate)
		dst.PutStr(keyURLTemplate, stellarHorizonTemplates.pick(tpl, stellarOther))
		status, hasStatus := canonicalStatus(src)
		if _, known := stellarHTTPStatusSet[status]; hasStatus && known {
			dst.PutInt(keyStatus, status)
			if status >= 400 {
				// error.type of an HTTP failure is its status (semantic conventions); derived, never copied.
				dst.PutStr(keyErrorType, strconv.FormatInt(status, 10))
			}
		} else if v, ok := str(keyErrorType); ok || (hasStatus && status >= 400) {
			dst.PutStr(keyErrorType, stellarTransportErrors.pick(v, stellarOther))
		}
	case stellarSubmissions:
		via, _ := str(keyStellarVia)
		dst.PutStr(keyStellarVia, stellarVia.pick(via, stellarOther))
		st, _ := str(keyStellarStatus)
		st = stellarSubmitStatuses.pick(st, stellarOther)
		dst.PutStr(keyStellarStatus, st)
		if st == "ERROR" || st == "FAILED" {
			pickOpt(keyStellarResult, stellarResultClasses, stellarOtherClass)
		}
	case stellarPolls:
		st, _ := str(keyStellarStatus)
		st = stellarPollStatuses.pick(st, stellarOther)
		dst.PutStr(keyStellarStatus, st)
		if st == "FAILED" {
			pickOpt(keyStellarResult, stellarResultClasses, stellarOtherClass)
		}
	case stellarSimulations:
		o, _ := str(keySimOutcome)
		o = stellarSimOutcomes.pick(o, stellarOther)
		dst.PutStr(keySimOutcome, o)
		if o == "error" {
			pickOpt(keySimErrorClass, stellarSimErrorClases, stellarOtherClass)
		}
	}
	dst.PutStr(keyStellarNetwork, stellarNetworks.pick(net, stellarUnknownNet))
}

// sanitizeStellar applies step 4a to one Stellar client metric, and the same
// allow-list mechanics to the rule of any later client-metric step (clientrules.go).
func (s *sanitizer) sanitizeStellar(k clientRule, m pmetric.Metric, sb *scopeBuilder, service string, rm *requestMeta, t *tally) {
	if k.histogram() {
		s.stellarHistogram(k, m, sb, service, rm, t)
		return
	}
	if m.Type() != pmetric.MetricTypeSum {
		t.add(service, ReasonMalformedPoint, int64(metricPoints(m)))
		return
	}
	marked := func(dp pmetric.NumberDataPoint) bool {
		if k.marked(dp.Attributes()) {
			return true
		}
		t.add(service, k.unmarkedReason(), 1)
		return false
	}
	sum := m.Sum()
	temp := sum.AggregationTemporality()
	if !validTemporality(temp) || !sum.IsMonotonic() {
		t.add(service, ReasonMalformedPoint, int64(sum.DataPoints().Len()))
		return
	}
	var om *outMetric
	for _, dp := range sum.DataPoints().All() {
		if !marked(dp) {
			continue
		}
		v, ok := counterValue(dp)
		if !ok {
			t.add(service, ReasonMalformedPoint, 1)
			continue
		}
		if r := s.timeReason(dp.Timestamp(), rm); r != "" {
			t.add(service, r, 1)
			continue
		}
		if om == nil {
			om = sb.metricOf(k.name(), k.unit(), pmetric.MetricTypeSum, temp)
		}
		dst := om.m.Sum().DataPoints().AppendEmpty()
		dst.SetStartTimestamp(dp.StartTimestamp())
		dst.SetTimestamp(dp.Timestamp())
		dst.SetIntValue(v)
		dst.SetFlags(pmetric.DataPointFlags(uint32(dp.Flags()) & pointFlagsMask))
		om.orig = append(om.orig, origKey(dp.Attributes()))
		k.attrs(dp.Attributes(), dst.Attributes())
	}
}

// counterValue: a monotonic count is a non-negative integer; integral doubles
// (the OTel JS SDK's default counter type) up to 2^53 are accepted as ints.
func counterValue(dp pmetric.NumberDataPoint) (int64, bool) {
	switch dp.ValueType() {
	case pmetric.NumberDataPointValueTypeInt:
		return dp.IntValue(), dp.IntValue() >= 0
	case pmetric.NumberDataPointValueTypeDouble:
		d := dp.DoubleValue()
		if !finite(d) || d < 0 || d != math.Trunc(d) || d > 1<<53 {
			return 0, false
		}
		return int64(d), true
	}
	return 0, false
}

func (s *sanitizer) stellarHistogram(k clientRule, m pmetric.Metric, sb *scopeBuilder, service string, rm *requestMeta, t *tally) {
	type pt interface{ Attributes() pcommon.Map }
	// Points without the Stellar marker are other client metrics.
	marked := func(p pt) bool {
		if k.marked(p.Attributes()) {
			return true
		}
		t.add(service, k.unmarkedReason(), 1)
		return false
	}
	factor, unitOK := unitFactor(m.Unit())
	switch m.Type() {
	case pmetric.MetricTypeHistogram:
		h := m.Histogram()
		temp := h.AggregationTemporality()
		var om *outMetric
		for _, dp := range h.DataPoints().All() {
			if !marked(dp) {
				continue
			}
			if !unitOK || !validTemporality(temp) || !validHistogram(dp) {
				t.add(service, ReasonMalformedPoint, 1)
				continue
			}
			if r := s.timeReason(dp.Timestamp(), rm); r != "" {
				t.add(service, r, 1)
				continue
			}
			if om == nil {
				om = sb.metricOf(k.name(), k.unit(), pmetric.MetricTypeHistogram, temp)
			}
			dst := om.m.Histogram().DataPoints().AppendEmpty()
			copyHistogram(dp, dst, factor)
			om.orig = append(om.orig, origKey(dp.Attributes()))
			k.attrs(dp.Attributes(), dst.Attributes())
		}
	case pmetric.MetricTypeExponentialHistogram:
		h := m.ExponentialHistogram()
		temp := h.AggregationTemporality()
		var om *outMetric
		for _, dp := range h.DataPoints().All() {
			if !marked(dp) {
				continue
			}
			if !unitOK || !validTemporality(temp) || !validExpHistogram(dp) {
				t.add(service, ReasonMalformedPoint, 1)
				continue
			}
			if r := s.timeReason(dp.Timestamp(), rm); r != "" {
				t.add(service, r, 1)
				continue
			}
			tmp := pmetric.NewExponentialHistogramDataPoint()
			if !copyExpHistogram(dp, tmp, factor) {
				t.add(service, ReasonMalformedPoint, 1)
				continue
			}
			if om == nil {
				om = sb.metricOf(k.name(), k.unit(), pmetric.MetricTypeExponentialHistogram, temp)
			}
			dst := om.m.ExponentialHistogram().DataPoints().AppendEmpty()
			tmp.MoveTo(dst)
			om.orig = append(om.orig, origKey(dp.Attributes()))
			k.attrs(dp.Attributes(), dst.Attributes())
		}
	default:
		// Not a histogram: step 4a counts a generic client metric of another shape
		// as client_metric_ignored; later steps as malformed_point.
		t.add(service, k.wrongShapeReason(), int64(metricPoints(m)))
	}
}
