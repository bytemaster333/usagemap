// SPDX-License-Identifier: Apache-2.0

// Package config reads the gateway's environment (all variables prefixed GW_). Secrets are files, never values.
package config

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// NodeRe is the one node-name pattern (C-114).
var NodeRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,31}$`)

// Named is a name=url pair (cores, peers).
type Named struct{ Name, URL string }

// Config of the gateway.
type Config struct {
	Node             string
	ListenAddr       string
	TLSCert, TLSKey  string
	AllowPlaintext   bool
	MetricsAddr      string
	KeyxAddr         string
	Peers            []Named
	NodeCert         string
	NodeKey          string
	CA               string
	Cores            []Named
	SnapshotKeys     string
	SnapshotInterval time.Duration
	StateDir         string
	SpoolMaxBytes    int64
	SpoolSiteShare   int64 // bytes of pending event records one site may hold
	GeoDB, GeoSHA256 string
	RangeListsDir    string
	TrackerDir       string
	LogLevel         string
	RequireMlock     bool
	Workers          int
	CounterPeriod    time.Duration
	OTLPEnabled      bool
	PepperIngFile    string
	CollectorHTTP    string
	CollectorGRPC    string
	OTLPMaxInflight  int // concurrent OTLP requests per node
	OTLPTenantFlight int // concurrent OTLP requests per tenant and node
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func parseNamed(s string) ([]Named, error) {
	var out []Named
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		n, u, ok := strings.Cut(p, "=")
		if !ok || !NodeRe.MatchString(n) || !strings.HasPrefix(u, "https://") {
			return nil, fmt.Errorf("expected name=https://host:port, got %q", p)
		}
		out = append(out, Named{n, strings.TrimRight(u, "/")})
	}
	return out, nil
}

// Load reads the configuration.
func Load() (*Config, error) {
	c := &Config{
		Node:           os.Getenv("GW_NODE_ID"),
		ListenAddr:     env("GW_LISTEN_ADDR", ":8443"),
		TLSCert:        os.Getenv("GW_TLS_CERT"),
		TLSKey:         os.Getenv("GW_TLS_KEY"),
		AllowPlaintext: os.Getenv("GW_ALLOW_PLAINTEXT") == "1",
		MetricsAddr:    env("GW_METRICS_ADDR", ":9464"),
		KeyxAddr:       os.Getenv("GW_KEYX_ADDR"),
		NodeCert:       os.Getenv("GW_NODE_CERT"),
		NodeKey:        os.Getenv("GW_NODE_KEY"),
		CA:             os.Getenv("GW_CA"),
		SnapshotKeys:   os.Getenv("GW_SNAPSHOT_KEYS"),
		StateDir:       env("GW_STATE_DIR", "/var/lib/scf-gateway"),
		GeoDB:          os.Getenv("GW_GEO_DB"),
		GeoSHA256:      os.Getenv("GW_GEO_SHA256"),
		RangeListsDir:  env("GW_RANGELISTS_DIR", "/var/lib/scf-rangelists"),
		TrackerDir:     env("GW_TRACKER_DIR", "/usr/share/scf-gateway/tracker"),
		LogLevel:       env("GW_LOG_LEVEL", "info"),
		RequireMlock:   env("GW_REQUIRE_MLOCK", "1") == "1",
	}
	var errs []error
	if !NodeRe.MatchString(c.Node) {
		errs = append(errs, errors.New("GW_NODE_ID must match ^[a-z0-9][a-z0-9-]{1,31}$"))
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		errs = append(errs, errors.New("set both GW_TLS_CERT and GW_TLS_KEY"))
	}
	if c.TLSCert == "" && !c.AllowPlaintext {
		errs = append(errs, errors.New("GW_TLS_CERT/GW_TLS_KEY are required (GW_ALLOW_PLAINTEXT=1 only behind a TLS terminator or in tests)"))
	}
	if c.NodeCert == "" || c.NodeKey == "" || c.CA == "" {
		errs = append(errs, errors.New("GW_NODE_CERT, GW_NODE_KEY and GW_CA are required (mTLS to the cores and peers)"))
	}
	var err error
	if c.Cores, err = parseNamed(os.Getenv("GW_CORES")); err != nil || len(c.Cores) == 0 {
		errs = append(errs, fmt.Errorf("GW_CORES: %v", err))
	}
	if c.Peers, err = parseNamed(os.Getenv("GW_KEYX_PEERS")); err != nil {
		errs = append(errs, fmt.Errorf("GW_KEYX_PEERS: %v", err))
	}
	if len(c.Peers) > 0 && c.KeyxAddr == "" {
		errs = append(errs, errors.New("GW_KEYX_ADDR is required when GW_KEYX_PEERS is set"))
	}
	if c.SnapshotKeys == "" {
		errs = append(errs, errors.New("GW_SNAPSHOT_KEYS is required (kid=path to the Ed25519 public key)"))
	}
	if c.SnapshotInterval, err = time.ParseDuration(env("GW_SNAPSHOT_INTERVAL", "30s")); err != nil || c.SnapshotInterval < time.Second || c.SnapshotInterval > 45*time.Second {
		errs = append(errs, errors.New("GW_SNAPSHOT_INTERVAL must be between 1s and 45s (revocation within 60 s, C-06)"))
	}
	if c.SpoolMaxBytes, err = strconv.ParseInt(env("GW_SPOOL_MAX_BYTES", strconv.FormatInt(20<<30, 10)), 10, 64); err != nil || c.SpoolMaxBytes < 1<<20 {
		errs = append(errs, errors.New("GW_SPOOL_MAX_BYTES must be ≥ 1 MiB"))
	}
	if c.SpoolSiteShare, err = strconv.ParseInt(env("GW_SPOOL_SITE_SHARE_BYTES", strconv.FormatInt(c.SpoolMaxBytes/4, 10)), 10, 64); err != nil || c.SpoolSiteShare < 1<<20 || c.SpoolSiteShare > c.SpoolMaxBytes {
		errs = append(errs, errors.New("GW_SPOOL_SITE_SHARE_BYTES must be between 1 MiB and GW_SPOOL_MAX_BYTES (default a quarter of it)"))
	}
	if c.Workers, err = strconv.Atoi(env("GW_FORWARD_WORKERS", "16")); err != nil || c.Workers < 1 || c.Workers > 256 {
		errs = append(errs, errors.New("GW_FORWARD_WORKERS must be 1…256"))
	}
	if c.CounterPeriod, err = time.ParseDuration(env("GW_COUNTER_PERIOD", "1m")); err != nil || c.CounterPeriod < time.Second || c.CounterPeriod > time.Minute {
		errs = append(errs, errors.New("GW_COUNTER_PERIOD must be between 1s and 1m (counter records are per minute, §d.3)"))
	}
	c.OTLPEnabled = env("GW_OTLP_ENABLED", "1") == "1"
	c.PepperIngFile = os.Getenv("GW_PEPPER_ING_FILE")
	c.CollectorHTTP = strings.TrimRight(env("GW_COLLECTOR_HTTP", "http://127.0.0.1:4318"), "/")
	c.CollectorGRPC = strings.TrimRight(env("GW_COLLECTOR_GRPC", "http://127.0.0.1:4317"), "/")
	if c.OTLPMaxInflight, err = strconv.Atoi(env("GW_OTLP_MAX_INFLIGHT", "16")); err != nil || c.OTLPMaxInflight < 1 || c.OTLPMaxInflight > 1024 {
		errs = append(errs, errors.New("GW_OTLP_MAX_INFLIGHT must be 1…1024"))
	}
	if c.OTLPTenantFlight, err = strconv.Atoi(env("GW_OTLP_MAX_INFLIGHT_TENANT", "4")); err != nil || c.OTLPTenantFlight < 1 || c.OTLPTenantFlight > c.OTLPMaxInflight {
		errs = append(errs, errors.New("GW_OTLP_MAX_INFLIGHT_TENANT must be 1…GW_OTLP_MAX_INFLIGHT"))
	}
	if c.OTLPEnabled && c.PepperIngFile == "" {
		errs = append(errs, errors.New("GW_PEPPER_ING_FILE is required for the OTLP front door (GW_OTLP_ENABLED=0 disables it)"))
	}
	return c, errors.Join(errs...)
}
