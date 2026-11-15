// SPDX-License-Identifier: Apache-2.0

package integration

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

// Stellar client metrics (C-153, wire-formats §g.7, migration 0080): stored in scf.stellar_client_* only.

var stellarBounds = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30}

const stellarScope = "@usagemap/stellar-otel"

func stellarRPC(rm pmetric.ResourceMetrics, start, ts time.Time, method, errType string, counts []uint64, sum float64) {
	a := map[string]any{"rpc.system.name": "jsonrpc", "rpc.method": method, "stellar.network": "testnet"}
	if errType != "" {
		a["error.type"] = errType
	}
	explicit(rm, stellarScope, rules.MetricStellarRPC, true, start, ts, stellarBounds, counts, sum, a)
}

func stellarCounter(rm pmetric.ResourceMetrics, name string, start, ts time.Time, v int64, attrs map[string]any) {
	m := metric(rm, stellarScope, name)
	m.SetUnit("{call}")
	s := m.SetEmptySum()
	s.SetIsMonotonic(true)
	s.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	dp := s.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	dp.SetIntValue(v)
	a := map[string]any{"stellar.network": "testnet"}
	for k, x := range attrs {
		a[k] = x
	}
	_ = dp.Attributes().FromRaw(a)
}

type stellarTotal struct {
	count int64
	sum   float64
	hist  []int64
}

func stellarRead(t testing.TB, table, tenant, where string, args ...any) stellarTotal {
	t.Helper()
	q := `SELECT COALESCE(sum(count), 0)::bigint, COALESCE(sum(duration_sum), 0), COALESCE(scf.hist_sum(hist), '{}')
	        FROM scf.` + table + ` WHERE tenant_id = $1`
	if where != "" {
		q += " AND " + where
	}
	var r stellarTotal
	if err := superConn(t).QueryRow(context.Background(), q, append([]any{tenant}, args...)...).Scan(&r.count, &r.sum, &r.hist); err != nil {
		t.Fatal(err)
	}
	return r
}

// Two cumulative exports of a fresh backend process: the first is counted in full (C-122: started seconds before),
// the second adds its delta; every resolution holds the second export's cumulative value; the package's bounds
// nest into explicit15 exactly; a duplicate batch changes nothing; the API tables and API stream state stay empty;
// an unknown backend service is registered like any histogram source.
func TestStellarClientCumulativeStreams(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC().Truncate(time.Second)
	start := now.Add(-90 * time.Second)
	export := func(ts time.Time, k uint64) pmetric.Metrics {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "dapp-backend", recv: ts})
		stellarRPC(rm, start, ts, "sendTransaction", "", []uint64{0, 0, 1 * k, 2 * k, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.1*float64(k))
		stellarRPC(rm, start, ts, "getLatestLedger", "-32603", []uint64{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 * k, 0}, 12*float64(k))
		stellarCounter(rm, rules.MetricStellarSubmissions, start, ts, int64(3*k), map[string]any{
			"stellar.tx.via": "rpc", "stellar.tx.status": "ERROR", "stellar.tx.result_class": "bad_seq"})
		stellarCounter(rm, rules.MetricStellarSimulations, start, ts, int64(5*k), map[string]any{"stellar.sim.outcome": "success"})
		return md
	}
	r1 := apply(t, st, export(now.Add(-60*time.Second), 1), now)
	if r1[0].Applied != 4 {
		t.Fatalf("first export: %+v", r1)
	}
	second := export(now.Add(-time.Second), 2)
	if r := apply(t, st, second, now); r[0].Applied != 4 {
		t.Fatalf("second export: %+v", r)
	}
	for _, tb := range []string{"stellar_client_1m", "stellar_client_1h", "stellar_client_1d"} {
		send := stellarRead(t, tb, tenant, "metric = $2 AND operation = 'sendTransaction' AND outcome = ''", rules.MetricStellarRPC)
		if send.count != 6 || math.Abs(send.sum-0.2) > 1e-9 {
			t.Errorf("%s sendTransaction: %+v", tb, send)
		}
		// 0.01–0.025 → explicit15 bucket 3; 0.025–0.05 → bucket 4
		if len(send.hist) != 15 || send.hist[2] != 2 || send.hist[3] != 4 {
			t.Errorf("%s sendTransaction histogram %v", tb, send.hist)
		}
		ll := stellarRead(t, tb, tenant, "operation = 'getLatestLedger' AND outcome = '-32603'")
		if ll.count != 2 || len(ll.hist) != 15 || ll.hist[14] != 2 { // (10, 30] nests into the open last bucket
			t.Errorf("%s getLatestLedger: %+v", tb, ll)
		}
		sub := stellarRead(t, tb, tenant, "metric = $2 AND operation = 'rpc' AND variant = 'ERROR' AND outcome = 'bad_seq'",
			rules.MetricStellarSubmissions)
		if sub.count != 6 || len(sub.hist) != 0 {
			t.Errorf("%s submissions: %+v", tb, sub)
		}
		sim := stellarRead(t, tb, tenant, "metric = $2 AND variant = 'success'", rules.MetricStellarSimulations)
		if sim.count != 10 {
			t.Errorf("%s simulations: %+v", tb, sim)
		}
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.stellar_client_1m WHERE tenant_id = $1 AND hist_quality <> 0`, tenant); n != 0 {
		t.Errorf("%d rows not exact", n)
	}
	if n := rowCount(t, `SELECT (SELECT count(*) FROM scf.api_metrics_1m WHERE tenant_id = $1) + (SELECT count(*) FROM scf.api_stream_state WHERE tenant_id = $1)
	    + (SELECT count(*) FROM scf.api_routes WHERE tenant_id = $1)`, tenant); n != 0 {
		t.Errorf("Stellar client metrics reached the API tables: %d rows", n)
	}
	_ = serviceID(t, tenant, "dapp-backend")
	if n := rowCount(t, `SELECT count(*) FROM scf.audit_log WHERE tenant_id = $1 AND action = 'service.auto_registered'`, tenant); n != 1 {
		t.Errorf("auto-registration audit rows %d", n)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.stellar_client_stream_state WHERE tenant_id = $1`, tenant); n != 4 {
		t.Errorf("stream state rows %d", n)
	}
	before := stellarDump(t, tenant)
	if r := apply(t, st, second, now); !r[0].Duplicate {
		t.Fatalf("duplicate not recognised: %+v", r)
	}
	if after := stellarDump(t, tenant); after != before {
		t.Fatalf("a duplicate batch changed rows:\n%s\n---\n%s", before, after)
	}
	// A new series on the running service later counts in full (C-122: the source already delivers).
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: tenant, service: "dapp-backend", recv: now})
	stellarCounter(rm, rules.MetricStellarPolls, now.Add(-2*time.Hour), now, 7, map[string]any{"stellar.tx.status": "NOT_FOUND"})
	apply(t, st, md, now)
	if p := stellarRead(t, "stellar_client_1d", tenant, "metric = $2", rules.MetricStellarPolls); p.count != 7 {
		t.Errorf("new series of a known source: %+v", p)
	}
	if n := counter(t, tenant, rules.ReasonCumulativeFirstPoint); n != 0 {
		t.Errorf("cumulative_first_point = %d", n)
	}
}

func stellarDump(t testing.TB, tenant string) string {
	t.Helper()
	var s string
	if err := superConn(t).QueryRow(context.Background(), `
SELECT COALESCE(string_agg(x, E'\n' ORDER BY x), '') FROM (
  SELECT '1m ' || row_to_json(t)::text AS x FROM scf.stellar_client_1m t WHERE tenant_id = $1
  UNION ALL SELECT '1h ' || row_to_json(t)::text FROM scf.stellar_client_1h t WHERE tenant_id = $1
  UNION ALL SELECT '1d ' || row_to_json(t)::text FROM scf.stellar_client_1d t WHERE tenant_id = $1
  UNION ALL SELECT 'st ' || encode(stream_key, 'hex') || last_count || last_time_unix_ns FROM scf.stellar_client_stream_state t WHERE tenant_id = $1) q`,
		tenant).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

// The caps: new series of a UTC day beyond stellar_client_series_cap_per_tenant_day and new streams beyond
// stellar_client_stream_cap_per_tenant are dropped (stellar_series_overflow), first come first served in key order;
// series already stored keep growing.
func TestStellarClientCaps(t *testing.T) {
	st := newStore(t, store.Options{SettingsTTL: time.Nanosecond})
	now := time.Now().UTC().Truncate(time.Second)
	t.Run("series per day", func(t *testing.T) {
		setSetting(t, "stellar_client_series_cap_per_tenant_day", 2)
		tenant := newTenant(t)
		send := func(ts time.Time, methods ...string) {
			md := pmetric.NewMetrics()
			rm := resource(md, rsrc{tenant: tenant, service: "capped", recv: ts})
			for _, m := range methods {
				a := map[string]any{"rpc.system.name": "jsonrpc", "rpc.method": m, "stellar.network": "mainnet"}
				explicit(rm, stellarScope, rules.MetricStellarRPC, false, ts.Add(-time.Minute), ts, stellarBounds,
					[]uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001, a)
			}
			apply(t, st, md, now)
		}
		send(now.Add(-2*time.Minute), "getEvents", "getHealth", "getNetwork")
		send(now.Add(-time.Minute), "getHealth", "getLedgers")
		if n := counter(t, tenant, rules.ReasonStellarSeriesOverflow); n != 2 {
			t.Errorf("stellar_series_overflow = %d, want 2", n)
		}
		got := map[string]int64{}
		rows, err := superConn(t).Query(context.Background(), `SELECT operation, count FROM scf.stellar_client_1d WHERE tenant_id = $1`, tenant)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var op string
			var n int64
			_ = rows.Scan(&op, &n)
			got[op] = n
		}
		rows.Close()
		if fmt.Sprint(got) != "map[getEvents:1 getHealth:2]" {
			t.Errorf("stored series %v", got)
		}
	})
	t.Run("streams per tenant", func(t *testing.T) {
		setSetting(t, "stellar_client_stream_cap_per_tenant", 1)
		tenant := newTenant(t)
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "capped", recv: now})
		for _, s := range []string{"SUCCESS", "FAILED"} {
			stellarCounter(rm, rules.MetricStellarPolls, now.Add(-time.Minute), now, 1, map[string]any{"stellar.tx.status": s})
		}
		apply(t, st, md, now)
		if n := counter(t, tenant, rules.ReasonStellarSeriesOverflow); n != 1 {
			t.Errorf("stellar_series_overflow = %d, want 1", n)
		}
		if n := rowCount(t, `SELECT count(*) FROM scf.stellar_client_stream_state WHERE tenant_id = $1`, tenant); n != 1 {
			t.Errorf("stream rows %d", n)
		}
	})
}

// Time bounds, the backfill bound and malformed points are counted, never stored; a point of one tenant never lands
// in another's rows.
func TestStellarClientBoundsAndIsolation(t *testing.T) {
	st := newStore(t, store.Options{})
	now := time.Now().UTC().Truncate(time.Second)
	a, b := newTenant(t), newTenant(t)
	md := pmetric.NewMetrics()
	for _, tn := range []string{a, b} {
		rm := resource(md, rsrc{tenant: tn, service: "svc-" + tn[:8], recv: now})
		attrs := map[string]any{"rpc.system.name": "jsonrpc", "rpc.method": "getHealth", "stellar.network": "testnet"}
		explicit(rm, stellarScope, rules.MetricStellarRPC, false, now.Add(-2*time.Minute), now.Add(-time.Minute), stellarBounds,
			[]uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001, attrs)
		if tn == a {
			explicit(rm, stellarScope, rules.MetricStellarRPC, false, now.Add(-3*time.Hour), now.Add(-2*time.Hour), stellarBounds,
				[]uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001, attrs) // before registration (auto-registered now)
			explicit(rm, stellarScope, rules.MetricStellarRPC, false, now.Add(2*time.Hour), now.Add(3*time.Hour), stellarBounds,
				[]uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001, attrs)
			bad := map[string]any{"rpc.method": "getHealth", "stellar.network": "testnet", "error.type": "boom: G-address"}
			explicit(rm, stellarScope, rules.MetricStellarRPC, false, now.Add(-2*time.Minute), now.Add(-time.Minute), stellarBounds,
				[]uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001, bad)
		}
	}
	apply(t, st, md, now)
	for reason, want := range map[string]int64{rules.ReasonBeforeRegistration: 1, rules.ReasonFuture: 1, rules.ReasonMalformedPoint: 1} {
		if n := counter(t, a, reason); n != want {
			t.Errorf("%s = %d, want %d", reason, n, want)
		}
	}
	for _, tn := range []string{a, b} {
		if n := rowCount(t, `SELECT count(*) FROM scf.stellar_client_1m m JOIN scf.api_services s USING (tenant_id, service_id)
		    WHERE m.tenant_id = $1 AND s.service_name = $2`, tn, "svc-"+tn[:8]); n != 1 {
			t.Errorf("tenant %s rows %d", tn[:8], n)
		}
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.stellar_client_1m m JOIN scf.api_services s
	    ON s.service_id = m.service_id AND s.tenant_id <> m.tenant_id WHERE m.tenant_id = ANY($1::uuid[])`, []string{a, b}); n != 0 {
		t.Error("a row references another tenant's service")
	}
}

// Package → OTLP → the built Collector (stellar_client_metrics on, as in collector/config/collector.yaml) → writer →
// PostgreSQL, with the fixture recorded from @usagemap/stellar-otel (testdata/sdk/stellar-otel.metrics.json,
// written by `pnpm --filter @usagemap/stellar-otel collector-fixture`). Exported twice like an SDK (cumulative),
// so the stored totals equal the second export. The control-plane leg (… → API) is
// services/control-plane/test/integration/stellar-client-chain.test.ts.
func TestStellarClientCollectorToDatabase(t *testing.T) {
	p := newPKI(t)
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	_ = startWriter(t, p, e2eWriter, st)
	logs := startCollector(t, p, e2eWriter)
	raw, err := os.ReadFile(filepath.Join(repoRoot, "collector/processor/scfsanitizeprocessor/testdata/sdk/stellar-otel.metrics.json"))
	if err != nil {
		t.Fatal(err)
	}
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(raw)
	if err != nil {
		t.Fatal(err)
	}
	var maxTS int64
	want := map[string]uint64{} // metric → cumulative total of one export
	for _, rm := range md.ResourceMetrics().All() {
		for _, sm := range rm.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				switch m.Type() {
				case pmetric.MetricTypeHistogram:
					for _, dp := range m.Histogram().DataPoints().All() {
						maxTS = max(maxTS, int64(dp.Timestamp()))
						want[m.Name()] += dp.Count()
					}
				case pmetric.MetricTypeSum:
					for _, dp := range m.Sum().DataPoints().All() {
						maxTS = max(maxTS, int64(dp.Timestamp()))
						want[m.Name()] += uint64(dp.IntValue())
					}
				}
			}
		}
	}
	now := time.Now()
	first := now.Add(-2 * time.Minute).UnixNano()
	a := cloneMetrics(md)
	shiftMetrics(a, first-maxTS, first-maxTS, 1)
	b := cloneMetrics(md)
	shiftMetrics(b, first-maxTS, first-maxTS+int64(30*time.Second), 2)
	doubleSums(b)
	for _, x := range []pmetric.Metrics{a, b} {
		body, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(x)
		postToCollector(t, "/v1/metrics", body, tenant)
		time.Sleep(300 * time.Millisecond)
	}
	stored := func() map[string]int64 {
		out := map[string]int64{}
		rows, err := superConn(t).Query(context.Background(), `SELECT metric, sum(count)::bigint FROM scf.stellar_client_1m WHERE tenant_id = $1 GROUP BY 1`, tenant)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var m string
			var n int64
			_ = rows.Scan(&m, &n)
			out[m] = n
		}
		return out
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		got := stored()
		ok := len(want) == 5
		for m, n := range want {
			if got[m] < 2*int64(n) {
				ok = false
			}
		}
		if ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out: stored %v, want 2× %v; collector log:\n%s", got, want, tail(logs.String(), 3000))
		}
		time.Sleep(300 * time.Millisecond)
	}
	time.Sleep(2 * time.Second)
	got := stored()
	for m, n := range want {
		if got[m] != 2*int64(n) {
			t.Errorf("%s: stored %d, want %d", m, got[m], 2*n)
		}
	}
	// what reached storage is the closed sets only: no URL, host, address, hash or message in any dimension
	if n := rowCount(t, `SELECT count(*) FROM scf.stellar_client_1m WHERE tenant_id = $1
	   AND (operation ~ '(://|\.org|\.com|[0-9a-f]{64}|G[A-Z2-7]{55}|C[A-Z2-7]{55})' OR outcome ~ '[ :]' OR variant ~ '[ :]')`, tenant); n != 0 {
		t.Fatalf("%d rows carry raw values", n)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_metrics_1m WHERE tenant_id = $1`, tenant); n != 0 {
		t.Errorf("Stellar client metrics counted as API traffic: %d rows", n)
	}
	if n := counter(t, tenant, "client_metric_ignored"); n != 0 {
		t.Errorf("client_metric_ignored = %d: the Collector's stellar_client_metrics is off", n)
	}
}

// doubleSums doubles every monotonic sum (the second cumulative export of a process that did everything twice).
func doubleSums(md pmetric.Metrics) {
	for _, rm := range md.ResourceMetrics().All() {
		for _, sm := range rm.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Type() == pmetric.MetricTypeSum {
					for _, dp := range m.Sum().DataPoints().All() {
						dp.SetIntValue(dp.IntValue() * 2)
					}
				}
			}
		}
	}
}
