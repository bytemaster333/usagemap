// SPDX-License-Identifier: Apache-2.0

package integration

import (
	"context"
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

// dump renders every row the writer may touch for a tenant (except the data-quality counters), for equality checks.
func dump(t testing.TB, tenant string) string {
	t.Helper()
	var s string
	err := superConn(t).QueryRow(context.Background(), `
SELECT COALESCE(string_agg(x, E'\n' ORDER BY x), '') FROM (
  SELECT '1m ' || row_to_json(t)::text AS x FROM scf.api_metrics_1m t WHERE tenant_id = $1
  UNION ALL SELECT '1h ' || row_to_json(t)::text FROM scf.api_metrics_1h t WHERE tenant_id = $1
  UNION ALL SELECT '1d ' || row_to_json(t)::text FROM scf.api_metrics_1d t WHERE tenant_id = $1
  UNION ALL SELECT 'st ' || row_to_json(t)::text FROM scf.api_stream_state t WHERE tenant_id = $1
  UNION ALL SELECT 'rt ' || row_to_json(t)::text FROM scf.api_routes t WHERE tenant_id = $1
  UNION ALL SELECT 'rd ' || row_to_json(t)::text FROM scf.api_route_day t WHERE tenant_id = $1
  UNION ALL SELECT 'gr ' || row_to_json(t)::text FROM scf.api_stream_groups t WHERE tenant_id = $1
  UNION ALL SELECT 'dg ' || row_to_json(t)::text FROM scf.api_service_day_groups t WHERE tenant_id = $1
  UNION ALL SELECT 'sv ' || row_to_json(t)::text FROM scf.api_services t WHERE tenant_id = $1
  UNION ALL SELECT 'au ' || action || ' ' || target_id FROM scf.audit_log t WHERE tenant_id = $1) q`, tenant).Scan(&s)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mixedPayload(tenant string, now time.Time, r *rand.Rand) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: tenant, service: "orders", instance: "i-1", recv: now})
	explicit(rm, "@opentelemetry/instrumentation-http", rules.MetricStable, true, now.Add(-time.Hour), now.Add(-time.Minute),
		bounds15, []uint64{3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}, 12.5, pointAttrs("/orders/{id}", nil))
	explicit(rm, "@opentelemetry/instrumentation-http", rules.MetricStable, false, now.Add(-2*time.Minute), now.Add(-time.Minute),
		bounds15, []uint64{1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1}, 30, pointAttrs("/orders", map[string]any{"http.request.method": "POST"}))
	vals := make([]float64, 500)
	for i := range vals {
		vals[i] = 0.05 * math.Exp(0.7*r.NormFloat64())
	}
	exponential(rm, rules.ConnectorScope, rules.MetricSpanDerived, false, time.Time{}, now.Add(-30*time.Second), 20, vals,
		pointAttrs("/orders/{id}", nil))
	dropCounters(md, tenant, now, [][3]any{{"orders", "route_redacted", 2}})
	return md
}

// Duplicate batch delivery changes nothing (wire-formats §g.3, C-23): sequentially, and when the same batch reaches
// both writers at once (C-07).
func TestDuplicateBatchChangesNothing(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	md := mixedPayload(tenant, now, rand.New(rand.NewPCG(1, 1)))
	body, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	first := applyBody(t, st, body, now)
	if first[0].Duplicate || first[0].Applied != 2 { // cumulative first point only seeds; 2 delta points
		t.Fatalf("first apply: %+v", first)
	}
	before := dump(t, tenant)
	again := applyBody(t, st, body, now)
	if !again[0].Duplicate {
		t.Fatalf("second apply not a duplicate: %+v", again)
	}
	if after := dump(t, tenant); after != before {
		t.Fatalf("a duplicate batch changed stored rows:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	if n := counter(t, tenant, rules.ReasonDuplicateBatch); n != 4 {
		t.Fatalf("duplicate_batch = %d, want 4 (points of the tenant part)", n)
	}
	if n := counter(t, tenant, "route_redacted"); n != 2 {
		t.Fatalf("Collector counter applied %d times", n)
	}

	// Two writers receive the same new batch at the same moment: the ledger lets exactly one apply it.
	tenant2 := newTenant(t)
	st2 := newStore(t, store.Options{})
	md2 := mixedPayload(tenant2, now, rand.New(rand.NewPCG(2, 2)))
	body2, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md2)
	var wg sync.WaitGroup
	res := make([][]store.Result, 2)
	for i, s := range []*store.Store{st, st2} {
		wg.Add(1)
		go func() { defer wg.Done(); res[i] = applyBody(t, s, body2, now) }()
	}
	wg.Wait()
	if res[0][0].Duplicate == res[1][0].Duplicate {
		t.Fatalf("both or neither applied: %+v %+v", res[0], res[1])
	}
	if tot := readTotals(t, "api_metrics_1m", tenant2, ""); tot.count != 15+500 {
		t.Fatalf("1m count = %d, want 515", tot.count)
	}
}

// Cumulative streams with resets convert correctly (§9.4): seed, delta, stale replay, reset with a new start time,
// decrease without a new start time.
func TestCumulativeStreamsWithResets(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	s0 := now.Add(-2 * time.Hour) // the process started long before we first saw the service → first point seeds
	b := []float64{0.1, 1}
	send := func(start, ts time.Time, c ...uint64) {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "ledger", instance: "pod-1", recv: now})
		explicit(rm, "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", rules.MetricStable, true, start, ts, b, c,
			float64(c[0])*0.05+float64(c[1])*0.5, pointAttrs("/ledgers/{seq}", nil))
		apply(t, st, md, now)
	}
	send(s0, now.Add(-5*time.Minute), 10, 2, 0)                       // seed
	send(s0, now.Add(-4*time.Minute), 15, 3, 1)                       // +5, +1, +1
	send(s0, now.Add(-5*time.Minute), 10, 2, 0)                       // stale replay (queue replay after a newer one)
	send(s0, now.Add(-3*time.Minute), 1, 0, 0)                        // decrease without a new start: reset, dropped
	send(now.Add(-150*time.Second), now.Add(-2*time.Minute), 4, 0, 0) // new start ≥ last time: whole point
	send(now.Add(-150*time.Second), now.Add(-1*time.Minute), 6, 1, 0) // +2, +1
	tot := readTotals(t, "api_metrics_1m", tenant, "")
	if tot.count != 7+4+3 {
		t.Fatalf("1m count = %d, want 14", tot.count)
	}
	if got := counter(t, tenant, rules.ReasonCumulativeFirstPoint); got != 1 {
		t.Fatalf("cumulative_first_point = %d", got)
	}
	if got := counter(t, tenant, rules.ReasonCumulativeReset); got != 2 {
		t.Fatalf("cumulative_reset = %d, want 2", got)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_metrics_1m WHERE tenant_id = $1 AND (duration_min IS NOT NULL OR duration_max IS NOT NULL)`, tenant); n != 0 {
		t.Fatalf("%d rows from cumulative deltas carry min/max", n)
	}
	// (0.1, 1] of the source maps into explicit15 by width → hist_layout_approx
	if got := counter(t, tenant, rules.ReasonHistLayoutApprox); got == 0 {
		t.Fatal("hist_layout_approx not counted for a straddling layout")
	}
}

// Delta streams add; the three resolutions agree.
func TestDeltaStreamsAddAcrossResolutions(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	for i := range 3 {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "api", recv: now})
		explicit(rm, "s", rules.MetricStable, false, now.Add(-time.Duration(3-i)*time.Minute), now.Add(-time.Duration(2-i)*time.Minute),
			bounds15, []uint64{1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.05, pointAttrs("/x", nil))
		apply(t, st, md, now)
	}
	want := []int64{3, 6, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	for _, tbl := range []string{"api_metrics_1m", "api_metrics_1h", "api_metrics_1d"} {
		tot := readTotals(t, tbl, tenant, "")
		if tot.count != 18 || !slices.Equal(tot.hist, want) || math.Abs(tot.sum-0.15) > 1e-9 {
			t.Fatalf("%s: count %d hist %v sum %v", tbl, tot.count, tot.hist, tot.sum)
		}
	}
	// presence of the stream group for the day (preferred-group views)
	if n := rowCount(t, `SELECT count(*) FROM scf.api_service_day_groups WHERE tenant_id = $1`, tenant); n != 1 {
		t.Fatalf("day groups = %d", n)
	}
}

// "Restart without service.instance.id loses nothing" (C-112(3)): a cumulative stream restarted
// mid-hour delivers exactly the requests made after the restart.
func TestRestartWithoutInstanceIDLosesNothing(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	b := []float64{0.25}
	send := func(start, ts time.Time, n uint64) {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "go-api", instance: "_", recv: time.Now()}) // Go: no instance id
		explicit(rm, "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", rules.MetricStable, true, start, ts, b,
			[]uint64{n, 0}, 0.01*float64(n), pointAttrs("/health", nil))
		apply(t, st, md, time.Now())
	}
	p1 := now.Add(-time.Hour)
	send(p1, now.Add(-3*time.Minute), 100) // first export of a long-running process: seeds only
	send(p1, now.Add(-2*time.Minute), 103) // +3
	// The process restarts: a new start time, a new stream key (C-105). It served 5 requests before its first export.
	restart := time.Now().UTC().Add(time.Second)
	send(restart, restart.Add(10*time.Second), 5)
	send(restart, restart.Add(20*time.Second), 9) // +4
	if tot := readTotals(t, "api_metrics_1m", tenant, ""); tot.count != 3+5+4 {
		t.Fatalf("counted %d requests, want 12", tot.count)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_stream_state WHERE tenant_id = $1 AND last_layout->>'kind' <> 'source'`, tenant); n != 2 {
		t.Fatalf("stream states = %d, want 2 (one per process start)", n)
	}
}

// C-122: the first point of a stream on a source we already receive is counted in full — a new route, the first 404
// ever — because the SDK stamps every stream with the process start time and the stream's whole cumulative value is
// new to us. A stale replay of such a stream never adds anything.
func TestFirstPointOfNewStreamOnKnownSource(t *testing.T) {
	for _, inst := range []string{"pod-1", "_"} { // with and without service.instance.id
		t.Run("instance="+inst, func(t *testing.T) {
			tenant := newTenant(t)
			st := newStore(t, store.Options{})
			now := time.Now().UTC()
			p0 := now.Add(-2 * time.Hour) // the process started long before its first export to us
			b := []float64{0.25}
			type pt struct {
				route  string
				status int64
				n      uint64
			}
			send := func(ts time.Time, points ...pt) {
				md := pmetric.NewMetrics()
				rm := resource(md, rsrc{tenant: tenant, service: "api", instance: inst, recv: time.Now()})
				for _, p := range points {
					explicit(rm, "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", rules.MetricStable, true,
						p0, ts, b, []uint64{p.n, 0}, 0.01*float64(p.n),
						pointAttrs(p.route, map[string]any{"http.response.status_code": p.status}))
				}
				apply(t, st, md, time.Now())
			}
			send(now.Add(-4*time.Minute), pt{"/a", 200, 100})                   // first export of the process: seeds
			send(now.Add(-3*time.Minute), pt{"/a", 200, 103}, pt{"/b", 200, 2}) // +3; new route /b: +2 in full
			send(now.Add(-2*time.Minute), pt{"/a", 200, 103}, pt{"/b", 200, 2}, // unchanged
				pt{"/a", 404, 1}) // the first 404 ever: +1
			send(now.Add(-3*time.Minute), pt{"/a", 200, 103}, pt{"/b", 200, 2})                   // stale replay of an older request
			send(now.Add(-1*time.Minute), pt{"/a", 200, 104}, pt{"/b", 200, 2}, pt{"/a", 404, 3}) // +1, +2
			if tot := readTotals(t, "api_metrics_1m", tenant, ""); tot.count != 3+2+1+1+2 {
				t.Fatalf("counted %d requests, want 9", tot.count)
			}
			if n := readTotals(t, "api_metrics_1m", tenant, "status_code = 404").count; n != 3 {
				t.Fatalf("404s counted %d, want 3", n)
			}
			if got := counter(t, tenant, rules.ReasonCumulativeFirstPoint); got != 1 {
				t.Fatalf("cumulative_first_point = %d, want 1 (only the process's first export)", got)
			}
			// one state row per stream plus one source row
			if n := rowCount(t, `SELECT count(*) FROM scf.api_stream_state WHERE tenant_id = $1 AND last_layout->>'kind' = 'source'`, tenant); n != 1 {
				t.Fatalf("source rows = %d, want 1", n)
			}
		})
	}
}

// C-122, brand-new service: a fresh process's first export is counted in full (nothing lost); the first export of a
// long-running process to a service we have never seen only seeds (no imported history).
func TestFirstPointOfBrandNewService(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	b := []float64{0.25}
	send := func(service string, start, ts time.Time, n uint64) {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: service, instance: "_", recv: time.Now()})
		explicit(rm, "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", rules.MetricStable, true, start, ts, b,
			[]uint64{n, 0}, 0.01*float64(n), pointAttrs("/x", nil))
		apply(t, st, md, time.Now())
	}
	send("fresh", now.Add(-time.Minute), now, 7)                  // started a minute ago: 7 requests, all counted
	send("fresh", now.Add(-time.Minute), now.Add(time.Second), 9) // +2
	send("old", now.Add(-3*time.Hour), now, 500)                  // running for 3 h before its first export: seeds
	send("old", now.Add(-3*time.Hour), now.Add(time.Second), 504) // +4
	if n := readTotals(t, "api_metrics_1m", tenant, "service_id = $2::uuid", serviceID(t, tenant, "fresh")).count; n != 9 {
		t.Fatalf("fresh service counted %d, want 9", n)
	}
	if n := readTotals(t, "api_metrics_1m", tenant, "service_id = $2::uuid", serviceID(t, tenant, "old")).count; n != 4 {
		t.Fatalf("old process counted %d, want 4", n)
	}
	if got := counterFor(t, tenant, serviceID(t, tenant, "old"), rules.ReasonCumulativeFirstPoint); got != 1 {
		t.Fatalf("cumulative_first_point(old) = %d, want 1", got)
	}
}

// C-122: a new path-rule set renders existing routes anew, so every stream key changes; the source changes with the
// rules version, so the new streams only seed and history is never counted twice.
func TestRulesVersionChangeDoesNotRecount(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	p0 := now.Add(-5 * time.Hour)
	send := func(ts time.Time, rv string, n uint64) {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "api", instance: "pod-1", recv: time.Now()})
		explicit(rm, "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", rules.MetricStable, true, p0, ts,
			[]float64{0.25}, []uint64{n, 0}, 0.01*float64(n), pointAttrs("/x", map[string]any{"scf.rules_version": rv}))
		apply(t, st, md, time.Now())
	}
	send(now.Add(-3*time.Minute), "scf-path-rules/1.0.0", 1000) // seeds
	send(now.Add(-2*time.Minute), "scf-path-rules/1.0.0", 1010) // +10
	send(now.Add(-1*time.Minute), "scf-path-rules/1.1.0", 1020) // new rules: new source → seeds
	send(now, "scf-path-rules/1.1.0", 1021)                     // +1
	if tot := readTotals(t, "api_metrics_1m", tenant, ""); tot.count != 11 {
		t.Fatalf("counted %d requests, want 11", tot.count)
	}
}

// Two writers receive two consecutive exports of a source we have not seen, at the same moment (C-07): whichever
// commits first, every request is counted exactly once.
func TestConcurrentFirstExportsOfNewSource(t *testing.T) {
	for i := range 5 {
		tenant := newTenant(t)
		st1, st2 := newStore(t, store.Options{}), newStore(t, store.Options{})
		now := time.Now().UTC()
		start := now.Add(-2 * time.Minute)
		body := func(ts time.Time, a, c uint64) []byte {
			md := pmetric.NewMetrics()
			rm := resource(md, rsrc{tenant: tenant, service: "api", instance: "_", recv: time.Now()})
			explicit(rm, "s", rules.MetricStable, true, start, ts, []float64{0.25}, []uint64{a, 0}, 0.01*float64(a), pointAttrs("/a", nil))
			if c > 0 {
				explicit(rm, "s", rules.MetricStable, true, start, ts, []float64{0.25}, []uint64{c, 0}, 0.01*float64(c), pointAttrs("/c", nil))
			}
			out, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
			return out
		}
		b1, b2 := body(now.Add(-time.Minute), 5, 0), body(now, 8, 2) // /a: 5 then 8; /c first appears in the second
		var wg sync.WaitGroup
		for j, pair := range []struct {
			s *store.Store
			b []byte
		}{{st1, b1}, {st2, b2}} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if j == i%2 {
					time.Sleep(time.Duration(i) * time.Millisecond)
				}
				applyBody(t, pair.s, pair.b, time.Now())
			}()
		}
		wg.Wait()
		// /a: 5 (fresh, in full) + 3, or 8 in full and the older export stale; /c: 2 in full either way
		if tot := readTotals(t, "api_metrics_1m", tenant, ""); tot.count != 10 {
			t.Fatalf("run %d: counted %d, want 10", i, tot.count)
		}
	}
}

// Percentiles from the stored histograms are within the stated error against exact values (§9: exp3 ≤ 4.33 %,
// explicit15 within the width of the bucket that holds the exact value), read with the §9.3 range query.
func TestPercentilesWithinStatedError(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	r := rand.New(rand.NewPCG(20261112, 7))
	const n = 100_000
	values := make([]float64, n)
	for i := range values {
		if i%10 < 7 {
			values[i] = 0.015 * math.Exp(0.4*r.NormFloat64())
		} else {
			values[i] = 0.45 * math.Exp(0.5*r.NormFloat64())
		}
	}
	// exp3 path: span-derived delta points at scale 20, 20 points of 5,000 values
	// explicit15 path: SDK delta points with the default bounds, same values
	for c := 0; c < n; c += 5000 {
		chunk := values[c : c+5000]
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "acc-exp", recv: now})
		exponential(rm, rules.ConnectorScope, rules.MetricSpanDerived, false, time.Time{}, now.Add(-time.Minute), 20, chunk,
			pointAttrs("/q", nil))
		rm2 := resource(md, rsrc{tenant: tenant, service: "acc-x15", recv: now})
		counts := make([]uint64, 15)
		var sum, mn, mx = 0.0, math.Inf(1), math.Inf(-1)
		for _, v := range chunk {
			i := 0
			for i < 14 && hist.Explicit15Bounds[i] < v {
				i++
			}
			counts[i]++
			sum += v
			mn, mx = math.Min(mn, v), math.Max(mx, v)
		}
		dp := explicit(rm2, "s", rules.MetricStable, false, now.Add(-2*time.Minute), now.Add(-time.Minute), bounds15, counts, sum,
			pointAttrs("/q", nil))
		dp.SetMin(mn)
		dp.SetMax(mx)
		apply(t, st, md, now)
	}
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	exact := func(q float64) float64 { return sorted[int(math.Ceil(q*n))-1] } // inverted CDF
	for _, svc := range []string{"acc-exp", "acc-x15"} {
		var acc string
		var p [3]float64
		var requests int64
		err := superConn(t).QueryRow(context.Background(), `
WITH r AS (
  SELECT sum(request_count) AS requests,
         bool_and(hist_kind = 'exp3') AS all_exp3, bool_and(hist_kind = 'explicit15') AS all_exp15,
         max(hist_quality)::smallint AS q,
         CASE WHEN bool_and(hist_kind = 'exp3') THEN scf.hist_sum(hist)
              ELSE scf.hist_add8(scf.hist_sum(hist) FILTER (WHERE hist_kind = 'explicit15'),
                                 scf.hist_exp3_to_explicit15(scf.hist_sum(hist) FILTER (WHERE hist_kind = 'exp3'))) END AS h,
         CASE WHEN bool_and(duration_min IS NOT NULL) THEN min(duration_min) END AS vmin,
         CASE WHEN bool_and(duration_max IS NOT NULL) THEN max(duration_max) END AS vmax
    FROM scf.api_metrics_1h WHERE tenant_id = $1 AND service_id = $2::uuid)
SELECT requests, scf.accuracy_class(all_exp3, all_exp15, q),
       scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.50, vmin, vmax),
       scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.95, vmin, vmax),
       scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.99, vmin, vmax)
  FROM r`, tenant, serviceID(t, tenant, svc)).Scan(&requests, &acc, &p[0], &p[1], &p[2])
		if err != nil {
			t.Fatal(err)
		}
		if requests != n {
			t.Fatalf("%s: %d requests stored, want %d", svc, requests, n)
		}
		for i, q := range []float64{0.5, 0.95, 0.99} {
			ex := exact(q)
			rel := (p[i] - ex) / ex
			switch acc {
			case "exp3":
				if math.Abs(rel) > 0.0433 {
					t.Errorf("%s p%v = %.6f, exact %.6f: error %.2f %% > 4.33 %%", svc, q*100, p[i], ex, rel*100)
				}
			case "explicit15":
				j := 0
				for j < 14 && hist.Explicit15Bounds[j] < ex {
					j++
				}
				lo, hi := 0.0, math.Inf(1)
				if j > 0 {
					lo = hist.Explicit15Bounds[j-1]
				}
				if j < 14 {
					hi = hist.Explicit15Bounds[j]
				}
				if p[i] < lo || p[i] > hi {
					t.Errorf("%s p%v = %.6f outside the exact value's bucket (%v, %v]", svc, q*100, p[i], lo, hi)
				}
			default:
				t.Fatalf("%s: accuracy class %q", svc, acc)
			}
			t.Logf("%s (%s) p%v: stored %.6f s, exact %.6f s, error %+.2f %%", svc, acc, q*100, p[i], ex, rel*100)
		}
	}
}

// Late and future points are handled per the bounds: no partition → too_old / future (§10); before
// registered_at − 10 min → before_registration (§8.6); received more than 72 h ago → undeliverable_72h (C-112(8)).
func TestTimeBounds(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	su := superConn(t)
	if _, err := su.Exec(context.Background(), `INSERT INTO scf.api_services (tenant_id, service_name, created_by) VALUES ($1, 'portal-svc', $2)`,
		tenant, userID); err != nil {
		t.Fatal(err)
	}
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: tenant, service: "portal-svc", recv: now})
	one := []uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	explicit(rm, "s", rules.MetricStable, false, now, now.AddDate(1, 2, 0), bounds15, one, 0.001, pointAttrs("/f", nil))
	explicit(rm, "s", rules.MetricStable, false, now, now.AddDate(0, 0, -3), bounds15, one, 0.001, pointAttrs("/o", nil))
	explicit(rm, "s", rules.MetricStable, false, now, now.Add(-20*time.Minute), bounds15, one, 0.001, pointAttrs("/b", nil))
	explicit(rm, "s", rules.MetricStable, false, now, now.Add(-5*time.Minute), bounds15, one, 0.001, pointAttrs("/ok", nil))
	old := resource(md, rsrc{tenant: tenant, service: "portal-svc", recv: now.Add(-73 * time.Hour)})
	explicit(old, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001, pointAttrs("/q", nil))
	apply(t, st, md, now)
	svc := serviceID(t, tenant, "portal-svc")
	for reason, want := range map[string]int64{rules.ReasonFuture: 1, rules.ReasonTooOld: 1, rules.ReasonBeforeRegistration: 1,
		rules.ReasonUndeliverable72h: 1} {
		if got := counterFor(t, tenant, svc, reason); got != want {
			t.Errorf("%s = %d, want %d", reason, got, want)
		}
	}
	if tot := readTotals(t, "api_metrics_1m", tenant, ""); tot.count != 1 {
		t.Fatalf("stored %d points, want only the in-bounds one", tot.count)
	}
}

func setSetting(t testing.TB, key string, value int) {
	t.Helper()
	su := superConn(t)
	var old string
	if err := su.QueryRow(context.Background(), `SELECT value::text FROM scf.settings WHERE key = $1`, key).Scan(&old); err != nil {
		t.Fatal(err)
	}
	if _, err := su.Exec(context.Background(), `UPDATE scf.settings SET value = to_jsonb($2::int) WHERE key = $1`, key, value); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = superConn(t).Exec(context.Background(), `UPDATE scf.settings SET value = $2::jsonb WHERE key = $1`, key, old)
	})
}

// The cardinality guard routes excess to {overflow} (C-24, C-16, C-89): service, tenant and sibling caps, and
// otel.metric.overflow; first come, first served; counted route_overflow.
func TestCardinalityGuard(t *testing.T) {
	setSetting(t, "route_cap_per_service_day", 3)
	setSetting(t, "route_cap_per_tenant_day", 4)
	setSetting(t, "route_sibling_cap", 2)
	tenant := newTenant(t)
	st := newStore(t, store.Options{SettingsTTL: time.Nanosecond})
	now := time.Now().UTC()
	one := []uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: tenant, service: "s1", recv: now})
	for _, r := range []string{"/a/x1", "/a/x2", "/a/x3", "/b", "/c", "/a/{id}"} {
		explicit(rm, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001, pointAttrs(r, nil))
	}
	explicit(rm, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001,
		pointAttrs("/z", map[string]any{"otel.metric.overflow": true}))
	rm2 := resource(md, rsrc{tenant: tenant, service: "s2", recv: now})
	for _, r := range []string{"/d", "/e"} {
		explicit(rm2, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001, pointAttrs(r, nil))
	}
	apply(t, st, md, now)
	routesOf := func(svc string) []string {
		rows, err := superConn(t).Query(context.Background(), `
SELECT r.route || ':' || sum(m.request_count) FROM scf.api_metrics_1m m JOIN scf.api_routes r USING (tenant_id, route_id)
 WHERE m.tenant_id = $1 AND m.service_id = $2::uuid GROUP BY r.route ORDER BY r.route`, tenant, serviceID(t, tenant, svc))
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var s string
			_ = rows.Scan(&s)
			out = append(out, s)
		}
		return out
	}
	// sorted arrival: /a/x1 ✓, /a/x2 ✓, /a/x3 → /a/{overflow} (2 literal siblings), /a/{id} ✓ (typed placeholder,
	// not a literal sibling; 3rd route of s1), /b → {overflow} (service cap 3), /c → {overflow}, /z → {overflow}
	// (otel.metric.overflow); s2: /d ✓ (4th of the tenant), /e → {overflow} (tenant cap 4)
	want1 := []string{"/a/x1:1", "/a/x2:1", "/a/{id}:1", "/a/{overflow}:1", "{overflow}:3"}
	if got := routesOf("s1"); !slices.Equal(got, want1) {
		t.Fatalf("s1 routes = %v, want %v", got, want1)
	}
	if got := routesOf("s2"); !slices.Equal(got, []string{"/d:1", "{overflow}:1"}) {
		t.Fatalf("s2 routes = %v", got)
	}
	if got := counter(t, tenant, rules.ReasonRouteOverflow); got != 5 {
		t.Fatalf("route_overflow = %d, want 5", got)
	}
	// An admitted route stays admitted for the rest of the day; an overflowed one keeps overflowing.
	md = pmetric.NewMetrics()
	rm = resource(md, rsrc{tenant: tenant, service: "s1", recv: now})
	explicit(rm, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001, pointAttrs("/a/x1", nil))
	explicit(rm, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001, pointAttrs("/b", nil))
	apply(t, st, md, now)
	want1 = []string{"/a/x1:2", "/a/x2:1", "/a/{id}:1", "/a/{overflow}:1", "{overflow}:4"}
	if got := routesOf("s1"); !slices.Equal(got, want1) {
		t.Fatalf("s1 routes after a second batch = %v, want %v", got, want1)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_routes WHERE tenant_id = $1 AND route IN ('/b', '/c', '/e', '/a/x3', '/z')`, tenant); n != 0 {
		t.Fatalf("%d overflowed routes entered the dictionary", n)
	}
}

// Services: auto-registration up to the quota with an audit row (C-21; L0: 1 service), service_quota_exceeded beyond
// it; counters never register a service and {not_allowed} drops go to the all-zero service (C-115).
func TestServiceRegistrationAndCounters(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	one := []uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: tenant, service: "first", recv: now})
	withLevel(rm, 0)
	explicit(rm, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001, pointAttrs("/a", nil))
	rm2 := resource(md, rsrc{tenant: tenant, service: "second", recv: now})
	withLevel(rm2, 0)
	explicit(rm2, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001, pointAttrs("/a", nil))
	rm3 := resource(md, rsrc{tenant: tenant, service: "has space", recv: now})
	explicit(rm3, "s", rules.MetricStable, false, now, now.Add(-time.Minute), bounds15, one, 0.001, pointAttrs("/a", nil))
	dropCounters(md, tenant, now, [][3]any{{rules.ServiceNotAllowed, "service_not_allowed", 7}, {"first", "route_redacted", 1},
		{"never-seen", "malformed_point", 2}})
	apply(t, st, md, now)
	if n := rowCount(t, `SELECT count(*) FROM scf.api_services WHERE tenant_id = $1`, tenant); n != 1 {
		t.Fatalf("services = %d, want 1 (L0 quota)", n)
	}
	first := serviceID(t, tenant, "first")
	if n := rowCount(t, `SELECT count(*) FROM scf.audit_log WHERE tenant_id = $1 AND action = 'service.auto_registered'
  AND actor_kind = 'writer' AND target_id = $2`, tenant, first); n != 1 {
		t.Fatalf("audit rows = %d", n)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_services WHERE tenant_id = $1 AND registration = 'auto' AND created_by IS NULL`, tenant); n != 1 {
		t.Fatal("auto-registered service not marked auto")
	}
	const zero = "00000000-0000-0000-0000-000000000000"
	checks := []struct {
		svc, reason string
		want        int64
	}{
		{zero, rules.ReasonServiceQuotaExceeded, 1},
		{zero, rules.ReasonServiceNotAllowed, 7},
		{zero, rules.ReasonMalformedPoint, 1 + 2}, // invalid service name; counter of an unregistered service
		{first, "route_redacted", 1},
	}
	for _, c := range checks {
		if got := counterFor(t, tenant, c.svc, c.reason); got != c.want {
			t.Errorf("%s/%s = %d, want %d", c.svc, c.reason, got, c.want)
		}
	}
}

// count_overflow (C-112(1)): a point whose bucket exceeds int4 is rejected before any SQL; a merge that would push a
// stored _1d row past int4 is skipped and the point is left out of _1h and _1m.
func TestCountOverflow(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	at := now.Add(-time.Minute)
	send := func(c0 uint64) {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "big", recv: now})
		c := make([]uint64, 15)
		c[0] = c0
		explicit(rm, "s", rules.MetricStable, false, at, at, bounds15, c, 0.001, pointAttrs("/a", nil))
		apply(t, st, md, now)
	}
	send(1 << 31) // 2^31 > int4
	if got := counter(t, tenant, rules.ReasonCountOverflow); got != 1 {
		t.Fatalf("count_overflow = %d", got)
	}
	send(1)
	// Push the stored _1d row to the int4 limit, then merge one more.
	if _, err := superConn(t).Exec(context.Background(),
		`UPDATE scf.api_metrics_1d SET hist[1] = 2147483647 WHERE tenant_id = $1`, tenant); err != nil {
		t.Fatal(err)
	}
	res := func() []store.Result {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "big", recv: now})
		c := make([]uint64, 15)
		c[0] = 1
		explicit(rm, "s", rules.MetricStable, false, at, at.Add(time.Second), bounds15, c, 0.001, pointAttrs("/a", nil))
		return apply(t, st, md, now)
	}()
	if res[0].WriteError || res[0].Applied != 0 {
		t.Fatalf("result %+v", res[0])
	}
	if got := counter(t, tenant, rules.ReasonCountOverflow); got != 2 {
		t.Fatalf("count_overflow = %d, want 2", got)
	}
	for _, tbl := range []string{"api_metrics_1h", "api_metrics_1m"} {
		if tot := readTotals(t, tbl, tenant, ""); tot.count != 1 {
			t.Fatalf("%s count = %d, want 1 (the skipped point must not reach the finer tables)", tbl, tot.count)
		}
	}
}

// Every write runs as scf_writer (no bypass role) under a tenant context set only by scf.set_tenant_ctx() (C-103).
func TestWritesOnlyUnderTenantContext(t *testing.T) {
	ctx := context.Background()
	su := superConn(t)
	var bypass, super bool
	if err := su.QueryRow(ctx, `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'scf_writer'`).Scan(&bypass, &super); err != nil {
		t.Fatal(err)
	}
	if bypass || super {
		t.Fatal("scf_writer must not bypass RLS")
	}
	// The statements the writer ran (pg_stat_statements; earlier tests exercised every path).
	rows, err := su.Query(ctx, `SELECT s.query FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
 WHERE r.rolname = 'scf_writer' AND s.toplevel`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var n, ctxCalls int
	for rows.Next() {
		var q string
		_ = rows.Scan(&q)
		n++
		if contains(q, "set_tenant_ctx") {
			ctxCalls++
		}
		if lq := strings.ToLower(q); contains(lq, "set_"+"config") || contains(lq, "set "+"app.") {
			t.Errorf("writer statement sets context without the wrapper: %s", q)
		}
	}
	if n == 0 || ctxCalls == 0 {
		t.Fatalf("pg_stat_statements: %d writer statements, %d context calls", n, ctxCalls)
	}
	// Without a context the role sees and writes nothing.
	wp := writerPool(t, 1)
	tx, err := wp.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var visible int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.api_metrics_1m`).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible != 0 {
		t.Fatalf("scf_writer sees %d metric rows without a tenant context", visible)
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }
