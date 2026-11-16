-- Source: docs/data-model.md, block '-- migration: 0072_product_improvements' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0072_product_improvements
-- Product improvements of 2026-11-19. (1) Secret-seed leak warning: the Collector counts API data points whose route held a
-- Stellar secret seed as api_ingest_counters reason `route_seed_redacted` (wire-formats §h.3; the seed itself is never
-- stored). The tenant portal shows "N secret seeds appeared in your API request paths since <date> — rotate those
-- keys" until a tenant admin acknowledges it. The acknowledgement stores when it happened and, per service, the UTC
-- day's count at that moment ({"<service_id>": n}), so seeds seen later on the same day still raise the warning again:
--   shown count per service = sum(count) over days after the ack day + max(0, its count of the ack day − baseline).
-- Written by the control plane (scf_app) under the tenant's context, audited as tenant.updated.
ALTER TABLE scf.tenants
  ADD COLUMN seed_warning_ack_at timestamptz,
  ADD COLUMN seed_warning_ack_baseline jsonb NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(seed_warning_ack_baseline) = 'object' AND pg_column_size(seed_warning_ack_baseline) <= 65536),
  ADD CONSTRAINT tenants_seed_warning_ack CHECK (seed_warning_ack_at IS NOT NULL OR seed_warning_ack_baseline = '{}');
GRANT UPDATE (seed_warning_ack_at, seed_warning_ack_baseline) ON scf.tenants TO scf_app;

-- (2) Filtered traffic on the public project card: job public_metrics reads the site verdict and
-- reason counters (web_edge_counters, data-model §8.9) under the tenant's context to publish the share of events not
-- counted and the reasons behind it; reason rows pass scf.op_count (k-threshold and rounding, C-95) in the document.
DROP POLICY jobs_select ON scf.web_edge_counters;
CREATE POLICY jobs_select ON scf.web_edge_counters FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['trust_scoring','edge_snapshot','retention','tenant_purge',
                                                 'public_metrics']::text[]));

-- (3) Per-service availability objective: the tenant API dashboard's SLO / error-budget card measures
-- the share of requests without a 5xx answer against this target (percent; default 99.5). Requests without a status
-- code are left out of the measure and shown as such. scf_app already holds UPDATE on scf.api_services (RLS).
ALTER TABLE scf.api_services
  ADD COLUMN slo_target_pct numeric(6,3) NOT NULL DEFAULT 99.5 CHECK (slo_target_pct BETWEEN 90 AND 99.999);
