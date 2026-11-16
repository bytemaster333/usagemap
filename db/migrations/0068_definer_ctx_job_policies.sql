-- Source: docs/data-model.md, block '-- migration: 0068_definer_ctx_job_policies' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0068_definer_ctx_job_policies
-- Wave C1 (audit 2026-11-18, database-isolation findings 5 and 6).
-- (1) Finding 5: the tenant-acting definer functions refuse what RLS refuses (C-17): a tenant set together with an
--     SCF-operator, machine-key or anonymous actor (scf.tenant_ctx_ok() false) is not that tenant's context. Same
--     signatures, owner, grants and results otherwise. (claim_host gets the same check in 0069, which also changes
--     what it does with a disputed host.)
GRANT CREATE ON SCHEMA scf TO scf_definer;   -- CREATE OR REPLACE checks it; revoked below
SET LOCAL ROLE scf_definer;
CREATE OR REPLACE FUNCTION scf.release_host(p_host text, p_tenant uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF scf.current_tenant() IS DISTINCT FROM p_tenant OR NOT scf.tenant_ctx_ok() THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    DELETE FROM scf.host_claims WHERE host = p_host AND tenant_id = p_tenant;
  END $$;
CREATE OR REPLACE FUNCTION scf.release_domain_claim(p_tenant uuid, p_domain uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_host text; v_next uuid;
  BEGIN
    IF scf.current_tenant() IS DISTINCT FROM p_tenant OR NOT scf.tenant_ctx_ok() THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    SELECT h.host INTO v_host FROM scf.host_claims h WHERE h.tenant_id = p_tenant AND h.domain_id = p_domain FOR UPDATE;
    IF NOT FOUND THEN RETURN 'none'; END IF;
    SELECT d.domain_id INTO v_next FROM scf.site_domains d
     WHERE d.tenant_id = p_tenant AND d.host = v_host AND d.domain_id <> p_domain
     ORDER BY (d.state = 'verified') DESC, d.created_at, d.domain_id LIMIT 1;
    IF FOUND THEN
      UPDATE scf.host_claims SET domain_id = v_next WHERE host = v_host;
      RETURN 'moved';
    END IF;
    DELETE FROM scf.host_claims WHERE host = v_host;
    RETURN 'released';
  END $$;
CREATE OR REPLACE FUNCTION scf.write_removal_tombstones(p_tenant uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_reason text; v_n integer;
  BEGIN
    IF p_tenant IS NULL OR scf.current_tenant() IS DISTINCT FROM p_tenant OR NOT scf.tenant_ctx_ok() THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    SELECT left(t.status_reason, 500) INTO v_reason FROM scf.tenants t
     WHERE t.tenant_id = p_tenant AND t.status = 'removed' AND t.purged_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'tenant not removed' USING ERRCODE = '55000'; END IF;
    INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id, reason)
      SELECT s.kind, s.subject, p_tenant, v_reason
        FROM (SELECT 'host'::text AS kind, d.host AS subject FROM scf.site_domains d
               WHERE d.tenant_id = p_tenant AND d.state = 'verified'
              UNION
              SELECT 'github_user', x.subject FROM scf.memberships m
                JOIN scf.external_identities x ON x.user_id = m.user_id AND x.provider = 'github'
               WHERE m.tenant_id = p_tenant AND m.role = 'owner'
              UNION
              SELECT 'stellar_account', v.subject FROM scf.verification_evidence v
               WHERE v.tenant_id = p_tenant AND v.kind = 'stellar_account' AND v.status = 'valid') s
       WHERE NOT EXISTS (SELECT 1 FROM scf.enrollment_tombstones z
                          WHERE z.kind = s.kind AND z.subject = s.subject
                            AND (z.tenant_id = p_tenant OR z.lifted_at IS NULL));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
  END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;

-- (2) Finding 6: the job policies of the global tables are per command, so no reader job gets a write it does not
--     need (§6.3): only retention deletes registry projects and sync runs, spool accounting and durability reports;
--     edge_snapshot keeps deleting the snapshots it supersedes (and retention the stale ones).
DROP POLICY jobs_sync ON scf.registry_projects;
CREATE POLICY jobs_select ON scf.registry_projects FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['registry_sync','trust_scoring','retention']::text[]));
CREATE POLICY jobs_insert ON scf.registry_projects FOR INSERT TO scf_jobs
  WITH CHECK ((SELECT scf.current_job()) = 'registry_sync');
CREATE POLICY jobs_update ON scf.registry_projects FOR UPDATE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'registry_sync') WITH CHECK ((SELECT scf.current_job()) = 'registry_sync');
CREATE POLICY jobs_delete ON scf.registry_projects FOR DELETE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'retention');

DROP POLICY jobs_sync ON scf.registry_sync_runs;
CREATE POLICY jobs_select ON scf.registry_sync_runs FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['registry_sync','retention']::text[]));
CREATE POLICY jobs_insert ON scf.registry_sync_runs FOR INSERT TO scf_jobs
  WITH CHECK ((SELECT scf.current_job()) = 'registry_sync');
CREATE POLICY jobs_update ON scf.registry_sync_runs FOR UPDATE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'registry_sync') WITH CHECK ((SELECT scf.current_job()) = 'registry_sync');
CREATE POLICY jobs_delete ON scf.registry_sync_runs FOR DELETE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'retention');

DROP POLICY jobs_build ON scf.edge_snapshots;
CREATE POLICY jobs_select ON scf.edge_snapshots FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['edge_snapshot','retention']::text[]));
CREATE POLICY jobs_insert ON scf.edge_snapshots FOR INSERT TO scf_jobs
  WITH CHECK ((SELECT scf.current_job()) = 'edge_snapshot');
CREATE POLICY jobs_delete ON scf.edge_snapshots FOR DELETE TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['edge_snapshot','retention']::text[]));

DROP POLICY jobs_read ON scf.edge_spool_accounting;
CREATE POLICY jobs_select ON scf.edge_spool_accounting FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['durability_reconcile','retention']::text[]));
CREATE POLICY jobs_delete ON scf.edge_spool_accounting FOR DELETE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'retention');

DROP POLICY jobs_write ON scf.durability_reports;
CREATE POLICY jobs_select ON scf.durability_reports FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['durability_reconcile','retention']::text[]));
CREATE POLICY jobs_insert ON scf.durability_reports FOR INSERT TO scf_jobs
  WITH CHECK ((SELECT scf.current_job()) = 'durability_reconcile');
CREATE POLICY jobs_update ON scf.durability_reports FOR UPDATE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'durability_reconcile') WITH CHECK ((SELECT scf.current_job()) = 'durability_reconcile');
CREATE POLICY jobs_delete ON scf.durability_reports FOR DELETE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'retention');
