// SPDX-License-Identifier: Apache-2.0

// Package store applies one tenant's part of a request in one transaction under that tenant's context
// (scf.set_tenant_ctx(), role scf_writer, through PgBouncer — C-23, C-103), following docs/data-model.md §8.11:
// ledger → services → stream groups → cumulative state → routes and cardinality guard → additive upserts into
// _1d, _1h, _1m → day-group presence → data-quality counters.
package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// ErrUnavailable wraps every failure that means the database cannot take writes: the connection is lost, or the
// database answers but cannot write (read-only during a switchover, disk full, I/O error, out of memory, a missing
// privilege). The server answers 503 for the request in flight and closes its listener until the probe succeeds
// (wire-formats §g.3, C-107).
var ErrUnavailable = errors.New("database unavailable")

// ErrBusy wraps transient failures of a reachable database: no pooled connection or no turn within the budget, a
// tenant transaction that ran out of time, or a conflict that persisted after the in-transaction retries. The server
// answers 503 + Retry-After but keeps its listener open.
var ErrBusy = errors.New("database busy")

// Observer receives the writer's own counts (Prometheus); every method must be safe for concurrent use.
type Observer interface {
	Outcome(outcome string)                   // tenant transactions: committed, duplicate, write_error, unavailable, busy, timeout, poison, tenant_gone, retried
	Reason(reason string, n int64)            // data-quality reasons the writer counted (also written to the database)
	Points(outcome string, n int64)           // points by outcome: applied, dropped, seeded, stale, zero_delta, tenant_gone
	TxSeconds(d time.Duration, result string) // tenant transaction duration
}

type nopObserver struct{}

func (nopObserver) Outcome(string)                  {}
func (nopObserver) Reason(string, int64)            {}
func (nopObserver) Points(string, int64)            {}
func (nopObserver) TxSeconds(time.Duration, string) {}

// Options configure a Store.
type Options struct {
	Observer        Observer
	Logger          *slog.Logger
	Now             func() time.Time // writer clock (tests)
	TxTimeout       time.Duration    // per tenant transaction (default 10 s)
	SettingsTTL     time.Duration    // default 60 s
	PartitionsTTL   time.Duration    // default 1 h (and on a miss, at most once a minute)
	DeadlockRetries int              // default 3
	PoisonAttempts  int              // timed-out attempts before a part is dropped as poison (default 5)
	PoisonWindow    time.Duration    // … and at least this long after the first one (default 10 min; < 0 means 0)
}

// Store writes tenant parts.
type Store struct {
	pool  *pgxpool.Pool
	obs   Observer
	log   *slog.Logger
	now   func() time.Time
	opt   Options
	sets  settingsCache
	parts partitionCache
	fl    flights
	tries attemptTracker
}

// New returns a Store over pool.
func New(pool *pgxpool.Pool, o Options) *Store {
	if o.Observer == nil {
		o.Observer = nopObserver{}
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.TxTimeout <= 0 {
		o.TxTimeout = 10 * time.Second
	}
	if o.SettingsTTL <= 0 {
		o.SettingsTTL = time.Minute
	}
	if o.PartitionsTTL <= 0 {
		o.PartitionsTTL = time.Hour
	}
	if o.DeadlockRetries <= 0 {
		o.DeadlockRetries = 3
	}
	if o.PoisonAttempts <= 0 {
		o.PoisonAttempts = DefaultPoisonAttempts
	}
	switch {
	case o.PoisonWindow == 0:
		o.PoisonWindow = DefaultPoisonWindow
	case o.PoisonWindow < 0:
		o.PoisonWindow = 0
	}
	return &Store{pool: pool, obs: o.Observer, log: o.Logger, now: o.Now, opt: o,
		tries: attemptTracker{attempts: o.PoisonAttempts, window: o.PoisonWindow}}
}

// pingSQL is the listener probe: the database must answer through the pool, accept writes (not in recovery, not a
// read-only session — a switchover can briefly route PgBouncer to a standby) and let the writer
// call scf.writer_tenant_gone(), the tenant-status check every tenant transaction starts with (a
// deployment without that migration keeps the listener closed instead of failing every request).
const pingSQL = `SELECT NOT pg_catalog.pg_is_in_recovery(),
       NOT pg_catalog.current_setting('transaction_read_only')::boolean,
       COALESCE(pg_catalog.has_function_privilege(pg_catalog.to_regprocedure('scf.writer_tenant_gone()'), 'EXECUTE'), false)`

// Ping checks that the database answers through the pool and can take the writer's writes (used by the listener
// controller).
func (s *Store) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var primary, writable, granted bool
	if err := s.pool.QueryRow(ctx, pingSQL).Scan(&primary, &writable, &granted); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	switch {
	case !primary:
		return fmt.Errorf("%w: the database is in recovery (standby)", ErrUnavailable)
	case !writable:
		return fmt.Errorf("%w: the session is read-only", ErrUnavailable)
	case !granted:
		return fmt.Errorf("%w: scf_writer cannot execute scf.writer_tenant_gone() — migration missing", ErrUnavailable)
	}
	return nil
}

// Result is the outcome of one tenant part.
type Result struct {
	Duplicate  bool // the ledger already held (tenant, batch key): nothing applied
	WriteError bool // rolled back for a non-transient reason (or a poison timeout) and counted tenant_write_error
	TenantGone bool // the tenant is removed, purged or unknown: nothing written, counted in the writer's metrics only
	Applied    int  // histogram points applied to the metric tables
}

// Apply applies part in one transaction. Its error wraps ErrUnavailable when the database cannot take writes
// (connection lost, read-only, disk full, I/O error, …; the server closes its listener) or ErrBusy for a transient
// failure of a reachable database (the server answers 503 and stays open). Every other failure rolls the
// transaction back, is counted tenant_write_error (in a separate transaction) and yields Result.WriteError with a nil
// error, so the request is not retried for ever (C-112(1)); so does a part whose transaction keeps timing out
// (Options.PoisonAttempts over Options.PoisonWindow).
func (s *Store) Apply(ctx context.Context, key [32]byte, part *batch.TenantPart) (Result, error) {
	fk := flightKey{part.Tenant, key}
	release, err := s.fl.acquire(ctx, fk)
	if err != nil {
		s.obs.Outcome("busy")
		return Result{}, fmt.Errorf("%w: waiting for the in-flight transaction of the same batch: %v", ErrBusy, err)
	}
	defer release()
	var res Result
	poison := false
	for attempt := 0; ; attempt++ {
		start := time.Now()
		res, err = s.applyOnce(ctx, key, part)
		if err == nil {
			s.tries.forget(fk)
			result := "committed"
			switch {
			case res.Duplicate:
				result = "duplicate"
			case res.TenantGone:
				result = "tenant_gone"
				s.obs.Points("tenant_gone", int64(part.Total))
				s.log.Info("tenant part dropped: tenant removed or unknown", "tenant", part.Tenant)
			}
			s.obs.TxSeconds(time.Since(start), result)
			s.obs.Outcome(result)
			return res, nil
		}
		cls := classify(err)
		if cls == failTimeout && isRetryable(err) && attempt < s.opt.DeadlockRetries {
			s.obs.Outcome("retried")
			continue
		}
		switch cls {
		case failLost, failUnavailable:
			s.log.Warn("database unavailable", "class", cls.String(), "sqlstate", sqlState(err), "error_class", errorClass(err))
			s.obs.TxSeconds(time.Since(start), "unavailable")
			s.obs.Outcome("unavailable")
			return Result{}, fmt.Errorf("%w: %s (sqlstate %q)", ErrUnavailable, cls, sqlState(err))
		case failBusy:
			s.obs.TxSeconds(time.Since(start), "busy")
			s.obs.Outcome("busy")
			return Result{}, fmt.Errorf("%w: no connection within the budget", ErrBusy)
		case failTimeout:
			s.obs.TxSeconds(time.Since(start), "timeout")
			if !s.tries.timedOut(fk, s.now()) {
				s.log.Warn("tenant transaction timed out", "tenant", part.Tenant, "sqlstate", sqlState(err))
				s.obs.Outcome("timeout")
				return Result{}, fmt.Errorf("%w: tenant transaction timed out (sqlstate %q)", ErrBusy, sqlState(err))
			}
			poison = true
		default:
			s.obs.TxSeconds(time.Since(start), "write_error")
		}
		break
	}
	// Non-transient (or poison): rolled back already. Count it outside the failed transaction.
	if poison {
		s.log.Warn("tenant part keeps timing out: dropped as poison", "tenant", part.Tenant,
			"attempts", s.opt.PoisonAttempts, "window", s.opt.PoisonWindow.String())
		s.obs.Outcome("poison")
	} else {
		s.log.Warn("tenant transaction rolled back", "tenant", part.Tenant, "sqlstate", sqlState(err),
			"error_class", errorClass(err))
	}
	if cerr := s.countWriteError(ctx, part); cerr != nil {
		switch classify(cerr) {
		case failLost, failUnavailable:
			s.obs.Outcome("unavailable")
			return Result{}, fmt.Errorf("%w: counting tenant_write_error: sqlstate %q", ErrUnavailable, sqlState(cerr))
		case failBusy, failTimeout:
			// Retry the whole part later: a poison key stays poison, so the next attempt comes straight back here.
			s.obs.Outcome("busy")
			return Result{}, fmt.Errorf("%w: counting tenant_write_error timed out", ErrBusy)
		}
		s.log.Error("could not count tenant_write_error", "tenant", part.Tenant, "sqlstate", sqlState(cerr))
	}
	s.tries.forget(fk)
	s.obs.Outcome("write_error")
	s.obs.Reason(rules.ReasonTenantWriteError, int64(part.Total))
	return Result{WriteError: true}, nil
}

func (s *Store) countWriteError(ctx context.Context, part *batch.TenantPart) error {
	ctx, cancel := context.WithTimeout(ctx, s.opt.TxTimeout)
	defer cancel()
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := setCtx(ctx, tx, part.Tenant); err != nil {
			return err
		}
		c := counterSet{}
		c.add(dayOf(s.now()), zeroService, rules.ReasonTenantWriteError, int64(max(part.Total, 1)))
		return c.write(ctx, tx, part.Tenant)
	})
}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// errorClass is a log-safe description: never the message (it may quote tenant values).
func errorClass(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return "sql:" + pgErr.ConstraintName
	}
	return fmt.Sprintf("%T", errors.Unwrap(err))
}

// ---- caches -----------------------------------------------------------------------------------------------------

type settingsCache struct {
	mu     sync.Mutex
	at     time.Time
	values map[string]int64
}

// Settings the writer reads (data-model §7.1).
// stream_state_cap_per_tenant / l0_stream_state_cap bound the tenant's api_stream_state rows (streams and sources); the defaults leave room for every admitted route × methods × status codes × instances and their
// restarts within the 7-day idle window.
var settingKeys = []string{"max_services_per_tenant", "l0_max_services", "route_cap_per_service_day",
	"route_cap_per_tenant_day", "l0_routes_per_day", "route_sibling_cap", "stream_state_cap_per_tenant",
	"l0_stream_state_cap", "stellar_client_series_cap_per_tenant_day", "stellar_client_stream_cap_per_tenant",
	"integration_series_cap_per_tenant_day", "integration_series_cap_per_service_day", "integration_stream_cap_per_tenant"}

var settingDefaults = map[string]int64{"max_services_per_tenant": 20, "l0_max_services": 1,
	"route_cap_per_service_day": 1000, "route_cap_per_tenant_day": 5000, "l0_routes_per_day": 100,
	"route_sibling_cap": 200, "stream_state_cap_per_tenant": 250000, "l0_stream_state_cap": 10000,
	"stellar_client_series_cap_per_tenant_day": 5000, "stellar_client_stream_cap_per_tenant": 20000,
	"integration_series_cap_per_tenant_day": 5000, "integration_series_cap_per_service_day": 2000,
	"integration_stream_cap_per_tenant": 20000}

func (s *Store) settings(ctx context.Context, q pgx.Tx) (map[string]int64, error) {
	s.sets.mu.Lock()
	if s.sets.values != nil && time.Since(s.sets.at) < s.opt.SettingsTTL {
		v := s.sets.values
		s.sets.mu.Unlock()
		return v, nil
	}
	s.sets.mu.Unlock()
	rows, err := q.Query(ctx, `SELECT key, (value #>> '{}')::bigint FROM scf.settings WHERE key = ANY($1::text[])`, settingKeys)
	if err != nil {
		return nil, err
	}
	v := map[string]int64{}
	for k, d := range settingDefaults {
		v[k] = d
	}
	for rows.Next() {
		var k string
		var n int64
		if err := rows.Scan(&k, &n); err != nil {
			return nil, err
		}
		v[k] = n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.sets.mu.Lock()
	s.sets.values, s.sets.at = v, time.Now()
	s.sets.mu.Unlock()
	return v, nil
}

// partitionCache holds the partition ranges of api_metrics_1m/_1h/_1d, read from pg_inherits (§10: the writer
// never creates DDL; a point whose bucket has no partition is dropped before insertion).
type partitionCache struct {
	mu     sync.Mutex
	at     time.Time
	missAt time.Time
	ranges map[string][][2]time.Time
	loaded bool
}

const partitionsSQL = `
SELECT p.relname::text,
       (regexp_match(pg_catalog.pg_get_expr(c.relpartbound, c.oid), $re$FROM \('([^']+)'\)$re$))[1]::timestamptz,
       (regexp_match(pg_catalog.pg_get_expr(c.relpartbound, c.oid), $re$TO \('([^']+)'\)$re$))[1]::timestamptz
  FROM pg_catalog.pg_inherits h
  JOIN pg_catalog.pg_class c ON c.oid = h.inhrelid
  JOIN pg_catalog.pg_class p ON p.oid = h.inhparent
  JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
 WHERE n.nspname = 'scf' AND p.relname IN ('api_metrics_1m', 'api_metrics_1h', 'api_metrics_1d')`

// querier is a pool or a transaction. Inside a tenant transaction the cache is refreshed through that transaction:
// asking the pool for a second connection while every pooled connection holds a transaction would deadlock.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func (s *Store) loadPartitions(ctx context.Context, q querier) error {
	rows, err := q.Query(ctx, partitionsSQL)
	if err != nil {
		return err
	}
	r := map[string][][2]time.Time{}
	for rows.Next() {
		var tbl string
		var from, to *time.Time
		if err := rows.Scan(&tbl, &from, &to); err != nil {
			return err
		}
		if from == nil || to == nil {
			continue
		}
		r[tbl] = append(r[tbl], [2]time.Time{*from, *to})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	s.parts.mu.Lock()
	s.parts.ranges, s.parts.at, s.parts.loaded = r, time.Now(), true
	s.parts.mu.Unlock()
	return nil
}

// RefreshPartitions re-reads the partition ranges (the server calls it hourly and tests call it after creating
// partitions).
func (s *Store) RefreshPartitions(ctx context.Context) error { return s.loadPartitions(ctx, s.pool) }

// covered reports whether t has a partition in all three resolutions; on a miss it refreshes the cache at most
// once a minute. reason is too_old or future when not covered.
func (s *Store) covered(ctx context.Context, q querier, t time.Time) (bool, string, error) {
	s.parts.mu.Lock()
	stale := !s.parts.loaded || time.Since(s.parts.at) > s.opt.PartitionsTTL
	s.parts.mu.Unlock()
	if stale {
		if err := s.loadPartitions(ctx, q); err != nil {
			return false, "", err
		}
	}
	ok, reason := s.check(t)
	if ok {
		return true, "", nil
	}
	s.parts.mu.Lock()
	retry := time.Since(s.parts.missAt) > time.Minute
	if retry {
		s.parts.missAt = time.Now()
	}
	s.parts.mu.Unlock()
	if retry {
		if err := s.loadPartitions(ctx, q); err != nil {
			return false, "", err
		}
		ok, reason = s.check(t)
	}
	return ok, reason, nil
}

func (s *Store) check(t time.Time) (bool, string) {
	s.parts.mu.Lock()
	defer s.parts.mu.Unlock()
	for _, tbl := range []string{"api_metrics_1m", "api_metrics_1h", "api_metrics_1d"} {
		in := false
		earliest := time.Time{}
		for _, rg := range s.parts.ranges[tbl] {
			if !t.Before(rg[0]) && t.Before(rg[1]) {
				in = true
				break
			}
			if earliest.IsZero() || rg[0].Before(earliest) {
				earliest = rg[0]
			}
		}
		if !in {
			if !earliest.IsZero() && t.Before(earliest) || t.Before(s.now()) {
				return false, rules.ReasonTooOld
			}
			return false, rules.ReasonFuture
		}
	}
	return true, ""
}
