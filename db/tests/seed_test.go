// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Port of spikes/s03-rls-real-postgres/tests/seed.py to the final text of docs/data-model.md: tenants A, B and canary
// C with at least one row in EVERY tenant-owned table (incl. web_hourly_totals, C-109), one row in every global table.
// Inserted by the superuser (bypasses RLS; triggers still fire).

var users = map[string]string{
	A: "0a000000-0000-7000-8000-00000000000a",
	B: "0b000000-0000-7000-8000-00000000000b",
	C: "0c000000-0000-7000-8000-00000000000c",
}

const (
	uOp  = "0e000000-0000-7000-8000-00000000000e" // SCF operator
	uAdm = "0f000000-0000-7000-8000-00000000000f" // SCF operator_admin
	reg  = "0d000000-0000-7000-8000-00000000000d" // registry project
)

// uid derives a deterministic per-tenant UUID.
func uid(t string, n int) string { return t[:9] + fmt.Sprintf("%04x", n) + t[13:] }

func alnum(t string, n, length int) string {
	base := strings.ReplaceAll(t, "-", "") + strings.Repeat(fmt.Sprint(n), 40)
	var b strings.Builder
	for _, r := range base {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			b.WriteRune(r)
		}
	}
	return b.String()[:length]
}

func hashLit(s string) string {
	h := sha256.Sum256([]byte(s))
	return `'\x` + hex.EncodeToString(h[:]) + `'::bytea`
}

func slugOf(t string) string {
	return map[string]string{A: "tenant-a", B: "tenant-b", C: "canary-c"}[t]
}

func tenantSQL(t string, idx int) string {
	const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	var g, c strings.Builder
	g.WriteByte('G')
	c.WriteByte('C')
	for i := 0; i < 55; i++ {
		g.WriteByte(L[(idx*7+i)%32])
		c.WriteByte(L[(idx*5+i)%32])
	}
	site, dom, svc, ver, ev := uid(t, 1), uid(t, 2), uid(t, 3), uid(t, 4), uid(t, 5)
	con, req, ann, inv, snap := uid(t, 6), uid(t, 7), uid(t, 8), uid(t, 9), uid(t, 10)
	slug := slugOf(t)
	host := slug + ".example.org"
	u := users[t]
	canary := "false"
	if t == C {
		canary = "true"
	}
	r := strings.NewReplacer("{t}", t, "{u}", u, "{slug}", slug, "{host}", host, "{site}", site, "{dom}", dom,
		"{svc}", svc, "{ver}", ver, "{ev}", ev, "{con}", con, "{req}", req, "{ann}", ann, "{inv}", inv, "{snap}", snap,
		"{canary}", canary, "{gacct}", g.String(), "{cid}", c.String(), "{idx}", fmt.Sprint(idx), "{reg}", reg,
		"{sitekey}", alnum(t, 1, 22), "{vtoken}", alnum(t, 2, 22), "{ingid}", alnum(t, 3, 12), "{pubid}", alnum(t, 4, 12),
		"{umami}", uid(t, 11), "{ev2}", uid(t, 12), "{team}", uid(t, 13), "{uuser}", uid(t, 14), "{ukey}", uid(t, 15),
		"{uname}", strings.ReplaceAll(t, "-", ""),
		"{hinv}", hashLit("inv"+t), "{hing}", hashLit("ing"+t), "{hpub}", hashLit("pub"+t), "{hbatch}", hashLit("batch"+t),
		"{hstream}", hashLit("stream"+t), "{hsnap}", hashLit("snap"+t), "{hch}", hashLit("ch"+t),
		"{hsalt}", hashLit("salt"+t), "{hleaf}", hashLit("leaf"+t), "{fp}", uid(t, 16))
	metrics := ""
	for _, gb := range [][2]string{{"1m", "date_trunc('minute', now())"}, {"1h", "date_trunc('hour', now(), 'UTC')"},
		{"1d", "date_trunc('day', now(), 'UTC')"}} {
		metrics += fmt.Sprintf(`
INSERT INTO scf.api_metrics_%s (tenant_id, service_id, route_id, method, status_code, source, stream_group_id, bucket_start,
  request_count, duration_sum, duration_min, duration_max, hist_kind, hist)
  SELECT '{t}', '{svc}', r.route_id, 1, 200, 'sdk_metric', s.group_id, %s, 3, 0.3, 0.05, 0.15, 'explicit15',
         '{0,0,0,0,1,1,1,0,0,0,0,0,0,0,0}'::int4[]
    FROM scf.api_routes r, scf.api_stream_groups s WHERE r.tenant_id = '{t}' AND s.tenant_id = '{t}';`, gb[0], gb[1])
	}
	return r.Replace(`
INSERT INTO scf.users (user_id, display_name) VALUES ('{u}', 'owner {slug}');
INSERT INTO scf.external_identities (user_id, provider, subject, display_handle) VALUES ('{u}', 'github', '100{idx}', 'gh{idx}');
INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by, is_canary, public_stats_enabled)
  VALUES ('{t}', '{slug}', 'Tenant {slug}', 'active', '{u}', {canary}, true);
INSERT INTO scf.memberships (tenant_id, user_id, role) VALUES ('{t}', '{u}', 'owner');
INSERT INTO scf.tenant_invitations (tenant_id, invitation_id, role, code_hash, created_by, expires_at)
  VALUES ('{t}', '{inv}', 'member', {hinv}, '{u}', now() + interval '1 day');
INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by)
  VALUES ('{t}', '{site}', 'site {slug}', '{sitekey}', '{umami}', 'on', '{u}');
INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host, state, verified_at)
  VALUES ('{t}', '{dom}', '{site}', '{host}', 'verified', now());
INSERT INTO scf.domain_verifications (tenant_id, verification_id, domain_id, method, token, status, expires_at)
  VALUES ('{t}', '{ver}', '{dom}', 'dns_txt', '{vtoken}', 'verified', now() + interval '7 days');
INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES ('{host}', '{t}', '{dom}');
INSERT INTO scf.verification_evidence (tenant_id, evidence_id, kind, subject) VALUES ('{t}', '{ev}', 'domain', '{host}');
INSERT INTO scf.verification_evidence (tenant_id, evidence_id, kind, subject) VALUES ('{t}', '{ev2}', 'stellar_account', '{gacct}');
INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status)
  VALUES ('{t}', '{reg}', ARRAY['registrable_domain'], 'candidate');
INSERT INTO scf.api_services (tenant_id, service_id, service_name, created_by) VALUES ('{t}', '{svc}', 'svc-{slug}', '{u}');
INSERT INTO scf.declared_contracts (tenant_id, contract_ref, contract_id, network, service_id, created_by)
  VALUES ('{t}', '{con}', '{cid}', 'public', '{svc}', '{u}');
INSERT INTO scf.ingest_tokens (tenant_id, token_id, secret_hash, last4, label, created_by)
  VALUES ('{t}', '{ingid}', {hing}, 'abcd', 'ing {slug}', '{u}');
INSERT INTO scf.share_keys (tenant_id, key_id, secret_hash, last4, label, created_by)
  VALUES ('{t}', '{pubid}', {hpub}, 'abcd', 'pub {slug}', '{u}');
INSERT INTO scf.footprint_keys (tenant_id, key_id, secret_hash, last4, label, network, created_by)
  VALUES ('{t}', '` + alnum(t, 6, 12) + `', ` + hashLit("reg"+t) + `, 'abcd', 'reg {slug}', 'testnet', '{u}');
INSERT INTO scf.umami_credentials (tenant_id, umami_team_id, umami_user_id, umami_username, umami_api_key_id,
  api_key_ciphertext, password_ciphertext, key_version)
  VALUES ('{t}', '{team}', '{uuser}', 'scf-t-{uname}', '{ukey}', '\x00', '\x00', 1);
INSERT INTO scf.erasure_requests (tenant_id, request_id, site_id, criteria, requested_by)
  VALUES ('{t}', '{req}', '{site}', '{"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z","path_pattern":"/x/*"}', '{u}');
INSERT INTO scf.web_edge_counters VALUES ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date, 'verdict', 'verified', 3);
INSERT INTO scf.web_daily_totals (tenant_id, site_id, day, pageviews_verified, pageviews_raw, pageviews_unidentified_verified,
  pageviews_unidentified_raw, visitors_verified, visitors_raw, visits, bounces, total_duration_s, events_raw, is_final, engine_version)
  VALUES ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date - 1, 7, 9, 1, 2, 3, 4, 5, 1, 300, 12, true, 'umami/3.5.0');
INSERT INTO scf.web_hourly_totals (tenant_id, site_id, hour_start, pageviews_verified, pageviews_raw,
  pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, events_raw)
  VALUES ('{t}', '{site}', date_trunc('hour', now(), 'UTC'), 1, 2, 0, 1, 1, 1, 3);
INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews) VALUES
  ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date - 1, 'verified', 'country', 'XX', 3, 3, 4),
  ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date - 1, 'verified', 'country', 'DE', 1, 24, 26),
  ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date - 1, 'verified', 'country', 'FR', 2, 10, 14);
INSERT INTO scf.web_trust_scores (tenant_id, site_id, day, window_days, score, components, algorithm_version)
  VALUES ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date - 1, 1, 80, '{}', 'trust/1.0.0');
INSERT INTO scf.api_service_assurance (tenant_id, service_id, day, level, onchain_badge, checks)
  VALUES ('{t}', '{svc}', (now() AT TIME ZONE 'UTC')::date - 1, 1, 'not_applicable', '{}');
INSERT INTO scf.trust_annotations (tenant_id, annotation_id, site_id, range_start, range_end, author_kind, author_user_id, body)
  VALUES ('{t}', '{ann}', '{site}', date_trunc('day', now(), 'UTC') - interval '1 day', date_trunc('day', now(), 'UTC'), 'tenant', '{u}', 'note');
INSERT INTO scf.api_stream_groups (tenant_id, service_id, kind, metric_name, scope_name, rank_key)
  VALUES ('{t}', '{svc}', 'sdk_stable', 'http.server.request.duration', 'io.opentelemetry.x', '1|001|io.opentelemetry.x');
INSERT INTO scf.api_routes (tenant_id, service_id, route, parent_prefix, rules_version)
  VALUES ('{t}', '{svc}', '/v1/items/{id}', '/v1/items', 'scf-path-rules/1.0.0');
INSERT INTO scf.api_route_day (tenant_id, day, service_id, route_id)
  SELECT '{t}', (now() AT TIME ZONE 'UTC')::date, '{svc}', route_id FROM scf.api_routes WHERE tenant_id = '{t}';
INSERT INTO scf.api_service_day_groups (tenant_id, service_id, day, stream_group_id)
  SELECT '{t}', '{svc}', (now() AT TIME ZONE 'UTC')::date, group_id FROM scf.api_stream_groups WHERE tenant_id = '{t}';
` + metrics + `
INSERT INTO scf.api_ingest_ledger (tenant_id, batch_key, points) VALUES ('{t}', {hbatch}, 1);
INSERT INTO scf.api_stream_state (tenant_id, stream_key, start_time_unix_ns, last_time_unix_ns, last_count, last_sum, last_layout, last_buckets)
  VALUES ('{t}', {hstream}, 1, 2, 3, 0.3, '{"kind":"explicit"}', '{1,2}');
INSERT INTO scf.api_ingest_counters VALUES ('{t}', (now() AT TIME ZONE 'UTC')::date, '{svc}', 'quota_exceeded', 3);
INSERT INTO scf.stellar_client_1m (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome, count, duration_sum, hist)
  VALUES ('{t}', '{svc}', date_trunc('minute', now()), 'rpc.client.call.duration', 'testnet', 'getHealth', '', '', 2, 0.1,
          '{0,0,0,1,1,0,0,0,0,0,0,0,0,0,0}'::int4[]);
INSERT INTO scf.stellar_client_1h (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome, count)
  VALUES ('{t}', '{svc}', date_trunc('hour', now(), 'UTC'), 'stellar.tx.submissions', 'testnet', 'rpc', 'PENDING', '', 1);
INSERT INTO scf.stellar_client_1d (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome, count)
  VALUES ('{t}', '{svc}', date_trunc('day', now(), 'UTC'), 'stellar.tx.simulations', 'testnet', '', 'success', '', 1);
INSERT INTO scf.stellar_client_stream_state (tenant_id, stream_key, source_key, service_id, start_time_unix_ns, last_time_unix_ns,
  last_count, last_sum, last_layout, last_buckets)
  VALUES ('{t}', {hstream}, {hstream}, '{svc}', 1, 2, 3, 0.3, '{"kind":"explicit"}', '{1,2}');
INSERT INTO scf.integration_metrics_1h (tenant_id, service_id, bucket_start, metric, network, d1, d2, d3, count, duration_sum, hist)
  VALUES ('{t}', '{svc}', date_trunc('hour', now(), 'UTC'), 'stellar.partner.call.duration', 'testnet', 'soroswap', '/quote', 'success',
          2, 0.1, '{0,0,0,1,1,0,0,0,0,0,0,0,0,0,0}'::int4[]);
INSERT INTO scf.integration_metrics_1d (tenant_id, service_id, bucket_start, metric, network, d1, d2, count)
  VALUES ('{t}', '{svc}', date_trunc('day', now(), 'UTC'), 'payment.server.events', 'stellar:testnet', 'x402', 'settled', 1);
INSERT INTO scf.integration_stream_state (tenant_id, stream_key, source_key, service_id, start_time_unix_ns, last_time_unix_ns,
  last_count, last_sum, last_layout, last_buckets)
  VALUES ('{t}', {hstream}, {hstream}, '{svc}', 1, 2, 3, 0.3, '{"kind":"explicit"}', '{1,2}');
INSERT INTO scf.onchain_daily (tenant_id, contract_ref, day, invocations, successful_invocations, distinct_invokers, data_source)
  VALUES ('{t}', '{con}', (now() AT TIME ZONE 'UTC')::date - 1, 3, 2, 1, 'hubble');
INSERT INTO scf.protocol_usage_tenant_daily (tenant_id, network, day, protocol, transactions, successful_transactions, contracts, registry_version)
  VALUES ('{t}', 'mainnet', '2025-01-06', 'any', 3, 2, 1, '2026-11-19.1'), ('{t}', 'mainnet', '2025-01-06', 'blend', 1, 1, 1, '2026-11-19.1');
INSERT INTO scf.traction_snapshots (tenant_id, snapshot_id, created_by, period_start, period_end, document, canonical_sha256, signature, kid)
  VALUES ('{t}', '{snap}', '{u}', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '{}', {hsnap}, '\x` + strings.Repeat("00", 64) + `', 'k1');
INSERT INTO scf.public_metrics_documents (tenant_id, document) VALUES ('{t}', '{"tenant":"{slug}"}');
INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict, reason)
  VALUES ('{t}', '{site}', now(), 'stellar', 'wallet_connect', '/app', 'suspect', 'proof_missing');
INSERT INTO scf.web_event_property_daily (tenant_id, site_id, day, event_name, network, prop_key, prop_value, verdict, count)
  VALUES ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date, 'wallet_connect', 'mainnet', '_total', 'all', 'verified', 4),
         ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date, 'wallet_connect', 'mainnet', 'wallet', 'freighter', 'verified', 3);
INSERT INTO scf.app_event_daily (tenant_id, site_id, day, platform, event_name, prop_key, prop_value, count)
  VALUES ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date, 'ios', 'app_open', '_total', 'all', 2);
INSERT INTO scf.web_rpc_client_daily (tenant_id, site_id, day, api, operation, network, outcome, latency, verdict, count)
  VALUES ('{t}', '{site}', (now() AT TIME ZONE 'UTC')::date, 'rpc', 'send_transaction', 'mainnet', 'ok', 'lt100ms', 'verified', 2);
INSERT INTO scf.seal_leaves (tenant_id, snapshot_id, network, day, leaf_index, salt, leaf_hash, audit_path)
  VALUES ('{t}', '{snap}', 'testnet', (now() AT TIME ZONE 'UTC')::date - 1, 2 + {idx}, {hsalt}, {hleaf}, ARRAY[{hch}]);
INSERT INTO scf.footprint_items (tenant_id, item_id, kind, subject, network, created_by)
  VALUES ('{t}', '{fp}', 'issuing_account', '{gacct}', 'mainnet', '{u}');
INSERT INTO scf.auth_challenges (kind, secret_hash, user_id, tenant_id, subject, expires_at)
  VALUES ('stellar_link_sep53', {hch}, '{u}', '{t}', '{gacct}', now() + interval '5 minutes');
SELECT set_config('app.actor_kind', 'system', true);
INSERT INTO scf.audit_log (tenant_id, actor_kind, action) VALUES ('{t}', 'system', 'tenant.created');
`)
}

func seedSQL() string {
	glob := strings.NewReplacer("{op}", uOp, "{adm}", uAdm, "{reg}", reg, "{hsess}", hashLit("sess"), "{hreg}", hashLit("reg"),
		"{hop}", hashLit("op"), "{hsnapenv}", hashLit("snapenv"), "{rec}", uid(A, 99), "{cred}", strings.Repeat("11", 16)).Replace(`
INSERT INTO scf.users (user_id, display_name) VALUES ('{op}', 'scf operator'), ('{adm}', 'scf operator admin');
INSERT INTO scf.platform_operators (user_id, role) VALUES ('{op}', 'operator'), ('{adm}', 'operator_admin');
INSERT INTO scf.passkey_credentials (credential_id, user_id, public_key, backup_eligible, backup_state)
  VALUES ('\x{cred}', '{op}', '\x00', false, false);
INSERT INTO scf.auth_sessions (session_hash, user_id, kind, first_factor, reauth_method, idle_expires_at, absolute_expires_at)
  VALUES ({hsess}, '{op}', 'operator', 'github', 'passkey', now() + interval '30 min', now() + interval '12 hours');
INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, scf_awarded, fetched_at, content_sha256, raw)
  VALUES ('{reg}', 'stellarlight', 'p1', 'Project', true, now(), {hreg}, '{}');
INSERT INTO scf.registry_sync_runs (source) VALUES ('stellarlight');
INSERT INTO scf.operator_api_keys (key_id, secret_hash, last4, label, scopes, created_by, expires_at)
  VALUES ('opkey0000001', {hop}, 'abcd', 'machine', ARRAY['web:read','api:read'], '{adm}', now() + interval '90 days');
INSERT INTO scf.edge_snapshots (sequence, envelope, payload_sha256) VALUES (1, '\x00', {hsnapenv});
INSERT INTO scf.edge_report_ledger (node_id, record_id) VALUES ('edge-1', '{rec}');
INSERT INTO scf.rate_limit_buckets (bucket, window_end, hits) VALUES (decode(repeat('ab', 32), 'hex'), now() + interval '1 minute', 1);
INSERT INTO scf.edge_spool_accounting (node_id, day) VALUES ('edge-1', (now() AT TIME ZONE 'UTC')::date);
INSERT INTO scf.durability_reports (day, subject, expected, observed, status)
  VALUES ((now() AT TIME ZONE 'UTC')::date - 1, 'node:edge-1', 1, 1, 'balanced');
INSERT INTO scf.seal_days (network, day, prev_root, audit_anchor_sha256, leaf_count, head_path, root)
  VALUES ('testnet', (now() AT TIME ZONE 'UTC')::date - 1, decode(repeat('00', 32), 'hex'), {hreg}, 5, ARRAY[{hreg}, {hop}], {hop});
INSERT INTO scf.sealed_audit_anchors (day, sha256, document) VALUES ('2025-01-05', decode(repeat('ab', 32), 'hex'),
  jsonb_build_object('schema', 'scf-analytics/audit-anchor/1', 'date', '2025-01-05', 'sha256', repeat('ab', 32), 'chains', '[]'::jsonb));
INSERT INTO scf.usage_map_days (network, day, ledgers, ledger_first, ledger_last, anchor_ledger, anchor_hash, anchor_checked, projects, contracts)
  VALUES ('mainnet', '2025-01-06', 2, 10, 11, 12, repeat('cd', 32), true, 1, 1);
INSERT INTO scf.usage_map_project_daily (registry_project_id, network, day, invocations, successful_invocations, distinct_invokers,
  contract_calls, contracts_listed, contracts_invoked) VALUES ('{reg}', 'mainnet', '2025-01-06', 1, 1, 1, 0, 1, 1);
INSERT INTO scf.usage_map_project_weekly (registry_project_id, network, week_start, active_accounts, active_accounts_successful,
  invocations, successful_invocations, contract_calls) VALUES ('{reg}', 'mainnet', '2025-01-06', 1, 1, 1, 1, 0);
INSERT INTO scf.usage_map_contract_daily (network, day, contract_id, invocations, successful_invocations, distinct_invokers,
  contract_calls, successful_contract_calls) VALUES ('mainnet', '2025-01-06', 'C' || repeat('S', 55), 1, 1, 1, 0, 0);
INSERT INTO scf.usage_map_function_daily (network, day, contract_id, function_name, caller_kind, calls, successful_calls)
  VALUES ('mainnet', '2025-01-06', 'C' || repeat('S', 55), 'f', 'account', 1, 1);
INSERT INTO scf.protocol_usage_days (network, day, ledgers, ledger_first, ledger_last, anchor_ledger, anchor_hash, anchor_checked,
  registry_version, projects, tenants) VALUES ('mainnet', '2025-01-06', 2, 10, 11, 12, repeat('cd', 32), true, '2026-11-19.1', 1, 3);
INSERT INTO scf.protocol_usage_network_daily (network, day, protocol, transactions, successful_transactions)
  VALUES ('mainnet', '2025-01-06', 'blend', 5, 4);
INSERT INTO scf.protocol_usage_project_daily (registry_project_id, network, day, protocol, transactions, successful_transactions)
  VALUES ('{reg}', 'mainnet', '2025-01-06', 'any', 2, 2), ('{reg}', 'mainnet', '2025-01-06', 'soroswap', 1, 1);
-- MCP OAuth (0083): one client, request, operator grant, code and token (global tables)
INSERT INTO scf.oauth_clients (client_id, kind, client_name, redirect_uris)
  VALUES ('umc_seedseedseedseedseedseedseedseed', 'dcr', 'Seed client', ARRAY['https://client.example/cb']);
INSERT INTO scf.oauth_requests (client_id, redirect_uri, code_challenge, scope, resource, expires_at)
  VALUES ('umc_seedseedseedseedseedseedseedseed', 'https://client.example/cb', repeat('A', 43), 'usagemap:read',
          'https://app.example/mcp', now() + interval '5 minutes');
INSERT INTO scf.oauth_grants (grant_id, client_id, user_id, kind, scope, resource, expires_at)
  VALUES ('0e000000-0000-7000-8000-0000000000a1', 'umc_seedseedseedseedseedseedseedseed', '{op}', 'operator',
          'usagemap:read', 'https://app.example/mcp', now() + interval '1 hour');
INSERT INTO scf.oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
  VALUES ({hsess}, '0e000000-0000-7000-8000-0000000000a1', 'https://client.example/cb', repeat('A', 43), now() + interval '1 minute');
INSERT INTO scf.oauth_tokens (token_hash, grant_id, kind, audience, expires_at)
  VALUES ({hsess}, '0e000000-0000-7000-8000-0000000000a1', 'access', 'https://app.example/mcp', now() + interval '10 minutes');
`)
	body := glob
	for i, t := range []string{A, B, C} {
		body += tenantSQL(t, i)
	}
	body += fmt.Sprintf(`
INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id, reason) VALUES ('host', 'old.example.org', '%s', 'seed');
INSERT INTO scf.audit_log (tenant_id, actor_kind, action) VALUES (NULL, 'system', 'audit.anchored');
`, B)
	return body
}

// seed inserts the fixture and checks the precondition (M0): no table of schema scf is empty.
func seed() error {
	ctx := context.Background()
	su, err := pgx.Connect(ctx, dsn("postgres", "scf", false))
	if err != nil {
		return err
	}
	defer su.Close(ctx)
	tx, err := su.Begin(ctx)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, seedSQL()); err != nil {
		_ = tx.Rollback(ctx)
		return fmt.Errorf("seed: %s", sqlState(err))
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	empty, err := queryStrings(ctx, su, `
	  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	   WHERE n.nspname = 'scf' AND c.relkind IN ('r', 'p')
	     AND (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', c.oid::regclass), false, true, '')))[1]::text::int = 0
	   ORDER BY 1`)
	if err != nil {
		return err
	}
	if len(empty) > 0 {
		return fmt.Errorf("seed leaves tables empty: %v", empty)
	}
	return nil
}
