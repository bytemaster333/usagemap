// SPDX-License-Identifier: Apache-2.0

// Command gateway is the web ingest gateway of an edge node: tracker files, challenge, events, spool, forwarder,
// snapshot consumer, key exchange and metrics (wire-formats §a–§e, §h, §l, §n).
//
//	gateway              serve (configuration from GW_* variables, see services/gateway/README.md)
//	gateway healthcheck  exit 0 when the local node reports healthy (container health check)
//	gateway templates    print the synthetic User-Agent templates as JSON (contract test against Umami)
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	stdlog "log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/appevents"
	"github.com/bytemaster333/usagemap/services/gateway/internal/config"
	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/forwarder"
	"github.com/bytemaster333/usagemap/services/gateway/internal/geo"
	"github.com/bytemaster333/usagemap/services/gateway/internal/guard"
	"github.com/bytemaster333/usagemap/services/gateway/internal/ingest"
	"github.com/bytemaster333/usagemap/services/gateway/internal/keys"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/multiplicity"
	"github.com/bytemaster333/usagemap/services/gateway/internal/netclass"
	"github.com/bytemaster333/usagemap/services/gateway/internal/otlp"
	"github.com/bytemaster333/usagemap/services/gateway/internal/secmem"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
	"github.com/bytemaster333/usagemap/services/gateway/internal/trackerfiles"
	"github.com/bytemaster333/usagemap/services/gateway/internal/transport"
	"github.com/bytemaster333/usagemap/services/gateway/internal/uaclass"
	"github.com/bytemaster333/usagemap/services/gateway/internal/uuid"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthcheck":
			os.Exit(healthcheck())
		case "templates":
			_ = json.NewEncoder(os.Stdout).Encode(uaclass.Templates(131))
			return
		}
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "gateway:", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	addr := os.Getenv("GW_METRICS_ADDR")
	if addr == "" {
		addr = ":9464"
	}
	_, port, _ := net.SplitHostPort(addr)
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func logger(level string) *slog.Logger {
	var l slog.Level
	_ = l.UnmarshalText([]byte(level))
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := logger(cfg.LogLevel).With("node", cfg.Node)
	// Keys are memory-only: no core dumps, ever (C-04, C-66).
	if err := secmem.DisableCoreDumps(); err != nil {
		return fmt.Errorf("disabling core dumps: %w", err)
	}
	reg := metrics.New()
	declareMetrics(reg)
	started := time.Now()

	// Node identity for the cores and peers.
	nodeCert, err := tls.LoadX509KeyPair(cfg.NodeCert, cfg.NodeKey)
	if err != nil {
		return fmt.Errorf("node certificate: %w", err)
	}
	caPEM, err := os.ReadFile(cfg.CA)
	if err != nil {
		return err
	}
	ca := x509.NewCertPool()
	if !ca.AppendCertsFromPEM(caPEM) {
		return errors.New("GW_CA holds no certificate")
	}
	coreClient := &http.Client{Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{nodeCert}, RootCAs: ca},
		MaxIdleConnsPerHost: 32, IdleConnTimeout: 90 * time.Second, ForceAttemptHTTP2: true,
	}, Timeout: 15 * time.Second}
	var cores []snapshot.Core
	for _, c := range cfg.Cores {
		cores = append(cores, snapshot.Core{ID: c.Name, URL: c.URL})
	}

	// Snapshot.
	skeys, err := snapshot.ParseKeys(cfg.SnapshotKeys)
	if err != nil {
		return err
	}
	store := snapshot.NewStore(filepath.Join(cfg.StateDir, "snapshot.json"), skeys)
	if err := store.LoadFromDisk(); err != nil && !os.IsNotExist(err) {
		log.Error("persisted snapshot refused; waiting for a fresh one", "reason", err.Error())
	}

	// Keys.
	ring, err := keys.NewRing(nil)
	if err != nil {
		return err
	}
	if !ring.Locked() {
		if cfg.RequireMlock {
			return errors.New("cannot mlock key memory (raise RLIMIT_MEMLOCK or set GW_REQUIRE_MLOCK=0 for development)")
		}
		log.Warn("key memory is not locked against swapping (GW_REQUIRE_MLOCK=0)")
	}
	mult := multiplicity.New()
	ring.OnDestroy(func(k keys.Kind, id string) {
		if k == keys.Mult {
			mult.Reset(keys.DayID(time.Now())) // all cells are dropped at the daily K_mult rotation (§b.4)
		}
	})
	var peers []keys.Peer
	for _, p := range cfg.Peers {
		peers = append(peers, keys.Peer{Name: p.Name, URL: p.URL})
	}
	kx := &keys.Exchange{Node: cfg.Node, Ring: ring, Peers: peers, Client: keys.NewClient(nodeCert, ca), Log: log}

	// Geo, network classes, tracker files.
	var resolver geo.Resolver = geo.None{}
	if cfg.GeoDB != "" {
		db, err := geo.Open(cfg.GeoDB, cfg.GeoSHA256)
		if err != nil {
			return err
		}
		defer db.Close()
		resolver = db
		log.Info("geo database loaded", "sha256", db.SHA256, "build", db.Build)
	} else {
		log.Warn("no geo database configured: every country is XX")
	}
	ncls := netclass.New(cfg.RangeListsDir)
	tf, err := trackerfiles.Load(cfg.TrackerDir)
	if err != nil {
		return err
	}

	// Spool.
	sp, err := spool.Open(spool.Options{Dir: filepath.Join(cfg.StateDir, "spool", cfg.Node), Node: cfg.Node, MaxBytes: cfg.SpoolMaxBytes,
		SiteShare: cfg.SpoolSiteShare})
	if err != nil {
		return err
	}
	agg := counters.New()
	bootID := uuid.V4().String()

	var draining atomic.Bool
	srv := &ingest.Server{Snap: store, Ring: ring, LiveNodes: kx.LiveNodes, Geo: resolver, Net: ncls, Mult: mult, Spool: sp,
		Counters: agg, Metrics: reg, Log: log, Draining: draining.Load}
	srv.Init()
	health := func() (bool, string) {
		switch {
		case store.Current() == nil:
			return false, "no_snapshot"
		case !ring.HasCurrent():
			return false, "keys"
		case !sp.Durable():
			return false, "spool"
		case draining.Load():
			return false, "draining"
		}
		return true, ""
	}
	registerGauges(reg, store, ring, kx, sp, mult, ncls, started, cfg, srv.SitesLimited)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	bg, cancelBG := context.WithCancel(context.Background())
	defer cancelBG()

	// Background loops.
	kx.Maintain(bg)
	go kx.Run(bg, 10*time.Second)
	fetcher := &snapshot.Fetcher{Store: store, Cores: cores, Client: coreClient, Interval: cfg.SnapshotInterval, Jitter: 5 * time.Second, Log: log}
	go fetcher.Run(bg)
	fwd := &forwarder.Forwarder{Spool: sp, Snap: store, Cores: cores, Client: coreClient, Counters: agg, Metrics: reg, Log: log, Workers: cfg.Workers}
	fwdDone := make(chan struct{})
	go func() { fwd.Run(bg); close(fwdDone) }()
	flusher := &counters.Flusher{Agg: agg, Spool: sp, Node: cfg.Node, BootID: bootID, Log: log,
		// Optional counter-record parts only when the current snapshot advertises them (C-137, §d.3).
		Features: func() (bool, bool) {
			v := store.Current()
			if v == nil {
				return false, false
			}
			return v.Settings.HasFeature(snapshot.FeatureProps), v.Settings.HasFeature(snapshot.FeatureDev)
		},
		// Self-attested app events (§a.9): sent only when the snapshot advertises "app".
		AppFeature: func() bool {
			v := store.Current()
			return v != nil && v.Settings.HasFeature(snapshot.FeatureApp)
		},
		// Browser Stellar RPC/Horizon aggregate (§a.3.2): sent only when the snapshot advertises "rpc".
		RPCFeature: func() bool {
			v := store.Current()
			return v != nil && v.Settings.HasFeature(snapshot.FeatureRPC)
		}}
	flushDone := make(chan struct{})
	flushCtx, cancelFlush := context.WithCancel(context.Background())
	defer cancelFlush()
	go func() { flusher.Run(flushCtx, cfg.CounterPeriod); close(flushDone) }()
	stopWatch := make(chan struct{})
	go ncls.Watch(stopWatch, time.Minute)
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-bg.Done():
				return
			case <-t.C:
				sp.ExpireOld(fwd.CountExpired)
				mult.Sweep(time.Now())
			}
		}
	}()

	// Listeners.
	var tlsCert atomic.Pointer[tls.Certificate]
	loadCert := func() error {
		c, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			return err
		}
		tlsCert.Store(&c)
		return nil
	}
	var extra []func(*http.ServeMux)
	// Mobile / app intake (wire-formats §a.9): self-attested counts, never web verdicts.
	apps := &appevents.Door{Snap: store, Counters: agg, Metrics: reg, LiveNodes: kx.LiveNodes, Draining: draining.Load}
	apps.Init()
	extra = append(extra, apps.Register)
	if cfg.OTLPEnabled {
		raw, err := os.ReadFile(cfg.PepperIngFile)
		if err != nil {
			return fmt.Errorf("pepper_ing: %w", err)
		}
		peppers, err := otlp.ParsePeppers(string(raw))
		clear(raw)
		if err != nil {
			return fmt.Errorf("pepper_ing: %w", err)
		}
		door := &otlp.Door{Snap: store, Peppers: peppers, Node: cfg.Node, Counters: agg, Metrics: reg, Log: log,
			CollectorHTTP: cfg.CollectorHTTP, CollectorGRPC: cfg.CollectorGRPC, MaxInflight: cfg.OTLPMaxInflight, TenantInflight: cfg.OTLPTenantFlight}
		door.Init()
		extra = append(extra, door.Register)
	}
	pub := &http.Server{Addr: cfg.ListenAddr, Handler: srv.Handler(tf.Handler(func(v string) bool {
		cur := store.Current()
		return cur != nil && cur.Withdrawn(v)
	}), health, extra...), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 40 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10, ErrorLog: quietLog()}
	// TLS is terminated by transport.Listener, not by net/http, so the ClientHello and the HTTP/2 preface can be
	// fingerprinted per connection (C-124). net/http then sees decrypted connections: HTTP/1.1, or HTTP/2 with prior
	// knowledge after ALPN h2 (OTLP/gRPC included). On the plaintext test listener the same setting allows h2c.
	protos := new(http.Protocols)
	protos.SetHTTP1(true)
	protos.SetUnencryptedHTTP2(true)
	pub.Protocols = protos
	// At most 100 concurrent streams per HTTP/2 connection (Go's default is 250): with the OTLP in-flight bounds this
	// keeps one connection from queueing hundreds of request bodies.
	pub.HTTP2 = &http.HTTP2Config{MaxConcurrentStreams: 100}
	pub.ConnContext = transport.ConnContext
	var tlsConf *tls.Config
	if cfg.TLSCert != "" {
		if err := loadCert(); err != nil {
			return fmt.Errorf("listener certificate: %w", err)
		}
		tlsConf = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return tlsCert.Load(), nil }}
		hup := make(chan os.Signal, 1)
		signal.Notify(hup, syscall.SIGHUP)
		go func() {
			for range hup {
				if err := loadCert(); err != nil {
					log.Error("certificate reload failed; keeping the previous one", "error_kind", "load")
				} else {
					log.Info("listener certificate reloaded")
				}
			}
		}()
	}
	mmux := http.NewServeMux()
	mmux.Handle("GET /metrics", reg.Handler())
	mmux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		if ok, reason := health(); !ok {
			http.Error(w, reason, http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})
	msrv := &http.Server{Addr: cfg.MetricsAddr, Handler: mmux, ReadHeaderTimeout: 5 * time.Second, ErrorLog: quietLog()}
	var ksrv *http.Server
	if cfg.KeyxAddr != "" {
		ksrv = &http.Server{Addr: cfg.KeyxAddr, Handler: kx.Handler(), TLSConfig: keys.ServerTLS(nodeCert, ca), ReadHeaderTimeout: 5 * time.Second, ErrorLog: quietLog()}
	}
	errc := make(chan error, 3)
	pubLn, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	if tlsConf != nil {
		pubLn = transport.NewListener(pubLn, tlsConf)
	}
	go func() { errc <- pub.Serve(pubLn) }()
	go func() { errc <- msrv.ListenAndServe() }()
	if ksrv != nil {
		go func() { errc <- ksrv.ListenAndServeTLS("", "") }()
	}
	log.Info("gateway started", "boot_id", bootID, "listen", cfg.ListenAddr, "cores", len(cores), "peers", len(peers),
		"tracker_versions", tf.Versions(), "pathnorm", guard.RulesVersion, "transport_rules", transport.RulesVersion, "mlock", ring.Locked(), "core_dumps_disabled", secmem.CoreDumpsDisabled())

	select {
	case <-ctx.Done():
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Error("listener failed", "error", err.Error())
		}
	}
	// Drain: refuse new ingest (503), finish in-flight requests, write the last counter record, close the spool.
	log.Info("draining")
	draining.Store(true)
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = pub.Shutdown(sctx)
	if ksrv != nil {
		_ = ksrv.Shutdown(sctx)
	}
	cancelFlush()
	<-flushDone
	cancelBG()
	<-fwdDone
	close(stopWatch)
	_ = msrv.Shutdown(sctx)
	return sp.Close()
}

// quietLog drops net/http's own error log (it prints client addresses on TLS handshake errors).
func quietLog() *stdlog.Logger { return stdlog.New(io.Discard, "", 0) }
