-- Source: docs/data-model.md, block '-- migration: 0004_rls_helpers' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0004_rls_helpers
CREATE FUNCTION scf_admin.pred_clause(p_cmd text, p_using text, p_check text) RETURNS text LANGUAGE sql IMMUTABLE
  AS $$
  SELECT CASE upper(p_cmd)
           WHEN 'SELECT' THEN format('USING (%s)', p_using)
           WHEN 'DELETE' THEN format('USING (%s)', p_using)
           WHEN 'INSERT' THEN format('WITH CHECK (%s)', p_check)
           WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', p_using, p_check) END
  $$;

CREATE PROCEDURE scf_admin.apply_tenant_rls(
  p_table      regclass,
  p_app        text[] DEFAULT '{}',   -- scf_app commands under a tenant context
  p_writer     text[] DEFAULT '{}',   -- scf_writer commands under a tenant context
  p_op_definer text[] DEFAULT '{}',   -- commands available to op_* functions (owner scf_op_definer)
  p_jobs       jsonb  DEFAULT '{}'    -- {"SELECT":["job",…],"INSERT":[…],"UPDATE":[…],"DELETE":[…]}
) LANGUAGE plpgsql
  AS $$
  DECLARE
    t  text := p_table::text;
    tp constant text := 'tenant_id = (SELECT scf.current_tenant())';
    c  text; jp text; jobs text[];
  BEGIN
    IF (p_app && ARRAY['UPDATE','DELETE'] AND NOT 'SELECT' = ANY (p_app))
       OR (p_writer && ARRAY['UPDATE','DELETE'] AND NOT 'SELECT' = ANY (p_writer))
       OR ((p_jobs ? 'UPDATE' OR p_jobs ? 'DELETE') AND NOT p_jobs ? 'SELECT') THEN
      RAISE EXCEPTION '%: UPDATE/DELETE without SELECT', t;
    END IF;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_op_definer', t);
    EXECUTE format('CREATE POLICY tenant_backstop ON %s AS RESTRICTIVE FOR ALL '
                   'TO scf_app, scf_writer, scf_jobs, scf_metrics_ro '
                   'USING ((%s AND (SELECT scf.tenant_ctx_ok())) OR (SELECT scf.cross_tenant_read_ok())) '
                   'WITH CHECK (%s AND (SELECT scf.tenant_ctx_ok()))', t, tp, tp);
    -- F1 (C-103, S-03): DELETE has no WITH CHECK, so it needs its own restrictive policy without the cross-tenant branch.
    EXECUTE format('CREATE POLICY tenant_backstop_delete ON %s AS RESTRICTIVE FOR DELETE '
                   'TO scf_app, scf_writer, scf_jobs, scf_metrics_ro '
                   'USING (%s AND (SELECT scf.tenant_ctx_ok()))', t, tp);
    FOREACH c IN ARRAY p_app LOOP
      EXECUTE format('GRANT %s ON %s TO scf_app', c, t);
      EXECUTE format('CREATE POLICY %I ON %s FOR %s TO scf_app %s', 'app_' || lower(c), t, c,
                     scf_admin.pred_clause(c, tp, tp));
    END LOOP;
    FOREACH c IN ARRAY p_writer LOOP
      EXECUTE format('GRANT %s ON %s TO scf_writer', c, t);
      EXECUTE format('CREATE POLICY %I ON %s FOR %s TO scf_writer %s', 'writer_' || lower(c), t, c,
                     scf_admin.pred_clause(c, tp, tp));
    END LOOP;
    FOREACH c IN ARRAY p_op_definer LOOP
      EXECUTE format('GRANT %s ON %s TO scf_op_definer', c, t);
      EXECUTE format('CREATE POLICY %I ON %s FOR %s TO scf_op_definer %s', 'op_definer_' || lower(c), t, c,
                     scf_admin.pred_clause(c, 'true', 'true'));
    END LOOP;
    FOR c IN SELECT jsonb_object_keys(p_jobs) LOOP
      SELECT array_agg(quote_literal(x)) INTO jobs FROM jsonb_array_elements_text(p_jobs -> c) AS x;
      jp := format('(SELECT scf.current_job()) = ANY (ARRAY[%s]::text[])', array_to_string(jobs, ','));
      EXECUTE format('GRANT %s ON %s TO scf_jobs', c, t);
      EXECUTE format('CREATE POLICY %I ON %s FOR %s TO scf_jobs %s', 'jobs_' || lower(c), t, c,
                     scf_admin.pred_clause(c, jp, jp));
    END LOOP;
  END $$;
