// SPDX-License-Identifier: Apache-2.0

package forwarder

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
)

func TestOrderIsStableAndSpreads(t *testing.T) {
	cores := []snapshot.Core{{ID: "core-a"}, {ID: "core-b"}}
	first := map[string]int{}
	for i := 0; i < 1000; i++ {
		s := netip.MustParseAddr(fmt.Sprintf("2001:db8::%x", i+1))
		o := Order(cores, s)
		if Order([]snapshot.Core{cores[1], cores[0]}, s)[0].ID != o[0].ID {
			t.Fatal("order must not depend on configuration order")
		}
		first[o[0].ID]++
	}
	if first["core-a"] < 400 || first["core-b"] < 400 {
		t.Fatalf("rendezvous hashing does not spread: %v", first)
	}
}

type core struct {
	status atomic.Int32
	body   string
	hits   atomic.Int32
}

func (c *core) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.hits.Add(1)
	w.WriteHeader(int(c.status.Load()))
	_, _ = io.WriteString(w, c.body)
}

func run(t *testing.T, cores map[string]*core, recs int) (*spool.Spool, *counters.Agg) {
	t.Helper()
	sp, agg, _ := runM(t, cores, recs)
	return sp, agg
}

func runM(t *testing.T, cores map[string]*core, recs int) (*spool.Spool, *counters.Agg, *metrics.Registry) {
	t.Helper()
	sp, err := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	if err != nil {
		t.Fatal(err)
	}
	var cs []snapshot.Core
	for id, c := range cores {
		srv := httptest.NewServer(c)
		t.Cleanup(srv.Close)
		cs = append(cs, snapshot.Core{ID: id, URL: srv.URL})
	}
	w := "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"
	for i := 0; i < recs; i++ {
		_ = sp.Append(context.Background(), []spool.Record{&spool.EventRecord{ReceivedAtMs: time.Now().UnixMilli(), TenantID: "t", SiteID: "s", Target: "main",
			UmamiWebsiteID: &w, Tag: "v", Surrogate: fmt.Sprintf("2001:db8::%x", i+1), Country: "XX", UA: "ua", Hostname: "h", URL: "/", Kind: "pageview"}})
	}
	agg := counters.New()
	reg := metrics.New()
	f := &Forwarder{Spool: sp, Snap: snapshot.NewStore(t.TempDir()+"/s", nil), Cores: cs, Client: http.DefaultClient, Counters: agg, Metrics: reg,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Workers: 4, MaxBackoff: 50 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); f.Run(ctx) }()
	t.Cleanup(func() { cancel(); wg.Wait(); sp.Close() })
	return sp, agg, reg
}

func waitQueued(t *testing.T, sp *spool.Spool, want int64) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if sp.Stats().Queued == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("queued %d, want %d", sp.Stats().Queued, want)
}

func TestFailoverToTheOtherCore(t *testing.T) {
	a, b := &core{body: "{}"}, &core{body: "{}"}
	a.status.Store(503)
	b.status.Store(200)
	sp, _ := run(t, map[string]*core{"core-a": a, "core-b": b}, 20)
	waitQueued(t, sp, 0)
	if b.hits.Load() != 20 {
		t.Fatalf("core-b got %d", b.hits.Load())
	}
	if st := sp.Stats().Totals; st.AckedStored != 20 {
		t.Fatalf("totals %+v", st)
	}
}

func TestEngineAnswers(t *testing.T) {
	bot := &core{body: `{"beep":"boop"}`}
	bot.status.Store(200)
	sp, agg := run(t, map[string]*core{"core-a": bot}, 3)
	waitQueued(t, sp, 0)
	if sp.Stats().Totals.AckedEngineBot != 3 || agg.Get("t", "s", time.Now(), "drop", "engine_bot_drop") != 3 {
		t.Fatal("bot drops")
	}
	rej := &core{body: `bad`}
	rej.status.Store(400)
	sp2, agg2 := run(t, map[string]*core{"core-a": rej}, 2)
	waitQueued(t, sp2, 0)
	if sp2.Stats().Totals.AckedEngineRejected != 2 || agg2.Get("t", "s", time.Now(), "drop", "engine_rejected") != 2 {
		t.Fatal("engine_rejected")
	}
	// 403 (a configuration problem): kept, never acknowledged.
	forb := &core{}
	forb.status.Store(403)
	sp3, _ := run(t, map[string]*core{"core-a": forb}, 2)
	time.Sleep(300 * time.Millisecond)
	if sp3.Stats().Queued != 2 {
		t.Fatal("a 403 must not acknowledge records")
	}
}

func TestPayloadNeverCarriesForbiddenFields(t *testing.T) {
	w := "w"
	b, _ := Payload(&spool.EventRecord{UmamiWebsiteID: &w, Hostname: "h", URL: "/", Tag: "s", ReceivedAtMs: 1794460800123, Kind: "pageview", Name: "x",
		Data: map[string]any{"a": 1}, ReferrerHost: "r.test", Screen: "390x844", Language: "en"}, "w")
	want := `{"payload":{"hostname":"h","language":"en","referrer":"https://r.test/","screen":"390x844","tag":"s","timestamp":1794460800,"url":"/","website":"w"},"type":"event"}`
	if string(b) != want {
		t.Fatalf("payload %s", b)
	}
}

// flaky answers `first` for its first n requests, then 200.
type flaky struct {
	n, first int
	hits     atomic.Int32
}

func (f *flaky) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	if int(f.hits.Add(1)) <= f.n {
		w.WriteHeader(f.first)
		return
	}
	_, _ = io.WriteString(w, "{}")
}

// ADR-0020 / C-124: a record delivered after an attempt whose outcome is unknown (502 after the request was written)
// counts one ambiguous retry; a 503 (explicitly not processed) does not.
func TestAmbiguousRetries(t *testing.T) {
	for _, c := range []struct {
		status int
		want   float64
	}{{502, 1}, {504, 1}, {500, 1}, {503, 0}, {429, 0}} {
		sp, err := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
		if err != nil {
			t.Fatal(err)
		}
		fl := &flaky{n: 1, first: c.status}
		srv := httptest.NewServer(fl)
		w := "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"
		_ = sp.Append(context.Background(), []spool.Record{&spool.EventRecord{ReceivedAtMs: time.Now().UnixMilli(), TenantID: "t", SiteID: "s", Target: "main",
			UmamiWebsiteID: &w, Tag: "v", Surrogate: "2001:db8::1", Country: "XX", UA: "ua", Hostname: "h", URL: "/", Kind: "pageview"}})
		reg := metrics.New()
		f := &Forwarder{Spool: sp, Snap: snapshot.NewStore(t.TempDir()+"/s", nil), Cores: []snapshot.Core{{ID: "core-a", URL: srv.URL}}, Client: http.DefaultClient,
			Counters: counters.New(), Metrics: reg, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Workers: 1, MaxBackoff: 20 * time.Millisecond}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { f.Run(ctx); close(done) }()
		waitQueued(t, sp, 0)
		cancel()
		<-done
		srv.Close()
		sp.Close()
		if got := reg.Get("scf_gateway_forward_ambiguous_retries_total", "core", "core-a"); got != c.want {
			t.Errorf("status %d: ambiguous retries %v, want %v", c.status, got, c.want)
		}
	}
	if Ambiguous(false, errors.New("dial"), 0) || !Ambiguous(true, errors.New("reset"), 0) || Ambiguous(true, syscall.ECONNREFUSED, 0) {
		t.Fatal("Ambiguous transport cases")
	}
}

// slowSite answers 200 after a delay for records of one site (the test puts the site id into the URL path).
type slowCore struct {
	delay   time.Duration
	mu      sync.Mutex
	order   []string
	keys    []string
	running atomic.Int32
}

func (c *slowCore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	site := "flood"
	if strings.Contains(string(b), `"url":"/quiet"`) {
		site = "quiet"
	}
	c.mu.Lock()
	c.keys = append(c.keys, r.Header.Get("x-scf-event-key"))
	c.mu.Unlock()
	if site == "flood" {
		time.Sleep(c.delay)
	}
	c.mu.Lock()
	c.order = append(c.order, site)
	c.mu.Unlock()
	_, _ = io.WriteString(w, "{}")
}

// A backlog of one site does not hold back another site's records: the quiet site's record is
// delivered long before the flood's backlog is done. The event key travels as x-scf-event-key.
func TestSiteFairnessAndEventKey(t *testing.T) {
	sp, err := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	if err != nil {
		t.Fatal(err)
	}
	c := &slowCore{delay: 50 * time.Millisecond}
	srv := httptest.NewServer(c)
	t.Cleanup(srv.Close)
	w := "5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a41"
	rec := func(site, url string, i int) *spool.EventRecord {
		return &spool.EventRecord{ReceivedAtMs: time.Now().UnixMilli(), TenantID: "t", SiteID: site, Target: "main", UmamiWebsiteID: &w, Tag: "v",
			Surrogate: fmt.Sprintf("2001:db8::%x", i+1), Country: "XX", UA: "ua", Hostname: "h", URL: url, Kind: "pageview",
			EventKey: fmt.Sprintf("%032x", i+1)}
	}
	for i := 0; i < 80; i++ {
		_ = sp.Append(context.Background(), []spool.Record{rec("flood", "/flood", i)})
	}
	_ = sp.Append(context.Background(), []spool.Record{rec("quiet", "/quiet", 999)})
	f := &Forwarder{Spool: sp, Snap: snapshot.NewStore(t.TempDir()+"/s", nil), Cores: []snapshot.Core{{ID: "core-a", URL: srv.URL}},
		Client: http.DefaultClient, Counters: counters.New(), Metrics: metrics.New(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Workers: 4, MaxBackoff: 50 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); f.Run(ctx) }()
	t.Cleanup(func() { cancel(); wg.Wait(); sp.Close() })
	waitQueued(t, sp, 0)
	c.mu.Lock()
	defer c.mu.Unlock()
	pos := -1
	for i, s := range c.order {
		if s == "quiet" {
			pos = i
		}
	}
	// With 4 workers and the flood capped at 3, the quiet record goes in the first round.
	if pos < 0 || pos > 4 {
		t.Fatalf("quiet site delivered at position %d of %d", pos, len(c.order))
	}
	if len(c.keys) == 0 || len(c.keys[0]) != 32 {
		t.Fatalf("event key header %v", c.keys[:1])
	}
}
