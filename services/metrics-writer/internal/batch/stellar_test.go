// SPDX-License-Identifier: Apache-2.0

package batch

import (
	"os"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// The Collector's output for the package's recorded scenario (stellar_client_metrics on) decodes into Stellar
// points only — never API points — with the dimensions of migration 0080's table header.
func TestStellarGoldenDecodes(t *testing.T) {
	raw, err := os.ReadFile("../../../../collector/processor/scfsanitizeprocessor/testdata/golden/stellar-otel.enabled.metrics.json")
	if err != nil {
		t.Fatal(err)
	}
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(raw)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Decode(marshal(t, md), time.Unix(0, 1795084228302000000))
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Parts) != 1 {
		t.Fatalf("parts %d", len(b.Parts))
	}
	p := b.Parts[0]
	if len(p.Points) != 0 {
		t.Fatalf("Stellar client metrics became API points: %d", len(p.Points))
	}
	for k, n := range p.Drops {
		t.Errorf("unexpected drop %v × %d", k, n)
	}
	type dims struct{ metric, op, variant, outcome string }
	got := map[dims]uint64{}
	for _, s := range p.Stellar {
		if !s.Cumulative || s.Network != "testnet" || s.Service != "stellar-dapp-api" {
			t.Errorf("point %+v", s)
		}
		got[dims{s.Metric, s.Operation, s.Variant, s.Outcome}] += s.Snap.Count
	}
	want := map[dims]uint64{
		{rules.MetricStellarRPC, "getHealth", "", ""}:                  2,
		{rules.MetricStellarRPC, "getFeeStats", "", "503"}:             1,
		{rules.MetricStellarHTTP, "/accounts/{id}", "GET", "404"}:      1,
		{rules.MetricStellarHTTP, "/transactions", "POST", "400"}:      1,
		{rules.MetricStellarSubmissions, "rpc", "ERROR", "bad_seq"}:    1,
		{rules.MetricStellarPolls, "", "FAILED", "contract_error"}:     1,
		{rules.MetricStellarSimulations, "", "error", "other"}:         1,
		{rules.MetricStellarSimulations, "", "success", ""}:            1,
		{rules.MetricStellarSubmissions, "rpc", "TRY_AGAIN_LATER", ""}: 1,
	}
	for k, n := range want {
		if got[k] != n {
			t.Errorf("%+v: got %d, want %d", k, got[k], n)
		}
	}
	// histograms keep the package's bounds; convertible into explicit15 exactly (they nest)
	for _, s := range p.Stellar {
		if !s.Histogram {
			if len(s.Snap.Buckets) != 1 || s.Snap.Buckets[0] != s.Snap.Count {
				t.Errorf("counter layout %+v", s.Snap)
			}
			continue
		}
		c, err := ConvertExplicit15(s.Snap, nil, nil)
		if err != nil || c.Row.Quality != 0 || uint64(c.Count) != s.Snap.Count {
			t.Errorf("convert %s %s: %+v %v", s.Metric, s.Operation, c, err)
		}
	}
}

func stellarMetrics(build func(sm pmetric.ScopeMetrics)) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := newRes(md, res{tenant: tA, service: "backend", instance: "_", received: now})
	sm := rm.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName("@usagemap/stellar-otel")
	sm.Scope().SetVersion("0.1.0")
	build(sm)
	return md
}

func stellarHist(sm pmetric.ScopeMetrics, name, unit string, attrs map[string]any) {
	m := sm.Metrics().AppendEmpty()
	m.SetName(name)
	m.SetUnit(unit)
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	dp := h.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(now.Add(-time.Minute)))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(now))
	dp.ExplicitBounds().FromRaw([]float64{5, 10, 25})
	dp.BucketCounts().FromRaw([]uint64{1, 2, 0, 0})
	dp.SetCount(3)
	dp.SetSum(20)
	_ = dp.Attributes().FromRaw(attrs)
}

func stellarSum(sm pmetric.ScopeMetrics, name string, monotonic bool, v any, attrs map[string]any) {
	m := sm.Metrics().AppendEmpty()
	m.SetName(name)
	s := m.SetEmptySum()
	s.SetIsMonotonic(monotonic)
	s.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	dp := s.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(now.Add(-time.Minute)))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(now))
	switch x := v.(type) {
	case int64:
		dp.SetIntValue(x)
	case float64:
		dp.SetDoubleValue(x)
	}
	_ = dp.Attributes().FromRaw(attrs)
}

func TestStellarDecodeRules(t *testing.T) {
	rpc := func(extra map[string]any) map[string]any {
		a := map[string]any{"rpc.system.name": "jsonrpc", "rpc.method": "sendTransaction", "stellar.network": "mainnet"}
		for k, v := range extra {
			if v == nil {
				delete(a, k)
			} else {
				a[k] = v
			}
		}
		return a
	}
	cases := []struct {
		name      string
		build     func(sm pmetric.ScopeMetrics)
		malformed int64
		check     func(t *testing.T, p []StellarPoint)
	}{
		{"ms histogram converted to seconds, delta keeps min/max absent", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarRPC, "ms", rpc(map[string]any{"error.type": "-32602"}))
		}, 0, func(t *testing.T, p []StellarPoint) {
			if len(p) != 1 || p[0].Snap.Bounds[0] != 0.005 || p[0].Snap.Sum != 0.02 || p[0].Outcome != "-32602" || p[0].Cumulative {
				t.Errorf("%+v", p)
			}
		}},
		{"http: int status wins over error.type", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarHTTP, "s", map[string]any{"url.template": "/accounts/{id}",
				"http.request.method": "GET", "http.response.status_code": int64(404), "error.type": "404", "stellar.network": "testnet"})
		}, 0, func(t *testing.T, p []StellarPoint) {
			if len(p) != 1 || p[0].Operation != "/accounts/{id}" || p[0].Variant != "GET" || p[0].Outcome != "404" {
				t.Errorf("%+v", p)
			}
		}},
		{"http: timeout without status", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarHTTP, "s", map[string]any{"url.template": "_OTHER",
				"http.request.method": "POST", "error.type": "timeout", "stellar.network": "testnet"})
		}, 0, func(t *testing.T, p []StellarPoint) {
			if len(p) != 1 || p[0].Outcome != "timeout" {
				t.Errorf("%+v", p)
			}
		}},
		{"unknown network refused", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarRPC, "s", rpc(map[string]any{"stellar.network": "pubnet"}))
		}, 1, nil},
		{"no network refused", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarRPC, "s", rpc(map[string]any{"stellar.network": nil}))
		}, 1, nil},
		{"a URL never passes", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarHTTP, "s", map[string]any{"url.template": "https://rpc.example/apikey",
				"http.request.method": "GET", "stellar.network": "mainnet"})
		}, 1, nil},
		{"an address never passes", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarHTTP, "s", map[string]any{"url.template": "/accounts/GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ2",
				"http.request.method": "GET", "stellar.network": "mainnet"})
		}, 1, nil},
		{"error text never passes", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarRPC, "s", rpc(map[string]any{"error.type": "tx_bad_seq: account G..."}))
		}, 1, nil},
		{"duration without operation refused", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarRPC, "s", rpc(map[string]any{"rpc.method": nil}))
		}, 1, nil},
		{"bad unit refused", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarRPC, "us", rpc(nil))
		}, 1, nil},
		{"counter: integral double ok", func(sm pmetric.ScopeMetrics) {
			stellarSum(sm, rules.MetricStellarSubmissions, true, float64(3), map[string]any{"stellar.tx.via": "horizon",
				"stellar.tx.status": "SUCCESS", "stellar.network": "mainnet"})
		}, 0, func(t *testing.T, p []StellarPoint) {
			if len(p) != 1 || p[0].Snap.Count != 3 || p[0].Histogram || !p[0].Cumulative || p[0].Operation != "horizon" {
				t.Errorf("%+v", p)
			}
		}},
		{"counter: fraction, negative, non-monotonic, no status refused", func(sm pmetric.ScopeMetrics) {
			a := map[string]any{"stellar.tx.status": "SUCCESS", "stellar.network": "mainnet"}
			stellarSum(sm, rules.MetricStellarPolls, true, 1.5, a)
			stellarSum(sm, rules.MetricStellarPolls, true, int64(-1), a)
			stellarSum(sm, rules.MetricStellarPolls, false, int64(1), a)
			stellarSum(sm, rules.MetricStellarSimulations, true, int64(1), map[string]any{"stellar.network": "mainnet"})
		}, 4, nil},
		{"histogram under a counter name refused", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricStellarPolls, "s", map[string]any{"stellar.tx.status": "SUCCESS", "stellar.network": "mainnet"})
		}, 1, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b := decode(t, stellarMetrics(c.build))
			p := b.Parts[0]
			if n := p.Drops[DropKey{"backend", rules.ReasonMalformedPoint}]; n != c.malformed {
				t.Errorf("malformed %d, want %d (drops %v)", n, c.malformed, p.Drops)
			}
			if len(p.Points) != 0 {
				t.Errorf("API points %d", len(p.Points))
			}
			if c.check != nil {
				c.check(t, p.Stellar)
			}
		})
	}
}

// Stream keys: one per process (start time without an instance id) and series; the source is the service — so a
// new series of a running service counts in full (C-122) — and never equals a stream key or an API key.
func TestStellarStreamKeys(t *testing.T) {
	key := func(instance string, start time.Time, status string) StellarPoint {
		md := pmetric.NewMetrics()
		rm := newRes(md, res{tenant: tA, service: "backend", instance: instance, received: now})
		sm := rm.ScopeMetrics().AppendEmpty()
		sm.Scope().SetName("@usagemap/stellar-otel")
		m := sm.Metrics().AppendEmpty()
		m.SetName(rules.MetricStellarPolls)
		s := m.SetEmptySum()
		s.SetIsMonotonic(true)
		s.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
		dp := s.DataPoints().AppendEmpty()
		dp.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
		dp.SetTimestamp(pcommon.NewTimestampFromTime(now))
		dp.SetIntValue(1)
		_ = dp.Attributes().FromRaw(map[string]any{"stellar.tx.status": status, "stellar.network": "testnet"})
		return decode(t, md).Parts[0].Stellar[0]
	}
	a := key("_", now.Add(-time.Hour), "SUCCESS")
	b := key("_", now.Add(-time.Hour), "FAILED")
	c := key("_", now.Add(-time.Minute), "SUCCESS")
	d := key("pod-1", now.Add(-time.Hour), "SUCCESS")
	if a.StreamKey == b.StreamKey || a.StreamKey == c.StreamKey || a.StreamKey == d.StreamKey {
		t.Error("stream keys must differ per series and process")
	}
	if a.SourceKey != b.SourceKey || a.SourceKey != c.SourceKey || a.SourceKey == d.SourceKey {
		t.Error("source: the service (without instance id), per explicit instance")
	}
	if a.SourceKey == a.StreamKey {
		t.Error("source key equals a stream key")
	}
}
