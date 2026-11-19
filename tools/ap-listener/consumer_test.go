// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
)

// The listener consumes the TRANSACTION topic over the real Kafka protocol
// (franz-go's in-process kfake broker), with its own consumer group: the
// anchor's own processor group still sees every record, offsets are committed
// after handling, and a restart resumes without re-counting.
func TestConsumeOwnGroup(t *testing.T) {
	cluster, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.SeedTopics(1, "TRANSACTION"))
	if err != nil {
		t.Fatal(err)
	}
	defer cluster.Close()
	brokers := cluster.ListenAddrs()

	// Anchor Platform's KafkaSession: key = event id, header type, JSON value.
	prod, err := kgo.NewClient(kgo.SeedBrokers(brokers...))
	if err != nil {
		t.Fatal(err)
	}
	defer prod.Close()
	events := lines(t, "testdata/events.jsonl")
	produce := func(vals [][]byte) {
		for _, v := range vals {
			rec := &kgo.Record{Topic: "TRANSACTION", Value: v, Headers: []kgo.RecordHeader{{Key: "type", Value: []byte("transaction")}}}
			if err := prod.ProduceSync(context.Background(), rec).FirstErr(); err != nil {
				t.Fatal(err)
			}
		}
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := KafkaConfig{Brokers: brokers, Topic: "TRANSACTION", Group: "usagemap-ap-listener", StartAtEarliest: true}

	runUntil := func(p *Processor, stats *Stats, want int64) {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- Consume(ctx, cfg, p, stats, log) }()
		deadline := time.After(15 * time.Second)
		for stats.OK.Load()+stats.Malformed.Load()+stats.Ignored.Load() < want {
			select {
			case <-deadline:
				cancel()
				t.Fatalf("handled %d of %d records", stats.OK.Load(), want)
			case <-time.After(20 * time.Millisecond):
			}
		}
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}

	produce(events)
	p, r := newTestProcessor(t, ProcessorOptions{Network: "testnet"})
	var stats Stats
	runUntil(p, &stats, int64(len(events)))
	if stats.OK.Load() != int64(len(events)) {
		t.Fatalf("ok = %d, want %d", stats.OK.Load(), len(events))
	}
	got := series(t, r)
	if got["stellar.anchor.transfer.duration{kind=deposit,status=completed,stellar.sep=24}"] != 1 {
		t.Fatalf("flow not reproduced over Kafka: %v", got)
	}

	// The anchor's own consumer group is unaffected: it still reads every record.
	own, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.ConsumerGroup("anchor-platform-event-processor"),
		kgo.ConsumeTopics("TRANSACTION"), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	for n < len(events) && ctx.Err() == nil {
		n += len(own.PollFetches(ctx).Records())
	}
	cancel()
	own.Close()
	if n != len(events) {
		t.Fatalf("anchor's own group read %d of %d records", n, len(events))
	}

	// Restart with the same group: committed records are not handled again.
	produce(lines(t, "testdata/malformed.jsonl"))
	var stats2 Stats
	p2, _ := newTestProcessor(t, ProcessorOptions{})
	runUntil(p2, &stats2, 4)
	if stats2.OK.Load() != 0 || stats2.Malformed.Load() != 3 || stats2.Ignored.Load() != 1 {
		t.Fatalf("after restart ok=%d malformed=%d ignored=%d, want 0/3/1",
			stats2.OK.Load(), stats2.Malformed.Load(), stats2.Ignored.Load())
	}
}

func TestKafkaConfigValidation(t *testing.T) {
	for _, tc := range []struct {
		c    KafkaConfig
		want string
	}{
		{KafkaConfig{Topic: "T", Group: "g"}, "no Kafka brokers"},
		{KafkaConfig{Brokers: []string{"b:9092"}, Group: "g"}, "topic and consumer group"},
		{KafkaConfig{Brokers: []string{"b:9092"}, Topic: "T", Group: "g", SecurityProtocol: "SSL"}, "unsupported security protocol"},
		{KafkaConfig{Brokers: []string{"b:9092"}, Topic: "T", Group: "g", SecurityProtocol: "SASL_SSL"}, "needs a SASL username"},
		{KafkaConfig{Brokers: []string{"b:9092"}, Topic: "T", Group: "g", SecurityProtocol: "SASL_SSL", Username: "u", CAFile: "/nonexistent"}, "read CA file"},
	} {
		_, err := kafkaOpts(tc.c)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%+v: err %v, want %q", tc.c, err, tc.want)
		}
	}
	if _, err := kafkaOpts(KafkaConfig{Brokers: []string{"b:9092"}, Topic: "T", Group: "g", SecurityProtocol: "sasl_plaintext", Username: "u", Password: "p"}); err != nil {
		t.Errorf("valid SASL_PLAINTEXT config rejected: %v", err)
	}
}

func TestLoadConfig(t *testing.T) {
	t.Setenv("AP_KAFKA_BROKERS", "k1:9092, k2:9092")
	t.Setenv("STELLAR_NETWORK", "mainnet")
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Kafka.Brokers) != 2 || c.Kafka.Topic != "TRANSACTION" || c.Kafka.Group != "usagemap-ap-listener" ||
		c.Kafka.StartAtEarliest || c.Network != "mainnet" || c.MaxClients != 50 {
		t.Fatalf("defaults: %+v", c)
	}
	t.Setenv("AP_KAFKA_START", "yesterday")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("bad AP_KAFKA_START accepted")
	}
	t.Setenv("AP_KAFKA_START", "earliest")
	t.Setenv("STELLAR_NETWORK", "pubnet")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("bad STELLAR_NETWORK accepted")
	}
}
