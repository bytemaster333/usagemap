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

func TestFlushWritesCounterRecordWithAccounting(t *testing.T) {
	sp, err := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	if err != nil {
		t.Fatal(err)
	}
	defer sp.Close()
	now := time.Date(2026, 11, 12, 10, 1, 0, 0, time.UTC)
	w := "w"
	_ = sp.Append(context.Background(), []spool.Record{&spool.EventRecord{ReceivedAtMs: now.UnixMilli(), UmamiWebsiteID: &w, Target: "main", Tag: "v", Kind: "pageview", URL: "/"}})
	a := New()
	a.Add("t1", "s1", now, "verdict", "verified", 3)
	a.Add("t1", "s1", now, "reason", "Bad-Label", 1) // ignored: not a closed-list label
	f := &Flusher{Agg: a, Spool: sp, Node: "edge-a1", BootID: "0193b7e2-4c1a-7d3e-9a10-2b4f6c8d0e14", Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return now }}
	if err := f.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	p := sp.PendingAfter(spool.Start, 10)
	b, _ := sp.Read(p[1].Pos)
	var rec spool.CounterRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Type != "counter" || rec.NodeID != "edge-a1" || len(rec.Web) != 1 || rec.Web[0].Count != 3 || rec.Web[0].Day != "2026-11-12" {
		t.Fatalf("record %+v", rec)
	}
	s := rec.Spool
	if s.Fsynced != 1 || s.Queued != 1 || s.QueuedAtDayStart == nil || *s.QueuedAtDayStart != 0 || s.Day != "2026-11-12" {
		t.Fatalf("accounting %+v", s)
	}
	if rec.OTLP == nil || rec.Tokens == nil {
		t.Fatal("otlp and tokens must be arrays, not null")
	}
	// Second record of the same day: no queued_at_day_start, empty deltas.
	_ = f.Flush(context.Background())
	p = sp.PendingAfter(spool.Start, 10)
	b, _ = sp.Read(p[2].Pos)
	var rec2 spool.CounterRecord
	_ = json.Unmarshal(b, &rec2)
	if rec2.Spool.QueuedAtDayStart != nil || rec2.Spool.Fsynced != 0 || rec2.Spool.Queued != 1 || len(rec2.Web) != 0 {
		t.Fatalf("second record %+v", rec2.Spool)
	}
	if a.Get("t1", "s1", now, "verdict", "verified") != 0 {
		t.Fatal("aggregate not reset")
	}
}

func TestFlushRestoresOnFailure(t *testing.T) {
	sp, _ := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	now := time.Now()
	a := New()
	a.Add("t1", "s1", now, "drop", "gpc_dnt", 2)
	f := &Flusher{Agg: a, Spool: sp, Node: "edge-a1", BootID: "b", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	sp.Close()
	if err := f.Flush(context.Background()); err == nil {
		t.Fatal("expected failure on a closed spool")
	}
	if a.Get("t1", "s1", now, "drop", "gpc_dnt") != 2 {
		t.Fatal("counters lost after a failed flush")
	}
}
