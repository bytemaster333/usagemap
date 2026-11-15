// SPDX-License-Identifier: Apache-2.0

// Package otlp is the OTLP front door of the edge (wire-formats §f): OTLP/HTTP and OTLP/gRPC for metrics and
// traces, logs refused; ingest-token authentication against the signed snapshot (§f.2, §k, C-81); size limits,
// per-tenant rate limits and the status codes of §f.3; and the proxy to the loopback Collector that forwards ONLY the
// content headers and the gateway's own `x-scf-*` metadata (§f.4, C-107, C-116). Request headers, tokens and bodies
// are never logged.
package otlp

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
)

const (
	// MaxCompressed is the compressed body limit (§f.3).
	MaxCompressed = 4 << 20
	// MaxDecompressed is the decompressed body limit (§f.3).
	MaxDecompressed = 16 << 20

	pathMetrics = "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export"
	pathTraces  = "/opentelemetry.proto.collector.trace.v1.TraceService/Export"
)

// gRPC status codes used here.
const (
	grpcOK                = 0
	grpcInvalidArgument   = 3
	grpcPermissionDenied  = 7
	grpcResourceExhausted = 8
	grpcUnimplemented     = 12
	grpcUnavailable       = 14
	grpcUnauthenticated   = 16
)

// Door serves OTLP.
type Door struct {
	Snap          *snapshot.Store
	Peppers       map[int][]byte // pepper_ing versions (C-81)
	Node          string
	Counters      *counters.Agg
	Metrics       *metrics.Registry
	Log           *slog.Logger
	Now           func() time.Time
	CollectorHTTP string // http://127.0.0.1:4318
	CollectorGRPC string // http://127.0.0.1:4317 (h2c)
	// MaxInflight bounds concurrent OTLP requests on this node (default 16) and TenantInflight per tenant (default
	// 4). Each request may hold up to 4 MiB compressed plus 16 MiB decompressed, so without these bounds a single
	// tenant with many HTTP/2 streams could exhaust the edge's memory.
	MaxInflight    int
	TenantInflight int

	httpClient *http.Client
	h2cClient  *http.Client
	mu         sync.Mutex
	buckets    map[string]*tenantBuckets
	inflight   map[string]int
	global     chan struct{}
}

// Init prepares the clients.
func (d *Door) Init() {
	if d.Now == nil {
		d.Now = time.Now
	}
	d.httpClient = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 32, DisableCompression: true}}
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	d.h2cClient = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Protocols: p, DisableCompression: true}}
	d.buckets = map[string]*tenantBuckets{}
	d.inflight = map[string]int{}
	if d.MaxInflight < 1 {
		d.MaxInflight = 16
	}
	if d.TenantInflight < 1 {
		d.TenantInflight = 4
	}
	d.global = make(chan struct{}, d.MaxInflight)
}

// acquire takes an in-flight slot for the tenant before any body byte is read: over the tenant's bound → 429 (the
// tenant's own concurrency), over the node's bound → 503 (retry, possibly on the other edge).
func (d *Door) acquire(tenant string) (release func(), rej *rejection) {
	d.mu.Lock()
	if d.inflight[tenant] >= d.TenantInflight {
		d.mu.Unlock()
		return nil, &rejection{httpStatus: 429, grpcCode: grpcResourceExhausted, msg: "too many concurrent requests", reason: "rate_limited", retryAfter: 1}
	}
	d.inflight[tenant]++
	d.mu.Unlock()
	undo := func() {
		d.mu.Lock()
		if d.inflight[tenant]--; d.inflight[tenant] <= 0 {
			delete(d.inflight, tenant)
		}
		d.mu.Unlock()
	}
	select {
	case d.global <- struct{}{}:
	default:
		undo()
		d.Metrics.Add("scf_gateway_otlp_inflight_refused_total", 1)
		return nil, &rejection{httpStatus: 503, grpcCode: grpcUnavailable, msg: "edge busy", retryAfter: 1}
	}
	return func() { <-d.global; undo() }, nil
}

// bearer extracts the credential of an `Authorization: Bearer …` value; the scheme is case-insensitive (RFC 9110
// §11.1).
func bearer(v string) (string, bool) {
	if len(v) < 7 || !strings.EqualFold(v[:7], "Bearer ") {
		return "", false
	}
	return strings.TrimSpace(v[7:]), true
}

// Register adds the OTLP routes to mux.
func (d *Door) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/metrics", func(w http.ResponseWriter, r *http.Request) { d.serveHTTP(w, r, "metrics") })
	mux.HandleFunc("POST /v1/traces", func(w http.ResponseWriter, r *http.Request) { d.serveHTTP(w, r, "traces") })
	mux.HandleFunc("/v1/logs", func(w http.ResponseWriter, r *http.Request) { d.serveHTTP(w, r, "logs") })
	mux.HandleFunc(pathMetrics, d.serveGRPC)
	mux.HandleFunc(pathTraces, d.serveGRPC)
	mux.HandleFunc("/opentelemetry.proto.collector.logs.v1.LogsService/", d.serveGRPC)
}

// ---------------------------------------------------------------------------------------------------------- auth

type rejection struct {
	httpStatus int
	grpcCode   int
	msg        string
	reason     string // §d.3 otlp reason (counted per tenant) or ""
	retryAfter int
}

type principal struct {
	token  *snapshot.IngestToken
	tenant *snapshot.Tenant
}

var vendorHeaders = []string{"DD-API-KEY", "X-Honeycomb-Team", "Api-Key", "X-Api-Key", "Signalfx-Token", "X-Sf-Token", "Lightstep-Access-Token"}

func (d *Door) authenticate(r *http.Request, view *snapshot.View, now time.Time) (*principal, *rejection) {
	unauth := func(msg string) *rejection {
		return &rejection{httpStatus: http.StatusUnauthorized, grpcCode: grpcUnauthenticated, msg: msg}
	}
	auths := r.Header.Values("Authorization")
	raw := ""
	if len(auths) == 1 {
		raw, _ = bearer(auths[0])
	}
	id, secret, ok := ParseIngestKey(raw)
	if !ok {
		foreign := len(auths) == 1 && strings.HasPrefix(strings.ToLower(auths[0]), "basic ")
		for _, h := range vendorHeaders {
			if r.Header.Get(h) != "" {
				foreign = true
			}
		}
		if raw == "" && foreign {
			return nil, unauth("a vendor credential was sent but no SCF ingest token: set Authorization: Bearer scfa_ing_… for this exporter")
		}
		return nil, unauth("missing or invalid SCF ingest token")
	}
	t := view.Token(id)
	if t == nil {
		return nil, unauth("invalid, revoked or expired ingest token")
	}
	if _, ok := view.TokenFor(id, secret, d.Peppers, time.Time{}); !ok { // hash only (expiry below)
		return nil, unauth("invalid, revoked or expired ingest token")
	}
	if t.ExpiresAt != nil {
		exp, err := time.Parse(time.RFC3339Nano, *t.ExpiresAt)
		if err != nil || !now.Before(exp) {
			d.Counters.AddOTLP(t.TenantID, now, "token_expired", 1)
			return nil, unauth("ingest token expired")
		}
	}
	ten := view.Tenant(t.TenantID)
	switch {
	case ten == nil:
		return nil, unauth("invalid, revoked or expired ingest token")
	case ten.Status == "pending":
		return nil, &rejection{httpStatus: http.StatusForbidden, grpcCode: grpcPermissionDenied, msg: "tenant pending approval", reason: "tenant_pending"}
	case ten.Status == "suspended":
		return nil, &rejection{httpStatus: http.StatusForbidden, grpcCode: grpcPermissionDenied, msg: "tenant suspended", reason: "tenant_suspended"}
	}
	return &principal{token: t, tenant: ten}, nil
}

// ---------------------------------------------------------------------------------------------------- rate limit

type bucket struct {
	tokens float64
	last   time.Time
}

func (b *bucket) take(n, rate, burst float64, now time.Time) (bool, int) {
	if b.last.IsZero() {
		b.tokens = burst
	} else {
		b.tokens = math.Min(burst, b.tokens+now.Sub(b.last).Seconds()*rate)
	}
	b.last = now
	if b.tokens >= n {
		b.tokens -= n
		return true, 0
	}
	if rate <= 0 {
		return false, 60
	}
	wait := int(math.Ceil((n - b.tokens) / rate))
	return false, min(max(wait, 1), 60)
}

type tenantBuckets struct{ req, bytes bucket }

// allowRequest applies otlp_requests_per_s / otlp_burst per tenant on this node. It runs before the body is read,
// so a rate-limited tenant costs no body memory.
func (d *Door) allowRequest(tenant string, s snapshot.Settings, now time.Time) (bool, int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	tb := d.tenant(tenant)
	rate := float64(max(s.OTLPRequestsPerS, 1))
	burst := float64(max(s.OTLPBurst, s.OTLPRequestsPerS, 1))
	return tb.req.take(1, rate, burst, now)
}

func (d *Door) tenant(id string) *tenantBuckets {
	tb := d.buckets[id]
	if tb == nil {
		tb = &tenantBuckets{}
		d.buckets[id] = tb
	}
	return tb
}

// allowBytes applies otlp_bytes_per_s (compressed bytes) per tenant on this node; a refusal gives the request token
// back.
func (d *Door) allowBytes(tenant string, size int, s snapshot.Settings, now time.Time) (bool, int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	tb := d.tenant(tenant)
	brate := float64(max(s.OTLPBytesPerS, 1))
	bburst := math.Max(brate, MaxCompressed) // one maximal request always fits an idle bucket
	if ok, wait := tb.bytes.take(float64(size), brate, bburst, now); !ok {
		tb.req.tokens++ // give the request token back
		return false, wait
	}
	return true, 0
}

// ---------------------------------------------------------------------------------------------------- metadata

// Metadata are the six x-scf-* values of §f.4 (and C-116's level).
func (d *Door) metadata(p *principal, now time.Time) map[string]string {
	allowed := "*"
	if p.token.AllowedServiceNames != nil {
		parts := make([]string, 0, len(p.token.AllowedServiceNames))
		for _, n := range p.token.AllowedServiceNames {
			parts = append(parts, url.PathEscape(n))
		}
		allowed = strings.Join(parts, ",") // empty list → empty value → the Collector allows no service (fail closed)
	}
	level := min(max(p.tenant.Level, 0), 3) // C-116: L0…L3; L4 (operator approval) has no stricter caps than L3
	return map[string]string{
		"x-scf-tenant-id":        p.token.TenantID,
		"x-scf-token-id":         p.token.TokenID,
		"x-scf-allowed-services": allowed,
		"x-scf-tenant-level":     "L" + strconv.Itoa(level),
		"x-scf-received-at":      strconv.FormatInt(now.UnixNano(), 10),
		"x-scf-node":             d.Node,
	}
}

// ---------------------------------------------------------------------------------------------------- bodies

var errTooLarge = errors.New("too large")

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errTooLarge
	}
	return b, nil
}

// gunzip decompresses with the 16 MiB bound enforced while streaming (gzip-bomb safe).
func gunzip(b []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return readLimited(zr, MaxDecompressed)
}

// ---------------------------------------------------------------------------------------------------- HTTP

// count records one request: status is the HTTP status or gRPC code; outcome ∈ accepted, rejected, unavailable;
// reason ∈ none, auth, tenant, logs, schema, size, rate_limit, unavailable (closed sets; C-124). `time_bounds` is
// decided by the metrics writer (h.3 too_old/future), not here.
func (d *Door) count(signal, proto string, status int, outcome, reason string) {
	d.Metrics.Add("scf_gateway_otlp_requests_total", 1, "signal", signal, "protocol", proto, "status", strconv.Itoa(status),
		"outcome", outcome, "reason", reason)
}

// classify maps a rejection to the metric's outcome and reason.
func classify(rej *rejection) (outcome, reason string) {
	switch {
	case rej.grpcCode == grpcUnavailable:
		return "unavailable", "unavailable"
	case rej.grpcCode == grpcUnauthenticated:
		return "rejected", "auth"
	case rej.grpcCode == grpcPermissionDenied:
		return "rejected", "tenant"
	case rej.reason == "logs_rejected":
		return "rejected", "logs"
	case rej.reason == "payload_too_large":
		return "rejected", "size"
	case rej.reason == "rate_limited":
		return "rejected", "rate_limit"
	}
	return "rejected", "schema"
}

// passthrough classifies an answer relayed from the Collector (HTTP status or gRPC code).
func passthrough(ok bool, tooLarge bool) (outcome, reason string) {
	switch {
	case ok:
		return "accepted", "none"
	case tooLarge:
		return "rejected", "size"
	}
	return "rejected", "schema"
}

func (d *Door) httpError(w http.ResponseWriter, r *http.Request, signal string, rej *rejection, tenant string) {
	if rej.reason != "" && tenant != "" {
		d.Counters.AddOTLP(tenant, d.Now(), rej.reason, 1)
	}
	code := grpcCodeFor(rej)
	if rej.retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(rej.retryAfter))
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rej.httpStatus)
		_, _ = w.Write(statusJSON(code, rej.msg))
	} else {
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(rej.httpStatus)
		_, _ = w.Write(statusProto(code, rej.msg, 0))
	}
	o, rs := classify(rej)
	d.count(signal, "http", rej.httpStatus, o, rs)
}

func grpcCodeFor(rej *rejection) int {
	if rej.grpcCode != 0 {
		return rej.grpcCode
	}
	return grpcInvalidArgument
}

func (d *Door) serveHTTP(w http.ResponseWriter, r *http.Request, signal string) {
	now := d.Now()
	view := d.Snap.Current()
	if view == nil {
		d.httpError(w, r, signal, &rejection{httpStatus: 503, grpcCode: grpcUnavailable, msg: "unavailable", retryAfter: 10}, "")
		return
	}
	if view.Expired(now) { // hard expiry (§e.4): refuse new OTLP ingest until a newer snapshot arrives
		d.httpError(w, r, signal, &rejection{httpStatus: 503, grpcCode: grpcUnavailable, msg: "snapshot_expired", retryAfter: 30}, "")
		return
	}
	p, rej := d.authenticate(r, view, now)
	if signal == "logs" {
		tenant := ""
		if p != nil {
			tenant = p.token.TenantID
		}
		d.httpError(w, r, signal, &rejection{httpStatus: 404, grpcCode: grpcUnimplemented, msg: "logs are not accepted", reason: "logs_rejected"}, tenant)
		return
	}
	if rej != nil {
		tenant := ""
		if rej.reason != "" { // 403: the token was valid, the tenant is known
			if t := view.Token(presentedTokenID(r)); t != nil {
				tenant = t.TenantID
			}
		}
		d.httpError(w, r, signal, rej, tenant)
		return
	}
	tenant := p.token.TenantID
	release, busy := d.acquire(tenant)
	if busy != nil {
		d.httpError(w, r, signal, busy, tenant)
		return
	}
	defer release()
	if ok, wait := d.allowRequest(tenant, view.Settings, now); !ok {
		d.httpError(w, r, signal, &rejection{httpStatus: 429, grpcCode: grpcResourceExhausted, msg: "rate limited", reason: "rate_limited", retryAfter: wait}, tenant)
		return
	}
	ct := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if ct != "application/x-protobuf" && ct != "application/json" {
		d.httpError(w, r, signal, &rejection{httpStatus: 400, grpcCode: grpcInvalidArgument, msg: "content type must be application/x-protobuf or application/json"}, "")
		return
	}
	enc := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding")))
	if enc != "" && enc != "gzip" && enc != "identity" {
		d.httpError(w, r, signal, &rejection{httpStatus: 400, grpcCode: grpcInvalidArgument, msg: "unsupported content encoding (gzip only)"}, "")
		return
	}
	tooLarge := &rejection{httpStatus: 413, grpcCode: grpcResourceExhausted, msg: "request too large (4 MiB compressed, 16 MiB decompressed)", reason: "payload_too_large"}
	if r.ContentLength > MaxCompressed {
		d.httpError(w, r, signal, tooLarge, tenant)
		return
	}
	body, err := readLimited(r.Body, MaxCompressed)
	if errors.Is(err, errTooLarge) {
		d.httpError(w, r, signal, tooLarge, tenant)
		return
	}
	if err != nil {
		d.httpError(w, r, signal, &rejection{httpStatus: 400, grpcCode: grpcInvalidArgument, msg: "unreadable body"}, "")
		return
	}
	plain := body
	if enc == "gzip" {
		plain, err = gunzip(body)
		if errors.Is(err, errTooLarge) {
			d.httpError(w, r, signal, tooLarge, tenant)
			return
		}
		if err != nil {
			d.httpError(w, r, signal, &rejection{httpStatus: 400, grpcCode: grpcInvalidArgument, msg: "malformed gzip body"}, "")
			return
		}
	} else if len(body) > MaxDecompressed {
		d.httpError(w, r, signal, tooLarge, tenant)
		return
	}
	if (ct == "application/json" && !json.Valid(plain)) || (ct == "application/x-protobuf" && !WellFormed(plain)) {
		d.httpError(w, r, signal, &rejection{httpStatus: 400, grpcCode: grpcInvalidArgument, msg: "malformed OTLP payload"}, "")
		return
	}
	if ok, wait := d.allowBytes(tenant, len(body), view.Settings, now); !ok {
		d.httpError(w, r, signal, &rejection{httpStatus: 429, grpcCode: grpcResourceExhausted, msg: "rate limited", reason: "rate_limited", retryAfter: wait}, tenant)
		return
	}
	d.Counters.TokenUsed(p.token.TokenID, tenant, now)

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, d.CollectorHTTP+"/v1/"+signal, bytes.NewReader(body))
	req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	req.Header.Set("User-Agent", "") // an empty value suppresses Go's default "Go-http-client/1.1" (§f.4)
	if enc != "" {
		req.Header.Set("Content-Encoding", enc)
	}
	for k, v := range d.metadata(p, now) {
		req.Header.Set(k, v)
	}
	resp, err := d.httpClient.Do(req)
	if err != nil {
		d.Metrics.Add("scf_gateway_otlp_collector_errors_total", 1, "protocol", "http")
		d.httpError(w, r, signal, &rejection{httpStatus: 503, grpcCode: grpcUnavailable, msg: "collector unavailable", retryAfter: 5}, "")
		return
	}
	defer resp.Body.Close()
	rb, _ := readLimited(resp.Body, 1<<20)
	switch {
	case resp.StatusCode == 200:
	case resp.StatusCode == 400 || resp.StatusCode == 413:
	default: // 429/503 from the memory limiter or a full queue, or anything unexpected
		d.httpError(w, r, signal, &rejection{httpStatus: 503, grpcCode: grpcUnavailable, msg: "collector unavailable", retryAfter: 5}, "")
		return
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(rb)
	o, rs := passthrough(resp.StatusCode == 200, resp.StatusCode == 413)
	d.count(signal, "http", resp.StatusCode, o, rs)
}

// presentedTokenID extracts the id part of a well-formed key (for attributing a 403 to its tenant).
func presentedTokenID(r *http.Request) string {
	raw, _ := bearer(r.Header.Get("Authorization"))
	id, _, _ := ParseIngestKey(raw)
	return id
}

// ---------------------------------------------------------------------------------------------------- gRPC

func (d *Door) grpcError(w http.ResponseWriter, signal string, rej *rejection, tenant string) {
	if rej.reason != "" && tenant != "" {
		d.Counters.AddOTLP(tenant, d.Now(), rej.reason, 1)
	}
	code := grpcCodeFor(rej)
	h := w.Header()
	h.Set("Content-Type", "application/grpc")
	h.Set("Grpc-Status", strconv.Itoa(code))
	h.Set("Grpc-Message", url.PathEscape(rej.msg))
	if rej.retryAfter > 0 {
		h.Set("Grpc-Status-Details-Bin", statusDetailsBin(code, rej.msg, rej.retryAfter))
	}
	w.WriteHeader(http.StatusOK) // trailers-only response
	o, rs := classify(rej)
	d.count(signal, "grpc", code, o, rs)
}

func (d *Door) serveGRPC(w http.ResponseWriter, r *http.Request) {
	now := d.Now()
	signal := "unknown"
	switch r.URL.Path {
	case pathMetrics:
		signal = "metrics"
	case pathTraces:
		signal = "traces"
	case "/opentelemetry.proto.collector.logs.v1.LogsService/Export":
		signal = "logs"
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc") {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	view := d.Snap.Current()
	if view == nil {
		d.grpcError(w, signal, &rejection{grpcCode: grpcUnavailable, msg: "unavailable", retryAfter: 10}, "")
		return
	}
	if view.Expired(now) {
		d.grpcError(w, signal, &rejection{grpcCode: grpcUnavailable, msg: "snapshot_expired", retryAfter: 30}, "")
		return
	}
	p, rej := d.authenticate(r, view, now)
	if signal == "logs" || signal == "unknown" {
		tenant := ""
		if p != nil && signal == "logs" {
			tenant = p.token.TenantID
		}
		d.grpcError(w, signal, &rejection{grpcCode: grpcUnimplemented, msg: "logs are not accepted", reason: "logs_rejected"}, tenant)
		return
	}
	if rej != nil {
		tenant := ""
		if rej.reason != "" {
			if t := view.Token(presentedTokenID(r)); t != nil {
				tenant = t.TenantID
			}
		}
		d.grpcError(w, signal, rej, tenant)
		return
	}
	tenant := p.token.TenantID
	release, busy := d.acquire(tenant)
	if busy != nil {
		d.grpcError(w, signal, busy, tenant)
		return
	}
	defer release()
	if ok, wait := d.allowRequest(tenant, view.Settings, now); !ok {
		d.grpcError(w, signal, &rejection{grpcCode: grpcResourceExhausted, msg: "rate limited", reason: "rate_limited", retryAfter: wait}, tenant)
		return
	}
	tooLarge := &rejection{grpcCode: grpcResourceExhausted, msg: "request too large (4 MiB compressed, 16 MiB decompressed)", reason: "payload_too_large"}
	body, err := readLimited(r.Body, MaxCompressed+5)
	if errors.Is(err, errTooLarge) {
		d.grpcError(w, signal, tooLarge, tenant)
		return
	}
	bad := &rejection{grpcCode: grpcInvalidArgument, msg: "malformed gRPC message"}
	if err != nil || len(body) < 5 {
		d.grpcError(w, signal, bad, "")
		return
	}
	// One unary message: flag (1 byte), length (4 bytes BE), message.
	flag, n := body[0], int(uint32(body[1])<<24|uint32(body[2])<<16|uint32(body[3])<<8|uint32(body[4]))
	if n != len(body)-5 || flag > 1 {
		d.grpcError(w, signal, bad, "")
		return
	}
	msg := body[5:]
	enc := strings.ToLower(r.Header.Get("Grpc-Encoding"))
	if flag == 1 {
		if enc != "gzip" {
			d.grpcError(w, signal, &rejection{grpcCode: grpcUnimplemented, msg: "unsupported grpc-encoding (gzip only)"}, "")
			return
		}
		msg, err = gunzip(msg)
		if errors.Is(err, errTooLarge) {
			d.grpcError(w, signal, tooLarge, tenant)
			return
		}
		if err != nil {
			d.grpcError(w, signal, bad, "")
			return
		}
	} else if len(msg) > MaxDecompressed {
		d.grpcError(w, signal, tooLarge, tenant)
		return
	}
	if !WellFormed(msg) {
		d.grpcError(w, signal, bad, "")
		return
	}
	if ok, wait := d.allowBytes(tenant, len(body), view.Settings, now); !ok {
		d.grpcError(w, signal, &rejection{grpcCode: grpcResourceExhausted, msg: "rate limited", reason: "rate_limited", retryAfter: wait}, tenant)
		return
	}
	d.Counters.TokenUsed(p.token.TokenID, tenant, now)

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, d.CollectorGRPC+r.URL.Path, bytes.NewReader(body))
	req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	req.Header.Set("Te", "trailers")
	req.Header.Set("User-Agent", "") // an empty value suppresses Go's default "Go-http-client/2.0" (§f.4)
	for _, h := range []string{"Grpc-Encoding", "Grpc-Accept-Encoding", "Grpc-Timeout"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	for k, v := range d.metadata(p, now) {
		req.Header.Set(k, v)
	}
	resp, err := d.h2cClient.Do(req)
	if err != nil {
		d.Metrics.Add("scf_gateway_otlp_collector_errors_total", 1, "protocol", "grpc")
		d.grpcError(w, signal, &rejection{grpcCode: grpcUnavailable, msg: "collector unavailable", retryAfter: 5}, "")
		return
	}
	defer resp.Body.Close()
	rb, err := readLimited(resp.Body, 1<<20)
	if err != nil || resp.StatusCode != 200 {
		d.grpcError(w, signal, &rejection{grpcCode: grpcUnavailable, msg: "collector unavailable", retryAfter: 5}, "")
		return
	}
	status := resp.Trailer.Get("Grpc-Status")
	gmsg := resp.Trailer.Get("Grpc-Message")
	if status == "" { // trailers-only answer
		status, gmsg = resp.Header.Get("Grpc-Status"), resp.Header.Get("Grpc-Message")
	}
	code, _ := strconv.Atoi(status)
	if status == "" || code == grpcUnavailable || code == grpcResourceExhausted || code == 4 /* DEADLINE_EXCEEDED */ {
		d.grpcError(w, signal, &rejection{grpcCode: grpcUnavailable, msg: "collector unavailable", retryAfter: 5}, "")
		return
	}
	if code != grpcOK && code != grpcInvalidArgument {
		d.grpcError(w, signal, &rejection{grpcCode: grpcUnavailable, msg: "collector unavailable", retryAfter: 5}, "")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/grpc")
	if v := resp.Header.Get("Grpc-Encoding"); v != "" {
		h.Set("Grpc-Encoding", v)
	}
	h.Set("Trailer", "Grpc-Status, Grpc-Message")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(rb)
	h.Set("Grpc-Status", strconv.Itoa(code))
	if gmsg != "" {
		h.Set("Grpc-Message", gmsg)
	}
	o, rs := passthrough(code == grpcOK, false)
	d.count(signal, "grpc", code, o, rs)
}
