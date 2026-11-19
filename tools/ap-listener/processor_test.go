// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func newTestProcessor(t *testing.T, o ProcessorOptions) (*Processor, *sdkmetric.ManualReader) {
	t.Helper()
	r := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(r))
	p, err := NewProcessor(mp.Meter(scopeName), o)
	if err != nil {
		t.Fatal(err)
	}
	return p, r
}

func lines(t *testing.T, path string) [][]byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out [][]byte
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		out = append(out, append([]byte(nil), sc.Bytes()...))
	}
	return out
}

// series flattens collected metrics to "name{k=v,…}" → count (sum value or
// histogram count) and, for histograms, "name{…}#sum" → sum.
func series(t *testing.T, r *sdkmetric.ManualReader) map[string]float64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := r.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]float64{}
	key := func(name string, s attribute.Set) string {
		var kv []string
		for _, a := range s.ToSlice() {
			if a.Key == keyNetwork {
				continue
			}
			kv = append(kv, fmt.Sprintf("%s=%s", strings.TrimPrefix(string(a.Key), "stellar.anchor."), a.Value.Emit()))
		}
		sort.Strings(kv)
		return name + "{" + strings.Join(kv, ",") + "}"
	}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			switch d := m.Data.(type) {
			case metricdata.Sum[int64]:
				for _, p := range d.DataPoints {
					out[key(m.Name, p.Attributes)] += float64(p.Value)
				}
			case metricdata.Histogram[float64]:
				for _, p := range d.DataPoints {
					out[key(m.Name, p.Attributes)] += float64(p.Count)
					out[key(m.Name, p.Attributes)+"#sum"] += p.Sum
				}
			default:
				t.Fatalf("unexpected data type %T for %s", m.Data, m.Name)
			}
		}
	}
	return out
}

func TestRecordedFlow(t *testing.T) {
	p, r := newTestProcessor(t, ProcessorOptions{Network: "testnet"})
	for i, l := range lines(t, "testdata/events.jsonl") {
		if got := p.Handle(context.Background(), l); got != ResultOK {
			t.Fatalf("event %d: %s", i, got)
		}
	}
	want := map[string]float64{
		"stellar.anchor.transfer.created{client=wallet.example.com,kind=deposit,stellar.sep=24}": 1,
		"stellar.anchor.transfer.created{client=moneygram-like,kind=receive,stellar.sep=31}":     1,

		"stellar.anchor.transfer.transitions{kind=deposit,status=incomplete,status_from=_new,stellar.sep=24}":                                    1,
		"stellar.anchor.transfer.transitions{kind=deposit,status=pending_user_transfer_start,status_from=incomplete,stellar.sep=24}":             1,
		"stellar.anchor.transfer.transitions{kind=deposit,status=pending_anchor,status_from=pending_user_transfer_start,stellar.sep=24}":         1,
		"stellar.anchor.transfer.transitions{kind=deposit,status=completed,status_from=pending_anchor,stellar.sep=24}":                           1,
		"stellar.anchor.transfer.transitions{kind=receive,status=pending_sender,status_from=_new,stellar.sep=31}":                                1,
		"stellar.anchor.transfer.transitions{kind=receive,status=error,status_from=pending_sender,stellar.sep=31}":                               1,
		"stellar.anchor.transfer.transitions{kind=withdrawal-exchange,status=pending_user_transfer_complete,status_from=_unknown,stellar.sep=6}": 1,

		"stellar.anchor.transfer.status.duration{kind=deposit,status=incomplete,stellar.sep=24}":                      1,
		"stellar.anchor.transfer.status.duration{kind=deposit,status=incomplete,stellar.sep=24}#sum":                  120,
		"stellar.anchor.transfer.status.duration{kind=deposit,status=pending_user_transfer_start,stellar.sep=24}":     1,
		"stellar.anchor.transfer.status.duration{kind=deposit,status=pending_user_transfer_start,stellar.sep=24}#sum": 600,
		"stellar.anchor.transfer.status.duration{kind=deposit,status=pending_anchor,stellar.sep=24}":                  1,
		"stellar.anchor.transfer.status.duration{kind=deposit,status=pending_anchor,stellar.sep=24}#sum":              2880, // entered 10:12, not the 10:13 repeat
		"stellar.anchor.transfer.status.duration{kind=receive,status=pending_sender,stellar.sep=31}":                  1,
		"stellar.anchor.transfer.status.duration{kind=receive,status=pending_sender,stellar.sep=31}#sum":              1800,

		"stellar.anchor.transfer.duration{kind=deposit,status=completed,stellar.sep=24}":     1, // the redelivered terminal event is not counted twice
		"stellar.anchor.transfer.duration{kind=deposit,status=completed,stellar.sep=24}#sum": 3600,
		"stellar.anchor.transfer.duration{kind=receive,status=error,stellar.sep=31}":         1,
		"stellar.anchor.transfer.duration{kind=receive,status=error,stellar.sep=31}#sum":     1800,

		"stellar.anchor.customer.updates{client=wallet.example.com,status=ACCEPTED}": 1,
		"stellar.anchor.customer.updates{client=_none,status=NEEDS_INFO}":            1,
		"stellar.anchor.quotes.created{client=wallet.example.com}":                   1,
	}
	got := series(t, r)
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	for k, v := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("unexpected series %s = %v", k, v)
		}
	}
}

// Nothing from the drop list may reach an attribute, whatever the fixtures carry.
func TestDropListNeverExported(t *testing.T) {
	p, r := newTestProcessor(t, ProcessorOptions{Network: "mainnet"})
	for _, l := range lines(t, "testdata/events.jsonl") {
		p.Handle(context.Background(), l)
	}
	var rm metricdata.ResourceMetrics
	if err := r.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	allowedKeys := map[attribute.Key]bool{keySep: true, keyKind: true, keyStatus: true, keyStatusFrom: true, keyClient: true, keyNetwork: true}
	var dump strings.Builder
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			var sets []attribute.Set
			switch d := m.Data.(type) {
			case metricdata.Sum[int64]:
				for _, p := range d.DataPoints {
					sets = append(sets, p.Attributes)
				}
			case metricdata.Histogram[float64]:
				for _, p := range d.DataPoints {
					sets = append(sets, p.Attributes)
				}
			}
			for _, s := range sets {
				for _, a := range s.ToSlice() {
					if !allowedKeys[a.Key] {
						t.Errorf("%s carries non-allow-listed key %s", m.Name, a.Key)
					}
					fmt.Fprintf(&dump, "%s=%s\n", a.Key, a.Value.Emit())
				}
			}
		}
	}
	for _, bad := range []string{
		"GBXQ5QPEDCQFEWXRO3SPPV3Z", "GCQCXAGA4OE2QJQTKF7YAD5L", "MAAAAAAA", "3389e9f0", "AAAAAgAAAABi",
		"100.25", "99.75", "0.50", "1.005", "4471", "9001", "BANKREF", "Jane", "jane@", "DE8937", "203.0.113.7",
		"121122676", "cust-", "tx-24a", "tx-31a", "quote-7f3c", "SWIFT", "bank_account_number", "rf-1", "iso4217",
		"2026-11-", "e1", "e5",
	} {
		if strings.Contains(dump.String(), bad) {
			t.Errorf("exported attributes contain %q:\n%s", bad, dump.String())
		}
	}
}

func TestMalformedAndUnknown(t *testing.T) {
	p, r := newTestProcessor(t, ProcessorOptions{})
	var got []Result
	for _, l := range lines(t, "testdata/malformed.jsonl") {
		got = append(got, p.Handle(context.Background(), l))
	}
	got = append(got, p.Handle(context.Background(), nil), p.Handle(context.Background(), make([]byte, maxRecordBytes+1)))
	want := []Result{ResultMalformed, ResultMalformed, ResultMalformed, ResultIgnored, ResultMalformed, ResultMalformed}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("results %v, want %v", got, want)
	}
	if s := series(t, r); len(s) != 0 {
		t.Fatalf("malformed input produced metrics: %v", s)
	}
}

func TestClosedSetsAndBounds(t *testing.T) {
	p, r := newTestProcessor(t, ProcessorOptions{MaxClients: 2, MaxTxs: 2})
	ev := func(id, sep, kind, status, client string) []byte {
		return []byte(fmt.Sprintf(`{"type":"transaction_created","sep":%s,"transaction":{"id":%q,"sep":%s,"kind":%q,"status":%q,"client_domain":%q}}`,
			sep, id, sep, kind, status, client))
	}
	ctx := context.Background()
	p.Handle(ctx, ev("a", "24", "deposit", "incomplete", "one.org"))
	p.Handle(ctx, ev("b", `"24"`, "deposit", "incomplete", "two.org"))
	p.Handle(ctx, ev("c", "24", "deposit", "incomplete", "three.org"))                                                    // over the client cap
	p.Handle(ctx, ev("d", "99", "teleport", "pending_magic", "one.org"))                                                  // unknown sep/kind/status
	p.Handle(ctx, ev("e", "24", "deposit", "incomplete", "GBXQ5QPEDCQFEWXRO3SPPV3ZGXAKKSNK3AUSP3XQNQSUD7FOXD4UFMXJ.org")) // key-like label
	p.Handle(ctx, ev("f", "24", "deposit", "incomplete", "10.0.0.1"))
	got := series(t, r)
	for k, v := range map[string]float64{
		"stellar.anchor.transfer.created{client=one.org,kind=deposit,stellar.sep=24}":                        1,
		"stellar.anchor.transfer.created{client=two.org,kind=deposit,stellar.sep=24}":                        1,
		"stellar.anchor.transfer.created{client=_OTHER,kind=deposit,stellar.sep=24}":                         3,
		"stellar.anchor.transfer.created{client=one.org,kind=_OTHER,stellar.sep=_OTHER}":                     1,
		"stellar.anchor.transfer.transitions{kind=_OTHER,status=_OTHER,status_from=_new,stellar.sep=_OTHER}": 1,
	} {
		if got[k] != v {
			t.Errorf("%s = %v, want %v (all: %v)", k, got[k], v, got)
		}
	}
	if n := p.txs.len(); n != 2 {
		t.Errorf("tx memory holds %d, want the cap 2", n)
	}
}

func TestPublicDomain(t *testing.T) {
	for in, want := range map[string]string{
		"Wallet.Example.COM.": "wallet.example.com",
		"localhost":           "",
		"anchor.local":        "",
		"10.0.0.1":            "",
		"[::1]":               "",
		"a.b.c.org":           "a.b.c.org",
		"under_score.org":     "",
		"host.org:443":        "",
		"single":              "",
	} {
		if got := publicDomain(in); got != want {
			t.Errorf("publicDomain(%q) = %q, want %q", in, got, want)
		}
	}
	c := newClients(5)
	if got := c.of("", ""); got != none {
		t.Errorf("empty client = %q", got)
	}
	if got := c.of("", "Vibrant"); got != "vibrant" {
		t.Errorf("client name = %q", got)
	}
	if got := c.of("", "Jane Doe <jane@x.org>"); got != other {
		t.Errorf("free-text client name = %q", got)
	}
}
