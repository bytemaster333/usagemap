-- Source: docs/data-model.md, block '-- migration: 0050_retention' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0050_retention
-- the retention table of §14 in machine-
-- readable form, plus two INVOKER helpers for job `retention` / `stream_gc`. They add no privilege: they run as the
-- calling role (scf_jobs) under its RLS policies, only for the job that §6.3/§14 names, and — for tenant tables —
-- only under the target tenant's context (F1, C-103: every DELETE needs the row's tenant context anyway).
-- Partition drops stay with scf.drop_expired_partitions() (§10); Umami pruning stays with the jobs service (§16.2).

-- One row per stored relation with a retention period. age_expr is evaluated on the row (alias t) and yields the
-- moment from which the row ages (NULL = never expires); a row goes when age_expr < now() - keep.
CREATE FUNCTION scf.retention_rules()
  RETURNS TABLE (relname text, tenant_scoped boolean, keep interval, age_expr text, mechanism text, job text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ VALUES
    ('api_metrics_1m',        true,  interval '35 days',   'bucket_start',                          'partition_drop', 'partitions'),
    ('api_metrics_1h',        true,  interval '25 months', 'bucket_start',                          'partition_drop', 'partitions'),
    ('web_hourly_totals',     true,  interval '25 months', 'hour_start',                            'partition_drop', 'partitions'),
    ('api_ingest_ledger',     true,  interval '7 days',    't.received_at',                         'delete', 'retention'),
    ('api_ingest_counters',   true,  interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('web_edge_counters',     true,  interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
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

-- Deletes up to p_limit expired rows of one relation of retention_rules() (mechanism 'delete'); returns the count.
-- Caller: scf_jobs with app.job = the rule's job; for a tenant-scoped relation inside that tenant's context.
CREATE FUNCTION scf.retention_apply(p_relname text, p_limit integer DEFAULT 10000) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE r record; v_n bigint;
  BEGIN
    SELECT * INTO r FROM scf.retention_rules() x WHERE x.relname = p_relname AND x.mechanism = 'delete';
    IF NOT FOUND OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    IF scf.current_job() IS DISTINCT FROM r.job THEN
      RAISE EXCEPTION 'job % required', r.job USING ERRCODE = '42501';
    END IF;
    IF r.tenant_scoped AND scf.current_tenant() IS NULL THEN
      RAISE EXCEPTION 'tenant context required for %', p_relname USING ERRCODE = '42501';
    END IF;
    EXECUTE format('DELETE FROM scf.%1$I WHERE ctid = ANY (ARRAY(SELECT t.ctid FROM scf.%1$I t WHERE %2$s (%3$s) < now() - $1 LIMIT $2))',
                   r.relname, CASE WHEN r.tenant_scoped THEN 't.tenant_id = scf.current_tenant() AND' ELSE '' END, r.age_expr)
      USING r.keep, p_limit;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
  END $$;

-- C-88: replaces the literal selector of finished erasure requests older than 56 days by its type and length, sets
-- selector_redacted_at and writes one audit row 'erasure.selector_redacted' per request (never the literal).
-- Caller: scf_jobs, app.job = retention, inside the tenant's context. Returns the number of requests redacted.
CREATE FUNCTION scf.erasure_redact_selectors(p_limit integer DEFAULT 1000) RETURNS integer
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE e record; v_type text; v_sel jsonb; v_n integer := 0;
  BEGIN
    IF scf.current_job() IS DISTINCT FROM 'retention' OR scf.current_tenant() IS NULL THEN
      RAISE EXCEPTION 'job retention with a tenant context required' USING ERRCODE = '42501';
    END IF;
    FOR e IN SELECT x.tenant_id, x.request_id, x.scope, x.criteria FROM scf.erasure_requests x
              WHERE x.tenant_id = scf.current_tenant() AND x.selector_redacted_at IS NULL
                AND x.finished_at < now() - interval '56 days'
              ORDER BY x.finished_at LIMIT p_limit FOR UPDATE
    LOOP
      v_type := CASE WHEN e.criteria ->> 'path_pattern' IS NOT NULL THEN 'path_pattern'
                     WHEN e.criteria ->> 'event_name'   IS NOT NULL THEN 'event_name'
                     WHEN e.criteria ->> 'property_key' IS NOT NULL THEN 'property_key' END;
      v_sel := CASE WHEN v_type IS NULL THEN 'null'::jsonb
                    ELSE jsonb_build_object('type', v_type, 'length', char_length(e.criteria ->> v_type)) END;
      UPDATE scf.erasure_requests
         SET criteria = (criteria - 'path_pattern' - 'event_name' - 'property_key') || jsonb_build_object('selector', v_sel),
             selector_redacted_at = now()
       WHERE tenant_id = e.tenant_id AND request_id = e.request_id;
      INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, details, request_id)
      VALUES (e.tenant_id, scf.actor_kind(), scf.current_actor(), 'erasure.selector_redacted', 'erasure_request',
              e.request_id::text, jsonb_build_object('request_id', e.request_id, 'scope', e.scope, 'selector_type', v_type),
              NULLIF(current_setting('app.request_id', true), ''));
      v_n := v_n + 1;
    END LOOP;
    RETURN v_n;
  END $$;

REVOKE ALL ON FUNCTION scf.retention_rules(), scf.retention_apply(text, integer), scf.erasure_redact_selectors(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.retention_rules(), scf.retention_apply(text, integer), scf.erasure_redact_selectors(integer)
  TO scf_jobs;
