// SPDX-License-Identifier: Apache-2.0

// Command probe sends canary events like the pinned tracker (C-78, wire-formats §o) and exports
// scf_probe_canary_accepted_total{source,path}.
//
//	probe -hosts https://ingest-a.example,https://ingest-b.example -site <key> -origin https://canary.example \
//	      -source mon-c -path /canary/mon-c/round [-interval 30s] [-metrics :9465] [-ca ca.pem] [-insecure]
//
// With -interval 0 it sends one round and exits 0 on a 202, 1 otherwise.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/pkg/probe"
)

func main() {
	hosts := flag.String("hosts", "", "comma-separated ingest origins, tried in order")
	site := flag.String("site", "", "canary site key")
	origin := flag.String("origin", "", "page origin, a declared domain of the canary site")
	source := flag.String("source", "", "probe source name (mon-c, probe-d, edge-a1, …)")
	path := flag.String("path", "", "canary path (default /canary/<source>/round)")
	tv := flag.String("tv", "1.0.0", "tracker version")
	interval := flag.Duration("interval", 0, "repeat every interval (0 = once)")
	deadline := flag.Duration("deadline", 2*time.Second, "a round is good when a 202 arrives within this time")
	metricsAddr := flag.String("metrics", "", "listen address for /metrics (repeat mode)")
	caFile := flag.String("ca", "", "extra CA certificate for the ingest hosts (tests)")
	insecure := flag.Bool("insecure", false, "skip TLS verification (local tests only)")
	flag.Parse()
	if *hosts == "" || *site == "" || *origin == "" || *source == "" {
		flag.Usage()
		os.Exit(2)
	}
	if *path == "" {
		*path = "/canary/" + *source + "/round"
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: *insecure} //nolint:gosec // flag for local tests
	if *caFile != "" {
		pem, err := os.ReadFile(*caFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		pool, _ := x509.SystemCertPool()
		if pool == nil {
			pool = x509.NewCertPool()
		}
		pool.AppendCertsFromPEM(pem)
		tlsCfg.RootCAs = pool
	}
	cfg := probe.Config{SiteKey: *site, Origin: *origin, Path: *path, TrackerVersion: *tv,
		Client: &http.Client{Timeout: *deadline, Transport: &http.Transport{TLSClientConfig: tlsCfg}}}
	list := strings.Split(*hosts, ",")
	var accepted, rounds atomic.Int64
	once := func() bool {
		r, host, ok := probe.Round(context.Background(), cfg, list, *deadline)
		rounds.Add(1)
		if ok {
			accepted.Add(1)
		}
		log.Info("canary round", "source", *source, "path", *path, "ok", ok, "host", host, "status", r.Status, "elapsed_ms", r.Elapsed.Milliseconds(), "solve_ms", r.Solve.Milliseconds())
		return ok
	}
	if *interval == 0 {
		if once() {
			os.Exit(0)
		}
		os.Exit(1)
	}
	if *metricsAddr != "" {
		mux := http.NewServeMux()
		mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; version=0.0.4")
			fmt.Fprintf(w, "# HELP scf_probe_canary_accepted_total Canary events answered 202.\n# TYPE scf_probe_canary_accepted_total counter\n")
			fmt.Fprintf(w, "scf_probe_canary_accepted_total{source=%q,path=%q} %d\n", *source, *path, accepted.Load())
			fmt.Fprintf(w, "# HELP scf_probe_rounds_total Canary rounds attempted.\n# TYPE scf_probe_rounds_total counter\n")
			fmt.Fprintf(w, "scf_probe_rounds_total{source=%q,path=%q} %d\n", *source, *path, rounds.Load())
		})
		go func() {
			_ = (&http.Server{Addr: *metricsAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
		}()
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	t := time.NewTicker(*interval)
	defer t.Stop()
	once()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			once()
		}
	}
}
