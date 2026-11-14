-- Source: docs/data-model.md, block '-- migration: 0059_dispute_not_found_public_metrics_api' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0059_dispute_not_found_public_metrics_api
-- (1) op_resolve_domain_dispute: a domain that is not disputed (unknown, foreign, or already resolved) raises
--     P0002 ('not found') instead of succeeding silently; the audit row of the call is rolled back with it. Same
--     signature, owner and grants.
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- CREATE OR REPLACE checks it; revoked below
SET LOCAL ROLE scf_op_definer;
CREATE OR REPLACE FUNCTION scf.op_resolve_domain_dispute(p_tenant uuid, p_domain uuid, p_decision text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    PERFORM scf.op_authorize(NULL, true);                   -- C-114
    IF p_decision NOT IN ('keep', 'release') THEN RAISE EXCEPTION 'invalid decision' USING ERRCODE = '22023'; END IF;
    PERFORM scf.op_begin('domain.dispute_resolved', NULL, ARRAY[p_tenant],
                         jsonb_build_object('domain_id', p_domain, 'decision', p_decision), true);
    UPDATE scf.site_domains SET state = CASE p_decision WHEN 'keep' THEN 'verified' ELSE 'unverified' END,
           verified_at = CASE p_decision WHEN 'keep' THEN verified_at END
     WHERE tenant_id = p_tenant AND domain_id = p_domain AND state = 'disputed';
    IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;

-- (2) Job public_metrics (§6.3, metrics_endpoint): the API half of the document reads the preferred-group views
--     (security_invoker), which need the stream-group tables for the preference. The rows themselves stay limited
--     by the base tables' jobs policies (api_metrics_1d lists public_metrics; 1h/1m do not).
GRANT SELECT ON scf.api_metrics_1m_pref, scf.api_metrics_1h_pref, scf.api_metrics_1d_pref TO scf_jobs;
DROP POLICY jobs_select ON scf.api_stream_groups;
CREATE POLICY jobs_select ON scf.api_stream_groups FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['trust_scoring','tenant_purge','public_metrics']::text[]));
DROP POLICY jobs_select ON scf.api_service_day_groups;
CREATE POLICY jobs_select ON scf.api_service_day_groups FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['trust_scoring','tenant_purge','public_metrics']::text[]));
