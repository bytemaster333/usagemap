"""S-03 item 4b: call every op_* function in an SCF-operator (or op_key) context through PgBouncer; check exactly one
audit row per call in the same transaction, the C-95 rule (min count + rounding only on web breakdown rows), canary
exclusion, key scope/tenant restriction, and that no runtime role reaches op_* / op_begin another way."""
import json
import psycopg
from lib import connect, Recorder, err_text
from seed import A, B, C, U, U_OP, U_ADM, REG, uid

R = Recorder('/out/t-ops.json')
su = connect('postgres', via='direct')
today = su.execute("SELECT date_trunc('day', now(), 'UTC')").fetchone()[0]
D0 = su.execute("SELECT date_trunc('day', now(), 'UTC') - interval '1 day'").fetchone()[0]
D2 = su.execute("SELECT date_trunc('day', now(), 'UTC') + interval '1 day'").fetchone()[0]
TOMB = su.execute("SELECT tombstone_id FROM scf.enrollment_tombstones LIMIT 1").fetchone()[0]


def ctx(conn, kind='operator', actor=U_OP, prole='operator', step_up=True, extra=None):
    s = {'app.actor_kind': kind, 'app.actor_id': actor or '', 'app.platform_role': prole or '',
         'app.request_id': 'req-s03', 'app.step_up_at': '', 'app.tenant_id': ''}
    if step_up:
        s['app.step_up_at'] = su.execute("SELECT now()::text").fetchone()[0]
    s.update(extra or {})
    for k, v in s.items():
        conn.execute('SELECT set_config(%s, %s, true)', (k, v))


def call(role, sql, params=None, **ctxkw):
    """One transaction: set context, run sql, read this transaction's audit rows. Returns (rows|error, audit_rows)."""
    conn = connect(role)
    try:
        with conn.transaction():
            ctx(conn, **ctxkw)
            rows = conn.execute(sql, params).fetchall()
            audit = conn.execute("""SELECT action, tenant_id::text, outcome, subject_tenant_ids::text[], actor_kind
                                      FROM scf.audit_log WHERE tx_id = pg_current_xact_id() ORDER BY seq""").fetchall()
            raise psycopg.Rollback()   # keep the database unchanged between checks
    except psycopg.Error as e:
        return 'ERROR ' + err_text(e), []
    finally:
        conn.close()
    return rows, audit


def one_audit(audit, action):
    return len(audit) == 1 and audit[0][0] == action


# ---------------- read functions, SCF operator context (scf_app)
rows, au = call('scf_app', 'SELECT tenant_id::text, verification_level, site_count, service_count FROM scf.op_projects()')
R.add('O1', 'op_projects as operator', 'A and B listed, canary C excluded, 1 audit row operator.read.op_projects',
      f'{rows} audit={au}', isinstance(rows, list) and {r[0] for r in rows} == {A, B} and one_audit(au, 'operator.read.op_projects'))

rows, au = call('scf_app', "SELECT tenant_id::text, pageviews, visitors_sum, suppressed FROM scf.op_web_metrics(%s, %s)", (D0, today))
R.add('O2', 'op_web_metrics (C-95: totals exact, no k / rounding)', 'pageviews 7 and visitors 3 returned exactly, suppressed=false; 1 audit row',
      f'{rows} audit={au}', isinstance(rows, list) and len(rows) == 2 and all(r[1] == 7 and r[2] == 3 and r[3] is False for r in rows)
      and one_audit(au, 'operator.read.op_web_metrics'))

rows, au = call('scf_app', "SELECT tenant_id::text, pageviews FROM scf.op_web_metrics(%s, %s, 'day', 'all')", (D0, today))
R.add('O2b', "op_web_metrics p_group='all'", 'one row, tenant NULL, pageviews 14 (A+B, canary excluded)', f'{rows}',
      rows == [(None, 14)])
rows, au = call('scf_app', "SELECT tenant_id::text, pageviews FROM scf.op_web_metrics(%s, %s, p_tenants => %s::uuid[])", (D0, today, [C]))
R.add('O2c', 'op_web_metrics naming canary C', 'C returned only when named', f'{rows}', rows == [(C, 7)])

rows, au = call('scf_app', "SELECT tenant_id::text, value, visitors_sum, pageviews, suppressed FROM scf.op_web_breakdown(%s, %s, 'country') ORDER BY 1, 2",
                (D0, today))
exp = sorted([(t, 'DE', 20, 30, False) for t in (A, B)] + [(t, 'FR', 10, 10, False) for t in (A, B)])
R.add('O3', 'op_web_breakdown (C-95: the ONLY thresholded output, k=10, round to 10)',
      'XX (3 visitors) omitted; DE 24→20 visitors, 26→30 pageviews; FR 10→10, 14→10', f'{rows} audit={au}',
      rows == exp and one_audit(au, 'operator.read.op_web_breakdown'))

rows, au = call('scf_app', "SELECT tenant_id::text, counter, label, count, suppressed FROM scf.op_web_verdicts(%s, %s)", (today, D2))
R.add('O4', 'op_web_verdicts (exact)', 'count 3 exactly per tenant, 1 audit row', f'{rows} audit={au}',
      isinstance(rows, list) and len(rows) == 2 and all(r[3] == 3 for r in rows) and one_audit(au, 'operator.read.op_web_verdicts'))

rows, au = call('scf_app', "SELECT tenant_id::text, requests, status_2xx, p50_s, p95_s, p99_s, accuracy_class, suppressed FROM scf.op_api_metrics(%s, %s, 'range', 'service')",
                (today, D2))
R.add('O5', 'op_api_metrics (exact, merged percentiles)', 'requests 3 exactly (below k), p50/p95/p99 set, accuracy explicit15',
      f'{rows} audit={au}', isinstance(rows, list) and len(rows) == 2 and all(r[1] == 3 and r[3] is not None and r[6] == 'explicit15' for r in rows)
      and one_audit(au, 'operator.read.op_api_metrics'))

rows, au = call('scf_app', "SELECT tenant_id::text, score FROM scf.op_trust(%s, %s)", (D0, today))
R.add('O6', 'op_trust', '2 rows, 1 audit row', f'{rows} audit={au}', isinstance(rows, list) and len(rows) == 2 and one_audit(au, 'operator.read.op_trust'))
rows, au = call('scf_app', "SELECT tenant_id::text, level FROM scf.op_api_assurance(%s, %s)", (D0, today))
R.add('O7', 'op_api_assurance', '2 rows, 1 audit row', f'{rows} audit={au}', isinstance(rows, list) and len(rows) == 2 and one_audit(au, 'operator.read.op_api_assurance'))
rows, au = call('scf_app', "SELECT tenant_id::text, invocations, distinct_invokers, suppressed FROM scf.op_onchain(%s, %s)", (D0, today))
R.add('O8', 'op_onchain (exact)', 'invocations 3, distinct_invokers 1 exactly, 1 audit row', f'{rows} audit={au}',
      isinstance(rows, list) and len(rows) == 2 and all(r[1] == 3 and r[2] == 1 for r in rows) and one_audit(au, 'operator.read.op_onchain'))

rows, au = call('scf_app', "SELECT scf.op_tenant_detail(%s)", (A,))
doc = rows[0][0] if isinstance(rows, list) else {}
R.add('O9', 'op_tenant_detail(A)', "jsonb for A, no secret_hash in tokens; 1 audit row in A's chain",
      f"keys={sorted(doc)} tokens={doc.get('ingest_tokens')} audit={au}",
      isinstance(rows, list) and 'secret_hash' not in json.dumps(doc.get('ingest_tokens')) and one_audit(au, 'operator.read.op_tenant_detail')
      and au[0][1] == A)

rows, au = call('scf_app', "SELECT action, tenant_id::text FROM scf.op_audit_list(%s, %s)", (D0, D2))
R.add('O10', 'op_audit_list', 'audit rows of every chain, 1 audit row for the call', f'{len(rows) if isinstance(rows, list) else rows} rows; audit={au}',
      isinstance(rows, list) and len(rows) >= 4 and one_audit(au, 'operator.read.op_audit_list'))

# ---------------- op_metrics_document (scf_metrics_ro, op_key)
KEY = dict(kind='op_key', actor='opkey0000001', prole=None, step_up=False)
rows, au = call('scf_metrics_ro', "SELECT scf.op_metrics_document('tenant-a')", **KEY, extra={'app.key_scopes': 'web:read,api:read'})
R.add('O11', 'op_metrics_document via op_key with both scopes', 'document of A, 1 audit row outcome success',
      f'{rows} audit={au}', isinstance(rows, list) and rows[0][0] == {'tenant': 'tenant-a'} and one_audit(au, 'operator.read.op_metrics_document') and au[0][2] == 'success')
rows, au = call('scf_metrics_ro', "SELECT scf.op_metrics_document('tenant-a')", **KEY,
                extra={'app.key_scopes': 'web:read,api:read', 'app.key_tenants': '{' + B + '}'})
R.add('O12', 'op_metrics_document, key restricted to B, asks for A', 'NULL; audit row outcome denied', f'{rows} audit={au}',
      rows == [(None,)] and one_audit(au, 'operator.read.op_metrics_document') and au[0][2] == 'denied')
rows, au = call('scf_metrics_ro', "SELECT scf.op_metrics_document('tenant-a')", **KEY, extra={'app.key_scopes': 'web:read'})
R.add('O13', 'op_metrics_document with web:read only (needs both)', 'ERROR 42501 scope', str(rows), str(rows).startswith('ERROR 42501'))
rows, au = call('scf_metrics_ro', "SELECT tenant_id::text FROM scf.op_web_metrics(%s, %s, p_tenants => %s::uuid[])", (D0, today, [B]), **KEY,
                extra={'app.key_scopes': 'web:read', 'app.key_tenants': '{' + A + '}'})
R.add('O14', 'op_key restricted to A asks op_web_metrics for B', '0 rows (intersection empty); audit subject = {}', f'{rows} audit={au}',
      rows == [] and len(au) == 1)
rows, au = call('scf_metrics_ro', "SELECT tenant_id::text FROM scf.op_web_metrics(%s, %s)", (D0, today), **KEY,
                extra={'app.key_scopes': 'web:read', 'app.key_tenants': '{' + A + '}'})
R.add('O15', 'op_key restricted to A, no tenant filter', 'only A', f'{rows}', rows == [(A,)])
rows, au = call('scf_metrics_ro', "SELECT * FROM scf.op_api_metrics(%s, %s, 'range')", (today, D2), **KEY, extra={'app.key_scopes': 'web:read'})
R.add('O16', 'op_key with web:read calls op_api_metrics (needs api:read)', 'ERROR 42501', str(rows), str(rows).startswith('ERROR 42501'))
r0, _ = call('scf_metrics_ro', "SELECT * FROM scf.op_projects(1, '{active}')", **KEY, extra={'app.key_scopes': 'registry:read'})
R.add('O17a', 'op_projects(1, ...) with an int4 literal for p_min_level smallint', 'documented usability issue: ERROR 42883',
      str(r0), str(r0).startswith('ERROR 42883'), 'callers must pass smallint explicitly; integer parameters would be friendlier')
rows, au = call('scf_metrics_ro', "SELECT * FROM scf.op_projects(1::smallint, '{active,removed}')", **KEY, extra={'app.key_scopes': 'registry:read'})
R.add('O17', 'op_key lists removed tenants via op_projects', 'ERROR 42501', str(rows), str(rows).startswith('ERROR 42501'))

# ---------------- write functions (step-up), SCF operator
rows, au = call('scf_app', 'SELECT scf.op_add_annotation(%s, %s, NULL, %s, %s, %s)', (A, uid(A, 1), D0, today, 'operator note'))
R.add('O18', 'op_add_annotation(A, site of A)', "annotation id; 1 audit row trust.annotation.created in A's chain", f'{rows} audit={au}',
      isinstance(rows, list) and one_audit(au, 'trust.annotation.created') and au[0][1] == A)
rows, au = call('scf_app', 'SELECT scf.op_add_annotation(%s, %s, NULL, %s, %s, %s)', (A, uid(B, 1), D0, today, 'x'))
R.add('O19', "op_add_annotation(A, site of B) (C-87)", 'ERROR P0002 not found', str(rows), str(rows).startswith('ERROR P0002'))
rows, au = call('scf_app', 'SELECT scf.op_add_annotation(%s, %s, NULL, %s, %s, %s)', (A, uid(A, 1), D0, today, 'x'), step_up=False)
R.add('O20', 'write without step-up (C-09)', 'ERROR 42501 step-up required', str(rows), 'step-up required' in str(rows))
rows, au = call('scf_app', "SELECT scf.op_registry_link_decide(%s, %s, 'confirm')", (A, REG))
R.add('O21', 'op_registry_link_decide confirm', '1 audit row registry.link_confirmed', f'{rows} audit={au}', one_audit(au, 'registry.link_confirmed'))
rows, au = call('scf_app', "SELECT scf.op_resolve_domain_dispute(%s, %s, 'keep')", (A, uid(A, 2)))
R.add('O22', 'op_resolve_domain_dispute', '1 audit row domain.dispute_resolved', f'{rows} audit={au}', one_audit(au, 'domain.dispute_resolved'))
rows, au = call('scf_app', "SELECT scf.op_approve_tenant_evidence(%s, 'ok')", (A,))
R.add('O23', 'op_approve_tenant_evidence', 'evidence id; 1 audit row verification.operator_approved', f'{rows} audit={au}',
      isinstance(rows, list) and one_audit(au, 'verification.operator_approved'))
rows, au = call('scf_app', "SELECT scf.op_tenant_transition(%s, 'suspend', 'test')", (B,))
R.add('O24', 'op_tenant_transition(B, suspend)', "'suspended'; 1 audit row tenant.suspended in B's chain", f'{rows} audit={au}',
      rows == [('suspended',)] and one_audit(au, 'tenant.suspended') and au[0][1] == B)
rows, au = call('scf_app', "SELECT scf.op_tenant_transition(%s, 'remove', 'test')", (B,))
R.add('O25', 'op_tenant_transition remove by plain operator', 'ERROR 42501 operator_admin required', str(rows), 'operator_admin required' in str(rows))
rows, au = call('scf_app', "SELECT scf.op_tenant_transition(%s, 'remove', 'test')", (B,), actor=U_ADM, prole='operator_admin')
R.add('O26', 'op_tenant_transition remove by operator_admin', "'removed'; 1 audit row tenant.removed", f'{rows} audit={au}',
      rows == [('removed',)] and one_audit(au, 'tenant.removed'))
rows, au = call('scf_app', 'SELECT scf.op_lift_tombstone(%s)', (TOMB,), actor=U_ADM, prole='operator_admin')
R.add('O27', 'op_lift_tombstone by operator_admin', '1 audit row operator.tombstone_lifted (platform chain)', f'{rows} audit={au}',
      one_audit(au, 'operator.tombstone_lifted') and au[0][1] is None)

# ---------------- no other way in
rows, au = call('scf_app', "SELECT * FROM scf.op_web_metrics(%s, %s)", (D0, today), kind='user', actor=U[A], prole=None,
                extra={'app.tenant_id': A})
R.add('N1', 'scf_app in a tenant (user) context calls op_web_metrics', 'ERROR 42501, no audit row', f'{rows} {au}', str(rows).startswith('ERROR 42501') and not au)
for role in ('scf_writer', 'scf_jobs'):
    rows, au = call(role, "SELECT * FROM scf.op_web_metrics(%s, %s)", (D0, today))
    R.add(f'N2.{role}', f'{role} calls op_web_metrics', 'permission denied for function', str(rows), 'permission denied for function' in str(rows))
for role in ('scf_app', 'scf_metrics_ro', 'scf_writer', 'scf_jobs'):
    rows, au = call(role, "SELECT scf.op_begin('operator.read.op_projects', NULL, NULL, '{}'::jsonb)")
    r2, _ = call(role, "SELECT * FROM scf.op_eligible_tenants(0::smallint)")
    R.add(f'N3.{role}', f'{role} calls op_begin / op_eligible_tenants directly', 'permission denied for function (both)', f'{rows} | {r2}',
          'permission denied' in str(rows) and 'permission denied' in str(r2))
rows, au = call('scf_metrics_ro', 'SELECT scf.op_tenant_detail(%s)', (A,))
R.add('N4', 'scf_metrics_ro calls console-only op_tenant_detail', 'permission denied for function', str(rows), 'permission denied' in str(rows))
# the operator context sees no tenant row in base tables (also covered by matrix M3) — spot check with a direct SELECT
rows, au = call('scf_app', 'SELECT count(*) FROM scf.web_daily_totals')
R.add('N5', 'scf_app, operator context, SELECT web_daily_totals directly', '0 rows', str(rows), rows == [(0,)])
# all op_* are SECURITY DEFINER owned by scf_op_definer, proconfig has search_path, no PUBLIC execute
rows = su.execute("""SELECT p.proname, pg_get_userbyid(p.proowner), p.prosecdef, has_function_privilege('public', p.oid, 'EXECUTE')
                       FROM pg_proc p WHERE p.pronamespace = 'scf'::regnamespace AND p.proname LIKE 'op\\_%' AND p.proname <> 'op_count' ORDER BY 1""").fetchall()
bad = [r for r in rows if r[1] != 'scf_op_definer' or r[3] or (not r[2] and r[0] not in ('op_begin', 'op_eligible_tenants'))]
R.add('N6', 'catalog: every op_* owned by scf_op_definer, definer (except helpers), no PUBLIC EXECUTE', 'no exceptions',
      f'{len(rows)} functions; exceptions {bad}', not bad)
R.save()
