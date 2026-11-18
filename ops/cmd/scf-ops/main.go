// SPDX-License-Identifier: Apache-2.0

// Command scf-ops is the operations toolbox:
//
//	scf-ops probe       -config probe.json           probe source: rounds every 30 s, journeys every 60 s (C-78, C-93)
//	scf-ops slo-report  -store DIR -month YYYY-MM -out docs/evidence/slo [-prometheus URL]
//	scf-ops status-page -store DIR -out DIR [-listen :8080] [-heartbeat-token-file F]
//	scf-ops logscan     -victorialogs URL [-interval 5m] [-metrics :9480]
//	scf-ops dashboards  -out ops/dashboards          regenerate the Grafana dashboards from code
//	scf-ops keygen      -seed-file F                 new Stellar keypair for a synthetic journey member; prints G…
//	scf-ops chown       -owner UID:GID PATH…         hand a new named volume to a service's user (vlogs-init)
//	scf-ops healthcheck URL
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
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

	"github.com/bytemaster333/usagemap/ops/internal/dashboards"
	"github.com/bytemaster333/usagemap/ops/internal/journey"
	"github.com/bytemaster333/usagemap/ops/internal/logscan"
	"github.com/bytemaster333/usagemap/ops/internal/metrics"
	"github.com/bytemaster333/usagemap/ops/internal/probes"
	"github.com/bytemaster333/usagemap/ops/internal/slo"
	"github.com/bytemaster333/usagemap/ops/internal/status"
	"github.com/bytemaster333/usagemap/ops/internal/store"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "probe":
		err = probeCmd(os.Args[2:])
	case "slo-report":
		err = sloCmd(os.Args[2:])
	case "status-page":
		err = statusCmd(os.Args[2:])
	case "logscan":
		err = logscanCmd(os.Args[2:])
	case "dashboards":
		err = dashCmd(os.Args[2:])
	case "keygen":
		err = keygenCmd(os.Args[2:])
	case "chown":
		err = chownCmd(os.Args[2:])
	case "healthcheck":
		os.Exit(healthcheck(os.Args[2:]))
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "scf-ops:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: scf-ops probe|slo-report|status-page|logscan|dashboards|keygen|chown|healthcheck …")
	os.Exit(2)
}

func healthcheck(args []string) int {
	u := "http://127.0.0.1:9480/healthz"
	if len(args) > 0 {
		u = args[0]
	}
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Get(u)
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func logger() *slog.Logger { return slog.New(slog.NewJSONHandler(os.Stderr, nil)) }

func readSecret(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("secret file: %w", err)
	}
	return strings.TrimSpace(string(b)), nil
}

func serveMetrics(addr string, reg *metrics.Registry, extra map[string]http.Handler) *http.Server {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", reg.Handler())
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	for p, h := range extra {
		mux.Handle(p, h)
	}
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			logger().Error("listener failed", "addr", addr)
			os.Exit(1)
		}
	}()
	return srv
}

// probeFile is the probe source's configuration (JSON). Secrets are file paths.
type probeFile struct {
	Source         string            `json:"source"`
	Hosts          map[string]string `json:"hosts"`
	Nodes          map[string]string `json:"nodes"`
	SiteKey        string            `json:"site_key"`
	Origin         string            `json:"origin"`
	TrackerVersion string            `json:"tracker_version"`
	Interval       string            `json:"interval"`
	Deadline       string            `json:"deadline"`
	SelfCheckURL   string            `json:"self_check_url"`
	StoreDir       string            `json:"store_dir"`
	MetricsAddr    string            `json:"metrics_addr"`
	IngestCAFile   string            `json:"ingest_ca_file"`
	OTLPURL        string            `json:"otlp_url"`
	OTLPTokenFile  string            `json:"otlp_token_file"`
	// tracker_api: control-plane origin whose /v1/tracker/versions the served tracker files must match (every
	// tracker_every, default 1m, the status page's cadence); empty = no tracker-file check.
	TrackerAPI   string `json:"tracker_api"`
	TrackerEvery string `json:"tracker_every"`
	Journey      *struct {
		Every        string `json:"every"`
		API          string `json:"api"`
		PortalOrigin string `json:"portal_origin"`
		SeedFile     string `json:"seed_file"`
		TenantID     string `json:"tenant_id"`
		SiteID       string `json:"site_id"`
		ServiceID    string `json:"service_id"`
		OpKeyFile    string `json:"op_key_file"`
		RequireData  bool   `json:"require_data"`
		FreshWithin  string `json:"fresh_within"` // e.g. "15m": page views must also exist in the last 15 minutes
	} `json:"journey"`
}

func dur(s string, def time.Duration) (time.Duration, error) {
	if s == "" {
		return def, nil
	}
	return time.ParseDuration(s)
}

func probeCmd(args []string) error {
	fs := flag.NewFlagSet("probe", flag.ExitOnError)
	cfgPath := fs.String("config", "/etc/scf-ops/probe.json", "probe source configuration")
	once := fs.Bool("once", false, "run one round now and exit (0 when the availability round is good)")
	_ = fs.Parse(args)
	b, err := os.ReadFile(*cfgPath)
	if err != nil {
		return err
	}
	var pf probeFile
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&pf); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if pf.Source == "" || pf.SiteKey == "" || pf.Origin == "" || pf.StoreDir == "" {
		return errors.New("config: source, site_key, origin and store_dir are required")
	}
	iv, err := dur(pf.Interval, 30*time.Second)
	if err != nil {
		return err
	}
	dl, err := dur(pf.Deadline, 2*time.Second)
	if err != nil {
		return err
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if pf.IngestCAFile != "" {
		pool, _ := x509.SystemCertPool()
		if pool == nil {
			pool = x509.NewCertPool()
		}
		pem, err := os.ReadFile(pf.IngestCAFile)
		if err != nil {
			return err
		}
		pool.AppendCertsFromPEM(pem)
		tlsCfg.RootCAs = pool
	}
	// A fresh connection per attempt: every round resolves DNS anew (C-43) and measures a full handshake.
	client := &http.Client{Timeout: dl, Transport: &http.Transport{TLSClientConfig: tlsCfg, DisableKeepAlives: true}}
	cfg := probes.Config{Source: pf.Source, Hosts: pf.Hosts, Nodes: pf.Nodes, SiteKey: pf.SiteKey, Origin: pf.Origin,
		TrackerVersion: pf.TrackerVersion, Deadline: dl, Interval: iv, SelfCheckURL: pf.SelfCheckURL, OTLPURL: pf.OTLPURL,
		IngestClient: client}
	if cfg.TrackerVersion == "" {
		cfg.TrackerVersion = "1.0.0"
	}
	if cfg.OTLPToken, err = readSecret(pf.OTLPTokenFile); err != nil {
		return err
	}
	if pf.TrackerAPI != "" {
		cfg.TrackerAPI = pf.TrackerAPI
		if cfg.TrackerEvery, err = dur(pf.TrackerEvery, time.Minute); err != nil {
			return err
		}
	}
	if j := pf.Journey; j != nil {
		every, err := dur(j.Every, 60*time.Second)
		if err != nil {
			return err
		}
		seed, err := readSecret(j.SeedFile)
		if err != nil {
			return err
		}
		opKey, err := readSecret(j.OpKeyFile)
		if err != nil {
			return err
		}
		fresh, err := dur(j.FreshWithin, 0)
		if err != nil {
			return err
		}
		cfg.JourneyEvery = every
		cfg.Journey = &journey.Config{API: j.API, PortalOrigin: j.PortalOrigin, Seed: seed, TenantID: j.TenantID,
			SiteID: j.SiteID, ServiceID: j.ServiceID, OpKey: opKey, RequireData: j.RequireData, FreshWithin: fresh,
			Client: &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{TLSClientConfig: tlsCfg, DisableKeepAlives: true}}}
	}
	reg := metrics.New()
	probes.Describe(reg)
	r := &probes.Runner{Cfg: cfg, Store: &store.Writer{Dir: pf.StoreDir, Source: pf.Source}, Metrics: reg, Log: logger()}
	if *once {
		rows := r.Round(context.Background(), time.Now().Truncate(time.Second))
		for _, row := range rows {
			if row.Kind == store.KindRound && row.Outcome == store.Good {
				return nil
			}
		}
		os.Exit(1)
	}
	addr := pf.MetricsAddr
	if addr == "" {
		addr = ":9480"
	}
	srv := serveMetrics(addr, reg, nil)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	logger().Info("probe source started", "source", pf.Source, "interval", iv.String(), "hosts", len(pf.Hosts), "nodes", len(pf.Nodes),
		"journey", pf.Journey != nil, "otlp", pf.OTLPURL != "")
	r.Run(ctx)
	sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return srv.Shutdown(sctx)
}

func sloCmd(args []string) error {
	fs := flag.NewFlagSet("slo-report", flag.ExitOnError)
	dir := fs.String("store", "", "raw probe store (one directory per source)")
	month := fs.String("month", time.Now().UTC().AddDate(0, -1, 0).Format("2006-01"), "calendar month YYYY-MM (default: last month)")
	out := fs.String("out", "docs/evidence/slo", "output directory")
	prom := fs.String("prometheus", "", "Prometheus base URL for the server-side view (optional)")
	_ = fs.Parse(args)
	if *dir == "" {
		return errors.New("-store is required")
	}
	rep, err := slo.Compute(*dir, *month)
	if err != nil {
		return err
	}
	if *prom != "" {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		rep.FetchServerSide(ctx, *prom, nil)
	}
	if err := rep.Write(*out); err != nil {
		return err
	}
	h := rep.Series[0]
	fmt.Printf("SLO report %s written to %s: ingest %.4f %% (%d good, %d bad, %d unknown)\n", *month, *out,
		h.Availability()*100, h.Good, h.Bad, h.Unknown)
	return nil
}

func statusCmd(args []string) error {
	fs := flag.NewFlagSet("status-page", flag.ExitOnError)
	dir := fs.String("store", "", "raw probe store")
	out := fs.String("out", "/var/lib/scf-status/www", "output directory (static files)")
	listen := fs.String("listen", "", "serve the output directory and the heartbeat receiver (empty: generate once and exit)")
	every := fs.Duration("every", time.Minute, "regeneration interval")
	tokenFile := fs.String("heartbeat-token-file", "", "bearer token Alertmanager presents with the Watchdog heartbeat")
	def := status.DefaultOptions()
	minVoters := fs.Int("min-voters", def.MinVoters, "sources that must vote for a round to be judged (2 = 2-of-3 quorum; 1 = one probe source)")
	objective := fs.String("objective", def.Objective, "the headline objective as the page shows it, e.g. 99.5%")
	objectiveOf := fs.String("objective-of", def.ObjectiveOf, "one sentence after the objective: what it applies to (never a guarantee)")
	serviceWindow := fs.String("service-window", def.ServiceWindow, "optional sentence after the objective: how this host's objective relates to the service-window commitment")
	objectives := fs.String("objectives", def.Objectives, "sentence naming the objectives that apply to this deployment (status.json consumers; kept for compatibility)")
	placement := fs.String("placement", def.Placement, "sentence on where this page runs relative to the service it monitors")
	reports := fs.String("reports", def.Reports, "sentence on the published SLO reports")
	_ = fs.Parse(args)
	if *dir == "" {
		return errors.New("-store is required")
	}
	opt := def
	opt.MinVoters, opt.Objectives, opt.Placement, opt.Reports = *minVoters, *objectives, *placement, *reports
	opt.Objective, opt.ObjectiveOf, opt.ServiceWindow = *objective, *objectiveOf, *serviceWindow
	gen := func() error {
		p, err := status.BuildWith(*dir, time.Now(), opt)
		if err != nil {
			return err
		}
		return p.Render(*out)
	}
	if err := gen(); err != nil {
		return err
	}
	if *listen == "" {
		return nil
	}
	token, err := readSecret(*tokenFile)
	if err != nil {
		return err
	}
	hb := &status.Heartbeat{Token: token, Out: *out}
	reg := metrics.New()
	reg.Describe("scf_status_page_generated_timestamp_seconds", "gauge", "Last successful generation of the status page.")
	reg.Describe("scf_status_page_errors_total", "counter", "Failed generations.")
	reg.Describe("scf_status_heartbeat_timestamp_seconds", "gauge", "Last Watchdog heartbeat received from Alertmanager.")
	files := http.FileServer(http.Dir(*out))
	srv := serveMetrics(*listen, reg, map[string]http.Handler{
		"POST /v1/heartbeat": hb,
		"GET /": http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Cache-Control", "max-age=30")
			files.ServeHTTP(w, r)
		}),
	})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	t := time.NewTicker(*every)
	defer t.Stop()
	for {
		reg.Set("scf_status_page_generated_timestamp_seconds", float64(time.Now().Unix()))
		if l := hb.Last(); !l.IsZero() {
			reg.Set("scf_status_heartbeat_timestamp_seconds", float64(l.Unix()))
		}
		select {
		case <-ctx.Done():
			sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			return srv.Shutdown(sctx)
		case <-t.C:
			if err := gen(); err != nil {
				reg.Add("scf_status_page_errors_total", 1)
				logger().Error("status page generation failed")
			}
		}
	}
}

func logscanCmd(args []string) error {
	fs := flag.NewFlagSet("logscan", flag.ExitOnError)
	base := fs.String("victorialogs", "http://victorialogs:9428", "VictoriaLogs base URL")
	interval := fs.Duration("interval", 5*time.Minute, "scan window and interval")
	addr := fs.String("metrics", ":9480", "/metrics listener")
	limit := fs.Int("limit", 200000, "maximum lines per window")
	_ = fs.Parse(args)
	reg := metrics.New()
	reg.Describe("scf_log_pii_findings_total", "counter", "Log lines that contain a personal-data or secret shape, by class (text never stored).")
	reg.Describe("scf_log_scan_lines_total", "counter", "Log lines scanned.")
	reg.Describe("scf_log_scan_last_success_timestamp_seconds", "gauge", "End of the last successful scan.")
	reg.Describe("scf_log_scan_errors_total", "counter", "Failed scans.")
	for _, c := range []string{logscan.ClassIPv4, logscan.ClassIPv6, logscan.ClassUA, logscan.ClassBearer, logscan.ClassAPIKey, logscan.ClassSeed, logscan.ClassG} {
		reg.Add("scf_log_pii_findings_total", 0, "class", c)
	}
	srv := serveMetrics(*addr, reg, nil)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	client := &http.Client{Timeout: time.Minute}
	scan := func() {
		counts, lines, err := logscan.Scan(ctx, client, *base, *interval, *limit)
		if err != nil {
			reg.Add("scf_log_scan_errors_total", 1)
			logger().Warn("log scan failed")
			return
		}
		reg.Add("scf_log_scan_lines_total", float64(lines))
		for c, n := range counts {
			reg.Add("scf_log_pii_findings_total", float64(n), "class", c)
		}
		reg.Set("scf_log_scan_last_success_timestamp_seconds", float64(time.Now().Unix()))
	}
	scan()
	t := time.NewTicker(*interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			return srv.Shutdown(sctx)
		case <-t.C:
			scan()
		}
	}
}

func dashCmd(args []string) error {
	fs := flag.NewFlagSet("dashboards", flag.ExitOnError)
	out := fs.String("out", "ops/dashboards", "output directory")
	_ = fs.Parse(args)
	return dashboards.WriteAll(*out)
}

// keygenCmd creates the synthetic member's keypair: the secret seed goes to a 0600 file (never printed), the account
// id to stdout. If the file exists, its account id is printed.
func keygenCmd(args []string) error {
	fs := flag.NewFlagSet("keygen", flag.ExitOnError)
	path := fs.String("seed-file", "", "secret seed file (created 0600 if missing)")
	_ = fs.Parse(args)
	if *path == "" {
		return errors.New("-seed-file is required")
	}
	if b, err := os.ReadFile(*path); err == nil {
		k, err := journey.DecodeSeed(string(b))
		if err != nil {
			return err
		}
		fmt.Println(journey.AccountID(k.Public().(ed25519.PublicKey)))
		return nil
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return err
	}
	if err := os.WriteFile(*path, []byte(journey.EncodeSeed(seed)+"\n"), 0o600); err != nil {
		return err
	}
	fmt.Println(journey.AccountID(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)))
	return nil
}
