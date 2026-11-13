-- Source: docs/data-model.md, block '-- migration: 0006_settings' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0006_settings
CREATE TABLE scf.settings (
  key         text  PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  value       jsonb NOT NULL,
  public      boolean NOT NULL DEFAULT false,
  description text  NOT NULL CHECK (char_length(description) <= 500),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  CHECK (key <> 'enrollment_mode' OR value IN ('"open"'::jsonb, '"approval_required"'::jsonb)),
  CHECK (key <> 'web_event_retention_days' OR ((value #>> '{}')::int BETWEEN 30 AND 395)),
  CHECK (key <> 'web_live_events_budget' OR ((value #>> '{}')::int BETWEEN 10000 AND 1000000)),
  CHECK (key <> 'web_live_window_max_days' OR ((value #>> '{}')::int BETWEEN 1 AND 90)),
  CHECK (key <> 'pow_cost' OR ((value #>> '{}')::int BETWEEN 256 AND 65535))
);

INSERT INTO scf.settings (key, value, public, description) VALUES
 ('enrollment_mode',            '"open"',   true, 'open | approval_required; affects new enrollments only (ADR-0015, C-08, C-19)'),
 ('op_min_count',               '10',       true, 'Minimum count k for anything SCF operators or programme outputs see (ADR-0027, Q-21)'),
 ('op_round_to',                '10',       true, 'Rounding step for those counts (ADR-0027, Q-21)'),
 ('tenant_min_count',           '10',       true, 'Minimum count for anonymous_reports in tenant dashboards (C-51)'),
 ('tenant_round_to',            '10',       true, 'Rounding step for anonymous_reports (C-51)'),
 ('ecosystem_percentile_min_tenants', '20', true, 'Ecosystem percentiles shown only with at least this many active tenants (C-44)'),
 ('web_breakdown_top_n',        '50',       true, 'Rows kept per site/day/variant/dimension in web_daily_breakdowns'),
 ('web_event_retention_days',   '90',       true, 'Umami event-level retention, platform-wide (C-54: 30–395 days; 395 is the hard maximum)'),
 ('web_live_events_budget',     '250000',   true, 'Engine events one live dashboard query may cover; sets each site''s live window (C-109, S-11: p95 ≈ 1 s warm at 250k events)'),
 ('web_live_window_max_days',   '90',       true, 'Upper bound of a site''s live window in days, never above the site''s event-level retention (C-109)'),
 ('l0_max_sites',               '2',        true, 'Sites per tenant at L0 (C-19)'),
 ('l0_max_services',            '1',        true, 'API services per tenant at L0 (C-19)'),
 ('l0_events_per_day',          '50000',    true, 'Daily web quota per tenant at L0, shared by its sites; counts verified events only (C-19, C-80, C-90)'),
 ('l0_routes_per_day',          '100',      true, 'Distinct routes/day per tenant at L0 (C-19)'),
 ('l1_events_per_day',          '1000000',  true, 'Daily web quota per tenant at L1+, shared by its sites; counts verified events only (C-90)'),
 ('l0_web_requests_per_min_site', '600',    true, 'Per-site web request rate limit at L0, platform-wide figure; each edge enforces limit ÷ live edges (C-90)'),
 ('web_requests_per_min_site',  '6000',     true, 'Per-site web request rate limit at L1+, as above (C-90)'),
 ('web_requests_per_min_subnet', '600',     true, 'Per-site, per-truncated-subnet web request rate limit, per edge node (ADR-0005, C-80)'),
 ('max_services_per_tenant',    '20',       true, 'Auto-registration quota for services (C-21)'),
 ('max_active_ingest_tokens',   '5',        true, 'Active ingest tokens per tenant (C-21)'),
 ('max_tenants_per_user',       '3',        true, 'Tenants a user may create'),
 ('route_cap_per_service_day',  '1000',     true, 'Cardinality guard (C-24)'),
 ('route_cap_per_tenant_day',   '5000',     true, 'Cardinality guard (C-24)'),
 ('route_sibling_cap',          '200',      true, 'Distinct literal children per prefix (C-24)'),
 ('otlp_requests_per_s',        '50',       true, 'Per-tenant OTLP request rate'),
 ('otlp_burst',                 '200',      true, 'Per-tenant OTLP burst'),
 ('otlp_bytes_per_s',           '1048576',  true, 'Per-tenant OTLP compressed bytes/s'),
 ('op_key_requests_per_min',    '600',      true, 'Default operator API key rate (C-21)'),
 ('web_events_per_token',       '300',      true, 'Events per challenge token before token_flood'),
 ('pow_cost',                   '512',      true, 'PBKDF2 iterations per proof-of-work attempt; ≥ 256 (below that call overhead dominates, S-07); default confirmed by S-07, C-106'),
 ('pow_max',                    '1024',     true, 'Counter space at base difficulty (512 × 1024 ≈ 2^18 expected iterations: median ≈ 0.3 s emulated, C-106)'),
 ('pow_max_multiplier',         '8',        true, 'Upper bound of the adaptive difficulty multiplier'),
 ('multiplicity_thresholds',    '{"exact_ip":{"datacenter":3,"vpn":4,"tor":3,"eyeball_fixed":6,"eyeball_mobile":40,"unknown":6},"subnet":{"datacenter":6,"vpn":8,"tor":6,"eyeball_fixed":24,"eyeball_mobile":160,"unknown":24}}',
                                            true, 'Distinct surrogates per 10-min window before the high bucket (ADR-0008 L6, C-38, wire-formats §b.4); relay exempt'),
 ('multiplicity_event_thresholds', '{"exact_ip":{"datacenter":30,"vpn":40,"tor":30,"eyeball_fixed":60,"eyeball_mobile":400,"unknown":60},"subnet":{"datacenter":60,"vpn":80,"tor":60,"eyeball_fixed":240,"eyeball_mobile":1600,"unknown":240}}',
                                            true, 'Page loads per 10-min window before the high bucket on sites with visitor_id = off (C-80b, wire-formats §b.4); initial values, calibrated in the load tests'),
 ('trust_weights',              '{"proof_coverage":25,"network_quality":15,"multiplicity":15,"engagement":15,"mix":10,"temporal":10,"pow_latency":5,"cross_signal":5}',
                                            true, 'Trust score component weights (ADR-0028, C-44)'),
 ('trust_algorithm_version',    '"trust/1.0.0"', true, 'Version stamped on web_trust_scores rows'),
 ('public_metrics_window_days', '30',       true, 'metrics_endpoint window (ADR-0032)');

CREATE FUNCTION scf.setting_int(p_key text) RETURNS integer LANGUAGE sql STABLE
  AS $$ SELECT (s.value #>> '{}')::integer FROM scf.settings s WHERE s.key = p_key $$;

-- k-threshold + rounding for web breakdown rows (ADR-0027, C-95: the only counts it applies to).
CREATE FUNCTION scf.op_count(x bigint) RETURNS bigint LANGUAGE sql STABLE
  AS $$
  SELECT CASE WHEN x IS NULL OR x < scf.setting_int('op_min_count') THEN NULL
              ELSE (round(x::numeric / scf.setting_int('op_round_to')) * scf.setting_int('op_round_to'))::bigint END
  $$;

ALTER TABLE scf.settings ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.settings FORCE ROW LEVEL SECURITY;
GRANT SELECT ON scf.settings TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer;
GRANT UPDATE (value, updated_at, updated_by) ON scf.settings TO scf_app;
CREATE POLICY settings_read ON scf.settings FOR SELECT
  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer USING (true);
-- C-114: FORCE applies to the owner too; later migrations add and correct settings as scf_migrator.
CREATE POLICY migrator_seed ON scf.settings FOR ALL TO scf_migrator USING (true) WITH CHECK (true);
CREATE POLICY settings_write ON scf.settings FOR UPDATE TO scf_app
  USING ((SELECT scf.platform_role()) = 'operator_admin' AND (SELECT scf.audited_in_tx()))
  WITH CHECK ((SELECT scf.platform_role()) = 'operator_admin' AND (SELECT scf.audited_in_tx()));
GRANT EXECUTE ON FUNCTION scf.setting_int(text), scf.op_count(bigint)
  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer;
