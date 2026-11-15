// SPDX-License-Identifier: Apache-2.0

// Command umami-bootstrap runs Umami's one-shot bootstrap B1–B5 through the engine proxy with the provisioning
// identity's certificate (wire-formats §j.2; C-99, C-104, C-112(7)). It is restartable and idempotent: run it at every
// deploy; it resumes from the first incomplete step and ends with the B5 check that opens the proxy's gate.
//
// Configuration (environment; files are read once, values are never logged):
//
//	UB_PROXY_URL                  https://engine-proxy:8443
//	UB_TLS_CERT, UB_TLS_KEY       provisioning identity's client certificate (OU=provisioner)
//	UB_CA                         private CA bundle
//	UB_SERVER_NAME                expected server name in the proxy's certificate (default: host of UB_PROXY_URL)
//	UB_SEED_PASSWORD_FILE         B2: the seed admin's interim password (from SOPS / .secrets)
//	UB_PROVISIONER_PASSWORD_FILE  B3: the provisioning admin's password
//	UB_PROVISIONER_USER           default scf-provisioner
//	UB_DEADLINE                   total time budget, default 5m
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/bootstrap"
	"github.com/bytemaster333/usagemap/services/engine-proxy/internal/proxy"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("umami_bootstrap_failed", "error", err.Error())
		os.Exit(1)
	}
}

func secret(env string) (string, error) {
	p := os.Getenv(env)
	if p == "" {
		return "", errors.New(env + " is required")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", errors.New(env + ": cannot read the file")
	}
	return strings.TrimRight(string(b), "\r\n"), nil
}

func run(logger *slog.Logger) error {
	base, err := url.Parse(os.Getenv("UB_PROXY_URL"))
	if err != nil || base.Scheme != "https" || base.Host == "" {
		return errors.New("UB_PROXY_URL must be the engine proxy's https origin")
	}
	serverName := os.Getenv("UB_SERVER_NAME")
	if serverName == "" {
		serverName = base.Hostname()
	}
	tlsCfg, err := proxy.ClientConfig(os.Getenv("UB_TLS_CERT"), os.Getenv("UB_TLS_KEY"), os.Getenv("UB_CA"), serverName)
	if err != nil {
		return err
	}
	seed, err := secret("UB_SEED_PASSWORD_FILE")
	if err != nil {
		return err
	}
	provPW, err := secret("UB_PROVISIONER_PASSWORD_FILE")
	if err != nil {
		return err
	}
	user := os.Getenv("UB_PROVISIONER_USER")
	if user == "" {
		user = "scf-provisioner"
	}
	deadline := 5 * time.Minute
	if v := os.Getenv("UB_DEADLINE"); v != "" {
		if deadline, err = time.ParseDuration(v); err != nil || deadline <= 0 {
			return errors.New("UB_DEADLINE must be a positive duration")
		}
	}
	b := &bootstrap.Bootstrapper{
		Base:   base,
		HTTP:   &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil, TLSClientConfig: tlsCfg}},
		Logger: logger,
		Config: bootstrap.Config{SeedPassword: seed, ProvisionerUser: user, ProvisionerPassword: provPW},
		Retry:  bootstrap.RetryPolicy{Initial: time.Second, Max: 10 * time.Second, Deadline: deadline},
	}
	res, err := b.Run(context.Background())
	if err != nil {
		return err
	}
	logger.Info("umami_bootstrap_done", "steps", strings.Join(res.Steps, ","))
	return nil
}
