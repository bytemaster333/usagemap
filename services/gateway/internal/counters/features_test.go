// SPDX-License-Identifier: Apache-2.0

package counters

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
)

// Optional counter-record parts behind settings.counter_features (wire-formats §d.3 upgrade rule, C-137).

func flushOnce(t *testing.T, a *Agg, props, dev bool) (spool.CounterRecord, map[string]json.RawMessage) {
	t.Helper()
	sp, err := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	if err != nil {
		t.Fatal(err)
	}
	defer sp.Close()
	now := time.Date(2026, 11, 16, 10, 1, 0, 0, time.UTC)
	f := &Flusher{Agg: a, Spool: sp, Node: "edge-a1", BootID: "b", Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return now },
		Features: func() (bool, bool) { return props, dev }}
	if err := f.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	p := sp.PendingAfter(spool.Start, 10)
	b, _ := sp.Read(p[0].Pos)
	var rec spool.CounterRecord
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &rec)
	_ = json.Unmarshal(b, &raw)
	return rec, raw
}

func filled() *Agg {
	a := New()
	now := time.Date(2026, 11, 16, 10, 0, 30, 0, time.UTC)
	a.Add("t1", "s1", now, "verdict", "verified", 1)
	k := PropKey{Tenant: "t1", Site: "s1", Event: "wallet_connect", Network: "testnet", Key: "_total", Value: "all", Verdict: "verified"}
	a.AddProp(k, now, 2)
	k.Key, k.Value = "wallet", "freighter"
	a.AddProp(k, now, 2)
	k.Value = "Not A Label"
	a.AddProp(k, now, 1) // ignored
	for i := 0; i < 25; i++ {
		a.AddDev(spool.DevEvent{TenantID: "t1", SiteID: "s1", ReceivedAtMs: int64(i), Kind: "pageview", Name: "pageview", Path: "/", WouldBe: "verified"})
	}
	return a
}

func TestPartsOnlyWhenAdvertised(t *testing.T) {
	rec, raw := flushOnce(t, filled(), false, false)
	if _, ok := raw["props"]; ok {
		t.Fatal("props sent while not advertised")
	}
	if _, ok := raw["dev"]; ok {
		t.Fatal("dev sent while not advertised")
	}
	if len(rec.Web) != 1 {
		t.Fatal("web counters must be unaffected")
	}
	rec, _ = flushOnce(t, filled(), true, false)
	if len(rec.Props) != 2 || rec.Dev != nil || rec.Props[0].Day != "2026-11-16" || rec.Props[0].Count != 2 {
		t.Fatalf("props only: %+v", rec)
	}
	rec, _ = flushOnce(t, filled(), true, true)
	if len(rec.Dev) != MaxDevPerSite || rec.Dev[0].ReceivedAtMs != 5 || rec.Dev[19].ReceivedAtMs != 24 {
		t.Fatalf("dev capped to the newest %d per site: %d", MaxDevPerSite, len(rec.Dev))
	}
	// Advertised but empty: omitted.
	_, raw = flushOnce(t, New(), true, true)
	if _, ok := raw["props"]; ok {
		t.Fatal("empty props must be omitted")
	}
	if _, ok := raw["dev"]; ok {
		t.Fatal("empty dev must be omitted")
	}
}

func TestNotAdvertisedPartsAreDroppedNotCarried(t *testing.T) {
	a := filled()
	flushOnce(t, a, false, false)
	if a.PropRows("s1") != 0 || len(a.Dev("s1")) != 0 {
		t.Fatal("parts not advertised are dropped in memory, not carried into a later record")
	}
}
