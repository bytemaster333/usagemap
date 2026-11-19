// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/plain"
)

// KafkaConfig mirrors the settings Anchor Platform 5.x itself uses
// (events.queue.kafka: bootstrap_server, security_protocol PLAINTEXT |
// SASL_PLAINTEXT | SASL_SSL, sasl_mechanism PLAIN), plus our own consumer
// group so the anchor's own event processors are not affected.
type KafkaConfig struct {
	Brokers          []string
	Topic            string // Anchor Platform names the topic after the queue: TRANSACTION
	Group            string
	SecurityProtocol string
	Username         string
	Password         string
	CAFile           string
	StartAtEarliest  bool
}

// Stats counts handled records by result (logged, never exported as data).
type Stats struct {
	OK, Malformed, Ignored atomic.Int64
}

func (s *Stats) add(r Result) {
	switch r {
	case ResultOK:
		s.OK.Add(1)
	case ResultMalformed:
		s.Malformed.Add(1)
	default:
		s.Ignored.Add(1)
	}
}

func kafkaOpts(c KafkaConfig) ([]kgo.Opt, error) {
	if len(c.Brokers) == 0 {
		return nil, errors.New("no Kafka brokers configured")
	}
	if c.Topic == "" || c.Group == "" {
		return nil, errors.New("topic and consumer group are required")
	}
	start := kgo.NewOffset().AtEnd()
	if c.StartAtEarliest {
		start = kgo.NewOffset().AtStart()
	}
	opts := []kgo.Opt{
		kgo.SeedBrokers(c.Brokers...),
		kgo.ConsumerGroup(c.Group),
		kgo.ConsumeTopics(c.Topic),
		kgo.ConsumeResetOffset(start),
		kgo.AutoCommitMarks(),
		kgo.ClientID("usagemap-ap-listener"),
	}
	switch strings.ToUpper(c.SecurityProtocol) {
	case "", "PLAINTEXT":
	case "SASL_PLAINTEXT", "SASL_SSL":
		if c.Username == "" {
			return nil, fmt.Errorf("%s needs a SASL username and password", c.SecurityProtocol)
		}
		opts = append(opts, kgo.SASL(plain.Auth{User: c.Username, Pass: c.Password}.AsMechanism()))
		if strings.EqualFold(c.SecurityProtocol, "SASL_SSL") {
			tc := &tls.Config{MinVersion: tls.VersionTLS12}
			if c.CAFile != "" {
				pem, err := os.ReadFile(c.CAFile)
				if err != nil {
					return nil, fmt.Errorf("read CA file: %w", err)
				}
				pool := x509.NewCertPool()
				if !pool.AppendCertsFromPEM(pem) {
					return nil, errors.New("CA file holds no PEM certificate")
				}
				tc.RootCAs = pool
			}
			opts = append(opts, kgo.DialTLSConfig(tc))
		}
	default:
		return nil, fmt.Errorf("unsupported security protocol %q (PLAINTEXT, SASL_PLAINTEXT, SASL_SSL)", c.SecurityProtocol)
	}
	return opts, nil
}

// Consume reads the topic until ctx ends, handing each record to p. Offsets
// are committed only after a record was handled (at-least-once: a crash can
// count an event twice, never skip one silently).
func Consume(ctx context.Context, c KafkaConfig, p *Processor, stats *Stats, log *slog.Logger) error {
	opts, err := kafkaOpts(c)
	if err != nil {
		return err
	}
	cl, err := kgo.NewClient(opts...)
	if err != nil {
		return fmt.Errorf("kafka client: %w", err)
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := cl.CommitMarkedOffsets(cctx); err != nil {
			log.Warn("final offset commit failed", "error_kind", errKind(err))
		}
		cl.Close()
	}()
	for {
		fetches := cl.PollFetches(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if fetches.IsClientClosed() {
			return nil
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			// Broker/topic errors only; record contents are never logged.
			log.Warn("fetch error", "topic", topic, "partition", partition, "error", err.Error())
		})
		fetches.EachRecord(func(r *kgo.Record) {
			stats.add(p.Handle(ctx, r.Value))
			cl.MarkCommitRecords(r)
		})
	}
}

// errKind is a short, content-free description of an error for logs.
func errKind(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	default:
		return fmt.Sprintf("%T", err)
	}
}
