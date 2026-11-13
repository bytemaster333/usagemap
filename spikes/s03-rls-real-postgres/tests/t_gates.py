"""S-03 item 3: run the CI gate queries G1–G10 exactly as written in docs/data-model.md §15 (parsed from the file),
then for each gate apply one deliberate breakage inside a transaction (rolled back) and check the gate catches it."""
import re
import psycopg
from lib import connect, Recorder, err_text

R = Recorder('/out/t-gates.json')
doc = open('/repo/docs/data-model.md', encoding='utf-8').read()
block = re.search(r'```sql\n(-- illustrative CI gate queries.*?)```', doc, re.S).group(1)
gates = {}
for part in re.split(r'\n(?=-- G\d+)', block)[1:]:
    gid = re.match(r'-- (G\d+)', part).group(1)
    sql = '\n'.join(l for l in part.splitlines() if not l.lstrip().startswith('--')).strip().rstrip(';')
    gates[gid] = sql
assert sorted(gates, key=lambda g: int(g[1:])) == [f'G{i}' for i in range(1, 11)], gates.keys()

# G8 runtime half (the document gives it in prose only): session-level SET of app.* in pg_stat_statements
G8B = r"""SELECT query FROM pg_stat_statements WHERE query ~* '^\s*set\s+(session\s+)?app\.' OR query ~* 'set_config\(\s*''app\.[^'']*''\s*,[^,]*,\s*false'"""


def run_gate(conn, gid, sql=None):
    return conn.execute(sql or gates[gid]).fetchall()


mig = connect('scf_migrator', via='direct')
for gid in sorted(gates, key=lambda g: int(g[1:])):
    rows = run_gate(mig, gid)
    R.add(f'{gid}.clean', f'gate {gid} on the freshly migrated + seeded database', '0 rows', str(rows)[:300], not rows)

SU = connect('postgres', via='direct', autocommit=False)
DAY = "('2031-01-01 00:00+00') TO ('2031-01-02 00:00+00')"
BREAKS = {
    'G1': ('partition created without RLS/FORCE (plain PARTITION OF, not ensure_partitions)',
           f"CREATE TABLE scf_part.api_metrics_1m_20310101 PARTITION OF scf.api_metrics_1m FOR VALUES FROM {DAY}"),
    'G2': ('new tenant table with ENABLE+FORCE but no tenant_backstop',
           "CREATE TABLE scf.g2_bad (tenant_id uuid PRIMARY KEY); ALTER TABLE scf.g2_bad ENABLE ROW LEVEL SECURITY;"
           " ALTER TABLE scf.g2_bad FORCE ROW LEVEL SECURITY"),
    'G3': ('GRANT SELECT on an existing partition to scf_app',
           "DO $$ DECLARE p regclass; BEGIN SELECT inhrelid::regclass INTO p FROM pg_inherits WHERE inhparent = 'scf.api_metrics_1h'::regclass LIMIT 1;"
           " EXECUTE format('GRANT SELECT ON %s TO scf_app', p); END $$"),
    'G4': ('view without security_invoker',
           "CREATE VIEW scf.g4_bad AS SELECT tenant_id, site_id FROM scf.sites; GRANT SELECT ON scf.g4_bad TO scf_app"),
    'G5': ('SECURITY DEFINER function without search_path, EXECUTE left to PUBLIC (created by the superuser)',
           "CREATE FUNCTION scf.g5_bad() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1::bigint $$"),
    'G6': ('extra LOGIN role with BYPASSRLS', "CREATE ROLE g6_bad LOGIN BYPASSRLS"),
    'G7': ('a partition loses one parent policy (DROP POLICY app_select on one partition)',
           "DO $$ DECLARE p regclass; BEGIN SELECT inhrelid::regclass INTO p FROM pg_inherits WHERE inhparent = 'scf.api_metrics_1d'::regclass LIMIT 1;"
           " EXECUTE format('DROP POLICY app_select ON %s', p); END $$"),
    'G8': ('LOGIN role made member of scf_definer', "GRANT scf_definer TO scf_app"),
    'G9': ('tenant table whose PK does not start with tenant_id',
           "CREATE TABLE scf.g9_bad (id bigint, tenant_id uuid NOT NULL, PRIMARY KEY (id, tenant_id))"),
    'G10': ('tenant table with a single-column FK to sites(site_id) (sites has UNIQUE (site_id))',
            "CREATE TABLE scf.g10_bad (tenant_id uuid NOT NULL, site_id uuid REFERENCES scf.sites (site_id), PRIMARY KEY (tenant_id))"),
}
for gid, (what, ddl) in BREAKS.items():
    try:
        SU.execute(ddl)
        rows = run_gate(SU, gid)
    except psycopg.Error as e:
        rows = f'ERROR {err_text(e)}'
    SU.rollback()
    R.add(f'{gid}.break', f'{gid} catches: {what}', '>= 1 row naming the broken object', str(rows)[:300],
          isinstance(rows, list) and len(rows) > 0)

# Gaps: breakages the gates as written do NOT catch (expected to be missed → recorded as findings, ok = gate missed)
GAPS = [
    ('G5', 'unlisted SECURITY DEFINER function WITH search_path and no PUBLIC EXECUTE, granted to scf_app (G5 has no allow-list comparison)',
     "CREATE FUNCTION scf.g5_sneaky() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp"
     " AS $$ SELECT count(*) FROM scf.sites $$; REVOKE ALL ON FUNCTION scf.g5_sneaky() FROM PUBLIC;"
     " GRANT EXECUTE ON FUNCTION scf.g5_sneaky() TO scf_app"),
    ('G1', 'partition attached from a table in schema public (outside scf/scf_part) without RLS',
     f"CREATE TABLE public.g1_outside (LIKE scf.api_metrics_1m INCLUDING CONSTRAINTS); ALTER TABLE scf.api_metrics_1m ATTACH PARTITION public.g1_outside FOR VALUES FROM {DAY}"),
    ('G4', 'security_invoker view created in schema scf_admin/public (G4 checks schema scf only) — owner-semantics view elsewhere',
     "CREATE VIEW public.g4_outside AS SELECT tenant_id FROM scf.sites; GRANT USAGE ON SCHEMA public TO scf_app; GRANT SELECT ON public.g4_outside TO scf_app"),
]
for gid, what, ddl in GAPS:
    try:
        SU.execute(ddl)
        rows = run_gate(SU, gid)
        others = {g: run_gate(SU, g) for g in gates if g != gid}
        others = {g: r for g, r in others.items() if r}
    except psycopg.Error as e:
        rows, others = f'ERROR {err_text(e)}', {}
    SU.rollback()
    R.add(f'{gid}.gap', f'{gid} as written misses: {what}', 'documented gap (0 rows)',
          f'{gid} rows={rows}; other gates catching it: {others or "none"}'[:400],
          rows == [], 'ok = the gap is real; see README for the stricter query')

# G8 runtime half via pg_stat_statements
su = connect('postgres', via='direct')
su.execute('SELECT pg_stat_statements_reset()')
app = connect('scf_app', db='scf')
app.execute("SET app.tenant_id = 'aaaaaaaa-0000-7000-8000-000000000001'")
app.execute("RESET app.tenant_id")
rows = su.execute(G8B).fetchall()
R.add('G8b.break', 'pg_stat_statements check catches a session-level SET app.tenant_id (via PgBouncer)', '>= 1 row', str(rows),
      len(rows) > 0)
su.execute('SELECT pg_stat_statements_reset()')
app.execute("SELECT set_config('app.tenant_id', %s, false)", ('aaaaaaaa-0000-7000-8000-000000000001',))
app.execute("RESET app.tenant_id")
rows = su.execute(G8B).fetchall()
allq = su.execute("SELECT query FROM pg_stat_statements WHERE query ILIKE '%set_config%'").fetchall()
R.add('G8b.gap', "pg_stat_statements check vs session-level set_config('app.tenant_id', $1, false) from a driver",
      'documented gap (0 rows: constants are normalised to $n)', f'gate rows={rows}; recorded as {allq}', rows == [])
R.save()
