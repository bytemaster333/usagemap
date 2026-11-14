// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"bytes"
	"maps"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

func TestMetricsTenantOverwriteAndStamping(t *testing.T) {
	h := newHarness(t)
	md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
	res := md.ResourceMetrics().At(0).Resource().Attributes()
	res.PutStr("tenant.id", "FORGED-TENANT")
	res.PutStr("scf.tenant.id", "22222222-2222-4222-8222-222222222222")
	res.PutInt("scf.received_at_unix_nano", 1)
	res.PutStr("service.instance.id", "inst-1")
	addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/users/{id}", "http.request.method": "GET", "http.response.status_code": 200,
		"tenant.id": "FORGED-TENANT", "scf.tenant.id": "FORGED"})

	out := h.runMetrics(defaultMeta(), md)
	if out.ResourceMetrics().Len() != 1 {
		t.Fatalf("resources = %d", out.ResourceMetrics().Len())
	}
	got := out.ResourceMetrics().At(0).Resource().Attributes().AsRaw()
	want := map[string]any{"service.name": "checkout", "service.instance.id": "inst-1", AttrTenantID: testTenant,
		AttrReceivedAt: testRecv, AttrStreamInstance: "inst-1"}
	if !maps.Equal(got, want) {
		t.Fatalf("resource = %v\nwant %v", got, want)
	}
	dp := onlyPoint(t, out, MetricServerDuration)
	pa := dp.Attributes().AsRaw()
	wantPA := map[string]any{AttrRoute: "/users/{id}", AttrRulesVersion: "scf-path-rules/1.1.0", "http.request.method": "GET", "http.response.status_code": int64(200)}
	if !maps.Equal(pa, wantPA) {
		t.Fatalf("point attributes = %v\nwant %v", pa, wantPA)
	}
	if b := marshalMetrics(t, out); bytes.Contains(b, []byte("FORGED")) {
		t.Fatal("forged tenant survived")
	}
}

func TestMetricsNoTenantDropsRequest(t *testing.T) {
	h := newHarness(t)
	md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
	addHistPoint(dps, testRecv, nil)
	addHistPoint(dps, testRecv, map[string]any{"http.route": "/x"})
	for _, m := range []meta{{allowed: "*"}, {tenant: "FORGED-TENANT", allowed: "*"}} {
		out := h.runMetrics(m, md)
		if out.ResourceMetrics().Len() != 0 {
			t.Fatalf("request without valid tenant produced output")
		}
	}
	if n := h.selfCounter(MetricDropped, map[string]string{"signal": "metrics", "reason": ReasonNoTenant}); n != 4 {
		t.Fatalf("no_tenant counter = %d, want 4", n)
	}
}

func TestMetricsAllowListAndReasons(t *testing.T) {
	h := newHarness(t)
	md := pmetric.NewMetrics()
	add := func(service string, build func(pmetric.MetricSlice)) {
		r := md.ResourceMetrics().AppendEmpty()
		r.Resource().Attributes().PutStr("service.name", service)
		build(r.ScopeMetrics().AppendEmpty().Metrics())
	}
	hist := func(ms pmetric.MetricSlice, name, unit string, n int, ts int64) pmetric.Metric {
		m := ms.AppendEmpty()
		m.SetName(name)
		m.SetUnit(unit)
		h := m.SetEmptyHistogram()
		h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
		for i := range n {
			addHistPoint(h.DataPoints(), ts, map[string]any{"http.route": "/r/" + string(rune('a'+i))})
		}
		return m
	}
	add("checkout", func(ms pmetric.MetricSlice) {
		hist(ms, MetricServerDuration, "s", 2, testRecv-second)      // kept
		hist(ms, "http.client.request.duration", "s", 3, testRecv)   // client_metric_ignored
		hist(ms, "http.server.request.body.size", "By", 1, testRecv) // metric_not_allowed
		g := ms.AppendEmpty()                                        // metric_not_allowed
		g.SetName("jvm.memory.used")
		g.SetEmptyGauge().DataPoints().AppendEmpty().SetIntValue(1)
		hist(ms, MetricServerDuration, "us", 2, testRecv) // malformed_point (unit)
		s := ms.AppendEmpty()                             // malformed_point (not a histogram)
		s.SetName(MetricServerDurationLegacy)
		s.SetUnit("ms")
		s.SetEmptySum().DataPoints().AppendEmpty().SetDoubleValue(1)
		hist(ms, MetricServerDuration, "s", 1, testRecv+5*minute+1)                             // future
		hist(ms, MetricServerDuration, "s", 1, testRecv-48*hour-1)                              // too_old
		hist(ms, MetricServerDuration, "s", 1, testRecv+5*minute).SetName(MetricServerDuration) // boundary: kept
	})
	add("forbidden-svc", func(ms pmetric.MetricSlice) { hist(ms, MetricServerDuration, "s", 4, testRecv) })
	add("checkout", func(ms pmetric.MetricSlice) {
		m := hist(ms, MetricServerDuration, "s", 1, testRecv)
		m.Histogram().SetAggregationTemporality(pmetric.AggregationTemporalityUnspecified) // malformed_point
		bad := hist(ms, MetricServerDuration, "s", 2, testRecv)
		bad.Histogram().DataPoints().At(0).BucketCounts().FromRaw([]uint64{1, 1}) // wrong bucket count → malformed
		bad.Histogram().DataPoints().At(1).SetCount(99)                           // buckets do not add up → malformed
	})

	m := defaultMeta()
	m.allowed = "checkout,unused"
	out := h.runMetrics(m, md)

	want := map[string]int64{
		"checkout/" + ReasonClientMetric:                      3,
		"checkout/" + ReasonMetricNotAllowed:                  2,
		"checkout/" + ReasonMalformedPoint:                    2 + 1 + 1 + 2,
		"checkout/" + ReasonFuture:                            1,
		"checkout/" + ReasonTooOld:                            1,
		ServiceNotAllowedName + "/" + ReasonServiceNotAllowed: 4,
	}
	if got := droppedCounts(t, out); !maps.Equal(got, want) {
		t.Fatalf("scf.ingest.dropped = %v\nwant %v", got, want)
	}
	kept := 0
	for _, r := range out.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() == MetricIngestDropped {
					continue
				}
				if m.Name() != MetricServerDuration || m.Unit() != "s" {
					t.Errorf("unexpected metric %s %s", m.Name(), m.Unit())
				}
				kept += metricPoints(m)
			}
		}
	}
	if kept != 3 {
		t.Fatalf("kept points = %d, want 3", kept)
	}
	for reason, n := range map[string]int64{ReasonClientMetric: 3, ReasonServiceNotAllowed: 4, ReasonMalformedPoint: 6} {
		if got := h.selfCounter(MetricDropped, map[string]string{"signal": "metrics", "reason": reason}); got != n {
			t.Errorf("self-metric %s = %d, want %d", reason, got, n)
		}
	}
}

func TestMetricsDropCounterShape(t *testing.T) {
	h := newHarness(t)
	md, dps := newHistMetrics("checkout", "http.client.request.duration", "s")
	addHistPoint(dps, testRecv, nil)
	out := h.runMetrics(defaultMeta(), md)
	if out.ResourceMetrics().Len() != 1 {
		t.Fatalf("resources = %d", out.ResourceMetrics().Len())
	}
	r := out.ResourceMetrics().At(0)
	if got := r.Resource().Attributes().AsRaw(); !maps.Equal(got, map[string]any{AttrTenantID: testTenant, AttrReceivedAt: testRecv, AttrStreamInstance: NoInstance}) {
		t.Fatalf("counter resource = %v", got)
	}
	sm := r.ScopeMetrics().At(0)
	if sm.Scope().Name() != ScopeName || sm.Scope().Version() != ScopeVersion {
		t.Fatalf("scope = %s %s", sm.Scope().Name(), sm.Scope().Version())
	}
	m := sm.Metrics().At(0)
	if m.Name() != MetricIngestDropped || m.Unit() != "{point}" || m.Type() != pmetric.MetricTypeSum ||
		!m.Sum().IsMonotonic() || m.Sum().AggregationTemporality() != pmetric.AggregationTemporalityDelta {
		t.Fatalf("counter metric shape wrong: %s %s %v", m.Name(), m.Unit(), m.Type())
	}
	dp := m.Sum().DataPoints().At(0)
	if dp.ValueType() != pmetric.NumberDataPointValueTypeInt || dp.IntValue() != 1 || int64(dp.Timestamp()) != testRecv {
		t.Fatalf("counter point wrong: %v %d %d", dp.ValueType(), dp.IntValue(), dp.Timestamp())
	}
}

func TestMetricsLegacyMillisecondsConverted(t *testing.T) {
	h := newHarness(t)
	md, dps := newHistMetrics("py", MetricServerDurationLegacy, "ms")
	dp := dps.AppendEmpty()
	dp.SetStartTimestamp(pcommon.Timestamp(testRecv - minute))
	dp.SetTimestamp(pcommon.Timestamp(testRecv - second))
	dp.ExplicitBounds().FromRaw([]float64{0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000})
	dp.BucketCounts().FromRaw([]uint64{0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0})
	dp.SetCount(4)
	dp.SetSum(23)
	dp.SetMin(2)
	dp.SetMax(8)
	_ = dp.Attributes().FromRaw(map[string]any{"http.target": "/accounts/{account_id}", "http.method": "GET", "http.status_code": 200,
		"http.host": "127.0.0.1:18542", "http.server_name": "x", "net.host.port": 18542, "http.flavor": "1.1"})
	ex := dp.Exemplars().AppendEmpty()
	ex.SetDoubleValue(5)
	ex.FilteredAttributes().PutStr("enduser.id", "CANARY-USER")

	out := h.runMetrics(defaultMeta(), md)
	var m pmetric.Metric
	for _, x := range out.ResourceMetrics().At(0).ScopeMetrics().At(0).Metrics().All() {
		m = x
	}
	if m.Name() != MetricServerDurationLegacy || m.Unit() != "s" {
		t.Fatalf("metric = %s %s (name must stay legacy for the sdk_legacy group)", m.Name(), m.Unit())
	}
	got := m.Histogram().DataPoints().At(0)
	wantBounds := []float64{0, 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10}
	if b := got.ExplicitBounds().AsRaw(); !equalFloats(b, wantBounds) {
		t.Fatalf("bounds = %v", b)
	}
	if got.Sum() != 0.023 || got.Min() != 0.002 || got.Max() != 0.008 || got.Count() != 4 {
		t.Fatalf("sum/min/max/count = %v %v %v %d", got.Sum(), got.Min(), got.Max(), got.Count())
	}
	if got.Exemplars().Len() != 0 {
		t.Fatal("exemplars kept")
	}
	want := map[string]any{AttrRoute: "/accounts/{account_id}", AttrRulesVersion: "scf-path-rules/1.1.0", "http.request.method": "GET", "http.response.status_code": int64(200)}
	if a := got.Attributes().AsRaw(); !maps.Equal(a, want) {
		t.Fatalf("attributes = %v", a)
	}
}

func equalFloats(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestMetricsExponentialHistogramMilliseconds(t *testing.T) {
	h := newHarness(t)
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	r.Resource().Attributes().PutStr("service.name", "svc")
	m := r.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName(MetricServerDuration)
	m.SetUnit("ms")
	eh := m.SetEmptyExponentialHistogram()
	eh.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	dp := eh.DataPoints().AppendEmpty()
	dp.SetTimestamp(pcommon.Timestamp(testRecv))
	dp.SetScale(3)
	dp.Positive().SetOffset(26) // 2^(26/8) ≈ 9.5 ms
	dp.Positive().BucketCounts().FromRaw([]uint64{2})
	dp.SetCount(2)
	dp.SetSum(20)
	dp.Exemplars().AppendEmpty().SetDoubleValue(10)

	out := h.runMetrics(defaultMeta(), md)
	got := out.ResourceMetrics().At(0).ScopeMetrics().At(0).Metrics().At(0)
	if got.Unit() != "s" {
		t.Fatalf("unit %s", got.Unit())
	}
	p := got.ExponentialHistogram().DataPoints().At(0)
	// log2(0.001) × 2^3 = −79.7 → shift −80; 2^((26−80)/8) ≈ 9.3 ms ✓.
	if p.Positive().Offset() != 26-80 || p.Sum() != 0.02 || p.Exemplars().Len() != 0 {
		t.Fatalf("offset %d sum %v exemplars %d", p.Positive().Offset(), p.Sum(), p.Exemplars().Len())
	}
}

func TestMetricsCollidingPointsAreMerged(t *testing.T) {
	// Go otelhttp: points that differ only in server.address / network.* attributes.
	h := newHarness(t)
	md, dps := newHistMetrics("go", MetricServerDuration, "s")
	md.ResourceMetrics().At(0).Resource().Attributes().PutStr("service.instance.id", "i-1")
	// Same timestamp (C-114: only points of equal time merge); the merged point keeps the earliest start.
	addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/x", "http.request.method": "GET", "http.response.status_code": 200, "server.address": "a"}).
		SetStartTimestamp(pcommon.Timestamp(testRecv - 2*second - minute))
	addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/x", "http.request.method": "GET", "http.response.status_code": 200, "server.address": "b"})
	addHistPoint(dps, testRecv-second, map[string]any{"http.route": "/y", "http.request.method": "GET", "http.response.status_code": 200, "server.address": "b"})
	out := h.runMetrics(defaultMeta(), md)
	ps := out.ResourceMetrics().At(0).ScopeMetrics().At(0).Metrics().At(0).Histogram().DataPoints()
	if ps.Len() != 2 {
		t.Fatalf("points = %d, want 2", ps.Len())
	}
	p := ps.At(0)
	if p.Count() != 6 || p.Sum() != 3 || int64(p.Timestamp()) != testRecv-second || int64(p.StartTimestamp()) != testRecv-2*second-minute {
		t.Fatalf("merged point: count %d sum %v ts %d start %d", p.Count(), p.Sum(), p.Timestamp(), p.StartTimestamp())
	}
	if got := p.BucketCounts().AsRaw(); got[0] != 2 || got[1] != 4 {
		t.Fatalf("buckets %v", got)
	}
	if n := h.selfCounter(MetricMergedPoints, nil); n != 1 {
		t.Fatalf("merged counter = %d", n)
	}
}

func TestMetricsDeterministicBytes(t *testing.T) {
	// The writer's batch key is the SHA-256 of the body (§g.3): the same
	// request must always produce the same bytes.
	h := newHarness(t)
	md, dps := newHistMetrics("checkout", MetricServerDuration, "s")
	for i := range 20 {
		addHistPoint(dps, testRecv-int64(i)*second, map[string]any{"http.route": "/users/" + string(rune('a'+i%5)), "server.address": string(rune('a' + i))})
	}
	extra := md.ResourceMetrics().AppendEmpty()
	extra.Resource().Attributes().PutStr("service.name", "z-svc")
	cm := extra.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	cm.SetName("http.client.request.duration")
	cm.SetEmptyHistogram().DataPoints().AppendEmpty()
	var first []byte
	for i := range 20 {
		out := h.runMetrics(defaultMeta(), md)
		b, err := (&pmetric.ProtoMarshaler{}).MarshalMetrics(out)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = b
		} else if !bytes.Equal(first, b) {
			t.Fatal("output bytes differ between runs")
		}
	}
}

func TestMetricsSeedRedactionHasItsOwnCounter(t *testing.T) {
	h := newHarness(t)
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	r.Resource().Attributes().PutStr("service.name", "checkout")
	m := r.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName(MetricServerDuration)
	m.SetUnit("s")
	hg := m.SetEmptyHistogram()
	hg.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	addHistPoint(hg.DataPoints(), testRecv, map[string]any{"http.route": "/accounts/" + testSeed(3)})
	addHistPoint(hg.DataPoints(), testRecv, map[string]any{"http.route": "/users/someone@example.org"})
	addHistPoint(hg.DataPoints(), testRecv, map[string]any{"http.route": "/plain"})
	out := h.runMetrics(defaultMeta(), md)
	want := map[string]int64{"checkout/" + ReasonRouteRedacted: 2, "checkout/" + ReasonRouteSeedRedacted: 1}
	if got := droppedCounts(t, out); !maps.Equal(got, want) {
		t.Fatalf("scf.ingest.dropped = %v, want %v", got, want)
	}
	if strings.Contains(string(marshalMetrics(t, out)), testSeed(3)[:12]) {
		t.Fatal("output contains part of the seed")
	}
}
