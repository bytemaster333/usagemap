-- Source: docs/data-model.md, block '-- migration: 0056_erasure_queue_sweeps' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0056_erasure_queue_sweeps
-- C-119: scf.job_queue('erasure') also returns
--   - completed requests whose edge-spool sweep is due (result.spool_sweep.due_at ≤ now(), no done_at, selector not
--     yet redacted), so the sweep survives a control-plane restart instead of living only in process memory;
--   - running requests whose run started more than an hour ago (a crashed worker's request is claimed again; the
--     job's steps are idempotent).
-- A due_at that is not a valid timestamp never matches (and never breaks the queue). Same signature and owner.
CREATE INDEX erasure_requests_sweep ON scf.erasure_requests (created_at)
  WHERE status = 'completed' AND selector_redacted_at IS NULL;

GRANT CREATE ON SCHEMA scf TO scf_definer;   -- CREATE OR REPLACE checks it; revoked below
SET LOCAL ROLE scf_definer;
CREATE OR REPLACE FUNCTION scf.job_queue(p_job text) RETURNS TABLE (tenant_id uuid, item_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF NULLIF(current_setting('app.job', true), '') IS DISTINCT FROM p_job OR scf.current_tenant() IS NOT NULL THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    IF p_job = 'erasure' THEN
      RETURN QUERY SELECT e.tenant_id, e.request_id FROM scf.erasure_requests e
                    WHERE e.status IN ('previewing', 'confirmed')
                       OR (e.status = 'running' AND e.started_at < now() - interval '1 hour')
                       OR (e.status = 'completed' AND e.selector_redacted_at IS NULL
                           AND e.result -> 'spool_sweep' ->> 'done_at' IS NULL
                           AND CASE WHEN pg_input_is_valid(e.result -> 'spool_sweep' ->> 'due_at', 'timestamptz')
                                    THEN (e.result -> 'spool_sweep' ->> 'due_at')::timestamptz <= now()
                                    ELSE false END)
                    ORDER BY e.created_at LIMIT 100;
    ELSIF p_job = 'tenant_purge' THEN
      RETURN QUERY SELECT t.tenant_id, t.tenant_id FROM scf.tenants t
                    WHERE t.status = 'removed' AND t.purged_at IS NULL AND t.purge_after <= now()
                    ORDER BY t.purge_after LIMIT 100;
    ELSE
      RAISE EXCEPTION 'no queue for job %', p_job USING ERRCODE = '22023';
    END IF;
  END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;
