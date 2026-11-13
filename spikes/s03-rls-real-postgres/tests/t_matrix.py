"""S-03 item 4a: SQL-level cross-tenant matrix. Relations are enumerated from the catalog (every table, partitioned
table, partition and view in scf / scf_part). For each runtime role and context (one transaction through PgBouncer,
GUCs via set_config(...,true)), count visible rows that do not belong to tenant A; try UPDATE/DELETE of B's rows.
Expected 0 everywhere, except documented cross-tenant jobs (tenant unset) and allow-listed global tables."""
import psycopg
from lib import connect, Recorder, err_text
from seed import A, B, C, U, U_OP

R = Recorder('/out/t-matrix.json')
su = connect('postgres', via='direct')
JOBS = ['partitions', 'retention', 'edge_snapshot', 'web_rollup', 'trust_scoring', 'registry_sync', 'domain_verification',
        'contract_verification', 'onchain_correlation', 'erasure', 'tenant_purge', 'public_metrics', 'umami_reconcile',
        'durability_reconcile', 'audit_verify', 'audit_anchor', 'stream_gc']
# tables whose tenant_id is a reference, not ownership (docs/data-model.md §15 G2/G9 allow-list)
REF_ONLY = {'auth_challenges', 'enrollment_tombstones'}

rels = su.execute("""
  SELECT c.oid::regclass::text, c.relname, c.relkind,
         EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped),
         EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'chain_id' AND NOT a.attisdropped)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('scf', 'scf_part') AND c.relkind IN ('r', 'p', 'v') ORDER BY 1""").fetchall()
tenant_rels = [r for r in rels if (r[3] or r[4]) and r[1] not in REF_ONLY]
print(f'{len(rels)} relations enumerated, {len(tenant_rels)} carry tenant_id/chain_id')
# B must really have rows in every tenant relation that is a table (views/partitions may legitimately be empty)
missing = []
for name, rel, kind, has_t, has_c in tenant_rels:
    col = 'tenant_id' if has_t else 'chain_id'
    n = su.execute(f"SELECT count(*) FROM {name} WHERE {col} = '{B}'").fetchone()[0]
    if n == 0 and kind in ('r', 'p') and not name.startswith('scf_part.'):
        missing.append(name)
R.add('M0', 'tenant B has rows in every tenant-owned table (precondition)', 'no table without B rows', str(missing), not missing)


def ctx_sql(tenant=None, kind='user', actor=None, job=None, extra=None):
    s = {'app.tenant_id': tenant or '', 'app.actor_kind': kind, 'app.actor_id': actor or '', 'app.job': job or ''}
    s.update(extra or {})
    return s


def probe(role, ctx, expect_zero=True):
    """Returns list of (relation, foreign_rows_visible, write_rows_affected_on_B, error)."""
    out = []
    conn = connect(role, db='scf')
    with conn.transaction():
        for k, v in ctx.items():
            conn.execute('SELECT set_config(%s, %s, true)', (k, v))
        for name, rel, kind, has_t, has_c in rels:
            col = 'tenant_id' if has_t else ('chain_id' if has_c else None)
            vis = wr = None
            err = ''
            try:
                with conn.transaction():   # savepoint
                    if col:   # foreign = rows of tenants B or C (platform rows and the actor's own tenant A excluded)
                        vis = conn.execute(f'SELECT count(*) FROM {name} WHERE {col} IN (%s::uuid, %s::uuid)', (B, C)).fetchone()[0]
                    else:
                        vis = conn.execute(f'SELECT count(*) FROM {name}').fetchone()[0]
            except psycopg.Error as e:
                err = err_text(e)
            if col and kind in ('r', 'p'):
                n = 0
                for stmt in (f"UPDATE {name} SET {col} = {col} WHERE {col} = '{B}'", f"DELETE FROM {name} WHERE {col} = '{B}'"):
                    try:
                        with conn.transaction():
                            n += conn.execute(stmt).rowcount
                            raise psycopg.Rollback()
                    except psycopg.Error:
                        pass
                wr = n
                if n:
                    print(f'   !! {role} {ctx.get("app.job") or ctx.get("app.actor_kind")}: {n} B rows updatable/deletable in {name}', flush=True)
            out.append((name, rel, has_t or has_c, vis, wr, err))
        raise psycopg.Rollback()
    conn.close()
    return out


def check(tid, role, ctx, label, allow_cross=False):
    res = probe(role, ctx)
    bad = [(n, v, w) for n, rel, ten, v, w, e in res if ten and rel not in REF_ONLY and ((v or 0) > 0 or (w or 0) > 0)]
    readable = sum(1 for r in res if not r[5])
    if allow_cross:
        R.add(tid, f'{role} {label}', 'cross-tenant reads allowed by design; 0 B rows updatable/deletable (§6.3 writes only under the tenant context)',
              f'{readable}/{len(res)} relations readable; relations showing foreign rows: {len([b for b in bad if b[1]])}; '
              f'writes on B rows: {sum((b[2] or 0) for b in bad)}', all((b[2] or 0) == 0 for b in bad))
    else:
        R.add(tid, f'{role} {label}', '0 foreign rows visible and 0 B rows updatable/deletable in every relation',
              f'{readable}/{len(res)} relations readable; violations: {bad}', not bad)
    return res


# scf_app — tenant routes
check('M1', 'scf_app', ctx_sql(A, 'user', U[A]), 'tenant A, actor user')
check('M2', 'scf_app', ctx_sql(None, 'user', U[A]), 'GUC unset (empty), actor user of A (tenants/memberships via membership only)')
check('M3', 'scf_app', ctx_sql(A, 'operator', U_OP, extra={'app.platform_role': 'operator'}),
      'actor_kind operator WITH tenant A set (C-17: must see no tenant row at all)')
check('M4', 'scf_app', ctx_sql(None, 'anonymous'), 'anonymous, no context')
check('M5', 'scf_app', ctx_sql(A, 'op_key', 'opkey0000001', extra={'app.key_scopes': 'web:read,api:read'}), 'op_key context with tenant A set')
# scf_writer
check('M6', 'scf_writer', ctx_sql(A, 'writer', 'writer'), 'tenant A, actor writer')
check('M7', 'scf_writer', ctx_sql(None, 'writer', 'writer'), 'no tenant')
# scf_metrics_ro
check('M8', 'scf_metrics_ro', ctx_sql(A, 'op_key', 'opkey0000001', extra={'app.key_scopes': 'web:read,api:read'}), 'op_key, tenant A set')
check('M9', 'scf_metrics_ro', ctx_sql(None, 'operator', U_OP, extra={'app.platform_role': 'operator'}), 'operator, no tenant')
# scf_jobs — every named job under tenant A, and the for-tenant jobs without a tenant
for i, j in enumerate(JOBS):
    check(f'M10.{i:02d}', 'scf_jobs', ctx_sql(A, 'job', j, job=j), f'job {j}, tenant A',
          allow_cross=j in ('audit_verify', 'audit_anchor'))   # these two read every audit chain by design (§5)
for j in ('erasure', 'tenant_purge'):
    check(f'M11.{j}', 'scf_jobs', ctx_sql(None, 'job', j, job=j), f'job {j}, tenant UNSET (C-87: no cross-tenant read)')
check('M12', 'scf_jobs', ctx_sql(None, 'job', 'x'), 'no app.job, no tenant')
# §6.3: cross-tenant READS for named jobs, but "writes are always under the target tenant's context"
for j in JOBS:
    if j not in ('erasure', 'tenant_purge'):
        check(f'M13.{j}', 'scf_jobs', ctx_sql(None, 'job', j, job=j), f'job {j}, tenant unset', allow_cross=True)
R.save()
