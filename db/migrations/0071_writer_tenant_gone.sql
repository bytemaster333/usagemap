-- Source: docs/data-model.md, block '-- migration: 0071_writer_tenant_gone' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0071_writer_tenant_gone
-- Wave C1 (audit 2026-11-18 api-pipeline finding 7): the metrics writer asks, before writing, whether its tenant is
-- removed, purged or unknown, and drops the batch if so. scf_writer gets no SELECT on scf.tenants (its backstop would
-- also need scf.memberships); this definer answers for the context's own tenant only, under a writer context only.
CREATE FUNCTION scf.writer_tenant_gone() RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_status scf.tenant_status; v_purged timestamptz;
  BEGIN
    -- current_user is scf_definer here: read the GUCs set by scf.set_tenant_ctx() (EXECUTE: scf_writer only).
    IF NULLIF(current_setting('app.actor_kind', true), '') IS DISTINCT FROM 'writer' OR scf.current_tenant() IS NULL THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    SELECT t.status, t.purged_at INTO v_status, v_purged FROM scf.tenants t WHERE t.tenant_id = scf.current_tenant();
    RETURN NOT FOUND OR v_status = 'removed' OR v_purged IS NOT NULL;
  END $$;
REVOKE ALL ON FUNCTION scf.writer_tenant_gone() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.writer_tenant_gone() TO scf_writer;
GRANT CREATE ON SCHEMA scf TO scf_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.writer_tenant_gone() OWNER TO scf_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;
