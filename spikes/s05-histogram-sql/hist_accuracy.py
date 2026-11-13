"""S-05 item 1: accuracy of the explicit15 and exp3 layouts of docs/data-model.md §9 on a real PostgreSQL 18, using the
document's own SQL (migration 0030, already applied) for merging and quantiles, and this file's Python implementation of
the writer-side bucketing (§9.1 idx(v), §9.2 k = i + 114, down-scaling i3 = i_s >> (s-3), scale<3 → explicit15).
Writes /out05/accuracy.json and prints a summary."""
import json, math, sys
import numpy as np
import psycopg
sys.path.insert(0, '/repo/spikes/s03-rls-real-postgres/tests')
from lib import connect
from seed import A, uid

rng = np.random.default_rng(20261112)
N = 200_000
B = np.array([0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10])
QS = (0.50, 0.95, 0.99)
EXP_BOUND = (2 ** (1 / 8) - 1) / (2 ** (1 / 8) + 1)   # 0.04329


# ---------- writer-side bucketing (Python implementation of §9.1 / §9.2)
def explicit15(v):
    return np.bincount(np.searchsorted(B, v, side='left'), minlength=15)[:15].astype(np.int64)   # idx-1 = |{b < v}|


def otlp_index(v, scale):
    """OTLP exponential bucket index: v in (base^i, base^(i+1)], base = 2^(2^-scale)."""
    return (np.ceil(np.log2(v) * 2.0 ** scale) - 1).astype(np.int64)


def exp3_from_index(i3, n_zero=0):
    k = np.clip(i3 + 114, 1, 194)
    h = np.bincount(k - 1, minlength=194).astype(np.int64)
    h[0] += n_zero
    return h


def exp3(v):
    return exp3_from_index(otlp_index(v, 3))


def sdk_scale(v, max_size=160, max_scale=20):
    """Scale an OTel SDK with MaxSize 160 settles on for this data (largest scale whose index span fits)."""
    for s in range(max_scale, -11, -1):
        i = otlp_index(np.array([v.min(), v.max()]), s)
        if i[1] - i[0] + 1 <= max_size:
            return s
    return -10


def lowscale_to_explicit15(v, s):
    """Scale < 3 (C-23): OTLP histogram at scale s, mapped to explicit15 by log-uniform split over EVERY bound a source
    bucket straddles (a general split; at scale <= 1 a bucket can straddle 2+ bounds). Returns (hist, max_bounds_straddled)."""
    idx = otlp_index(v, s)
    vals, cnt = np.unique(idx, return_counts=True)
    base = 2.0 ** (2.0 ** -s)
    out = np.zeros(15)
    worst = 0
    for i, n in zip(vals, cnt):
        lo, hi = base ** i, base ** (i + 1)
        edges = [lo] + [b for b in B if lo < b < hi] + [hi]
        worst = max(worst, len(edges) - 2)
        for a, b2 in zip(edges[:-1], edges[1:]):
            j = int(np.searchsorted(B, b2, side='left'))   # target bucket holding (a, b2]
            out[j] += n * math.log(b2 / a) / math.log(hi / lo)
    h = np.round(out).astype(np.int64)
    h[np.argmax(h)] += len(v) - h.sum()                       # keep the count exact after rounding
    return h, worst


# ---------- distributions (seconds)
def dists():
    yield 'lognormal_82ms', rng.lognormal(math.log(0.082), 0.8, N)
    m = rng.random(N) < 0.7
    yield 'bimodal_15ms_450ms', np.where(m, rng.lognormal(math.log(0.015), 0.3, N), rng.lognormal(math.log(0.45), 0.25, N))
    yield 'heavy_tail_pareto', 0.02 * (1 + rng.pareto(0.9, N))
    yield 'narrow_120ms', np.abs(rng.normal(0.120, 0.003, N))
    yield 'submillisecond', rng.lognormal(math.log(0.0003), 0.5, N)


def exact_q(v, q):
    return float(np.quantile(v, q, method='inverted_cdf'))


def bucket_width_explicit(x, vmax):
    j = int(np.searchsorted(B, x, side='left'))
    lo = 0.0 if j == 0 else B[j - 1]
    hi = B[j] if j < 14 else max(vmax, 10.0)
    return hi - lo


su = connect('postgres', via='direct')
app = connect('scf_app', db='scf')        # quantiles computed by the tenant role through PgBouncer
wr = connect('scf_writer', db='scf')


def sql_q(kind, h, q, vmin=None, vmax=None):
    return app.execute('SELECT scf.hist_quantile(%s::scf.hist_kind, %s::bigint[], %s, %s, %s)',
                       (kind, [int(x) for x in h], q, vmin, vmax)).fetchone()[0]


results = {'n_per_dist': N, 'exp3_bound': EXP_BOUND, 'dists': {}}
svc = uid(A, 3)
grp = su.execute('SELECT group_id FROM scf.api_stream_groups WHERE tenant_id = %s', (A,)).fetchone()[0]
day0 = su.execute("SELECT date_trunc('day', now(), 'UTC')").fetchone()[0]

UPSERT = """INSERT INTO scf.api_metrics_{g} AS t
  (tenant_id, service_id, route_id, method, status_code, source, stream_group_id, bucket_start,
   request_count, duration_sum, duration_min, duration_max, hist_kind, hist, hist_quality)
SELECT %(tenant)s, %(service)s, %(route)s, 1, 200, 'sdk_metric', %(group)s, {bucket},
       %(count)s, %(sum)s, %(min)s, %(max)s, %(kind)s::scf.hist_kind, %(hist)s::bigint[], %(quality)s
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
                           CASE WHEN t.hist_kind <> EXCLUDED.hist_kind THEN 1 ELSE 0 END)"""
BUCKET = {'1m': "%(ts)s::timestamptz", '1h': "date_trunc('hour', %(ts)s::timestamptz)",
          '1d': "date_trunc('day', %(ts)s::timestamptz, 'UTC')"}
RANGE_Q = """WITH r AS (
  SELECT route_id, sum(request_count) AS requests,
         bool_and(hist_kind = 'exp3') AS all_exp3, bool_and(hist_kind = 'explicit15') AS all_exp15,
         max(hist_quality)::smallint AS q,
         CASE WHEN bool_and(hist_kind = 'exp3') THEN scf.hist_sum(hist)
              ELSE scf.hist_sum(scf.hist_to_explicit15(hist_kind, hist)) END AS h,
         CASE WHEN bool_and(duration_min IS NOT NULL) THEN min(duration_min) END AS vmin,
         CASE WHEN bool_and(duration_max IS NOT NULL) THEN max(duration_max) END AS vmax
    FROM scf.api_metrics_{g}_pref
   WHERE tenant_id = %(tenant)s AND service_id = %(service)s AND route_id = %(route)s
     AND bucket_start >= %(from)s AND bucket_start < %(to)s
   GROUP BY route_id)
SELECT requests, scf.accuracy_class(all_exp3, all_exp15, q) AS accuracy_class, h,
       scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.50, vmin, vmax),
       scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.95, vmin, vmax),
       scf.hist_quantile(CASE WHEN all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, h, 0.99, vmin, vmax)
  FROM r"""


def new_route(name):
    return su.execute("""INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rules_version)
                         VALUES (%s, %s, %s, '/s05', 'scf-path-rules/1.0.0')
                         ON CONFLICT (tenant_id, service_id, route, rpc_method, rules_version) DO UPDATE SET last_seen_at = now()
                         RETURNING route_id""", (A, svc, name)).fetchone()[0]


def load(route, v, kind_of_chunk, minutes=600, with_minmax=True, quality=0):
    """Split samples into `minutes` 1m chunks spread over today and upsert each chunk into 1m/1h/1d as scf_writer."""
    su.execute('DELETE FROM scf.api_metrics_1m WHERE route_id = %s; DELETE FROM scf.api_metrics_1h WHERE route_id = %s;'
               'DELETE FROM scf.api_metrics_1d WHERE route_id = %s' % (route, route, route))
    chunks = np.array_split(v, minutes)
    with wr.transaction():
        wr.execute("SELECT set_config('app.tenant_id', %s, true), set_config('app.actor_kind', 'writer', true),"
                   " set_config('app.actor_id', 'writer', true)", (A,))
        with wr.cursor() as cur:
            for m, c in enumerate(chunks):
                kind = kind_of_chunk(m)
                h = explicit15(c) if kind == 'explicit15' else exp3(c)
                p = dict(tenant=A, service=svc, route=route, group=grp, ts=day0 + np.timedelta64(m * 2, 'm').item(),
                         count=len(c), sum=float(c.sum()), min=float(c.min()) if with_minmax else None,
                         max=float(c.max()) if with_minmax else None, kind=kind, hist=[int(x) for x in h], quality=quality)
                for g in ('1m', '1h', '1d'):
                    cur.execute(UPSERT.format(g=g, bucket=BUCKET[g]), p)


def range_quantiles(route):
    out = {}
    with app.transaction():
        app.execute("SELECT set_config('app.tenant_id', %s, true), set_config('app.actor_kind', 'user', true)", (A,))
        for g in ('1m', '1h', '1d'):
            r = app.execute(RANGE_Q.format(g=g), dict(tenant=A, service=svc, route=route, **{
                'from': day0, 'to': day0 + np.timedelta64(1, 'D').item()})).fetchone()
            out[g] = dict(requests=r[0], accuracy_class=r[1], hist=r[2], p=[r[3], r[4], r[5]])
    return out


all_ok = True
for name, v in dists():
    d = {'min': float(v.min()), 'max': float(v.max()), 'exact': [exact_q(v, q) for q in QS]}
    vmin, vmax = d['min'], d['max']
    he, hx = explicit15(v), exp3(v)
    d['sdk_scale_maxsize160'] = sdk_scale(v)
    d['exp3_underflow_overflow'] = [int(hx[0]), int(hx[-1])]
    for kind, h in (('explicit15', he), ('exp3', hx)):
        for mm in ('with_minmax', 'no_minmax'):
            est = [sql_q(kind, h, q, vmin if mm == 'with_minmax' else None, vmax if mm == 'with_minmax' else None) for q in QS]
            rel = [(e - x) / x for e, x in zip(est, d['exact'])]
            if kind == 'exp3':
                inrange = [2 ** -14 < x <= 1024 for x in d['exact']]
                ok = all(abs(r) <= EXP_BOUND + 1e-12 for r, ir in zip(rel, inrange) if ir)
                bound = f'|rel| <= {EXP_BOUND:.4%} (in range)'
            else:
                widths = [bucket_width_explicit(x, vmax if mm == 'with_minmax' else 10.0) for x in d['exact']]
                ok = all(abs(e - x) <= w + 1e-12 for e, x, w in zip(est, d['exact'], widths))
                bound = '|abs err| <= width of the exact value\'s bucket'
            d[f'{kind}_{mm}'] = dict(est=est, rel_err=rel, within_bound=ok, bound=bound)
            all_ok &= ok or (mm == 'no_minmax')
    # exp3 → explicit15 conversion in SQL vs direct explicit bucketing
    conv = app.execute('SELECT scf.hist_exp3_to_explicit15(%s::bigint[])', ([int(x) for x in hx],)).fetchone()[0]
    d['exp3_to_explicit15'] = dict(l1_moved_fraction=float(np.abs(np.array(conv) - he).sum() / 2 / N),
                                   count_preserved=int(sum(conv)) == N,
                                   est=[sql_q('explicit15', conv, q, vmin, vmax) for q in QS])
    d['exp3_to_explicit15']['rel_err'] = [(e - x) / x for e, x in zip(d['exp3_to_explicit15']['est'], d['exact'])]
    # down-scaling from tenant scales > 3 is exact (perfect subsetting)
    i3 = otlp_index(v, 3)
    d['downscale_mismatches'] = {s: int((otlp_index(v, s) >> (s - 3) != i3).sum()) for s in (4, 5, 6, 8, 12, 20)}
    # scale < 3 → explicit15 'coarse'
    d['coarse'] = {}
    for s in (2, 1, 0):
        h2, worst = lowscale_to_explicit15(v, s)
        est = [sql_q('explicit15', h2, q, vmin, vmax) for q in QS]
        d['coarse'][s] = dict(rel_err=[(e - x) / x for e, x in zip(est, d['exact'])], max_bounds_straddled=worst,
                              l1_moved_fraction=float(np.abs(h2 - he).sum() / 2 / N))
    # merge across rows and 1m → 1h → 1d (writer upsert path, then the tenant range query of §9.3 per table)
    for kind in ('explicit15', 'exp3'):
        route = new_route(f'/s05/{name}/{kind}')
        load(route, v, lambda m, k=kind: k)
        rq = range_quantiles(route)
        direct = he if kind == 'explicit15' else hx
        same_hist = all(list(rq[g]['hist']) == [int(x) for x in direct] for g in rq)
        same_q = rq['1m']['p'] == rq['1h']['p'] == rq['1d']['p']
        d[f'merge_{kind}'] = dict(rows_1m=600, hist_equal_to_unsplit=same_hist, quantiles_equal_across_1m_1h_1d=same_q,
                                  requests=[rq[g]['requests'] for g in rq], accuracy_class=rq['1d']['accuracy_class'],
                                  p_1d=rq['1d']['p'])
        all_ok &= same_hist and same_q
    # mixed kinds in one key collapse to explicit15 with quality 1 (explicit15_approx)
    route = new_route(f'/s05/{name}/mixed')
    load(route, v, lambda m: 'exp3' if m % 2 == 0 else 'explicit15')
    rq = range_quantiles(route)
    d['mixed'] = dict(accuracy_class={g: rq[g]['accuracy_class'] for g in rq}, p_1d=rq['1d']['p'],
                      rel_err_1d=[(e - x) / x for e, x in zip(rq['1d']['p'], d['exact'])],
                      requests=[rq[g]['requests'] for g in rq])
    results['dists'][name] = d
    print(f'--- {name}: n={N} min={vmin:.6g}s max={vmax:.6g}s SDK scale(MaxSize 160)={d["sdk_scale_maxsize160"]} '
          f'exp3 under/overflow={d["exp3_underflow_overflow"]}')
    print('    exact p50/p95/p99 = ' + ' / '.join(f'{x * 1000:.3f}ms' for x in d['exact']))
    for key in ('explicit15_with_minmax', 'explicit15_no_minmax', 'exp3_with_minmax', 'exp3_no_minmax'):
        e = d[key]
        print(f'    {key:24s} rel err ' + ' / '.join(f'{r:+.2%}' for r in e['rel_err']) + f'   within bound: {e["within_bound"]}')
    c = d['exp3_to_explicit15']
    print(f'    exp3→explicit15 (SQL)    rel err ' + ' / '.join(f'{r:+.2%}' for r in c['rel_err'])
          + f'   moved {c["l1_moved_fraction"]:.3%} of counts, count preserved {c["count_preserved"]}')
    for s, c in d['coarse'].items():
        print(f'    coarse scale {s}           rel err ' + ' / '.join(f'{r:+.2%}' for r in c['rel_err'])
              + f'   bounds straddled by one source bucket ≤ {c["max_bounds_straddled"]}')
    print(f'    downscale mismatches vs direct scale 3: {d["downscale_mismatches"]}')
    for kind in ('explicit15', 'exp3'):
        mg = d[f'merge_{kind}']
        print(f'    merge {kind}: 600 rows → 1m/1h/1d hist == unsplit: {mg["hist_equal_to_unsplit"]}; quantiles equal across '
              f'1m/1h/1d: {mg["quantiles_equal_across_1m_1h_1d"]}; requests {mg["requests"]}; class {mg["accuracy_class"]}')
    print(f'    mixed exp3/explicit15 in one key: class {d["mixed"]["accuracy_class"]}, rel err 1d '
          + ' / '.join(f'{r:+.2%}' for r in d['mixed']['rel_err_1d']))

# explicit15 bound ratios: claim "adjacent bounds differ by >= 4/3" (so one exp3 bucket straddles at most one bound)
results['explicit15_min_adjacent_ratio'] = float(min(B[1:] / B[:-1]))
results['all_checks_ok'] = bool(all_ok)
json.dump(results, open('/out05/accuracy.json', 'w'), indent=1, default=float)
print(f'explicit15 min adjacent bound ratio = {results["explicit15_min_adjacent_ratio"]:.4f}; exp3 base = {2 ** 0.125:.4f}')
print('ALL CHECKS OK' if all_ok else 'SOME CHECKS FAILED')
