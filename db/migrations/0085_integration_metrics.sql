-- Source: docs/data-model.md, block '-- migration: 0085_integration_metrics' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0085_integration_metrics
-- Integration client metrics (integration wave I1, agent U; wire-formats §f.5 steps 4b–4d, §g.8): the writer's
-- "integration" stream. A tenant backend's calls to SCF Integration List partner APIs (@scf-analytics/partner-otel),
-- its agent-payment lifecycle events (x402 / MPP, @scf-analytics/payments-otel), a wallet's anchor funnel
-- (@scf-analytics/anchor-otel) and an anchor's own Anchor Platform events (tools/ap-listener). Self-attested
-- telemetry of the tenant's own systems: NEVER API usage — separate tables, never read by the API metrics, trust
-- scoring, public metrics, snapshots or the Usage Map — and never in scf.stellar_client_*. Every dimension is a
-- closed set (or, for the two anchor business names, a vetted public DNS name / short configured name) already
-- applied by the Collector; the checks here are the storage backstop (character class and length).
--
-- Dimensions per metric (d1 … d7; '' = not applicable / not sent). network is stellar.network (mainnet, testnet,
-- futurenet, local, unknown), or payment.network for payments (stellar:pubnet, stellar:testnet, other, unknown).
--   stellar.partner.call.duration            partner | operation | outcome
--   payment.server.events                    protocol | stage | scheme (x402) or method (MPP) | intent (MPP) | asset
--                                            | amount_bucket (stage not failed/canceled) or reason_class (failed/
--                                            canceled) | error.type (failed/canceled)
--   stellar.anchor.request.duration          sep | step | outcome | home_domain
--   stellar.anchor.events                    event | sep | home_domain
--   stellar.anchor.transfer.created          sep | kind | '' | '' | client
--   stellar.anchor.transfer.transitions      sep | kind | status_from | status
--   stellar.anchor.transfer.status.duration  sep | kind | '' | status
--   stellar.anchor.transfer.duration         sep | kind | '' | status
--   stellar.anchor.customer.updates          '' | '' | '' | status | client
--   stellar.anchor.quotes.created            '' | '' | '' | '' | client
-- Values: count = calls / events; partner and anchor request durations keep duration_sum (seconds) and the
-- explicit15 histogram (§9.1). The two transfer durations (minutes to days, beyond explicit15's 10 s top bound) keep
-- count and duration_sum only (a mean), no histogram. Counters keep count only.
--
-- Resolution (why no minute table): the panels show 24 h … 25 months; the worst-case cardinality of payments
-- (≈ 1.34 M attribute sets per service and scope, bounded here by the series caps below) times 1,440 minutes a day
-- is not worth storing for a dependency-health panel. _1h (35 days) serves ranges up to 31 days; _1d (25 months)
-- everything (aggregates ≥ 24 months, RFP).

CREATE TABLE scf.integration_metrics_1h (
  tenant_id     uuid        NOT NULL,
  service_id    uuid        NOT NULL,
  bucket_start  timestamptz NOT NULL,
  metric        text        NOT NULL CHECK (metric IN ('stellar.partner.call.duration', 'payment.server.events',
                  'stellar.anchor.request.duration', 'stellar.anchor.events', 'stellar.anchor.transfer.created',
                  'stellar.anchor.transfer.transitions', 'stellar.anchor.transfer.status.duration',
                  'stellar.anchor.transfer.duration', 'stellar.anchor.customer.updates', 'stellar.anchor.quotes.created')),
  network       text        NOT NULL,
  d1            text        NOT NULL DEFAULT '' CHECK (d1 ~ '^[A-Za-z0-9_./{}:-]{0,64}$'),
  d2            text        NOT NULL DEFAULT '' CHECK (d2 ~ '^[A-Za-z0-9_./{}:-]{0,64}$'),
  d3            text        NOT NULL DEFAULT '' CHECK (d3 ~ '^[A-Za-z0-9_./{}:-]{0,253}$'),
  d4            text        NOT NULL DEFAULT '' CHECK (d4 ~ '^[A-Za-z0-9_./{}:-]{0,253}$'),
  d5            text        NOT NULL DEFAULT '' CHECK (d5 ~ '^[A-Za-z0-9_./{}:-]{0,253}$'),
  d6            text        NOT NULL DEFAULT '' CHECK (d6 ~ '^[A-Za-z0-9_./{}:-]{0,64}$'),
  d7            text        NOT NULL DEFAULT '' CHECK (d7 ~ '^[A-Za-z0-9_./{}:-]{0,64}$'),
  count         bigint      NOT NULL CHECK (count >= 0),
  duration_sum  float8      NOT NULL DEFAULT 0 CHECK (duration_sum >= 0),
  hist          int4[],
  hist_quality  smallint    NOT NULL DEFAULT 0 CHECK (hist_quality BETWEEN 0 AND 2),
  PRIMARY KEY (tenant_id, service_id, bucket_start, metric, network, d1, d2, d3, d4, d5, d6, d7),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  CONSTRAINT integration_metrics_network CHECK (CASE WHEN metric = 'payment.server.events'
    THEN network IN ('stellar:pubnet', 'stellar:testnet', 'other', 'unknown')
    ELSE network IN ('mainnet', 'testnet', 'futurenet', 'local', 'unknown') END),
  -- no column holds a key-like run (a Stellar strkey is 56 base32 characters; no closed-set value comes close)
  CONSTRAINT integration_metrics_no_keys CHECK (concat_ws('|', d1, d2, d3, d4, d5, d6, d7) !~* '[a-z2-7]{52}'),
  CONSTRAINT integration_metrics_shape CHECK (CASE
    WHEN metric IN ('stellar.partner.call.duration', 'stellar.anchor.request.duration')
      THEN hist IS NOT NULL AND cardinality(hist) = 15
    WHEN metric IN ('stellar.anchor.transfer.status.duration', 'stellar.anchor.transfer.duration')
      THEN hist IS NULL AND hist_quality = 0
    ELSE hist IS NULL AND duration_sum = 0 AND hist_quality = 0 END),
  CHECK (bucket_start = date_trunc('hour', bucket_start, 'UTC'))
);
-- LIKE does not copy foreign keys: they are repeated (C-87).
CREATE TABLE scf.integration_metrics_1d (LIKE scf.integration_metrics_1h INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (tenant_id, service_id, bucket_start, metric, network, d1, d2, d3, d4, d5, d6, d7),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  CHECK (bucket_start = date_trunc('day', bucket_start, 'UTC'))   -- (the copied hour-grid check holds as well)
);
CREATE INDEX integration_metrics_1h_tenant_time ON scf.integration_metrics_1h (tenant_id, bucket_start);
CREATE INDEX integration_metrics_1d_tenant_time ON scf.integration_metrics_1d (tenant_id, bucket_start);

-- Cumulative → delta state of the integration stream (as stellar_client_stream_state, 0080), kept apart so neither
-- the API's nor the Stellar client stream's state cap is consumed. Serialised by the writer's per-tenant advisory lock.
CREATE TABLE scf.integration_stream_state (
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
CREATE INDEX integration_stream_state_source ON scf.integration_stream_state (tenant_id, source_key);

-- Tenant reads (scf_app) for the portal panels; the writer adds; retention and stream_gc delete. A tenant purge
-- removes the rows through the cascade from api_services (deleted by tenant_purge under the tenant's context).
CALL scf_admin.apply_tenant_rls('scf.integration_metrics_1h', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{}',
  '{"SELECT":["retention"],"DELETE":["retention"]}');
CALL scf_admin.apply_tenant_rls('scf.integration_metrics_1d', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{}',
  '{"SELECT":["retention"],"DELETE":["retention"]}');
CALL scf_admin.apply_tenant_rls('scf.integration_stream_state', '{}', '{SELECT,INSERT,UPDATE}', '{}',
  '{"SELECT":["stream_gc"],"DELETE":["stream_gc"]}');

-- Cardinality caps (tunable like the other writer quotas). Series = one (service, metric, network, d1 … d7) row of a
-- UTC day (integration_metrics_1d). New series beyond the tenant's or the service's daily cap and new streams beyond
-- the state cap are dropped and counted stellar_series_overflow (wire-formats §h.3). The service cap keeps one
-- hostile or misconfigured service (payments: ≈ 1.34 M possible attribute sets) from using the tenant's whole day.
INSERT INTO scf.settings (key, value, public, description) VALUES
 ('integration_series_cap_per_tenant_day',  '5000',  true, 'Integration client-metric series (integration_metrics_1d rows) a tenant may start per UTC day; beyond it stellar_series_overflow'),
 ('integration_series_cap_per_service_day', '2000',  true, 'Integration client-metric series one service may start per UTC day; beyond it stellar_series_overflow'),
 ('integration_stream_cap_per_tenant',      '20000', true, 'Cumulative integration client-metric streams (integration_stream_state rows) a tenant may hold; beyond it stellar_series_overflow');
ALTER TABLE scf.settings ADD CONSTRAINT settings_integer_integration
  CHECK (key NOT IN ('integration_series_cap_per_tenant_day', 'integration_series_cap_per_service_day',
                     'integration_stream_cap_per_tenant')
         OR (jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,9}$'));

-- Retention (§14): 1h 35 days, 1d 25 months (aggregates ≥ 24 months, RFP), state 7 days idle (as api_stream_state).
-- scf.retention_rules() is replaced as a whole (0080's rows + these three).
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
