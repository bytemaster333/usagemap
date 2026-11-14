// SPDX-License-Identifier: Apache-2.0

package store

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/cumul"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// The integration client-metric stream (wire-formats §g.8, migration 0085): partner-API calls, agent-payment events
// and the anchor funnel of a tenant's own systems. Written into scf.integration_metrics_{1d,1h} — never into the
// API metrics and never into scf.stellar_client_* — in the tenant's transaction, after the Stellar client stream and
// before any API state row is locked, under the tenant's advisory lock (which serialises the stream state and the
// series caps across both writers). It follows the Stellar client stream (stellar.go) step by step; the differences
// are the seven dimension columns, no minute table, long durations kept as count and sum, and a per-service daily
// series cap besides the tenant's.

// integrationMaxAge keeps the hour table's retention (35 days) clear.
const (
	integrationMaxAge    = 34 * 24 * time.Hour
	integrationMaxFuture = time.Hour
)

var integrationTables = []resolution{ // _1d first: a point refused there is left out of _1h (C-112(1))
	{"integration_metrics_1d", resolutions[0].trunc},
	{"integration_metrics_1h", resolutions[1].trunc},
}

type integrationPending struct {
	p         *batch.IntegrationPoint
	serviceID string
	count     int64
	sum       float64
	row       hist.Row // explicit15, short durations only
}

// intSeries is a series of a UTC day: one integration_metrics_1d row.
type intSeries struct {
	service, metric, network string
	d                        [batch.IntegrationDims]string
}

func (a intSeries) compare(b intSeries) int {
	c := cmp.Or(cmp.Compare(a.service, b.service), cmp.Compare(a.metric, b.metric), cmp.Compare(a.network, b.network))
	for i := range a.d {
		c = cmp.Or(c, cmp.Compare(a.d[i], b.d[i]))
	}
	return c
}

func intSeriesOf(ip *integrationPending) intSeries {
	return intSeries{ip.serviceID, ip.p.Metric, ip.p.Network, ip.p.Dims}
}

// integrationRegistrants: as stellarRegistrants — a backend instrumented only with an integration package is a
// service of the tenant like any other (same quota and audit row).
func (w *work) integrationRegistrants() []*pending {
	var out []*pending
	seen := map[string]bool{}
	for i := range w.part.Integration {
		s := w.part.Integration[i].Service
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, &pending{p: &batch.Point{Service: s}})
	}
	return out
}

// integration applies the part's integration client metrics and returns the number of points written.
func (w *work) integration(ctx context.Context) (int, error) {
	if len(w.part.Integration) == 0 {
		return 0, nil
	}
	var pts []*integrationPending
	for i := range w.part.Integration {
		p := &w.part.Integration[i]
		sv, ok := w.services[p.Service]
		if !ok {
			continue // counted service_quota_exceeded / malformed_point in resolveServices
		}
		t := time.Unix(0, p.Snap.Time)
		switch {
		case t.Before(w.now.Add(-integrationMaxAge)):
			w.count(p.Service, rules.ReasonTooOld, 1)
			continue
		case t.After(w.now.Add(integrationMaxFuture)):
			w.count(p.Service, rules.ReasonFuture, 1)
			continue
		case t.Before(sv.registeredAt.Add(-backfillSlack)):
			w.count(p.Service, rules.ReasonBeforeRegistration, 1)
			continue
		}
		pts = append(pts, &integrationPending{p: p, serviceID: sv.id})
	}
	if len(pts) == 0 {
		return 0, nil
	}
	if err := w.lock(ctx); err != nil {
		return 0, err
	}
	pts, err := w.integrationCumulative(ctx, pts)
	if err != nil {
		return 0, err
	}
	pts = w.integrationConvert(pts)
	if pts, err = w.integrationSeriesCap(ctx, pts); err != nil {
		return 0, err
	}
	return w.integrationUpsert(ctx, pts)
}

// integrationCumulative turns cumulative points into deltas (cumul.Step, §9.4, C-122) against
// scf.integration_stream_state, bounded by integration_stream_cap_per_tenant.
func (w *work) integrationCumulative(ctx context.Context, pts []*integrationPending) ([]*integrationPending, error) {
	byKey := map[[32]byte][]*integrationPending{}
	sources := map[[32]byte]bool{}
	for _, ip := range pts {
		if ip.p.Cumulative {
			byKey[ip.p.StreamKey] = append(byKey[ip.p.StreamKey], ip)
			sources[ip.p.SourceKey] = true
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
	known := map[[32]byte]bool{}
	rows, err := w.tx.Query(ctx, `SELECT DISTINCT source_key FROM scf.integration_stream_state
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
	states, err := w.integrationStates(ctx, keys)
	if err != nil {
		return nil, err
	}
	var held int64
	if err := w.tx.QueryRow(ctx, `SELECT count(*) FROM scf.integration_stream_state WHERE tenant_id = $1::uuid`, w.tenant).
		Scan(&held); err != nil {
		return nil, err
	}
	capacity := w.settings["integration_stream_cap_per_tenant"] - held
	drop := map[*integrationPending]bool{}
	type upd struct {
		key, src []byte
		svc      string
		snap     *cumul.Snapshot
	}
	var updates []upd
	for _, k := range keys {
		key := [32]byte(k)
		group := byKey[key]
		prev, had := states[key]
		if !had {
			if capacity <= 0 {
				for _, ip := range group {
					drop[ip] = true
					w.count(ip.p.Service, rules.ReasonStellarSeriesOverflow, 1)
				}
				continue
			}
			capacity--
		}
		slices.SortStableFunc(group, func(a, b *integrationPending) int { return cmp.Compare(a.p.Snap.Time, b.p.Snap.Time) })
		orig := prev
		for _, ip := range group {
			delta, next, out := cumul.Step(prev, ip.p.Snap, known[ip.p.SourceKey])
			switch out {
			case cumul.FirstSeed:
				w.count(ip.p.Service, rules.ReasonCumulativeFirstPoint, 1)
				w.s.obs.Points("seeded", 1)
			case cumul.ResetDelta, cumul.ResetDrop:
				w.count(ip.p.Service, rules.ReasonCumulativeReset, 1)
			case cumul.Stale:
				w.s.obs.Points("stale", 1)
			}
			if delta == nil {
				drop[ip] = true
			} else {
				ip.p.Snap = *delta
				ip.p.Min, ip.p.Max = nil, nil
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
INSERT INTO scf.integration_stream_state AS s (tenant_id, stream_key, source_key, service_id, start_time_unix_ns,
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
	for _, ip := range pts {
		if !drop[ip] {
			out = append(out, ip)
		}
	}
	return out, nil
}

func (w *work) integrationStates(ctx context.Context, keys [][]byte) (map[[32]byte]*cumul.Snapshot, error) {
	rows, err := w.tx.Query(ctx, `
SELECT stream_key, start_time_unix_ns, last_time_unix_ns, last_count, last_sum, last_layout, last_buckets,
       last_zero_count, last_exp_offset
  FROM scf.integration_stream_state WHERE tenant_id = $1::uuid AND stream_key = ANY($2::bytea[])`, w.tenant, keys)
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
			return nil, fmt.Errorf("integration stream state layout: %w", err)
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

// integrationConvert: short durations into explicit15 (count_overflow / malformed_point as on the API path); long
// durations keep count and sum (a finite, non-negative sum, else malformed_point); counters their value. Empty
// deltas write nothing.
func (w *work) integrationConvert(pts []*integrationPending) []*integrationPending {
	out := pts[:0]
	for _, ip := range pts {
		switch {
		case !ip.p.Histogram:
			if ip.p.Snap.Count == 0 {
				continue
			}
			ip.count = clampI64(ip.p.Snap.Count)
		case ip.p.Long:
			if ip.p.Snap.Count == 0 {
				continue
			}
			if s := ip.p.Snap.Sum; math.IsNaN(s) || math.IsInf(s, 0) || s < 0 || ip.p.Snap.Negative > 0 {
				w.count(ip.p.Service, rules.ReasonMalformedPoint, 1)
				continue
			}
			ip.count, ip.sum = clampI64(ip.p.Snap.Count), ip.p.Snap.Sum
		default:
			c, err := batch.ConvertExplicit15(ip.p.Snap, ip.p.Min, ip.p.Max)
			switch {
			case errors.Is(err, hist.ErrCountOverflow):
				w.count(ip.p.Service, rules.ReasonCountOverflow, 1)
				continue
			case err != nil:
				w.count(ip.p.Service, rules.ReasonMalformedPoint, 1)
				continue
			}
			if c.Count == 0 {
				continue
			}
			for _, r := range c.Reasons {
				w.count(ip.p.Service, r, 1)
			}
			ip.count, ip.sum, ip.row = c.Count, c.Sum, c.Row
		}
		out = append(out, ip)
	}
	return out
}

// integrationSeriesCap admits the series new on their UTC day (no integration_metrics_1d row yet) in key order while
// both the tenant's series of that day stay below integration_series_cap_per_tenant_day and the service's below
// integration_series_cap_per_service_day; the rest is dropped (stellar_series_overflow).
func (w *work) integrationSeriesCap(ctx context.Context, pts []*integrationPending) ([]*integrationPending, error) {
	byDay := map[int64]map[intSeries][]*integrationPending{}
	for _, ip := range pts {
		d := integrationTables[0].trunc(time.Unix(0, ip.p.Snap.Time).UTC()).UnixNano()
		if byDay[d] == nil {
			byDay[d] = map[intSeries][]*integrationPending{}
		}
		k := intSeriesOf(ip)
		byDay[d][k] = append(byDay[d][k], ip)
	}
	tenantLimit := w.settings["integration_series_cap_per_tenant_day"]
	serviceLimit := w.settings["integration_series_cap_per_service_day"]
	drop := map[*integrationPending]bool{}
	for day, series := range byDay {
		var have int64
		perService := map[string]int64{}
		existing := map[intSeries]bool{}
		rows, err := w.tx.Query(ctx, `SELECT service_id::text, metric, network, d1, d2, d3, d4, d5, d6, d7
  FROM scf.integration_metrics_1d WHERE tenant_id = $1::uuid AND bucket_start = $2`, w.tenant, time.Unix(0, day).UTC())
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var k intSeries
			if err := rows.Scan(&k.service, &k.metric, &k.network, &k.d[0], &k.d[1], &k.d[2], &k.d[3], &k.d[4], &k.d[5],
				&k.d[6]); err != nil {
				rows.Close()
				return nil, err
			}
			existing[k] = true
			have++
			perService[k.service]++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		var fresh []intSeries
		for k := range series {
			if !existing[k] {
				fresh = append(fresh, k)
			}
		}
		slices.SortFunc(fresh, intSeries.compare)
		for _, k := range fresh {
			if have < tenantLimit && perService[k.service] < serviceLimit {
				have++
				perService[k.service]++
				continue
			}
			for _, ip := range series[k] {
				drop[ip] = true
				w.count(ip.p.Service, rules.ReasonStellarSeriesOverflow, 1)
			}
		}
	}
	out := pts[:0]
	for _, ip := range pts {
		if !drop[ip] {
			out = append(out, ip)
		}
	}
	return out, nil
}

const integrationUpsertSQL = `
INSERT INTO scf.%s AS t (tenant_id, service_id, bucket_start, metric, network, d1, d2, d3, d4, d5, d6, d7,
                         count, duration_sum, hist, hist_quality)
SELECT $1::uuid, u.s::uuid, u.b, u.m, u.n, u.d1, u.d2, u.d3, u.d4, u.d5, u.d6, u.d7, u.c, u.sm,
       CASE WHEN u.hh THEN ($16::int4[])[(u.i - 1) * 15 + 1 : u.i * 15] END, u.q
  FROM unnest($2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
              $10::text[], $11::text[], $12::text[], $13::int8[], $14::float8[], $15::bool[], $17::int2[])
       WITH ORDINALITY AS u(s, b, m, n, d1, d2, d3, d4, d5, d6, d7, c, sm, hh, q, i)
 ORDER BY u.s::uuid, u.b, u.m, u.n, u.d1, u.d2, u.d3, u.d4, u.d5, u.d6, u.d7
ON CONFLICT (tenant_id, service_id, bucket_start, metric, network, d1, d2, d3, d4, d5, d6, d7) DO UPDATE SET
  count        = t.count + EXCLUDED.count,
  duration_sum = t.duration_sum + EXCLUDED.duration_sum,
  hist         = scf.hist_add(t.hist, EXCLUDED.hist),
  hist_quality = GREATEST(t.hist_quality, EXCLUDED.hist_quality)
  WHERE t.count <= 9223372036854775807 - EXCLUDED.count
    AND (t.hist IS NULL OR scf.hist_merge_fits('explicit15', t.hist, 'explicit15', EXCLUDED.hist))
RETURNING service_id::text, bucket_start, metric, network, d1, d2, d3, d4, d5, d6, d7`

type integrationRow struct {
	key    intSeries
	bucket int64
	count  int64
	sum    float64
	h      hist.Row
	hasH   bool
	pts    []*integrationPending
}

// integrationUpsert adds the points into _1d and _1h (one multi-row upsert each, rows pre-aggregated per primary
// key). A merge that would overflow is refused: count_overflow, and the point is left out of the finer table.
func (w *work) integrationUpsert(ctx context.Context, pts []*integrationPending) (int, error) {
	if len(pts) == 0 {
		return 0, nil
	}
	excluded := map[*integrationPending]bool{}
	type rk struct {
		k intSeries
		b int64
	}
	for _, res := range integrationTables {
		rows := map[rk]*integrationRow{}
		var order []rk
		for _, ip := range pts {
			if excluded[ip] {
				continue
			}
			k := rk{intSeriesOf(ip), res.trunc(time.Unix(0, ip.p.Snap.Time).UTC()).UnixNano()}
			r := rows[k]
			short := ip.p.Histogram && !ip.p.Long
			if r == nil {
				r = &integrationRow{key: k.k, bucket: k.b, hasH: short}
				if short {
					r.h = hist.Row{Kind: hist.KindExplicit15, Counts: make([]int64, hist.Explicit15Len)}
				}
				rows[k] = r
				order = append(order, k)
			}
			if r.hasH && !r.h.Add(ip.row) || r.count > 1<<63-1-ip.count {
				excluded[ip] = true
				w.count(ip.p.Service, rules.ReasonCountOverflow, 1)
				continue
			}
			r.count += ip.count
			r.sum += ip.sum
			r.pts = append(r.pts, ip)
		}
		slices.SortFunc(order, func(a, b rk) int { return cmp.Or(a.k.compare(b.k), cmp.Compare(a.b, b.b)) })
		var (
			svc, metric, network []string
			dims                 [batch.IntegrationDims][]string
			bucket               []time.Time
			count                []int64
			sum                  []float64
			hasH                 []bool
			quality              []int16
			flat                 = make([]int32, 0, len(order)*hist.Explicit15Len)
			batchRows            []*integrationRow
		)
		for _, k := range order {
			r := rows[k]
			if len(r.pts) == 0 {
				continue
			}
			batchRows = append(batchRows, r)
			svc, metric, network = append(svc, r.key.service), append(metric, r.key.metric), append(network, r.key.network)
			for i := range dims {
				dims[i] = append(dims[i], r.key.d[i])
			}
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
		res2, err := w.tx.Query(ctx, fmt.Sprintf(integrationUpsertSQL, res.table), w.tenant, svc, bucket, metric, network,
			dims[0], dims[1], dims[2], dims[3], dims[4], dims[5], dims[6], count, sum, hasH, flat, quality)
		if err != nil {
			return 0, err
		}
		applied := map[rk]bool{}
		for res2.Next() {
			var k intSeries
			var b time.Time
			if err := res2.Scan(&k.service, &b, &k.metric, &k.network, &k.d[0], &k.d[1], &k.d[2], &k.d[3], &k.d[4],
				&k.d[5], &k.d[6]); err != nil {
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
			for _, ip := range r.pts {
				if !excluded[ip] {
					excluded[ip] = true
					w.count(ip.p.Service, rules.ReasonCountOverflow, 1)
				}
			}
		}
	}
	n := 0
	for _, ip := range pts {
		if !excluded[ip] {
			n++
		}
	}
	w.s.obs.Points("applied", int64(n))
	return n, nil
}
