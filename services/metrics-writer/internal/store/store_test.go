// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// ---- failure classes ----------------------------------------------------

func pgErr(code, msg string) error { return &pgconn.PgError{Code: code, Message: msg} }

func TestClassifySQLStates(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want failClass
	}{
		// The batch's own fault or a bug: acknowledged, counted tenant_write_error.
		{"unique violation", pgErr("23505", "duplicate key"), failData},
		{"check violation", pgErr("23514", "check"), failData},
		{"foreign key", pgErr("23503", "fk"), failData},
		{"numeric overflow", pgErr("22003", "out of range"), failData},
		{"invalid text", pgErr("22P02", "invalid input"), failData},
		{"internal error (bug)", pgErr("XX000", "bug"), failData},
		{"undefined column (bug)", pgErr("42703", "column"), failData},
		// Infrastructure that cannot write: 503 and close the listener.
		{"read-only transaction (switchover)", pgErr("25006", "cannot execute INSERT in a read-only transaction"), failUnavailable},
		{"disk full", pgErr("53100", "could not extend file"), failUnavailable},
		{"out of memory", pgErr("53200", "out of memory"), failUnavailable},
		{"too many connections", pgErr("53300", "too many"), failUnavailable},
		{"I/O error", pgErr("58030", "could not read block"), failUnavailable},
		{"operator intervention", pgErr("57000", "operator"), failUnavailable},
		{"data corrupted", pgErr("XX001", "corrupt"), failUnavailable},
		{"missing privilege after a deployment", pgErr("42501", "permission denied for table tenants"), failUnavailable},
		// Connection gone.
		{"admin shutdown", pgErr("57P01", "terminating connection"), failLost},
		{"crash shutdown", pgErr("57P02", "crash"), failLost},
		{"cannot connect now", pgErr("57P03", "starting up"), failLost},
		{"connection failure", pgErr("08006", "connection failure"), failLost},
		// Out of time or conflicting: 503 without closing, counted toward the poison limit.
		{"statement timeout", pgErr("57014", "canceling statement due to statement timeout"), failTimeout},
		{"cancelled by our deadline", pgErr("57014", "canceling statement due to user request"), failTimeout},
		{"lock timeout", pgErr("55P03", "lock not available"), failTimeout},
		{"deadlock", pgErr("40P01", "deadlock"), failTimeout},
		{"serialisation", pgErr("40001", "could not serialize"), failTimeout},
	}
	for _, c := range cases {
		if got := classify(fmt.Errorf("wrapped: %w", c.err)); got != c.want {
			t.Errorf("%s: class %v, want %v", c.name, got, c.want)
		}
	}
}

type netTimeout struct{}

func (netTimeout) Error() string   { return "i/o timeout" }
func (netTimeout) Timeout() bool   { return true }
func (netTimeout) Temporary() bool { return true }

func TestClassifyGoErrors(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want failClass
	}{
		{"nil", nil, failData},
		{"plain error (bug)", errors.New("something odd"), failData},
		{"our sentinel", fmt.Errorf("x: %w", ErrUnavailable), failLost},
		{"busy sentinel", fmt.Errorf("x: %w", ErrBusy), failBusy},
		// A pool that had no connection for us within the budget is not a lost database.
		{"pool wait timed out", fmt.Errorf("%w: %w", errNotStarted, context.DeadlineExceeded), failBusy},
		{"transaction deadline", fmt.Errorf("query: %w", context.DeadlineExceeded), failTimeout},
		{"transaction cancelled", context.Canceled, failTimeout},
		{"EOF", io.EOF, failLost},
		{"unexpected EOF", io.ErrUnexpectedEOF, failLost},
		{"closed network connection", net.ErrClosed, failLost},
		{"network timeout", &net.OpError{Op: "read", Err: netTimeout{}}, failLost},
		{"conn closed text", errors.New("conn closed"), failLost},
		{"connection reset text", errors.New("read: connection reset by peer"), failLost},
	}
	for _, c := range cases {
		if got := classify(c.err); got != c.want {
			t.Errorf("%s: class %v, want %v", c.name, got, c.want)
		}
	}
}

func TestIsConnectionLossOnlyForListenerClosingClasses(t *testing.T) {
	for _, err := range []error{pgErr("08006", ""), pgErr("25006", ""), pgErr("53100", ""), io.EOF} {
		if !IsConnectionLoss(err) {
			t.Errorf("%v: want connection loss (listener closes)", err)
		}
	}
	// Before the fix every one of these closed the listener on a healthy database.
	for _, err := range []error{nil, context.DeadlineExceeded, fmt.Errorf("%w: x", errNotStarted),
		pgErr("57014", "canceling statement due to statement timeout"), pgErr("23505", ""), pgErr("40P01", "")} {
		if IsConnectionLoss(err) {
			t.Errorf("%v: must not close the listener", err)
		}
	}
}

func TestRetryableConflicts(t *testing.T) {
	if !isRetryable(pgErr("40P01", "")) || !isRetryable(pgErr("40001", "")) {
		t.Fatal("deadlock and serialisation failures are retried in the transaction loop")
	}
	if isRetryable(pgErr("57014", "")) || isRetryable(context.DeadlineExceeded) {
		t.Fatal("timeouts are not retried inside Apply")
	}
}

func TestSQLStateAndErrorClassAreLogSafe(t *testing.T) {
	e := &pgconn.PgError{Code: "23505", Message: "duplicate key value (route)=(/u/alice)", ConstraintName: "api_routes_pkey"}
	if sqlState(e) != "23505" || sqlState(errors.New("x")) != "" {
		t.Fatal("sqlState")
	}
	if got := errorClass(e); got != "sql:api_routes_pkey" {
		t.Fatalf("errorClass = %q (must never carry the message)", got)
	}
}

// ---- in-flight deduplication --------------------------------------------------------------------------

func TestFlightsSerialiseOneBatchKey(t *testing.T) {
	var f flights
	k := flightKey{"t", [32]byte{1}}
	release, err := f.acquire(context.Background(), k)
	if err != nil {
		t.Fatal(err)
	}
	// Another key is independent.
	r2, err := f.acquire(context.Background(), flightKey{"t", [32]byte{2}})
	if err != nil {
		t.Fatal(err)
	}
	r2()
	// The same key waits for the first.
	var got atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		r, err := f.acquire(context.Background(), k)
		if err != nil {
			t.Error(err)
			return
		}
		got.Store(true)
		r()
	}()
	time.Sleep(50 * time.Millisecond)
	if got.Load() {
		t.Fatal("a retry of the same batch key ran while the first was in flight")
	}
	release()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the waiter was not released")
	}
	if !got.Load() {
		t.Fatal("the waiter never ran")
	}
}

func TestFlightsWaitEndsWithTheBudget(t *testing.T) {
	var f flights
	k := flightKey{"t", [32]byte{9}}
	release, _ := f.acquire(context.Background(), k)
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := f.acquire(ctx, k); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the budget's deadline", err)
	}
}

func TestFlightsManyWaiters(t *testing.T) {
	var f flights
	k := flightKey{"t", [32]byte{3}}
	var inside, maxInside atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.acquire(context.Background(), k)
			if err != nil {
				t.Error(err)
				return
			}
			n := inside.Add(1)
			for {
				m := maxInside.Load()
				if n <= m || maxInside.CompareAndSwap(m, n) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			inside.Add(-1)
			r()
		}()
	}
	wg.Wait()
	if maxInside.Load() != 1 {
		t.Fatalf("%d transactions of one batch key ran at once", maxInside.Load())
	}
	if len(f.m) != 0 {
		t.Fatalf("flights left behind: %d", len(f.m))
	}
}

// ---- poison messages ----------------------------------------------------------------------------------

func TestAttemptTrackerNeedsCountAndWindow(t *testing.T) {
	a := attemptTracker{attempts: 3, window: 10 * time.Minute}
	k := flightKey{"t", [32]byte{1}}
	t0 := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	// Three quick timeouts are not enough: a lock storm of a minute must not drop data.
	for i := range 3 {
		if a.timedOut(k, t0.Add(time.Duration(i)*time.Second)) {
			t.Fatalf("poison after %d quick attempts", i+1)
		}
	}
	// Ten minutes after the first, the next timeout makes it poison.
	if !a.timedOut(k, t0.Add(10*time.Minute)) {
		t.Fatal("a part that keeps timing out for 10 minutes must be poison")
	}
	// Forgotten after commit (or drop): a new run starts from zero.
	a.forget(k)
	if a.timedOut(k, t0.Add(11*time.Minute)) {
		t.Fatal("forget did not reset the count")
	}
	// Other keys are independent.
	if a.timedOut(flightKey{"t", [32]byte{2}}, t0.Add(20*time.Minute)) {
		t.Fatal("keys share counts")
	}
}

func TestAttemptTrackerZeroWindow(t *testing.T) {
	a := attemptTracker{attempts: 2, window: 0}
	k := flightKey{"t", [32]byte{1}}
	now := time.Now()
	if a.timedOut(k, now) || !a.timedOut(k, now) {
		t.Fatal("with a zero window the second timeout is poison")
	}
}

func TestAttemptTrackerIsBounded(t *testing.T) {
	a := attemptTracker{attempts: 5, window: time.Minute}
	t0 := time.Now()
	for i := range attemptsCapacity + 50 {
		var key [32]byte
		key[0], key[1], key[2] = byte(i), byte(i>>8), byte(i>>16)
		a.timedOut(flightKey{"t", key}, t0.Add(time.Duration(i)*time.Millisecond))
	}
	if n := a.len(); n > attemptsCapacity {
		t.Fatalf("tracker holds %d entries, capacity %d", n, attemptsCapacity)
	}
	// At capacity, entries idle for longer than the TTL are pruned first.
	a.timedOut(flightKey{"other", [32]byte{}}, t0.Add(2*attemptsTTL))
	if n := a.len(); n != 1 {
		t.Fatalf("after the TTL %d entries remain, want 1", n)
	}
}

func TestNewAppliesDefaults(t *testing.T) {
	s := New(nil, Options{})
	if s.opt.TxTimeout != 10*time.Second || s.opt.DeadlockRetries != 3 || s.opt.SettingsTTL != time.Minute ||
		s.opt.PartitionsTTL != time.Hour {
		t.Fatalf("defaults %+v", s.opt)
	}
	if s.tries.attempts != DefaultPoisonAttempts || s.tries.window != DefaultPoisonWindow {
		t.Fatalf("poison defaults %d/%s", s.tries.attempts, s.tries.window)
	}
	s = New(nil, Options{PoisonAttempts: 2, PoisonWindow: -1})
	if s.tries.attempts != 2 || s.tries.window != 0 {
		t.Fatalf("poison options %d/%s", s.tries.attempts, s.tries.window)
	}
}

// ---- stream-state bound -------------------------------------------------------------------------------

func key(b byte) [32]byte { return [32]byte{b} }

func TestAdmitStreamsKnownRoutesFirst(t *testing.T) {
	src := key(100)
	streams := []newStream{
		{key: key(1), source: src, day: "2026-11-18", route: routeKey{"s", "/x/a1", "", "v"}},
		{key: key(2), source: src, day: "2026-11-18", route: routeKey{"s", "/x/a2", "", "v"}},
		{key: key(3), source: src, day: "2026-11-18", route: routeKey{"s", "/known", "", "v"}, known: true},
	}
	admitted, sources := admitStreams(streams, streamBudget{routesLeft: map[string]int64{"2026-11-18": 1}, rowsLeft: 100})
	if !admitted[key(3)] || !admitted[key(1)] || admitted[key(2)] {
		t.Fatalf("admitted %v: want the known route and one new route (capacity 1)", admitted)
	}
	if len(sources) != 0 {
		t.Fatal("no new source")
	}
}

func TestAdmitStreamsOneRouteManyStreams(t *testing.T) {
	// One new route with several streams (methods, status codes) uses one unit of route capacity.
	r := routeKey{"s", "/new", "", "v"}
	var streams []newStream
	for i := range 5 {
		streams = append(streams, newStream{key: key(byte(i + 1)), source: key(100), day: "d", route: r})
	}
	admitted, _ := admitStreams(streams, streamBudget{routesLeft: map[string]int64{"d": 1}, rowsLeft: 100})
	if len(admitted) != 5 {
		t.Fatalf("admitted %d of 5 streams of one route", len(admitted))
	}
}

func TestAdmitStreamsRowCapCountsNewSources(t *testing.T) {
	streams := []newStream{
		{key: key(1), source: key(100), sourceNew: true, day: "d", known: true},
		{key: key(2), source: key(100), sourceNew: true, day: "d", known: true},
		{key: key(3), source: key(101), sourceNew: true, day: "d", known: true},
	}
	// 3 rows: stream 1 + its new source (2), stream 2 (1); stream 3 would need 2 more.
	admitted, sources := admitStreams(streams, streamBudget{routesLeft: map[string]int64{}, rowsLeft: 3})
	if !admitted[key(1)] || !admitted[key(2)] || admitted[key(3)] {
		t.Fatalf("admitted %v", admitted)
	}
	if !sources[key(100)] || sources[key(101)] {
		t.Fatalf("sources %v", sources)
	}
	// A full tenant admits nothing, known or not.
	admitted, _ = admitStreams(streams, streamBudget{rowsLeft: 0})
	if len(admitted) != 0 {
		t.Fatalf("admitted %v at the cap", admitted)
	}
}

// The audit scenario: 10 000 distinct literal routes in one request create at most the route capacity of state rows.
func TestAdmitStreamsTenThousandRoutes(t *testing.T) {
	var streams []newStream
	for i := range 10000 {
		var k [32]byte
		k[0], k[1] = byte(i), byte(i>>8)
		streams = append(streams, newStream{key: k, source: key(255), day: "d",
			route: routeKey{"s", fmt.Sprintf("/orders/x%05d", i), "", "v"}})
	}
	budget := streamBudget{routesLeft: map[string]int64{"d": 1000}, rowsLeft: 250000}
	admitted, _ := admitStreams(streams, budget)
	if len(admitted) != 1000 {
		t.Fatalf("%d state rows for 10 000 new routes, want the 1000 the route capacity allows", len(admitted))
	}
	if budget.routesLeft["d"] != 1000 {
		t.Fatal("admitStreams changed the caller's budget")
	}
	// Deterministic: the same input admits the same keys whatever the order.
	slices.Reverse(streams)
	again, _ := admitStreams(streams, budget)
	for k := range admitted {
		if !again[k] {
			t.Fatal("admission depends on input order")
		}
	}
}

// ---- small helpers ------------------------------------------------------------------------------------------------

func TestCounterSetAggregates(t *testing.T) {
	c := counterSet{}
	c.add("2026-11-18", zeroService, rules.ReasonRouteOverflow, 2)
	c.add("2026-11-18", zeroService, rules.ReasonRouteOverflow, 3)
	c.add("2026-11-18", zeroService, rules.ReasonTooOld, 0)  // ignored
	c.add("2026-11-18", zeroService, rules.ReasonFuture, -1) // ignored
	if len(c) != 1 || c[[3]string{"2026-11-18", zeroService, rules.ReasonRouteOverflow}] != 5 {
		t.Fatalf("counters %v", c)
	}
}

func TestCounterSetEmptyWriteIsNoop(t *testing.T) {
	if err := (counterSet{}).write(context.Background(), nil, "t"); err != nil {
		t.Fatal(err)
	}
}

func TestPgArrayAndClamp(t *testing.T) {
	if got := pgArray([]uint64{0, 5, 1 << 63}); got != "{0,5,9223372036854775807}" {
		t.Fatalf("pgArray = %s", got)
	}
	if pgArray(nil) != "{}" {
		t.Fatal("empty array")
	}
	if clampI64(1<<64-1) != 1<<63-1 || clampI64(7) != 7 {
		t.Fatal("clampI64")
	}
}

func TestDayOfIsUTC(t *testing.T) {
	loc := time.FixedZone("x", 5*3600)
	if got := dayOf(time.Date(2026, 11, 19, 2, 0, 0, 0, loc)); got != "2026-11-18" {
		t.Fatalf("dayOf = %s", got)
	}
}

func TestDropPending(t *testing.T) {
	a, b, c := &pending{}, &pending{}, &pending{}
	if got := dropPending([]*pending{a, b, c}, nil); len(got) != 3 {
		t.Fatal("nothing to drop")
	}
	got := dropPending([]*pending{a, b, c}, map[*pending]bool{b: true})
	if len(got) != 2 || got[0] != a || got[1] != c {
		t.Fatalf("got %v", got)
	}
}

func TestPartitionCheck(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	s := New(nil, Options{Now: func() time.Time { return now }})
	day := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	s.parts.ranges = map[string][][2]time.Time{
		"api_metrics_1m": {{day, day.AddDate(0, 0, 1)}},
		"api_metrics_1h": {{day.AddDate(0, 0, -17), day.AddDate(0, 0, 13)}},
		"api_metrics_1d": {{day.AddDate(0, -10, -17), day.AddDate(0, 2, 13)}},
	}
	if ok, _ := s.check(now); !ok {
		t.Fatal("covered time refused")
	}
	if ok, r := s.check(day.Add(-time.Minute)); ok || r != rules.ReasonTooOld {
		t.Fatalf("before the 1m partition: %v %s", ok, r)
	}
	if ok, r := s.check(day.AddDate(0, 0, 1).Add(time.Minute)); ok || r != rules.ReasonFuture {
		t.Fatalf("after the 1m partition: %v %s", ok, r)
	}
}

func TestSettingDefaultsCoverEveryKey(t *testing.T) {
	for _, k := range settingKeys {
		if _, ok := settingDefaults[k]; !ok {
			t.Errorf("setting %s has no default", k)
		}
	}
	if settingDefaults["stream_state_cap_per_tenant"] <= settingDefaults["route_cap_per_tenant_day"] ||
		settingDefaults["l0_stream_state_cap"] <= settingDefaults["l0_routes_per_day"] {
		t.Fatal("the state caps must leave room for every admitted route")
	}
}
