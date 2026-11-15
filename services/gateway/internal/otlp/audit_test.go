// SPDX-License-Identifier: Apache-2.0

package otlp

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
)

// Regression tests for the hardening of the gateway's OTLP door.

// blockingCollector holds every request until release is closed.
type blockingCollector struct {
	entered chan struct{}
	release chan struct{}
}

func (b *blockingCollector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.entered <- struct{}{}
	<-b.release
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(200)
}

// Concurrent requests are bounded per tenant (429) and per node (503) before any body is read.
func TestOTLPInflightBounds(t *testing.T) {
	e := newEnv(t)
	bc := &blockingCollector{entered: make(chan struct{}, 16), release: make(chan struct{})}
	e.door.CollectorHTTP = h2cServer(t, bc)
	e.door.MaxInflight, e.door.TenantInflight = 2, 2
	e.door.Init()
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r := e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 200 {
				t.Errorf("held request: %d", r.StatusCode)
			}
		}()
	}
	<-bc.entered
	<-bc.entered
	r := e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID))
	if r.StatusCode != 429 || r.Header.Get("Retry-After") == "" {
		t.Fatalf("over the tenant bound: %d", r.StatusCode)
	}
	if st, _ := e.grpcCall(pathMetrics, protoBody, auth(tokenID)); st != "8" {
		t.Fatalf("gRPC over the tenant bound: %s", st)
	}
	close(bc.release)
	wg.Wait()

	// Node bound: tenant bound 2, node bound 1.
	e2 := newEnv(t)
	bc2 := &blockingCollector{entered: make(chan struct{}, 16), release: make(chan struct{})}
	e2.door.CollectorHTTP = h2cServer(t, bc2)
	e2.door.MaxInflight, e2.door.TenantInflight = 1, 1
	e2.door.Init()
	done := make(chan struct{})
	go func() { e2.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID)); close(done) }()
	<-bc2.entered
	e2.door.TenantInflight = 2 // let the tenant through, so the node bound decides
	if r := e2.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 503 {
		t.Fatalf("over the node bound: %d", r.StatusCode)
	}
	close(bc2.release)
	<-done
	// Slots are released: the next request goes through.
	if r := e2.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 200 {
		t.Fatalf("after release: %d", r.StatusCode)
	}
}

// The request rate limit is applied before the body is read and decompressed — a rate-limited tenant's
// gzip bomb is answered 429, not processed into a 413.
func TestOTLPRateLimitBeforeBody(t *testing.T) {
	e := newEnv(t)
	e.apply(defaultTokens(), snapshot.Settings{OTLPRequestsPerS: 1, OTLPBurst: 1, OTLPBytesPerS: 1 << 20})
	if r := e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(make([]byte, MaxDecompressed+1))
	_ = zw.Close()
	h := auth(tokenID)
	h["Content-Encoding"] = "gzip"
	if r := e.post("/v1/metrics", "application/x-protobuf", gz.Bytes(), h); r.StatusCode != 429 {
		t.Fatalf("rate-limited bomb: %d (must be refused before decompression)", r.StatusCode)
	}
	e.now = e.now.Add(2 * time.Second)
	if r := e.post("/v1/metrics", "application/x-protobuf", gz.Bytes(), h); r.StatusCode != 413 {
		t.Fatalf("bomb with budget: %d", r.StatusCode)
	}
}

// The Bearer scheme is case-insensitive.
func TestOTLPBearerCaseInsensitive(t *testing.T) {
	e := newEnv(t)
	for _, scheme := range []string{"bearer ", "BEARER ", "Bearer "} {
		if r := e.post("/v1/metrics", "application/x-protobuf", protoBody, map[string]string{"Authorization": scheme + key(tokenID)}); r.StatusCode != 200 {
			t.Errorf("%q: %d", scheme, r.StatusCode)
		}
	}
	if r := e.post("/v1/metrics", "application/x-protobuf", protoBody, map[string]string{"Authorization": "Basic " + key(tokenID)}); r.StatusCode != 401 {
		t.Errorf("Basic: %d", r.StatusCode)
	}
}
