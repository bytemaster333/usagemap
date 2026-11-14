// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/processor/processorhelper"
)

// TypeStr is the component type used in Collector configuration.
const TypeStr = "scfsanitize"

var componentType = component.MustNewType(TypeStr)

// NewFactory returns the factory referenced from collector/builder-config.yaml.
// Only traces and metrics are supported: the distribution has no logs pipeline.
func NewFactory() processor.Factory {
	return processor.NewFactory(
		componentType,
		func() component.Config { return createDefaultConfig() },
		processor.WithTraces(createTraces, component.StabilityLevelBeta),
		processor.WithMetrics(createMetrics, component.StabilityLevelBeta),
	)
}

func newSanitizer(set processor.Settings, cfg component.Config) (*sanitizer, error) {
	c, ok := cfg.(*Config)
	if !ok {
		return nil, fmt.Errorf("scfsanitize: unexpected config type %T", cfg)
	}
	tel, err := newTelemetry(set.TelemetrySettings)
	if err != nil {
		return nil, err
	}
	return &sanitizer{cfg: *c, log: set.Logger, tel: tel, now: time.Now}, nil
}

func createTraces(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Traces) (processor.Traces, error) {
	s, err := newSanitizer(set, cfg)
	if err != nil {
		return nil, err
	}
	return processorhelper.NewTraces(ctx, set, cfg, next, s.processTraces,
		processorhelper.WithCapabilities(consumer.Capabilities{MutatesData: true}))
}

func createMetrics(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Metrics) (processor.Metrics, error) {
	s, err := newSanitizer(set, cfg)
	if err != nil {
		return nil, err
	}
	return processorhelper.NewMetrics(ctx, set, cfg, next, s.processMetrics,
		processorhelper.WithCapabilities(consumer.Capabilities{MutatesData: true}))
}
