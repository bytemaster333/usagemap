-- Source: docs/data-model.md, block '-- migration: 0086_tracker_1_2' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0086_tracker_1_2
-- Tracker 1.2.0 (integration wave I1, agents T and V; lead decisions 2026-11-19; wire-formats §a.3.1, §a.3.2, §d.3).
-- (1) Stellar event schema v1 minor additions: three event names, four property keys, the wallet type `privy`.
ALTER TABLE scf.web_event_property_daily DROP CONSTRAINT web_event_property_daily_event_name_check;
ALTER TABLE scf.web_event_property_daily ADD CONSTRAINT web_event_property_daily_event_name_check
  CHECK (event_name IN ('wallet_modal_opened', 'wallet_modal_closed', 'wallet_selected', 'wallet_connect',
    'wallet_disconnect', 'sign_requested', 'sign_approved', 'sign_rejected', 'tx_submitted', 'smart_wallet_created',
    'passkey_used', 'wallet_connect_failed', 'walletconnect_session', 'walletconnect_request'));
ALTER TABLE scf.web_event_property_daily DROP CONSTRAINT web_event_property_daily_value;
ALTER TABLE scf.web_event_property_daily ADD CONSTRAINT web_event_property_daily_value CHECK (CASE prop_key
    WHEN '_total'       THEN prop_value = 'all'
    WHEN 'wallet'       THEN prop_value IN ('freighter', 'albedo', 'xbull', 'lobstr', 'hana', 'hot', 'rabet',
                               'walletconnect', 'ledger', 'trezor', 'fordefi', 'klever', 'onekey', 'bitget',
                               'cactuslink', 'dcent', 'scopuly', 'metamask', 'ghostsig', 'passkey', 'privy',
                               'injected_other', 'unknown')
    WHEN 'connect_kind' THEN prop_value IN ('new', 'restored')
    WHEN 'sign_kind'    THEN prop_value IN ('tx', 'auth_entry', 'message', 'tx_submit')
    WHEN 'error_class'  THEN prop_value IN ('user_rejected', 'invalid_request', 'external_service', 'internal',
                               'timeout', 'unsupported', 'unknown')
    WHEN 'result_class' THEN prop_value IN ('success', 'failed', 'pending', 'try_again_later', 'error')
    WHEN 'duration'     THEN prop_value IN ('lt5s', '5_30s', 'gt30s')
    WHEN 'outcome'      THEN prop_value IN ('connected', 'dismissed', 'error')
    WHEN 'passkey_op'   THEN prop_value IN ('register', 'authenticate', 'sign')
    WHEN 'failure_reason' THEN prop_value IN ('user_rejected', 'wallet_not_installed', 'wallet_locked',
                               'network_mismatch', 'timeout', 'error_other')
    WHEN 'wallet_context' THEN prop_value IN ('none', 'varial_inapp', 'dcent_inapp', 'scopuly_inapp', 'other_inapp',
                               'unknown')
    WHEN 'wc_state'     THEN prop_value IN ('proposed', 'approved', 'rejected')
    WHEN 'wc_method'    THEN prop_value IN ('sign_xdr', 'sign_submit_xdr', 'sign_message', 'sign_auth_entry')
    ELSE false END);

-- (2) Browser Stellar RPC / Horizon aggregate (wire-formats §a.3.2): per site and UTC day of receipt, the count of
--     calls per closed cell from accepted `stellar_rpc` aggregates (verified | suspect). No visitor key, session,
--     path, time of call, URL or address exists to store. Filled by the internal counter endpoint from the `rpc`
--     array of counter records as INSERT … ON CONFLICT DO UPDATE SET count = count + EXCLUDED.count. Never API usage
--     and never traffic: not read by trust scoring, public metrics, snapshots, cohorts, the operator console or the
--     API tables. Tenant reads only (portal panel "RPC calls from your users' browsers", getSiteBrowserRpc), which
--     are exact; nothing of it leaves the tenant, so no small-count floor applies (C-137). A tenant purge removes the
--     rows through the cascade from scf.sites; the retention job deletes days older than 25 months.
CREATE TABLE scf.web_rpc_client_daily (
  tenant_id  uuid   NOT NULL,
  site_id    uuid   NOT NULL,
  day        date   NOT NULL,
  api        text   NOT NULL CHECK (api IN ('rpc', 'horizon')),
  operation  text   NOT NULL CHECK (operation ~ '^[a-z0-9_]{1,40}$'),
  network    text   NOT NULL CHECK (network IN ('mainnet', 'testnet', 'futurenet', 'local', 'unknown')),
  outcome    text   NOT NULL CHECK (outcome IN ('ok', 'rpc_error', 'http_4xx', 'http_429', 'http_5xx', 'timeout',
                                                'network_error')),
  latency    text   NOT NULL CHECK (latency IN ('lt100ms', '100_500ms', '500_2000ms', 'gt2000ms')),
  verdict    text   NOT NULL CHECK (verdict IN ('verified', 'suspect')),
  count      bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (tenant_id, site_id, day, api, operation, network, outcome, latency, verdict),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE,
  CONSTRAINT web_rpc_client_daily_operation CHECK (operation = 'other' OR CASE api
    WHEN 'rpc' THEN operation IN ('get_health', 'get_network', 'get_latest_ledger', 'get_ledgers',
      'get_ledger_entries', 'get_events', 'get_fee_stats', 'get_version_info', 'get_transaction', 'get_transactions',
      'simulate_transaction', 'send_transaction', 'query_events')
    ELSE operation IN ('root', 'accounts', 'accounts_id', 'accounts_id_data_key', 'accounts_id_effects',
      'accounts_id_offers', 'accounts_id_operations', 'accounts_id_payments', 'accounts_id_trades',
      'accounts_id_transactions', 'assets', 'claimable_balances', 'claimable_balances_id',
      'claimable_balances_id_operations', 'claimable_balances_id_transactions', 'effects', 'fee_stats', 'friendbot',
      'health', 'ledgers', 'ledgers_id', 'ledgers_id_effects', 'ledgers_id_operations', 'ledgers_id_payments',
      'ledgers_id_transactions', 'liquidity_pools', 'liquidity_pools_id', 'liquidity_pools_id_effects',
      'liquidity_pools_id_operations', 'liquidity_pools_id_trades', 'liquidity_pools_id_transactions', 'offers',
      'offers_id', 'offers_id_trades', 'operations', 'operations_id', 'operations_id_effects', 'order_book', 'paths',
      'paths_strict_receive', 'paths_strict_send', 'payments', 'trade_aggregations', 'trades', 'transactions',
      'transactions_id', 'transactions_id_effects', 'transactions_id_operations', 'transactions_id_payments',
      'transactions_async') END)
);
CREATE INDEX web_rpc_client_daily_day ON scf.web_rpc_client_daily (day);   -- maintenance index
-- The tenant reads its own rows, the internal counter endpoint (scf_app, actor_kind system) adds them, the retention
-- job deletes expired days under the tenant's context. No other role has access.
CALL scf_admin.apply_tenant_rls('scf.web_rpc_client_daily', '{SELECT,INSERT,UPDATE}', '{}', '{}',
  '{"SELECT":["retention"],"DELETE":["retention"]}');

-- Retention (§14): 25 months like the other daily aggregates (≥ 24 months, RFP). scf.retention_rules() is replaced
-- as a whole (0085's rows + this one).
CREATE OR REPLACE FUNCTION scf.retention_rules()
  RETURNS TABLE (relname text, tenant_scoped boolean, keep interval, age_expr text, mechanism text, job text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ VALUES
    ('api_metrics_1m',        true,  interval '35 days',   'bucket_start',                          'partition_drop', 'partitions'),
    ('api_metrics_1h',        true,  interval '25 months', 'bucket_start',                          'partition_drop', 'partitions'),
    ('web_hourly_totals',     true,  interval '25 months', 'hour_start',                            'partition_drop', 'partitions'),
    ('api_ingest_ledger',     true,  interval '7 days',    't.received_at',                         'delete', 'retention'),
    ('api_ingest_counters',   true,  interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('web_edge_counters',     true,  interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('web_dev_events',        true,  interval '24 hours',  't.received_at',                         'delete', 'retention'),   -- C-136
    -- C-137: rejected (since the last check), removed (since removal) or never verified (since the claim); verified kept
    ('footprint_items',       true,  interval '30 days',
       'CASE WHEN t.removed_at IS NOT NULL THEN t.removed_at
             WHEN t.status = ''rejected'' THEN COALESCE(t.last_checked_at, t.created_at)
             WHEN t.status = ''claimed'' THEN t.created_at END',                                     'delete', 'retention'),
    ('tenant_invitations',    true,  interval '30 days',
       'LEAST(COALESCE(t.accepted_at, ''infinity''), COALESCE(t.revoked_at, ''infinity''), t.expires_at)', 'delete', 'retention'),
    -- failed or expired rows 90 days after they closed; the current (newest) row of a domain is kept for its life
    ('domain_verifications',  true,  interval '90 days',
       'CASE WHEN t.status IN (''failed'', ''expired'') AND EXISTS (SELECT 1 FROM scf.domain_verifications n
               WHERE n.tenant_id = t.tenant_id AND n.domain_id = t.domain_id AND n.created_at > t.created_at)
             THEN CASE t.status WHEN ''expired'' THEN t.expires_at ELSE COALESCE(t.last_checked_at, t.expires_at) END END',
       'delete', 'retention'),
    ('api_stream_state',      true,  interval '7 days',    't.updated_at',                          'delete', 'stream_gc'),
    ('api_route_day',         true,  interval '7 days',    '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'stream_gc'),
    -- C-153 (0080): Stellar client metrics
    ('stellar_client_1m',     true,  interval '35 days',   't.bucket_start + interval ''1 minute''', 'delete', 'retention'),
    ('stellar_client_1h',     true,  interval '25 months', 't.bucket_start + interval ''1 hour''',   'delete', 'retention'),
    ('stellar_client_1d',     true,  interval '25 months', 't.bucket_start + interval ''1 day''',    'delete', 'retention'),
    ('stellar_client_stream_state', true, interval '7 days', 't.updated_at',                        'delete', 'stream_gc'),
    -- 0085: integration client metrics (partner, payments, anchors)
    ('integration_metrics_1h', true, interval '35 days',   't.bucket_start + interval ''1 hour''',   'delete', 'retention'),
    ('integration_metrics_1d', true, interval '25 months', 't.bucket_start + interval ''1 day''',    'delete', 'retention'),
    ('integration_stream_state', true, interval '7 days',  't.updated_at',                          'delete', 'stream_gc'),
    -- 0086: browser Stellar RPC / Horizon aggregate (wire-formats §a.3.2)
    ('web_rpc_client_daily',  true,  interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('auth_sessions',         false, interval '7 days',
       'LEAST(COALESCE(t.revoked_at, ''infinity''), t.idle_expires_at, t.absolute_expires_at)', 'delete', 'retention'),
    ('auth_challenges',       false, interval '1 day',     't.expires_at',                          'delete', 'retention'),
    ('edge_report_ledger',    false, interval '7 days',    't.received_at',                         'delete', 'retention'),
    ('edge_spool_accounting', false, interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('durability_reports',    false, interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('registry_sync_runs',    false, interval '25 months', 't.started_at',                          'delete', 'retention'),
    -- a project a tenant link still references stays (FK; C-114): links are kept for the tenant's life
    ('registry_projects',     false, interval '365 days',
       'CASE WHEN NOT EXISTS (SELECT 1 FROM scf.tenant_registry_links l
                               WHERE l.registry_project_id = t.registry_project_id) THEN t.missing_since END',
       'delete', 'retention'),
    -- edge snapshots: the last 100 sequences are kept
    ('edge_snapshots',        false, interval '0',
       'CASE WHEN t.sequence <= (SELECT max(s.sequence) - 100 FROM scf.edge_snapshots s) THEN ''-infinity''::timestamptz END',
       'delete', 'retention'),
    -- erasure selectors: literal kept until finished_at + 56 days (C-88, C-112), then type and length only
    ('erasure_requests',      true,  interval '56 days',   't.finished_at',                         'redact', 'retention')
  $$;

-- (3) The counter-record part `rpc` is accepted once every control plane runs this release; the operator then adds
--     "rpc" to edge_counter_features (C-137 upgrade rule, wire-formats §d.3). Keeps "app" (0084).
ALTER TABLE scf.settings DROP CONSTRAINT settings_edge_counter_features;
ALTER TABLE scf.settings ADD CONSTRAINT settings_edge_counter_features
  CHECK (key <> 'edge_counter_features' OR (jsonb_typeof(value) = 'array' AND value <@ '["props", "dev", "app", "rpc"]'::jsonb));
