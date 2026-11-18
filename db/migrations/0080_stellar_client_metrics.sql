-- Source: docs/data-model.md, block '-- migration: 0080_stellar_client_metrics' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0080_stellar_client_metrics
-- Stellar SDK client metrics (win wave 2026-11-19, agent F2b; register C-153; wire-formats §f.5 step 4a, §g.7): the
-- outbound-dependency metrics of @scf-analytics/stellar-otel (a tenant backend's calls to Stellar RPC and Horizon,
-- transaction submissions, polls and simulations). They are NEVER API usage: separate tables, never read by the API
-- metrics, trust scoring, public metrics or snapshots. Every dimension is a closed set already applied by the
-- Collector; the checks here are the storage backstop (character class and length).
--
-- Dimensions per metric (operation | variant | outcome; '' = not applicable / absent):
--   rpc.client.call.duration      rpc.method      | ''                  | error.type ('' = success)
--   http.client.request.duration  url.template    | http.request.method | http.response.status_code, else error.type
--   stellar.tx.submissions        stellar.tx.via  | stellar.tx.status   | stellar.tx.result_class
--   stellar.tx.polls              stellar.tx.via  | stellar.tx.status   | stellar.tx.result_class
--   stellar.tx.simulations        ''              | stellar.sim.outcome | stellar.sim.error_class
-- Durations: count = calls, duration_sum seconds, hist explicit15 (§9.1). Counters: count = events, no histogram.

CREATE TABLE scf.stellar_client_1m (
  tenant_id     uuid        NOT NULL,
  service_id    uuid        NOT NULL,
  bucket_start  timestamptz NOT NULL,
  metric        text        NOT NULL CHECK (metric IN ('rpc.client.call.duration', 'http.client.request.duration',
                                                     'stellar.tx.submissions', 'stellar.tx.polls', 'stellar.tx.simulations')),
  network       text        NOT NULL CHECK (network IN ('mainnet', 'testnet', 'futurenet', 'local', 'unknown')),
  operation     text        NOT NULL CHECK (operation ~ '^[A-Za-z0-9_./{}-]{0,64}$'),
  variant       text        NOT NULL CHECK (variant ~ '^[A-Za-z0-9_]{0,32}$'),
  outcome       text        NOT NULL CHECK (outcome ~ '^[A-Za-z0-9_-]{0,32}$'),
  count         bigint      NOT NULL CHECK (count >= 0),
  duration_sum  float8      NOT NULL DEFAULT 0 CHECK (duration_sum >= 0),
  hist          int4[],
  hist_quality  smallint    NOT NULL DEFAULT 0 CHECK (hist_quality BETWEEN 0 AND 2),
  PRIMARY KEY (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  CHECK (CASE WHEN metric IN ('rpc.client.call.duration', 'http.client.request.duration')
              THEN hist IS NOT NULL AND cardinality(hist) = 15
              ELSE hist IS NULL AND duration_sum = 0 AND hist_quality = 0 END),
  CHECK (bucket_start = date_trunc('minute', bucket_start))
);
-- LIKE does not copy foreign keys: they are repeated (C-87).
CREATE TABLE scf.stellar_client_1h (LIKE scf.stellar_client_1m INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  CHECK (bucket_start = date_trunc('hour', bucket_start, 'UTC'))
);
CREATE TABLE scf.stellar_client_1d (LIKE scf.stellar_client_1m INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  CHECK (bucket_start = date_trunc('day', bucket_start, 'UTC'))
);
CREATE INDEX stellar_client_1m_tenant_time ON scf.stellar_client_1m (tenant_id, bucket_start);
CREATE INDEX stellar_client_1h_tenant_time ON scf.stellar_client_1h (tenant_id, bucket_start);
CREATE INDEX stellar_client_1d_tenant_time ON scf.stellar_client_1d (tenant_id, bucket_start);

-- Cumulative → delta state of the Stellar streams (as api_stream_state, §9.4, C-105, C-122), kept apart so the
-- API's stream-state cap is never consumed by client metrics. source_key = the stream without its data-point
-- attributes (C-122 "source already delivering"). Serialised by the writer's per-tenant advisory lock.
CREATE TABLE scf.stellar_client_stream_state (
  tenant_id          uuid     NOT NULL,
  stream_key         bytea    NOT NULL CHECK (octet_length(stream_key) = 32),
  source_key         bytea    NOT NULL CHECK (octet_length(source_key) = 32),
  service_id         uuid     NOT NULL,
  start_time_unix_ns bigint   NOT NULL,
  last_time_unix_ns  bigint   NOT NULL,
  last_count         bigint   NOT NULL,
  last_sum           float8   NOT NULL,
  last_layout        jsonb    NOT NULL,     -- {"kind":"explicit","bounds":[…]} | {"kind":"exponential","scale":s,"neg":n}
  last_buckets       bigint[] NOT NULL,
  last_zero_count    bigint   NOT NULL DEFAULT 0,
  last_exp_offset    integer,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stream_key),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE
);
CREATE INDEX stellar_client_stream_state_source ON scf.stellar_client_stream_state (tenant_id, source_key);

-- Tenant reads (scf_app) for the portal panel; the writer adds; retention and stream_gc delete. A tenant purge removes
-- the rows through the cascade from api_services (deleted by tenant_purge under the tenant's context).
CALL scf_admin.apply_tenant_rls('scf.stellar_client_1m', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{}',
  '{"SELECT":["retention"],"DELETE":["retention"]}');
CALL scf_admin.apply_tenant_rls('scf.stellar_client_1h', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{}',
  '{"SELECT":["retention"],"DELETE":["retention"]}');
CALL scf_admin.apply_tenant_rls('scf.stellar_client_1d', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{}',
  '{"SELECT":["retention"],"DELETE":["retention"]}');
CALL scf_admin.apply_tenant_rls('scf.stellar_client_stream_state', '{}', '{SELECT,INSERT,UPDATE}', '{}',
  '{"SELECT":["stream_gc"],"DELETE":["stream_gc"]}');

-- Cardinality caps (tunable like the other writer quotas). Series = one (service, metric, network, operation,
-- variant, outcome) row of a UTC day; new series beyond the cap and new streams beyond the state cap are dropped and
-- counted stellar_series_overflow (wire-formats §h.3).
INSERT INTO scf.settings (key, value, public, description) VALUES
 ('stellar_client_series_cap_per_tenant_day', '5000',  true, 'Stellar client-metric series (stellar_client_1d rows) a tenant may start per UTC day; beyond it stellar_series_overflow'),
 ('stellar_client_stream_cap_per_tenant',     '20000', true, 'Cumulative Stellar client-metric streams (stellar_client_stream_state rows) a tenant may hold; beyond it stellar_series_overflow');
ALTER TABLE scf.settings ADD CONSTRAINT settings_integer_stellar_client
  CHECK (key NOT IN ('stellar_client_series_cap_per_tenant_day', 'stellar_client_stream_cap_per_tenant')
         OR (jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,9}$'));

-- Retention (§14): 1m 35 days (as api_metrics_1m), 1h and 1d 25 months (aggregates ≥ 24 months, RFP), state 7 days
-- idle (as api_stream_state). scf.retention_rules() is replaced as a whole (0066's rows + these four).
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
