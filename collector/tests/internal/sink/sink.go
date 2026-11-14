// SPDX-License-Identifier: Apache-2.0
// Package sink is a stand-in for the metrics writer in the Collector tests:
// an OTLP/HTTP metrics endpoint behind mutual TLS that records every request
// (path, header names, SHA-256 of the decompressed body — the writer's batch
// key, wire-formats §g.3 — and the decoded payload) and answers like the
// writer (200 with an empty ExportMetricsServiceResponse).
package sink

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"slices"
	"sync"
	"time"

	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
)

// Record is one request received by the sink.
type Record struct {
	Path        string    `json:"path"`
	HeaderNames []string  `json:"header_names"`
	BodySHA256  string    `json:"body_sha256"`
	Body        []byte    `json:"body"`      // decompressed request body
	OTLPJSON    string    `json:"otlp_json"` // the payload as OTLP JSON ("" when undecodable)
	Status      int       `json:"status"`    // the status the sink answered
	ReceivedAt  time.Time `json:"received_at"`
}

// Metrics decodes the record's payload.
func (r Record) Metrics() (pmetric.Metrics, error) {
	req := pmetricotlp.NewExportRequest()
	if err := req.UnmarshalProto(r.Body); err != nil {
		return pmetric.Metrics{}, err
	}
	return req.Metrics(), nil
}

// Sink records requests. The zero value is not usable; use New.
type Sink struct {
	mu      sync.Mutex
	records []Record
	fail    int           // answer 503 to the next fail requests
	hold    time.Duration // wait this long after recording before answering
	srv     *http.Server
}

// New returns a sink serving with tlsCfg (nil = plain HTTP).
func New(tlsCfg *tls.Config) *Sink {
	s := &Sink{}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	s.srv = &http.Server{Handler: mux, TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	return s
}

// Serve serves on l until Close.
func (s *Sink) Serve(l net.Listener) error {
	if s.srv.TLSConfig != nil {
		l = tls.NewListener(l, s.srv.TLSConfig)
	}
	err := s.srv.Serve(l)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

// Close stops the server at once (open connections are closed).
func (s *Sink) Close() error { return s.srv.Close() }

// FailNext makes the sink answer 503 to the next n requests.
func (s *Sink) FailNext(n int) { s.mu.Lock(); s.fail = n; s.mu.Unlock() }

// Hold delays every answer by d after the request was recorded.
func (s *Sink) Hold(d time.Duration) { s.mu.Lock(); s.hold = d; s.mu.Unlock() }

// Records returns a copy of everything received so far.
func (s *Sink) Records() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.records)
}

// Reset forgets the records.
func (s *Sink) Reset() { s.mu.Lock(); s.records = nil; s.mu.Unlock() }

func (s *Sink) handle(w http.ResponseWriter, r *http.Request) {
	rec := Record{Path: r.URL.Path, ReceivedAt: time.Now().UTC()}
	for k := range r.Header {
		rec.HeaderNames = append(rec.HeaderNames, http.CanonicalHeaderKey(k))
	}
	slices.Sort(rec.HeaderNames)
	body, err := readBody(r)
	if err != nil {
		rec.Status = http.StatusBadRequest
		s.add(rec)
		http.Error(w, "bad body", rec.Status)
		return
	}
	sum := sha256.Sum256(body)
	rec.BodySHA256 = hex.EncodeToString(sum[:])
	rec.Body = body
	req := pmetricotlp.NewExportRequest()
	if r.URL.Path == "/v1/metrics" && req.UnmarshalProto(body) == nil {
		if j, err := req.MarshalJSON(); err == nil {
			rec.OTLPJSON = string(j)
		}
	}

	s.mu.Lock()
	hold := s.hold
	switch {
	case r.URL.Path != "/v1/metrics" || r.Method != http.MethodPost:
		rec.Status = http.StatusNotFound
	case rec.OTLPJSON == "":
		rec.Status = http.StatusBadRequest
	case s.fail > 0:
		s.fail--
		rec.Status = http.StatusServiceUnavailable
	default:
		rec.Status = http.StatusOK
	}
	s.records = append(s.records, rec)
	s.mu.Unlock()

	if hold > 0 {
		time.Sleep(hold)
	}
	if rec.Status != http.StatusOK {
		if rec.Status == http.StatusServiceUnavailable {
			w.Header().Set("Retry-After", "1")
		}
		http.Error(w, http.StatusText(rec.Status), rec.Status)
		return
	}
	resp, _ := pmetricotlp.NewExportResponse().MarshalProto()
	w.Header().Set("Content-Type", "application/x-protobuf")
	_, _ = w.Write(resp)
}

func (s *Sink) add(r Record) { s.mu.Lock(); s.records = append(s.records, r); s.mu.Unlock() }

func readBody(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if r.Header.Get("Content-Encoding") != "gzip" {
		return raw, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(zr, 64<<20))
}

// AdminHandler serves the records as JSON (GET /records) and clears them
// (POST /reset); used by cmd/writersink in the Compose tests.
func (s *Sink) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /records", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.Records())
	})
	mux.HandleFunc("POST /reset", func(w http.ResponseWriter, _ *http.Request) { s.Reset() })
	return mux
}
