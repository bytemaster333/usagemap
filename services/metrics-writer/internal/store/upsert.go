// SPDX-License-Identifier: Apache-2.0

package store

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// resolution is one of the three metric tables.
type resolution struct {
	table string
	trunc func(time.Time) time.Time
}

var resolutions = []resolution{ // _1d first (C-112(1)): a point skipped there is left out of _1h and _1m
	{"api_metrics_1d", func(t time.Time) time.Time { y, m, d := t.Date(); return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }},
	{"api_metrics_1h", func(t time.Time) time.Time { return t.Truncate(time.Hour) }},
	{"api_metrics_1m", func(t time.Time) time.Time { return t.Truncate(time.Minute) }},
}

// rowKey is a metric table's primary key (without tenant_id) plus the histogram kind (one statement per kind).
type rowKey struct {
	service string
	bucket  int64 // unix ns
	route   int64
	method  int16
	status  int16
	source  string
	group   int64
	kind    hist.Kind
}

func (a rowKey) compare(b rowKey) int {
	return cmp.Or(cmp.Compare(a.service, b.service), cmp.Compare(a.bucket, b.bucket), cmp.Compare(a.route, b.route),
		cmp.Compare(a.method, b.method), cmp.Compare(a.status, b.status), cmp.Compare(a.source, b.source),
		cmp.Compare(a.group, b.group))
}

type aggRow struct {
	key      rowKey
	h        hist.Row
	count    int64
	sum      float64
	min, max *float64
	pts      []*pending
}

// merge adds a point into the row with the upsert's semantics (min/max NULL as soon as one side is unknown).
func (r *aggRow) merge(pp *pending) bool {
	if !r.h.Add(pp.conv.Row) {
		return false
	}
	r.count += pp.conv.Count
	r.sum += pp.conv.Sum
	if r.min == nil || pp.conv.Min == nil {
		r.min = nil
	} else {
		r.min = new(min(*r.min, *pp.conv.Min))
	}
	if r.max == nil || pp.conv.Max == nil {
		r.max = nil
	} else {
		r.max = new(max(*r.max, *pp.conv.Max))
	}
	r.pts = append(r.pts, pp)
	return true
}

// upsertSQL is §8.11's additive upsert as one multi-row INSERT … SELECT FROM unnest … ORDER BY <primary key> per
// (kind × resolution) (S-05, C-103). The histograms travel as one flat int4[] sliced per row ($15 = row width).
const upsertSQL = `
INSERT INTO scf.%s AS t
  (tenant_id, service_id, route_id, method, status_code, source, stream_group_id, bucket_start,
   request_count, duration_sum, duration_min, duration_max, hist_kind, hist, hist_quality)
SELECT $1::uuid, u.s::uuid, u.r, u.m, u.st, u.src::scf.metric_source, u.g, u.b,
       u.c, u.sm, u.mn, u.mx, $2::scf.hist_kind, ($14::int4[])[(u.i - 1) * $15 + 1 : u.i * $15], u.q
  FROM unnest($3::text[], $4::int8[], $5::int2[], $6::int2[], $7::text[], $8::int8[], $9::timestamptz[],
              $10::int8[], $11::float8[], $12::float8[], $13::float8[], $16::int2[])
       WITH ORDINALITY AS u(s, r, m, st, src, g, b, c, sm, mn, mx, q, i)
 ORDER BY u.s::uuid, u.b, u.r, u.m, u.st, u.src, u.g
ON CONFLICT (tenant_id, service_id, bucket_start, route_id, method, status_code, source, stream_group_id) DO UPDATE SET
  request_count = t.request_count + EXCLUDED.request_count,
  duration_sum  = t.duration_sum  + EXCLUDED.duration_sum,
  duration_min  = CASE WHEN t.duration_min IS NULL OR EXCLUDED.duration_min IS NULL THEN NULL
                       ELSE LEAST(t.duration_min, EXCLUDED.duration_min) END,
  duration_max  = CASE WHEN t.duration_max IS NULL OR EXCLUDED.duration_max IS NULL THEN NULL
                       ELSE GREATEST(t.duration_max, EXCLUDED.duration_max) END,
  hist          = CASE WHEN t.hist_kind = EXCLUDED.hist_kind THEN scf.hist_add(t.hist, EXCLUDED.hist)
                       ELSE scf.hist_add(scf.hist_to_explicit15(t.hist_kind, t.hist),
                                         scf.hist_to_explicit15(EXCLUDED.hist_kind, EXCLUDED.hist)) END,
  hist_kind     = CASE WHEN t.hist_kind = EXCLUDED.hist_kind THEN t.hist_kind ELSE 'explicit15'::scf.hist_kind END,
  hist_quality  = GREATEST(t.hist_quality, EXCLUDED.hist_quality,
                           CASE WHEN t.hist_kind <> EXCLUDED.hist_kind THEN 1 ELSE 0 END)
  WHERE scf.hist_merge_fits(t.hist_kind, t.hist, EXCLUDED.hist_kind, EXCLUDED.hist)
RETURNING service_id::text, route_id, method, status_code, source::text, stream_group_id, bucket_start`

var upsertSQLByTable = func() map[string]string {
	m := map[string]string{}
	for _, r := range resolutions {
		m[r.table] = fmt.Sprintf(upsertSQL, r.table)
	}
	return m
}()

// upsert writes the converted points into _1d, _1h and _1m and records the day-group presence. It returns the
// number of points applied.
func (w *work) upsert(ctx context.Context, pts []*pending) (int, error) {
	if len(pts) == 0 {
		return 0, nil
	}
	excluded := map[*pending]bool{}
	for ri, res := range resolutions {
		rows := map[rowKey]*aggRow{}
		var order []rowKey
		for _, pp := range pts {
			if excluded[pp] {
				continue
			}
			k := rowKey{pp.serviceID, res.trunc(time.Unix(0, pp.p.Snap.Time).UTC()).UnixNano(), pp.routeID,
				pp.p.Method, pp.p.Status, pp.p.Source, pp.groupID, pp.conv.Row.Kind}
			r := rows[k]
			if r == nil {
				h := hist.Row{Kind: pp.conv.Row.Kind, Counts: slices.Clone(pp.conv.Row.Counts), Quality: pp.conv.Row.Quality}
				rows[k] = &aggRow{key: k, h: h, count: pp.conv.Count, sum: pp.conv.Sum, min: pp.conv.Min, max: pp.conv.Max,
					pts: []*pending{pp}}
				order = append(order, k)
				continue
			}
			if !r.merge(pp) { // the request alone would push one stored row past int4
				excluded[pp] = true
				w.count(pp.p.Service, rules.ReasonCountOverflow, 1)
			}
		}
		slices.SortFunc(order, rowKey.compare)
		for _, kind := range []hist.Kind{hist.KindExplicit15, hist.KindExp3} {
			var batch []*aggRow
			for _, k := range order {
				if k.kind == kind {
					batch = append(batch, rows[k])
				}
			}
			applied, err := w.execUpsert(ctx, res.table, kind, batch)
			if err != nil {
				return 0, err
			}
			for _, r := range batch {
				if applied[r.key] {
					continue
				}
				// hist_merge_fits refused the merge (C-112(1)): count_overflow, and left out of the finer tables.
				for _, pp := range r.pts {
					if !excluded[pp] {
						excluded[pp] = true
						w.count(pp.p.Service, rules.ReasonCountOverflow, 1)
					}
				}
			}
		}
		if ri == 0 {
			if err := w.dayGroups(ctx, rows, excluded); err != nil {
				return 0, err
			}
		}
	}
	n := 0
	for _, pp := range pts {
		if !excluded[pp] {
			n++
		}
	}
	w.s.obs.Points("applied", int64(n))
	return n, nil
}

func (w *work) execUpsert(ctx context.Context, table string, kind hist.Kind, rows []*aggRow) (map[rowKey]bool, error) {
	applied := map[rowKey]bool{}
	if len(rows) == 0 {
		return applied, nil
	}
	width := kind.Len()
	var (
		svc     []string
		route   []int64
		method  []int16
		status  []int16
		source  []string
		group   []int64
		bucket  []time.Time
		count   []int64
		sum     []float64
		mins    []*float64
		maxs    []*float64
		quality []int16
		flat    = make([]int32, 0, len(rows)*width)
	)
	for _, r := range rows {
		svc, route, method, status = append(svc, r.key.service), append(route, r.key.route), append(method, r.key.method), append(status, r.key.status)
		source, group, bucket = append(source, r.key.source), append(group, r.key.group), append(bucket, time.Unix(0, r.key.bucket).UTC())
		count, sum, mins, maxs = append(count, r.count), append(sum, r.sum), append(mins, r.min), append(maxs, r.max)
		quality = append(quality, int16(r.h.Quality))
		for _, c := range r.h.Counts {
			flat = append(flat, int32(c))
		}
	}
	res, err := w.tx.Query(ctx, upsertSQLByTable[table], w.tenant, kind.String(), svc, route, method, status, source,
		group, bucket, count, sum, mins, maxs, flat, width, quality)
	if err != nil {
		return nil, err
	}
	defer res.Close()
	for res.Next() {
		var k rowKey
		var b time.Time
		if err := res.Scan(&k.service, &k.route, &k.method, &k.status, &k.source, &k.group, &b); err != nil {
			return nil, err
		}
		k.bucket, k.kind = b.UnixNano(), kind
		applied[k] = true
	}
	return applied, res.Err()
}

// dayGroups records which stream groups delivered data per service and UTC day (drives the preferred group, C-22).
func (w *work) dayGroups(ctx context.Context, rows map[rowKey]*aggRow, excluded map[*pending]bool) error {
	set := map[[3]string]int64{}
	for k, r := range rows {
		ok := false
		for _, pp := range r.pts {
			if !excluded[pp] {
				ok = true
				break
			}
		}
		if ok {
			set[[3]string{k.service, dayOf(time.Unix(0, k.bucket)), fmt.Sprintf("%020d", k.group)}] = k.group
		}
	}
	if len(set) == 0 {
		return nil
	}
	keys := make([][3]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b [3]string) int {
		return cmp.Or(cmp.Compare(a[0], b[0]), cmp.Compare(a[1], b[1]), cmp.Compare(a[2], b[2]))
	})
	var svcs, days []string
	var groups []int64
	for _, k := range keys {
		svcs, days, groups = append(svcs, k[0]), append(days, k[1]), append(groups, set[k])
	}
	_, err := w.tx.Exec(ctx, `
INSERT INTO scf.api_service_day_groups (tenant_id, service_id, day, stream_group_id)
SELECT $1::uuid, u.s::uuid, u.d::date, u.g FROM unnest($2::text[], $3::text[], $4::int8[]) AS u(s, d, g)
 ORDER BY 2, 3, 4
ON CONFLICT DO NOTHING`, w.tenant, svcs, days, groups)
	return err
}
