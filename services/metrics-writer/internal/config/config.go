// SPDX-License-Identifier: Apache-2.0

// Package config reads the writer's environment. Secrets come from files (Docker secrets); no value of a secret
// is ever logged.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the writer's configuration.
type Config struct {
	ListenAddr    string // SCF_WRITER_LISTEN_ADDR [:4319]
	AdminAddr     string // SCF_WRITER_ADMIN_ADDR [:9464] — /metrics, /healthz, /readyz (plain HTTP, internal)
	TLSCertFile   string // SCF_WRITER_TLS_CERT_FILE (required)
	TLSKeyFile    string // SCF_WRITER_TLS_KEY_FILE (required)
	TLSClientCA   string // SCF_WRITER_TLS_CLIENT_CA_FILE (required)
	TLSCRLFile    string // SCF_WRITER_TLS_CRL_FILE (optional)
	AllowedOUs    []string
	DatabaseURL   string // SCF_WRITER_DATABASE_URL or SCF_WRITER_DATABASE_URL_FILE (PgBouncer, role scf_writer)
	DBPassword    string // SCF_WRITER_DB_PASSWORD_FILE (optional; overrides a password in the URL)
	DBMaxConns    int32  // SCF_WRITER_DB_MAX_CONNS [8] (S-05: 8–16 is enough)
	MaxBodyBytes  int64
	ProbeInterval time.Duration
	LogLevel      string
	TxTimeout     time.Duration // SCF_WRITER_TX_TIMEOUT [10s] per tenant transaction
	WorkTimeout   time.Duration // SCF_WRITER_WORK_TIMEOUT [12s] per request; below the Collector's 15 s timeout
}

// MaxWorkTimeout is the largest request budget: the Collector's exporter timeout (collector/config/collector.yaml,
// 15 s) minus a margin for the response, so the writer always answers before the Collector retries.
const MaxWorkTimeout = 14 * time.Second

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func fileValue(k string) (string, error) {
	p := os.Getenv(k)
	if p == "" {
		return "", nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", fmt.Errorf("%s: %w", k, err)
	}
	return strings.TrimRight(string(b), "\r\n"), nil
}

// Load reads the environment.
func Load() (Config, error) {
	c := Config{
		ListenAddr:  env("SCF_WRITER_LISTEN_ADDR", ":4319"),
		AdminAddr:   env("SCF_WRITER_ADMIN_ADDR", ":9464"),
		TLSCertFile: os.Getenv("SCF_WRITER_TLS_CERT_FILE"),
		TLSKeyFile:  os.Getenv("SCF_WRITER_TLS_KEY_FILE"),
		TLSClientCA: os.Getenv("SCF_WRITER_TLS_CLIENT_CA_FILE"),
		TLSCRLFile:  os.Getenv("SCF_WRITER_TLS_CRL_FILE"),
		LogLevel:    env("SCF_WRITER_LOG_LEVEL", "info"),
	}
	for _, ou := range strings.Split(env("SCF_WRITER_ALLOWED_CLIENT_OUS", "edge"), ",") {
		if ou = strings.TrimSpace(ou); ou != "" {
			c.AllowedOUs = append(c.AllowedOUs, ou)
		}
	}
	var err error
	c.DatabaseURL = os.Getenv("SCF_WRITER_DATABASE_URL")
	if c.DatabaseURL == "" {
		if c.DatabaseURL, err = fileValue("SCF_WRITER_DATABASE_URL_FILE"); err != nil {
			return c, err
		}
	}
	if c.DBPassword, err = fileValue("SCF_WRITER_DB_PASSWORD_FILE"); err != nil {
		return c, err
	}
	n, err := strconv.Atoi(env("SCF_WRITER_DB_MAX_CONNS", "8"))
	if err != nil || n < 1 || n > 64 {
		return c, errors.New("SCF_WRITER_DB_MAX_CONNS must be 1–64")
	}
	c.DBMaxConns = int32(n)
	mb, err := strconv.ParseInt(env("SCF_WRITER_MAX_BODY_BYTES", strconv.Itoa(64<<20)), 10, 64)
	if err != nil || mb < 1<<20 {
		return c, errors.New("SCF_WRITER_MAX_BODY_BYTES must be ≥ 1 MiB")
	}
	c.MaxBodyBytes = mb
	if c.ProbeInterval, err = time.ParseDuration(env("SCF_WRITER_PROBE_INTERVAL", "2s")); err != nil || c.ProbeInterval <= 0 {
		return c, errors.New("SCF_WRITER_PROBE_INTERVAL must be a positive duration")
	}
	if c.TxTimeout, err = time.ParseDuration(env("SCF_WRITER_TX_TIMEOUT", "10s")); err != nil || c.TxTimeout <= 0 {
		return c, errors.New("SCF_WRITER_TX_TIMEOUT must be a positive duration")
	}
	if c.WorkTimeout, err = time.ParseDuration(env("SCF_WRITER_WORK_TIMEOUT", "12s")); err != nil || c.WorkTimeout <= 0 ||
		c.WorkTimeout > MaxWorkTimeout {
		return c, fmt.Errorf("SCF_WRITER_WORK_TIMEOUT must be a positive duration of at most %s", MaxWorkTimeout)
	}
	if c.TxTimeout > c.WorkTimeout {
		return c, errors.New("SCF_WRITER_TX_TIMEOUT must not exceed SCF_WRITER_WORK_TIMEOUT")
	}
	switch {
	case c.TLSCertFile == "" || c.TLSKeyFile == "" || c.TLSClientCA == "":
		return c, errors.New("SCF_WRITER_TLS_CERT_FILE, SCF_WRITER_TLS_KEY_FILE and SCF_WRITER_TLS_CLIENT_CA_FILE are required (mutual TLS, C-107)")
	case c.DatabaseURL == "":
		return c, errors.New("SCF_WRITER_DATABASE_URL or SCF_WRITER_DATABASE_URL_FILE is required")
	}
	if u, err := url.Parse(c.DatabaseURL); err == nil && u.User != nil && u.User.Username() != "" && u.User.Username() != "scf_writer" {
		return c, errors.New("the database user must be scf_writer (no bypass role, ADR-0013)")
	}
	return c, nil
}
