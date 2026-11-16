-- Source: docs/data-model.md, block '-- migration: 0070_settings_floor_audit_dev_events' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0070_settings_floor_audit_dev_events
-- Wave C1 follow-ups of the control plane (audit 2026-11-18 control-plane-portal findings 4, 8, 12, 14, 17; OPS-17).
-- (1) Finding 4: the control plane lapses a removed domain's evidence itself and audits it in the same transaction.
UPDATE scf.audit_actions SET writers = writers || 'scf_app'::text
 WHERE action = 'verification.evidence_lapsed' AND NOT 'scf_app' = ANY (writers);

-- (2) OPS-17: platform read-only mode. `enabled` refuses writes except data-subject rights, removals and revocations;
--     `ingest` accept | pause. Changed by an operator_admin with step-up (operatorUpdateSetting).
INSERT INTO scf.settings (key, value, public, description) VALUES
 ('read_only_mode', '{"enabled":false,"ingest":"accept"}', true,
  'Platform read-only mode (OPS-17): enabled refuses writes except data-subject rights, removals and revocations; ingest accept | pause');
ALTER TABLE scf.settings ADD CONSTRAINT settings_read_only_mode
  CHECK (key <> 'read_only_mode' OR COALESCE(jsonb_typeof(value) = 'object' AND jsonb_typeof(value -> 'enabled') = 'boolean'
                                              AND value ->> 'ingest' IN ('accept', 'pause')
                                              AND value - 'enabled' - 'ingest' = '{}'::jsonb, false));

-- (3) The metrics writer's stream-state caps (audit 2026-11-18 api-pipeline), tunable like the other quotas.
INSERT INTO scf.settings (key, value, public, description) VALUES
 ('stream_state_cap_per_tenant', '250000', true, 'Cumulative-stream state rows (api_stream_state) a tenant may hold at L1+; new streams beyond it keep no state (route_overflow)'),
 ('l0_stream_state_cap',         '10000',  true, 'As stream_state_cap_per_tenant, at L0 (C-19)');

-- (4) Finding 12: every integer setting holds a JSON integer (scf.setting_int() would otherwise fail every reader
--     with 22P02); the privacy floor stays in a sane range (ADR-0027, C-51, C-95): op_min_count / tenant_min_count
--     5–1000 (0 would switch suppression off), op_round_to / tenant_round_to 1–100 (0 divides by zero).
ALTER TABLE scf.settings ADD CONSTRAINT settings_integer
  CHECK (key NOT IN ('op_min_count', 'op_round_to', 'tenant_min_count', 'tenant_round_to', 'ecosystem_percentile_min_tenants',
                     'web_breakdown_top_n', 'web_event_retention_days', 'web_live_events_budget', 'web_live_window_max_days',
                     'l0_max_sites', 'l0_max_services', 'l0_events_per_day', 'l0_routes_per_day', 'l1_events_per_day',
                     'l0_web_requests_per_min_site', 'web_requests_per_min_site', 'web_requests_per_min_subnet',
                     'max_services_per_tenant', 'max_active_ingest_tokens', 'max_tenants_per_user',
                     'route_cap_per_service_day', 'route_cap_per_tenant_day', 'route_sibling_cap', 'otlp_requests_per_s',
                     'otlp_burst', 'otlp_bytes_per_s', 'op_key_requests_per_min', 'web_events_per_token', 'pow_cost',
                     'pow_max', 'pow_max_multiplier', 'public_metrics_window_days', 'dev_events_per_min_site',
                     'dev_event_buffer_size', 'cohort_min_tenants', 'stream_state_cap_per_tenant', 'l0_stream_state_cap')
         OR (jsonb_typeof(value) = 'number' AND value::text ~ '^[0-9]{1,9}$'));
ALTER TABLE scf.settings ADD CONSTRAINT settings_privacy_floor
  CHECK (key NOT IN ('op_min_count', 'op_round_to', 'tenant_min_count', 'tenant_round_to')
         OR CASE WHEN jsonb_typeof(value) = 'number' AND value::text ~ '^[0-9]{1,9}$' THEN
                   CASE WHEN key IN ('op_min_count', 'tenant_min_count') THEN value::text::int BETWEEN 5 AND 1000
                        ELSE value::text::int BETWEEN 1 AND 100 END
                 ELSE false END);

-- (5) Findings 8 and 14: breakdown rows (C-95, ADR-0027) apply the small-count floor per UTC DAY before summing. A
--     row's visitors are daily uniques, so a range sum counts visitor-days: one person seen on k days would reach k
--     alone. A value's day counts only when that day's COALESCE(visitors, events) is at least k; the kept days are
--     then summed, floored and rounded as before. One person adds at most one visitor per site and day, so a value
--     needs k visitors on one day to appear, and differencing two windows reveals only days that passed the floor.
--     Same signature, owner, grants and audit row.
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- CREATE OR REPLACE checks it; revoked below
SET LOCAL ROLE scf_op_definer;
CREATE OR REPLACE FUNCTION scf.op_web_breakdown(p_start timestamptz, p_end timestamptz, p_dimension scf.web_dimension,
                                     p_variant scf.web_variant DEFAULT 'verified', p_tenants uuid[] DEFAULT NULL,
                                     p_min_level smallint DEFAULT 1, p_limit int DEFAULT 50, p_group text DEFAULT 'tenant')
  RETURNS TABLE (tenant_id uuid, value text, visitors_sum bigint, pageviews bigint, events bigint, suppressed boolean,
                 slug text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; k int := scf.setting_int('op_min_count'); d0 date; d1 date;
  BEGIN
    IF p_limit NOT BETWEEN 1 AND 200 OR p_group NOT IN ('tenant', 'all') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end) r;
    v_t := scf.op_begin('operator.read.op_web_breakdown', 'web:read', p_tenants,
             jsonb_build_object('start', p_start, 'end', p_end, 'dimension', p_dimension, 'variant', p_variant,
                                'group', p_group, 'tenants', p_tenants));
    RETURN QUERY
      WITH dd AS (
        SELECT CASE WHEN p_group = 'tenant' THEN x.tenant_id END AS tenant_id, x.value AS value, x.day AS day,
               sum(x.visitors)::bigint AS vis, sum(x.pageviews)::bigint AS pv, sum(x.events)::bigint AS ev
          FROM scf.web_daily_breakdowns x
          JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = x.tenant_id
         WHERE x.variant = p_variant AND x.dimension = p_dimension AND x.day >= d0 AND x.day < d1
         GROUP BY 1, 2, 3),
      b AS (
        SELECT dd.tenant_id, dd.value, sum(dd.vis)::bigint AS vis, sum(dd.pv)::bigint AS pv, sum(dd.ev)::bigint AS ev
          FROM dd WHERE COALESCE(dd.vis, dd.ev) >= k
         GROUP BY 1, 2),
      r AS (
        SELECT b.*, row_number() OVER (PARTITION BY b.tenant_id
                                       ORDER BY COALESCE(b.vis, b.ev) DESC NULLS LAST, b.value) AS rn
          FROM b)
      SELECT r.tenant_id, r.value, scf.op_count(r.vis), scf.op_count(r.pv), scf.op_count(r.ev), false,
             (SELECT t.slug FROM scf.tenants t WHERE t.tenant_id = r.tenant_id)
        FROM r WHERE r.rn <= p_limit AND COALESCE(r.vis, r.ev) >= k
       ORDER BY r.tenant_id, r.rn;
  END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;

-- (6) Finding 17: job erasure also removes the dev-event buffer's rows that match a path or event-name selector
--     (normalised path class and event name kept up to 24 hours, §8.9), under the requesting tenant's context.
DROP POLICY jobs_select ON scf.web_dev_events;
CREATE POLICY jobs_select ON scf.web_dev_events FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['retention','tenant_purge','erasure']::text[]));
DROP POLICY jobs_delete ON scf.web_dev_events;
CREATE POLICY jobs_delete ON scf.web_dev_events FOR DELETE TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['retention','tenant_purge','erasure']::text[]));
