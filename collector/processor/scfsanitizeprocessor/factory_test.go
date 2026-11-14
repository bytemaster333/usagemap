// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/confmap"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/processor/processortest"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestFactoryAndConfig(t *testing.T) {
	f := NewFactory()
	if f.Type().String() != "scfsanitize" {
		t.Fatalf("type %s", f.Type())
	}
	cfg := f.CreateDefaultConfig().(*Config)
	if cfg.MaxFuture != 5*time.Minute || cfg.MaxAge != 48*time.Hour {
		t.Fatalf("defaults %+v", cfg)
	}
	if err := componenttest.CheckConfigStruct(cfg); err != nil {
		t.Fatal(err)
	}
	if err := confmap.Validate(cfg); err != nil {
		t.Fatal(err)
	}
	if f.LogsStability().String() != "Undefined" {
		t.Fatalf("logs must not be supported, stability %s", f.LogsStability())
	}
	if _, err := f.CreateLogs(context.Background(), processortest.NewNopSettings(f.Type()), cfg, consumertest.NewNop()); err == nil {
		t.Fatal("logs processor created")
	}
}

func TestConfigUnmarshalAndValidate(t *testing.T) {
	tests := []struct {
		raw     map[string]any
		wantErr string
	}{
		{raw: map[string]any{}},
		{raw: map[string]any{"max_future": "1m", "max_age": "24h"}},
		{raw: map[string]any{"max_future": "0s"}, wantErr: "max_future"},
		{raw: map[string]any{"max_age": "-1h"}, wantErr: "max_age"},
		{raw: map[string]any{"max_age": "73h"}, wantErr: "72h"},
		{raw: map[string]any{"tenant_header": "x"}, wantErr: "invalid keys"},
	}
	for _, tc := range tests {
		cfg := createDefaultConfig()
		err := confmap.NewFromStringMap(tc.raw).Unmarshal(cfg)
		if err == nil {
			err = confmap.Validate(cfg)
		}
		if tc.wantErr == "" && err != nil || tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
			t.Errorf("%v: err = %v, want %q", tc.raw, err, tc.wantErr)
		}
	}
}

func TestShutdownAndCapabilities(t *testing.T) {
	// processortest.VerifyShutdown is not usable: it sends requests without
	// tenant metadata, which this processor drops by design. newHarness starts
	// both processors and shuts them down in its cleanup.
	h := newHarness(t)
	if !h.metrics.Capabilities().MutatesData || !h.traces.Capabilities().MutatesData {
		t.Fatal("must declare MutatesData")
	}
}

func TestLogsNeverContainValues(t *testing.T) {
	core, logs := observer.New(zap.DebugLevel)
	f := NewFactory()
	set := processortest.NewNopSettings(f.Type())
	set.Logger = zap.New(core)
	sink := new(consumertest.TracesSink)
	p, err := f.CreateTraces(context.Background(), set, f.CreateDefaultConfig(), sink)
	if err != nil {
		t.Fatal(err)
	}
	td := s04Canary()
	if err := p.ConsumeTraces(defaultMeta().ctx(), td); err != nil {
		t.Fatal(err)
	}
	m := defaultMeta()
	m.tenant = "CANARY-TENANT"
	if err := p.ConsumeTraces(m.ctx(), s04Canary()); err != nil {
		t.Fatal(err)
	}
	if logs.Len() == 0 {
		t.Fatal("expected debug logs")
	}
	for _, e := range logs.All() {
		line := e.Message
		for k, v := range e.ContextMap() {
			line += " " + k + "=" + fmt.Sprint(v)
		}
		if canaryPattern.MatchString(line) || strings.Contains(line, "203.0.113") || strings.Contains(line, "/users/") || strings.Contains(line, testTenant) {
			t.Fatalf("log line carries a value: %s", line)
		}
	}
}
