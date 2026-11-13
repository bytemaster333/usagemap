// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"context"
	"net/url"
	"strings"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor/processorhelper"
	"go.uber.org/zap"
)

const tenantAttr = "scf.tenant.id"

// Allow-lists from docs/contracts/wire-formats.md §f.5 (input side).
var (
	resourceKeep = set("service.name", "service.instance.id", "service.namespace",
		"deployment.environment.name", "deployment.environment")
	pointKeep = set("http.route", "http.request.method", "http.method",
		"http.response.status_code", "http.status_code", "rpc.method", "rpc.system",
		"rpc.system.name", "otel.metric.overflow")
	// Span attributes kept until signal_to_metrics has run. The four path
	// inputs are consumed here: the stub writes scf.route and deletes them.
	spanKeep  = set("http.route", "http.request.method", "http.method", "http.response.status_code", "http.status_code", "rpc.method", "rpc.system", "rpc.system.name", "scf.route")
	pathInput = []string{"http.route", "url.path", "http.target", "url.full", "http.url"}
)

func set(keys ...string) map[string]struct{} {
	m := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		m[k] = struct{}{}
	}
	return m
}

type sanitizer struct {
	cfg *Config
	log *zap.Logger
}

type requestMeta struct {
	tenant  string
	allowed map[string]struct{} // nil = "*"
}

func (s *sanitizer) meta(ctx context.Context) (requestMeta, bool) {
	md := client.FromContext(ctx).Metadata
	t := md.Get(s.cfg.TenantHeader)
	if len(t) != 1 || t[0] == "" {
		return requestMeta{}, false
	}
	rm := requestMeta{tenant: t[0]}
	a := md.Get(s.cfg.AllowedServicesHeader)
	if len(a) == 1 && a[0] != "*" {
		rm.allowed = map[string]struct{}{}
		for _, part := range strings.Split(a[0], ",") {
			if v, err := url.PathUnescape(strings.TrimSpace(part)); err == nil && v != "" {
				rm.allowed[v] = struct{}{}
			}
		}
	} else if len(a) != 1 {
		rm.allowed = map[string]struct{}{} // header missing: allow nothing
	}
	return rm, true
}

// resource applies steps 1–3 of §f.5 to one resource; false = drop it.
func (rm requestMeta) resource(res pcommon.Resource) bool {
	attrs := res.Attributes()
	if rm.allowed != nil {
		sn, ok := attrs.Get("service.name")
		if !ok {
			return false
		}
		if _, ok := rm.allowed[sn.AsString()]; !ok {
			return false
		}
	}
	keepOnly(attrs, resourceKeep) // also removes any payload tenant.id / scf.*
	attrs.PutStr(tenantAttr, rm.tenant)
	return true
}

func keepOnly(m pcommon.Map, keep map[string]struct{}) {
	m.RemoveIf(func(k string, _ pcommon.Value) bool {
		_, ok := keep[k]
		return !ok
	})
}

func (s *sanitizer) processTraces(ctx context.Context, td ptrace.Traces) (ptrace.Traces, error) {
	rm, ok := s.meta(ctx)
	if !ok {
		s.log.Warn("no tenant metadata on request; dropping payload", zap.Int("spans", td.SpanCount()))
		return td, processorhelper.ErrSkipProcessingData
	}
	td.ResourceSpans().RemoveIf(func(rs ptrace.ResourceSpans) bool {
		if !rm.resource(rs.Resource()) {
			s.log.Info("service_not_allowed", zap.Int("spans", countSpans(rs)))
			return true
		}
		for _, ss := range rs.ScopeSpans().All() {
			for _, sp := range ss.Spans().All() {
				attrs := sp.Attributes()
				route := "{unknown}"
				for _, k := range pathInput {
					if v, ok := attrs.Get(k); ok && v.AsString() != "" {
						route = v.AsString() // the real processor runs pathnorm here
						break
					}
				}
				attrs.PutStr("scf.route", route)
				keepOnly(attrs, spanKeep)
				sp.Events().RemoveIf(func(ptrace.SpanEvent) bool { return true })
				sp.Links().RemoveIf(func(ptrace.SpanLink) bool { return true })
			}
		}
		return false
	})
	if td.ResourceSpans().Len() == 0 {
		return td, processorhelper.ErrSkipProcessingData
	}
	return td, nil
}

func countSpans(rs ptrace.ResourceSpans) int {
	n := 0
	for _, ss := range rs.ScopeSpans().All() {
		n += ss.Spans().Len()
	}
	return n
}

func (s *sanitizer) processMetrics(ctx context.Context, md pmetric.Metrics) (pmetric.Metrics, error) {
	rm, ok := s.meta(ctx)
	if !ok {
		s.log.Warn("no tenant metadata on request; dropping payload", zap.Int("points", md.DataPointCount()))
		return md, processorhelper.ErrSkipProcessingData
	}
	md.ResourceMetrics().RemoveIf(func(r pmetric.ResourceMetrics) bool {
		if !rm.resource(r.Resource()) {
			s.log.Info("service_not_allowed")
			return true
		}
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				sanitizeMetric(m)
			}
		}
		return false
	})
	if md.ResourceMetrics().Len() == 0 {
		return md, processorhelper.ErrSkipProcessingData
	}
	return md, nil
}

func sanitizeMetric(m pmetric.Metric) {
	switch m.Type() {
	case pmetric.MetricTypeHistogram:
		for _, dp := range m.Histogram().DataPoints().All() {
			keepOnly(dp.Attributes(), pointKeep)
			dp.Exemplars().RemoveIf(func(pmetric.Exemplar) bool { return true })
		}
	case pmetric.MetricTypeExponentialHistogram:
		for _, dp := range m.ExponentialHistogram().DataPoints().All() {
			keepOnly(dp.Attributes(), pointKeep)
			dp.Exemplars().RemoveIf(func(pmetric.Exemplar) bool { return true })
		}
	case pmetric.MetricTypeSum:
		for _, dp := range m.Sum().DataPoints().All() {
			keepOnly(dp.Attributes(), pointKeep)
			dp.Exemplars().RemoveIf(func(pmetric.Exemplar) bool { return true })
		}
	case pmetric.MetricTypeGauge:
		for _, dp := range m.Gauge().DataPoints().All() {
			keepOnly(dp.Attributes(), pointKeep)
			dp.Exemplars().RemoveIf(func(pmetric.Exemplar) bool { return true })
		}
	case pmetric.MetricTypeSummary:
		for _, dp := range m.Summary().DataPoints().All() {
			keepOnly(dp.Attributes(), pointKeep)
		}
	}
}
