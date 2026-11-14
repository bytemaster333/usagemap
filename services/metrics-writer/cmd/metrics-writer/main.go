// SPDX-License-Identifier: Apache-2.0

// Command metrics-writer receives sanitised OTLP metrics from the Collectors (mutual TLS) and writes them into
// PostgreSQL as role scf_writer through PgBouncer, one transaction per tenant (ADR-0009, ADR-0010, wire-formats §g).
//
//	metrics-writer              run (configuration from the environment, see README.md)
//	metrics-writer healthcheck  exit 0 when the admin endpoint answers /healthz (Docker HEALTHCHECK)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/config"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/obs"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/server"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "metrics-writer:", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	addr := os.Getenv("SCF_WRITER_ADMIN_ADDR")
	if addr == "" {
		addr = ":9464"
	}
	if addr[0] == ':' {
		addr = "127.0.0.1" + addr
	}
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get("http://" + addr + "/healthz")
	if err != nil {
		return 1
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	level := slog.LevelInfo
	_ = level.UnmarshalText([]byte(cfg.LogLevel))
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("SCF_WRITER_DATABASE_URL is not a valid connection string")
	}
	if cfg.DBPassword != "" {
		poolCfg.ConnConfig.Password = cfg.DBPassword
	}
	if poolCfg.ConnConfig.User != "scf_writer" {
		return errors.New("the database user must be scf_writer (no bypass role, ADR-0013)")
	}
	poolCfg.MaxConns = cfg.DBMaxConns
	poolCfg.MinConns = 1
	poolCfg.HealthCheckPeriod = 10 * time.Second
	poolCfg.ConnConfig.ConnectTimeout = 5 * time.Second
	poolCfg.ConnConfig.RuntimeParams["application_name"] = "scf-metrics-writer"
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg) // lazy: connects on first use
	if err != nil {
		return err
	}
	defer pool.Close()

	reg := obs.New()
	reg.Set(obs.BuildInfo, 1, "component", "metrics-writer")
	st := store.New(pool, store.Options{Observer: obs.StoreObserver{R: reg}, Logger: logger, TxTimeout: cfg.TxTimeout})
	tlsr, err := server.NewTLSReloader(server.TLSFiles{CertFile: cfg.TLSCertFile, KeyFile: cfg.TLSKeyFile,
		ClientCAFile: cfg.TLSClientCA, CRLFile: cfg.TLSCRLFile, AllowedOUs: cfg.AllowedOUs})
	if err != nil {
		return err
	}
	srv := server.New(server.Config{Addr: cfg.ListenAddr, MaxBodyBytes: cfg.MaxBodyBytes, ProbeInterval: cfg.ProbeInterval,
		WorkTimeout: cfg.WorkTimeout},
		tlsr, st, reg, logger)

	admin := &http.Server{Addr: cfg.AdminAddr, Handler: srv.AdminHandler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := admin.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("admin listener stopped", "error", err.Error())
			stop()
		}
	}()
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			if err := tlsr.Reload(); err != nil {
				logger.Error("TLS reload failed; keeping the previous configuration", "error", err.Error())
			} else {
				logger.Info("TLS configuration reloaded")
			}
		}
	}()
	go func() { // partition bounds change hourly (job partitions); refresh in step
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = st.RefreshPartitions(ctx)
			}
		}
	}()
	logger.Info("metrics-writer starting", "listen", cfg.ListenAddr, "admin", cfg.AdminAddr)
	err = srv.Run(ctx)
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = admin.Shutdown(sctx)
	logger.Info("metrics-writer stopped")
	return err
}
