// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"errors"
	"time"
)

// Defaults of the time bounds of wire-formats §f.5 step 7 (ADR-0009, C-110).
const (
	DefaultMaxFuture = 5 * time.Minute
	DefaultMaxAge    = 48 * time.Hour
)

// Config of the scfsanitize processor. The metadata keys, allow-lists and
// reason codes are fixed by the contract and deliberately not configurable.
type Config struct {
	// MaxFuture: a point or span whose timestamp is later than receipt time +
	// MaxFuture is dropped (future).
	MaxFuture time.Duration `mapstructure:"max_future"`
	// MaxAge: a point or span whose timestamp is earlier than receipt time −
	// MaxAge is dropped (too_old).
	MaxAge time.Duration `mapstructure:"max_age"`
	// StellarClientMetrics keeps the Stellar client metrics of wire-formats
	// §f.5 step 4a (rpc.client.call.duration and http.client.request.duration
	// from the @usagemap/stellar-otel instrumentation, stellar.tx.*
	// counters) with their closed attribute sets. Off by default: the writer
	// stores them only once its stellar_client stream exists; until then they
	// are dropped here as client_metric_ignored / metric_not_allowed, as before.
	StellarClientMetrics bool `mapstructure:"stellar_client_metrics"`
	// ClientMetricSets enables further strict client-metric allow-list steps
	// by name (clientrules.go): "partner" (step 4b, stellar.partner.call.duration
	// of @usagemap/partner-otel) and "payments" (step 4c,
	// payment.server.events of @usagemap/payments-otel). Empty by default:
	// a set is enabled only once the writer stores its metric; until then the
	// names are dropped here as metric_not_allowed, as before.
	ClientMetricSets []string `mapstructure:"client_metric_sets"`
}

func createDefaultConfig() *Config {
	return &Config{MaxFuture: DefaultMaxFuture, MaxAge: DefaultMaxAge}
}

// Validate implements confmap.Validator.
func (c *Config) Validate() error {
	var errs []error
	if c.MaxFuture <= 0 {
		errs = append(errs, errors.New("max_future must be positive"))
	}
	if c.MaxAge <= 0 {
		errs = append(errs, errors.New("max_age must be positive"))
	}
	// The writer drops anything received more than 72 h earlier (C-112(8));
	// a late-data bound beyond that would only move the drop downstream.
	if c.MaxAge > 72*time.Hour {
		errs = append(errs, errors.New("max_age must not exceed 72h"))
	}
	if err := validateClientSets(c.ClientMetricSets); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
