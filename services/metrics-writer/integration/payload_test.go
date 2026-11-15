// SPDX-License-Identifier: Apache-2.0

package integration

import (
	"context"
	"math"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// rsrc is a resource as the Collector's sanitise step emits it (wire-formats §g.2).
type rsrc struct {
	tenant, service, instance string
	recv                      time.Time
}

func resource(md pmetric.Metrics, r rsrc) pmetric.ResourceMetrics {
	rm := md.ResourceMetrics().AppendEmpty()
	a := rm.Resource().Attributes()
	a.PutStr("scf.tenant.id", r.tenant)
	if r.service != "" {
		a.PutStr("service.name", r.service)
	}
	if r.instance == "" {
		r.instance = "_"
	}
	a.PutStr("scf.stream.instance", r.instance)
	if r.recv.IsZero() {
		r.recv = time.Now()
	}
	a.PutInt("scf.received_at_unix_nano", r.recv.UnixNano())
	return rm
}

// withLevel sets the optional scf.tenant.level resource attribute (L0 caps).
func withLevel(rm pmetric.ResourceMetrics, level int) {
	rm.Resource().Attributes().PutInt("scf.tenant.level", int64(level))
}

func pointAttrs(route string, extra map[string]any) map[string]any {
	a := map[string]any{"scf.route": route, "scf.rules_version": "scf-path-rules/1.0.0",
		"http.request.method": "GET", "http.response.status_code": int64(200)}
	for k, v := range extra {
		if v == nil {
			delete(a, k)
		} else {
			a[k] = v
		}
	}
	return a
}

func metric(rm pmetric.ResourceMetrics, scope, name string) pmetric.Metric {
	sm := rm.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName(scope)
	sm.Scope().SetVersion("1.0.0")
	m := sm.Metrics().AppendEmpty()
	m.SetName(name)
	m.SetUnit("s")
	return m
}

// explicit adds one explicit-histogram point.
func explicit(rm pmetric.ResourceMetrics, scope, name string, cumulative bool, start, ts time.Time, bounds []float64,
	counts []uint64, sum float64, attrs map[string]any) pmetric.HistogramDataPoint {
	m := metric(rm, scope, name)
	h := m.SetEmptyHistogram()
	if cumulative {
		h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	} else {
		h.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	}
	dp := h.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	dp.ExplicitBounds().FromRaw(bounds)
	dp.BucketCounts().FromRaw(counts)
	var n uint64
	for _, c := range counts {
		n += c
	}
	dp.SetCount(n)
	dp.SetSum(sum)
	_ = dp.Attributes().FromRaw(attrs)
	return dp
}

// exponential adds one exponential-histogram point bucketed from values at scale s.
func exponential(rm pmetric.ResourceMetrics, scope, name string, cumulative bool, start, ts time.Time, s int32,
	values []float64, attrs map[string]any) pmetric.ExponentialHistogramDataPoint {
	m := metric(rm, scope, name)
	h := m.SetEmptyExponentialHistogram()
	if cumulative {
		h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	} else {
		h.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	}
	dp := h.DataPoints().AppendEmpty()
	if !start.IsZero() {
		dp.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
	}
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	// Like an SDK (and the connector) with max_size 160: lower the scale until the buckets fit.
	var lo, hi int64
	idx := make([]int64, len(values))
	var sum float64
	mn, mx := math.Inf(1), math.Inf(-1)
	for ; ; s-- {
		lo, hi = int64(math.MaxInt64), int64(math.MinInt64)
		sum, mn, mx = 0, math.Inf(1), math.Inf(-1)
		for i, v := range values {
			idx[i] = int64(math.Ceil(math.Log2(v)*math.Ldexp(1, int(s)))) - 1
			lo, hi = min(lo, idx[i]), max(hi, idx[i])
			sum += v
			mn, mx = math.Min(mn, v), math.Max(mx, v)
		}
		if len(values) == 0 || hi-lo+1 <= 160 || s == -10 {
			break
		}
	}
	dp.SetScale(s)
	if len(values) > 0 {
		counts := make([]uint64, hi-lo+1)
		for _, i := range idx {
			counts[i-lo]++
		}
		dp.Positive().SetOffset(int32(lo))
		dp.Positive().BucketCounts().FromRaw(counts)
		dp.SetMin(mn)
		dp.SetMax(mx)
	}
	dp.SetCount(uint64(len(values)))
	dp.SetSum(sum)
	_ = dp.Attributes().FromRaw(attrs)
	return dp
}

// dropCounters adds a scf.ingest.dropped resource (no service.name at resource level, C-113).
func dropCounters(md pmetric.Metrics, tenant string, ts time.Time, entries [][3]any) {
	rm := md.ResourceMetrics().AppendEmpty()
	a := rm.Resource().Attributes()
	a.PutStr("scf.tenant.id", tenant)
	a.PutInt("scf.received_at_unix_nano", ts.UnixNano())
	a.PutStr("scf.stream.instance", "_")
	sm := rm.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName(rules.SanitizeScope)
	sm.Scope().SetVersion("1.1.0")
	m := sm.Metrics().AppendEmpty()
	m.SetName(rules.MetricDropped)
	m.SetUnit("{point}")
	s := m.SetEmptySum()
	s.SetIsMonotonic(true)
	s.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	for _, e := range entries {
		dp := s.DataPoints().AppendEmpty()
		dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
		dp.SetIntValue(int64(e[2].(int)))
		dp.Attributes().PutStr("service.name", e[0].(string))
		dp.Attributes().PutStr("scf.reason", e[1].(string))
	}
}

var bounds15 = hist.Explicit15Bounds[:]

// ---- reading back (superuser, direct: bypasses RLS to see exactly what was stored) ----------------------------------

type totals struct {
	count int64
	sum   float64
	hist  []int64
}

func readTotals(t testing.TB, table, tenant string, where string, args ...any) totals {
	t.Helper()
	q := `SELECT COALESCE(sum(request_count), 0)::bigint, COALESCE(sum(duration_sum), 0),
                 COALESCE(scf.hist_sum(hist) FILTER (WHERE hist_kind = 'explicit15'), '{}')
            FROM scf.` + table + ` WHERE tenant_id = $1`
	if where != "" {
		q += " AND " + where
	}
	var r totals
	if err := superConn(t).QueryRow(context.Background(), q, append([]any{tenant}, args...)...).Scan(&r.count, &r.sum, &r.hist); err != nil {
		t.Fatal(err)
	}
	return r
}

func counter(t testing.TB, tenant, reason string) int64 {
	t.Helper()
	var n int64
	if err := superConn(t).QueryRow(context.Background(),
		`SELECT COALESCE(sum(count), 0)::bigint FROM scf.api_ingest_counters WHERE tenant_id = $1 AND reason = $2`,
		tenant, reason).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func counterFor(t testing.TB, tenant, service, reason string) int64 {
	t.Helper()
	var n int64
	if err := superConn(t).QueryRow(context.Background(),
		`SELECT COALESCE(sum(count), 0)::bigint FROM scf.api_ingest_counters WHERE tenant_id = $1 AND reason = $2 AND service_id = $3::uuid`,
		tenant, reason, service).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func serviceID(t testing.TB, tenant, name string) string {
	t.Helper()
	var id string
	if err := superConn(t).QueryRow(context.Background(),
		`SELECT service_id::text FROM scf.api_services WHERE tenant_id = $1 AND service_name = $2`, tenant, name).Scan(&id); err != nil {
		t.Fatalf("service %q: %v", name, err)
	}
	return id
}

func rowCount(t testing.TB, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := superConn(t).QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
