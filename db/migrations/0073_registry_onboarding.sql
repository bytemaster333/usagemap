-- Source: docs/data-model.md, block '-- migration: 0073_registry_onboarding' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0073_registry_onboarding
-- Onboarding of SCF-awarded projects from the public registry (2026-11-19, "find your SCF project"; RFP §4, §5).
-- (1) scf.registry_claimants(p_registry_project): how many tenants already claim a registry project — a confirmed
--     registry link, or a verified host (host_claims) equal to, or a subdomain of, one of the project's registrable
--     domains. Signed-in users only (actor kind `user`); answers a number for a public registry row and names no tenant.
--     The control plane subtracts the caller's own claims (read in the caller's tenant contexts) to show "already
--     claimed — dispute" before a second tenant is created for the same project. A claim never grants trust: trust
--     still comes only from the verification ladder (C-19, C-20).
-- (2) scf.op_registry_coverage(p_measuring_days): per registry project, the tenants enrolled for it (a declared domain,
--     verified or not, on one of its registrable domains, or any registry link), verified for it (a confirmed link or
--     a verified domain on it) and measuring (verified, with web page views or API data in the last p_measuring_days
--     UTC days). Rows only for projects with at least one enrolled tenant. Audited (`operator.read.op_registry_coverage`),
--     scope registry:read, like op_projects. Canary tenants and removed or purged tenants are never counted.
GRANT SELECT ON scf.registry_projects, scf.tenant_registry_links TO scf_definer;
CREATE POLICY definer_select ON scf.registry_projects FOR SELECT TO scf_definer USING (true);
CREATE POLICY definer_select ON scf.tenant_registry_links FOR SELECT TO scf_definer USING (true);

CREATE FUNCTION scf.registry_claimants(p_registry_project uuid) RETURNS integer
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_n integer;
  BEGIN
    IF scf.actor_kind() <> 'user' OR scf.current_actor_user() IS NULL THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    SELECT count(DISTINCT c.tenant_id)::integer INTO v_n
      FROM (SELECT l.tenant_id FROM scf.tenant_registry_links l
             WHERE l.registry_project_id = p_registry_project AND l.status = 'confirmed'
            UNION
            SELECT h.tenant_id FROM scf.host_claims h
              JOIN scf.registry_projects p ON p.registry_project_id = p_registry_project
             WHERE EXISTS (SELECT 1 FROM unnest(p.registrable_domains) d(dom)
                            WHERE h.host = d.dom OR right(h.host, char_length(d.dom) + 1) = '.' || d.dom)) c;
    RETURN v_n;
  END $$;
REVOKE ALL ON FUNCTION scf.registry_claimants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.registry_claimants(uuid) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.registry_claimants(uuid) OWNER TO scf_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('operator.read.op_registry_coverage', 'op_* read', '{scf_op_definer}');

CREATE FUNCTION scf.op_registry_coverage(p_measuring_days integer DEFAULT 7)
  RETURNS TABLE (registry_project_id uuid, tenants_enrolled integer, tenants_verified integer,
                 tenants_measuring integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE d0 date;
  BEGIN
    PERFORM scf.op_authorize('registry:read');                -- C-114: first
    IF p_measuring_days IS NULL OR p_measuring_days NOT BETWEEN 1 AND 90 THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    PERFORM scf.op_begin('operator.read.op_registry_coverage', 'registry:read', NULL,
                         jsonb_build_object('measuring_days', p_measuring_days));
    d0 := (now() AT TIME ZONE 'UTC')::date - p_measuring_days;
    RETURN QUERY
      WITH t AS (
        SELECT x.tenant_id FROM scf.tenants x
         WHERE x.status IN ('pending', 'active', 'suspended') AND x.purged_at IS NULL AND NOT x.is_canary),
      dom AS (                                                -- tenant × project through a declared domain
        SELECT p.registry_project_id AS rp, d.tenant_id, bool_or(d.state = 'verified') AS verified
          FROM scf.registry_projects p
          CROSS JOIN LATERAL unnest(p.registrable_domains) r(dom)
          JOIN scf.site_domains d ON d.host = r.dom OR right(d.host, char_length(r.dom) + 1) = '.' || r.dom
          JOIN scf.sites s ON s.tenant_id = d.tenant_id AND s.site_id = d.site_id AND s.status = 'active'
          JOIN t ON t.tenant_id = d.tenant_id
         WHERE p.missing_since IS NULL
         GROUP BY p.registry_project_id, d.tenant_id),
      lnk AS (
        SELECT l.registry_project_id AS rp, l.tenant_id, bool_or(l.status = 'confirmed') AS verified
          FROM scf.tenant_registry_links l JOIN t ON t.tenant_id = l.tenant_id
         WHERE l.status <> 'rejected'
         GROUP BY l.registry_project_id, l.tenant_id),
      e AS (
        SELECT u.rp, u.tenant_id, bool_or(u.verified) AS verified
          FROM (SELECT rp, tenant_id, verified FROM dom UNION ALL SELECT rp, tenant_id, verified FROM lnk) u
         GROUP BY u.rp, u.tenant_id),
      active AS (
        SELECT w.tenant_id FROM scf.web_daily_totals w
         WHERE w.day >= d0 AND w.pageviews_raw > 0 AND w.tenant_id IN (SELECT e.tenant_id FROM e WHERE e.verified)
        UNION
        SELECT a.tenant_id FROM scf.api_metrics_1d a
         WHERE a.bucket_start >= d0::timestamp AT TIME ZONE 'UTC'
           AND a.tenant_id IN (SELECT e.tenant_id FROM e WHERE e.verified))
      SELECT e.rp, count(*)::integer, (count(*) FILTER (WHERE e.verified))::integer,
             (count(*) FILTER (WHERE e.verified AND e.tenant_id IN (SELECT tenant_id FROM active)))::integer
        FROM e
       GROUP BY e.rp
       ORDER BY e.rp;
  END $$;
REVOKE ALL ON FUNCTION scf.op_registry_coverage(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_registry_coverage(integer) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_registry_coverage(integer) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
