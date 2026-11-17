// SPDX-License-Identifier: Apache-2.0

package prober

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/health-controller/internal/config"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/fakeedge"
)

func TestProbeHealthAndCanary(t *testing.T) {
	edge := &fakeedge.Edge{}
	srv := httptest.NewServer(edge)
	defer srv.Close()
	p := &HTTP{Client: DefaultClient(2 * time.Second), Ingest: DefaultClient(2 * time.Second), Instance: "mon-c",
		Canary: &config.Canary{SiteKey: "0123456789abcdefghijkl", Origin: "https://canary.test"}}
	n := config.Node{ID: "edge-a1", HealthURL: srv.URL + "/healthz", IngestURL: srv.URL}

	if r := p.Probe(context.Background(), n); !r.OK || r.Reason != "ok" {
		t.Fatalf("healthy: %+v", r)
	}
	if edge.Events.Load() != 1 {
		t.Fatal("canary event not sent through the real probe client")
	}
	edge.RejectAll.Store(true)
	if r := p.Probe(context.Background(), n); r.OK || r.Reason != "canary_failed" {
		t.Fatalf("canary refused: %+v", r)
	}
	edge.RejectAll.Store(false)
	edge.Unhealthy.Store(true)
	if r := p.Probe(context.Background(), n); r.OK || r.Reason != "health_failed" {
		t.Fatalf("unhealthy: %+v", r)
	}
	srv.Close()
	if r := p.Probe(context.Background(), n); r.OK {
		t.Fatalf("down: %+v", r)
	}
}

func TestHealthOnlyNode(t *testing.T) {
	edge := &fakeedge.Edge{}
	srv := httptest.NewServer(edge)
	defer srv.Close()
	p := &HTTP{Client: DefaultClient(time.Second), Ingest: DefaultClient(time.Second), Instance: "mon-c"}
	if r := p.Probe(context.Background(), config.Node{ID: "core-a", HealthURL: srv.URL + "/healthz"}); !r.OK {
		t.Fatalf("%+v", r)
	}
	if edge.Challenges.Load() != 0 {
		t.Fatal("no canary expected without ingest_url")
	}
}
