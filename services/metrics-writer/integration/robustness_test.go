// SPDX-License-Identifier: Apache-2.0

package integration

// Regression tests for the writer's robustness rules:
// tenant status, failure classes, timeouts and poison parts, pool exhaustion, in-flight retries and the
// stream-state bound — against real PostgreSQL through PgBouncer as scf_writer.

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

// applyAll decodes md and applies every tenant part, returning the results and the first error.
func applyAll(t testing.TB, st *store.Store, md pmetric.Metrics, now time.Time) ([]store.Result, error) {
	t.Helper()
	body, err := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	if err != nil {
		t.Fatal(err)
	}
	b, err := batch.Decode(body, now)
	if err != nil {
		t.Fatal(err)
	}
	var out []store.Result
	for _, p := range b.Parts {
		r, err := st.Apply(context.Background(), b.Key, p)
		if err != nil {
			return out, err
		}
		out = append(out, r)
	}
	return out, nil
}

func onePoint(tenant, service string, now time.Time) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: tenant, service: service, recv: now})
	explicit(rm, "s", rules.MetricStable, false, now.Add(-2*time.Minute), now.Add(-time.Minute), bounds15,
		[]uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001, pointAttrs("/a", nil))
	return md
}

// injectTrigger makes every INSERT of the tenant into scf.<table> run body (PL/pgSQL), e.g. a RAISE with a chosen
// SQLSTATE or a pg_sleep. Superuser, test database only; removed on cleanup (or by the returned function).
func injectTrigger(t testing.TB, tenant, table, body string) (remove func()) {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("scf_wsd_inject_%d", time.Now().UnixNano())
	su := superConn(t)
	if _, err := su.Exec(ctx, fmt.Sprintf(`CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.tenant_id = %s::uuid THEN %s; END IF;
  RETURN NEW;
END $f$`, name, quoteLit(tenant), body)); err != nil {
		t.Fatal(err)
	}
	if _, err := su.Exec(ctx, fmt.Sprintf(`CREATE TRIGGER %s BEFORE INSERT ON scf.%s FOR EACH ROW EXECUTE FUNCTION public.%s()`,
		name, table, name)); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	remove = func() {
		once.Do(func() {
			_, _ = superConn(t).Exec(ctx, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON scf.%s`, name, table))
			_, _ = superConn(t).Exec(ctx, fmt.Sprintf(`DROP FUNCTION IF EXISTS public.%s()`, name))
		})
	}
	t.Cleanup(remove)
	return remove
}

func quoteLit(s string) string { return "'" + s + "'" }

// setTenant changes lifecycle columns of a tenant directly (superuser, triggers off for this transaction: the
// status guard only lets the operator functions do this, which these tests do not exercise).
func setTenant(t testing.TB, tenant, set string) {
	t.Helper()
	ctx := context.Background()
	tx, err := superConn(t).Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL session_replication_role = replica`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE scf.tenants SET `+set+` WHERE tenant_id = $1`, tenant); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

// A removed (purged) tenant's requests still queued at the edge recreate nothing — no ledger row, service,
// audit row, route, stream state, metric or counter — and neither do requests of an unknown tenant.
func TestRemovedTenantGetsNothing(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	// The tenant is removed and tenant_purge has run (purged_at set).
	setTenant(t, tenant, `status = 'removed', removed_at = now(), purge_after = now(), purged_at = now()`)
	ghost := "0198dead-0000-7000-8000-0000000000aa" // no tenants row at all
	md := mixedPayload(tenant, now, rand.New(rand.NewPCG(7, 11)))
	other := onePoint(ghost, "svc", now)
	other.ResourceMetrics().MoveAndAppendTo(md.ResourceMetrics())
	res, err := applyAll(t, st, md, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 2 || !res[0].TenantGone || !res[1].TenantGone {
		t.Fatalf("results %+v, want both tenant_gone", res)
	}
	for _, tn := range []string{tenant, ghost} {
		if d := dump(t, tn); d != "" {
			t.Errorf("%s: rows written for a removed/unknown tenant:\n%s", tn, d)
		}
		for _, q := range []string{`SELECT count(*) FROM scf.api_ingest_ledger WHERE tenant_id = $1`,
			`SELECT count(*) FROM scf.api_ingest_counters WHERE tenant_id = $1`} {
			if n := rowCount(t, q, tn); n != 0 {
				t.Errorf("%s: %s = %d", tn, q, n)
			}
		}
	}
	// Removed but not purged yet: also nothing (tenant_purge would have to find and delete it again).
	pending := newTenant(t)
	setTenant(t, pending, `status = 'removed', removed_at = now(), purge_after = now() + interval '30 days'`)
	if res, err := applyAll(t, st, onePoint(pending, "svc", now), now); err != nil || !res[0].TenantGone {
		t.Fatalf("removed tenant: %+v %v", res, err)
	}
	// A suspended tenant keeps the data it sent before the suspension.
	suspended := newTenant(t)
	setTenant(t, suspended, `status = 'suspended'`)
	if res, err := applyAll(t, st, onePoint(suspended, "svc", now), now); err != nil || res[0].TenantGone || res[0].Applied != 1 {
		t.Fatalf("suspended tenant: %+v %v", res, err)
	}
}

// A non-transient SQL error caused by the data rolls that tenant back, is counted tenant_write_error and leaves the
// other tenants of the same request unaffected (C-112(1)). (A tenant without a row is tenant_gone, so the error is injected.)
func TestTenantWriteErrorIsIsolated(t *testing.T) {
	good, bad := newTenant(t), newTenant(t)
	injectTrigger(t, bad, "api_routes", `RAISE EXCEPTION 'injected check violation' USING ERRCODE = '23514'`)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	md := onePoint(bad, "svc", now)
	onePoint(good, "svc", now).ResourceMetrics().MoveAndAppendTo(md.ResourceMetrics())
	res, err := applyAll(t, st, md, now)
	if err != nil {
		t.Fatal(err)
	}
	var sawError, sawOK bool
	for _, r := range res {
		sawError = sawError || r.WriteError
		sawOK = sawOK || (!r.WriteError && r.Applied == 1)
	}
	if !sawError || !sawOK {
		t.Fatalf("results %+v", res)
	}
	if got := counter(t, bad, rules.ReasonTenantWriteError); got != 1 {
		t.Fatalf("tenant_write_error = %d", got)
	}
	if tot := readTotals(t, "api_metrics_1m", good, ""); tot.count != 1 {
		t.Fatalf("good tenant count = %d", tot.count)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_ingest_ledger WHERE tenant_id = $1`, bad); n != 0 {
		t.Fatal("the failed tenant's ledger row survived the rollback")
	}
}

// Conditions of the infrastructure — a read-only transaction during a switchover, disk full, out of memory,
// an I/O error, a missing privilege — are not the batch's fault. They are retryable (ErrUnavailable: 503, listener
// closes), nothing is counted as tenant_write_error, and the retry applies the batch once the condition is gone.
func TestInfrastructureErrorsAreRetried(t *testing.T) {
	for _, code := range []string{"25006", "53100", "53200", "58030", "42501"} {
		t.Run(code, func(t *testing.T) {
			tenant := newTenant(t)
			remove := injectTrigger(t, tenant, "api_routes",
				fmt.Sprintf(`RAISE EXCEPTION 'injected %s' USING ERRCODE = '%s'`, code, code))
			st := newStore(t, store.Options{})
			now := time.Now().UTC()
			md := onePoint(tenant, "svc", now)
			if _, err := applyAll(t, st, md, now); !errors.Is(err, store.ErrUnavailable) {
				t.Fatalf("err = %v, want ErrUnavailable", err)
			}
			if got := counter(t, tenant, rules.ReasonTenantWriteError); got != 0 {
				t.Fatalf("tenant_write_error = %d: an infrastructure error was blamed on the batch", got)
			}
			remove()
			res, err := applyAll(t, st, md, now) // the Collector's retry of the same bytes
			if err != nil || res[0].Applied != 1 || res[0].Duplicate {
				t.Fatalf("retry: %+v %v", res, err)
			}
		})
	}
}

// Findings 4 and 5: a tenant transaction that runs out of time is ErrBusy (503 without closing the listener), not a
// lost database; one that keeps timing out is dropped as poison (tenant_write_error) instead of being retried for
// 72 hours.
func TestTimeoutIsBusyThenPoison(t *testing.T) {
	tenant := newTenant(t)
	injectTrigger(t, tenant, "api_ingest_ledger", `PERFORM pg_sleep(3)`)
	st := newStore(t, store.Options{TxTimeout: 400 * time.Millisecond, PoisonAttempts: 2, PoisonWindow: -1})
	now := time.Now().UTC()
	md := onePoint(tenant, "svc", now)
	_, err := applyAll(t, st, md, now)
	if !errors.Is(err, store.ErrBusy) || errors.Is(err, store.ErrUnavailable) {
		t.Fatalf("first timeout: %v, want ErrBusy only", err)
	}
	if store.IsConnectionLoss(err) {
		t.Fatal("a timeout counts as connection loss")
	}
	res, err := applyAll(t, st, md, now)
	if err != nil || len(res) != 1 || !res[0].WriteError {
		t.Fatalf("second timeout: %+v %v, want a poison write error", res, err)
	}
	if got := counter(t, tenant, rules.ReasonTenantWriteError); got != 1 {
		t.Fatalf("tenant_write_error = %d", got)
	}
}

// An exhausted pool is busy, not a lost database.
func TestPoolExhaustionIsBusy(t *testing.T) {
	ctx := context.Background()
	tenant := newTenant(t)
	pool := writerPool(t, 1)
	st := store.New(pool, store.Options{TxTimeout: 300 * time.Millisecond})
	held, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	md := onePoint(tenant, "svc", now)
	_, err = applyAll(t, st, md, now)
	if !errors.Is(err, store.ErrBusy) || errors.Is(err, store.ErrUnavailable) {
		held.Release()
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	held.Release()
	if err := st.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if res, err := applyAll(t, st, md, now); err != nil || res[0].Applied != 1 {
		t.Fatalf("after release: %+v %v", res, err)
	}
}

// A retry of a request still being applied (same tenant and batch key) waits for the first transaction
// instead of opening a second one; it then finds the ledger row and is a duplicate.
func TestRetryWaitsForInFlightBatch(t *testing.T) {
	tenant := newTenant(t)
	remove := injectTrigger(t, tenant, "api_routes", `PERFORM pg_sleep(1)`)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	md := onePoint(tenant, "svc", now)
	var wg sync.WaitGroup
	results := make([][]store.Result, 2)
	errs := make([]error, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i == 1 {
				time.Sleep(200 * time.Millisecond)
			}
			results[i], errs[i] = applyAll(t, st, md, now)
		}()
	}
	wg.Wait()
	remove()
	if errs[0] != nil || errs[1] != nil {
		t.Fatalf("errors %v %v", errs[0], errs[1])
	}
	if results[0][0].Applied != 1 || !results[1][0].Duplicate {
		t.Fatalf("results %+v %+v, want applied then duplicate", results[0], results[1])
	}
	if tot := readTotals(t, "api_metrics_1m", tenant, ""); tot.count != 1 {
		t.Fatalf("count = %d", tot.count)
	}
}

// upsertSetting sets a writer setting that may not have a row in scf.settings yet (new keys use the writer's
// defaults until a migration seeds them).
func upsertSetting(t testing.TB, key string, value int) {
	t.Helper()
	ctx := context.Background()
	var old *string
	_ = superConn(t).QueryRow(ctx, `SELECT value::text FROM scf.settings WHERE key = $1`, key).Scan(&old)
	if _, err := superConn(t).Exec(ctx, `INSERT INTO scf.settings (key, value, description) VALUES ($1, to_jsonb($2::int), 'test')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, key, value); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if old == nil {
			_, _ = superConn(t).Exec(ctx, `DELETE FROM scf.settings WHERE key = $1`, key)
		} else {
			_, _ = superConn(t).Exec(ctx, `UPDATE scf.settings SET value = $2::jsonb WHERE key = $1`, key, *old)
		}
	})
}

// Cumulative stream keys hash the raw route, so 50 distinct literal routes used to create 50 state rows
// (and 100 k routes 100 k rows) although the cardinality guard admits only a few routes. Now a new route gets state
// only within the tenant's route capacity, the tenant's state rows are capped, and the rest is counted route_overflow.
func TestStreamStateIsBounded(t *testing.T) {
	setSetting(t, "route_cap_per_tenant_day", 5)
	tenant := newTenant(t)
	st := newStore(t, store.Options{SettingsTTL: time.Nanosecond})
	now := time.Now().UTC()
	start := now.Add(-time.Hour) // a long-running process: its first export only seeds
	send := func(ts time.Time, n uint64) {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "raw", instance: "i-1", recv: now})
		for i := range 50 {
			explicit(rm, "s", rules.MetricStable, true, start, ts, bounds15,
				[]uint64{n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001*float64(n),
				pointAttrs(fmt.Sprintf("/orders/x%02d", i), nil))
		}
		if _, err := applyAll(t, st, md, now); err != nil {
			t.Fatal(err)
		}
	}
	states := func() int64 {
		return rowCount(t, `SELECT count(*) FROM scf.api_stream_state WHERE tenant_id = $1`, tenant)
	}
	send(now.Add(-3*time.Minute), 10)
	if n := states(); n != 5+1 {
		t.Fatalf("%d state rows after 50 new routes with route capacity 5, want 6 (5 streams + 1 source)", n)
	}
	if got := counter(t, tenant, rules.ReasonRouteOverflow); got != 45 {
		t.Fatalf("route_overflow = %d, want 45", got)
	}
	send(now.Add(-2*time.Minute), 11) // the 5 tracked streams deliver +1 each and are admitted by the guard
	send(now.Add(-time.Minute), 12)   // capacity used up: no new state
	if n := states(); n > 5+5+1 {
		t.Fatalf("%d state rows: growth beyond the route capacity", n)
	}
	if tot := readTotals(t, "api_metrics_1m", tenant, ""); tot.count < 5 {
		t.Fatalf("the admitted streams counted %d requests", tot.count)
	}
	// The per-tenant state cap holds whatever the route capacity.
	setSetting(t, "route_cap_per_tenant_day", 5000)
	upsertSetting(t, "stream_state_cap_per_tenant", 3)
	capped := newTenant(t)
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: capped, service: "raw", instance: "i-1", recv: now})
	for i := range 20 {
		explicit(rm, "s", rules.MetricStable, true, start, now.Add(-time.Minute), bounds15,
			[]uint64{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.001, pointAttrs(fmt.Sprintf("/r%02d", i), nil))
	}
	if _, err := applyAll(t, st, md, now); err != nil {
		t.Fatal(err)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_stream_state WHERE tenant_id = $1`, capped); n != 3 {
		t.Fatalf("%d state rows with a cap of 3", n)
	}
}

// The Collector now sends scf.stream.instance = "_" for a service.instance.id it had to
// redact (an IP or host:port), so two replicas are told apart by their start times instead of sharing one stream
// whose alternating exports looked like resets. Replica A (+100/min) and replica B (+50/min) alternate for 6 minutes.
func TestRedactedInstancesStayDistinct(t *testing.T) {
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC().Truncate(time.Second)
	startA, startB := now.Add(-time.Hour), now.Add(-55*time.Minute)
	send := func(start, ts time.Time, n uint64) {
		md := pmetric.NewMetrics()
		rm := resource(md, rsrc{tenant: tenant, service: "replicated", instance: "_", recv: now})
		explicit(rm, "s", rules.MetricStable, true, start, ts, []float64{0.25}, []uint64{n, 0}, 0.01*float64(n),
			pointAttrs("/items/{int}", nil))
		if _, err := applyAll(t, st, md, now); err != nil {
			t.Fatal(err)
		}
	}
	base := now.Add(-7 * time.Minute)
	for i := range 6 {
		ts := base.Add(time.Duration(i) * time.Minute)
		send(startA, ts, uint64(1000+100*i))
		send(startB, ts.Add(30*time.Second), uint64(500+50*i))
	}
	// The first export of each long-running replica seeds; the next five deltas count: 5×100 + 5×50.
	if tot := readTotals(t, "api_metrics_1m", tenant, ""); tot.count != 750 {
		t.Fatalf("counted %d requests, want 750", tot.count)
	}
	if got := counter(t, tenant, rules.ReasonCumulativeReset); got != 0 {
		t.Fatalf("cumulative_reset = %d: the replicas shared a stream", got)
	}
}
