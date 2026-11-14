// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"runtime"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// Regression tests for the G1 review findings fixed under C-114 (finding
// numbers of the review in brackets).

// withEntityRefs adds resource entity references (which pdata v1.71 has no
// setter for) through the JSON form.
func withEntityRefs(t testing.TB, b []byte, refs []map[string]any) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	for _, list := range []string{"resourceMetrics", "resourceSpans"} {
		rs, _ := doc[list].([]any)
		for _, r := range rs {
			res := r.(map[string]any)["resource"].(map[string]any)
			res["entityRefs"] = refs
		}
	}
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func hostileEntityRefs(r *rand.Rand) []map[string]any {
	return []map[string]any{{
		"schemaUrl":       "https://schema.example/" + testSeed(r.Uint64()) + "?token=" + testJWT(r),
		"type":            "canary-" + testEmail(r),
		"idKeys":          []string{"203.0.113.77:8080", testAccount(r)},
		"descriptionKeys": []string{testMuxed(r), "https://x.example/p?q=" + testEmail(r)},
	}}
}

// [1] Resource entity references must not pass.
func TestG1EntityRefsDoNotPass(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 1))
	h := newHarness(t)

	md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
	addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a"})
	in, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(withEntityRefs(t, marshalMetrics(t, md), hostileEntityRefs(r)))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(marshalMetrics(t, in)), "entityRefs") {
		t.Fatal("test input has no entity refs")
	}
	out := h.runMetrics(defaultMeta(), in)
	if out.DataPointCount() == 0 {
		t.Fatal("nothing forwarded")
	}
	assertProtoAllowListMetrics(t, out, func(string, string) {})
	assertNoLeak(t, "metrics", marshalMetrics(t, out), true)

	td, spans := newSpans("checkout")
	addServerSpan(spans, testRecv-second, map[string]any{"http.route": "/a"})
	tin, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces(withEntityRefs(t, marshalTraces(t, td), hostileEntityRefs(r)))
	if err != nil {
		t.Fatal(err)
	}
	tout := h.runTraces(defaultMeta(), tin)
	if tout.SpanCount() == 0 {
		t.Fatal("nothing forwarded")
	}
	assertProtoAllowListTraces(t, tout, func(string, string) {})
	assertNoLeak(t, "traces", marshalTraces(t, tout), true)
}

// hostileValues are free-text values the classifier must replace (C-114).
func hostileValues(r *rand.Rand) map[string]string {
	return map[string]string{
		"seed":          testSeed(r.Uint64()),
		"seed in text":  "svc " + strings.ToLower(testSeed(r.Uint64())) + " x",
		"G address":     testAccount(r),
		"muxed address": testMuxed(r),
		"contract":      testContract(r),
		"jwt":           testJWT(r),
		"email":         testEmail(r),
		"ipv4":          "203.0.113.77",
		"ipv4 port":     "203.0.113.77:8080",
		"ipv4 in text":  "node-203.0.113.77",
		"ipv6":          "2001:db8::7",
		"ipv6 port":     "[2001:db8::7]:443",
		"url query":     "https://x.example/p?token=abc",
		"path query":    "/login?user=bob",
		"api key":       "sk_live_" + b32.EncodeToString(payload(r, 20)),
		"bad strkey":    "GZ" + strings.Repeat("A", 54),
	}
}

// [7] Kept free-text values are classified; benign values stay.
func TestG1FreeTextValuesAreClassified(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 7))
	h := newHarness(t)
	keys := []string{keyServiceName, keyServiceNamespace, keyServiceInstance, keyDeployEnvName, keyDeployEnvLegacy}
	for name, v := range hostileValues(r) {
		for _, k := range keys {
			t.Run(name+"/"+k, func(t *testing.T) {
				md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
				md.ResourceMetrics().At(0).Resource().Attributes().PutStr(k, v)
				sm := md.ResourceMetrics().At(0).ScopeMetrics().At(0)
				sm.Scope().SetName(v)
				sm.Scope().SetVersion(v)
				addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "rpc.method": v, "rpc.system": v, "rpc.system.name": v})
				out := h.runMetrics(defaultMeta(), md)
				b := marshalMetrics(t, out)
				if strings.Contains(string(b), v) || strings.Contains(string(b), jsonEscaped(v)) {
					t.Fatalf("value survived: %s", b)
				}
				res := out.ResourceMetrics().At(0).Resource().Attributes()
				outKey := k
				if k == keyDeployEnvLegacy {
					outKey = keyDeployEnvName
				}
				if got, _ := res.Get(outKey); got.Str() != Redacted {
					t.Errorf("%s = %q, want %q", outKey, got.Str(), Redacted)
				}
				if k == keyServiceInstance {
					// A redacted instance id is no stream identity (finding 2): the writer falls back to start times.
					if got, _ := res.Get(AttrStreamInstance); got.Str() != NoInstance {
						t.Errorf("scf.stream.instance = %q, want %q", got.Str(), NoInstance)
					}
				}
				osm := out.ResourceMetrics().At(0).ScopeMetrics().At(0)
				if osm.Scope().Name() != Redacted || osm.Scope().Version() != Redacted {
					t.Errorf("scope = %q %q", osm.Scope().Name(), osm.Scope().Version())
				}
			})
		}
	}
	t.Run("benign values are kept", func(t *testing.T) {
		md, dps := newHistMetrics("s06a-express-sdk", MetricServerDuration, "s")
		attrs := md.ResourceMetrics().At(0).Resource().Attributes()
		attrs.PutStr(keyServiceInstance, "00000000-0000-4000-8000-000000000001")
		attrs.PutStr(keyServiceNamespace, "shop")
		attrs.PutStr(keyDeployEnvName, "production")
		md.ResourceMetrics().At(0).ScopeMetrics().At(0).Scope().SetName("@opentelemetry/instrumentation-http")
		md.ResourceMetrics().At(0).ScopeMetrics().At(0).Scope().SetVersion("2.33.1-alpha")
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "rpc.method": "pkg.Service/GetAccount", "rpc.system": "grpc"})
		out := h.runMetrics(defaultMeta(), md)
		res := out.ResourceMetrics().At(0).Resource().Attributes().AsRaw()
		for k, want := range map[string]any{keyServiceName: "s06a-express-sdk", keyServiceInstance: "00000000-0000-4000-8000-000000000001",
			keyServiceNamespace: "shop", keyDeployEnvName: "production", AttrStreamInstance: "00000000-0000-4000-8000-000000000001"} {
			if res[k] != want {
				t.Errorf("%s = %v, want %v", k, res[k], want)
			}
		}
		sc := out.ResourceMetrics().At(0).ScopeMetrics().At(0).Scope()
		if sc.Name() != "@opentelemetry/instrumentation-http" || sc.Version() != "2.33.1-alpha" {
			t.Errorf("scope %q %q", sc.Name(), sc.Version())
		}
		p := onlyPoint(t, out, MetricServerDuration).Attributes().AsRaw()
		if p[keyRPCMethod] != "pkg.Service/GetAccount" || p[keyRPCSystem] != "grpc" {
			t.Errorf("rpc %v", p)
		}
	})
	t.Run("rpc values outside the strict charset are dropped", func(t *testing.T) {
		md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
		addHistPoint(dps, testRecv-second, map[string]any{"rpc.method": "Get Account", "rpc.system": "grpc;drop", "rpc.system.name": "ünï"})
		p := onlyPoint(t, h.runMetrics(defaultMeta(), md), MetricServerDuration).Attributes().AsRaw()
		for _, k := range []string{keyRPCMethod, keyRPCSystem, keyRPCSystemName} {
			if _, ok := p[k]; ok {
				t.Errorf("%s kept: %v", k, p[k])
			}
		}
	})
	t.Run("a non-allowed service is reported under a fixed name", func(t *testing.T) {
		m := defaultMeta()
		m.allowed = "checkout"
		seed := testSeed(99)
		md, dps := newHistMetrics(seed, MetricServerDuration, "s")
		addHistPoint(dps, testRecv-second, nil)
		out := h.runMetrics(m, md)
		if strings.Contains(string(marshalMetrics(t, out)), seed) {
			t.Fatal("non-allowed service name echoed")
		}
		if got := droppedCounts(t, out); got[ServiceNotAllowedName+"/"+ReasonServiceNotAllowed] != 1 {
			t.Fatalf("counts %v", got)
		}
	})
}

func jsonEscaped(s string) string {
	b, _ := json.Marshal(s)
	return strings.Trim(string(b), `"`)
}

func TestSensitiveValueClassifier(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 3))
	for name, v := range hostileValues(r) {
		if !sensitiveValue(v) {
			t.Errorf("%s: %q not flagged", name, v)
		}
	}
	for _, v := range []string{"checkout", "s06b-rust-tower", "rust-tower-replica-1", "00000000-0000-4000-8000-000000000001",
		"production", "staging", "2.33.1-alpha", "0.66b2", "@opentelemetry/instrumentation-http", "Microsoft.AspNetCore.Hosting",
		"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", "io.opentelemetry.tomcat-10.0", "grpc", "pkg.Service/GetAccount",
		"https://api.example.com", "checkout-7d9f8b6c4-x2k9p", "host:8080"} {
		if sensitiveValue(v) {
			t.Errorf("benign %q flagged", v)
		}
	}
}

// expMetrics builds one cumulative exponential-histogram metric with the
// given points (attributes differ in server.address, so they collapse).
func expMetrics(withInstance bool, pts ...pmetric.ExponentialHistogramDataPoint) pmetric.Metrics {
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	r.Resource().Attributes().PutStr("service.name", "checkout")
	if withInstance {
		r.Resource().Attributes().PutStr("service.instance.id", "i-1")
	}
	m := r.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName(MetricServerDuration)
	m.SetUnit("s")
	h := m.SetEmptyExponentialHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	for i, p := range pts {
		dp := h.DataPoints().AppendEmpty()
		p.CopyTo(dp)
		dp.SetStartTimestamp(pcommon.Timestamp(testRecv - minute))
		dp.SetTimestamp(pcommon.Timestamp(testRecv - second))
		dp.Attributes().PutStr("http.route", "/a")
		dp.Attributes().PutStr("server.address", fmt.Sprintf("h%d", i))
	}
	return md
}

// [2] Hostile exponential histograms: no huge allocation, no panic,
// malformed points dropped and counted.
func TestG1ExpHistogramHostileLayouts(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name      string
		pts       []pmetric.ExponentialHistogramDataPoint
		malformed int64
		outPoints int
	}{
		{name: "offsets 0 and 1<<25 at scale 20 are not merged into 33M buckets",
			pts: []pmetric.ExponentialHistogramDataPoint{expPoint(20, 0, []uint64{1}, 0), expPoint(20, 1<<25, []uint64{1}, 0)}, outPoints: 2},
		{name: "offset 1<<30 at scale 0 is out of range",
			pts: []pmetric.ExponentialHistogramDataPoint{expPoint(0, 0, []uint64{1}, 0), expPoint(0, 1<<30, []uint64{1}, 0)}, malformed: 1, outPoints: 1},
		{name: "MinInt32 and MaxInt32 offsets",
			pts: []pmetric.ExponentialHistogramDataPoint{expPoint(0, math.MinInt32, []uint64{1}, 0), expPoint(0, math.MaxInt32, []uint64{1}, 0)}, malformed: 2},
		{name: "scale -1 merged with MaxInt32 at scale 0",
			pts: []pmetric.ExponentialHistogramDataPoint{expPoint(-1, 0, []uint64{1}, 0), expPoint(0, math.MaxInt32-1, []uint64{1, 1}, 0)}, malformed: 1, outPoints: 1},
		{name: "more than 320 buckets",
			pts: []pmetric.ExponentialHistogramDataPoint{expPoint(3, 0, make([]uint64, 321), 1)}, malformed: 1},
		{name: "320 buckets at the range edge are fine",
			pts: []pmetric.ExponentialHistogramDataPoint{expPoint(3, 1075*8-320+1, make([]uint64, 320), 1)}, outPoints: 1},
		{name: "scale 20 merged with scale -10 at the extremes",
			pts: []pmetric.ExponentialHistogramDataPoint{expPoint(20, -1075<<20, []uint64{1}, 0), expPoint(-10, 1, []uint64{1}, 0)}, outPoints: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := h.selfCounter(MetricDropped, map[string]string{"reason": ReasonMalformedPoint})
			var ms0, ms1 runtime.MemStats
			runtime.ReadMemStats(&ms0)
			out := h.runMetrics(defaultMeta(), expMetrics(true, tc.pts...))
			runtime.ReadMemStats(&ms1)
			if d := ms1.TotalAlloc - ms0.TotalAlloc; d > 32<<20 {
				t.Fatalf("allocated %d MiB", d>>20)
			}
			got := h.selfCounter(MetricDropped, map[string]string{"reason": ReasonMalformedPoint}) - before
			if got != tc.malformed {
				t.Errorf("malformed = %d, want %d", got, tc.malformed)
			}
			n := 0
			for _, rm := range out.ResourceMetrics().All() {
				for _, sm := range rm.ScopeMetrics().All() {
					for _, m := range sm.Metrics().All() {
						if m.Type() == pmetric.MetricTypeExponentialHistogram {
							n += m.ExponentialHistogram().DataPoints().Len()
							for _, dp := range m.ExponentialHistogram().DataPoints().All() {
								if !validExpHistogram(dp) {
									t.Errorf("invalid point forwarded: scale %d off %d len %d", dp.Scale(), dp.Positive().Offset(), dp.Positive().BucketCounts().Len())
								}
							}
						}
					}
				}
			}
			if n != tc.outPoints {
				t.Errorf("points out = %d, want %d", n, tc.outPoints)
			}
		})
	}
}

// [2] A panic while processing one request is recovered, counted and the
// request dropped; the Collector keeps running.
func TestG1PanicIsRecovered(t *testing.T) {
	h := newHarness(t)
	testPanicHook = func() { panic("boom") }
	t.Cleanup(func() { testPanicHook = nil })
	md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
	addHistPoint(dps, testRecv-second, nil)
	out := h.runMetrics(defaultMeta(), md)
	if got := droppedCounts(t, out); got[UnknownService+"/"+ReasonMalformedPoint] != 1 {
		t.Fatalf("counts %v", got)
	}
	td, spans := newSpans("checkout")
	addServerSpan(spans, testRecv-second, nil)
	tout := h.runTraces(defaultMeta(), td)
	if got := markerCounts(t, tout); got[UnknownService+"/"+ReasonMalformedPoint] != 1 {
		t.Fatalf("markers %v", got)
	}
	if h.selfCounter(MetricDropped, map[string]string{"reason": ReasonMalformedPoint}) != 2 {
		t.Fatal("not counted")
	}
}

// [8] Two snapshots of one cumulative stream (same original attributes) are
// never added up; points are merged only when their original attribute sets
// differed and their timestamps are equal.
func TestG1MergeOnlyDifferentOriginalsAtEqualTime(t *testing.T) {
	h := newHarness(t)
	mk := func() (pmetric.Metrics, pmetric.HistogramDataPointSlice) {
		md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
		md.ResourceMetrics().At(0).Resource().Attributes().PutStr("service.instance.id", "i-1")
		return md, dps
	}
	counts := func(md pmetric.Metrics) []uint64 {
		var c []uint64
		for _, r := range md.ResourceMetrics().All() {
			for _, sm := range r.ScopeMetrics().All() {
				for _, m := range sm.Metrics().All() {
					if m.Name() == MetricServerDuration {
						for _, dp := range m.Histogram().DataPoints().All() {
							c = append(c, dp.Count())
						}
					}
				}
			}
		}
		return c
	}
	t.Run("same original attributes are two snapshots", func(t *testing.T) {
		md, dps := mk()
		a := addHistPoint(dps, testRecv-2*second, map[string]any{"http.route": "/a"})
		b := addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a"})
		b.BucketCounts().FromRaw([]uint64{2, 3, 0})
		b.SetCount(5)
		_ = a
		if got := counts(h.runMetrics(defaultMeta(), md)); len(got) != 2 || got[0]+got[1] != 8 {
			t.Fatalf("counts %v: snapshots were merged", got)
		}
	})
	t.Run("same original attributes and same time are still not summed", func(t *testing.T) {
		md, dps := mk()
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a"})
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a"})
		if got := counts(h.runMetrics(defaultMeta(), md)); len(got) != 2 {
			t.Fatalf("counts %v", got)
		}
	})
	t.Run("different originals at the same time merge", func(t *testing.T) {
		md, dps := mk()
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "server.address": "x"})
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "server.address": "y"})
		if got := counts(h.runMetrics(defaultMeta(), md)); len(got) != 1 || got[0] != 6 {
			t.Fatalf("counts %v", got)
		}
	})
	t.Run("different originals at different times stay separate", func(t *testing.T) {
		md, dps := mk()
		addHistPoint(dps, testRecv-2*second, map[string]any{"http.route": "/a", "server.address": "x"})
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "server.address": "y"})
		if got := counts(h.runMetrics(defaultMeta(), md)); len(got) != 2 {
			t.Fatalf("counts %v", got)
		}
	})
	t.Run("a third point repeating an original is not folded in", func(t *testing.T) {
		md, dps := mk()
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "server.address": "x"})
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "server.address": "y"})
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "server.address": "x"})
		if got := counts(h.runMetrics(defaultMeta(), md)); len(got) != 2 || got[0]+got[1] != 9 {
			t.Fatalf("counts %v", got)
		}
	})
}

// [9] 20,000 points with distinct bounds that collapse to one attribute set
// are processed in linear time.
func TestG1MergeIsNotQuadratic(t *testing.T) {
	h := newHarness(t)
	md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
	md.ResourceMetrics().At(0).Resource().Attributes().PutStr("service.instance.id", "i-1")
	for i := range 20_000 {
		p := addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a", "server.address": fmt.Sprintf("h%d", i)})
		p.ExplicitBounds().FromRaw([]float64{0.1 + float64(i)*1e-6, 1})
	}
	start := time.Now()
	out := h.runMetrics(defaultMeta(), md)
	if d := time.Since(start); d > time.Second {
		t.Fatalf("took %v", d)
	}
	if out.DataPointCount() != 20_000 {
		t.Fatalf("points %d", out.DataPointCount())
	}
}

// [19] Tenant-controlled multipliers are bounded.
func TestG1SamplingDurationAndFlagsBounded(t *testing.T) {
	h := newHarness(t)
	t.Run("adjusted count is capped", func(t *testing.T) {
		for in, want := range map[string]string{
			"ot=th:ffffffffffffff": MaxSamplingThreshold, "ot=th:fff": MaxSamplingThreshold,
			"ot=th:ffc": "ot=th:ffc", "ot=th:c": "ot=th:c", "ot=th:0": "ot=th:0", "ot=th:80000000000000": "ot=th:8",
		} {
			td, spans := newSpans("checkout")
			sp := addServerSpan(spans, testRecv-second, map[string]any{"http.route": "/a"})
			sp.TraceState().FromRaw(in)
			out := h.runTraces(defaultMeta(), td)
			got := out.ResourceSpans().At(0).ScopeSpans().At(0).Spans().At(0).TraceState().AsRaw()
			if got != want {
				t.Errorf("%s → %q, want %q", in, got, want)
			}
		}
	})
	t.Run("span duration is bounded", func(t *testing.T) {
		td, spans := newSpans("checkout")
		sp := addServerSpan(spans, testRecv-second, map[string]any{"http.route": "/a"})
		sp.SetStartTimestamp(1)
		out := h.runTraces(defaultMeta(), td)
		if got := markerCounts(t, out); got["checkout/"+ReasonMalformedPoint] != 1 {
			t.Fatalf("markers %v", got)
		}
	})
	t.Run("point and span flags are masked", func(t *testing.T) {
		md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
		addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/a"}).SetFlags(pmetric.DataPointFlags(0xfffffffe))
		if f := onlyPoint(t, h.runMetrics(defaultMeta(), md), MetricServerDuration).Flags(); f != 0 {
			t.Errorf("point flags %#x", f)
		}
		td, spans := newSpans("checkout")
		addServerSpan(spans, testRecv-second, map[string]any{"http.route": "/a"}).SetFlags(0xffffffff)
		out := h.runTraces(defaultMeta(), td)
		if f := out.ResourceSpans().At(0).ScopeSpans().At(0).Spans().At(0).Flags(); f != spanFlagsMask {
			t.Errorf("span flags %#x", f)
		}
	})
}
