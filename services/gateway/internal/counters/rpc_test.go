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

// The optional `rpc` part (browser Stellar RPC/Horizon aggregate, wire-formats §a.3.2) follows the props/dev upgrade
// rule (C-137): sent only when advertised, omitted when empty, dropped in memory when not advertised.

func flushRPC(t *testing.T, a *Agg, rpc bool) map[string]json.RawMessage {
	t.Helper()
	sp, err := spool.Open(spool.Options{Dir: t.TempDir(), Node: "edge-a1"})
	if err != nil {
		t.Fatal(err)
	}
	defer sp.Close()
	now := time.Date(2026, 11, 19, 10, 1, 0, 0, time.UTC)
	f := &Flusher{Agg: a, Spool: sp, Node: "edge-a1", BootID: "b", Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: func() time.Time { return now }, RPCFeature: func() bool { return rpc }}
	if err := f.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	p := sp.PendingAfter(spool.Start, 10)
	b, _ := sp.Read(p[0].Pos)
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	return raw
}

func rpcFilled() *Agg {
	a := New()
	at := time.Date(2026, 11, 19, 10, 0, 30, 0, time.UTC)
	k := RPCKey{Tenant: "t1", Site: "s1", API: "rpc", Operation: "get_latest_ledger", Network: "mainnet", Outcome: "ok", Latency: "lt100ms", Verdict: "verified"}
	a.AddRPC(k, at, 3)
	a.AddRPC(k, at, 2)
	k.API, k.Operation = "horizon", "accounts_id"
	a.AddRPC(k, at, 1)
	k.Operation = "Bad Label"
	a.AddRPC(k, at, 1) // ignored
	a.AddRPC(k, at, 0) // ignored
	return a
}

func TestRPCPartOnlyWhenAdvertised(t *testing.T) {
	if _, ok := flushRPC(t, rpcFilled(), false)["rpc"]; ok {
		t.Fatal("rpc sent while not advertised")
	}
	raw := flushRPC(t, rpcFilled(), true)
	var rows []spool.RPCCounter
	if err := json.Unmarshal(raw["rpc"], &rows); err != nil || len(rows) != 2 {
		t.Fatalf("rpc rows: %s", raw["rpc"])
	}
	if rows[0].API != "horizon" || rows[0].Count != 1 || rows[1].Operation != "get_latest_ledger" || rows[1].Count != 5 ||
		rows[1].Day != "2026-11-19" || rows[1].Verdict != "verified" {
		t.Fatalf("rpc rows sorted and summed: %+v", rows)
	}
	if _, ok := flushRPC(t, New(), true)["rpc"]; ok {
		t.Fatal("empty rpc part must be omitted")
	}
}

func TestRPCNotAdvertisedIsDroppedNotCarried(t *testing.T) {
	a := rpcFilled()
	flushRPC(t, a, false)
	if _, ok := flushRPC(t, a, true)["rpc"]; ok {
		t.Fatal("cells of a period without the feature must not be carried into a later record")
	}
}
