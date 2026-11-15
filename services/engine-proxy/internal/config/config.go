// SPDX-License-Identifier: Apache-2.0

// Package config reads the engine proxy's environment.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"time"
)

// Config is the engine proxy's runtime configuration.
type Config struct {
	ListenAddr      string        // EP_LISTEN_ADDR, mutual-TLS listener (default :8443)
	MetricsAddr     string        // EP_METRICS_ADDR, plain HTTP /metrics, /healthz, /readyz (default :9464)
	TLSCert         string        // EP_TLS_CERT (required)
	TLSKey          string        // EP_TLS_KEY (required)
	ClientCA        string        // EP_CLIENT_CA (required): CA bundle of the node certificates
	ClientCRL       string        // EP_CLIENT_CRL (optional)
	UmamiURL        *url.URL      // EP_UMAMI_URL (default http://umami:3000)
	ControlPlaneURL *url.URL      // EP_CONTROL_PLANE_URL (optional; internal edge API answers 503 without it)
	CPClientCert    string        // EP_CONTROL_PLANE_TLS_CERT: client certificate for an https control plane
	CPClientKey     string        // EP_CONTROL_PLANE_TLS_KEY
	CPCA            string        // EP_CONTROL_PLANE_TLS_CA: CA bundle of the control plane's certificate
	MaxEntries      int           // EP_MAX_ENTRIES (default 500000)
	DedupWindow     time.Duration // EP_DEDUP_WINDOW: how long a delivered event key is remembered (default 1h, C1 #11)
	DedupMaxEntries int           // EP_DEDUP_MAX_ENTRIES (default 500000)
	UpstreamTimeout time.Duration // EP_UPSTREAM_TIMEOUT (default 30s, = umami_app statement_timeout)
	GateProbeClosed time.Duration // EP_GATE_PROBE_CLOSED (default 2s)
	GateProbeOpen   time.Duration // EP_GATE_PROBE_OPEN (default 60s)
	ShutdownGrace   time.Duration // EP_SHUTDOWN_GRACE (default 10s)
	LogLevel        slog.Level    // EP_LOG_LEVEL (debug|info|warn|error; default info)

	// The provisioning identity used by the proxy's own bootstrap probe (C-114): the gate opens only when the seed
	// credentials are refused and this identity can sign in.
	ProvisionerUser         string // EP_PROVISIONER_USER (default scf-provisioner, = UB_PROVISIONER_USER)
	ProvisionerPasswordFile string // EP_PROVISIONER_PASSWORD_FILE (optional; without it only the worker's B5 opens the gate)
}

func httpURL(name, v string) (*url.URL, error) {
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return nil, fmt.Errorf("%s must be an http(s) origin without path or query", name)
	}
	u.Path = ""
	return u, nil
}

func duration(name, v string, def time.Duration) (time.Duration, error) {
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", name)
	}
	return d, nil
}

// Load reads the configuration through getenv (os.Getenv in production).
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		ListenAddr:  or(getenv("EP_LISTEN_ADDR"), ":8443"),
		MetricsAddr: or(getenv("EP_METRICS_ADDR"), ":9464"),
		TLSCert:     getenv("EP_TLS_CERT"),
		TLSKey:      getenv("EP_TLS_KEY"),
		ClientCA:    getenv("EP_CLIENT_CA"),
		ClientCRL:   getenv("EP_CLIENT_CRL"),

		ProvisionerUser:         or(getenv("EP_PROVISIONER_USER"), "scf-provisioner"),
		ProvisionerPasswordFile: getenv("EP_PROVISIONER_PASSWORD_FILE"),
	}
	var errs []error
	if c.TLSCert == "" || c.TLSKey == "" || c.ClientCA == "" {
		errs = append(errs, errors.New("EP_TLS_CERT, EP_TLS_KEY and EP_CLIENT_CA are required"))
	}
	var err error
	if c.UmamiURL, err = httpURL("EP_UMAMI_URL", or(getenv("EP_UMAMI_URL"), "http://umami:3000")); err != nil {
		errs = append(errs, err)
	}
	if v := getenv("EP_CONTROL_PLANE_URL"); v != "" {
		if c.ControlPlaneURL, err = httpURL("EP_CONTROL_PLANE_URL", v); err != nil {
			errs = append(errs, err)
		}
	}
	c.CPClientCert, c.CPClientKey, c.CPCA = getenv("EP_CONTROL_PLANE_TLS_CERT"), getenv("EP_CONTROL_PLANE_TLS_KEY"), getenv("EP_CONTROL_PLANE_TLS_CA")
	if c.ControlPlaneURL != nil && c.ControlPlaneURL.Scheme == "https" && (c.CPClientCert == "" || c.CPClientKey == "" || c.CPCA == "") {
		errs = append(errs, errors.New("an https EP_CONTROL_PLANE_URL needs EP_CONTROL_PLANE_TLS_CERT, _KEY and _CA"))
	}
	c.MaxEntries = 500_000
	if v := getenv("EP_MAX_ENTRIES"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 10_000_000 {
			errs = append(errs, errors.New("EP_MAX_ENTRIES must be 1 … 10000000"))
		}
		c.MaxEntries = n
	}
	c.DedupMaxEntries = 500_000
	if v := getenv("EP_DEDUP_MAX_ENTRIES"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 10_000_000 {
			errs = append(errs, errors.New("EP_DEDUP_MAX_ENTRIES must be 1 … 10000000"))
		}
		c.DedupMaxEntries = n
	}
	for _, d := range []struct {
		dst  *time.Duration
		name string
		def  time.Duration
	}{
		{&c.DedupWindow, "EP_DEDUP_WINDOW", time.Hour},
		{&c.UpstreamTimeout, "EP_UPSTREAM_TIMEOUT", 30 * time.Second},
		{&c.GateProbeClosed, "EP_GATE_PROBE_CLOSED", 2 * time.Second},
		{&c.GateProbeOpen, "EP_GATE_PROBE_OPEN", 60 * time.Second},
		{&c.ShutdownGrace, "EP_SHUTDOWN_GRACE", 10 * time.Second},
	} {
		if *d.dst, err = duration(d.name, getenv(d.name), d.def); err != nil {
			errs = append(errs, err)
		}
	}
	if err := c.LogLevel.UnmarshalText([]byte(or(getenv("EP_LOG_LEVEL"), "info"))); err != nil {
		errs = append(errs, errors.New("EP_LOG_LEVEL must be debug, info, warn or error"))
	}
	return c, errors.Join(errs...)
}

func or(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
