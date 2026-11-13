"""S-05 item 2b: cost of creating a new day's partition with RLS (scf.ensure_partitions(), §10) and of the retention
DETACH+DROP (scf.drop_expired_partitions()), called by scf_jobs through PgBouncer as job 'partitions'.
usage: partition_bench.py <label> [repeats]   → /out05/partitions-<label>.json"""
import json, sys, time
sys.path.insert(0, '/repo/spikes/s03-rls-real-postgres/tests')
from lib import connect

label = sys.argv[1]
reps = int(sys.argv[2]) if len(sys.argv) > 2 else 5
su = connect('postgres', via='direct')
jobs = connect('scf_jobs', db='scf')


def as_job(sql):
    t = time.perf_counter()
    with jobs.transaction():
        jobs.execute("SELECT set_config('app.job', 'partitions', true), set_config('app.actor_kind', 'job', true)")
        r = jobs.execute(sql).fetchone()[0]
    return r, (time.perf_counter() - t) * 1e3


create, drop, npol = [], [], None
for i in range(reps):
    # remove the farthest-ahead daily partition so ensure_partitions() has exactly one new day to create
    last = su.execute("""SELECT c.relname FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid
                          WHERE h.inhparent = 'scf.api_metrics_1m'::regclass ORDER BY c.relname DESC LIMIT 1""").fetchone()[0]
    su.execute(f'DROP TABLE scf_part.{last}')
    made, ms = as_job('SELECT scf.ensure_partitions()')
    create.append(ms)
    npol = su.execute(f"""SELECT relrowsecurity, relforcerowsecurity, (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid),
                                (SELECT count(*) FROM pg_policy WHERE polrelid = 'scf.api_metrics_1m'::regclass)
                           FROM pg_class c WHERE relname = '{last}'""").fetchone()
    assert made == 1, made
    # an expired day (40 days old) to detach + drop
    old = su.execute("SELECT to_char(now() AT TIME ZONE 'UTC' - interval '40 days', 'YYYYMMDD')").fetchone()[0]
    su.execute(f"""CREATE TABLE scf_part.api_metrics_1m_{old} PARTITION OF scf.api_metrics_1m
                   FOR VALUES FROM ('{old[:4]}-{old[4:6]}-{old[6:]} 00:00+00') TO ('{old[:4]}-{old[4:6]}-{old[6:]} 00:00+00'::timestamptz + interval '1 day')""")
    dropped, ms = as_job('SELECT scf.drop_expired_partitions()')
    drop.append(ms)
out = dict(label=label, reps=reps, ensure_partitions_new_day_ms=[round(x, 1) for x in create],
           drop_expired_partitions_ms=[round(x, 1) for x in drop],
           new_partition_rls_force_policies_vs_parent=list(npol))
json.dump(out, open(f'/out05/partitions-{label}.json', 'w'), indent=1)
print(json.dumps(out))
