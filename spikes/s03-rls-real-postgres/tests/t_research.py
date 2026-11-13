"""Re-run tests T0–T21 (+ COPY, + PgBouncer extras) of the RLS research test table on a
real PostgreSQL 18 server, app_role connections going through PgBouncer (transaction mode, pool_size=1 for rlslab).
"ok" in the result file means: same behaviour as the research (PGlite) result."""
import io
from lib import connect, try_sql, Recorder

A = 'aaaaaaaa-0000-0000-0000-000000000001'
B = 'bbbbbbbb-0000-0000-0000-000000000002'
R = Recorder('/out/t-research.json')

su0 = connect('postgres', db='postgres', via='direct')
su0.execute('DROP DATABASE IF EXISTS rlslab WITH (FORCE)')
su0.execute('CREATE DATABASE rlslab')
su = connect('postgres', db='rlslab', via='direct')
su.execute(open('/repo/spikes/s03-rls-real-postgres/sql/rlslab.sql').read())


def q(conn, sql, params=None):
    return try_sql(conn, sql, params)


def owner():
    c = connect('postgres', db='rlslab', via='direct')
    c.execute('SET ROLE owner_role')
    return c


# ---- T3 first: a fresh pooled server connection that never saw the GUC
app1 = connect('app_role', db='rlslab')
st, rows = q(app1, 'SELECT count(*) FROM m.web_daily')
R.add('T3', 'app_role via PgBouncer, GUC never set', '0 rows', f'{st} {rows}', st == 'ok' and rows[0][0] == 0)

# ---- T0 owner insert (FORCE on, policies only TO app_role)
o = owner()
st, msg = q(o, f"INSERT INTO m.web_daily VALUES ('{A}', '2026-04-01', 'x', 1)")
R.add('T0', 'owner inserts with FORCE + role-scoped policies', 'ERROR new row violates row-level security policy',
      f'{st} {msg}', st == 'error' and 'row-level security' in msg)

# ---- T1 catalog flags
st, rows = q(su, """SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                    (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)
                    FROM pg_class c WHERE c.relname IN ('web_daily','web_daily_2025','web_daily_2026') ORDER BY 1""")
flags = {r[0]: r[1:] for r in rows}
R.add('T1', 'partitions inherit RLS flags/policies?', 'parent t/t/2; both partitions f/f/0', str(flags),
      flags['web_daily'] == (True, True, 2) and flags['web_daily_2025'] == (False, False, 0)
      and flags['web_daily_2026'] == (False, False, 0))

# ---- T2 owner reads parent / partition directly
s1, r1 = q(o, 'SELECT count(*) FROM m.web_daily')
s2, r2 = q(o, 'SELECT count(*) FROM m.web_daily_2026')
R.add('T2', 'owner reads parent vs partition directly', 'parent 0, partition 2', f'parent {r1}, partition {r2}',
      r1[0][0] == 0 and r2[0][0] == 2)

# ---- T4 SET LOCAL via PgBouncer
app = connect('app_role', db='rlslab')
with app.transaction():
    app.execute(f"SET LOCAL app.tenant_id = '{A}'")
    n = app.execute('SELECT tenant_id::text FROM m.web_daily').fetchall()
after = app.execute("SELECT current_setting('app.tenant_id', true)").fetchone()[0]
R.add('T4', 'BEGIN; SET LOCAL app.tenant_id=a; SELECT; COMMIT (via PgBouncer)', "only a's row; after COMMIT ''",
      f'rows={n}; after={after!r}', n == [(A,)] and after == '')

# ---- T5 session SET leaks to ANOTHER client through the pool (pool_size=1)
c1 = connect('app_role', db='rlslab')
c1.execute(f"SET app.tenant_id = '{B}'")          # session-level SET, autocommit
c1.close()
c2 = connect('app_role', db='rlslab')             # a different client
v = c2.execute("SELECT current_setting('app.tenant_id', true)").fetchone()[0]
rows = c2.execute('SELECT count(*) FROM m.web_daily').fetchone()[0]
pid = c2.execute('SELECT pg_backend_pid()').fetchone()[0]
R.add('T5', "session SET by client 1, then client 2's new transaction (PgBouncer transaction mode)",
      "research (one session): still 'b' in the next txn", f'client 2 sees GUC={v!r}, rows visible={rows} (backend {pid})',
      v == B and rows == 2, 'real server + PgBouncer: the leak crosses clients, not only transactions')

# ---- T5b after RESET, '' → cast error with the research predicate
c2.execute('RESET app.tenant_id')
v = c2.execute("SELECT current_setting('app.tenant_id', true)").fetchone()[0]
st, msg = q(c2, 'SELECT count(*) FROM m.web_daily')
R.add('T5b', "after RESET the GUC is '' and ''::uuid errors", "GUC '' ; ERROR invalid input syntax for type uuid",
      f'GUC={v!r}; {st} {msg}', v == '' and st == 'error' and 'invalid input syntax for type uuid' in msg)

# ---- T20 NULLIF form → 0 rows, no error
# same table shape, policy written with NULLIF (the form docs/data-model.md uses)
su.execute("""CREATE TABLE IF NOT EXISTS m.t20 (tenant_id uuid);
              ALTER TABLE m.t20 ENABLE ROW LEVEL SECURITY; ALTER TABLE m.t20 FORCE ROW LEVEL SECURITY;
              DROP POLICY IF EXISTS p ON m.t20;
              CREATE POLICY p ON m.t20 TO app_role USING (tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid));
              GRANT SELECT ON m.t20 TO app_role; TRUNCATE m.t20;""")
su.execute(f"INSERT INTO m.t20 VALUES ('{A}'), ('{B}')")
st, rows = q(c2, 'SELECT count(*) FROM m.t20')
R.add('T20', "NULLIF(current_setting(...),'')::uuid policy with GUC = ''", '0 rows, no error', f'{st} {rows}',
      st == 'ok' and rows[0][0] == 0)

# ---- T6 app_role reads a partition directly (no grant)
st, msg = q(c2, 'SELECT count(*) FROM m.web_daily_2026')
R.add('T6', 'app_role selects partition directly, no grant', 'permission denied', f'{st} {msg}',
      st == 'error' and 'permission denied' in msg)

# ---- T7 WITH CHECK
with c2.transaction():
    c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
    st, msg = q(c2, f"INSERT INTO m.web_daily VALUES ('{B}', '2026-05-01', 'evil', 1)")
R.add('T7', 'tenant a inserts a row for b', 'RLS violation error', f'{st} {msg}', st == 'error' and 'row-level security' in msg)

# ---- T8 unique-constraint probing
c2.execute('BEGIN')
c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
vis = c2.execute('SELECT count(*) FROM m.sites').fetchone()[0]
st, msg = q(c2, f"INSERT INTO m.sites VALUES ('{A}', 'b.example')")
R.add('T8', "tenant a inserts b's hostname into a global UNIQUE column", '0 rows visible, duplicate key error',
      f'visible={vis}; {st} {msg}', vis == 0 and st == 'error' and 'duplicate key' in msg)

# ---- T10 views with FORCE
with c2.transaction():
    c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
    d = c2.execute('SELECT count(*) FROM m.v_default').fetchone()[0]
    i = c2.execute('SELECT count(*) FROM m.v_invoker').fetchone()[0]
R.add('T10', 'default view vs security_invoker view, table FORCEd', 'default 0, invoker 1', f'default {d}, invoker {i}',
      d == 0 and i == 1)
su.execute('ALTER TABLE m.web_daily NO FORCE ROW LEVEL SECURITY')
with c2.transaction():
    c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
    d = c2.execute('SELECT count(*) FROM m.v_default').fetchone()[0]
    i = c2.execute('SELECT count(*) FROM m.v_invoker').fetchone()[0]
su.execute('ALTER TABLE m.web_daily FORCE ROW LEVEL SECURITY')
R.add('T10b', 'same with NO FORCE', 'default 3 (leak), invoker 1', f'default {d}, invoker {i}', d == 3 and i == 1)

# ---- T11 matview
s1, m1 = q(su, 'ALTER TABLE m.mv ENABLE ROW LEVEL SECURITY')
s2, m2 = q(su, 'CREATE POLICY p ON m.mv USING (true)')
R.add('T11', 'RLS on a materialized view', 'cannot be performed / is not a table', f'{m1} | {m2}',
      s1 == 'error' and s2 == 'error')

# ---- T12 BYPASSRLS
ops = connect('ops_role', db='rlslab')
n = ops.execute('SELECT count(*) FROM m.web_daily').fetchone()[0]
R.add('T12', 'BYPASSRLS role (via PgBouncer)', 'sees all 3', str(n), n == 3)

# ---- T13 row_security=off
with c2.transaction():
    c2.execute("SET LOCAL row_security = off")
    c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
    st, msg = q(c2, 'SELECT count(*) FROM m.web_daily')
R.add('T13', 'SET row_security=off as app_role', 'ERROR query would be affected by row-level security policy',
      f'{st} {msg}', st == 'error' and 'would be affected by row-level security' in msg)

# ---- T14 EXPLAIN: InitPlan + index cond + pruning
with c2.transaction():
    c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
    c2.execute('SET LOCAL enable_seqscan = off')
    plan = '\n'.join(r[0] for r in c2.execute(
        "EXPLAIN SELECT * FROM m.web_daily WHERE day >= '2026-02-01'").fetchall())
ok = 'InitPlan' in plan and 'Index Cond' in plan and 'web_daily_2025' not in plan
R.add('T14', 'EXPLAIN with (SELECT current_setting(...)) predicate', 'InitPlan once; Index Cond tenant_id; pruned to 2026',
      plan.replace('\n', ' / '), ok)

# ---- T15 leakproof
rows = su.execute("""SELECT o.oprname || '(' || format_type(o.oprleft, NULL) || ')', p.proleakproof
  FROM pg_operator o JOIN pg_proc p ON p.oid = o.oprcode
  WHERE o.oprname IN ('=', '<', '>=') AND o.oprleft = o.oprright
    AND format_type(o.oprleft, NULL) IN ('uuid','text','date','bigint','timestamp with time zone') ORDER BY 1""").fetchall()
others = su.execute("""SELECT proname, proleakproof FROM pg_proc WHERE proname IN ('textlike','lower','current_setting')
                       AND pronamespace = 'pg_catalog'::regnamespace ORDER BY 1""").fetchall()
R.add('T15', 'proleakproof of =,<,>= on uuid/text/date/int8/timestamptz; textlike/lower/current_setting',
      'operators all true; the three functions false', f'{rows} {others}',
      all(r[1] for r in rows) and not any(r[1] for r in others))

# ---- T16 CI gate query (research §6.4 form, schema m)
rows = su.execute("""SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'm' AND c.relkind IN ('r','p','m','f')
    AND (NOT (c.relrowsecurity AND c.relforcerowsecurity) OR c.relkind = 'm'
         OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_backstop' AND NOT p.polpermissive))
  ORDER BY 1""").fetchall()
names = [r[0] for r in rows]
R.add('T16', 'research CI gate query lists unprotected objects', 'mv, web_daily_2025, web_daily_2026 (+ sites, t20 here)',
      str(names), {'mv', 'web_daily_2025', 'web_daily_2026'} <= set(names))

# ---- T17 SECURITY DEFINER owned by the forced owner
with c2.transaction():
    c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
    n = c2.execute('SELECT m.count_all()').fetchone()[0]
R.add('T17', 'SECURITY DEFINER fn owned by the FORCEd owner counts all rows', '0', str(n), n == 0)

# ---- T19 GRANT on a partition = leak (before T18 detaches it)
su.execute('GRANT SELECT ON m.web_daily_2026 TO app_role')
with c2.transaction():
    c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
    p = c2.execute('SELECT count(*) FROM m.web_daily_2026').fetchone()[0]
    par = c2.execute('SELECT count(*) FROM m.web_daily').fetchone()[0]
su.execute('REVOKE SELECT ON m.web_daily_2026 FROM app_role')
R.add('T19', 'GRANT SELECT on a partition to app_role', 'direct partition 2 (both tenants), parent 1',
      f'partition {p}, parent {par}', p == 2 and par == 1)

# ---- T18 DETACH
su.execute('ALTER TABLE m.web_daily DETACH PARTITION m.web_daily_2025')
f = su.execute("SELECT relrowsecurity, relforcerowsecurity, relispartition FROM pg_class WHERE relname='web_daily_2025'").fetchone()
R.add('T18', 'DETACH PARTITION', 'detached table keeps f/f, standalone without RLS', str(f), f == (False, False, False))

# ---- T21 app sets the GUC to b
with c2.transaction():
    c2.execute(f"SELECT set_config('app.tenant_id', '{B}', true)")
    n = c2.execute('SELECT count(*) FROM m.web_daily').fetchone()[0]
R.add('T21', 'app_role sets GUC to tenant b', "sees b's row(s)", str(n), n == 1, '2025 partition detached by T18, so 1')

# ---- T9 TRUNCATE (destructive: last)
su.execute('GRANT TRUNCATE ON m.web_daily TO app_role')
with c2.transaction():
    c2.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
    st, msg = q(c2, 'TRUNCATE m.web_daily')
left = su.execute(f"SELECT count(*) FROM m.web_daily WHERE tenant_id = '{B}'").fetchone()[0]
R.add('T9', 'app_role granted TRUNCATE on an RLS table', "wipes tenant b's rows", f'{st}; b rows left={left}',
      st == 'ok' and left == 0)

# ---- COPY FROM
su.execute(f"INSERT INTO m.web_daily VALUES ('{A}', '2026-03-01', 'a.example', 10)")
res = {}
for who, conn in (('app_role', c2), ('owner (FORCEd)', owner()), ('ops_role BYPASSRLS', ops)):
    if who != 'owner (FORCEd)':
        su.execute(f'GRANT INSERT ON m.web_daily TO {who.split()[0]}')
    try:
        with conn.transaction():
            conn.execute(f"SELECT set_config('app.tenant_id', '{A}', true)")
            with conn.cursor().copy('COPY m.web_daily FROM STDIN') as cp:
                cp.write_row((A, '2026-07-01', 'copy', 1))
            raise RuntimeError('rollback')
    except RuntimeError:
        res[who] = 'OK'
    except Exception as e:  # noqa
        res[who] = str(e).splitlines()[0]
R.add('COPY', 'COPY FROM as RLS-subject role / FORCEd owner / BYPASSRLS', 'not supported / not supported / OK', str(res),
      'not supported' in res['app_role'] and 'not supported' in res['owner (FORCEd)'] and res['ops_role BYPASSRLS'] == 'OK')

# ---- Extra PgBouncer checks (not in the research table; T22 does not exist there)
# X1: a set_config(...,true) in a transaction that errors and rolls back leaves nothing for the next client
x = connect('app_role', db='rlslab')
x.execute('RESET app.tenant_id')
try:
    with x.transaction():
        x.execute(f"SELECT set_config('app.tenant_id', '{B}', true)")
        x.execute('SELECT 1/0')
except Exception:
    pass
x.close()
y = connect('app_role', db='rlslab')
v = y.execute("SELECT current_setting('app.tenant_id', true)").fetchone()[0]
R.add('X1', 'set_config(..., true) in a failed transaction, next client on the same server connection', "GUC ''",
      repr(v), v == '')

su.execute(f"INSERT INTO m.web_daily VALUES ('{B}', '2026-03-01', 'b.example', 20)")
# X2: protocol-level prepared statement reused by two clients with different tenants (generic plan must not bake it)
y.execute('SET plan_cache_mode = force_generic_plan')   # session-level, deliberately (same server conn, pool_size=1)
seen = []
for t in (A, B, A, B, A, B):
    cc = connect('app_role', db='rlslab', prepare_threshold=0)
    with cc.transaction():
        cc.execute("SELECT set_config('app.tenant_id', %s, true)", (t,))
        seen.append(cc.execute('SELECT count(*), min(tenant_id::text) FROM m.web_daily WHERE day >= %s',
                               ('2020-01-01',), prepare=True).fetchone())
    cc.close()
y.execute('RESET plan_cache_mode')
ok = all((r[1] == t) for r, t in zip(seen, (A, B, A, B, A, B)))
R.add('X2', 'prepared (forced generic) plan reused across pooled clients with different tenants',
      'each execution sees only its own tenant', str(seen), ok)
R.save()

# cleanup: the lab roles are cluster-wide (ops_role has BYPASSRLS and would trip gate G6 of the scf database)
for c in (app, app1, c2, y, ops, o):
    try:
        c.close()
    except Exception:
        pass
su.close()
su0.execute('DROP DATABASE rlslab WITH (FORCE)')
su0.execute('DROP ROLE app_role, owner_role, ops_role')
