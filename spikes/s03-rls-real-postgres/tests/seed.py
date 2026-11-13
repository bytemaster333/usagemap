"""Seed tenants A, B and canary C with at least one row in EVERY tenant-owned table of the migrated `scf` database
(superuser, bypasses RLS; triggers still fire). Global tables get one row each. Idempotent per fresh migration."""
import hashlib
from lib import connect

A = 'aaaaaaaa-0000-7000-8000-000000000001'
B = 'bbbbbbbb-0000-7000-8000-000000000002'
C = 'cccccccc-0000-7000-8000-000000000003'
U = {A: '0a000000-0000-7000-8000-00000000000a', B: '0b000000-0000-7000-8000-00000000000b',
     C: '0c000000-0000-7000-8000-00000000000c'}
U_OP = '0e000000-0000-7000-8000-00000000000e'
U_ADM = '0f000000-0000-7000-8000-00000000000f'
REG = '0d000000-0000-7000-8000-00000000000d'


def h(s):
    return "'\\x" + hashlib.sha256(s.encode()).hexdigest() + "'::bytea"


def uid(t, n):  # deterministic per-tenant uuid
    return t[:9] + f'{n:04x}' + t[13:]


def alnum(t, n, length):
    base = (t.replace('-', '') + f'{n}' * 40)
    return ''.join(ch for ch in base if ch.isalnum())[:length]


def tenant_sql(t, idx):
    L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    g_acct = 'G' + ''.join(L[(idx * 7 + i) % 32] for i in range(55))
    c_id = 'C' + ''.join(L[(idx * 5 + i) % 32] for i in range(55))
    site, dom, svc, ver, ev = uid(t, 1), uid(t, 2), uid(t, 3), uid(t, 4), uid(t, 5)
    con, req, ann, inv, snap = uid(t, 6), uid(t, 7), uid(t, 8), uid(t, 9), uid(t, 10)
    slug = {0: 'tenant-a', 1: 'tenant-b', 2: 'canary-c'}[idx]
    host = f'{slug}.example.org'
    u = U[t]
    canary = 'true' if idx == 2 else 'false'
    return f"""
INSERT INTO scf.users (user_id, display_name) VALUES ('{u}', 'owner {slug}');
INSERT INTO scf.external_identities (user_id, provider, subject, display_handle) VALUES ('{u}', 'github', '{1000 + idx}', 'gh{idx}');
INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by, is_canary, public_stats_enabled)
  VALUES ('{t}', '{slug}', 'Tenant {slug}', 'active', '{u}', {canary}, true);
INSERT INTO scf.memberships (tenant_id, user_id, role) VALUES ('{t}', '{u}', 'owner');
INSERT INTO scf.tenant_invitations (tenant_id, invitation_id, role, code_hash, created_by, expires_at)
  VALUES ('{t}', '{inv}', 'member', {h('inv' + t)}, '{u}', now() + interval '1 day');
INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by)
  VALUES ('{t}', '{site}', 'site {slug}', '{alnum(t, 1, 22)}', '{uid(t, 11)}', 'on', '{u}');
INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host, state, verified_at)
  VALUES ('{t}', '{dom}', '{site}', '{host}', 'verified', now());
INSERT INTO scf.domain_verifications (tenant_id, verification_id, domain_id, method, token, status, expires_at)
  VALUES ('{t}', '{ver}', '{dom}', 'dns_txt', '{alnum(t, 2, 22)}', 'verified', now() + interval '7 days');
INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES ('{host}', '{t}', '{dom}');
INSERT INTO scf.verification_evidence (tenant_id, evidence_id, kind, subject) VALUES ('{t}', '{ev}', 'domain', '{host}');
INSERT INTO scf.verification_evidence (tenant_id, evidence_id, kind, subject) VALUES ('{t}', '{uid(t, 12)}', 'stellar_account', '{g_acct}');
INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status)
  VALUES ('{t}', '{REG}', ARRAY['registrable_domain'], 'candidate');
INSERT INTO scf.api_services (tenant_id, service_id, service_name, created_by) VALUES ('{t}', '{svc}', 'svc-{slug}', '{u}');
INSERT INTO scf.declared_contracts (tenant_id, contract_ref, contract_id, network, service_id, created_by)
  VALUES ('{t}', '{con}', '{c_id}', 'public', '{svc}', '{u}');
INSERT INTO scf.ingest_tokens (tenant_id, token_id, secret_hash, last4, label, created_by)
  VALUES ('{t}', '{alnum(t, 3, 12)}', {h('ing' + t)}, 'abcd', 'ing {slug}', '{u}');
INSERT INTO scf.share_keys (tenant_id, key_id, secret_hash, last4, label, created_by)
  VALUES ('{t}', '{alnum(t, 4, 12)}', {h('pub' + t)}, 'abcd', 'pub {slug}', '{u}');
INSERT INTO scf.umami_credentials (tenant_id, umami_team_id, umami_user_id, umami_username, umami_api_key_id,
  api_key_ciphertext, password_ciphertext, key_version)
  VALUES ('{t}', '{uid(t, 13)}', '{uid(t, 14)}', 'scf-t-{t.replace('-', '')}', '{uid(t, 15)}', '\\x00', '\\x00', 1);
INSERT INTO scf.erasure_requests (tenant_id, request_id, site_id, criteria, requested_by)
  VALUES ('{t}', '{req}', '{site}', '{{"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z","path_pattern":"/x/*"}}', '{u}');
INSERT INTO scf.web_edge_counters VALUES ('{t}', '{site}', current_date, 'verdict', 'verified', 3);
INSERT INTO scf.web_daily_totals VALUES ('{t}', '{site}', current_date - 1, 7, 9, 1, 2, 3, 4, 5, 1, 300, true, 'umami/3.5.0');
INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews) VALUES
  ('{t}', '{site}', current_date - 1, 'verified', 'country', 'XX', 3, 3, 4),
  ('{t}', '{site}', current_date - 1, 'verified', 'country', 'DE', 1, 24, 26),
  ('{t}', '{site}', current_date - 1, 'verified', 'country', 'FR', 2, 10, 14);
INSERT INTO scf.web_trust_scores (tenant_id, site_id, day, window_days, score, components, algorithm_version)
  VALUES ('{t}', '{site}', current_date - 1, 1, 80, '{{}}', 'trust/1.0.0');
INSERT INTO scf.api_service_assurance (tenant_id, service_id, day, level, onchain_badge, checks)
  VALUES ('{t}', '{svc}', current_date - 1, 1, 'not_applicable', '{{}}');
INSERT INTO scf.trust_annotations (tenant_id, annotation_id, site_id, range_start, range_end, author_kind, author_user_id, body)
  VALUES ('{t}', '{ann}', '{site}', date_trunc('day', now(), 'UTC') - interval '1 day', date_trunc('day', now(), 'UTC'), 'tenant', '{u}', 'note');
INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key)
  VALUES ('{t}', '{svc}', 'sdk_stable', 'http.server.request.duration', 'io.opentelemetry.x', '1|001|io.opentelemetry.x');
INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rules_version)
  VALUES ('{t}', '{svc}', '/v1/items/{{id}}', '/v1/items', 'scf-path-rules/1.0.0');
INSERT INTO scf.api_route_day (tenant_id, day, service_id, route_id)
  SELECT '{t}', current_date, '{svc}', route_id FROM scf.api_routes WHERE tenant_id = '{t}';
INSERT INTO scf.api_service_day_groups (tenant_id, service_id, day, stream_group_id)
  SELECT '{t}', '{svc}', current_date, group_id FROM scf.api_stream_groups WHERE tenant_id = '{t}';
"""+ ''.join(f"""
INSERT INTO scf.api_metrics_{g} (tenant_id, service_id, route_id, method, status_code, source, stream_group_id, bucket_start,
  request_count, duration_sum, duration_min, duration_max, hist_kind, hist)
  SELECT '{t}', '{svc}', r.route_id, 1, 200, 'sdk_metric', s.group_id, {bs}, 3, 0.3, 0.05, 0.15, 'explicit15',
         '{{0,0,0,0,1,1,1,0,0,0,0,0,0,0,0}}'::bigint[]
    FROM scf.api_routes r, scf.api_stream_groups s WHERE r.tenant_id = '{t}' AND s.tenant_id = '{t}';"""
    for g, bs in (('1m', "date_trunc('minute', now())"), ('1h', "date_trunc('hour', now())"),
                  ('1d', "date_trunc('day', now(), 'UTC')"))) + f"""
INSERT INTO scf.api_ingest_ledger (tenant_id, batch_key, points) VALUES ('{t}', {h('batch' + t)}, 1);
INSERT INTO scf.api_stream_state (tenant_id, stream_key, start_time_unix_ns, last_time_unix_ns, last_count, last_sum, last_layout, last_buckets)
  VALUES ('{t}', {h('stream' + t)}, 1, 2, 3, 0.3, '{{"kind":"explicit"}}', '{{1,2}}');
INSERT INTO scf.api_ingest_counters VALUES ('{t}', current_date, '{svc}', 'quota_exceeded', 3);
INSERT INTO scf.onchain_daily (tenant_id, contract_ref, day, invocations, successful_invocations, distinct_invokers, data_source)
  VALUES ('{t}', '{con}', current_date - 1, 3, 2, 1, 'hubble');
INSERT INTO scf.traction_snapshots (tenant_id, snapshot_id, created_by, period_start, period_end, document, canonical_sha256, signature, kid)
  VALUES ('{t}', '{snap}', '{u}', '2026-01-01', '2026-02-01', '{{}}', {h('snap' + t)}, '\\x{'00' * 64}', 'k1');
INSERT INTO scf.public_metrics_documents (tenant_id, document) VALUES ('{t}', '{{"tenant":"{slug}"}}');
INSERT INTO scf.auth_challenges (kind, secret_hash, user_id, tenant_id, subject, expires_at)
  VALUES ('stellar_link_sep53', {h('ch' + t)}, '{u}', '{t}', '{g_acct}', now() + interval '5 minutes');
SELECT set_config('app.actor_kind', 'system', true);
INSERT INTO scf.audit_log (tenant_id, actor_kind, action) VALUES ('{t}', 'system', 'tenant.created');
"""


def seed_sql():
    glob = f"""
INSERT INTO scf.users (user_id, display_name) VALUES ('{U_OP}', 'scf operator'), ('{U_ADM}', 'scf operator admin');
INSERT INTO scf.platform_operators (user_id, role) VALUES ('{U_OP}', 'operator'), ('{U_ADM}', 'operator_admin');
INSERT INTO scf.passkey_credentials (credential_id, user_id, public_key, backup_eligible, backup_state)
  VALUES ('\\x{'11' * 16}', '{U_OP}', '\\x00', false, false);
INSERT INTO scf.auth_sessions (session_hash, user_id, kind, first_factor, reauth_method, idle_expires_at, absolute_expires_at)
  VALUES ({h('sess')}, '{U_OP}', 'operator', 'github', 'passkey', now() + interval '30 min', now() + interval '12 hours');
INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, fetched_at, content_sha256, raw)
  VALUES ('{REG}', 'stellarlight', 'p1', 'Project', true, now(), {h('reg')}, '{{}}');
INSERT INTO scf.registry_sync_runs (source) VALUES ('stellarlight');
INSERT INTO scf.operator_api_keys (key_id, secret_hash, last4, label, scopes, created_by, expires_at)
  VALUES ('opkey0000001', {h('op')}, 'abcd', 'machine', ARRAY['web:read','api:read'], '{U_ADM}', now() + interval '90 days');
INSERT INTO scf.edge_snapshots (sequence, envelope, payload_sha256) VALUES (1, '\\x00', {h('snapenv')});
INSERT INTO scf.edge_report_ledger (node_id, record_id) VALUES ('edge-1', '{uid(A, 99)}');
INSERT INTO scf.edge_spool_accounting (node_id, day) VALUES ('edge-1', current_date);
INSERT INTO scf.durability_reports (day, subject, expected, observed, status) VALUES (current_date - 1, 'node:edge-1', 1, 1, 'balanced');
"""
    body = glob + ''.join(tenant_sql(t, i) for i, t in enumerate((A, B, C)))
    body += f"""
INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id, reason) VALUES ('host', 'old.example.org', '{B}', 'seed');
INSERT INTO scf.audit_log (tenant_id, actor_kind, action) VALUES (NULL, 'system', 'audit.anchored');
"""
    return 'BEGIN;\n' + body + '\nCOMMIT;'


if __name__ == '__main__':
    su = connect('postgres', via='direct')
    su.execute(seed_sql())
    rows = su.execute("""SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', c.oid::regclass), false, true, '')))[1]::text::int
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'scf' AND c.relkind IN ('r','p') ORDER BY 1""").fetchall()
    empty = [r[0] for r in rows if r[1] == 0]
    print(f'seeded {len(rows)} tables; empty: {empty}')
