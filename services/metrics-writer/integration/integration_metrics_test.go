// SPDX-License-Identifier: Apache-2.0

package integration

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

// Integration client metrics (wire-formats §g.8, migration 0085): partner calls, payments and the anchor funnel are
// stored in scf.integration_metrics_* only — never in the API tables, never in scf.stellar_client_*.

func intCounter(rm pmetric.ResourceMetrics, scope, name string, start, ts time.Time, v int64, attrs map[string]any) {
	m := metric(rm, scope, name)
	m.SetUnit("{event}")
	s := m.SetEmptySum()
	s.SetIsMonotonic(true)
	s.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	dp := s.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	dp.SetIntValue(v)
	_ = dp.Attributes().FromRaw(attrs)
}

type intTotal struct {
	count int64
	sum   float64
	hist  []int64
	rows  int64
}

func intRead(t testing.TB, table, tenant, where string, args ...any) intTotal {
	t.Helper()
	q := `SELECT COALESCE(sum(count), 0)::bigint, COALESCE(sum(duration_sum), 0), COALESCE(scf.hist_sum(hist), '{}'), count(*)
	        FROM scf.` + table + ` WHERE tenant_id = $1`
	if where != "" {
		q += " AND " + where
	}
	var r intTotal
	if err := superConn(t).QueryRow(context.Background(), q, append([]any{tenant}, args...)...).Scan(&r.count, &r.sum, &r.hist, &r.rows); err != nil {
		t.Fatal(err)
	}
	return r
}

func intDump(t testing.TB, tenant string) string {
	t.Helper()
	var s string
	if err := superConn(t).QueryRow(context.Background(), `
SELECT COALESCE(string_agg(x, E'\n' ORDER BY x), '') FROM (
  SELECT '1h ' || row_to_json(t)::text AS x FROM scf.integration_metrics_1h t WHERE tenant_id = $1
  UNION ALL SELECT '1d ' || row_to_json(t)::text FROM scf.integration_metrics_1d t WHERE tenant_id = $1
  UNION ALL SELECT 'st ' || encode(stream_key, 'hex') || last_count || last_time_unix_ns FROM scf.integration_stream_state t WHERE tenant_id = $1) q`,
		tenant).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

// Two cumulative exports of one backend with all three families: totals equal the second export in both tables;
// partner and anchor request durations keep explicit15, transfer durations count and sum only, counters count only;
// a duplicate batch changes nothing; nothing reaches the API or Stellar client tables; the service is registered.
func TestIntegrationCumulativeStreams(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC().Truncate(time.Second)
	start := now.Add(-90 * time.Second)
	bounds := []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30}
	export := func(ts time.Time, k uint64) pmetric.Metrics {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "wallet-backend", recv: ts})
		explicit(rm, "@usagemap/partner-otel", rules.MetricPartnerDuration, true, start, ts, bounds,
			[]uint64{0, 0, 0, 0, 1 * k, 2 * k, 0, 0, 0, 0, 0, 0, 0}, 0.5*float64(k), map[string]any{
				"stellar.partner": "soroswap", "stellar.partner.operation": "/quote", "stellar.partner.outcome": "success",
				"stellar.network": "mainnet"})
		intCounter(rm, "@usagemap/payments-otel", rules.MetricPaymentEvents, start, ts, int64(3*k), map[string]any{
			"payment.protocol": "x402", "payment.stage": "settled", "payment.network": "stellar:pubnet",
			"payment.scheme": "exact", "payment.asset": "USDC", "payment.amount_bucket": "0.01_0.1"})
		intCounter(rm, "@usagemap/payments-otel", rules.MetricPaymentEvents, start, ts, int64(1*k), map[string]any{
			"payment.protocol": "mpp", "payment.stage": "failed", "payment.network": "stellar:testnet",
			"payment.method": "stellar", "payment.intent": "charge", "payment.reason_class": "expired",
			"error.type": "payment-expired"})
		explicit(rm, "@usagemap/anchor-otel", rules.MetricAnchorRequestDuration, true, start, ts, bounds,
			[]uint64{0, 0, 0, 0, 0, 0, 1 * k, 0, 0, 0, 0, 0, 0}, 0.4*float64(k), map[string]any{"stellar.sep": "24",
				"stellar.anchor.step": "deposit_interactive", "stellar.anchor.outcome": "ok",
				"stellar.anchor.home_domain": "testanchor.stellar.org", "stellar.network": "testnet"})
		intCounter(rm, "@usagemap/anchor-otel", rules.MetricAnchorEvents, start, ts, int64(2*k), map[string]any{
			"stellar.anchor.event": "deposit_started", "stellar.sep": "24",
			"stellar.anchor.home_domain": "testanchor.stellar.org", "stellar.network": "testnet"})
		// the AP listener's transfer duration: an hour and a half per transfer, far above explicit15
		explicit(rm, "ap-listener", rules.MetricAnchorTransferDuration, true, start, ts, []float64{60, 600, 3600, 86400},
			[]uint64{0, 0, 0, 1 * k, 0}, 5400*float64(k), map[string]any{"stellar.sep": "24", "stellar.anchor.kind": "deposit",
				"stellar.anchor.status": "completed", "stellar.network": "mainnet"})
		return md
	}
	if r := apply(t, st, export(now.Add(-60*time.Second), 1), now); r[0].Applied != 6 {
		t.Fatalf("first export: %+v", r)
	}
	second := export(now.Add(-time.Second), 2)
	if r := apply(t, st, second, now); r[0].Applied != 6 {
		t.Fatalf("second export: %+v", r)
	}
	for _, tb := range []string{"integration_metrics_1h", "integration_metrics_1d"} {
		p := intRead(t, tb, tenant, "metric = $2 AND d1 = 'soroswap' AND d2 = '/quote' AND d3 = 'success'", rules.MetricPartnerDuration)
		// (0.05, 0.1] → explicit15 bucket 6, (0.1, 0.25] → bucket 7
		if p.count != 6 || math.Abs(p.sum-1) > 1e-9 || len(p.hist) != 15 || p.hist[5] != 2 || p.hist[6] != 4 {
			t.Errorf("%s partner: %+v", tb, p)
		}
		x := intRead(t, tb, tenant, "metric = $2 AND network = 'stellar:pubnet' AND d1 = 'x402' AND d2 = 'settled' AND d3 = 'exact' AND d5 = 'USDC' AND d6 = '0.01_0.1' AND d7 = ''",
			rules.MetricPaymentEvents)
		if x.count != 6 || len(x.hist) != 0 || x.sum != 0 {
			t.Errorf("%s x402: %+v", tb, x)
		}
		mpp := intRead(t, tb, tenant, "metric = $2 AND d1 = 'mpp' AND d3 = 'stellar' AND d4 = 'charge' AND d6 = 'expired' AND d7 = 'payment-expired'",
			rules.MetricPaymentEvents)
		if mpp.count != 2 {
			t.Errorf("%s mpp: %+v", tb, mpp)
		}
		ar := intRead(t, tb, tenant, "metric = $2 AND d4 = 'testanchor.stellar.org'", rules.MetricAnchorRequestDuration)
		if ar.count != 2 || len(ar.hist) != 15 || ar.hist[7] != 2 {
			t.Errorf("%s anchor request: %+v", tb, ar)
		}
		ev := intRead(t, tb, tenant, "metric = $2 AND d1 = 'deposit_started' AND d3 = 'testanchor.stellar.org'", rules.MetricAnchorEvents)
		if ev.count != 4 {
			t.Errorf("%s anchor events: %+v", tb, ev)
		}
		td := intRead(t, tb, tenant, "metric = $2 AND d4 = 'completed'", rules.MetricAnchorTransferDuration)
		if td.count != 2 || math.Abs(td.sum-10800) > 1e-6 || len(td.hist) != 0 {
			t.Errorf("%s transfer duration (count and sum only): %+v", tb, td)
		}
	}
	if n := rowCount(t, `SELECT (SELECT count(*) FROM scf.api_metrics_1m WHERE tenant_id = $1) + (SELECT count(*) FROM scf.api_stream_state WHERE tenant_id = $1)
	    + (SELECT count(*) FROM scf.stellar_client_1m WHERE tenant_id = $1) + (SELECT count(*) FROM scf.stellar_client_stream_state WHERE tenant_id = $1)`, tenant); n != 0 {
		t.Errorf("integration metrics reached the API or Stellar client tables: %d rows", n)
	}
	_ = serviceID(t, tenant, "wallet-backend")
	if n := rowCount(t, `SELECT count(*) FROM scf.integration_stream_state WHERE tenant_id = $1`, tenant); n != 6 {
		t.Errorf("stream state rows %d", n)
	}
	if n := counter(t, tenant, rules.ReasonCumulativeFirstPoint); n != 0 {
		t.Errorf("cumulative_first_point = %d (a fresh process is counted in full)", n)
	}
	before := intDump(t, tenant)
	if r := apply(t, st, second, now); !r[0].Duplicate {
		t.Fatalf("duplicate not recognised: %+v", r)
	}
	if after := intDump(t, tenant); after != before {
		t.Fatalf("a duplicate batch changed rows:\n%s\n---\n%s", before, after)
	}
}

// The caps: a service's new series of a UTC day beyond integration_series_cap_per_service_day, the tenant's beyond
// integration_series_cap_per_tenant_day, and new streams beyond integration_stream_cap_per_tenant are dropped
// (stellar_series_overflow) in key order; stored series keep growing; another service still has its own room.
func TestIntegrationCaps(t *testing.T) {
	st := newStore(t, store.Options{SettingsTTL: time.Nanosecond})
	now := time.Now().UTC().Truncate(time.Second)
	pay := func(rm pmetric.ResourceMetrics, ts time.Time, stage string) {
		m := metric(rm, "@usagemap/payments-otel", rules.MetricPaymentEvents)
		s := m.SetEmptySum()
		s.SetIsMonotonic(true)
		s.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
		dp := s.DataPoints().AppendEmpty()
		dp.SetStartTimestamp(pcommon.NewTimestampFromTime(ts.Add(-time.Minute)))
		dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
		dp.SetIntValue(1)
		_ = dp.Attributes().FromRaw(map[string]any{"payment.protocol": "x402", "payment.stage": stage, "payment.network": "stellar:pubnet"})
	}
	send := func(tenant, service string, ts time.Time, stages ...string) {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: service, recv: ts})
		for _, s := range stages {
			pay(rm, ts, s)
		}
		apply(t, st, md, now)
	}
	stored := func(tenant string) string {
		rows, err := superConn(t).Query(context.Background(), `SELECT s.service_name, m.d2, m.count FROM scf.integration_metrics_1d m
		  JOIN scf.api_services s USING (tenant_id, service_id) WHERE m.tenant_id = $1 ORDER BY 1, 2`, tenant)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := ""
		for rows.Next() {
			var svc, stage string
			var n int64
			_ = rows.Scan(&svc, &stage, &n)
			out += fmt.Sprintf("%s/%s=%d ", svc, stage, n)
		}
		return out
	}
	t.Run("series per service and per tenant", func(t *testing.T) {
		setSetting(t, "integration_series_cap_per_service_day", 2)
		setSetting(t, "integration_series_cap_per_tenant_day", 3)
		tenant := newTenant(t)
		// key order: required, settled, verified — verified is over a's cap
		send(tenant, "a", now.Add(-3*time.Minute), "verified", "required", "settled")
		send(tenant, "a", now.Add(-2*time.Minute), "required", "failed") // required grows; failed is over a's cap
		send(tenant, "b", now.Add(-time.Minute), "paid", "settled")      // paid fits the tenant; settled is over it
		if got := stored(tenant); got != "a/required=2 a/settled=1 b/paid=1 " {
			t.Errorf("stored %q", got)
		}
		if n := counter(t, tenant, rules.ReasonStellarSeriesOverflow); n != 3 {
			t.Errorf("stellar_series_overflow = %d, want 3", n)
		}
	})
	t.Run("streams per tenant", func(t *testing.T) {
		setSetting(t, "integration_stream_cap_per_tenant", 1)
		tenant := newTenant(t)
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "capped", recv: now})
		for _, s := range []string{"paid", "failed"} {
			intCounter(rm, "@usagemap/payments-otel", rules.MetricPaymentEvents, now.Add(-time.Minute), now, 1,
				map[string]any{"payment.protocol": "mpp", "payment.stage": s, "payment.network": "stellar:pubnet"})
		}
		apply(t, st, md, now)
		if n := counter(t, tenant, rules.ReasonStellarSeriesOverflow); n != 1 {
			t.Errorf("stellar_series_overflow = %d, want 1", n)
		}
		if n := rowCount(t, `SELECT count(*) FROM scf.integration_stream_state WHERE tenant_id = $1`, tenant); n != 1 {
			t.Errorf("stream rows %d", n)
		}
	})
}

// Time bounds, the backfill bound and malformed points are counted, never stored; one tenant's points never land in
// another's rows.
func TestIntegrationBoundsAndIsolation(t *testing.T) {
	st := newStore(t, store.Options{})
	now := time.Now().UTC().Truncate(time.Second)
	a, b := newTenant(t), newTenant(t)
	md := pmetric.NewMetrics()
	ev := func(rm pmetric.ResourceMetrics, ts time.Time, attrs map[string]any) {
		m := metric(rm, "@usagemap/anchor-otel", rules.MetricAnchorEvents)
		s := m.SetEmptySum()
		s.SetIsMonotonic(true)
		s.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
		dp := s.DataPoints().AppendEmpty()
		dp.SetStartTimestamp(pcommon.NewTimestampFromTime(ts.Add(-time.Minute)))
		dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
		dp.SetIntValue(1)
		_ = dp.Attributes().FromRaw(attrs)
	}
	ok := map[string]any{"stellar.anchor.event": "toml_resolved", "stellar.network": "mainnet"}
	for _, tn := range []string{a, b} {
		rm := resource(md, rsrc{tenant: tn, service: "svc-" + tn[:8], recv: now})
		ev(rm, now.Add(-time.Minute), ok)
		if tn == a {
			ev(rm, now.Add(-2*time.Hour), ok) // before registration (auto-registered now)
			ev(rm, now.Add(3*time.Hour), ok)  // future
			ev(rm, now.Add(-time.Minute), map[string]any{"stellar.anchor.event": "toml_resolved",
				"stellar.anchor.home_domain": "user@example.org", "stellar.network": "mainnet"}) // malformed
		}
	}
	apply(t, st, md, now)
	for reason, want := range map[string]int64{rules.ReasonBeforeRegistration: 1, rules.ReasonFuture: 1, rules.ReasonMalformedPoint: 1} {
		if n := counter(t, a, reason); n != want {
			t.Errorf("%s = %d, want %d", reason, n, want)
		}
	}
	for _, tn := range []string{a, b} {
		if n := rowCount(t, `SELECT count(*) FROM scf.integration_metrics_1h m JOIN scf.api_services s USING (tenant_id, service_id)
		    WHERE m.tenant_id = $1 AND s.service_name = $2`, tn, "svc-"+tn[:8]); n != 1 {
			t.Errorf("tenant %s rows %d", tn[:8], n)
		}
	}
}

// The anchor side through the built Collector (client_metric_sets on, as in collector/config/collector.yaml) → writer
// → PostgreSQL, with the six metrics of tools/ap-listener in its shapes (names, units, attribute keys; the live
// listener needs Kafka). The Collector keeps the closed sets and the vetted client name, turns a key-like client into
// _OTHER, and nothing reaches the API tables.
func TestAnchorPlatformCollectorToDatabase(t *testing.T) {
	p := newPKI(t)
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	_ = startWriter(t, p, e2eWriter, st)
	logs := startCollector(t, p, e2eWriter)
	now := time.Now().UTC()
	start := now.Add(-time.Minute)
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: tenant, service: "anchor-platform", recv: now})
	const scope = "ap-listener"
	base := map[string]any{"stellar.sep": "24", "stellar.anchor.kind": "deposit", "stellar.network": "testnet"}
	with := func(extra map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range base {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	intCounter(rm, scope, rules.MetricAnchorTransferCreated, start, now, 4, with(map[string]any{"stellar.anchor.client": "wallet.example.org"}))
	intCounter(rm, scope, rules.MetricAnchorTransferCreated, start, now, 1, with(map[string]any{
		"stellar.anchor.client": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"}))
	intCounter(rm, scope, rules.MetricAnchorTransitions, start, now, 4, with(map[string]any{
		"stellar.anchor.status_from": "_new", "stellar.anchor.status": "incomplete"}))
	explicit(rm, scope, rules.MetricAnchorStatusDuration, true, start, now, []float64{60, 600, 3600}, []uint64{0, 2, 0, 0}, 600,
		with(map[string]any{"stellar.anchor.status": "pending_anchor"}))
	explicit(rm, scope, rules.MetricAnchorTransferDuration, true, start, now, []float64{60, 600, 3600}, []uint64{0, 0, 1, 0}, 1800,
		with(map[string]any{"stellar.anchor.status": "completed"}))
	intCounter(rm, scope, rules.MetricAnchorCustomerUpdates, start, now, 2, map[string]any{"stellar.anchor.status": "ACCEPTED",
		"stellar.anchor.client": "wallet.example.org", "stellar.network": "testnet"})
	intCounter(rm, scope, rules.MetricAnchorQuotesCreated, start, now, 3, map[string]any{"stellar.network": "testnet"})
	body, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	postToCollector(t, "/v1/metrics", body, tenant)
	const want = 4 + 1 + 4 + 2 + 1 + 2 + 3
	deadline := time.Now().Add(60 * time.Second)
	for intRead(t, "integration_metrics_1h", tenant, "").count < want {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: stored %+v; collector log:\n%s", intRead(t, "integration_metrics_1h", tenant, ""), tail(logs.String(), 3000))
		}
		time.Sleep(300 * time.Millisecond)
	}
	for where, n := range map[string]int64{
		"metric = 'stellar.anchor.transfer.created' AND d5 = 'wallet.example.org'":                      4,
		"metric = 'stellar.anchor.transfer.created' AND d5 = '_OTHER'":                                  1,
		"metric = 'stellar.anchor.transfer.transitions' AND d3 = '_new' AND d4 = 'incomplete'":          4,
		"metric = 'stellar.anchor.transfer.status.duration' AND d4 = 'pending_anchor' AND hist IS NULL": 2,
		"metric = 'stellar.anchor.customer.updates' AND d4 = 'ACCEPTED'":                                2,
		"metric = 'stellar.anchor.quotes.created' AND d5 = '_none'":                                     3,
	} {
		if got := intRead(t, "integration_metrics_1d", tenant, where); got.count != n {
			t.Errorf("%s: %d, want %d", where, got.count, n)
		}
	}
	if td := intRead(t, "integration_metrics_1d", tenant, "metric = 'stellar.anchor.transfer.duration'"); td.count != 1 || td.sum != 1800 {
		t.Errorf("transfer duration %+v", td)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.integration_metrics_1d WHERE tenant_id = $1
	   AND concat_ws('|', d1, d2, d3, d4, d5, d6, d7) ~ '(G[A-Z2-7]{55}|://)'`, tenant); n != 0 {
		t.Errorf("%d rows carry raw values", n)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_metrics_1m WHERE tenant_id = $1`, tenant); n != 0 {
		t.Errorf("anchor metrics counted as API traffic: %d rows", n)
	}
	if n := counter(t, tenant, rules.ReasonMetricNotAllowed); n != 0 {
		t.Errorf("metric_not_allowed = %d: the Collector's client_metric_sets are off", n)
	}
}
