// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"context"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.uber.org/zap"
)

// sanitizer holds one pipeline's instance of the step. It keeps no state
// between requests.
type sanitizer struct {
	cfg Config
	log *zap.Logger
	tel *telemetry
	now func() time.Time
}

// meta reads the gateway metadata of the request in ctx.
func (s *sanitizer) meta(ctx context.Context) (requestMeta, bool) {
	return parseMeta(client.FromContext(ctx).Metadata, s.now())
}

// noTenant counts a request without a valid tenant id. It cannot be reported
// to a tenant; the gateway never forwards such a request (§f.4).
func (s *sanitizer) noTenant(ctx context.Context, signal string, items int64) {
	s.tel.dropped.Add(ctx, items, metric.WithAttributes(attribute.String("signal", signal), attribute.String("reason", ReasonNoTenant)))
	s.log.Debug("request without valid tenant metadata dropped", zap.String("signal", signal), zap.Int64("items", items))
}
