// SPDX-License-Identifier: Apache-2.0

package store

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/cumul"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// The Stellar client-metric stream (wire-formats §g.7, migration 0080, C-153): the outbound Stellar RPC / Horizon
// calls and transaction outcomes of a tenant backend, from @usagemap/stellar-otel. Written into
// scf.stellar_client_{1d,1h,1m} — never into the API metrics — in the tenant's transaction, after the services are
// resolved and before any API state row is locked, under the tenant's advisory lock (which serialises the stream
// state and the series cap across both writers).

// stellarMaxAge keeps the finest table's retention (35 days) clear: an older point would be deleted at once.
const (
	stellarMaxAge    = 34 * 24 * time.Hour
	stellarMaxFuture = time.Hour
)

var stellarTables = []resolution{ // _1d first: a point refused there is left out of _1h and _1m (C-112(1))
	{"stellar_client_1d", resolutions[0].trunc},
	{"stellar_client_1h", resolutions[1].trunc},
	{"stellar_client_1m", resolutions[2].trunc},
}

// stellarPending is a Stellar point on its way through the transaction.
type stellarPending struct {
	p         *batch.StellarPoint
	serviceID string
	count     int64
	sum       float64
	row       hist.Row // explicit15, histograms only
}

// seriesKey is a series of a UTC day: one stellar_client_1d row.
type seriesKey struct {
	service, metric, network, op, variant, outcome string
}

func (a seriesKey) compare(b seriesKey) int {
	return cmp.Or(cmp.Compare(a.service, b.service), cmp.Compare(a.metric, b.metric), cmp.Compare(a.network, b.network),
		cmp.Compare(a.op, b.op), cmp.Compare(a.variant, b.variant), cmp.Compare(a.outcome, b.outcome))
}

func seriesOf(sp *stellarPending) seriesKey {
	return seriesKey{sp.serviceID, sp.p.Metric, sp.p.Network, sp.p.Operation, sp.p.Variant, sp.p.Outcome}
}

// stellarRegistrants are placeholder API points for the services of Stellar points, so that resolveServices
// registers an unknown backend service (with the API path's quota and audit row) — a backend instrumented only with
// @usagemap/stellar-otel is a service of the tenant like any other.
func (w *work) stellarRegistrants() []*pending {
	var out []*pending
	seen := map[string]bool{}
	for i := range w.part.Stellar {
		s := w.part.Stellar[i].Service
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, &pending{p: &batch.Point{Service: s}})
	}
	return out
}

// stellar applies the part's Stellar client metrics and returns the number of points written.
func (w *work) stellar(ctx context.Context) (int, error) {
	if len(w.part.Stellar) == 0 {
		return 0, nil
	}
	var pts []*stellarPending
	for i := range w.part.Stellar {
		p := &w.part.Stellar[i]
		sv, ok := w.services[p.Service]
		if !ok {
			continue // counted service_quota_exceeded / malformed_point in resolveServices
		}
		t := time.Unix(0, p.Snap.Time)
		switch {
		case t.Before(w.now.Add(-stellarMaxAge)):
			w.count(p.Service, rules.ReasonTooOld, 1)
			continue
		case t.After(w.now.Add(stellarMaxFuture)):
			w.count(p.Service, rules.ReasonFuture, 1)
			continue
		case t.Before(sv.registeredAt.Add(-backfillSlack)):
			w.count(p.Service, rules.ReasonBeforeRegistration, 1)
			continue
		}
		pts = append(pts, &stellarPending{p: p, serviceID: sv.id})
	}
	if len(pts) == 0 {
		return 0, nil
	}
	if err := w.lock(ctx); err != nil {
		return 0, err
	}
	pts, err := w.stellarCumulative(ctx, pts)
	if err != nil {
		return 0, err
	}
	pts = w.stellarConvert(pts)
	if pts, err = w.stellarSeriesCap(ctx, pts); err != nil {
		return 0, err
	}
	return w.stellarUpsert(ctx, pts)
}

// stellarCumulative turns cumulative points into deltas (cumul.Step, the API path's rules, §9.4, C-122) against
// scf.stellar_client_stream_state, bounded by stellar_client_stream_cap_per_tenant.
func (w *work) stellarCumulative(ctx context.Context, pts []*stellarPending) ([]*stellarPending, error) {
	byKey := map[[32]byte][]*stellarPending{}
	sources := map[[32]byte]bool{}
	for _, sp := range pts {
		if sp.p.Cumulative {
			byKey[sp.p.StreamKey] = append(byKey[sp.p.StreamKey], sp)
			sources[sp.p.SourceKey] = true
		}
	}
	if len(byKey) == 0 {
		return pts, nil
	}
	keys := make([][]byte, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, bytesOf(k))
	}
	slices.SortFunc(keys, func(a, b []byte) int { return strings.Compare(string(a), string(b)) })
	srcKeys := make([][]byte, 0, len(sources))
	for k := range sources {
		srcKeys = append(srcKeys, bytesOf(k))
	}
	// Sources that delivered before this transaction (C-122).
	known := map[[32]byte]bool{}
	rows, err := w.tx.Query(ctx, `SELECT DISTINCT source_key FROM scf.stellar_client_stream_state
 WHERE tenant_id = $1::uuid AND source_key = ANY($2::bytea[])`, w.tenant, srcKeys)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k []byte
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return nil, err
		}
		known[[32]byte(k)] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	states, err := w.stellarStates(ctx, keys)
	if err != nil {
		return nil, err
	}
	// The stream-state cap: new streams admitted in key order while the tenant stays below the cap.
	var held int64
	if err := w.tx.QueryRow(ctx, `SELECT count(*) FROM scf.stellar_client_stream_state WHERE tenant_id = $1::uuid`, w.tenant).
		Scan(&held); err != nil {
		return nil, err
	}
	capacity := w.settings["stellar_client_stream_cap_per_tenant"] - held
	drop := map[*stellarPending]bool{}
	type upd struct {
		key  []byte
		src  []byte
		svc  string
		snap *cumul.Snapshot
	}
	var updates []upd
	for _, k := range keys {
		key := [32]byte(k)
		group := byKey[key]
		prev, had := states[key]
		if !had {
			if capacity <= 0 {
				for _, sp := range group {
					drop[sp] = true
					w.count(sp.p.Service, rules.ReasonStellarSeriesOverflow, 1)
				}
				continue
			}
			capacity--
		}
		slices.SortStableFunc(group, func(a, b *stellarPending) int { return cmp.Compare(a.p.Snap.Time, b.p.Snap.Time) })
		orig := prev
		for _, sp := range group {
			delta, next, out := cumul.Step(prev, sp.p.Snap, known[sp.p.SourceKey])
			switch out {
			case cumul.FirstSeed:
				w.count(sp.p.Service, rules.ReasonCumulativeFirstPoint, 1)
				w.s.obs.Points("seeded", 1)
			case cumul.ResetDelta, cumul.ResetDrop:
				w.count(sp.p.Service, rules.ReasonCumulativeReset, 1)
			case cumul.Stale:
				w.s.obs.Points("stale", 1)
			}
			if delta == nil {
				drop[sp] = true
			} else {
				sp.p.Snap = *delta
				sp.p.Min, sp.p.Max = nil, nil // deltas from cumulative points carry no min/max (§9.4)
			}
			prev = next
		}
		if prev != orig {
			updates = append(updates, upd{k, bytesOf(group[0].p.SourceKey), group[0].serviceID, prev})
		}
	}
	if len(updates) > 0 {
		var (
			uKeys, uSrc                  [][]byte
			uSvc, uLayout, uBuckets      []string
			uStart, uTime, uCount, uZero []int64
			uSum                         []float64
			uOffset                      []*int32
		)
		for _, u := range updates {
			lay := stateLayout{Kind: "explicit", Bounds: u.snap.Bounds}
			var off *int32
			if u.snap.Exponential {
				sc, o := u.snap.Scale, u.snap.Offset
				lay = stateLayout{Kind: "exponential", Scale: &sc, Neg: u.snap.Negative}
				off = &o
			}
			lj, _ := json.Marshal(lay)
			uKeys, uSrc, uSvc = append(uKeys, u.key), append(uSrc, u.src), append(uSvc, u.svc)
			uStart, uTime = append(uStart, u.snap.Start), append(uTime, u.snap.Time)
			uCount, uSum = append(uCount, clampI64(u.snap.Count)), append(uSum, u.snap.Sum)
			uLayout, uBuckets = append(uLayout, string(lj)), append(uBuckets, pgArray(u.snap.Buckets))
			uZero, uOffset = append(uZero, clampI64(u.snap.Zero)), append(uOffset, off)
		}
		if _, err := w.tx.Exec(ctx, `
INSERT INTO scf.stellar_client_stream_state AS s (tenant_id, stream_key, source_key, service_id, start_time_unix_ns,
       last_time_unix_ns, last_count, last_sum, last_layout, last_buckets, last_zero_count, last_exp_offset)
SELECT $1::uuid, u.k, u.src, u.svc::uuid, u.st, u.lt, u.c, u.sm, u.lay::jsonb, u.b::bigint[], u.z, u.o
  FROM unnest($2::bytea[], $3::bytea[], $4::text[], $5::int8[], $6::int8[], $7::int8[], $8::float8[], $9::text[],
              $10::text[], $11::int8[], $12::int4[]) AS u(k, src, svc, st, lt, c, sm, lay, b, z, o)
 ORDER BY u.k
ON CONFLICT (tenant_id, stream_key) DO UPDATE SET
  start_time_unix_ns = EXCLUDED.start_time_unix_ns, last_time_unix_ns = EXCLUDED.last_time_unix_ns,
  last_count = EXCLUDED.last_count, last_sum = EXCLUDED.last_sum, last_layout = EXCLUDED.last_layout,
  last_buckets = EXCLUDED.last_buckets, last_zero_count = EXCLUDED.last_zero_count,
  last_exp_offset = EXCLUDED.last_exp_offset, updated_at = now()`,
			w.tenant, uKeys, uSrc, uSvc, uStart, uTime, uCount, uSum, uLayout, uBuckets, uZero, uOffset); err != nil {
			return nil, err
		}
	}
	out := pts[:0]
	for _, sp := range pts {
		if !drop[sp] {
			out = append(out, sp)
		}
	}
	return out, nil
}

func (w *work) stellarStates(ctx context.Context, keys [][]byte) (map[[32]byte]*cumul.Snapshot, error) {
	rows, err := w.tx.Query(ctx, `
SELECT stream_key, start_time_unix_ns, last_time_unix_ns, last_count, last_sum, last_layout, last_buckets,
       last_zero_count, last_exp_offset
  FROM scf.stellar_client_stream_state WHERE tenant_id = $1::uuid AND stream_key = ANY($2::bytea[])`, w.tenant, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := map[[32]byte]*cumul.Snapshot{}
	for rows.Next() {
		var (
			k       []byte
			st      cumul.Snapshot
			count   int64
			layout  []byte
			buckets []int64
			zero    int64
			offset  *int32
		)
		if err := rows.Scan(&k, &st.Start, &st.Time, &count, &st.Sum, &layout, &buckets, &zero, &offset); err != nil {
			return nil, err
		}
		var lay stateLayout
		if err := json.Unmarshal(layout, &lay); err != nil {
			return nil, fmt.Errorf("stellar stream state layout: %w", err)
		}
		st.Count, st.Zero = uint64(count), uint64(zero)
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
		} else if len(lay.Bounds) > 0 {
			st.Bounds = lay.Bounds
		}
		states[[32]byte(k)] = &st
	}
	return states, rows.Err()
}

// stellarConvert maps histogram deltas into explicit15 (count_overflow / malformed_point as on the API path) and
// takes the counters' values. Empty deltas write nothing.
func (w *work) stellarConvert(pts []*stellarPending) []*stellarPending {
	out := pts[:0]
	for _, sp := range pts {
		if !sp.p.Histogram {
			if sp.p.Snap.Count == 0 {
				continue
			}
			sp.count = clampI64(sp.p.Snap.Count)
			out = append(out, sp)
			continue
		}
		c, err := batch.ConvertExplicit15(sp.p.Snap, sp.p.Min, sp.p.Max)
		switch {
		case errors.Is(err, hist.ErrCountOverflow):
			w.count(sp.p.Service, rules.ReasonCountOverflow, 1)
			continue
		case err != nil:
			w.count(sp.p.Service, rules.ReasonMalformedPoint, 1)
			continue
		}
		if c.Count == 0 {
			continue
		}
		for _, r := range c.Reasons {
			w.count(sp.p.Service, r, 1)
		}
		sp.count, sp.sum, sp.row = c.Count, c.Sum, c.Row
		out = append(out, sp)
	}
	return out
}

// stellarSeriesCap admits the series new on their UTC day (no stellar_client_1d row yet) in key order while the
// tenant's series of that day stay below stellar_client_series_cap_per_tenant_day; the rest is dropped
// (stellar_series_overflow). The closed sets bound the series per service; this bounds the tenant.
func (w *work) stellarSeriesCap(ctx context.Context, pts []*stellarPending) ([]*stellarPending, error) {
	byDay := map[int64]map[seriesKey][]*stellarPending{}
	for _, sp := range pts {
		d := stellarTables[0].trunc(time.Unix(0, sp.p.Snap.Time).UTC()).UnixNano()
		if byDay[d] == nil {
			byDay[d] = map[seriesKey][]*stellarPending{}
		}
		k := seriesOf(sp)
		byDay[d][k] = append(byDay[d][k], sp)
	}
	limit := w.settings["stellar_client_series_cap_per_tenant_day"]
	drop := map[*stellarPending]bool{}
	for day, series := range byDay {
		var have int64
		existing := map[seriesKey]bool{}
		rows, err := w.tx.Query(ctx, `SELECT service_id::text, metric, network, operation, variant, outcome
  FROM scf.stellar_client_1d WHERE tenant_id = $1::uuid AND bucket_start = $2`, w.tenant, time.Unix(0, day).UTC())
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var k seriesKey
			if err := rows.Scan(&k.service, &k.metric, &k.network, &k.op, &k.variant, &k.outcome); err != nil {
				rows.Close()
				return nil, err
			}
			existing[k] = true
			have++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		var fresh []seriesKey
		for k := range series {
			if !existing[k] {
				fresh = append(fresh, k)
			}
		}
		slices.SortFunc(fresh, seriesKey.compare)
		for _, k := range fresh {
			if have < limit {
				have++
				continue
			}
			for _, sp := range series[k] {
				drop[sp] = true
				w.count(sp.p.Service, rules.ReasonStellarSeriesOverflow, 1)
			}
		}
	}
	out := pts[:0]
	for _, sp := range pts {
		if !drop[sp] {
			out = append(out, sp)
		}
	}
	return out, nil
}

type stellarRow struct {
	key    seriesKey
	bucket int64
	count  int64
	sum    float64
	h      hist.Row
	hasH   bool
	pts    []*stellarPending
}

const stellarUpsertSQL = `
INSERT INTO scf.%s AS t (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome,
                         count, duration_sum, hist, hist_quality)
SELECT $1::uuid, u.s::uuid, u.b, u.m, u.n, u.op, u.v, u.o, u.c, u.sm,
       CASE WHEN u.hh THEN ($11::int4[])[(u.i - 1) * 15 + 1 : u.i * 15] END, u.q
  FROM unnest($2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int8[],
              $10::float8[], $12::bool[], $13::int2[])
       WITH ORDINALITY AS u(s, b, m, n, op, v, o, c, sm, hh, q, i)
 ORDER BY u.s::uuid, u.b, u.m, u.n, u.op, u.v, u.o
ON CONFLICT (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome) DO UPDATE SET
  count        = t.count + EXCLUDED.count,
  duration_sum = t.duration_sum + EXCLUDED.duration_sum,
  hist         = scf.hist_add(t.hist, EXCLUDED.hist),
  hist_quality = GREATEST(t.hist_quality, EXCLUDED.hist_quality)
  WHERE t.count <= 9223372036854775807 - EXCLUDED.count
    AND (t.hist IS NULL OR scf.hist_merge_fits('explicit15', t.hist, 'explicit15', EXCLUDED.hist))
RETURNING service_id::text, bucket_start, metric, network, operation, variant, outcome`

// stellarUpsert adds the points into _1d, _1h and _1m (one multi-row upsert each, rows pre-aggregated per primary
// key, S-05). A merge that would overflow (hist_merge_fits, bigint count) is refused: count_overflow, and the point
// is left out of the finer tables (C-112(1)).
func (w *work) stellarUpsert(ctx context.Context, pts []*stellarPending) (int, error) {
	if len(pts) == 0 {
		return 0, nil
	}
	excluded := map[*stellarPending]bool{}
	type rk struct {
		k seriesKey
		b int64
	}
	for _, res := range stellarTables {
		rows := map[rk]*stellarRow{}
		var order []rk
		for _, sp := range pts {
			if excluded[sp] {
				continue
			}
			k := rk{seriesOf(sp), res.trunc(time.Unix(0, sp.p.Snap.Time).UTC()).UnixNano()}
			r := rows[k]
			if r == nil {
				r = &stellarRow{key: k.k, bucket: k.b, hasH: sp.p.Histogram}
				if sp.p.Histogram {
					r.h = hist.Row{Kind: hist.KindExplicit15, Counts: make([]int64, hist.Explicit15Len)}
				}
				rows[k] = r
				order = append(order, k)
			}
			if r.hasH && !r.h.Add(sp.row) || r.count > 1<<63-1-sp.count {
				excluded[sp] = true
				w.count(sp.p.Service, rules.ReasonCountOverflow, 1)
				continue
			}
			r.count += sp.count
			r.sum += sp.sum
			r.pts = append(r.pts, sp)
		}
		slices.SortFunc(order, func(a, b rk) int { return cmp.Or(a.k.compare(b.k), cmp.Compare(a.b, b.b)) })
		var (
			svc, metric, network, op, variant, outcome []string
			bucket                                     []time.Time
			count                                      []int64
			sum                                        []float64
			hasH                                       []bool
			quality                                    []int16
			flat                                       = make([]int32, 0, len(order)*hist.Explicit15Len)
		)
		var batchRows []*stellarRow
		for _, k := range order {
			r := rows[k]
			if len(r.pts) == 0 {
				continue
			}
			batchRows = append(batchRows, r)
			svc, metric, network = append(svc, r.key.service), append(metric, r.key.metric), append(network, r.key.network)
			op, variant, outcome = append(op, r.key.op), append(variant, r.key.variant), append(outcome, r.key.outcome)
			bucket, count, sum = append(bucket, time.Unix(0, r.bucket).UTC()), append(count, r.count), append(sum, r.sum)
			hasH, quality = append(hasH, r.hasH), append(quality, int16(r.h.Quality))
			for i := 0; i < hist.Explicit15Len; i++ {
				var c int64
				if r.hasH {
					c = r.h.Counts[i]
				}
				flat = append(flat, int32(c))
			}
		}
		if len(batchRows) == 0 {
			continue
		}
		res2, err := w.tx.Query(ctx, fmt.Sprintf(stellarUpsertSQL, res.table), w.tenant, svc, bucket, metric, network,
			op, variant, outcome, count, sum, flat, hasH, quality)
		if err != nil {
			return 0, err
		}
		applied := map[rk]bool{}
		for res2.Next() {
			var k seriesKey
			var b time.Time
			if err := res2.Scan(&k.service, &b, &k.metric, &k.network, &k.op, &k.variant, &k.outcome); err != nil {
				res2.Close()
				return 0, err
			}
			applied[rk{k, b.UnixNano()}] = true
		}
		res2.Close()
		if err := res2.Err(); err != nil {
			return 0, err
		}
		for _, r := range batchRows {
			if applied[rk{r.key, r.bucket}] {
				continue
			}
			for _, sp := range r.pts {
				if !excluded[sp] {
					excluded[sp] = true
					w.count(sp.p.Service, rules.ReasonCountOverflow, 1)
				}
			}
		}
	}
	n := 0
	for _, sp := range pts {
		if !excluded[sp] {
			n++
		}
	}
	w.s.obs.Points("applied", int64(n))
	return n, nil
}
