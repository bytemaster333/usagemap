// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"maps"
	"math/rand/v2"
	"regexp"
	"strconv"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

// Step 4a (wire-formats §f.5): the Stellar client metrics of @usagemap/stellar-otel.

func stellarOn(c *Config) { c.StellarClientMetrics = true }

// allowedStellarKeys: per output metric, the only attribute keys and, per key, the only values.
var allowedStellarKeys = map[string]map[string]set{
	MetricRPCClientDuration: {keyRPCSystemName: newSet(stellarJSONRPC), keyRPCMethod: withOther(stellarRPCMethods),
		keyErrorType: stellarRPCErrorTypes, keyRPCStatusCode: stellarJSONCodes, keyStellarNetwork: stellarNetworks},
	MetricHTTPClientDuration: {keyMethod: newSet("GET", "POST", stellarOther), keyURLTemplate: withOther(stellarHorizonTemplates),
		keyStatus: nil, keyErrorType: stellarRPCErrorTypes, keyStellarNetwork: stellarNetworks},
	MetricStellarSubmissions: {keyStellarVia: withOther(stellarVia), keyStellarStatus: withOther(stellarSubmitStatuses),
		keyStellarResult: stellarResultClasses, keyStellarNetwork: stellarNetworks},
	MetricStellarPolls: {keyStellarStatus: withOther(stellarPollStatuses), keyStellarResult: stellarResultClasses,
		keyStellarNetwork: stellarNetworks},
	MetricStellarSimulations: {keySimOutcome: withOther(stellarSimOutcomes), keySimErrorClass: stellarSimErrorClases,
		keyStellarNetwork: stellarNetworks},
}

func withOther(s set) set {
	c := maps.Clone(s)
	c[stellarOther] = struct{}{}
	return c
}

var stellarUnits = map[string]string{MetricRPCClientDuration: "s", MetricHTTPClientDuration: "s",
	MetricStellarSubmissions: "{transaction}", MetricStellarPolls: "{call}", MetricStellarSimulations: "{call}"}

func pointAttrsOf(m pmetric.Metric) []pcommon.Map {
	var out []pcommon.Map
	switch m.Type() {
	case pmetric.MetricTypeHistogram:
		for _, dp := range m.Histogram().DataPoints().All() {
			out = append(out, dp.Attributes())
		}
	case pmetric.MetricTypeExponentialHistogram:
		for _, dp := range m.ExponentialHistogram().DataPoints().All() {
			out = append(out, dp.Attributes())
		}
	case pmetric.MetricTypeSum:
		for _, dp := range m.Sum().DataPoints().All() {
			out = append(out, dp.Attributes())
		}
	}
	return out
}

// checkStellarInvariants: only the five Stellar metrics and scf.ingest.dropped; units are ours; every key and value
// is in the metric's closed set; status codes are in the closed list; resources are the §f.5 allow-list.
func checkStellarInvariants(t *testing.T, md pmetric.Metrics) (kept map[string]int) {
	t.Helper()
	kept = map[string]int{}
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
				keys, ok := allowedStellarKeys[m.Name()]
				if !ok {
					t.Errorf("metric %q kept", m.Name())
					continue
				}
				if m.Unit() != stellarUnits[m.Name()] || m.Description() != "" {
					t.Errorf("%s: unit %q description %q", m.Name(), m.Unit(), m.Description())
				}
				for _, a := range pointAttrsOf(m) {
					kept[m.Name()]++
					for k, v := range a.All() {
						vals, ok := keys[k]
						switch {
						case !ok:
							t.Errorf("%s: attribute %q kept", m.Name(), k)
						case k == keyStatus:
							if _, known := stellarHTTPStatusSet[v.Int()]; v.Type() != pcommon.ValueTypeInt || !known {
								t.Errorf("%s: status %v", m.Name(), v.AsRaw())
							}
						default:
							if _, ok := vals[v.Str()]; v.Type() != pcommon.ValueTypeStr || !ok {
								t.Errorf("%s: %s = %q not in its closed set", m.Name(), k, v.AsString())
							}
						}
					}
					if _, ok := a.Get(keyStellarNetwork); !ok {
						t.Errorf("%s: point without stellar.network", m.Name())
					}
				}
			}
		}
	}
	return kept
}

// The real export of the package (packages/stellar-otel scripts/collector-fixture.ts) with step 4a on.
func TestStellarFixtureGolden(t *testing.T) {
	in, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(readFile(t, "testdata/sdk/stellar-otel.metrics.json"))
	if err != nil {
		t.Fatal(err)
	}
	var maxTS int64
	forEachPoint(in, func(ts int64) { maxTS = max(maxTS, ts) })
	h := newHarness(t, stellarOn)
	out := h.runMetrics(fixtureRecv(maxTS), in)
	kept := checkStellarInvariants(t, out)
	want := map[string]int{MetricRPCClientDuration: 7, MetricHTTPClientDuration: 3, MetricStellarSubmissions: 4,
		MetricStellarPolls: 2, MetricStellarSimulations: 2}
	if !maps.Equal(kept, want) {
		t.Errorf("kept points %v, want %v", kept, want)
	}
	if d := droppedCounts(t, out); len(d) != 0 {
		t.Errorf("drops %v", d)
	}
	assertProtoAllowListMetrics(t, out, func(string, string) {})
	b := marshalMetrics(t, out)
	assertNoLeak(t, "stellar-otel", b, true)
	golden(t, "testdata/golden/stellar-otel.enabled.metrics.json", b)
}

// The real export of the Python package (packages/stellar-otel-py scripts/collector_fixture.py: py-stellar-base 17 +
// the OpenTelemetry Python SDK's OTLP encoding) with step 4a on: the same closed sets, nothing dropped.
func TestStellarPyFixtureGolden(t *testing.T) {
	in, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(readFile(t, "testdata/sdk/stellar-otel-py.metrics.json"))
	if err != nil {
		t.Fatal(err)
	}
	var maxTS int64
	forEachPoint(in, func(ts int64) { maxTS = max(maxTS, ts) })
	out := newHarness(t, stellarOn).runMetrics(fixtureRecv(maxTS), in)
	kept := checkStellarInvariants(t, out)
	want := map[string]int{MetricRPCClientDuration: 7, MetricHTTPClientDuration: 3, MetricStellarSubmissions: 4,
		MetricStellarPolls: 2, MetricStellarSimulations: 2}
	if !maps.Equal(kept, want) {
		t.Errorf("kept points %v, want %v", kept, want)
	}
	if d := droppedCounts(t, out); len(d) != 0 {
		t.Errorf("drops %v", d)
	}
	assertProtoAllowListMetrics(t, out, func(string, string) {})
	b := marshalMetrics(t, out)
	assertNoLeak(t, "stellar-otel-py", b, true)
	golden(t, "testdata/golden/stellar-otel-py.enabled.metrics.json", b)
}

// Off (the default), the same export is dropped exactly as before step 4a existed.
func TestStellarOffByDefault(t *testing.T) {
	if createDefaultConfig().StellarClientMetrics {
		t.Fatal("stellar_client_metrics must default to false")
	}
	in, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(readFile(t, "testdata/sdk/stellar-otel.metrics.json"))
	if err != nil {
		t.Fatal(err)
	}
	var maxTS int64
	forEachPoint(in, func(ts int64) { maxTS = max(maxTS, ts) })
	out := newHarness(t).runMetrics(fixtureRecv(maxTS), in)
	want := map[string]int64{"stellar-dapp-api/" + ReasonClientMetric: 10, "stellar-dapp-api/" + ReasonMetricNotAllowed: 8}
	if got := droppedCounts(t, out); !maps.Equal(got, want) {
		t.Fatalf("drops %v, want %v", got, want)
	}
}

func stellarMetrics(service string) (pmetric.Metrics, pmetric.MetricSlice) {
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	r.Resource().Attributes().PutStr("service.name", service)
	r.Resource().Attributes().PutStr("server.address", "rpc.example.com")
	sm := r.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName("@usagemap/stellar-otel")
	return md, sm.Metrics()
}

func histOf(ms pmetric.MetricSlice, name, unit string) pmetric.HistogramDataPointSlice {
	m := ms.AppendEmpty()
	m.SetName(name)
	m.SetUnit(unit)
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	return h.DataPoints()
}

func sumOf(ms pmetric.MetricSlice, name string, monotonic bool) pmetric.NumberDataPointSlice {
	m := ms.AppendEmpty()
	m.SetName(name)
	m.SetUnit("1")
	s := m.SetEmptySum()
	s.SetIsMonotonic(monotonic)
	s.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	return s.DataPoints()
}

func addCount(dps pmetric.NumberDataPointSlice, ts int64, v any, attrs map[string]any) {
	dp := dps.AppendEmpty()
	dp.SetStartTimestamp(pcommon.Timestamp(ts - minute))
	dp.SetTimestamp(pcommon.Timestamp(ts))
	switch x := v.(type) {
	case int:
		dp.SetIntValue(int64(x))
	case float64:
		dp.SetDoubleValue(x)
	}
	if err := dp.Attributes().FromRaw(attrs); err != nil {
		panic(err)
	}
}

const (
	hostileAccount = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"
	hostileSeed    = "SBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"
	hostileHash    = "7b5ea4d1ac0d4d26b1b2f1a8d9d2fc2a8b1c3e4f5a6b7c8d9e0f1a2b3c4d5e6f"
)

func TestStellarAttributeAllowList(t *testing.T) {
	h := newHarness(t, stellarOn)
	md, ms := stellarMetrics("dapp")
	rpcPts := histOf(ms, MetricRPCClientDuration, "ms")
	addHistPoint(rpcPts, testRecv, map[string]any{ // kept, hostile extras dropped
		"rpc.system.name": "jsonrpc", "rpc.method": "sendTransaction", "stellar.network": "testnet",
		"server.address": "rpc.example.com", "url.full": "https://rpc.example.com/key-" + hostileSeed,
		"stellar.account": hostileAccount, "tx.hash": hostileHash, "rpc.status_code": "-32601"})
	addHistPoint(rpcPts, testRecv, map[string]any{ // unknown method/values → _OTHER; rpc.status_code derived
		"rpc.system.name": "jsonrpc", "rpc.method": hostileAccount, "stellar.network": "my-private-" + hostileHash,
		"error.type": "-32601"})
	addHistPoint(rpcPts, testRecv, map[string]any{ // error.type outside the set → _OTHER, no status code
		"rpc.system.name": "jsonrpc", "rpc.method": "getHealth", "stellar.network": "mainnet", "error.type": "boom " + hostileSeed})
	addHistPoint(rpcPts, testRecv, map[string]any{"rpc.system.name": "grpc", "rpc.method": "getHealth", "stellar.network": "testnet"}) // ignored: not JSON-RPC
	addHistPoint(rpcPts, testRecv, map[string]any{"rpc.system.name": "jsonrpc", "rpc.method": "getHealth"})                            // ignored: no marker
	httpPts := histOf(ms, MetricHTTPClientDuration, "s")
	addHistPoint(httpPts, testRecv, map[string]any{"http.request.method": "get", "url.template": "/accounts/{id}",
		"http.response.status_code": 404, "error.type": "anything", "stellar.network": "testnet", "url.full": "https://h/accounts/" + hostileAccount})
	addHistPoint(httpPts, testRecv, map[string]any{"http.request.method": "DELETE", "url.template": "/accounts/" + hostileAccount,
		"http.response.status_code": 418, "stellar.network": "testnet"}) // template and method → _OTHER, status dropped, error _OTHER
	addHistPoint(httpPts, testRecv, map[string]any{"http.request.method": "POST", "url.template": "/transactions",
		"error.type": "timeout", "stellar.network": "testnet"})
	addHistPoint(httpPts, testRecv, map[string]any{"http.request.method": "GET", "url.template": "/x", "http.response.status_code": 200}) // ignored: no marker
	addHistPoint(httpPts, testRecv, map[string]any{"http.request.method": "GET", "stellar.network": "testnet"})                           // ignored: no url.template
	subs := sumOf(ms, MetricStellarSubmissions, true)
	addCount(subs, testRecv, 2, map[string]any{"stellar.tx.via": "rpc", "stellar.tx.status": "ERROR",
		"stellar.tx.result_class": "bad_seq", "stellar.network": "testnet", "tx.hash": hostileHash})
	addCount(subs, testRecv, 1.0, map[string]any{"stellar.tx.via": "carrier-pigeon", "stellar.tx.status": "PENDING",
		"stellar.tx.result_class": "bad_seq"}) // result_class only on ERROR/FAILED; network defaults to unknown
	addCount(subs, testRecv, 1.5, map[string]any{"stellar.tx.status": "PENDING"}) // malformed: not an integer
	addCount(subs, testRecv, -1, map[string]any{"stellar.tx.status": "PENDING"})  // malformed: negative
	polls := sumOf(ms, MetricStellarPolls, true)
	addCount(polls, testRecv, 3, map[string]any{"stellar.tx.status": "FAILED", "stellar.tx.result_class": hostileAccount, "stellar.network": "testnet"})
	sims := sumOf(ms, MetricStellarSimulations, true)
	addCount(sims, testRecv, 1, map[string]any{"stellar.sim.outcome": "error", "stellar.sim.error_class": "contract_error",
		"stellar.network": "testnet", "error.message": "HostError: Error(Contract, #3) " + hostileAccount})
	addCount(sims, testRecv+6*minute, 1, map[string]any{"stellar.sim.outcome": "success"}) // future
	addCount(sumOf(ms, MetricStellarPolls, false), testRecv, 1, nil)                       // malformed: not monotonic
	g := ms.AppendEmpty()                                                                  // malformed: a gauge
	g.SetName(MetricStellarPolls)
	g.SetEmptyGauge().DataPoints().AppendEmpty().SetIntValue(1)

	out := h.runMetrics(defaultMeta(), md)
	checkStellarInvariants(t, out)
	assertProtoAllowListMetrics(t, out, func(string, string) {})
	b := marshalMetrics(t, out)
	assertNoLeak(t, "stellar allow-list", b, false)

	wantDrops := map[string]int64{
		"dapp/" + ReasonClientMetric:   4,
		"dapp/" + ReasonMalformedPoint: 2 + 1 + 1,
		"dapp/" + ReasonFuture:         1,
	}
	if got := droppedCounts(t, out); !maps.Equal(got, wantDrops) {
		t.Errorf("drops %v, want %v", got, wantDrops)
	}
	got := map[string][]map[string]any{}
	for _, r := range out.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() == MetricIngestDropped {
					continue
				}
				for _, a := range pointAttrsOf(m) {
					got[m.Name()] = append(got[m.Name()], a.AsRaw())
				}
				if m.Name() == MetricRPCClientDuration {
					dp := m.Histogram().DataPoints().At(0)
					if b := dp.ExplicitBounds().At(0); b != 0.0001 || dp.Sum() != 0.0015 || m.Unit() != "s" {
						t.Errorf("ms → s conversion: bound %v sum %v unit %s", b, dp.Sum(), m.Unit())
					}
				}
				if m.Name() == MetricStellarSubmissions {
					if v := m.Sum().DataPoints().At(1).IntValue(); v != 1 {
						t.Errorf("integral double count = %d", v)
					}
				}
			}
		}
	}
	want := map[string][]map[string]any{
		MetricRPCClientDuration: {
			{"rpc.system.name": "jsonrpc", "rpc.method": "sendTransaction", "stellar.network": "testnet"},
			{"rpc.system.name": "jsonrpc", "rpc.method": "_OTHER", "error.type": "-32601", "rpc.status_code": "-32601", "stellar.network": "unknown"},
			{"rpc.system.name": "jsonrpc", "rpc.method": "getHealth", "error.type": "_OTHER", "stellar.network": "mainnet"},
		},
		MetricHTTPClientDuration: {
			{"http.request.method": "GET", "url.template": "/accounts/{id}", "http.response.status_code": int64(404), "error.type": "404", "stellar.network": "testnet"},
			{"http.request.method": "_OTHER", "url.template": "_OTHER", "error.type": "_OTHER", "stellar.network": "testnet"},
			{"http.request.method": "POST", "url.template": "/transactions", "error.type": "timeout", "stellar.network": "testnet"},
		},
		MetricStellarSubmissions: {
			{"stellar.tx.via": "rpc", "stellar.tx.status": "ERROR", "stellar.tx.result_class": "bad_seq", "stellar.network": "testnet"},
			{"stellar.tx.via": "_OTHER", "stellar.tx.status": "PENDING", "stellar.network": "unknown"},
		},
		MetricStellarPolls:       {{"stellar.tx.status": "FAILED", "stellar.tx.result_class": "other", "stellar.network": "testnet"}},
		MetricStellarSimulations: {{"stellar.sim.outcome": "error", "stellar.sim.error_class": "contract_error", "stellar.network": "testnet"}},
	}
	for name, w := range want {
		g := got[name]
		if len(g) != len(w) {
			t.Errorf("%s: %d points %v, want %d", name, len(g), g, len(w))
			continue
		}
		for i := range w {
			if !maps.Equal(g[i], w[i]) {
				t.Errorf("%s[%d] = %v\nwant %v", name, i, g[i], w[i])
			}
		}
	}
}

// Points whose original attributes differed only in dropped keys (server.address, a hash) merge, as in step 8.
func TestStellarMerge(t *testing.T) {
	h := newHarness(t, stellarOn)
	md, ms := stellarMetrics("dapp")
	pts := histOf(ms, MetricRPCClientDuration, "s")
	subs := sumOf(ms, MetricStellarSubmissions, true)
	for _, host := range []string{"a.rpc", "b.rpc", "c.rpc"} {
		addHistPoint(pts, testRecv, map[string]any{"rpc.system.name": "jsonrpc", "rpc.method": "getHealth",
			"stellar.network": "testnet", "server.address": host})
		addCount(subs, testRecv, 2, map[string]any{"stellar.tx.via": "rpc", "stellar.tx.status": "PENDING",
			"stellar.network": "testnet", "server.address": host})
	}
	out := h.runMetrics(defaultMeta(), md)
	for _, r := range out.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				switch m.Name() {
				case MetricRPCClientDuration:
					if n := m.Histogram().DataPoints().Len(); n != 1 || m.Histogram().DataPoints().At(0).Count() != 9 {
						t.Errorf("histogram not merged: %d points", n)
					}
				case MetricStellarSubmissions:
					if n := m.Sum().DataPoints().Len(); n != 1 || m.Sum().DataPoints().At(0).IntValue() != 6 {
						t.Errorf("counter not merged: %d points", n)
					}
				}
			}
		}
	}
	// Two snapshots of the same original stream are never added up.
	md2, ms2 := stellarMetrics("dapp")
	subs2 := sumOf(ms2, MetricStellarSubmissions, true)
	for range 2 {
		addCount(subs2, testRecv, 5, map[string]any{"stellar.tx.via": "rpc", "stellar.tx.status": "PENDING", "stellar.network": "testnet"})
	}
	out2 := h.runMetrics(defaultMeta(), md2)
	for _, r := range out2.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() == MetricStellarSubmissions && m.Sum().DataPoints().Len() != 2 {
					t.Errorf("identical originals merged: %d points", m.Sum().DataPoints().Len())
				}
			}
		}
	}
}

// The closed sets bound the series per metric (stellar.go header); this enumerates every output by feeding every
// closed value plus junk for each key, and checks the documented maxima.
func TestStellarCardinalityBound(t *testing.T) {
	vals := func(s set, extra ...string) []string {
		out := append([]string{}, extra...)
		for v := range s {
			out = append(out, v)
		}
		return out
	}
	absent := "\x00absent"
	nets := vals(stellarNetworks, "junk", absent)
	distinct := func(k stellarKind, inputs []map[string]any) int {
		seen := map[string]bool{}
		for _, in := range inputs {
			for _, n := range nets {
				src := pcommon.NewMap()
				raw := maps.Clone(in)
				raw[keyStellarNetwork] = n
				for key, v := range raw {
					if s, ok := v.(string); ok && s == absent {
						delete(raw, key)
					}
				}
				if err := src.FromRaw(raw); err != nil {
					t.Fatal(err)
				}
				dst := pcommon.NewMap()
				stellarAttrs(k, src, dst)
				seen[mapKey(dst)] = true
			}
		}
		return len(seen)
	}
	product := func(axes map[string][]any) []map[string]any {
		out := []map[string]any{{}}
		for key, vs := range axes {
			var next []map[string]any
			for _, base := range out {
				for _, v := range vs {
					m := maps.Clone(base)
					m[key] = v
					next = append(next, m)
				}
			}
			out = next
		}
		return out
	}
	anyOf := func(ss []string) []any {
		out := make([]any, len(ss))
		for i, s := range ss {
			out[i] = s
		}
		return out
	}
	var statuses []any
	for _, s := range stellarHTTPStatuses {
		statuses = append(statuses, s)
	}
	statuses = append(statuses, int64(418), int64(299), absent)

	cases := []struct {
		k    stellarKind
		axes map[string][]any
		max  int
	}{
		{stellarRPCDuration, map[string][]any{keyRPCMethod: anyOf(vals(stellarRPCMethods, "junk")),
			keyErrorType: anyOf(vals(stellarRPCErrorTypes, "junk", absent))}, 1960},
		{stellarHTTPDuration, map[string][]any{keyMethod: anyOf([]string{"GET", "POST", "PUT", absent}),
			keyURLTemplate: anyOf(vals(stellarHorizonTemplates, "junk")), keyStatus: statuses,
			keyErrorType: anyOf([]string{"timeout", "network", "junk", absent})}, 3 * 51 * 32 * 5},
		{stellarSubmissions, map[string][]any{keyStellarVia: anyOf(vals(stellarVia, "junk")),
			keyStellarStatus: anyOf(vals(stellarSubmitStatuses, "junk")), keyStellarResult: anyOf(vals(stellarResultClasses, "junk", absent))}, 555},
		{stellarPolls, map[string][]any{keyStellarStatus: anyOf(vals(stellarPollStatuses, "junk")),
			keyStellarResult: anyOf(vals(stellarResultClasses, "junk", absent))}, 95},
		{stellarSimulations, map[string][]any{keySimOutcome: anyOf(vals(stellarSimOutcomes, "junk")),
			keySimErrorClass: anyOf(vals(stellarSimErrorClases, "junk", absent))}, 65},
	}
	for _, c := range cases {
		n := distinct(c.k, product(c.axes))
		t.Logf("%s: %d distinct attribute sets (bound %d)", c.k.name(), n, c.max)
		if n != c.max {
			t.Errorf("%s: %d distinct attribute sets, the documented bound is %d (update stellar.go's header)", c.k.name(), n, c.max)
		}
	}
}

// Hostile values (seeds, StrKeys, muxed addresses, JWTs, e-mails, IPs, URLs with queries, canaries) in every input
// key of every Stellar metric, marker keys included: nothing survives, every output value is a closed-set constant,
// and the output passes the proto-level allow-list.
func TestStellarNoSecretSurvives(t *testing.T) {
	h := newHarness(t, stellarOn)
	g := &hostileGen{r: rand.New(rand.NewPCG(2026, 1119))}
	keys := []string{keyRPCMethod, keyErrorType, keyRPCStatusCode, keyURLTemplate, keyMethod, keyStellarVia,
		keyStellarStatus, keyStellarResult, keySimOutcome, keySimErrorClass, "url.full", "server.address",
		"stellar.account", "tx.hash", "error.message"}
	kept := 0
	for i := range 400 {
		g.fuzz = "st" + string(rune('a'+i%26))
		md, ms := stellarMetrics("dapp")
		g.resourceAttrs(md.ResourceMetrics().At(0).Resource().Attributes(), i)
		g.scope(md.ResourceMetrics().At(0).ScopeMetrics().At(0).Scope())
		hostileAttrs := func(m pcommon.Map, marker map[string]any) {
			for j, k := range keys {
				g.put(m, k, i+j, k == keyURLTemplate)
			}
			g.pointAttrs(m, i)
			for k, v := range marker {
				_ = m.FromRaw(merge(m.AsRaw(), map[string]any{k: v}))
			}
		}
		for _, name := range []string{MetricRPCClientDuration, MetricHTTPClientDuration} {
			pts := histOf(ms, name, "s")
			for p := range 3 {
				dp := addHistPoint(pts, testRecv, nil)
				hostileAttrs(dp.Attributes(), map[string]any{keyRPCSystemName: stellarJSONRPC, keyStellarNetwork: g.text(),
					keyURLTemplate: g.path()})
				if p == 0 {
					dp.Attributes().PutStr(keyStellarNetwork, "testnet")
				}
			}
		}
		for _, name := range []string{MetricStellarSubmissions, MetricStellarPolls, MetricStellarSimulations} {
			dps := sumOf(ms, name, true)
			for range 3 {
				addCount(dps, testRecv, 1, nil)
				hostileAttrs(dps.At(dps.Len()-1).Attributes(), map[string]any{keyStellarNetwork: g.text()})
			}
		}
		out := h.runMetrics(defaultMeta(), md)
		for _, n := range checkStellarInvariants(t, out) {
			kept += n
		}
		checkHostileOutput(t, "stellar", marshalMetrics(t, out), func(f func(string, string)) { assertProtoAllowListMetrics(t, out, f) })
		if t.Failed() {
			return
		}
	}
	if kept == 0 {
		t.Fatal("nothing kept: the test would prove nothing")
	}
	t.Logf("%d hostile values, %d points kept", g.vals, kept)
}

func merge(a, b map[string]any) map[string]any {
	out := maps.Clone(a)
	maps.Copy(out, b)
	return out
}

// The closed sets here and in packages/stellar-otel/src/classify.ts must be identical: a value the package emits
// must never be rewritten to _OTHER by the Collector, and the Collector must not accept a value the package cannot
// emit.
func TestStellarSetsMatchPackage(t *testing.T) {
	src := string(readFile(t, "../../../packages/stellar-otel/src/classify.ts"))
	array := func(name string) []string {
		re := regexp.MustCompile(`(?s)export const ` + name + ` = \[(.*?)\] as const;`)
		m := re.FindStringSubmatch(src)
		if m == nil {
			t.Fatalf("%s not found in classify.ts", name)
		}
		var out []string
		for _, v := range regexp.MustCompile(`"([^"]*)"|(-?\d+)`).FindAllStringSubmatch(m[1], -1) {
			if v[1] != "" {
				out = append(out, v[1])
			} else {
				out = append(out, v[2])
			}
		}
		return out
	}
	eq := func(name string, got []string, want set) {
		t.Helper()
		if len(got) != len(want) {
			t.Errorf("%s: package has %d values, Collector %d", name, len(got), len(want))
		}
		for _, v := range got {
			if _, ok := want[v]; !ok {
				t.Errorf("%s: package value %q not in the Collector's set", name, v)
			}
		}
	}
	eq("RPC_METHODS", array("RPC_METHODS"), stellarRPCMethods)
	eq("NETWORKS", array("NETWORKS"), stellarNetworks)
	eq("RESULT_CLASSES", array("RESULT_CLASSES"), stellarResultClasses)
	eq("SIM_ERROR_CLASSES", array("SIM_ERROR_CLASSES"), stellarSimErrorClases)
	eq("SUBMIT_STATUSES", array("SUBMIT_STATUSES"), stellarSubmitStatuses)
	eq("POLL_STATUSES", array("POLL_STATUSES"), stellarPollStatuses)
	eq("SIM_OUTCOMES", array("SIM_OUTCOMES"), stellarSimOutcomes)
	eq("JSONRPC_CODES", array("JSONRPC_CODES"), stellarJSONCodes)
	eq("HORIZON_TEMPLATES", array("HORIZON_TEMPLATES"), stellarHorizonTemplates)
	statuses := newSet()
	for _, s := range stellarHTTPStatuses {
		statuses[strconv.FormatInt(s, 10)] = struct{}{}
	}
	eq("HTTP_STATUSES", array("HTTP_STATUSES"), statuses)
}
