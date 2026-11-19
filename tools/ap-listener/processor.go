// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"container/list"
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Metric names (proposed wire-formats §f.5 step 4c).
const (
	MetricCreated        = "stellar.anchor.transfer.created"
	MetricTransitions    = "stellar.anchor.transfer.transitions"
	MetricStatusDuration = "stellar.anchor.transfer.status.duration"
	MetricDuration       = "stellar.anchor.transfer.duration"
	MetricCustomers      = "stellar.anchor.customer.updates"
	MetricQuotes         = "stellar.anchor.quotes.created"

	keySep        = "stellar.sep"
	keyKind       = "stellar.anchor.kind"
	keyStatus     = "stellar.anchor.status"
	keyStatusFrom = "stellar.anchor.status_from"
	keyClient     = "stellar.anchor.client"
	keyNetwork    = "stellar.network"
)

// TransferBuckets are histogram bounds in seconds, from one second to a week:
// anchor transfers wait on people and banks.
var TransferBuckets = []float64{1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 43200, 86400, 172800, 604800}

const (
	maxRecordBytes = 1 << 20
	maxDuration    = 90 * 24 * time.Hour
)

// The ONLY parts of an Anchor Platform event the listener reads. Everything
// else in the JSON (amounts, fees, accounts, memos, external ids, Stellar
// transactions, customers' fields, creator, message, instructions, refunds,
// required_info_*, request_client_ip_address, quote prices …) has no field
// here, so the decoder skips it and it never exists in memory as a value.
type apEvent struct {
	Type         string         `json:"type"`
	Sep          json.Number    `json:"sep"`
	ClientName   string         `json:"clientName"`
	ClientDomain string         `json:"clientDomain"`
	Transaction  *apTransaction `json:"transaction"`
	Customer     *apCustomer    `json:"customer"`
	Quote        *struct{}      `json:"quote"` // presence only
}

type apTransaction struct {
	// ID is kept only in a bounded in-memory map (previous status and time,
	// to derive transitions); it is never an attribute and never logged.
	ID           string      `json:"id"`
	Sep          json.Number `json:"sep"`
	Kind         string      `json:"kind"`
	Status       string      `json:"status"`
	StartedAt    string      `json:"started_at"`
	UpdatedAt    string      `json:"updated_at"`
	CompletedAt  string      `json:"completed_at"`
	ClientDomain string      `json:"client_domain"`
	ClientName   string      `json:"client_name"`
}

type apCustomer struct {
	Status string `json:"status"` // the customer's KYC status only
}

// Result of handling one record.
type Result string

const (
	ResultOK        Result = "ok"
	ResultMalformed Result = "malformed"
	ResultIgnored   Result = "ignored"
)

type instruments struct {
	created, transitions, customers, quotes metric.Int64Counter
	statusDuration, duration                metric.Float64Histogram
}

func newInstruments(m metric.Meter) (*instruments, error) {
	var (
		in  instruments
		err error
	)
	if in.created, err = m.Int64Counter(MetricCreated, metric.WithUnit("{transaction}"),
		metric.WithDescription("Anchor Platform transactions created, by SEP, kind and client")); err != nil {
		return nil, err
	}
	if in.transitions, err = m.Int64Counter(MetricTransitions, metric.WithUnit("{transition}"),
		metric.WithDescription("Anchor Platform transaction status transitions, by SEP, kind, previous and new status")); err != nil {
		return nil, err
	}
	if in.customers, err = m.Int64Counter(MetricCustomers, metric.WithUnit("{update}"),
		metric.WithDescription("SEP-12 customer updates, by KYC status and client")); err != nil {
		return nil, err
	}
	if in.quotes, err = m.Int64Counter(MetricQuotes, metric.WithUnit("{quote}"),
		metric.WithDescription("SEP-38 firm quotes created, by client")); err != nil {
		return nil, err
	}
	if in.statusDuration, err = m.Float64Histogram(MetricStatusDuration, metric.WithUnit("s"),
		metric.WithDescription("Time a transaction spent in a status before the next transition"),
		metric.WithExplicitBucketBoundaries(TransferBuckets...)); err != nil {
		return nil, err
	}
	if in.duration, err = m.Float64Histogram(MetricDuration, metric.WithUnit("s"),
		metric.WithDescription("Start to final status of a transaction, by SEP, kind and final status"),
		metric.WithExplicitBucketBoundaries(TransferBuckets...)); err != nil {
		return nil, err
	}
	return &in, nil
}

type txState struct {
	status    string
	updatedAt time.Time
	final     bool
}

// txMemory is a bounded LRU of transaction id → last seen state.
type txMemory struct {
	mu  sync.Mutex
	cap int
	ll  *list.List
	m   map[string]*list.Element
}

type txEntry struct {
	id string
	st txState
}

func newTxMemory(capacity int) *txMemory {
	return &txMemory{cap: capacity, ll: list.New(), m: map[string]*list.Element{}}
}

func (t *txMemory) get(id string) (txState, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.m[id]; ok {
		return e.Value.(*txEntry).st, true
	}
	return txState{}, false
}

func (t *txMemory) put(id string, st txState) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.m[id]; ok {
		e.Value.(*txEntry).st = st
		t.ll.MoveToFront(e)
		return
	}
	t.m[id] = t.ll.PushFront(&txEntry{id: id, st: st})
	for t.ll.Len() > t.cap {
		last := t.ll.Back()
		t.ll.Remove(last)
		delete(t.m, last.Value.(*txEntry).id)
	}
}

func (t *txMemory) len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ll.Len()
}

// Processor turns Anchor Platform events into aggregate metrics.
type Processor struct {
	in      *instruments
	network attribute.KeyValue
	clients *clients
	txs     *txMemory
}

// ProcessorOptions configures a Processor.
type ProcessorOptions struct {
	Network    string // mainnet, testnet, futurenet, local; else unknown
	MaxClients int    // distinct client values reported by name (default 50)
	MaxTxs     int    // transactions remembered for transitions (default 100,000)
}

func NewProcessor(m metric.Meter, o ProcessorOptions) (*Processor, error) {
	in, err := newInstruments(m)
	if err != nil {
		return nil, err
	}
	if o.MaxClients <= 0 {
		o.MaxClients = 50
	}
	if o.MaxTxs <= 0 {
		o.MaxTxs = 100_000
	}
	return &Processor{
		in:      in,
		network: attribute.String(keyNetwork, networks.pick(o.Network, "unknown")),
		clients: newClients(o.MaxClients),
		txs:     newTxMemory(o.MaxTxs),
	}, nil
}

func numberString(n json.Number) string {
	s := strings.TrimSpace(string(n))
	if _, err := strconv.Atoi(s); err != nil {
		return ""
	}
	return s
}

func parseTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}

func span(from, to time.Time) (float64, bool) {
	d := to.Sub(from)
	if d < 0 || d > maxDuration {
		return 0, false
	}
	return d.Seconds(), true
}

// Handle processes one Kafka record value (an Anchor Platform AnchorEvent as
// JSON). It never returns an error: bad input is reported as a Result.
func (p *Processor) Handle(ctx context.Context, value []byte) Result {
	if len(value) == 0 || len(value) > maxRecordBytes {
		return ResultMalformed
	}
	var ev apEvent
	dec := json.NewDecoder(bytes.NewReader(value))
	dec.UseNumber()
	if err := dec.Decode(&ev); err != nil {
		return ResultMalformed
	}
	if !eventTypes.has(ev.Type) {
		return ResultIgnored
	}
	switch ev.Type {
	case "customer_updated":
		if ev.Customer == nil {
			return ResultMalformed
		}
		p.in.customers.Add(ctx, 1, metric.WithAttributes(
			attribute.String(keyStatus, customerStatuses.pick(ev.Customer.Status, other)),
			attribute.String(keyClient, p.clients.of(ev.ClientDomain, ev.ClientName)),
			p.network,
		))
		return ResultOK
	case "quote_created":
		if ev.Quote == nil {
			return ResultMalformed
		}
		p.in.quotes.Add(ctx, 1, metric.WithAttributes(
			attribute.String(keyClient, p.clients.of(ev.ClientDomain, ev.ClientName)),
			p.network,
		))
		return ResultOK
	}
	tx := ev.Transaction
	if tx == nil {
		return ResultMalformed
	}
	sep := numberString(tx.Sep)
	if sep == "" {
		sep = numberString(ev.Sep)
	}
	sep = txSeps.pick(sep, other)
	kind := kinds.pick(tx.Kind, other)
	status := statuses.pick(tx.Status, other)
	base := []attribute.KeyValue{attribute.String(keySep, sep), attribute.String(keyKind, kind), p.network}
	updated, hasUpdated := parseTime(tx.UpdatedAt)

	var prev txState
	known := false
	if tx.ID != "" && len(tx.ID) <= 256 {
		prev, known = p.txs.get(tx.ID)
	}

	from := fromUnk
	if ev.Type == "transaction_created" {
		from = fromNew
		domain, name := tx.ClientDomain, tx.ClientName
		if domain == "" && name == "" {
			domain, name = ev.ClientDomain, ev.ClientName
		}
		p.in.created.Add(ctx, 1, metric.WithAttributes(append(base,
			attribute.String(keyClient, p.clients.of(domain, name)))...))
	} else if known {
		from = prev.status
	}

	// A status_changed event that repeats the known status (e.g. a PATCH of
	// other fields) is not a transition.
	if !(known && from == status) {
		p.in.transitions.Add(ctx, 1, metric.WithAttributes(append(base,
			attribute.String(keyStatusFrom, from), attribute.String(keyStatus, status))...))
		if known && hasUpdated && !prev.updatedAt.IsZero() {
			if s, ok := span(prev.updatedAt, updated); ok {
				p.in.statusDuration.Record(ctx, s, metric.WithAttributes(append(base,
					attribute.String(keyStatus, prev.status))...))
			}
		}
	}

	final := known && prev.final
	if terminal.has(status) && !final {
		start, okStart := parseTime(tx.StartedAt)
		end, okEnd := parseTime(tx.CompletedAt)
		if !okEnd {
			end, okEnd = updated, hasUpdated
		}
		if okStart && okEnd {
			if s, ok := span(start, end); ok {
				p.in.duration.Record(ctx, s, metric.WithAttributes(append(base,
					attribute.String(keyStatus, status))...))
			}
		}
		final = true
	}

	if tx.ID != "" && len(tx.ID) <= 256 {
		// updatedAt is when the transaction ENTERED its current status: a
		// repeat of the same status keeps the earlier time.
		st := txState{status: status, final: final}
		switch {
		case known && from == status:
			st.updatedAt = prev.updatedAt
		case hasUpdated:
			st.updatedAt = updated
		}
		p.txs.put(tx.ID, st)
	}
	return ResultOK
}
