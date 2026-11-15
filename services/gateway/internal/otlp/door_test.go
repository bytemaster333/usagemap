// SPDX-License-Identifier: Apache-2.0

package otlp

import (
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
)

const (
	tenantA  = "0193b7e2-0000-7000-8000-00000000000a"
	tenantP  = "0193b7e2-0000-7000-8000-00000000000b"
	tokenID  = "AbCdEfGhIjKl"
	tokenP   = "PendPendPend"
	tokenX   = "ExpiredExpir"
	secret   = "0123456789abcdefghijABCDEFG"
	vendorKV = "VendorSecret4242"
)

var pepper = bytes.Repeat([]byte{0x5a}, 32)

func hashOf(s string) string {
	m := hmac.New(sha256.New, pepper)
	m.Write([]byte(s))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

type seen struct {
	path    string
	headers http.Header
	body    []byte
}

type fakeCollector struct {
	mu     sync.Mutex
	got    []seen
	status int    // HTTP status for /v1/*
	grpc   string // grpc-status answer
}

func (f *fakeCollector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.got = append(f.got, seen{r.URL.Path, r.Header.Clone(), b})
	st, gs := f.status, f.grpc
	f.mu.Unlock()
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc") {
		w.Header().Set("Content-Type", "application/grpc")
		w.Header().Set("Trailer", "Grpc-Status")
		w.WriteHeader(200)
		_, _ = w.Write([]byte{0, 0, 0, 0, 0})
		w.Header().Set("Grpc-Status", gs)
		return
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(st)
}

func h2cServer(t *testing.T, h http.Handler) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	srv := &http.Server{Handler: h, Protocols: p}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return "http://" + l.Addr().String()
}

type env struct {
	door *Door
	col  *fakeCollector
	url  string
	agg  *counters.Agg
	reg  *metrics.Registry
	now  time.Time
	s    *snapshot.Store
	priv ed25519.PrivateKey
	seq  int64
	t    *testing.T
}

func (e *env) apply(tokens []snapshot.IngestToken, settings snapshot.Settings) {
	e.seq++
	p := snapshot.Payload{Sequence: e.seq, IssuedAt: "x", Settings: settings,
		Tenants:      []snapshot.Tenant{{TenantID: tenantA, Status: "active", Level: 4}, {TenantID: tenantP, Status: "pending", Level: 0}},
		IngestTokens: tokens}
	pb, _ := json.Marshal(p)
	raw, _ := json.Marshal(snapshot.Envelope{Format: snapshot.Format, Alg: "Ed25519", Kid: "k", Payload: base64.RawURLEncoding.EncodeToString(pb), Sig: base64.RawURLEncoding.EncodeToString(ed25519.Sign(e.priv, pb))})
	if err := e.s.Apply(raw); err != nil {
		e.t.Fatal(err)
	}
}

var defaultSettings = snapshot.Settings{OTLPRequestsPerS: 50, OTLPBurst: 200, OTLPBytesPerS: 1 << 20}

func defaultTokens() []snapshot.IngestToken {
	past := "2026-01-01T00:00:00.000Z"
	return []snapshot.IngestToken{
		{TokenID: tokenID, TenantID: tenantA, Hash: hashOf(secret), PepperVersion: 1, AllowedServiceNames: []string{"api", "web shop"}},
		{TokenID: tokenP, TenantID: tenantP, Hash: hashOf(secret), PepperVersion: 1},
		{TokenID: tokenX, TenantID: tenantA, Hash: hashOf(secret), PepperVersion: 1, ExpiresAt: &past},
	}
}

func newEnv(t *testing.T) *env {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	e := &env{col: &fakeCollector{status: 200, grpc: "0"}, agg: counters.New(), reg: metrics.New(), now: time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC), priv: priv, t: t}
	e.s = snapshot.NewStore(filepath.Join(t.TempDir(), "s.json"), snapshot.Keys{"k": pub})
	e.apply(defaultTokens(), defaultSettings)
	col := h2cServer(t, e.col)
	e.door = &Door{Snap: e.s, Peppers: map[int][]byte{1: pepper}, Node: "edge-a1", Counters: e.agg, Metrics: e.reg,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return e.now }, CollectorHTTP: col, CollectorGRPC: col}
	e.door.Init()
	mux := http.NewServeMux()
	e.door.Register(mux)
	e.url = h2cServer(t, mux)
	return e
}

func key(id string) string { return MakeIngestKey(id, secret) }

func (e *env) post(path, ct string, body []byte, hdr map[string]string) *http.Response {
	req, _ := http.NewRequest(http.MethodPost, e.url+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", ct)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	return resp
}

// grpcCall sends a unary gRPC request over h2c and returns grpc-status (from trailers or a trailers-only answer).
func (e *env) grpcCall(path string, msg []byte, hdr map[string]string) (string, http.Header) {
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	c := &http.Client{Transport: &http.Transport{Protocols: p}}
	frame := make([]byte, 5, 5+len(msg))
	binary.BigEndian.PutUint32(frame[1:], uint32(len(msg)))
	frame = append(frame, msg...)
	if hdr["gzip"] == "1" {
		var b bytes.Buffer
		zw := gzip.NewWriter(&b)
		_, _ = zw.Write(msg)
		_ = zw.Close()
		frame = append([]byte{1, 0, 0, 0, 0}, b.Bytes()...)
		binary.BigEndian.PutUint32(frame[1:], uint32(b.Len()))
		delete(hdr, "gzip")
		hdr["grpc-encoding"] = "gzip"
	}
	req, _ := http.NewRequest(http.MethodPost, e.url+path, bytes.NewReader(frame))
	req.Header.Set("Content-Type", "application/grpc")
	req.Header.Set("Te", "trailers")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if s := resp.Header.Get("Grpc-Status"); s != "" {
		return s, resp.Header
	}
	return resp.Trailer.Get("Grpc-Status"), resp.Header
}

// A tiny well-formed OTLP protobuf (ExportMetricsServiceRequest with one empty ResourceMetrics).
var protoBody = []byte{0x0a, 0x00}

func auth(id string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + key(id)}
}

func TestKeyChecksum(t *testing.T) {
	k := key(tokenID)
	if _, _, ok := ParseIngestKey(k); !ok {
		t.Fatal("valid key refused")
	}
	bad := k[:len(k)-1] + "x"
	if bad == k {
		bad = k[:len(k)-1] + "y"
	}
	if _, _, ok := ParseIngestKey(bad); ok {
		t.Fatal("bad CRC accepted")
	}
	// Cross-check with the control plane's algorithm: base62 of CRC-32 IEEE, 6 characters, zero-padded.
	if c := checksum("000000000000", "000000000000000000000000000"); len(c) != 6 {
		t.Fatal(c)
	}
}

func TestHTTPForwardsOnlyAllowedHeaders(t *testing.T) {
	e := newEnv(t)
	hdr := auth(tokenID)
	hdr["User-Agent"] = "OTel-OTLP-Exporter-Go/1.0 marker"
	hdr["X-Scf-Tenant-Id"] = "00000000-0000-0000-0000-000000000000" // spoofed: must be replaced
	hdr["Dd-Api-Key"] = vendorKV
	hdr["X-Forwarded-For"] = "203.0.113.9"
	hdr["Content-Encoding"] = "gzip"
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(protoBody)
	_ = zw.Close()
	resp := e.post("/v1/metrics", "application/x-protobuf", gz.Bytes(), hdr)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	got := e.col.got[0]
	if got.path != "/v1/metrics" || !bytes.Equal(got.body, gz.Bytes()) {
		t.Fatal("body or path changed")
	}
	allowed := map[string]bool{"Content-Type": true, "Content-Encoding": true, "Content-Length": true, "Accept-Encoding": true,
		"X-Scf-Tenant-Id": true, "X-Scf-Token-Id": true, "X-Scf-Allowed-Services": true, "X-Scf-Tenant-Level": true, "X-Scf-Received-At": true, "X-Scf-Node": true}
	for k := range got.headers {
		if !allowed[k] {
			t.Errorf("header %s forwarded", k)
		}
	}
	h := got.headers
	if _, ok := h["User-Agent"]; ok {
		t.Errorf("a User-Agent reached the Collector (%q): neither the client's nor the gateway's own may (§f.4)", h.Get("User-Agent"))
	}
	if h.Get("X-Scf-Tenant-Id") != tenantA || len(h.Values("X-Scf-Tenant-Id")) != 1 || h.Get("X-Scf-Token-Id") != tokenID ||
		h.Get("X-Scf-Allowed-Services") != "api,web%20shop" || h.Get("X-Scf-Tenant-Level") != "L3" || h.Get("X-Scf-Node") != "edge-a1" ||
		h.Get("X-Scf-Received-At") != strconv.FormatInt(e.now.UnixNano(), 10) || h.Get("Content-Encoding") != "gzip" {
		t.Fatalf("metadata %v", h)
	}
	for _, v := range h {
		for _, x := range v {
			if strings.Contains(x, secret) || strings.Contains(x, vendorKV) || strings.Contains(x, "203.0.113.9") {
				t.Fatal("credential or address forwarded")
			}
		}
	}
}

func TestAuthFailures(t *testing.T) {
	e := newEnv(t)
	cases := []struct {
		name string
		hdr  map[string]string
		want int
		msg  string
	}{
		{"none", nil, 401, "missing or invalid"},
		{"vendor only", map[string]string{"DD-API-KEY": vendorKV}, 401, "vendor credential"},
		{"basic", map[string]string{"Authorization": "Basic dXNlcjpwYXNz"}, 401, "vendor credential"},
		{"bad crc", map[string]string{"Authorization": "Bearer " + key(tokenID)[:51] + "000000"}, 401, "missing or invalid"},
		{"unknown id", auth("ZZZZZZZZZZZZ"), 401, "invalid, revoked"},
		{"wrong secret", map[string]string{"Authorization": "Bearer " + MakeIngestKey(tokenID, strings.Repeat("9", 27))}, 401, "invalid, revoked"},
		{"expired", auth(tokenX), 401, "expired"},
		{"pending tenant", auth(tokenP), 403, "pending"},
	}
	for _, c := range cases {
		resp := e.post("/v1/traces", "application/json", []byte(`{}`), c.hdr)
		b, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != c.want || !strings.Contains(string(b), c.msg) {
			t.Errorf("%s: %d %s", c.name, resp.StatusCode, b)
		}
		if strings.Contains(string(b), vendorKV) || strings.Contains(string(b), secret) {
			t.Errorf("%s: credential echoed", c.name)
		}
	}
	if len(e.col.got) != 0 {
		t.Fatal("nothing may reach the Collector")
	}
	if e.agg.GetOTLP(tenantP, e.now, "tenant_pending") != 1 || e.agg.GetOTLP(tenantA, e.now, "token_expired") != 1 {
		t.Fatal("rejections must be counted per tenant (§d.3 otlp)")
	}
}

func TestRevokedTokenRefusedAfterNextSnapshot(t *testing.T) {
	e := newEnv(t)
	if r := e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	e.apply(nil, defaultSettings) // the control plane revoked every token
	if r := e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 401 {
		t.Fatalf("revoked token: %d", r.StatusCode)
	}
}

func TestLogsRefused(t *testing.T) {
	e := newEnv(t)
	if r := e.post("/v1/logs", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 404 {
		t.Fatalf("HTTP logs: %d", r.StatusCode)
	}
	if st, _ := e.grpcCall("/opentelemetry.proto.collector.logs.v1.LogsService/Export", protoBody, auth(tokenID)); st != "12" {
		t.Fatalf("gRPC logs: %s", st)
	}
	if len(e.col.got) != 0 {
		t.Fatal("logs reached the Collector")
	}
	if e.agg.GetOTLP(tenantA, e.now, "logs_rejected") != 2 {
		t.Fatal("logs_rejected counter")
	}
}

func TestSizeLimits(t *testing.T) {
	e := newEnv(t)
	big := make([]byte, MaxCompressed+10)
	if r := e.post("/v1/metrics", "application/x-protobuf", big, auth(tokenID)); r.StatusCode != 413 {
		t.Fatalf("compressed > 4 MiB: %d", r.StatusCode)
	}
	// gzip bomb: 17 MiB of zeros compresses to a few KiB.
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(make([]byte, MaxDecompressed+1))
	_ = zw.Close()
	h := auth(tokenID)
	h["Content-Encoding"] = "gzip"
	if r := e.post("/v1/metrics", "application/x-protobuf", gz.Bytes(), h); r.StatusCode != 413 {
		t.Fatalf("decompressed > 16 MiB: %d", r.StatusCode)
	}
	g := auth(tokenID)
	g["gzip"] = "1"
	if st, hd := e.grpcCall(pathMetrics, make([]byte, MaxDecompressed+1), g); st != "8" || hd.Get("Grpc-Status-Details-Bin") != "" {
		t.Fatalf("gRPC 16 MiB: %s (no RetryInfo expected)", st)
	}
}

func TestMalformed(t *testing.T) {
	e := newEnv(t)
	if r := e.post("/v1/metrics", "application/x-protobuf", []byte{0x0a, 0x05, 0x01}, auth(tokenID)); r.StatusCode != 400 {
		t.Fatalf("truncated protobuf: %d", r.StatusCode)
	}
	if r := e.post("/v1/metrics", "application/json", []byte(`{"resourceMetrics":[`), auth(tokenID)); r.StatusCode != 400 {
		t.Fatalf("bad JSON: %d", r.StatusCode)
	}
	if r := e.post("/v1/metrics", "text/plain", protoBody, auth(tokenID)); r.StatusCode != 400 {
		t.Fatalf("content type: %d", r.StatusCode)
	}
	if st, _ := e.grpcCall(pathMetrics, []byte{0x0a, 0x09}, auth(tokenID)); st != "3" {
		t.Fatalf("gRPC malformed: %s", st)
	}
}

func TestRateLimit(t *testing.T) {
	e := newEnv(t)
	e.apply(defaultTokens(), snapshot.Settings{OTLPRequestsPerS: 1, OTLPBurst: 2, OTLPBytesPerS: 1 << 20})
	codes := []int{}
	var last *http.Response
	for i := 0; i < 3; i++ {
		last = e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID))
		codes = append(codes, last.StatusCode)
	}
	if codes[0] != 200 || codes[1] != 200 || codes[2] != 429 || last.Header.Get("Retry-After") != "1" {
		t.Fatalf("codes %v retry %q", codes, last.Header.Get("Retry-After"))
	}
	st, hd := e.grpcCall(pathMetrics, protoBody, auth(tokenID))
	if st != "8" || hd.Get("Grpc-Status-Details-Bin") == "" {
		t.Fatalf("gRPC rate limit: %s, RetryInfo %q", st, hd.Get("Grpc-Status-Details-Bin"))
	}
	if e.agg.GetOTLP(tenantA, e.now, "rate_limited") != 2 {
		t.Fatal("rate_limited counter")
	}
	e.now = e.now.Add(2 * time.Second)
	if r := e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 200 {
		t.Fatal("bucket did not refill")
	}
}

func TestGRPCProxy(t *testing.T) {
	e := newEnv(t)
	hdr := auth(tokenID)
	hdr["User-Agent"] = "grpc-go/1.70 marker"
	hdr["api-key"] = vendorKV
	st, _ := e.grpcCall(pathMetrics, protoBody, hdr)
	if st != "0" {
		t.Fatalf("grpc-status %s", st)
	}
	got := e.col.got[0]
	if got.path != pathMetrics || got.headers.Get("Te") != "trailers" || got.headers.Get("X-Scf-Tenant-Id") != tenantA || got.headers.Get("Api-Key") != "" || got.headers.Get("Authorization") != "" {
		t.Fatalf("forwarded %v", got.headers)
	}
	if _, ok := got.headers["User-Agent"]; ok {
		t.Fatalf("a User-Agent reached the Collector over gRPC: %q", got.headers.Get("User-Agent"))
	}
	// Collector unavailable → UNAVAILABLE.
	e.col.grpc = "14"
	if st, _ := e.grpcCall(pathTraces, protoBody, auth(tokenID)); st != "14" {
		t.Fatalf("collector unavailable: %s", st)
	}
}

func TestCollectorDown503(t *testing.T) {
	e := newEnv(t)
	e.door.CollectorHTTP = "http://127.0.0.1:1"
	r := e.post("/v1/traces", "application/x-protobuf", protoBody, auth(tokenID))
	if r.StatusCode != 503 || r.Header.Get("Retry-After") == "" {
		t.Fatalf("collector down: %d", r.StatusCode)
	}
	e.door.CollectorHTTP = h2cServer(t, e.col)
	e.col.status = 503
	if r := e.post("/v1/traces", "application/x-protobuf", protoBody, auth(tokenID)); r.StatusCode != 503 {
		t.Fatalf("collector queue full: %d", r.StatusCode)
	}
}

func TestWellFormed(t *testing.T) {
	for _, c := range []struct {
		b  []byte
		ok bool
	}{{[]byte{}, true}, {[]byte{0x08, 0x96, 0x01}, true}, {[]byte{0x0a, 0x02, 'h', 'i'}, true}, {[]byte{0x0a, 0x03, 'h'}, false}, {[]byte{0x00}, false}, {[]byte{0x0b}, false}, {[]byte{0x09, 1, 2}, false}} {
		if WellFormed(c.b) != c.ok {
			t.Errorf("%x: %v", c.b, !c.ok)
		}
	}
}

func TestParsePeppers(t *testing.T) {
	std := base64.StdEncoding.EncodeToString(pepper)
	m, err := ParsePeppers("1:" + std + ",2:" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 40)))
	if err != nil || !bytes.Equal(m[1], pepper) || len(m[2]) != 40 {
		t.Fatal(err)
	}
	if _, err := ParsePeppers("1:c2hvcnQ="); err == nil {
		t.Fatal("short pepper accepted")
	}
}

// C-124: scf_gateway_otlp_requests_total carries outcome and reason (closed sets) for OTLPRejectedSpike.
func TestRequestMetricOutcomeReason(t *testing.T) {
	e := newEnv(t)
	e.apply(defaultTokens(), snapshot.Settings{OTLPRequestsPerS: 1, OTLPBurst: 1, OTLPBytesPerS: 1 << 20})
	e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID))                     // accepted
	e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID))                     // 429
	e.post("/v1/metrics", "application/x-protobuf", protoBody, nil)                               // 401
	e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenP))                      // 403
	e.post("/v1/logs", "application/x-protobuf", protoBody, auth(tokenID))                        // 404
	e.now = e.now.Add(5 * time.Second)                                                            // the request rate limit comes first
	e.post("/v1/metrics", "application/x-protobuf", make([]byte, MaxCompressed+1), auth(tokenID)) // 413
	e.now = e.now.Add(5 * time.Second)
	e.post("/v1/metrics", "text/plain", protoBody, auth(tokenID)) // 400
	for _, c := range []struct {
		signal, status, outcome, reason string
	}{
		{"metrics", "200", "accepted", "none"}, {"metrics", "429", "rejected", "rate_limit"}, {"metrics", "401", "rejected", "auth"},
		{"metrics", "403", "rejected", "tenant"}, {"logs", "404", "rejected", "logs"}, {"metrics", "413", "rejected", "size"},
		{"metrics", "400", "rejected", "schema"},
	} {
		if e.reg.Get("scf_gateway_otlp_requests_total", "signal", c.signal, "protocol", "http", "status", c.status, "outcome", c.outcome, "reason", c.reason) != 1 {
			var b strings.Builder
			e.reg.Write(&b)
			t.Fatalf("missing %+v in\n%s", c, b.String())
		}
	}
	e.col.grpc = "14"
	e.now = e.now.Add(5 * time.Second)
	e.grpcCall(pathTraces, protoBody, auth(tokenID))
	if e.reg.Get("scf_gateway_otlp_requests_total", "signal", "traces", "protocol", "grpc", "status", "14", "outcome", "unavailable", "reason", "unavailable") != 1 {
		t.Fatal("grpc unavailable not counted")
	}
}

// §e.4 hard expiry: OTLP ingest on an expired snapshot → 503 / UNAVAILABLE with retry 30 s, nothing forwarded.
func TestSnapshotExpiredRefusesOTLP(t *testing.T) {
	e := newEnv(t)
	e.seq++
	p := snapshot.Payload{Sequence: e.seq, IssuedAt: "x", ExpiresAt: e.now.Add(-10 * time.Minute).Format(time.RFC3339), Settings: defaultSettings,
		Tenants: []snapshot.Tenant{{TenantID: tenantA, Status: "active", Level: 4}}, IngestTokens: defaultTokens()}
	pb, _ := json.Marshal(p)
	raw, _ := json.Marshal(snapshot.Envelope{Format: snapshot.Format, Alg: "Ed25519", Kid: "k", Payload: base64.RawURLEncoding.EncodeToString(pb), Sig: base64.RawURLEncoding.EncodeToString(ed25519.Sign(e.priv, pb))})
	if err := e.s.Apply(raw); err != nil {
		t.Fatal(err)
	}
	r := e.post("/v1/metrics", "application/x-protobuf", protoBody, auth(tokenID))
	b, _ := io.ReadAll(r.Body)
	if r.StatusCode != 503 || r.Header.Get("Retry-After") != "30" || !strings.Contains(string(b), "snapshot_expired") {
		t.Fatalf("http: %d %q %s", r.StatusCode, r.Header.Get("Retry-After"), b)
	}
	if st, hd := e.grpcCall(pathMetrics, protoBody, auth(tokenID)); st != "14" || hd.Get("Grpc-Status-Details-Bin") == "" {
		t.Fatalf("grpc: %s", st)
	}
	if len(e.col.got) != 0 {
		t.Fatal("forwarded on an expired snapshot")
	}
}
