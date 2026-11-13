"""S-05 item 2: writer throughput on the migrated `scf` database, as scf_writer (RLS on) through PgBouncer (pool scf_bulk).
One transaction per tenant per batch (C-23): ledger de-dup insert → stream-state lock + upsert → additive upserts into
api_metrics_1m/_1h/_1d → api_service_day_groups. Keys sorted. 80 % explicit15 / 20 % exp3 series.

usage: throughput.py setup [tenants] [series]
       throughput.py run <phase> <target|max> <seconds> <workers> [tenants] [series] [interval_s]
       throughput.py fk drop|restore
       throughput.py sizes
Writes /out05/throughput-<phase>.json."""
import hashlib, json, multiprocessing as mp, os, random, sys, time
import numpy as np
sys.path.insert(0, '/repo/spikes/s03-rls-real-postgres/tests')
from lib import connect

T0 = 'f0000000-0000-7000-8000-'


def tid(i):
    return f'{T0}{i:012x}'


def sid(i):
    return f'f1000000-0000-7000-8000-{i:012x}'


def setup(tenants, series):
    su = connect('postgres', via='direct')
    su.execute("DELETE FROM scf.tenants WHERE tenant_id::text LIKE 'f0000000-%'")
    su.execute("INSERT INTO scf.users (user_id, display_name) VALUES ('f2000000-0000-7000-8000-000000000000', 'load') ON CONFLICT DO NOTHING")
    routes = series // 2
    with su.transaction():
        for i in range(tenants):
            t, s = tid(i), sid(i)
            su.execute("INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES (%s, %s, %s, 'active', "
                       "'f2000000-0000-7000-8000-000000000000')", (t, f'load-{i:04d}', f'load {i}'))
            su.execute("INSERT INTO scf.api_services (tenant_id, service_id, service_name, created_by) VALUES "
                       "(%s, %s, 'svc', 'f2000000-0000-7000-8000-000000000000')", (t, s))
            su.execute("INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key) "
                       "VALUES (%s, %s, 'sdk_stable', 'http.server.request.duration', 'io.otel', '1|001|io.otel')", (t, s))
            su.execute("INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rules_version) "
                       "SELECT %s, %s, '/r/' || g, '/r', 'scf-path-rules/1.0.0' FROM generate_series(1, %s) g", (t, s, routes))
    su.execute('VACUUM ANALYZE')
    print(f'setup: {tenants} tenants, {routes} routes x 2 status codes = {series} series each')


def tenant_meta(conn, i):
    t, s = tid(i), sid(i)
    g = conn.execute('SELECT group_id FROM scf.api_stream_groups WHERE tenant_id = %s', (t,)).fetchone()[0]
    r = [x[0] for x in conn.execute('SELECT route_id FROM scf.api_routes WHERE tenant_id = %s ORDER BY route_id', (t,)).fetchall()]
    return t, s, g, r


UPS = """INSERT INTO scf.api_metrics_{g} AS t
  (tenant_id, service_id, route_id, method, status_code, source, stream_group_id, bucket_start,
   request_count, duration_sum, duration_min, duration_max, hist_kind, hist, hist_quality)
SELECT %(t)s, %(s)s, u.route, 1, u.status, 'sdk_metric', %(grp)s, {bucket}, u.cnt, u.sum, NULL, NULL,
       u.kind::scf.hist_kind, ARRAY(SELECT unnest((%(hists)s::bigint[][])[u.ord:u.ord][1:])), 0
  FROM unnest(%(route)s::bigint[], %(status)s::smallint[], %(cnt)s::bigint[], %(sum)s::float8[], %(kind)s::text[]) WITH ORDINALITY
       AS u(route, status, cnt, sum, kind, ord)
 ORDER BY u.route, u.status
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
# a 2-D array cannot carry rows of different length (15 vs 194), so explicit15 and exp3 rows go in two statements
BUCKET = {'1m': "date_trunc('minute', now())", '1h': "date_trunc('hour', now())", '1d': "date_trunc('day', now(), 'UTC')"}


def batch_sql():
    return {(kind, g): UPS.format(g=g, bucket=BUCKET[g]) for kind in ('explicit15', 'exp3') for g in ('1m', '1h', '1d')}


SQL = batch_sql()


def worker(wid, metas, series, mode, seconds, interval, q):
    rnd = random.Random(wid)
    via = os.environ.get('VIA', 'bouncer')
    conn = connect('scf_writer', db='scf_bulk' if via == 'bouncer' else 'scf', via=via, prepare_threshold=1)
    nser = series
    plan = []
    for t, s, g, routes in metas:
        ser = [(r, st) for r in routes for st in (200, 500)][:nser]
        kinds = ['exp3' if rnd.random() < 0.2 else 'explicit15' for _ in ser]
        plan.append((t, s, g, ser, kinds))
    lat, pts, txns, dup = [], 0, 0, 0
    start = time.time()
    next_due = [start + rnd.random() * interval for _ in plan] if mode == 'target' else [start] * len(plan)
    seq = 0
    while time.time() - start < seconds:
        k = min(range(len(plan)), key=lambda j: next_due[j])
        if mode == 'target':
            d = next_due[k] - time.time()
            if d > 0:
                time.sleep(d)
            next_due[k] += interval
        t, s, g, ser, kinds = plan[k]
        seq += 1
        key = hashlib.sha256(f'{t}|{wid}|{seq}|{time.time_ns()}'.encode()).digest()
        stream_keys = sorted(hashlib.sha256(f'{t}|{r}|{st}'.encode()).digest() for r, st in ser)
        t1 = time.perf_counter()
        with conn.transaction():
            conn.execute("SELECT set_config('app.tenant_id', %s, true), set_config('app.actor_kind', 'writer', true), "
                         "set_config('app.actor_id', 'writer', true)", (t,))
            if conn.execute('INSERT INTO scf.api_ingest_ledger (tenant_id, batch_key, points) VALUES (%s, %s, %s) '
                            'ON CONFLICT DO NOTHING RETURNING 1', (t, key, len(ser))).fetchone() is None:
                dup += 1
                continue
            conn.execute('SELECT stream_key FROM scf.api_stream_state WHERE tenant_id = %s AND stream_key = ANY(%s) '
                         'ORDER BY stream_key FOR UPDATE', (t, stream_keys)).fetchall()
            conn.execute("""INSERT INTO scf.api_stream_state AS x (tenant_id, stream_key, start_time_unix_ns, last_time_unix_ns,
                              last_count, last_sum, last_layout, last_buckets)
                            SELECT %s, k, 1, %s, %s, 1.0, '{"kind":"explicit"}', %s::bigint[] FROM unnest(%s::bytea[]) k ORDER BY k
                            ON CONFLICT (tenant_id, stream_key) DO UPDATE SET last_time_unix_ns = EXCLUDED.last_time_unix_ns,
                              last_count = x.last_count + 1, last_buckets = EXCLUDED.last_buckets, updated_at = now()""",
                         (t, time.time_ns(), seq, [1] * 15, stream_keys))
            for kind, width in (('explicit15', 15), ('exp3', 194)):
                rows = [(r, st) for (r, st), kd in zip(ser, kinds) if kd == kind]
                if not rows:
                    continue
                cnt = [rnd.randint(1, 20) for _ in rows]
                hists = []
                for c in cnt:
                    h = [0] * width
                    for _ in range(min(c, 5)):
                        h[rnd.randrange(3, width - 3)] += 1
                    h[width // 2] += c - sum(h)
                    hists.append(h)
                p = dict(t=t, s=s, grp=g, route=[r for r, _ in rows], status=[st for _, st in rows], cnt=cnt,
                         sum=[c * 0.05 for c in cnt], kind=[kind] * len(rows), hists=hists)
                for gg in ('1m', '1h', '1d'):
                    conn.execute(SQL[(kind, gg)], p)
            conn.execute('INSERT INTO scf.api_service_day_groups (tenant_id, service_id, day, stream_group_id) '
                         "VALUES (%s, %s, (now() AT TIME ZONE 'UTC')::date, %s) ON CONFLICT DO NOTHING", (t, s, g))
        lat.append(time.perf_counter() - t1)
        pts += len(ser)
        txns += 1
    q.put(dict(lat=lat, pts=pts, txns=txns, dup=dup, elapsed=time.time() - start))


def run(phase, mode, seconds, workers, tenants, series, interval):
    q = mp.Queue()
    su = connect('postgres', via='direct')        # metadata read once by the superuser (the writer caches it)
    metas = [tenant_meta(su, i) for i in range(tenants)]
    su.close()
    procs = [mp.Process(target=worker, args=(w, metas[w::workers], series, mode, seconds, interval, q)) for w in range(workers)]
    t0 = time.time()
    for p in procs:
        p.start()
    res = [q.get() for _ in procs]
    for p in procs:
        p.join()
    lat = np.array([x for r in res for x in r['lat']])
    el = max(r['elapsed'] for r in res)
    pts = sum(r['pts'] for r in res)
    txns = sum(r['txns'] for r in res)
    out = dict(phase=phase, mode=mode, seconds=round(el, 1), workers=workers, tenants=tenants, series_per_tenant=series,
               interval_s=interval, txns=txns, points=pts, txn_per_s=round(txns / el, 1), points_per_s=round(pts / el, 1),
               metric_row_upserts_per_s=round(3 * pts / el, 1),
               row_writes_per_s=round((4 * pts + 2 * txns) / el, 1),   # 1m+1h+1d+state per point; ledger+day-group per txn
               lat_ms=dict(p50=round(float(np.percentile(lat, 50)) * 1e3, 2), p95=round(float(np.percentile(lat, 95)) * 1e3, 2),
                           p99=round(float(np.percentile(lat, 99)) * 1e3, 2), max=round(float(lat.max()) * 1e3, 2)),
               duplicates=sum(r['dup'] for r in res), started_at=t0)
    json.dump(out, open(f'/out05/throughput-{phase}.json', 'w'), indent=1)
    print(json.dumps(out))


FKS = """SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint
          WHERE contype = 'f' AND conrelid IN ('scf.api_metrics_1m'::regclass, 'scf.api_metrics_1h'::regclass, 'scf.api_metrics_1d'::regclass)
            AND conparentid = 0"""


def fk(action):
    su = connect('postgres', via='direct')
    path = '/out05/fk-defs.json'
    if action == 'drop':
        defs = su.execute(FKS).fetchall()
        json.dump(defs, open(path, 'w'))
        for rel, name, _ in defs:
            su.execute(f'ALTER TABLE {rel} DROP CONSTRAINT {name}')
        print(f'dropped {len(defs)} FKs')
    else:
        for rel, name, d in json.load(open(path)):
            su.execute(f'ALTER TABLE {rel} ADD CONSTRAINT {name} {d}')
        print('restored FKs')


def sizes():
    su = connect('postgres', via='direct')
    rows = su.execute("""SELECT t, (SELECT count(*) FROM pg_inherits WHERE inhparent = t::regclass),
             (SELECT sum(pg_total_relation_size(inhrelid)) FROM pg_inherits WHERE inhparent = t::regclass),
             (SELECT sum(pg_relation_size(inhrelid)) FROM pg_inherits WHERE inhparent = t::regclass),
             (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM ' || t, false, true, '')))[1]::text::bigint
        FROM unnest(ARRAY['scf.api_metrics_1m','scf.api_metrics_1h','scf.api_metrics_1d','scf.api_stream_state','scf.api_ingest_ledger']) t""").fetchall()
    out = {}
    for t, nparts, total, heap, n in rows:
        if nparts == 0:
            total = su.execute('SELECT pg_total_relation_size(%s::regclass), pg_relation_size(%s::regclass)', (t, t)).fetchone()
            total, heap = total
        out[t] = dict(rows=n, total_bytes=int(total or 0), heap_bytes=int(heap or 0),
                      total_bytes_per_row=round((total or 0) / n, 1) if n else None)
    hk = su.execute("SELECT hist_kind, count(*), avg(pg_column_size(t.*))::int FROM scf.api_metrics_1h t GROUP BY 1").fetchall()
    out['avg_tuple_bytes_1h_by_kind'] = {k: dict(rows=c, bytes=b) for k, c, b in hk}
    json.dump(out, open('/out05/sizes.json', 'w'), indent=1, default=float)
    print(json.dumps(out, indent=1, default=float))


def readbench():
    """Read path over the loaded data: op_api_metrics (SCF operator, all tenants) and a tenant range query."""
    app = connect('scf_app', db='scf')
    out = {}
    for label, sql in (
            ('op_api_metrics_today_group_service',
             "SELECT count(*) FROM scf.op_api_metrics(date_trunc('day', now(), 'UTC'), date_trunc('day', now(), 'UTC') + interval '1 day', 'range', 'service', p_min_level => 0::smallint)"),
            ('op_api_metrics_today_group_all_hourly',
             "SELECT count(*) FROM scf.op_api_metrics(date_trunc('day', now(), 'UTC'), date_trunc('day', now(), 'UTC') + interval '1 day', 'hour', 'all', p_min_level => 0::smallint)")):
        ts = []
        for _ in range(3):
            t = time.perf_counter()
            with app.transaction():
                app.execute("SELECT set_config('app.actor_kind', 'operator', true), set_config('app.actor_id', '0e000000-0000-7000-8000-00000000000e', true),"
                            " set_config('app.platform_role', 'operator', true)")
                n = app.execute(sql).fetchone()[0]
            ts.append(round((time.perf_counter() - t) * 1e3, 1))
        out[label] = dict(rows=n, ms=ts)
    ts = []
    for _ in range(3):
        t = time.perf_counter()
        with app.transaction():
            app.execute("SELECT set_config('app.tenant_id', %s, true), set_config('app.actor_kind', 'user', true)", (tid(0),))
            n = app.execute("""SELECT route_id, scf.hist_quantile('explicit15', scf.hist_sum(scf.hist_to_explicit15(hist_kind, hist)), 0.95)
                                FROM scf.api_metrics_1m_pref WHERE tenant_id = %s AND bucket_start >= now() - interval '6 hours'
                               GROUP BY route_id""", (tid(0),)).fetchall()
        ts.append(round((time.perf_counter() - t) * 1e3, 1))
    out['tenant_p95_per_route_1m_last_6h'] = dict(rows=len(n), ms=ts)
    json.dump(out, open('/out05/readbench.json', 'w'), indent=1)
    print(json.dumps(out))


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == 'setup':
        setup(int(a[1]) if len(a) > 1 else 300, int(a[2]) if len(a) > 2 else 50)
    elif a[0] == 'run':
        run(a[1], a[2], float(a[3]), int(a[4]), int(a[5]) if len(a) > 5 else 300, int(a[6]) if len(a) > 6 else 50,
            float(a[7]) if len(a) > 7 else 10.0)
    elif a[0] == 'fk':
        fk(a[1])
    elif a[0] == 'readbench':
        readbench()
    elif a[0] == 'sizes':
        sizes()
