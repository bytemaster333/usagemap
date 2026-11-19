// SPDX-License-Identifier: Apache-2.0

// Command ap-listener consumes Anchor Platform 5.x events from its Kafka
// TRANSACTION topic with its own consumer group and sends aggregate metrics
// (status transitions, transfer latencies, KYC status counts, quotes) over
// OTLP to UsageMap. It reads only an allow-list of event fields: never
// amounts, fees, accounts, memos, external ids, Stellar transactions,
// customer fields, messages, instructions, refunds or client IP addresses.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
)

const (
	scopeName          = "github.com/bytemaster333/usagemap/tools/ap-listener"
	version            = "0.1.0"
	defaultServiceName = "anchor-platform-events"
)

// Config is read from the environment (see README.md).
type Config struct {
	Kafka      KafkaConfig
	Network    string
	MaxClients int
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func secretEnv(k string) (string, error) {
	if f := env(k+"_FILE", ""); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return "", fmt.Errorf("read %s_FILE: %w", k, err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	return os.Getenv(k), nil
}

// LoadConfig reads the configuration from the environment.
func LoadConfig() (Config, error) {
	var c Config
	for _, b := range strings.Split(env("AP_KAFKA_BROKERS", ""), ",") {
		if b = strings.TrimSpace(b); b != "" {
			c.Kafka.Brokers = append(c.Kafka.Brokers, b)
		}
	}
	c.Kafka.Topic = env("AP_KAFKA_TOPIC", "TRANSACTION")
	c.Kafka.Group = env("AP_KAFKA_GROUP", "usagemap-ap-listener")
	c.Kafka.SecurityProtocol = env("AP_KAFKA_SECURITY_PROTOCOL", "PLAINTEXT")
	c.Kafka.Username = env("AP_KAFKA_SASL_USERNAME", "")
	pw, err := secretEnv("AP_KAFKA_SASL_PASSWORD")
	if err != nil {
		return c, err
	}
	c.Kafka.Password = pw
	c.Kafka.CAFile = env("AP_KAFKA_CA_FILE", "")
	switch s := strings.ToLower(env("AP_KAFKA_START", "latest")); s {
	case "latest":
	case "earliest":
		c.Kafka.StartAtEarliest = true
	default:
		return c, fmt.Errorf("AP_KAFKA_START must be latest or earliest, not %q", s)
	}
	c.Network = env("STELLAR_NETWORK", "unknown")
	if !networks.has(c.Network) {
		return c, fmt.Errorf("STELLAR_NETWORK must be one of mainnet, testnet, futurenet, local, unknown")
	}
	c.MaxClients, err = strconv.Atoi(env("AP_LISTENER_MAX_CLIENTS", "50"))
	if err != nil || c.MaxClients < 1 || c.MaxClients > 500 {
		return c, errors.New("AP_LISTENER_MAX_CLIENTS must be 1–500")
	}
	if _, err := kafkaOpts(c.Kafka); err != nil {
		return c, err
	}
	return c, nil
}

func main() {
	showVersion := flag.Bool("version", false, "print the version and exit")
	checkOnly := flag.Bool("check-config", false, "validate the configuration and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg, err := LoadConfig()
	if err != nil {
		log.Error("invalid configuration", "error", err.Error())
		os.Exit(2)
	}
	if *checkOnly {
		fmt.Println("configuration ok")
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, log); err != nil {
		log.Error("stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run(ctx context.Context, cfg Config, log *slog.Logger) error {
	// OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS / OTEL_METRIC_EXPORT_INTERVAL are
	// read by the SDK; OTEL_SERVICE_NAME overrides the default service name.
	exp, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return fmt.Errorf("otlp exporter: %w", err)
	}
	res, err := resource.New(ctx,
		resource.WithAttributes(attribute.String("service.name", defaultServiceName)),
		resource.WithFromEnv(),
	)
	if err != nil {
		return fmt.Errorf("resource: %w", err)
	}
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp)))
	defer func() {
		sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = mp.Shutdown(sctx) // flushes the last interval
	}()
	p, err := NewProcessor(mp.Meter(scopeName), ProcessorOptions{Network: cfg.Network, MaxClients: cfg.MaxClients})
	if err != nil {
		return err
	}
	var stats Stats
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				log.Info("events handled", "ok", stats.OK.Load(), "malformed", stats.Malformed.Load(), "ignored", stats.Ignored.Load())
			}
		}
	}()
	log.Info("consuming", "topic", cfg.Kafka.Topic, "group", cfg.Kafka.Group, "version", version)
	err = Consume(ctx, cfg.Kafka, p, &stats, log)
	log.Info("events handled", "ok", stats.OK.Load(), "malformed", stats.Malformed.Load(), "ignored", stats.Ignored.Load())
	return err
}
