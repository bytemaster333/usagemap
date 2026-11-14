// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/bytemaster333/usagemap/packages/pathnorm"
)

// Names of the Collector self-metrics of this processor, as the Collector's
// Prometheus reader exposes them. Attributes are closed sets: signal, reason,
// kind, location — never a tenant, service or value.
const (
	MetricDropped            = "otelcol_processor_scfsanitize_dropped"
	MetricRedactions         = "otelcol_processor_scfsanitize_redactions"
	MetricMergedPoints       = "otelcol_processor_scfsanitize_merged_points"
	MetricReceivedAtFallback = "otelcol_processor_scfsanitize_received_at_fallback"
	MetricTenantLevelAbsent  = "otelcol_processor_scfsanitize_tenant_level_absent"
)

const scopeName = "github.com/bytemaster333/usagemap/collector/processor/scfsanitizeprocessor"

type telemetry struct {
	dropped    metric.Int64Counter
	redactions metric.Int64Counter
	merged     metric.Int64Counter
	fallback   metric.Int64Counter
	noLevel    metric.Int64Counter
}

func newTelemetry(set component.TelemetrySettings) (*telemetry, error) {
	m := set.MeterProvider.Meter(scopeName)
	var t telemetry
	var err error
	if t.dropped, err = m.Int64Counter(MetricDropped,
		metric.WithDescription("Items (spans or data points) dropped by scfsanitize, by signal and reason."),
		metric.WithUnit("{item}")); err != nil {
		return nil, err
	}
	if t.redactions, err = m.Int64Counter(MetricRedactions,
		metric.WithDescription("Values redacted from routes and paths by pathnorm, by kind and location."),
		metric.WithUnit("{value}")); err != nil {
		return nil, err
	}
	if t.merged, err = m.Int64Counter(MetricMergedPoints,
		metric.WithDescription("Data points merged into another point whose attribute set became identical after sanitising."),
		metric.WithUnit("{point}")); err != nil {
		return nil, err
	}
	if t.fallback, err = m.Int64Counter(MetricReceivedAtFallback,
		metric.WithDescription("Requests without a valid x-scf-received-at; the Collector's clock was used."),
		metric.WithUnit("{request}")); err != nil {
		return nil, err
	}
	if t.noLevel, err = m.Int64Counter(MetricTenantLevelAbsent,
		metric.WithDescription("Requests without a valid x-scf-tenant-level (reason missing or invalid); scf.tenant.level was not stamped."),
		metric.WithUnit("{request}")); err != nil {
		return nil, err
	}
	return &t, nil
}

func (t *telemetry) recordDrops(ctx context.Context, signal string, byReason map[string]int64) {
	for reason, n := range byReason {
		t.dropped.Add(ctx, n, metric.WithAttributes(attribute.String("signal", signal), attribute.String("reason", reason)))
	}
}

// recordLevel counts a request whose tenant level was not stamped.
func (t *telemetry) recordLevel(ctx context.Context, rm *requestMeta) {
	if rm.levelAbsent != "" {
		t.noLevel.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", rm.levelAbsent)))
	}
}

// redactionSum accumulates pathnorm redaction counts over one request.
type redactionSum struct {
	kinds [16][4]int
	// freeText counts kept free-text values (resource, scope, rpc.*)
	// replaced by Redacted (C-114).
	freeText int
}

func (s *redactionSum) add(r pathnorm.Redactions) {
	r.Each(func(k pathnorm.Kind, l pathnorm.Location, n int) {
		if int(k) < len(s.kinds) && int(l) < len(s.kinds[0]) {
			s.kinds[k][l] += n
		}
	})
}

func (t *telemetry) recordRedactionSum(ctx context.Context, s *redactionSum) {
	if s.freeText > 0 {
		t.redactions.Add(ctx, int64(s.freeText), metric.WithAttributes(
			attribute.String("kind", "free_text"), attribute.String("location", "attribute")))
	}
	for k := range s.kinds {
		for l, n := range s.kinds[k] {
			if n > 0 {
				t.redactions.Add(ctx, int64(n), metric.WithAttributes(
					attribute.String("kind", pathnorm.Kind(k).String()),
					attribute.String("location", pathnorm.Location(l).String())))
			}
		}
	}
}
