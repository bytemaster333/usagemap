-- Source: docs/data-model.md, block '-- migration: 0057_trust_hourly_removal_tombstones' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0057_trust_hourly_removal_tombstones
-- (1) ADR-0028: the trust_scoring job reads web_hourly_totals (burstiness component). The partitions carry copies of
--     the parent's policies (scf_admin.secure_partition, gate G7), so every existing partition gets the new policy
--     too; partitions created later copy it from the parent.
DROP POLICY jobs_select ON scf.web_hourly_totals;
CREATE POLICY jobs_select ON scf.web_hourly_totals FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['web_rollup','tenant_purge','trust_scoring']::text[]));
DO $$
DECLARE p regclass; v_qual text;
BEGIN
  SELECT pg_catalog.pg_get_expr(q.polqual, q.polrelid) INTO STRICT v_qual FROM pg_catalog.pg_policy q
   WHERE q.polrelid = 'scf.web_hourly_totals'::regclass AND q.polname = 'jobs_select';
  FOR p IN SELECT h.inhrelid::regclass FROM pg_catalog.pg_inherits h WHERE h.inhparent = 'scf.web_hourly_totals'::regclass LOOP
    EXECUTE format('DROP POLICY IF EXISTS jobs_select ON %s', p);
    EXECUTE format('CREATE POLICY jobs_select ON %s FOR SELECT TO scf_jobs USING (%s)', p, v_qual);
  END LOOP;
END $$;

-- (2) C-64: an owner who removes their own tenant (UPDATE of tenants.status by scf_app, guarded by tenants_guard)
--     leaves the same tombstones as op_tenant_transition('remove'): verified hosts, the owners' GitHub ids and valid
--     Stellar accounts. scf_app cannot read other users' external identities nor write tombstones, so the control
--     plane calls this function in the removal transaction, after the UPDATE. Only under p_tenant's context and only
--     while the tenant is removed and not purged; idempotent (a tombstone of this tenant that an operator lifted stays
--     lifted; an active tombstone of another tenant for the same subject is enough). Returns the number written.
--     Writes no audit row (scf_definer never does): the caller's 'tenant.removed' row covers it.
GRANT SELECT (user_id, provider, subject) ON scf.external_identities TO scf_definer;
CREATE POLICY definer_select ON scf.external_identities FOR SELECT TO scf_definer USING (true);
GRANT SELECT ON scf.verification_evidence TO scf_definer;
CREATE POLICY definer_select ON scf.verification_evidence FOR SELECT TO scf_definer USING (true);

CREATE FUNCTION scf.write_removal_tombstones(p_tenant uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_reason text; v_n integer;
  BEGIN
    IF p_tenant IS NULL OR scf.current_tenant() IS DISTINCT FROM p_tenant THEN
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

-- C-114: grant, then owner.
REVOKE ALL ON FUNCTION scf.write_removal_tombstones(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.write_removal_tombstones(uuid) TO scf_app, scf_jobs;
GRANT CREATE ON SCHEMA scf TO scf_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.write_removal_tombstones(uuid) OWNER TO scf_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;

-- (3) Audit actions of the jobs service (WS-G): a declared contract that loses its on-chain proof
--     (contract_verification, C-19) and a tenant purge that failed and will be retried (tenant_purge, C-08/C-64;
--     written in its own transaction after the purge transaction rolled back).
INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('verification.contract_unverified', 'declared contract no longer proven on the ledger (C-19)', '{scf_jobs}'),
 ('tenant.purge_failed',              'tenant purge failed; retried on the next run (C-08)',      '{scf_jobs}');
