// SPDX-License-Identifier: Apache-2.0

// Command health-controller probes edge (and core) nodes every round and maintains the ingest and portal A/AAAA
// record sets at every DNS provider (C-27, C-92). Two instances (mon-c, core-b) exchange results; the etcd-lease
// leader writes.
//
//	health-controller -config /etc/scf-hc/config.json [-etcd https://etcd-1:2379,…] [-leader]
//	                  [-listen :9470] [-metrics :9471] [-tls-cert … -tls-key … -tls-ca …] [-ingest-ca …]
//	health-controller healthcheck [-metrics-url http://127.0.0.1:9471/healthz]
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/bytemaster333/usagemap/services/health-controller/internal/config"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/controller"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/dns"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/election"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/metrics"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/peer"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/prober"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(os.Args[2:]))
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "health-controller:", err)
		os.Exit(1)
	}
}

func healthcheck(args []string) int {
	fs := flag.NewFlagSet("healthcheck", flag.ExitOnError)
	u := fs.String("metrics-url", "http://127.0.0.1:9471/healthz", "health URL")
	_ = fs.Parse(args)
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(*u)
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func loadPool(path string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("no certificates in " + path)
	}
	return pool, nil
}

func run() error {
	cfgPath := flag.String("config", "/etc/scf-hc/config.json", "inventory (JSON)")
	listen := flag.String("listen", ":9470", "peer API listener")
	metricsAddr := flag.String("metrics", ":9471", "/metrics and /healthz listener (internal)")
	etcd := flag.String("etcd", "", "comma-separated etcd endpoints (leader election); empty = static role")
	etcdKey := flag.String("etcd-key", "/scf/health-controller/leader", "election key")
	etcdTTL := flag.Duration("etcd-ttl", 15*time.Second, "lease TTL")
	leader := flag.Bool("leader", false, "static role without etcd: this instance writes DNS")
	tlsCert := flag.String("tls-cert", "", "node certificate (peer API server and client, mesh health checks, etcd)")
	tlsKey := flag.String("tls-key", "", "node key")
	tlsCA := flag.String("tls-ca", "", "private CA: peers must present a certificate from it (mutual TLS)")
	ingestCA := flag.String("ingest-ca", "", "extra CA for the nodes' public ingest origins (tests)")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}

	meshTLS := &tls.Config{MinVersion: tls.VersionTLS13}
	var serverTLS *tls.Config
	if *tlsCert != "" {
		cert, err := tls.LoadX509KeyPair(*tlsCert, *tlsKey)
		if err != nil {
			return err
		}
		pool, err := loadPool(*tlsCA)
		if err != nil {
			return fmt.Errorf("-tls-ca is required with -tls-cert: %w", err)
		}
		meshTLS.Certificates, meshTLS.RootCAs = []tls.Certificate{cert}, pool
		serverTLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, ClientCAs: pool,
			ClientAuth: tls.RequireAndVerifyClientCert}
	}
	ingestTLS := &tls.Config{MinVersion: tls.VersionTLS12}
	if *ingestCA != "" {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		pem, err := os.ReadFile(*ingestCA)
		if err != nil {
			return err
		}
		pool.AppendCertsFromPEM(pem)
		ingestTLS.RootCAs = pool
	}
	timeout := cfg.ProbeTimeout.Duration
	meshClient := &http.Client{Timeout: timeout, Transport: &http.Transport{TLSClientConfig: meshTLS, DisableKeepAlives: true}}
	ingestClient := &http.Client{Timeout: timeout, Transport: &http.Transport{TLSClientConfig: ingestTLS, DisableKeepAlives: true}}

	var providers []dns.Provider
	for _, p := range cfg.Providers {
		token := ""
		if p.TokenFile != "" {
			b, err := os.ReadFile(p.TokenFile)
			if err != nil {
				return fmt.Errorf("provider %s: token file: %w", p.Name, err)
			}
			token = strings.TrimSpace(string(b))
		}
		switch p.Kind {
		case "http":
			providers = append(providers, dns.NewHTTP(p.Name, p.Endpoint, token,
				&http.Client{Timeout: cfg.ProviderTimeout.Duration}))
		case "azure":
			providers = append(providers, dns.NewAzure(dns.AzureConfig{Name: p.Name, SubscriptionID: p.SubscriptionID,
				ResourceGroup: p.ResourceGroup, Endpoint: p.Endpoint, IMDSEndpoint: p.IMDSEndpoint,
				Timeout: cfg.ProviderTimeout.Duration}))
		case "cloudflare":
			providers = append(providers, dns.NewCloudflare(dns.CloudflareConfig{Name: p.Name, Endpoint: p.Endpoint,
				Token: token, Timeout: cfg.ProviderTimeout.Duration}))
		case "memory":
			providers = append(providers, dns.NewMemory(p.Name))
		}
	}

	reg := metrics.New()
	controller.Describe(reg)
	var el election.Elector = election.Static{Leader: *leader}
	if *etcd != "" {
		el = &election.Etcd{Endpoints: strings.Split(*etcd, ","), Client: meshClient, Key: *etcdKey,
			Instance: cfg.Instance, TTL: *etcdTTL, Log: log}
	}
	var peers []controller.PeerSource
	for _, p := range cfg.Peers {
		peers = append(peers, &peer.Client{Base: p, Client: meshClient})
	}
	c := &controller.Controller{
		Cfg: cfg, Providers: providers, Peers: peers, Elector: el, Metrics: reg, Log: log,
		Prober: &prober.HTTP{Client: meshClient, Ingest: ingestClient, Canary: cfg.Canary, Instance: cfg.Instance},
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	mux := http.NewServeMux()
	mux.Handle("/internal/v1/rounds/", peer.Handler(cfg.Instance, c.Results))
	peerSrv := &http.Server{Addr: *listen, Handler: mux, TLSConfig: serverTLS, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second}
	mmux := http.NewServeMux()
	mmux.Handle("GET /metrics", reg.Handler())
	mmux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	metricsSrv := &http.Server{Addr: *metricsAddr, Handler: mmux, ReadHeaderTimeout: 5 * time.Second}

	errs := make(chan error, 2)
	go func() {
		var err error
		if serverTLS != nil {
			err = peerSrv.ListenAndServeTLS("", "")
		} else {
			err = peerSrv.ListenAndServe()
		}
		if !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()
	go func() {
		if err := metricsSrv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()
	go el.Run(ctx)
	log.Info("health controller started", "instance", cfg.Instance, "nodes", len(cfg.Nodes),
		"hostnames", len(cfg.Hostnames), "providers", len(providers), "interval", cfg.Interval.String())
	go c.Run(ctx)

	select {
	case <-ctx.Done():
	case err := <-errs:
		return err
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = peerSrv.Shutdown(sctx)
	_ = metricsSrv.Shutdown(sctx)
	log.Info("health controller stopped", "instance", cfg.Instance)
	return nil
}
