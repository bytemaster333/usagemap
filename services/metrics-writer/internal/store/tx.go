// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/cumul"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

const zeroService = "00000000-0000-0000-0000-000000000000"

// backfillSlack: no point with a time before registered_at − 10 min is accepted (ADR-0009 "no backfill", §8.6).
const backfillSlack = 10 * time.Minute

func dayOf(t time.Time) string { return t.UTC().Format(time.DateOnly) }

func setCtx(ctx context.Context, tx pgx.Tx, tenant string) error {
	_, err := tx.Exec(ctx, `SELECT scf.set_tenant_ctx(p_tenant => $1::uuid, p_actor_kind => 'writer', p_actor_id => 'writer')`, tenant)
	return err
}

// counterSet aggregates api_ingest_counters increments by (day, service_id, reason).
type counterSet map[[3]string]int64

func (c counterSet) add(day, service, reason string, n int64) {
	if n > 0 {
		c[[3]string{day, service, reason}] += n
	}
}

func (c counterSet) write(ctx context.Context, tx pgx.Tx, tenant string) error {
	if len(c) == 0 {
		return nil
	}
	keys := make([][3]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b [3]string) int {
		return strings.Compare(a[0]+a[1]+a[2], b[0]+b[1]+b[2])
	})
	var days, svcs, reasons []string
	var counts []int64
	for _, k := range keys {
		days, svcs, reasons, counts = append(days, k[0]), append(svcs, k[1]), append(reasons, k[2]), append(counts, c[k])
	}
	_, err := tx.Exec(ctx, `
INSERT INTO scf.api_ingest_counters AS c (tenant_id, day, service_id, reason, count)
SELECT $1::uuid, u.d::date, u.s::uuid, u.r, u.n
  FROM unnest($2::text[], $3::text[], $4::text[], $5::int8[]) AS u(d, s, r, n)
 ORDER BY 2, 3, 4
ON CONFLICT (tenant_id, day, service_id, reason) DO UPDATE SET count = c.count + EXCLUDED.count`,
		tenant, days, svcs, reasons, counts)
	return err
}

// service is a row of api_services the transaction uses.
type service struct {
	id           string
	registeredAt time.Time
	rpcDimension bool
}

// work is the state of one tenant transaction.
type work struct {
	s        *Store
	tx       pgx.Tx
	tenant   string
	part     *batch.TenantPart
	now      time.Time
	today    string
	counters counterSet
	services map[string]service // by service name
	settings map[string]int64
	locked   bool
}

func (w *work) count(service, reason string, n int64) {
	if n <= 0 {
		return
	}
	id := zeroService
	if sv, ok := w.services[service]; ok {
		id = sv.id
	}
	w.counters.add(w.today, id, reason, n)
	w.s.obs.Reason(reason, n)
}

// lock serialises the tenant's dictionary growth (auto-registration and the cardinality guard) across both writers.
func (w *work) lock(ctx context.Context) error {
	if w.locked {
		return nil
	}
	_, err := w.tx.Exec(ctx, `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scf-writer:' || $1::text, 0))`, w.tenant)
	w.locked = err == nil
	return err
}

// pending is a histogram point on its way through the transaction.
type pending struct {
	p         *batch.Point
	serviceID string
	groupID   int64
	routeID   int64
	conv      batch.Converted
	dropped   bool
}

func (s *Store) applyOnce(parent context.Context, key [32]byte, part *batch.TenantPart) (Result, error) {
	ctx, cancel := context.WithTimeout(parent, s.opt.TxTimeout)
	defer cancel()
	// Acquire explicitly: a pool that has no free connection within the budget is busy, not a lost database. A failure to connect is still classified by its own error.
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, fmt.Errorf("%w: %v", errNotStarted, err)
		}
		return Result{}, err
	}
	defer conn.Release()
	var res Result
	err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		now := s.now()
		w := &work{s: s, tx: tx, tenant: part.Tenant, part: part, now: now, today: dayOf(now),
			counters: counterSet{}, services: map[string]service{}}
		if err := setCtx(ctx, tx, part.Tenant); err != nil {
			return err
		}
		// The API erasure fence, shared, before any row lock (fence.go).
		if err := fence(ctx, tx, part.Tenant); err != nil {
			return err
		}
		// 0. Tenant status: requests can wait in the Collector's queue for up to 72 h. A removed
		// (and possibly already purged) or unknown tenant gets nothing written — no ledger row, no service, no
		// counter — so tenant_purge's work is never undone. The drop is counted in the writer's metrics only.
		gone, err := tenantGone(ctx, tx, part.Tenant)
		if err != nil {
			return err
		}
		if gone {
			res.TenantGone = true
			return nil
		}
		// 1. Ledger (C-23): a conflict means this tenant's part of this batch was applied already.
		var one int
		err = tx.QueryRow(ctx, `INSERT INTO scf.api_ingest_ledger (tenant_id, batch_key, points) VALUES ($1::uuid, $2, $3)
ON CONFLICT DO NOTHING RETURNING 1`, part.Tenant, key[:], part.Total).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			res.Duplicate = true
			w.counters.add(w.today, zeroService, rules.ReasonDuplicateBatch, int64(max(part.Total, 1)))
			s.obs.Reason(rules.ReasonDuplicateBatch, int64(max(part.Total, 1)))
			return w.counters.write(ctx, tx, part.Tenant)
		}
		if err != nil {
			return err
		}
		n, err := w.run(ctx)
		res.Applied = n
		return err
	})
	return res, err
}

// tenantGone reports whether the tenant of the current context is removed (status 'removed', purged or waiting for
// the purge) or has no row. Suspended and pending tenants keep their already accepted data: the gateway stops new
// ingest for them, and their rows are not purged. scf_writer has no SELECT on scf.tenants; the definer function
// scf.writer_tenant_gone() answers for the context's tenant only.
func tenantGone(ctx context.Context, tx pgx.Tx, _ string) (bool, error) {
	var gone bool
	err := tx.QueryRow(ctx, `SELECT scf.writer_tenant_gone()`).Scan(&gone)
	return gone, err
}

func (w *work) run(ctx context.Context) (int, error) {
	var err error
	if w.settings, err = w.s.settings(ctx, w.tx); err != nil {
		return 0, err
	}
	// Pre-database drops decided while decoding (receipt age, malformed, not allowed), by service name.
	names := map[string]bool{}
	for k := range w.part.Drops {
		names[k.Service] = true
	}
	for _, c := range w.part.Counters {
		names[c.Service] = true
	}
	// 2. Partitions: a point whose bucket has no partition is dropped before anything else (§10).
	pts := make([]*pending, 0, len(w.part.Points))
	type drop struct{ svc, reason string }
	var early []drop
	for i := range w.part.Points {
		p := &w.part.Points[i]
		names[p.Service] = true
		ok, reason, err := w.s.covered(ctx, w.tx, time.Unix(0, p.Snap.Time).UTC())
		if err != nil {
			return 0, err
		}
		if !ok {
			early = append(early, drop{p.Service, reason})
			continue
		}
		pts = append(pts, &pending{p: p})
	}
	// 3. Services: look up every name, auto-register unknown ones of histogram points up to the quota (C-21).
	for i := range w.part.Stellar { // Stellar client metrics (C-153) resolve and register services like histograms
		names[w.part.Stellar[i].Service] = true
	}
	for i := range w.part.Integration { // and so do the integration client metrics (§g.8, 0085)
		names[w.part.Integration[i].Service] = true
	}
	if err := w.resolveServices(ctx, names, slices.Concat(pts, w.stellarRegistrants(), w.integrationRegistrants())); err != nil {
		return 0, err
	}
	for k, n := range w.part.Drops {
		w.count(k.Service, k.Reason, n)
	}
	for _, d := range early {
		w.count(d.svc, d.reason, 1)
	}
	live := pts[:0]
	for _, pp := range pts {
		sv, ok := w.services[pp.p.Service]
		if !ok {
			continue // counted service_quota_exceeded / malformed_point in resolveServices
		}
		// Backfill bound (§8.6): nothing before registered_at − 10 min.
		if time.Unix(0, pp.p.Snap.Time).Before(sv.registeredAt.Add(-backfillSlack)) {
			w.count(pp.p.Service, rules.ReasonBeforeRegistration, 1)
			continue
		}
		pp.serviceID = sv.id
		live = append(live, pp)
	}
	pts = live
	// 3b. Stellar client metrics (C-153): their own tables, before any API stream-state row is locked (stellar.go).
	stellarApplied, err := w.stellar(ctx)
	if err != nil {
		return 0, err
	}
	// 3c. Integration client metrics (partner, payments, anchors; §g.8, 0085): their own tables (integration.go).
	integrationApplied, err := w.integration(ctx)
	if err != nil {
		return 0, err
	}
	// 4. Stream groups (C-22).
	if err := w.resolveGroups(ctx, pts); err != nil {
		return 0, err
	}
	// 5. Cumulative → delta under the locked state rows (§9.4, C-122), then conversion into the stored layouts (§9).
	if pts, err = w.cumulative(ctx, pts); err != nil {
		return 0, err
	}
	pts = w.convert(pts)
	// 6. Routes and the cardinality guard (C-24).
	if err := w.resolveRoutes(ctx, pts); err != nil {
		return 0, err
	}
	// 7. Additive upserts, _1d first (C-112(1)), then day-group presence.
	applied, err := w.upsert(ctx, pts)
	if err != nil {
		return 0, err
	}
	// 8. The Collector's drop counters (never registering a service, C-115) and the writer's own.
	for _, c := range w.part.Counters {
		id := zeroService
		if sv, ok := w.services[c.Service]; ok && c.Service != rules.ServiceNotAllowed {
			id = sv.id
		}
		w.counters.add(dayOf(time.Unix(0, c.Time)), id, c.Reason, c.Count)
	}
	if err := w.counters.write(ctx, w.tx, w.tenant); err != nil {
		return 0, err
	}
	return applied + stellarApplied + integrationApplied, nil
}

// ---- services -----------------------------------------------------------------------------------------------------

func (w *work) lookupServices(ctx context.Context, names []string) error {
	rows, err := w.tx.Query(ctx, `SELECT service_id::text, service_name, registered_at, rpc_method_dimension
  FROM scf.api_services WHERE service_name = ANY($1::text[])`, names)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var sv service
		var name string
		if err := rows.Scan(&sv.id, &name, &sv.registeredAt, &sv.rpcDimension); err != nil {
			return err
		}
		w.services[name] = sv
	}
	return rows.Err()
}

func (w *work) resolveServices(ctx context.Context, all map[string]bool, pts []*pending) error {
	var names []string
	for n := range all {
		if rules.ValidServiceName(n) && n != rules.ServiceNotAllowed {
			names = append(names, n)
		}
	}
	slices.Sort(names)
	if len(names) > 0 {
		if err := w.lookupServices(ctx, names); err != nil {
			return err
		}
	}
	// Unknown names of histogram points (never of counters, C-115) are registered.
	need := map[string]int{}
	for _, pp := range pts {
		if _, ok := w.services[pp.p.Service]; !ok {
			need[pp.p.Service]++
		}
	}
	if len(need) == 0 {
		return nil
	}
	var missing []string
	for n, k := range need {
		if !rules.ValidServiceName(n) || n == rules.ServiceNotAllowed {
			w.count("", rules.ReasonMalformedPoint, int64(k))
			continue
		}
		missing = append(missing, n)
	}
	if len(missing) == 0 {
		return nil
	}
	slices.Sort(missing)
	if err := w.lock(ctx); err != nil {
		return err
	}
	if err := w.lookupServices(ctx, missing); err != nil { // another writer may have registered them meanwhile
		return err
	}
	var existing int64
	if err := w.tx.QueryRow(ctx, `SELECT count(*) FROM scf.api_services`).Scan(&existing); err != nil {
		return err
	}
	quota := w.settings["max_services_per_tenant"]
	if w.part.Level == 0 {
		quota = w.settings["l0_max_services"]
	}
	for _, n := range missing {
		if _, ok := w.services[n]; ok {
			continue
		}
		if existing >= quota {
			w.count("", rules.ReasonServiceQuotaExceeded, int64(need[n]))
			continue
		}
		var sv service
		if err := w.tx.QueryRow(ctx, `INSERT INTO scf.api_services (tenant_id, service_name, registration)
VALUES ($1::uuid, $2, 'auto') RETURNING service_id::text, registered_at, rpc_method_dimension`, w.tenant, n).
			Scan(&sv.id, &sv.registeredAt, &sv.rpcDimension); err != nil {
			return err
		}
		if _, err := w.tx.Exec(ctx, `INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, details)
VALUES ($1::uuid, 'writer', 'writer', 'service.auto_registered', 'api_service', $2, '{"registration":"auto"}'::jsonb)`,
			w.tenant, sv.id); err != nil {
			return err
		}
		w.services[n] = sv
		existing++
	}
	return nil
}

// ---- stream groups ------------------------------------------------------------------------------------------------

type groupKey struct{ service, kind, metric, scope string }

func (w *work) resolveGroups(ctx context.Context, pts []*pending) error {
	if len(pts) == 0 {
		return nil
	}
	set := map[groupKey]int{}
	for _, pp := range pts {
		set[groupKey{pp.serviceID, pp.p.Kind, pp.p.Metric, pp.p.Scope}] = pp.p.KindRank
	}
	keys := make([]groupKey, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b groupKey) int {
		return strings.Compare(a.service+"\x00"+a.kind+"\x00"+a.metric+"\x00"+a.scope,
			b.service+"\x00"+b.kind+"\x00"+b.metric+"\x00"+b.scope)
	})
	var svcs, kinds, metrics, scopes, ranks []string
	for _, k := range keys {
		svcs, kinds, metrics, scopes = append(svcs, k.service), append(kinds, k.kind), append(metrics, k.metric), append(scopes, k.scope)
		ranks = append(ranks, rules.RankKey(set[k], k.scope))
	}
	if _, err := w.tx.Exec(ctx, `
INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key)
SELECT $1::uuid, u.s::uuid, u.k::scf.stream_kind, u.m, u.sc, u.r
  FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u(s, k, m, sc, r)
 ORDER BY 2, 3, 4, 5
ON CONFLICT (tenant_id, service_id, kind, metric_name, scope_name) DO NOTHING`,
		w.tenant, svcs, kinds, metrics, scopes, ranks); err != nil {
		return err
	}
	rows, err := w.tx.Query(ctx, `
SELECT g.group_id, g.service_id::text, g.kind::text, g.metric_name, g.scope_name
  FROM scf.api_stream_groups g
  JOIN unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS u(s, k, m, sc)
    ON g.service_id = u.s::uuid AND g.kind = u.k::scf.stream_kind AND g.metric_name = u.m AND g.scope_name = u.sc`,
		svcs, kinds, metrics, scopes)
	if err != nil {
		return err
	}
	ids := map[groupKey]int64{}
	for rows.Next() {
		var id int64
		var k groupKey
		if err := rows.Scan(&id, &k.service, &k.kind, &k.metric, &k.scope); err != nil {
			rows.Close()
			return err
		}
		ids[k] = id
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, pp := range pts {
		pp.groupID = ids[groupKey{pp.serviceID, pp.p.Kind, pp.p.Metric, pp.p.Scope}]
	}
	return nil
}

// ---- cumulative state ---------------------------------------------------------------------------------------------

type stateLayout struct {
	Kind   string    `json:"kind"`
	Bounds []float64 `json:"bounds,omitempty"`
	Scale  *int32    `json:"scale,omitempty"`
	Neg    uint64    `json:"neg,omitempty"`
}

// sourceLayout marks a source row in scf.api_stream_state (C-122): one row per source (sourceKey in package batch),
// touched whenever any of its streams delivers, so it ages out with them (stream_gc, 7 days idle). Its existence
// before the current transaction is what "the source was already delivering" means.
const sourceLayout = `{"kind":"source"}`

func (w *work) cumulative(ctx context.Context, pts []*pending) ([]*pending, error) {
	byKey := map[[32]byte][]*pending{}
	sourceTime := map[[32]byte]int64{} // source key → newest point time in this request
	var keys [][]byte
	var layouts []string
	for _, pp := range pts {
		if !pp.p.Cumulative {
			continue
		}
		k := pp.p.StreamKey
		if byKey[k] == nil {
			keys, layouts = append(keys, k[:]), append(layouts, "{}")
		}
		byKey[k] = append(byKey[k], pp)
		src := pp.p.SourceKey
		if t, ok := sourceTime[src]; !ok {
			keys, layouts = append(keys, src[:]), append(layouts, sourceLayout)
			sourceTime[src] = pp.p.Snap.Time
		} else {
			sourceTime[src] = max(t, pp.p.Snap.Time)
		}
	}
	if len(byKey) == 0 {
		return pts, nil
	}
	// Stream-state bound: streams refused here keep no state and their points are dropped.
	drop := map[*pending]bool{}
	refused, skipSources, err := w.boundStreams(ctx, byKey, sourceTime)
	if err != nil {
		return nil, err
	}
	if len(refused) > 0 || len(skipSources) > 0 {
		keys, layouts = keys[:0], layouts[:0]
		for k, group := range byKey {
			if !refused[k] {
				continue
			}
			for _, pp := range group {
				drop[pp] = true
				w.count(pp.p.Service, rules.ReasonRouteOverflow, 1)
			}
			delete(byKey, k)
		}
		for k := range skipSources {
			delete(sourceTime, k)
		}
		for k := range byKey {
			keys, layouts = append(keys, bytesOf(k)), append(layouts, "{}")
		}
		for k := range sourceTime {
			keys, layouts = append(keys, bytesOf(k)), append(layouts, sourceLayout)
		}
		if len(keys) == 0 {
			return dropPending(pts, drop), nil
		}
	}
	order := make([]int, len(keys))
	for i := range order {
		order[i] = i
	}
	slices.SortFunc(order, func(a, b int) int { return strings.Compare(string(keys[a]), string(keys[b])) })
	sk, sl := make([][]byte, len(keys)), make([]string, len(keys))
	for i, j := range order {
		sk[i], sl[i] = keys[j], layouts[j]
	}
	keys, layouts = sk, sl
	// Placeholder rows (last_time −1 = "no state yet") make concurrent first points of one stream on both writers
	// serialise on the row lock instead of both seeding. Source rows are inserted (and locked) in the same sorted
	// order; the ones this statement creates are the sources we had not seen (C-122). A concurrent transaction that
	// creates the same source row first makes this one wait and then see it as known — its streams' state rows are
	// locked in the same order, so whatever that transaction seeded or counted is state here.
	rows, err := w.tx.Query(ctx, `
INSERT INTO scf.api_stream_state (tenant_id, stream_key, start_time_unix_ns, last_time_unix_ns, last_count, last_sum, last_layout, last_buckets)
SELECT $1::uuid, u.k, 0, -1, 0, 0, u.l::jsonb, '{}'::bigint[] FROM unnest($2::bytea[], $3::text[]) AS u(k, l) ORDER BY u.k
ON CONFLICT (tenant_id, stream_key) DO NOTHING
RETURNING stream_key`, w.tenant, keys, layouts)
	if err != nil {
		return nil, err
	}
	created := map[[32]byte]bool{}
	for rows.Next() {
		var k []byte
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return nil, err
		}
		created[[32]byte(k)] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = w.tx.Query(ctx, `
SELECT stream_key, start_time_unix_ns, last_time_unix_ns, last_count, last_sum, last_layout, last_buckets,
       last_zero_count, last_exp_offset
  FROM scf.api_stream_state WHERE stream_key = ANY($1::bytea[]) ORDER BY stream_key FOR UPDATE`, keys)
	if err != nil {
		return nil, err
	}
	states := map[[32]byte]*cumul.Snapshot{}
	for rows.Next() {
		var (
			k        []byte
			st       cumul.Snapshot
			lastTime int64
			count    int64
			layout   []byte
			buckets  []int64
			zero     int64
			offset   *int32
		)
		if err := rows.Scan(&k, &st.Start, &lastTime, &count, &st.Sum, &layout, &buckets, &zero, &offset); err != nil {
			rows.Close()
			return nil, err
		}
		if lastTime < 0 {
			continue // placeholder: no state yet
		}
		var lay stateLayout
		if err := json.Unmarshal(layout, &lay); err != nil {
			rows.Close()
			return nil, fmt.Errorf("stream state layout: %w", err)
		}
		if lay.Kind == "source" {
			continue
		}
		st.Time, st.Count, st.Zero = lastTime, uint64(count), uint64(zero)
		st.Buckets = make([]uint64, len(buckets))
		for i, b := range buckets {
			st.Buckets[i] = uint64(b)
		}
		if lay.Kind == "exponential" {
			st.Exponential, st.Negative = true, lay.Neg
			if lay.Scale != nil {
				st.Scale = *lay.Scale
			}
			if offset != nil {
				st.Offset = *offset
			}
		} else {
			st.Bounds = lay.Bounds
		}
		var key [32]byte
		copy(key[:], k)
		states[key] = &st
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var (
		uKeys    [][]byte
		uStart   []int64
		uTime    []int64
		uCount   []int64
		uSum     []float64
		uLayout  []string
		uBuckets []string
		uZero    []int64
		uOffset  []*int32
	)
	for _, k := range keys {
		var key [32]byte
		copy(key[:], k)
		group := byKey[key]
		if group == nil {
			continue // a source row
		}
		slices.SortStableFunc(group, func(a, b *pending) int {
			switch {
			case a.p.Snap.Time < b.p.Snap.Time:
				return -1
			case a.p.Snap.Time > b.p.Snap.Time:
				return 1
			}
			return 0
		})
		prev := states[key]
		orig := prev
		for _, pp := range group {
			delta, next, out := cumul.Step(prev, pp.p.Snap, !created[pp.p.SourceKey])
			switch out {
			case cumul.FirstSeed:
				w.count(pp.p.Service, rules.ReasonCumulativeFirstPoint, 1)
				w.s.obs.Points("seeded", 1)
			case cumul.ResetDelta, cumul.ResetDrop:
				w.count(pp.p.Service, rules.ReasonCumulativeReset, 1)
			case cumul.Stale:
				w.s.obs.Points("stale", 1)
			}
			if delta == nil {
				drop[pp] = true
				if out == cumul.Delta || out == cumul.FirstFull {
					w.s.obs.Points("zero_delta", 1)
				}
			} else {
				pp.p.Snap = *delta
				pp.p.Min, pp.p.Max = nil, nil // deltas from cumulative points carry no min/max (§9.4)
			}
			prev = next
		}
		if prev == orig {
			continue
		}
		lay := stateLayout{Kind: "explicit", Bounds: prev.Bounds}
		var off *int32
		if prev.Exponential {
			sc, o := prev.Scale, prev.Offset
			lay = stateLayout{Kind: "exponential", Scale: &sc, Neg: prev.Negative}
			off = &o
		}
		lj, _ := json.Marshal(lay)
		uKeys = append(uKeys, k)
		uStart, uTime = append(uStart, prev.Start), append(uTime, prev.Time)
		uCount, uSum = append(uCount, clampI64(prev.Count)), append(uSum, prev.Sum)
		uLayout, uBuckets = append(uLayout, string(lj)), append(uBuckets, pgArray(prev.Buckets))
		uZero, uOffset = append(uZero, clampI64(prev.Zero)), append(uOffset, off)
	}
	if len(uKeys) > 0 {
		if _, err := w.tx.Exec(ctx, `
UPDATE scf.api_stream_state AS s
   SET start_time_unix_ns = u.st, last_time_unix_ns = u.lt, last_count = u.c, last_sum = u.sm, last_layout = u.lay::jsonb,
       last_buckets = u.b::bigint[], last_zero_count = u.z, last_exp_offset = u.o, updated_at = now()
  FROM unnest($2::bytea[], $3::int8[], $4::int8[], $5::int8[], $6::float8[], $7::text[], $8::text[], $9::int8[], $10::int4[])
       AS u(k, st, lt, c, sm, lay, b, z, o)
 WHERE s.tenant_id = $1::uuid AND s.stream_key = u.k`,
			w.tenant, uKeys, uStart, uTime, uCount, uSum, uLayout, uBuckets, uZero, uOffset); err != nil {
			return nil, err
		}
	}
	// Touch the source rows (already locked above): they age out only with their streams.
	var sKeys [][]byte
	var sTimes []int64
	for _, k := range keys {
		if t, ok := sourceTime[[32]byte(k)]; ok {
			sKeys, sTimes = append(sKeys, k), append(sTimes, t)
		}
	}
	if _, err := w.tx.Exec(ctx, `
UPDATE scf.api_stream_state AS s
   SET last_time_unix_ns = greatest(s.last_time_unix_ns, u.t), updated_at = now()
  FROM unnest($2::bytea[], $3::int8[]) AS u(k, t)
 WHERE s.tenant_id = $1::uuid AND s.stream_key = u.k`, w.tenant, sKeys, sTimes); err != nil {
		return nil, err
	}
	return dropPending(pts, drop), nil
}

// dropPending removes the dropped points from pts (in place).
func dropPending(pts []*pending, drop map[*pending]bool) []*pending {
	if len(drop) == 0 {
		return pts
	}
	out := pts[:0]
	for _, pp := range pts {
		if !drop[pp] {
			out = append(out, pp)
		}
	}
	return out
}

func bytesOf(k [32]byte) []byte { return k[:] }

func clampI64(v uint64) int64 {
	if v > 1<<63-1 {
		return 1<<63 - 1
	}
	return int64(v)
}

func pgArray(v []uint64) string {
	var b strings.Builder
	b.WriteByte('{')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatInt(clampI64(x), 10))
	}
	b.WriteByte('}')
	return b.String()
}

// ---- conversion -------------------------------------------------------------------------------------------------

func (w *work) convert(pts []*pending) []*pending {
	out := pts[:0]
	for _, pp := range pts {
		c, err := batch.Convert(pp.p.Snap, pp.p.Min, pp.p.Max)
		switch {
		case errors.Is(err, hist.ErrCountOverflow):
			w.count(pp.p.Service, rules.ReasonCountOverflow, 1)
			continue
		case err != nil:
			w.count(pp.p.Service, rules.ReasonMalformedPoint, 1)
			continue
		}
		if c.Count == 0 {
			continue
		}
		for _, r := range c.Reasons {
			w.count(pp.p.Service, r, 1)
		}
		pp.conv = c
		out = append(out, pp)
	}
	return out
}
