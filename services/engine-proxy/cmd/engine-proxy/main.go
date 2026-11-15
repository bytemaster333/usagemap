// SPDX-License-Identifier: Apache-2.0

// Command engine-proxy is the internal front of Umami on each core node (wire-formats §c.5; C-60, C-74, C-99, C-112):
// per-node mutual TLS, per-caller path allow-lists, the single deny-list, the bootstrap gate and the visit-token
// memory that implements the 30-minute visit rule.
//
//	engine-proxy              run (configuration from EP_* environment variables, see internal/config)
//	engine-proxy healthcheck  exit 0 when the local /healthz answers 200 (container health check; no shell needed)
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/config"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/dedup"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/proxy"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/visit"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("engine_proxy_exit", "error", err.Error())
		os.Exit(1)
	}
}

func healthcheck() int {
	addr := os.Getenv("EP_METRICS_ADDR")
	if addr == "" {
		addr = ":9464"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	c := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := c.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	logger := proxy.NewLogger(cfg.LogLevel)
	tlsr, err := proxy.NewTLSReloader(proxy.TLSFiles{CertFile: cfg.TLSCert, KeyFile: cfg.TLSKey, ClientCAFile: cfg.ClientCA, CRLFile: cfg.ClientCRL})
	if err != nil {
		return fmt.Errorf("tls: %w", err)
	}
	upstream := &http.Client{
		Timeout: cfg.UpstreamTimeout,
		Transport: &http.Transport{
			Proxy:                 nil, // never an environment HTTP proxy: upstreams are on the node's internal networks
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxIdleConns:          256,
			MaxIdleConnsPerHost:   128,
			IdleConnTimeout:       90 * time.Second,
			ResponseHeaderTimeout: cfg.UpstreamTimeout,
		},
	}
	cpClient := upstream
	if cfg.ControlPlaneURL != nil && cfg.ControlPlaneURL.Scheme == "https" {
		tc, err := proxy.ClientConfig(cfg.CPClientCert, cfg.CPClientKey, cfg.CPCA, cfg.ControlPlaneURL.Hostname())
		if err != nil {
			return fmt.Errorf("control plane tls: %w", err)
		}
		cpClient = &http.Client{Timeout: cfg.UpstreamTimeout, Transport: &http.Transport{
			Proxy: nil, TLSClientConfig: tc, MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second,
			DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext, ResponseHeaderTimeout: cfg.UpstreamTimeout,
		}}
	}
	store := visit.New(visit.Config{MaxEntries: cfg.MaxEntries})
	gate := &proxy.Gate{}
	if cfg.ProvisionerPasswordFile != "" {
		b, err := os.ReadFile(cfg.ProvisionerPasswordFile)
		if err != nil {
			return errors.New("EP_PROVISIONER_PASSWORD_FILE: cannot read the file")
		}
		pw := strings.TrimRight(string(b), "\r\n")
		if pw == "" {
			return errors.New("EP_PROVISIONER_PASSWORD_FILE is empty")
		}
		gate.Provisioner = &proxy.Credentials{Username: cfg.ProvisionerUser, Password: pw}
	}
	dd := dedup.New(dedup.Config{Window: cfg.DedupWindow, MaxEntries: cfg.DedupMaxEntries})
	metrics := proxy.NewMetrics().WithDedup(dd)
	srv := proxy.New(proxy.Config{
		UmamiURL: cfg.UmamiURL, ControlPlaneURL: cfg.ControlPlaneURL, ControlPlane: cpClient, Store: store, Gate: gate, Dedup: dd,
		Metrics: metrics, Logger: logger, Client: upstream,
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	api := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv,
		TLSConfig:         tlsr.ServerConfig(),
		ConnState:         tlsr.ConnState, // a reload closes connections opened before it (C-114)
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      cfg.UpstreamTimeout + 15*time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          proxy.ServerErrorLog(logger),
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", metrics.Handler(store, gate))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok\n") })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !gate.IsOpen() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, "bootstrap pending\n")
			return
		}
		_, _ = io.WriteString(w, "ready\n")
	})
	side := &http.Server{
		Addr: cfg.MetricsAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second,
		ErrorLog: proxy.ServerErrorLog(logger),
	}

	go gate.Run(ctx, upstream, cfg.UmamiURL, cfg.GateProbeClosed, cfg.GateProbeOpen)
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				store.Sweep()
			}
		}
	}()
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			if err := tlsr.Reload(); err != nil {
				logger.Error("tls_reload_failed", "error_kind", "load")
				continue
			}
			logger.Info("tls_reloaded")
		}
	}()

	errc := make(chan error, 2)
	go func() { errc <- side.ListenAndServe() }()
	go func() { errc <- api.ListenAndServeTLS("", "") }()
	logger.Info("engine_proxy_started", "listen", cfg.ListenAddr, "metrics", cfg.MetricsAddr,
		"max_entries", cfg.MaxEntries, "control_plane", cfg.ControlPlaneURL != nil, "crl", cfg.ClientCRL != "",
		"gate_probe_provisioner", gate.Provisioner != nil)

	select {
	case <-ctx.Done():
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	logger.Info("engine_proxy_stopping")
	sctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer cancel()
	_ = api.Shutdown(sctx)
	_ = side.Shutdown(sctx)
	return nil
}
