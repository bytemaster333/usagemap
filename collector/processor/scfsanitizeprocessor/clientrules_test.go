// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"maps"
	"math/rand/v2"
	"regexp"
	"slices"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

// Steps 4b (partner) and 4c (payments) of wire-formats §f.5: the client-metric rule framework (clientrules.go).

func withSets(names ...string) func(*Config) {
	return func(c *Config) { c.ClientMetricSets = names }
}

// allowedRuleKeys: per output metric, the only keys and, per key, the only values (nil: checked elsewhere).
var allowedRuleKeys = map[string]map[string]set{
	MetricPartnerDuration: {keyPartner: withOther(newSet(slices.Collect(maps.Keys(partnerOps))...)),
		keyPartnerOperation: withOther(unionOps()), keyPartnerOutcome: partnerOutcomes, keyStellarNetwork: stellarNetworks},
	MetricPaymentEvents: {keyPayProtocol: withOther(payProtocols), keyPayStage: withOther(payStages),
		keyPayScheme: withOther(paySchemes), keyPayMethod: withOther(payMethods), keyPayIntent: withOther(payIntents),
		keyPayNetwork: payNetworks, keyPayAsset: withOther(payAssets), keyPayAmountBucket: payAmounts,
		keyPayReasonClass: payReasons, keyErrorType: unionSets(payX402Errors, payMPPErrors)},
}

func unionOps() set {
	u := newSet()
	for _, s := range partnerOps {
		maps.Copy(u, s)
	}
	return u
}

func unionSets(ss ...set) set {
	u := newSet()
	for _, s := range ss {
		maps.Copy(u, s)
	}
	return u
}

var ruleUnits = map[string]string{MetricPartnerDuration: "s", MetricPaymentEvents: "{event}"}

// checkRuleInvariants: only rule metrics and scf.ingest.dropped; units ours; every key and value in its closed set;
// resources are the §f.5 allow-list. Returns the kept points per metric.
func checkRuleInvariants(t *testing.T, md pmetric.Metrics) map[string]int {
	t.Helper()
	kept := map[string]int{}
	for _, r := range md.ResourceMetrics().All() {
		for k := range r.Resource().Attributes().All() {
			if !allowedResourceOut[k] {
				t.Errorf("resource attribute %q kept", k)
			}
		}
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() == MetricIngestDropped {
					continue
				}
				keys, ok := allowedRuleKeys[m.Name()]
				if !ok {
					t.Errorf("metric %q kept", m.Name())
					continue
				}
				if m.Unit() != ruleUnits[m.Name()] || m.Description() != "" {
					t.Errorf("%s: unit %q description %q", m.Name(), m.Unit(), m.Description())
				}
				for _, a := range pointAttrsOf(m) {
					kept[m.Name()]++
					for k, v := range a.All() {
						vals, ok := keys[k]
						if !ok {
							t.Errorf("%s: attribute %q kept", m.Name(), k)
							continue
						}
						if _, open := vals["\x00domain"]; open && v.Type() == pcommon.ValueTypeStr {
							continue // an open-valued key: checkAnchorDomains
						}
						if _, ok := vals[v.Str()]; v.Type() != pcommon.ValueTypeStr || !ok {
							t.Errorf("%s: %s = %q not in its closed set", m.Name(), k, v.AsString())
						}
					}
				}
			}
		}
	}
	return kept
}

func TestClientMetricSetsConfig(t *testing.T) {
	if len(createDefaultConfig().ClientMetricSets) != 0 {
		t.Fatal("client_metric_sets must default to empty")
	}
	for _, c := range []struct {
		sets []string
		ok   bool
	}{{nil, true}, {[]string{"partner"}, true}, {[]string{"partner", "payments"}, true},
		{[]string{"stellar"}, false}, {[]string{"partner", "partner"}, false}, {[]string{""}, false}} {
		cfg := createDefaultConfig()
		cfg.ClientMetricSets = c.sets
		if err := cfg.Validate(); (err == nil) != c.ok {
			t.Errorf("%v: err = %v", c.sets, err)
		}
	}
	for name, rules := range clientMetricSets {
		for metric, r := range rules {
			if r.name() != metric || strings.HasPrefix(metric, "http.client.") || strings.HasPrefix(metric, "rpc.client.") {
				t.Errorf("set %s: rule %s registered as %s (names under http.client./rpc.client. belong to step 4a)", name, r.name(), metric)
			}
		}
	}
}

// The real export of packages/partner-otel (scripts/collector-fixture.ts) with step 4b on, and off (the default).
func TestPartnerFixtureGolden(t *testing.T) {
	in, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(readFile(t, "testdata/sdk/partner-otel.metrics.json"))
	if err != nil {
		t.Fatal(err)
	}
	var maxTS int64
	forEachPoint(in, func(ts int64) { maxTS = max(maxTS, ts) })
	out := newHarness(t, withSets(ClientSetPartner)).runMetrics(fixtureRecv(maxTS), in)
	if kept := checkRuleInvariants(t, out); kept[MetricPartnerDuration] != 10 {
		t.Errorf("kept %v, want 10 partner points", kept)
	}
	if d := droppedCounts(t, out); len(d) != 0 {
		t.Errorf("drops %v", d)
	}
	assertProtoAllowListMetrics(t, out, func(string, string) {})
	b := marshalMetrics(t, out)
	assertNoLeak(t, "partner-otel", b, true)
	for _, leak := range []string{"GBRPYHIL", "sk_live", "cus_1", "CAVAULT", "aqua-proxy"} {
		if strings.Contains(string(b), leak) {
			t.Errorf("leak %q", leak)
		}
	}
	golden(t, "testdata/golden/partner-otel.enabled.metrics.json", b)

	off := newHarness(t).runMetrics(fixtureRecv(maxTS), in)
	if got, want := droppedCounts(t, off), map[string]int64{"partner-dapp-api/" + ReasonMetricNotAllowed: 10}; !maps.Equal(got, want) {
		t.Errorf("off: drops %v, want %v", got, want)
	}
	// Enabling payments only leaves the partner metric not allowed.
	if got := droppedCounts(t, newHarness(t, withSets(ClientSetPayments)).runMetrics(fixtureRecv(maxTS), in)); got["partner-dapp-api/"+ReasonMetricNotAllowed] != 10 {
		t.Errorf("payments only: drops %v", got)
	}
}

func TestPartnerAttributeAllowList(t *testing.T) {
	h := newHarness(t, withSets(ClientSetPartner))
	md, ms := stellarMetrics("dapp")
	pts := histOf(ms, MetricPartnerDuration, "ms")
	addHistPoint(pts, testRecv, map[string]any{keyPartner: "soroswap", keyPartnerOperation: "/quote", keyPartnerOutcome: "success",
		keyStellarNetwork: "testnet", "url.full": "https://api.soroswap.finance/quote?apikey=" + hostileSeed,
		"server.address": "api.soroswap.finance", "http.request.method": "POST", "amount": "1000"})
	addHistPoint(pts, testRecv, map[string]any{keyPartner: "soroswap", keyPartnerOperation: "/vault/{id}", // another partner's template
		keyPartnerOutcome: "teapot", keyStellarNetwork: "pubnet"})
	addHistPoint(pts, testRecv, map[string]any{keyPartner: "evil-" + hostileAccount, keyPartnerOperation: "/quote",
		keyPartnerOutcome: "success"})
	addHistPoint(pts, testRecv, map[string]any{keyPartnerOperation: "/quote"}) // no marker: not allowed
	addHistPoint(pts, testRecv, map[string]any{keyPartner: 7})                 // marker not a string: not allowed
	g := ms.AppendEmpty()                                                      // wrong shape: malformed
	g.SetName(MetricPartnerDuration)
	g.SetEmptyGauge().DataPoints().AppendEmpty().SetDoubleValue(1)
	bad := histOf(ms, MetricPartnerDuration, "min") // unknown unit: malformed
	addHistPoint(bad, testRecv, map[string]any{keyPartner: "soroswap"})

	out := h.runMetrics(defaultMeta(), md)
	checkRuleInvariants(t, out)
	assertProtoAllowListMetrics(t, out, func(string, string) {})
	assertNoLeak(t, "partner allow-list", marshalMetrics(t, out), false)
	if got, want := droppedCounts(t, out), map[string]int64{"dapp/" + ReasonMetricNotAllowed: 2, "dapp/" + ReasonMalformedPoint: 2}; !maps.Equal(got, want) {
		t.Errorf("drops %v, want %v", got, want)
	}
	var got []map[string]any
	for _, r := range out.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() != MetricPartnerDuration {
					continue
				}
				if dp := m.Histogram().DataPoints().At(0); dp.Sum() != 0.0015 || m.Unit() != "s" {
					t.Errorf("ms → s: sum %v unit %s", dp.Sum(), m.Unit())
				}
				for _, a := range pointAttrsOf(m) {
					got = append(got, a.AsRaw())
				}
			}
		}
	}
	want := []map[string]any{
		{keyPartner: "soroswap", keyPartnerOperation: "/quote", keyPartnerOutcome: "success", keyStellarNetwork: "testnet"},
		{keyPartner: "soroswap", keyPartnerOperation: "_OTHER", keyPartnerOutcome: "_OTHER", keyStellarNetwork: "unknown"},
		{keyPartner: "_OTHER", keyPartnerOperation: "_OTHER", keyPartnerOutcome: "success", keyStellarNetwork: "unknown"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if !maps.Equal(got[i], want[i]) {
			t.Errorf("[%d] = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestPaymentAttributeAllowList(t *testing.T) {
	h := newHarness(t, withSets(ClientSetPayments))
	md, ms := stellarMetrics("api")
	ev := sumOf(ms, MetricPaymentEvents, true)
	addCount(ev, testRecv, 3, map[string]any{keyPayProtocol: "x402", keyPayStage: "settled", keyPayScheme: "exact",
		keyPayNetwork: "stellar:pubnet", keyPayAsset: "USDC", keyPayAmountBucket: "0.01_0.1",
		keyPayReasonClass: "expired", keyErrorType: "verification_failed", // not on a successful stage
		"payment.payer": hostileAccount, "payment.amount": "1234567", "http.route": "/paid/" + hostileSeed})
	addCount(ev, testRecv, 1, map[string]any{keyPayProtocol: "x402", keyPayStage: "failed", keyPayNetwork: "eip155:8453",
		keyPayAmountBucket: "1_10", keyErrorType: "invalid_exact_stellar_payload_wrong_amount"})
	addCount(ev, testRecv, 1, map[string]any{keyPayProtocol: "mpp", keyPayStage: "canceled", keyPayMethod: "paypal",
		keyPayIntent: "session", keyPayReasonClass: "boom " + hostileAccount,
		keyErrorType: "invalid_exact_stellar_payload_wrong_amount"}) // an x402 code on mpp → _OTHER
	addCount(ev, testRecv, 1.0, map[string]any{keyPayProtocol: "ftp", keyPayStage: "settled", keyPayAsset: "BTC",
		keyPayAmountBucket: "1_10", keyPayScheme: "exact"}) // unknown protocol: protocol, stage, network only
	addCount(ev, testRecv, 1, map[string]any{keyPayStage: "paid"})                                      // no marker
	addCount(ev, testRecv, 1.5, map[string]any{keyPayProtocol: "mpp", keyPayStage: "paid"})             // malformed
	addCount(sumOf(ms, MetricPaymentEvents, false), testRecv, 1, map[string]any{keyPayProtocol: "mpp"}) // not monotonic

	out := h.runMetrics(defaultMeta(), md)
	checkRuleInvariants(t, out)
	assertProtoAllowListMetrics(t, out, func(string, string) {})
	assertNoLeak(t, "payments allow-list", marshalMetrics(t, out), false)
	if got, want := droppedCounts(t, out), map[string]int64{"api/" + ReasonMetricNotAllowed: 1, "api/" + ReasonMalformedPoint: 2}; !maps.Equal(got, want) {
		t.Errorf("drops %v, want %v", got, want)
	}
	var got []map[string]any
	for _, r := range out.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() == MetricPaymentEvents {
					for _, a := range pointAttrsOf(m) {
						got = append(got, a.AsRaw())
					}
				}
			}
		}
	}
	want := []map[string]any{
		{keyPayProtocol: "x402", keyPayStage: "settled", keyPayScheme: "exact", keyPayNetwork: "stellar:pubnet",
			keyPayAsset: "USDC", keyPayAmountBucket: "0.01_0.1"},
		{keyPayProtocol: "x402", keyPayStage: "failed", keyPayNetwork: "unknown", keyPayReasonClass: "other",
			keyErrorType: "invalid_exact_stellar_payload_wrong_amount"},
		{keyPayProtocol: "mpp", keyPayStage: "canceled", keyPayMethod: "_OTHER", keyPayIntent: "session",
			keyPayNetwork: "unknown", keyPayReasonClass: "other", keyErrorType: "_OTHER"},
		{keyPayProtocol: "_OTHER", keyPayStage: "settled", keyPayNetwork: "unknown"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d points %v", len(got), got)
	}
	for i := range want {
		if !maps.Equal(got[i], want[i]) {
			t.Errorf("[%d] = %v\nwant %v", i, got[i], want[i])
		}
	}
}

// Hostile values in every input key, markers included: nothing survives, every output value is a constant.
func TestClientRulesNoSecretSurvives(t *testing.T) {
	h := newHarness(t, withSets(ClientSetPartner, ClientSetPayments))
	g := &hostileGen{r: rand.New(rand.NewPCG(2026, 1120))}
	keys := []string{keyPartner, keyPartnerOperation, keyPartnerOutcome, keyStellarNetwork, keyPayProtocol, keyPayStage,
		keyPayScheme, keyPayMethod, keyPayIntent, keyPayNetwork, keyPayAsset, keyPayAmountBucket, keyPayReasonClass,
		keyErrorType, "url.full", "server.address", "payment.payer", "payment.amount"}
	kept := 0
	for i := range 300 {
		g.fuzz = "cr" + string(rune('a'+i%26))
		md, ms := stellarMetrics("dapp")
		g.resourceAttrs(md.ResourceMetrics().At(0).Resource().Attributes(), i)
		g.scope(md.ResourceMetrics().At(0).ScopeMetrics().At(0).Scope())
		hostile := func(m pcommon.Map, marker string, keep map[string]any) {
			for j, k := range keys {
				g.put(m, k, i+j, k == keyPartnerOperation)
			}
			g.pointAttrs(m, i)
			m.PutStr(marker, g.text())
			for k, v := range keep {
				m.PutStr(k, v.(string))
			}
		}
		pts := histOf(ms, MetricPartnerDuration, "s")
		ev := sumOf(ms, MetricPaymentEvents, true)
		for p := range 3 {
			var keepP, keepE map[string]any
			if p == 0 {
				keepP = map[string]any{keyPartner: "bridge", keyPartnerOperation: "/transfers/{id}"}
				keepE = map[string]any{keyPayProtocol: "x402", keyPayStage: "failed"}
			}
			hostile(addHistPoint(pts, testRecv, nil).Attributes(), keyPartner, keepP)
			addCount(ev, testRecv, 1, nil)
			hostile(ev.At(ev.Len()-1).Attributes(), keyPayProtocol, keepE)
		}
		out := h.runMetrics(defaultMeta(), md)
		for _, n := range checkRuleInvariants(t, out) {
			kept += n
		}
		checkHostileOutput(t, "client rules", marshalMetrics(t, out), func(f func(string, string)) { assertProtoAllowListMetrics(t, out, f) })
		if t.Failed() {
			return
		}
	}
	if kept == 0 {
		t.Fatal("nothing kept: the test would prove nothing")
	}
}

// Every value of every closed set fits pick's length bound (a longer constant would silently become _OTHER), and the
// series per resource and scope stay within the documented bounds.
func TestClientRuleCardinalityBound(t *testing.T) {
	for name, s := range map[string]set{"outcomes": partnerOutcomes, "ops": unionOps(), "reasons": payReasons,
		"x402": payX402Errors, "mpp": payMPPErrors, "amounts": payAmounts, "networks": payNetworks} {
		for v := range s {
			if len(v) > maxStellarValueLen || v == "" {
				t.Errorf("%s: %q does not fit", name, v)
			}
		}
	}
	nOps := 0
	for _, s := range partnerOps {
		nOps += len(s) + 1 // + _OTHER
	}
	partnerMax := (nOps + 1) * len(partnerOutcomes) * len(stellarNetworks) // + the unknown partner's one operation
	// Payments: per protocol, (non-failed stages × scheme|method|intent options × amount buckets + failed stages ×
	// reasons × error types) × networks × assets. Options include "absent".
	opt := func(s set) int { return len(s) + 2 } // values + _OTHER + absent
	assets, nets := opt(payAssets), len(payNetworks)
	ok := len(payStages) - 2 + 1 // + _OTHER stage
	x402 := opt(paySchemes) * (ok*(len(payAmounts)+1) + 2*len(payReasons)*(len(payX402Errors)+1)) * nets * assets
	mpp := opt(payMethods) * opt(payIntents) * (ok*(len(payAmounts)+1) + 2*len(payReasons)*(len(payMPPErrors)+1)) * nets * assets
	other := (ok + 2) * nets // unknown protocol: protocol, stage, network only
	t.Logf("partner ≤ %d series; payments ≤ %d (x402 %d, mpp %d, _OTHER protocol %d) per resource and scope",
		partnerMax, x402+mpp+other, x402, mpp, other)
	if partnerMax > 10_000 {
		t.Errorf("partner bound %d grew past 10,000: revisit the storage caps", partnerMax)
	}
}

// The partner table here and in packages/partner-otel/src/partners.ts must be identical.
func TestPartnerTableMatchesPackage(t *testing.T) {
	src := string(readFile(t, "../../../packages/partner-otel/src/partners.ts"))
	block := regexp.MustCompile(`(?s)\n  ([a-z_]+): \{\n    hosts: \{[^}]*\},\n    operations: \[(.*?)\],\n  \},`)
	got := map[string]set{}
	for _, m := range block.FindAllStringSubmatch(src, -1) {
		ops := newSet()
		for _, v := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(m[2], -1) {
			ops[v[1]] = struct{}{}
		}
		got[m[1]] = ops
	}
	if len(got) != len(partnerOps) {
		t.Errorf("package has %d partners, Collector %d", len(got), len(partnerOps))
	}
	for p, ops := range partnerOps {
		if !maps.Equal(got[p], ops) {
			t.Errorf("%s: package %v\nCollector %v", p, slices.Sorted(maps.Keys(got[p])), slices.Sorted(maps.Keys(ops)))
		}
	}
	outs := regexp.MustCompile(`(?s)export const OUTCOMES = \[(.*?)\] as const;`).FindStringSubmatch(
		string(readFile(t, "../../../packages/partner-otel/src/classify.ts")))
	if outs == nil {
		t.Fatal("OUTCOMES not found")
	}
	pkg := withOther(newSet())
	for _, v := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(outs[1], -1) {
		pkg[v[1]] = struct{}{}
	}
	if !maps.Equal(pkg, partnerOutcomes) {
		t.Errorf("outcomes: package %v, Collector %v", pkg, partnerOutcomes)
	}
}

// The payment sets here and in packages/payments-otel/src/classify.ts must be identical.
func TestPaymentSetsMatchPackage(t *testing.T) {
	src := string(readFile(t, "../../../packages/payments-otel/src/classify.ts"))
	array := func(name string) set {
		m := regexp.MustCompile(`(?s)export const ` + name + ` = \[(.*?)\] as const;`).FindStringSubmatch(src)
		if m == nil {
			t.Fatalf("%s not found in classify.ts", name)
		}
		out := newSet()
		for _, v := range regexp.MustCompile(`"([^"]*)"|\bOTHER\b`).FindAllStringSubmatch(m[1], -1) {
			if v[1] != "" {
				out[v[1]] = struct{}{}
			} else {
				out[stellarOther] = struct{}{}
			}
		}
		return out
	}
	for _, c := range []struct {
		name string
		want set
	}{{"PROTOCOLS", payProtocols}, {"STAGES", payStages}, {"X402_SCHEMES", withOther(paySchemes)},
		{"MPP_METHODS", withOther(payMethods)}, {"MPP_INTENTS", withOther(payIntents)}, {"NETWORKS", payNetworks},
		{"ASSETS", withOther(payAssets)}, {"AMOUNT_BUCKETS", payAmounts}, {"REASON_CLASSES", payReasons},
		{"X402_ERROR_TYPES", payX402Errors}, {"MPP_ERROR_TYPES", payMPPErrors}} {
		if got := array(c.name); !maps.Equal(got, c.want) {
			t.Errorf("%s: package %v\nCollector %v", c.name, slices.Sorted(maps.Keys(got)), slices.Sorted(maps.Keys(c.want)))
		}
	}
	common := string(readFile(t, "../../../packages/payments-otel/src/common.ts"))
	if !strings.Contains(common, `METRIC_PAYMENT_EVENTS = "`+MetricPaymentEvents+`"`) || !strings.Contains(common, `unit: "{event}"`) {
		t.Error("payments-otel metric name or unit changed")
	}
}

// Stellar Disbursement Platform and OpenZeppelin Relayer Prometheus metrics (scraped by a tenant's own Collector) are
// not accepted, whatever sets are enabled: they are dropped as metric_not_allowed (docs/onboarding/api-sdp.md,
// api-oz-relayer.md give the reasons and the local recipe).
func TestPlatformPrometheusMetricsNotAccepted(t *testing.T) {
	h := newHarness(t, stellarOn, withSets(slices.Sorted(maps.Keys(clientMetricSets))...))
	md, ms := stellarMetrics("sdp")
	names := []string{"sdp_business_disbursements_counter", "tss_payment_transaction_successful", "tss_payment_error",
		"tss_wallet_creation_transaction_successful", "transactions_success_total", "transactions_failed_total",
		"raw_requests_total", "requests_total", "transaction_processing_seconds"}
	for _, n := range names {
		addCount(sumOf(ms, n, true), testRecv, 1, map[string]any{"wallet_id": "w-1", "tenant_name": "acme",
			"channel_account": hostileAccount, "relayer_id": "r1", "network_type": "stellar", "raw_uri": "/api/v1/relayers/r1/transactions/" + hostileHash,
			keyStellarNetwork: "testnet"})
	}
	out := h.runMetrics(defaultMeta(), md)
	if got, want := droppedCounts(t, out), map[string]int64{"sdp/" + ReasonMetricNotAllowed: int64(len(names))}; !maps.Equal(got, want) {
		t.Errorf("drops %v, want %v", got, want)
	}
	assertNoLeak(t, "platform prometheus", marshalMetrics(t, out), false)
}
