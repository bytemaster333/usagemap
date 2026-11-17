// SPDX-License-Identifier: Apache-2.0

// Package prober checks one node per round (C-92): its health endpoint over the mesh and, for edge nodes, one canary
// event to the node's own public origin through the gateway's protocol-level probe client (wire-formats §o), which
// fetches a challenge, solves the proof-of-work and expects a 202.
package prober

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/pkg/probe"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/config"
)

// Result of one node in one round. Reason is a closed word: ok, health_failed, canary_failed.
type Result struct {
	Node   string `json:"node"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason"`
}

// Prober checks nodes.
type Prober interface {
	Probe(ctx context.Context, n config.Node) Result
}

// HTTP is the production prober.
type HTTP struct {
	Client   *http.Client // health checks (mesh; mTLS configured by the caller)
	Ingest   *http.Client // canary events (public TLS)
	Canary   *config.Canary
	Instance string
}

// Probe runs the health check and, when the node has an ingest origin and a canary is configured, the canary event.
func (p *HTTP) Probe(ctx context.Context, n config.Node) Result {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.HealthURL, nil)
	if err != nil {
		return Result{Node: n.ID, Reason: "health_failed"}
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return Result{Node: n.ID, Reason: "health_failed"}
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Result{Node: n.ID, Reason: "health_failed"}
	}
	if n.IngestURL == "" || p.Canary == nil {
		return Result{Node: n.ID, OK: true, Reason: "ok"}
	}
	tv := p.Canary.TrackerVersion
	if tv == "" {
		tv = "1.0.0"
	}
	r, err := probe.Send(ctx, probe.Config{
		Target: n.IngestURL, SiteKey: p.Canary.SiteKey, Origin: p.Canary.Origin, TrackerVersion: tv,
		Path: "/canary/" + p.Instance + "/" + n.ID, Client: p.Ingest,
	})
	if err != nil || !r.OK() {
		return Result{Node: n.ID, Reason: "canary_failed"}
	}
	return Result{Node: n.ID, OK: true, Reason: "ok"}
}

// Func adapts a function (tests).
type Func func(ctx context.Context, n config.Node) Result

// Probe calls f.
func (f Func) Probe(ctx context.Context, n config.Node) Result { return f(ctx, n) }

// DefaultClient is a client with sane timeouts.
func DefaultClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{DisableKeepAlives: true, ResponseHeaderTimeout: timeout}}
}
