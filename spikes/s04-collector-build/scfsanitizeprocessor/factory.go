// SPDX-License-Identifier: Apache-2.0
// Package scfsanitizeprocessor is the S-04 plumbing stub of the UsageMap sanitise processor.
//
// It proves only the plumbing: reading gateway-supplied request metadata
// (client.FromContext(ctx).Metadata, filled by the otlp receiver when
// include_metadata is true) for HTTP and gRPC, stamping scf.tenant.id,
// enforcing the allowed-services list, and deleting every attribute that is
// not on a static allow-list. Path normalisation, unit conversion, time
// bounds and drop counters (wire-formats §f.5 steps 4, 6–8) are NOT here.
package scfsanitizeprocessor

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/processor/processorhelper"
)

var typ = component.MustNewType("scfsanitize")

// Config of the stub. Header names are lower-case; client.Metadata.Get is
// case-insensitive anyway.
type Config struct {
	TenantHeader          string `mapstructure:"tenant_header"`
	AllowedServicesHeader string `mapstructure:"allowed_services_header"`
}

func createDefaultConfig() component.Config {
	return &Config{
		TenantHeader:          "x-scf-tenant-id",
		AllowedServicesHeader: "x-scf-allowed-services",
	}
}

// NewFactory is referenced from the ocb builder manifest.
func NewFactory() processor.Factory {
	return processor.NewFactory(
		typ,
		createDefaultConfig,
		processor.WithTraces(createTraces, component.StabilityLevelDevelopment),
		processor.WithMetrics(createMetrics, component.StabilityLevelDevelopment),
	)
}

func createTraces(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Traces) (processor.Traces, error) {
	p := &sanitizer{cfg: cfg.(*Config), log: set.Logger}
	return processorhelper.NewTraces(ctx, set, cfg, next, p.processTraces,
		processorhelper.WithCapabilities(consumer.Capabilities{MutatesData: true}))
}

func createMetrics(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Metrics) (processor.Metrics, error) {
	p := &sanitizer{cfg: cfg.(*Config), log: set.Logger}
	return processorhelper.NewMetrics(ctx, set, cfg, next, p.processMetrics,
		processorhelper.WithCapabilities(consumer.Capabilities{MutatesData: true}))
}
