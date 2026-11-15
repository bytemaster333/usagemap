// SPDX-License-Identifier: Apache-2.0

package forwarder

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
)

// Counter-record delivery with the optional C-136 parts (wire-formats §d.3 upgrade rule, §l; C-137).

// controlPlane is a fake internal counter endpoint. strict: a pre-C-136 control plane with a closed schema that
// answers 422 to any record carrying `props` or `dev`. It applies each (node, record_id) once, like
// edge_report_ledger, and can lose the acknowledgement of the first delivery (answers 500 after applying).
type controlPlane struct {
	mu        sync.Mutex
	strict    bool
	loseFirst bool
	bodies    [][]byte
	applied   map[string]bool
	verified  int64
	props     map[string]int64 // event/key/value → count (web_event_property_daily)
}

func (c *controlPlane) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bodies = append(c.bodies, b)
	var raw map[string]json.RawMessage
	if json.Unmarshal(b, &raw) != nil {
		http.Error(w, "bad", 400)
		return
	}
	if _, p := raw["props"]; c.strict && p {
		http.Error(w, `{"error":"unknown property props"}`, 422)
		return
	}
	if _, d := raw["dev"]; c.strict && d {
		http.Error(w, `{"error":"unknown property dev"}`, 422)
		return
	}
	var rec spool.CounterRecord
	_ = json.Unmarshal(b, &rec)
	if !c.applied[rec.NodeID+"|"+rec.RecordID] {
		c.applied[rec.NodeID+"|"+rec.RecordID] = true
		for _, x := range rec.Web {
			if x.Counter == "verdict" && x.Label == "verified" {
				c.verified += x.Count
			}
		}
		for _, p := range rec.Props {
			c.props[p.Event+"/"+p.Key+"/"+p.Value] += p.Count
		}
	}
	if c.loseFirst {
		c.loseFirst = false
		w.WriteHeader(500) // applied, acknowledgement lost
		return
	}
	w.WriteHeader(200)
}

func counterRecord() *spool.CounterRecord {
	return &spool.CounterRecord{RecordID: "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e13", PeriodStartMs: time.Now().Add(-time.Minute).UnixMilli(), PeriodEndMs: time.Now().UnixMilli(),
		Web:   []spool.WebCounter{{TenantID: "t", SiteID: "s", Day: "2026-11-16", Counter: "verdict", Label: "verified", Count: 7}},
		Spool: spool.Accounting{BootID: "b", Day: "2026-11-16", Fsynced: 7, Queued: 0},
		Props: []spool.PropCounter{{TenantID: "t", SiteID: "s", Day: "2026-11-16", Event: "wallet_connect", Network: "testnet", Key: "_total", Value: "all", Verdict: "verified", Count: 3}},
		Dev:   []spool.DevEvent{{TenantID: "t", SiteID: "s", ReceivedAtMs: 1, Kind: "pageview", Name: "pageview", Path: "/", WouldBe: "verified"}}}
}

func deliver(t *testing.T, cp *controlPlane, rec *spool.CounterRecord) (*spool.Spool, *metrics.Registry) {
	t.Helper()
	cp.applied, cp.props = map[string]bool{}, map[string]int64{}
	srv := httptest.NewServer(cp)
	t.Cleanup(srv.Close)
	sp, err := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := sp.Append(context.Background(), []spool.Record{rec}); err != nil {
		t.Fatal(err)
	}
	reg := metrics.New()
	f := &Forwarder{Spool: sp, Snap: snapshot.NewStore(t.TempDir()+"/s", nil), Cores: []snapshot.Core{{ID: "core-a", URL: srv.URL}}, Client: http.DefaultClient,
		Counters: counters.New(), Metrics: reg, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Workers: 1, MaxBackoff: 20 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); f.Run(ctx) }()
	t.Cleanup(func() { cancel(); wg.Wait(); sp.Close() })
	for i := 0; i < 300; i++ {
		if len(sp.PendingAfter(spool.Start, 10)) == 0 {
			return sp, reg
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("counter record never acknowledged")
	return nil, nil
}

// (e) the upgrade case: a new gateway against a control plane that does not know `props`/`dev` (422) — the record is
// re-sent once without them, with the same record_id, and its web counters and accounting are delivered.
func TestOldControlPlaneGetsTheRecordWithoutOptionalParts(t *testing.T) {
	cp := &controlPlane{strict: true}
	deliver(t, cp, counterRecord())
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if len(cp.bodies) != 2 {
		t.Fatalf("attempts %d, want 2 (full, then stripped)", len(cp.bodies))
	}
	var first, second map[string]json.RawMessage
	_ = json.Unmarshal(cp.bodies[0], &first)
	_ = json.Unmarshal(cp.bodies[1], &second)
	if _, ok := first["props"]; !ok {
		t.Fatal("first attempt carries the advertised parts")
	}
	if _, ok := second["props"]; ok {
		t.Fatal("retry must drop props")
	}
	if _, ok := second["dev"]; ok {
		t.Fatal("retry must drop dev")
	}
	if string(first["record_id"]) != string(second["record_id"]) || string(first["web"]) != string(second["web"]) || string(first["spool"]) != string(second["spool"]) {
		t.Fatal("the retry must be the same record (record_id, web, spool) minus the optional parts")
	}
	if cp.verified != 7 {
		t.Fatalf("verified counters delivered: %d", cp.verified)
	}
}

// A control plane that refuses the record for another reason: one stripped retry, then the discard rule (no loop).
func TestRejectedTwiceIsDiscardedAfterOneRetry(t *testing.T) {
	cp := &controlPlane{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		cp.mu.Lock()
		cp.bodies = append(cp.bodies, b)
		cp.mu.Unlock()
		http.Error(w, "no", 422)
	}))
	t.Cleanup(srv.Close)
	sp, _ := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	_ = sp.Append(context.Background(), []spool.Record{counterRecord()})
	f := &Forwarder{Spool: sp, Snap: snapshot.NewStore(t.TempDir()+"/s", nil), Cores: []snapshot.Core{{ID: "core-a", URL: srv.URL}}, Client: http.DefaultClient,
		Counters: counters.New(), Metrics: metrics.New(), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Workers: 1, MaxBackoff: 20 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.Run(ctx); close(done) }()
	for i := 0; i < 300 && len(sp.PendingAfter(spool.Start, 10)) > 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	sp.Close()
	if len(cp.bodies) != 2 {
		t.Fatalf("attempts %d, want 2", len(cp.bodies))
	}
}

// (f) redelivering a counter record (acknowledgement lost after it was applied) re-sends the identical record — same
// record_id and the same props — so the control plane's per-part idempotency (§l) leaves the property totals unchanged.
func TestRedeliveryIsIdempotentForProps(t *testing.T) {
	cp := &controlPlane{loseFirst: true}
	deliver(t, cp, counterRecord())
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if len(cp.bodies) != 2 || string(cp.bodies[0]) != string(cp.bodies[1]) {
		t.Fatalf("redelivery must resend the identical record: %d attempts", len(cp.bodies))
	}
	if cp.props["wallet_connect/_total/all"] != 3 || cp.verified != 7 {
		t.Fatalf("totals after redelivery: props %v verified %d", cp.props, cp.verified)
	}
}

func TestStripOptional(t *testing.T) {
	b, _ := json.Marshal(counterRecord())
	lean, p, d, ok := StripOptional(b)
	if !ok || p != 1 || d != 1 {
		t.Fatalf("strip: %v %d %d", ok, p, d)
	}
	var rec spool.CounterRecord
	if json.Unmarshal(lean, &rec) != nil || rec.Props != nil || rec.Dev != nil || rec.RecordID != counterRecord().RecordID || len(rec.Web) != 1 {
		t.Fatalf("lean record %s", lean)
	}
	if _, _, _, ok := StripOptional(lean); ok {
		t.Fatal("nothing left to strip")
	}
}

func TestStripOptionalApp(t *testing.T) {
	rec := counterRecord()
	rec.Props, rec.Dev = nil, nil
	rec.App = []spool.AppCounter{{TenantID: "t", SiteID: "s", Day: "2026-11-19", Platform: "ios", Event: "_session", Key: "_total", Value: "all", Count: 1}}
	b, _ := json.Marshal(rec)
	lean, p, d, ok := StripOptional(b)
	if !ok || p != 0 || d != 0 {
		t.Fatalf("strip app: %v %d %d", ok, p, d)
	}
	var out spool.CounterRecord
	if json.Unmarshal(lean, &out) != nil || out.App != nil || out.RecordID != rec.RecordID {
		t.Fatalf("lean record %s", lean)
	}
}
