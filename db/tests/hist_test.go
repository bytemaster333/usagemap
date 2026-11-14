// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Histogram SQL (docs/data-model.md §9, S-05, C-103) — a smaller-sample port of spikes/s05-histogram-sql:
// the precomputed hist_exp3_map conversion equals the S-05-validated per-call CTE; exp3 quantiles stay within
// 4.33 %; explicit15 quantiles within the width of the bucket holding the exact value; merges are exact across rows
// and across 1m → 1h → 1d through the writer's upsert; mixed kinds collapse to explicit15; the int4 guard skips a
// merge that would overflow; sums accumulate beyond 2^31; the bucket-1 rule reports 0.005 s.

var explicitBounds = []float64{0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10}

var exp3Bound = (math.Pow(2, 1.0/8) - 1) / (math.Pow(2, 1.0/8) + 1) // 0.04329

// explicitIdx is §9.1: idx(v) = 1 + |{b ∈ B : b < v}| (1-based).
func explicitIdx(v float64) int {
	n := 0
	for _, b := range explicitBounds {
		if b < v {
			n++
		}
	}
	return n + 1
}

// exp3Idx is §9.2: OTLP index at scale 3, i = ceil(log2(v)·8) − 1, element k = i + 114 clamped to [1, 194].
func exp3Idx(v float64) int {
	k := int(math.Ceil(math.Log2(v)*8)-1) + 114
	return min(max(k, 1), 194)
}

func bucketize(vs []float64) (e15 []int64, e3 []int64) {
	e15, e3 = make([]int64, 15), make([]int64, 194)
	for _, v := range vs {
		e15[explicitIdx(v)-1]++
		e3[exp3Idx(v)-1]++
	}
	return
}

func distributions(n int) map[string][]float64 {
	r := rand.New(rand.NewPCG(20261112, 1))
	logn := func(med, sigma float64) float64 { return math.Exp(math.Log(med) + sigma*r.NormFloat64()) }
	gen := func(f func() float64) []float64 {
		out := make([]float64, n)
		for i := range out {
			out[i] = f()
		}
		return out
	}
	return map[string][]float64{
		"lognormal_82ms": gen(func() float64 { return logn(0.082, 0.8) }),
		"bimodal_15ms_450ms": gen(func() float64 {
			if r.Float64() < 0.7 {
				return logn(0.015, 0.3)
			}
			return logn(0.45, 0.25)
		}),
		"heavy_tail_pareto": gen(func() float64 { return 0.02 * math.Pow(1-r.Float64(), -1/0.9) }),
		"narrow_120ms":      gen(func() float64 { return math.Abs(0.120 + 0.003*r.NormFloat64()) }),
		"submillisecond":    gen(func() float64 { return logn(0.0003, 0.5) }),
	}
}

func exactQuantile(sorted []float64, q float64) float64 { // numpy method='inverted_cdf'
	i := int(math.Ceil(q*float64(len(sorted)))) - 1
	return sorted[max(i, 0)]
}

func TestHistExp3MapEqualsS05CTE(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	// the S-05-validated per-call CTE (docs/data-model.md before C-103), as a temporary reference function
	mustExec(t, su, `CREATE FUNCTION pg_temp.hist_exp3_ref(h bigint[]) RETURNS bigint[] LANGUAGE sql IMMUTABLE AS $$
	  WITH src AS (
	    SELECT k, h[k] AS n,
	           CASE WHEN k BETWEEN 2 AND 193 THEN power(2::float8, (k - 114) / 8.0) END AS lo,
	           CASE WHEN k BETWEEN 2 AND 193 THEN power(2::float8, (k - 113) / 8.0) END AS hi
	      FROM generate_subscripts(h, 1) AS k WHERE h[k] <> 0),
	  idx AS (
	    SELECT s.*, b.ub,
	           CASE WHEN s.k = 1 THEN 1 WHEN s.k = 194 THEN 15
	                ELSE 1 + (SELECT count(*) FROM unnest(b.ub) x WHERE x <= s.lo)::int END AS j_lo,
	           CASE WHEN s.k = 1 THEN 1 WHEN s.k = 194 THEN 15
	                ELSE 1 + (SELECT count(*) FROM unnest(b.ub) x WHERE x <  s.hi)::int END AS j_hi
	      FROM src s CROSS JOIN (SELECT scf.explicit15_bounds() AS ub) b),
	  parts AS (
	    SELECT j_hi AS j, n AS c FROM idx WHERE j_lo = j_hi
	    UNION ALL SELECT j_lo, round(n * ln(ub[j_lo] / lo) / ln(hi / lo))::bigint FROM idx WHERE j_lo <> j_hi
	    UNION ALL SELECT j_hi, n - round(n * ln(ub[j_lo] / lo) / ln(hi / lo))::bigint FROM idx WHERE j_lo <> j_hi)
	  SELECT ARRAY(SELECT COALESCE(sum(p.c), 0)::bigint FROM generate_series(1, 15) AS g(j)
	                 LEFT JOIN parts p ON p.j = g.j GROUP BY g.j ORDER BY g.j)
	  $$`)
	r := rand.New(rand.NewPCG(7, 11))
	const n = 2000
	batch := &pgx.Batch{}
	for i := 0; i < n; i++ {
		h := make([]int64, 194)
		for j := 0; j < 1+r.IntN(20); j++ {
			h[r.IntN(194)] += 1 + r.Int64N(1_000_000)
		}
		if i%10 == 0 {
			h[0] += 5
			h[193] += 7
		}
		batch.Queue(`SELECT scf.hist_exp3_to_explicit15($1) = pg_temp.hist_exp3_ref($1),
		                    (SELECT sum(x) FROM unnest(scf.hist_exp3_to_explicit15($1)) x) = (SELECT sum(x) FROM unnest($1::bigint[]) x)`, h)
	}
	br := su.SendBatch(ctx, batch)
	mismatch, lost := 0, 0
	for i := 0; i < n; i++ {
		var eq, total bool
		if err := br.QueryRow().Scan(&eq, &total); err != nil {
			t.Fatal(sqlState(err))
		}
		if !eq {
			mismatch++
		}
		if !total {
			lost++
		}
	}
	_ = br.Close()
	if mismatch > 0 || lost > 0 {
		t.Errorf("hist_exp3_map conversion vs S-05 CTE: %d/%d mismatches, %d totals not preserved", mismatch, n, lost)
	}
	t.Logf("hist_exp3_to_explicit15 (map) = S-05 CTE on %d random sparse histograms: %d mismatches", n, mismatch)
	// the map itself: 194 rows, every element splits across at most one bound (S-05: adjacent bounds ≥ 4/3 apart)
	var rows, straddle int
	if err := su.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE j_hi <> j_lo) FROM scf.hist_exp3_map`).Scan(&rows, &straddle); err != nil {
		t.Fatal(err)
	}
	if rows != 194 || straddle == 0 || straddle > 14 {
		t.Errorf("hist_exp3_map: %d rows, %d straddling elements", rows, straddle)
	}
}

func TestHistQuantileAccuracy(t *testing.T) {
	app := runtimeConn(t, "scf_app") // quantiles computed by the tenant role through PgBouncer
	ctx := context.Background()
	q := func(kind string, h []int64, p float64, vmin, vmax any) float64 {
		var v *float64
		if err := app.QueryRow(ctx, `SELECT scf.hist_quantile($1::scf.hist_kind, $2::bigint[], $3, $4, $5)`, kind, h, p, vmin, vmax).Scan(&v); err != nil || v == nil {
			t.Fatalf("hist_quantile(%s, q=%v): %v %s", kind, p, v, sqlState(err))
		}
		return *v
	}
	worstExp3 := 0.0
	for name, vs := range distributions(50_000) {
		sorted := slices.Clone(vs)
		slices.Sort(sorted)
		vmin, vmax := sorted[0], sorted[len(sorted)-1]
		e15, e3 := bucketize(vs)
		for _, p := range []float64{0.50, 0.95, 0.99} {
			exact := exactQuantile(sorted, p)
			// exp3: within (2^(1/8)−1)/(2^(1/8)+1) unless the value is in the underflow/overflow element
			if k := exp3Idx(exact); k > 1 && k < 194 {
				est := q("exp3", e3, p, vmin, vmax)
				rel := math.Abs(est-exact) / exact
				worstExp3 = math.Max(worstExp3, rel)
				if rel > exp3Bound+1e-12 {
					t.Errorf("%s p%.0f exp3: est %.6g exact %.6g rel %.4f > %.4f", name, p*100, est, exact, rel, exp3Bound)
				}
			}
			// explicit15: within the width of the bucket holding the exact value
			est := q("explicit15", e15, p, vmin, vmax)
			j := explicitIdx(exact)
			lo, hi := 0.0, 0.0
			if j > 1 {
				lo = explicitBounds[j-2]
			}
			if j < 15 {
				hi = explicitBounds[j-1]
			} else {
				hi = math.Max(vmax, 10)
			}
			if math.Abs(est-exact) > hi-lo+1e-12 {
				t.Errorf("%s p%.0f explicit15: est %.6g exact %.6g outside bucket width %.6g", name, p*100, est, exact, hi-lo)
			}
		}
	}
	t.Logf("exp3 worst relative error %.4f (bound %.4f)", worstExp3, exp3Bound)

	// bucket-1 rule (C-103): explicit15 quantile in bucket 1 with vmin unknown reports the bound 0.005 ("≤ 5 ms")
	h := make([]int64, 15)
	h[0] = 1000
	if v := q("explicit15", h, 0.5, nil, nil); v != 0.005 {
		t.Errorf("bucket-1 rule: want 0.005, got %v", v)
	}
	if v := q("explicit15", h, 0.5, nil, 0.002); v != 0.002 {
		t.Errorf("bucket-1 rule clamped to vmax: want 0.002, got %v", v)
	}
}

func TestHistSumAndMergeFits(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	ctx := context.Background()
	var total int64
	if err := app.QueryRow(ctx, `SELECT (scf.hist_sum(h))[1] FROM (VALUES ('{2147483647,0,0,0,0,0,0,0,0,0,0,0,0,0,0}'::int4[]),
	    ('{2147483647,0,0,0,0,0,0,0,0,0,0,0,0,0,0}'::int4[]), ('{10,0,0,0,0,0,0,0,0,0,0,0,0,0,0}'::int4[])) v(h)`).Scan(&total); err != nil {
		t.Fatal(sqlState(err))
	}
	if total != 2*2147483647+10 {
		t.Errorf("hist_sum beyond 2^31: got %d", total)
	}
	cases := []struct {
		ka, a, kb, b string
		fits         bool
	}{
		{"explicit15", "{2147483600,0,0,0,0,0,0,0,0,0,0,0,0,0,0}", "explicit15", "{47,0,0,0,0,0,0,0,0,0,0,0,0,0,0}", true},
		{"explicit15", "{2147483600,0,0,0,0,0,0,0,0,0,0,0,0,0,0}", "explicit15", "{48,0,0,0,0,0,0,0,0,0,0,0,0,0,0}", false},
	}
	for _, c := range cases {
		var fits bool
		if err := app.QueryRow(ctx, `SELECT scf.hist_merge_fits($1::scf.hist_kind, $2::int4[], $3::scf.hist_kind, $4::int4[])`,
			c.ka, c.a, c.kb, c.b).Scan(&fits); err != nil {
			t.Fatal(sqlState(err))
		}
		if fits != c.fits {
			t.Errorf("hist_merge_fits(%s, %s): want %v", c.a, c.b, c.fits)
		}
	}
	// mixed kinds: an exp3 element mapped into explicit15 bucket 1 that would overflow there
	e3 := make([]int32, 194)
	e3[0] = 100
	var fits bool
	if err := app.QueryRow(ctx, `SELECT scf.hist_merge_fits('explicit15', '{2147483600,0,0,0,0,0,0,0,0,0,0,0,0,0,0}', 'exp3', $1::int4[])`, e3).Scan(&fits); err != nil || fits {
		t.Errorf("mixed-kind overflow not detected: fits=%v %s", fits, sqlState(err))
	}
}

// writerUpsert is the §8.11 upsert (C-112(1) WHERE guard) for one resolution.
func writerUpsert(res string) string {
	return fmt.Sprintf(`INSERT INTO scf.api_metrics_%s AS t
  (tenant_id, service_id, route_id, method, status_code, source, stream_group_id, bucket_start,
   request_count, duration_sum, duration_min, duration_max, hist_kind, hist, hist_quality)
VALUES ($1, $2, $3, $4, 200, 'sdk_metric', $5, $6, $7, $8, $9, $10, $11::scf.hist_kind, $12::int4[], $13)
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
RETURNING bucket_start`, res)
}

func TestHistMergeThroughWriter(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	var route, group int64
	if err := su.QueryRow(ctx, `SELECT r.route_id, g.group_id FROM scf.api_routes r, scf.api_stream_groups g
	    WHERE r.tenant_id = $1 AND g.tenant_id = $1`, A).Scan(&route, &group); err != nil {
		t.Fatal(err)
	}
	svc := uid(A, 3)
	t.Cleanup(func() {
		for _, res := range []string{"1m", "1h", "1d"} {
			mustExec(t, su, fmt.Sprintf(`DELETE FROM scf.api_metrics_%s WHERE tenant_id = $1 AND method IN (3, 4, 5, 6)`, res), A)
		}
	})
	var hour time.Time
	if err := su.QueryRow(ctx, `SELECT date_trunc('hour', now(), 'UTC')`).Scan(&hour); err != nil {
		t.Fatal(err)
	}
	hour = hour.UTC()
	day := time.Date(hour.Year(), hour.Month(), hour.Day(), 0, 0, 0, 0, time.UTC)
	vs := distributions(20_000)["lognormal_82ms"]
	full15, full3 := bucketize(vs)

	wr := runtimeConn(t, "scf_writer")
	tx, err := wr.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := setCtx(ctx, tx, Ctx{Tenant: A, Kind: "writer", Actor: "writer"}); err != nil {
		t.Fatal(sqlState(err))
	}
	type point struct {
		method int
		kind   string
		h      []int64
		count  int64
		sum    float64
		vmin   float64
		vmax   float64
	}
	// 60 one-minute rows per kind: method 3 = explicit15, method 4 = exp3
	upsert := func(p point, minute int) int {
		applied := 0
		for _, res := range []string{"1d", "1h", "1m"} { // C-112(1): order _1d, _1h, _1m
			bucket := map[string]time.Time{"1d": day, "1h": hour, "1m": hour.Add(time.Duration(minute) * time.Minute)}[res]
			rows, err := tx.Query(ctx, writerUpsert(res), A, svc, route, p.method, group, bucket, p.count, p.sum, p.vmin, p.vmax,
				p.kind, p.h, 0)
			if err != nil {
				t.Fatalf("upsert %s: %s", res, sqlState(err))
			}
			for rows.Next() {
				applied++
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				t.Fatalf("upsert %s: %s", res, sqlState(err))
			}
		}
		return applied
	}
	per := len(vs) / 60
	for m := 0; m < 60; m++ {
		chunk := vs[m*per : (m+1)*per]
		if m == 59 {
			chunk = vs[m*per:]
		}
		e15, e3 := bucketize(chunk)
		mn, mx, s := slices.Min(chunk), slices.Max(chunk), 0.0
		for _, v := range chunk {
			s += v
		}
		upsert(point{3, "explicit15", e15, int64(len(chunk)), s, mn, mx}, m)
		upsert(point{4, "exp3", e3, int64(len(chunk)), s, mn, mx}, m)
	}
	// mixed kinds on one key (method 5): collapses to explicit15 with quality 1
	upsert(point{5, "exp3", full3, int64(len(vs)), 1, 0.001, 9}, 0)
	upsert(point{5, "explicit15", full15, int64(len(vs)), 1, 0.001, 9}, 0)
	// int4 guard (method 6): the second merge would overflow bucket 1 and is skipped (no row returned)
	big := make([]int64, 15)
	big[0] = 2147483600
	small := make([]int64, 15)
	small[0] = 100
	if n := upsert(point{6, "explicit15", big, 2147483600, 1, 0.001, 0.002}, 1); n != 3 {
		t.Fatalf("first int4 point: %d of 3 resolutions applied", n)
	}
	if n := upsert(point{6, "explicit15", small, 100, 1, 0.001, 0.002}, 1); n != 0 {
		t.Errorf("C-112(1): merge past int4 must be skipped at every resolution, %d applied", n)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(sqlState(err))
	}

	// read back as the tenant (scf_app, PgBouncer) through the *_pref views with the §9.3 range-query pattern
	app := runtimeConn(t, "scf_app")
	err = inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		for _, m := range []struct {
			method int
			kind   string
			want   []int64
		}{{3, "explicit15", full15}, {4, "exp3", full3}} {
			var quantiles []string
			for _, res := range []string{"1m", "1h", "1d"} {
				var h []int64
				var n int64
				var class string
				var p50, p95, p99 float64
				err := tx.QueryRow(ctx, fmt.Sprintf(`
				  WITH r AS (
				    SELECT sum(request_count) AS requests,
				           bool_and(hist_kind = 'exp3') AS all_exp3, bool_and(hist_kind = 'explicit15') AS all_exp15,
				           max(hist_quality)::smallint AS q,
				           CASE WHEN bool_and(hist_kind = 'exp3') THEN scf.hist_sum(hist)
				                ELSE scf.hist_add8(scf.hist_sum(hist) FILTER (WHERE hist_kind = 'explicit15'),
				                                   scf.hist_exp3_to_explicit15(scf.hist_sum(hist) FILTER (WHERE hist_kind = 'exp3'))) END AS h,
				           CASE WHEN bool_and(duration_min IS NOT NULL) THEN min(duration_min) END AS vmin,
				           CASE WHEN bool_and(duration_max IS NOT NULL) THEN max(duration_max) END AS vmax
				      FROM scf.api_metrics_%s_pref
				     WHERE tenant_id = $1 AND method = $2)
				  SELECT h, requests::bigint, scf.accuracy_class(all_exp3, all_exp15, q),
				         scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.50, vmin, vmax),
				         scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.95, vmin, vmax),
				         scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.99, vmin, vmax)
				    FROM r`, res), A, m.method).Scan(&h, &n, &class, &p50, &p95, &p99)
				if err != nil {
					return fmt.Errorf("%s %s: %s", m.kind, res, sqlState(err))
				}
				if !slices.Equal(h, m.want) || n != int64(len(vs)) || class != m.kind {
					return fmt.Errorf("%s at %s: merged histogram differs from the unsplit one (n=%d, class=%s)", m.kind, res, n, class)
				}
				quantiles = append(quantiles, fmt.Sprintf("%.9g/%.9g/%.9g", p50, p95, p99))
			}
			if quantiles[0] != quantiles[1] || quantiles[1] != quantiles[2] {
				return fmt.Errorf("%s quantiles differ across 1m/1h/1d: %v", m.kind, quantiles)
			}
		}
		var kind, class string
		var quality int16
		if err := tx.QueryRow(ctx, `SELECT hist_kind::text, hist_quality, scf.accuracy_class(false, true, hist_quality)
		    FROM scf.api_metrics_1d WHERE tenant_id = $1 AND method = 5`, A).Scan(&kind, &quality, &class); err != nil {
			return err
		}
		if kind != "explicit15" || quality != 1 || class != "explicit15_approx" {
			return fmt.Errorf("mixed kinds: got %s quality %d class %s", kind, quality, class)
		}
		var b1 int64
		if err := tx.QueryRow(ctx, `SELECT hist[1] FROM scf.api_metrics_1d WHERE tenant_id = $1 AND method = 6`, A).Scan(&b1); err != nil {
			return err
		}
		if b1 != 2147483600 {
			return fmt.Errorf("int4 guard: stored bucket changed to %d", b1)
		}
		return nil
	})
	if err != nil {
		t.Error(err)
	}
}
