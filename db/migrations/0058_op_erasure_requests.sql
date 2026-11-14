-- Source: docs/data-model.md, block '-- migration: 0058_op_erasure_requests' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0058_op_erasure_requests
-- The SCF-operator list of erasure requests (operation operatorListErasureRequests): status, tenant, dates, scope,
-- range and the selector TYPE — never the literal selector (C-88) — and the counts of the preview or the result.
-- Audited `operator.read.op_erasure_requests` (one row per call); console only (actor_kind operator, no machine keys).
INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('operator.read.op_erasure_requests', 'op_* read: erasure requests (no selectors)', '{scf_op_definer}');

CREATE FUNCTION scf.op_erasure_requests(p_start timestamptz, p_end timestamptz, p_tenant uuid DEFAULT NULL,
                                        p_status scf.erasure_status[] DEFAULT NULL)
  RETURNS TABLE (tenant_id uuid, slug text, request_id uuid, scope text, site_id uuid, service_id uuid,
                 range_start timestamptz, range_end timestamptz, selector_type text, status scf.erasure_status,
                 created_at timestamptz, previewed_at timestamptz, confirmed_at timestamptz, started_at timestamptz,
                 completed_at timestamptz, finished_at timestamptz, failure_code text, selector_redacted boolean,
                 counts jsonb)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    PERFORM scf.op_authorize(NULL);                         -- C-114: first; console only (no machine-key scope)
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '3660 days' THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    PERFORM scf.op_begin('operator.read.op_erasure_requests', NULL,
                         CASE WHEN p_tenant IS NULL THEN NULL ELSE ARRAY[p_tenant] END,
                         jsonb_build_object('start', p_start, 'end', p_end, 'tenant', p_tenant, 'status', p_status));
    RETURN QUERY
      SELECT e.tenant_id, t.slug, e.request_id, e.scope, e.site_id, e.service_id,
             (e.criteria ->> 'start')::timestamptz, (e.criteria ->> 'end')::timestamptz,
             COALESCE(e.criteria -> 'selector' ->> 'type',
                      CASE WHEN e.criteria ->> 'path_pattern' IS NOT NULL THEN 'path_pattern'
                           WHEN e.criteria ->> 'event_name' IS NOT NULL THEN 'event_name'
                           WHEN e.criteria ->> 'property_key' IS NOT NULL THEN 'property_key' END),
             e.status, e.created_at, e.previewed_at, e.confirmed_at, e.started_at, e.completed_at, e.finished_at,
             e.failure_code, e.selector_redacted_at IS NOT NULL,
             -- counts only: the result's spool_sweep and aggregate_days stay out
             (COALESCE(e.result, e.preview, '{}'::jsonb) - 'spool_sweep' - 'aggregate_days')
        FROM scf.erasure_requests e JOIN scf.tenants t ON t.tenant_id = e.tenant_id
       WHERE e.created_at >= p_start AND e.created_at < p_end
         AND (p_tenant IS NULL OR e.tenant_id = p_tenant)
         AND (p_status IS NULL OR e.status = ANY (p_status))
       ORDER BY e.created_at DESC, e.request_id;
  END $$;
REVOKE ALL ON FUNCTION scf.op_erasure_requests(timestamptz, timestamptz, uuid, scf.erasure_status[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_erasure_requests(timestamptz, timestamptz, uuid, scf.erasure_status[]) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_erasure_requests(timestamptz, timestamptz, uuid, scf.erasure_status[]) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
