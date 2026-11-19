// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
	colmetrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
)

// Kafka in, OTLP/HTTP out: the binary's run() against a kfake broker and a
// stand-in OTLP endpoint, as a tenant would point it at UsageMap.
func TestRunExportsOTLP(t *testing.T) {
	var (
		mu      sync.Mutex
		names   = map[string]bool{}
		service string
		auth    string
	)
	otlp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req colmetrics.ExportMetricsServiceRequest
		if r.URL.Path != "/v1/metrics" || proto.Unmarshal(body, &req) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		auth = r.Header.Get("Authorization")
		for _, rm := range req.ResourceMetrics {
			for _, a := range rm.GetResource().GetAttributes() {
				if a.Key == "service.name" {
					service = a.GetValue().GetStringValue()
				}
			}
			for _, sm := range rm.ScopeMetrics {
				for _, m := range sm.Metrics {
					names[m.Name] = true
				}
			}
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		_, _ = w.Write(nil)
	}))
	defer otlp.Close()

	cluster, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.SeedTopics(1, "TRANSACTION"))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	prod, err := kgo.NewClient(kgo.SeedBrokers(cluster.ListenAddrs()...))
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range lines(t, "testdata/events.jsonl") {
		if err := prod.ProduceSync(context.Background(), &kgo.Record{Topic: "TRANSACTION", Value: v}).FirstErr(); err != nil {
			t.Fatal(err)
		}
	}
	prod.Close()

	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", otlp.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Bearer test-key")
	t.Setenv("OTEL_METRIC_EXPORT_INTERVAL", "200")
	t.Setenv("AP_KAFKA_BROKERS", cluster.ListenAddrs()[0])
	t.Setenv("AP_KAFKA_START", "earliest")
	t.Setenv("STELLAR_NETWORK", "testnet")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := run(ctx, cfg, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	var got []string
	for n := range names {
		got = append(got, n)
	}
	sort.Strings(got)
	for _, want := range []string{MetricCreated, MetricTransitions, MetricStatusDuration, MetricDuration, MetricCustomers, MetricQuotes} {
		if !names[want] {
			t.Errorf("metric %s not exported (got %v)", want, got)
		}
	}
	if service != defaultServiceName {
		t.Errorf("service.name = %q", service)
	}
	if auth != "Bearer test-key" {
		t.Errorf("OTLP headers not applied")
	}
}
