// SPDX-License-Identifier: Apache-2.0

// Package server is the writer's OTLP/HTTP receiver (wire-formats §g.1, §g.3): POST /v1/metrics with an
// ExportMetricsServiceRequest (protobuf, optionally gzip) over mutual TLS, answered 200 (applied, duplicate, tenant
// removed, or rolled back for a non-transient reason), 400 (undecodable) or 503 + Retry-After (the database cannot
// take writes, or is busy, for the requests in flight). It never answers 429. A writer whose database is lost or cannot
// write closes its listener and reopens it when the probe succeeds again, so the Collector's dialer fails over to the
// other writer (C-107); a merely busy database (pool wait, a transaction deadline) keeps the listener open.
package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/obs"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

// DefaultWorkTimeout is the default request budget; see Config.WorkTimeout.
const DefaultWorkTimeout = 12 * time.Second

// Applier applies one tenant part (store.Store in production).
type Applier interface {
	Apply(ctx context.Context, key [32]byte, part *batch.TenantPart) (store.Result, error)
	Ping(ctx context.Context) error
}

// Config of the OTLP receiver.
type Config struct {
	Addr          string        // listen address, e.g. ":4319"
	MaxBodyBytes  int64         // limit of the compressed and of the decompressed body (default 64 MiB)
	ProbeInterval time.Duration // database probe interval (default 2 s)
	RetryAfter    time.Duration // Retry-After on 503 (default 5 s)
	// WorkTimeout is the budget for all tenant transactions of one request (default 12 s). It must stay below the
	// Collector exporter's timeout (collector/config/collector.yaml, 15 s), so the writer has always finished — and
	// answered — before the Collector gives up and retries.
	WorkTimeout time.Duration
}

// Server owns the OTLP listener and opens or closes it with the database's reachability.
type Server struct {
	cfg  Config
	tls  *TLSReloader
	app  Applier
	reg  *obs.Registry
	log  *slog.Logger
	now  func() time.Time
	lost chan struct{}

	mu      sync.Mutex
	srv     *http.Server
	open    bool
	stopped bool
	opened  chan struct{} // closed and replaced on every open (tests wait on it)
}

// New returns a Server; call Run.
func New(cfg Config, t *TLSReloader, app Applier, reg *obs.Registry, logger *slog.Logger) *Server {
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 64 << 20
	}
	if cfg.ProbeInterval <= 0 {
		cfg.ProbeInterval = 2 * time.Second
	}
	if cfg.RetryAfter <= 0 {
		cfg.RetryAfter = 5 * time.Second
	}
	if cfg.WorkTimeout <= 0 {
		cfg.WorkTimeout = DefaultWorkTimeout
	}
	return &Server{cfg: cfg, tls: t, app: app, reg: reg, log: logger, now: time.Now, lost: make(chan struct{}, 1),
		opened: make(chan struct{})}
}

// Open reports whether the listener is accepting connections.
func (s *Server) Open() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.open
}

// Run probes the database and keeps the listener open exactly while it answers; it returns when ctx ends, after
// closing the listener gracefully.
func (s *Server) Run(ctx context.Context) error {
	t := time.NewTicker(s.cfg.ProbeInterval)
	defer t.Stop()
	for {
		err := s.app.Ping(ctx)
		up := err == nil
		s.reg.Set(obs.DBUp, b2f(up))
		switch {
		case up && !s.Open():
			if err := s.openListener(); err != nil {
				s.log.Error("cannot open the OTLP listener", "error", err.Error())
			}
		case !up && s.Open():
			s.log.Warn("database unreachable: closing the OTLP listener")
			s.closeListener()
		}
		select {
		case <-ctx.Done():
			s.mu.Lock()
			s.stopped = true
			s.mu.Unlock()
			s.closeListener()
			return nil
		case <-t.C:
		case <-s.lost:
			if s.Open() {
				s.log.Warn("database connection lost in a request: closing the OTLP listener")
				s.closeListener()
			}
		}
	}
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// handshakeLog receives net/http's error log. Its lines can contain the peer address ("TLS handshake error from
// a.b.c.d:p"), so they are counted and replaced by a fixed message — never written as they are.
type handshakeLog struct {
	reg *obs.Registry
	log *slog.Logger
}

func (h handshakeLog) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("TLS handshake error")) {
		h.reg.Add(obs.TLSErrors, 1)
		h.log.Debug("TLS handshake failed")
	} else {
		h.log.Warn("http server error")
	}
	return len(p), nil
}

func (s *Server) openListener() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.open || s.stopped {
		return nil
	}
	ln, err := net.Listen("tcp", s.cfg.Addr)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler:           s,
		TLSConfig:         s.tls.ServerConfig(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      2 * s.cfg.WorkTimeout,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(handshakeLog{s.reg, s.log}, "", 0),
	}
	go func() {
		if err := srv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.log.Error("OTLP listener stopped", "error", err.Error())
		}
	}()
	s.srv, s.open = srv, true
	close(s.opened)
	s.opened = make(chan struct{})
	s.reg.Set(obs.ListenerOpen, 1)
	s.reg.Add(obs.ListenerCycles, 1, "transition", "opened")
	s.log.Info("OTLP listener open", "addr", s.cfg.Addr)
	return nil
}

// closeListener stops accepting at once and closes idle connections; requests in flight finish (with 503 when the
// database is gone) and their connections close afterwards.
func (s *Server) closeListener() {
	s.mu.Lock()
	srv := s.srv
	if !s.open || srv == nil {
		s.mu.Unlock()
		return
	}
	s.srv, s.open = nil, false
	s.mu.Unlock()
	s.reg.Set(obs.ListenerOpen, 0)
	s.reg.Add(obs.ListenerCycles, 1, "transition", "closed")
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.WorkTimeout+5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		_ = srv.Close()
	}
}

// WaitOpen returns a channel closed at the next open (tests).
func (s *Server) WaitOpen() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.opened
}

// ServeHTTP handles POST /v1/metrics.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	code := s.serve(w, r)
	s.reg.Add(obs.Requests, 1, "code", fmt.Sprint(code))
	s.reg.Observe(obs.RequestSeconds, time.Since(start))
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) int {
	if r.URL.Path != "/v1/metrics" {
		http.NotFound(w, r)
		return http.StatusNotFound
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return http.StatusMethodNotAllowed
	}
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/x-protobuf") {
		return s.status(w, http.StatusUnsupportedMediaType, 3, "only application/x-protobuf is accepted")
	}
	body, err := s.readBody(w, r)
	if err != nil {
		return s.status(w, http.StatusBadRequest, 3, "unreadable or oversized body")
	}
	b, err := batch.Decode(body, s.now())
	if err != nil {
		return s.status(w, http.StatusBadRequest, 3, "undecodable ExportMetricsServiceRequest")
	}
	s.reg.Add(obs.PointsTotal, float64(b.Points), "outcome", "received")
	if b.NoTenant > 0 {
		s.reg.Add(obs.PointsTotal, float64(b.NoTenant), "outcome", "no_tenant")
	}
	// The work outlives a client that disconnects (the ledger makes the retry a no-op), but its budget is shorter
	// than the Collector's timeout, so the Collector never retries a request that is still being applied.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), s.cfg.WorkTimeout)
	defer cancel()
	for _, part := range b.Parts {
		if _, err := s.app.Apply(ctx, b.Key, part); err != nil {
			switch {
			case errors.Is(err, store.ErrUnavailable):
				select {
				case s.lost <- struct{}{}:
				default:
				}
				w.Header().Set("Retry-After", fmt.Sprint(int(s.cfg.RetryAfter.Seconds())))
				w.Header().Set("Connection", "close")
				return s.status(w, http.StatusServiceUnavailable, 14, "database unavailable")
			case errors.Is(err, store.ErrBusy):
				// Transient: the Collector retries from its queue; the parts already committed are duplicates then.
				w.Header().Set("Retry-After", fmt.Sprint(int(s.cfg.RetryAfter.Seconds())))
				return s.status(w, http.StatusServiceUnavailable, 14, "database busy")
			}
			// Apply returns only ErrUnavailable or ErrBusy; anything else is a bug: answer 200 so it is not retried for
			// ever.
			s.log.Error("unexpected apply error", "error_type", fmt.Sprintf("%T", err))
		}
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(http.StatusOK) // empty ExportMetricsServiceResponse
	return http.StatusOK
}

func (s *Server) readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	in := io.Reader(http.MaxBytesReader(w, r.Body, s.cfg.MaxBodyBytes))
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))) {
	case "", "identity":
	case "gzip":
		gz, err := gzip.NewReader(in)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		in = gz
	default:
		return nil, errors.New("unsupported content encoding")
	}
	body, err := io.ReadAll(io.LimitReader(in, s.cfg.MaxBodyBytes+1)) // decompressed size bounded while streaming
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > s.cfg.MaxBodyBytes {
		return nil, errors.New("decompressed body too large")
	}
	return body, nil
}

// status writes a google.rpc.Status (code, message) as protobuf — the OTLP/HTTP error body.
func (s *Server) status(w http.ResponseWriter, httpCode int, rpcCode byte, msg string) int {
	b := []byte{0x08, rpcCode, 0x12, byte(len(msg))}
	b = append(b, msg...)
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(httpCode)
	_, _ = w.Write(b)
	return httpCode
}

// AdminHandler serves /metrics, /healthz (process up) and /readyz (listener open) on the plain admin port.
func (s *Server) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = s.reg.WriteTo(w)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok\n") })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !s.Open() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, "listener closed\n")
			return
		}
		_, _ = io.WriteString(w, "ok\n")
	})
	return mux
}
