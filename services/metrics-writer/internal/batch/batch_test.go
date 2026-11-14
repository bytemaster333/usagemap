// SPDX-License-Identifier: Apache-2.0

package batch

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/cumul"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

const (
	tA = "aaaaaaaa-0000-7000-8000-000000000001"
	tB = "BBBBBBBB-0000-7000-8000-000000000002"
)

var now = time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)

type res struct {
	tenant, service, instance string
	received                  time.Time
}

func newRes(md pmetric.Metrics, r res) pmetric.ResourceMetrics {
	rm := md.ResourceMetrics().AppendEmpty()
	a := rm.Resource().Attributes()
	if r.tenant != "" {
		a.PutStr(AttrTenantID, r.tenant)
	}
	if r.service != "" {
		a.PutStr(AttrServiceName, r.service)
	}
	a.PutStr(AttrStreamInstance, r.instance)
	if !r.received.IsZero() {
		a.PutInt(AttrReceivedAt, r.received.UnixNano())
	}
	return rm
}

func addHist(rm pmetric.ResourceMetrics, scope, name, unit string, temp pmetric.AggregationTemporality,
	start, ts time.Time, bounds []float64, counts []uint64, attrs map[string]any) pmetric.HistogramDataPoint {
	sm := rm.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName(scope)
	sm.Scope().SetVersion("1.0")
	m := sm.Metrics().AppendEmpty()
	m.SetName(name)
	m.SetUnit(unit)
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(temp)
	dp := h.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	dp.ExplicitBounds().FromRaw(bounds)
	dp.BucketCounts().FromRaw(counts)
	var n uint64
	for _, c := range counts {
		n += c
	}
	dp.SetCount(n)
	dp.SetSum(0.01 * float64(n))
	base := map[string]any{AttrRoute: "/v1/items/{id}", AttrRulesVersion: "scf-path-rules/1.0.0"}
	for k, v := range attrs {
		if v == nil {
			delete(base, k)
		} else {
			base[k] = v
		}
	}
	_ = dp.Attributes().FromRaw(base)
	return dp
}

func marshal(t *testing.T, md pmetric.Metrics) []byte {
	t.Helper()
	b, err := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func decode(t *testing.T, md pmetric.Metrics) *Batch {
	t.Helper()
	b, err := Decode(marshal(t, md), now)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

var b2 = []float64{0.1, 1}

func TestDecodeSplitsByTenantAndKeysTheBody(t *testing.T) {
	md := pmetric.NewMetrics()
	addHist(newRes(md, res{tenant: tB, service: "svc", instance: "i1", received: now}), "s", rules.MetricStable, "s",
		pmetric.AggregationTemporalityDelta, now.Add(-time.Minute), now, b2, []uint64{1, 2, 3}, nil)
	addHist(newRes(md, res{tenant: tA, service: "svc", instance: "_", received: now}), "s", rules.MetricStable, "s",
		pmetric.AggregationTemporalityDelta, now.Add(-time.Minute), now, b2, []uint64{1, 0, 0}, nil)
	addHist(newRes(md, res{tenant: "not-a-uuid", service: "svc", instance: "_"}), "s", rules.MetricStable, "s",
		pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 0, 0}, nil)
	body := marshal(t, md)
	b, err := Decode(body, now)
	if err != nil {
		t.Fatal(err)
	}
	if b.Key != sha256.Sum256(body) {
		t.Fatal("batch key is not the SHA-256 of the body")
	}
	if len(b.Parts) != 2 || b.Parts[0].Tenant != tA || b.Parts[1].Tenant != strings.ToLower(tB) {
		t.Fatalf("parts = %+v", b.Parts)
	}
	if b.NoTenant != 1 || b.Points != 3 || b.Parts[0].Total != 1 {
		t.Fatalf("no tenant %d, points %d", b.NoTenant, b.Points)
	}
}

func TestDecodeUndecodable(t *testing.T) {
	if _, err := Decode([]byte{0xff, 0xff, 0xff}, now); err == nil {
		t.Fatal("garbage decoded")
	}
}

func TestReceiptAgeCap72h(t *testing.T) {
	md := pmetric.NewMetrics()
	addHist(newRes(md, res{tenant: tA, service: "svc", instance: "_", received: now.Add(-72*time.Hour - time.Second)}),
		"s", rules.MetricStable, "s", pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 0, 0}, nil)
	addHist(newRes(md, res{tenant: tA, service: "svc", instance: "_", received: now.Add(-71 * time.Hour)}),
		"s", rules.MetricStable, "s", pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 0, 0}, nil)
	b := decode(t, md)
	p := b.Parts[0]
	if len(p.Points) != 1 || p.Drops[DropKey{"svc", rules.ReasonUndeliverable72h}] != 1 {
		t.Fatalf("points %d drops %v", len(p.Points), p.Drops)
	}
}

func TestPointDimensions(t *testing.T) {
	md := pmetric.NewMetrics()
	rm := newRes(md, res{tenant: tA, service: "svc", instance: "_", received: now})
	addHist(rm, rules.ConnectorScope, rules.MetricStable, "s", pmetric.AggregationTemporalityDelta, now, now, b2,
		[]uint64{1, 0, 0}, map[string]any{AttrMethod: "PATCH", AttrStatus: int64(503), AttrRPCMethod: "getHealth",
			AttrMetricOverflow: true})
	addHist(rm, "s", rules.MetricLegacy, "s", pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 0, 0},
		map[string]any{AttrRoute: nil})
	p := decode(t, md).Parts[0].Points
	if p[0].Method != 9 || p[0].Status != 503 || p[0].RPCMethod != "getHealth" || !p[0].HasRPC || !p[0].Overflow ||
		p[0].Scope != rules.StoredConnectorScope || p[0].Kind != rules.KindSDKStable {
		t.Fatalf("point 0 = %+v", p[0])
	}
	// absent method → 0 (_OTHER), absent status → 0, absent route → {unknown} (C-113)
	if p[1].Method != 0 || p[1].Status != 0 || p[1].Route != rules.RouteUnknown || p[1].Kind != rules.KindSDKLegacy {
		t.Fatalf("point 1 = %+v", p[1])
	}
}

func TestMalformedAndNotAllowed(t *testing.T) {
	md := pmetric.NewMetrics()
	rm := newRes(md, res{tenant: tA, service: "svc", instance: "_", received: now})
	dp := addHist(rm, "s", rules.MetricStable, "s", pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 2, 3}, nil)
	dp.SetCount(99) // buckets do not add up
	addHist(rm, "s", rules.MetricStable, "By", pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 0, 0}, nil)
	addHist(rm, "s", rules.MetricStable, "s", pmetric.AggregationTemporalityUnspecified, now, now, b2, []uint64{1, 0, 0}, nil)
	addHist(rm, "s", rules.MetricStable, "s", pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 0, 0},
		map[string]any{AttrRulesVersion: "v1"})
	addHist(rm, "s", "db.client.operation.duration", "s", pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 0, 0}, nil)
	nr := addHist(rm, "s", rules.MetricStable, "s", pmetric.AggregationTemporalityDelta, now, now, b2, []uint64{1, 0, 0}, nil)
	nr.SetFlags(pmetric.DefaultDataPointFlags.WithNoRecordedValue(true))
	p := decode(t, md).Parts[0]
	if len(p.Points) != 0 {
		t.Fatalf("points = %d", len(p.Points))
	}
	if p.Drops[DropKey{"svc", rules.ReasonMalformedPoint}] != 4 || p.Drops[DropKey{"svc", rules.ReasonMetricNotAllowed}] != 1 {
		t.Fatalf("drops = %v", p.Drops)
	}
}

// Legacy millisecond metrics are converted to seconds (the Collector already does it; the writer converts any that
// arrive unconverted).
func TestLegacyMillisecondsToSeconds(t *testing.T) {
	md := pmetric.NewMetrics()
	dp := addHist(newRes(md, res{tenant: tA, service: "svc", instance: "_", received: now}), "s", rules.MetricLegacy,
		"ms", pmetric.AggregationTemporalityDelta, now, now, []float64{5, 10, 25}, []uint64{1, 2, 3, 4}, nil)
	dp.SetSum(250)
	dp.SetMax(400)
	p := decode(t, md).Parts[0].Points[0]
	if p.Snap.Bounds[0] != 0.005 || p.Snap.Bounds[2] != 0.025 || p.Snap.Sum != 0.25 || *p.Max != 0.4 {
		t.Fatalf("bounds %v sum %v max %v", p.Snap.Bounds, p.Snap.Sum, *p.Max)
	}
}

func TestStreamKey(t *testing.T) {
	key := func(instance string, start time.Time, bounds []float64, attrs map[string]any) [32]byte {
		md := pmetric.NewMetrics()
		addHist(newRes(md, res{tenant: tA, service: "svc", instance: instance, received: now}), "s", rules.MetricStable,
			"s", pmetric.AggregationTemporalityCumulative, start, now, bounds, make([]uint64, len(bounds)+1), attrs)
		return decode(t, md).Parts[0].Points[0].StreamKey
	}
	t0 := now.Add(-time.Hour)
	base := key("i-1", t0, b2, nil)
	if base != key("i-1", t0.Add(time.Second), b2, nil) {
		t.Fatal("with service.instance.id the start time must not be part of the key")
	}
	if base == key("i-2", t0, b2, nil) {
		t.Fatal("instance not in the key")
	}
	// without service.instance.id the start time identifies the stream (C-105)
	if key("_", t0, b2, nil) == key("_", t0.Add(time.Second), b2, nil) {
		t.Fatal("start time not in the key without an instance id")
	}
	if base == key("i-1", t0, b2, map[string]any{AttrStatus: int64(500)}) {
		t.Fatal("attributes not in the key")
	}
	// different explicit bounds → separate state (§g.6, C-113)
	if base == key("i-1", t0, []float64{0.2, 1}, nil) {
		t.Fatal("bounds not in the key")
	}
}

func TestCounters(t *testing.T) {
	md := pmetric.NewMetrics()
	rm := newRes(md, res{tenant: tA, instance: "_", received: now})
	sm := rm.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName(rules.SanitizeScope)
	m := sm.Metrics().AppendEmpty()
	m.SetName(rules.MetricDropped)
	s := m.SetEmptySum()
	s.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	s.SetIsMonotonic(true)
	add := func(svc, reason string, n int64) {
		dp := s.DataPoints().AppendEmpty()
		dp.SetTimestamp(pcommon.NewTimestampFromTime(now))
		dp.SetIntValue(n)
		dp.Attributes().PutStr(AttrReason, reason)
		dp.Attributes().PutStr(AttrServiceName, svc)
	}
	add(rules.ServiceNotAllowed, "service_not_allowed", 4)
	add("svc", "route_redacted", 2)
	add("svc", "made_up_reason", 1)
	p := decode(t, md).Parts[0]
	if len(p.Counters) != 2 || p.Counters[0].Service != rules.ServiceNotAllowed || p.Counters[1].Count != 2 {
		t.Fatalf("counters = %+v", p.Counters)
	}
	if p.Drops[DropKey{"", rules.ReasonMalformedPoint}] != 1 {
		t.Fatalf("drops = %v", p.Drops)
	}
}

// Every real SDK payload, as the Collector's sanitise step emits it (the Collector's golden files), decodes without a
// malformed point.
func TestSDKGoldenPayloadsDecode(t *testing.T) {
	files, _ := filepath.Glob("../../../../collector/processor/scfsanitizeprocessor/testdata/golden/*.metrics.json")
	if len(files) < 8 {
		t.Fatalf("expected the Collector's golden metric payloads, found %d", len(files))
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(raw)
			if err != nil {
				t.Fatal(err)
			}
			b, err := Decode(marshal(t, md), time.Unix(0, 1794499400000000000))
			if err != nil {
				t.Fatal(err)
			}
			if len(b.Parts) != 1 || len(b.Parts[0].Points)+len(b.Parts[0].Stellar)+len(b.Parts[0].Integration)+len(b.Parts[0].Counters) == 0 {
				t.Fatalf("parts %d", len(b.Parts))
			}
			for k, n := range b.Parts[0].Drops {
				t.Errorf("unexpected drop %v × %d", k, n)
			}
			for _, p := range b.Parts[0].Points {
				if _, err := Convert(p.Snap, p.Min, p.Max); err != nil {
					t.Errorf("convert: %v", err)
				}
			}
		})
	}
}

// The source key (C-122) is the stream key without the data-point dimensions and the layout: a new route or status
// of a running process shares its source; another instance, start time (without an instance id), service, scope,
// metric or rules version does not. It never equals a stream key.
func TestSourceKey(t *testing.T) {
	type keys struct{ stream, source [32]byte }
	key := func(service, instance, scope, metric string, start time.Time, bounds []float64, attrs map[string]any) keys {
		md := pmetric.NewMetrics()
		addHist(newRes(md, res{tenant: tA, service: service, instance: instance, received: now}), scope, metric,
			"s", pmetric.AggregationTemporalityCumulative, start, now, bounds, make([]uint64, len(bounds)+1), attrs)
		p := decode(t, md).Parts[0].Points[0]
		return keys{p.StreamKey, p.SourceKey}
	}
	t0 := now.Add(-time.Hour)
	base := key("svc", "i-1", "s", rules.MetricStable, t0, b2, nil)
	if base.source == base.stream || base.source == ([32]byte{}) {
		t.Fatal("source key missing or equal to the stream key")
	}
	same := []keys{
		key("svc", "i-1", "s", rules.MetricStable, t0, b2, map[string]any{AttrStatus: int64(404)}),
		key("svc", "i-1", "s", rules.MetricStable, t0, b2, map[string]any{AttrRoute: "/other"}),
		key("svc", "i-1", "s", rules.MetricStable, t0.Add(time.Second), []float64{0.2, 1}, nil),
	}
	for i, k := range same {
		if k.source != base.source || k.stream == base.stream {
			t.Fatalf("case %d: a new dimension or layout must keep the source and change the stream", i)
		}
	}
	other := []keys{
		key("svc2", "i-1", "s", rules.MetricStable, t0, b2, nil),
		key("svc", "i-2", "s", rules.MetricStable, t0, b2, nil),
		key("svc", "i-1", "s2", rules.MetricStable, t0, b2, nil),
		key("svc", "i-1", "s", rules.MetricLegacy, t0, b2, nil),
		key("svc", "i-1", "s", rules.MetricStable, t0, b2, map[string]any{AttrRulesVersion: "scf-path-rules/2.0.0"}),
	}
	for i, k := range other {
		if k.source == base.source {
			t.Fatalf("case %d: source key must differ", i)
		}
	}
	// without service.instance.id the start time is the instance
	a := key("svc", "_", "s", rules.MetricStable, t0, b2, nil)
	if a.source == key("svc", "_", "s", rules.MetricStable, t0.Add(time.Second), b2, nil).source {
		t.Fatal("start time not in the source key without an instance id")
	}
	if a.source != key("svc", "_", "s", rules.MetricStable, t0, b2, map[string]any{AttrStatus: int64(404)}).source {
		t.Fatal("a new status of an instance-less process must share its source")
	}
}

// Millisecond default bounds under unit "s", end to end through Convert: the reason is hist_unit_suspect (not hist_layout_approx), the stored row is
// coarse, and milliseconds labelled "s" get their sum corrected too.
func TestConvertMsDefaultLayoutUnderSeconds(t *testing.T) {
	counts := make([]uint64, 16)
	counts[1] = 100
	c, err := Convert(cumul.Snapshot{Bounds: hist.MsDefaultBounds[:], Buckets: counts, Count: 100, Sum: 4}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(c.Reasons, []string{rules.ReasonHistUnitSuspect}) || c.Row.Quality != hist.QualityCoarse || c.Sum != 4 {
		t.Fatalf("converted %+v", c)
	}
	counts[1], counts[4] = 0, 100 // (25, 50] "s": milliseconds
	mx := 49.0
	c, err = Convert(cumul.Snapshot{Bounds: hist.MsDefaultBounds[:], Buckets: counts, Count: 100, Sum: 4000}, nil, &mx)
	if err != nil {
		t.Fatal(err)
	}
	if c.Sum != 4 || c.Max == nil || *c.Max != 0.049 || c.Row.Counts[3] != 100 {
		t.Fatalf("rescaled %+v", c)
	}
	if !rules.KnownReason(rules.ReasonHistUnitSuspect) {
		t.Fatal("hist_unit_suspect is not a known reason")
	}
}
