// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"context"
	"os"
	"strconv"
	"testing"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/processor/processortest"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

const (
	testTenant = "11111111-2222-4333-8444-555555555555"
	// testRecv is the gateway receipt time used by most tests (2026-11-12T16:00:00Z).
	testRecv int64 = 1794499200_000000000
	second   int64 = 1_000_000_000
	minute         = 60 * second
	hour           = 60 * minute
)

// meta builds the gateway metadata of one request.
type meta struct {
	tenant     string
	allowed    string // "" = header absent
	receivedAt string // "" = header absent
	level      string // "" = header absent
	extra      map[string][]string
}

func defaultMeta() meta {
	return meta{tenant: testTenant, allowed: "*", receivedAt: strconv.FormatInt(testRecv, 10)}
}

func (m meta) ctx() context.Context {
	md := map[string][]string{}
	if m.tenant != "" {
		md[MetaTenantID] = []string{m.tenant}
	}
	if m.allowed != "" {
		md[MetaAllowedServices] = []string{m.allowed}
	}
	if m.receivedAt != "" {
		md[MetaReceivedAt] = []string{m.receivedAt}
	}
	if m.level != "" {
		md[MetaTenantLevel] = []string{m.level}
	}
	for k, v := range m.extra {
		md[k] = v
	}
	return client.NewContext(context.Background(), client.Info{Metadata: client.NewMetadata(md)})
}

// harness runs the processor the way the Collector does: factory, settings,
// a sink as the next consumer, and an in-memory meter for self-metrics.
type harness struct {
	t       *testing.T
	tel     *componenttest.Telemetry
	metrics processor.Metrics
	traces  processor.Traces
	msink   *consumertest.MetricsSink
	tsink   *consumertest.TracesSink
}

func newHarness(t *testing.T, mutate ...func(*Config)) *harness {
	t.Helper()
	tel := componenttest.NewTelemetry()
	t.Cleanup(func() { _ = tel.Shutdown(context.Background()) })
	f := NewFactory()
	cfg := f.CreateDefaultConfig().(*Config)
	for _, m := range mutate {
		m(cfg)
	}
	set := processortest.NewNopSettings(f.Type())
	set.TelemetrySettings = tel.NewTelemetrySettings()
	h := &harness{t: t, tel: tel, msink: new(consumertest.MetricsSink), tsink: new(consumertest.TracesSink)}
	var err error
	if h.metrics, err = f.CreateMetrics(context.Background(), set, cfg, h.msink); err != nil {
		t.Fatal(err)
	}
	if h.traces, err = f.CreateTraces(context.Background(), set, cfg, h.tsink); err != nil {
		t.Fatal(err)
	}
	host := componenttest.NewNopHost()
	if err := h.metrics.Start(context.Background(), host); err != nil {
		t.Fatal(err)
	}
	if err := h.traces.Start(context.Background(), host); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = h.metrics.Shutdown(context.Background())
		_ = h.traces.Shutdown(context.Background())
	})
	return h
}

// runMetrics sends md and returns what reached the next consumer (or an empty
// pmetric.Metrics if nothing did). md is not modified.
func (h *harness) runMetrics(m meta, md pmetric.Metrics) pmetric.Metrics {
	h.t.Helper()
	in := pmetric.NewMetrics()
	md.CopyTo(in)
	before := len(h.msink.AllMetrics())
	if err := h.metrics.ConsumeMetrics(m.ctx(), in); err != nil {
		h.t.Fatalf("ConsumeMetrics: %v", err)
	}
	all := h.msink.AllMetrics()
	if len(all) == before {
		return pmetric.NewMetrics()
	}
	if len(all) != before+1 {
		h.t.Fatalf("expected one output, got %d", len(all)-before)
	}
	return all[len(all)-1]
}

func (h *harness) runTraces(m meta, td ptrace.Traces) ptrace.Traces {
	h.t.Helper()
	in := ptrace.NewTraces()
	td.CopyTo(in)
	before := len(h.tsink.AllTraces())
	if err := h.traces.ConsumeTraces(m.ctx(), in); err != nil {
		h.t.Fatalf("ConsumeTraces: %v", err)
	}
	all := h.tsink.AllTraces()
	if len(all) == before {
		return ptrace.NewTraces()
	}
	return all[len(all)-1]
}

// selfCounter sums a self-metric's data points that match attrs.
func (h *harness) selfCounter(name string, attrs map[string]string) int64 {
	h.t.Helper()
	m, err := h.tel.GetMetric(name)
	if err != nil {
		return 0
	}
	sum, ok := m.Data.(metricdata.Sum[int64])
	if !ok {
		h.t.Fatalf("%s is %T", name, m.Data)
	}
	var n int64
	for _, dp := range sum.DataPoints {
		match := true
		for k, v := range attrs {
			if got, ok := dp.Attributes.Value(attribute.Key(k)); !ok || got.AsString() != v {
				match = false
			}
		}
		if match {
			n += dp.Value
		}
	}
	return n
}

// droppedCounts reads scf.ingest.dropped from a sanitised metrics payload:
// "service/reason" → count.
func droppedCounts(t *testing.T, md pmetric.Metrics) map[string]int64 {
	t.Helper()
	out := map[string]int64{}
	for _, r := range md.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() != MetricIngestDropped {
					continue
				}
				if sm.Scope().Name() != ScopeName {
					t.Fatalf("scf.ingest.dropped in scope %q", sm.Scope().Name())
				}
				for _, dp := range m.Sum().DataPoints().All() {
					svc, _ := dp.Attributes().Get(keyServiceName)
					rs, _ := dp.Attributes().Get(AttrReason)
					out[svc.Str()+"/"+rs.Str()] += dp.IntValue()
				}
			}
		}
	}
	return out
}

// markerCounts reads the drop-marker spans from a sanitised traces payload.
func markerCounts(t *testing.T, td ptrace.Traces) map[string]int64 {
	t.Helper()
	out := map[string]int64{}
	for _, rs := range td.ResourceSpans().All() {
		for _, ss := range rs.ScopeSpans().All() {
			for _, sp := range ss.Spans().All() {
				if v, ok := sp.Attributes().Get(AttrMarker); !ok || v.Str() != MarkerDropped {
					continue
				}
				if ss.Scope().Name() != ScopeName {
					t.Fatalf("marker span in scope %q", ss.Scope().Name())
				}
				svc, _ := sp.Attributes().Get(keyServiceName)
				rs, _ := sp.Attributes().Get(AttrReason)
				n, _ := sp.Attributes().Get(AttrDroppedCount)
				out[svc.Str()+"/"+rs.Str()] += n.Int()
			}
		}
	}
	return out
}

// newHistMetrics builds one resource / scope / explicit-histogram metric.
func newHistMetrics(service, name, unit string) (pmetric.Metrics, pmetric.HistogramDataPointSlice) {
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	r.Resource().Attributes().PutStr("service.name", service)
	sm := r.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName("test/scope")
	m := sm.Metrics().AppendEmpty()
	m.SetName(name)
	m.SetUnit(unit)
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	return md, h.DataPoints()
}

// addHistPoint appends a valid 3-bucket point (bounds 0.1, 1).
func addHistPoint(dps pmetric.HistogramDataPointSlice, ts int64, attrs map[string]any) pmetric.HistogramDataPoint {
	dp := dps.AppendEmpty()
	dp.SetStartTimestamp(pcommon.Timestamp(ts - minute))
	dp.SetTimestamp(pcommon.Timestamp(ts))
	dp.ExplicitBounds().FromRaw([]float64{0.1, 1})
	dp.BucketCounts().FromRaw([]uint64{1, 2, 0})
	dp.SetCount(3)
	dp.SetSum(1.5)
	if err := dp.Attributes().FromRaw(attrs); err != nil {
		panic(err)
	}
	return dp
}

// newSpans builds one resource / scope with no spans yet.
func newSpans(service string) (ptrace.Traces, ptrace.SpanSlice) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", service)
	ss := rs.ScopeSpans().AppendEmpty()
	ss.Scope().SetName("test/scope")
	return td, ss.Spans()
}

func addServerSpan(spans ptrace.SpanSlice, end int64, attrs map[string]any) ptrace.Span {
	sp := spans.AppendEmpty()
	sp.SetKind(ptrace.SpanKindServer)
	sp.SetTraceID(pcommon.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, byte(spans.Len())})
	sp.SetSpanID(pcommon.SpanID{1, 2, 3, 4, 5, 6, 7, byte(spans.Len())})
	sp.SetFlags(0x101)
	sp.SetStartTimestamp(pcommon.Timestamp(end - 120_000_000))
	sp.SetEndTimestamp(pcommon.Timestamp(end))
	if err := sp.Attributes().FromRaw(attrs); err != nil {
		panic(err)
	}
	return sp
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func onlyPoint(t *testing.T, md pmetric.Metrics, metric string) pmetric.HistogramDataPoint {
	t.Helper()
	var found []pmetric.HistogramDataPoint
	for _, r := range md.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Name() == metric && m.Type() == pmetric.MetricTypeHistogram {
					for _, dp := range m.Histogram().DataPoints().All() {
						found = append(found, dp)
					}
				}
			}
		}
	}
	if len(found) != 1 {
		t.Fatalf("want 1 point of %s, got %d", metric, len(found))
	}
	return found[0]
}
