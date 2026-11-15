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

// The optional `app` part (self-attested app events, wire-formats §a.9) follows the props/dev upgrade rule (C-137):
// sent only when advertised, omitted when empty, dropped in memory when not advertised.

func flushApp(t *testing.T, a *Agg, app bool) map[string]json.RawMessage {
	t.Helper()
	sp, err := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	if err != nil {
		t.Fatal(err)
	}
	defer sp.Close()
	now := time.Date(2026, 11, 19, 10, 1, 0, 0, time.UTC)
	f := &Flusher{Agg: a, Spool: sp, Node: "edge-a1", BootID: "b", Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: func() time.Time { return now }, AppFeature: func() bool { return app }}
	if err := f.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	p := sp.PendingAfter(spool.Start, 10)
	b, _ := sp.Read(p[0].Pos)
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	return raw
}

func appFilled() *Agg {
	a := New()
	k := AppKey{Tenant: "t1", Site: "s1", Day: "2026-11-19", Platform: "ios", Event: "swap_started", Key: "_total", Value: "all"}
	a.AddApp(k, 3)
	a.AddApp(k, 2)
	k.Key, k.Value = "tier", "pro"
	a.AddApp(k, 1)
	a.AddApp(AppKey{Tenant: "t1", Site: "s1", Platform: "ios", Event: "x", Key: "_total", Value: "all"}, 1) // no day: ignored
	a.AddApp(k, 0)                                                                                          // ignored
	return a
}

func TestAppPartOnlyWhenAdvertised(t *testing.T) {
	if _, ok := flushApp(t, appFilled(), false)["app"]; ok {
		t.Fatal("app sent while not advertised")
	}
	raw := flushApp(t, appFilled(), true)
	var rows []spool.AppCounter
	if err := json.Unmarshal(raw["app"], &rows); err != nil || len(rows) != 2 {
		t.Fatalf("app rows: %s", raw["app"])
	}
	if rows[0].Key != "_total" || rows[0].Count != 5 || rows[1].Key != "tier" || rows[1].Value != "pro" || rows[1].Platform != "ios" {
		t.Fatalf("app rows sorted and summed: %+v", rows)
	}
	if _, ok := flushApp(t, New(), true)["app"]; ok {
		t.Fatal("empty app part must be omitted")
	}
}

func TestAppNotAdvertisedIsDroppedNotCarried(t *testing.T) {
	a := appFilled()
	flushApp(t, a, false)
	if a.GetApp(AppKey{Tenant: "t1", Site: "s1", Day: "2026-11-19", Platform: "ios", Event: "swap_started", Key: "_total", Value: "all"}) != 0 {
		t.Fatal("app cells not advertised are dropped in memory")
	}
}
