-- Source: docs/data-model.md, block '-- migration: 0064_registry_cohorts' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0064_registry_cohorts
-- C-136 (plan C3, D-9): SCF categories, award round and award stage per registry project (set by registry_sync
-- from the source; slugs of the SCF labels, wire-formats §i.4) and the SCF-operator cohort read model
-- scf.op_cohorts(): web and on-chain figures per cohort, cohorts with fewer than cohort_min_tenants tenants suppressed,
-- every figure below op_min_count withheld (C-137). A statistical floor for comparisons, not a privacy boundary: the
-- same scope reads exact per-tenant totals through op_web_metrics (§11).
ALTER TABLE scf.registry_projects
  ADD COLUMN scf_categories text[] NOT NULL DEFAULT '{}'
    CHECK (scf_categories <@ ARRAY['end_user_application', 'financial_protocols', 'applications',
                                   'developer_tooling', 'infrastructure_services']),
  ADD COLUMN award_round smallint CHECK (award_round BETWEEN 1 AND 999),          -- round of the latest award
  ADD COLUMN award_stage text CHECK (award_stage IN ('t0_prelaunch', 't1_mvp', 't2_testnet', 't3_mainnet'));

INSERT INTO scf.settings (key, value, public, description) VALUES
 ('cohort_min_tenants', '5', true,
  'Minimum tenants a cohort (SCF round, category, award stage) needs before SCF operators see its figures (C-136)');
ALTER TABLE scf.settings ADD CONSTRAINT settings_cohort_min_tenants
  CHECK (key <> 'cohort_min_tenants' OR ((value #>> '{}')::int BETWEEN 2 AND 100));

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('operator.read.op_cohorts', 'op_* read', '{scf_op_definer}');

-- p_by: 'round' (registry_projects.award_round), 'category' (each of scf_categories), 'award_stage'.
-- Membership: eligible tenants (op_eligible_tenants: level >= p_min_level, canary never) with a confirmed registry
-- link; a tenant linked to several projects or categories counts once in each cohort it belongs to. Web figures from
-- web_daily_totals, on-chain figures from onchain_daily of verified contracts without an open footprint conflict
-- (declared_contracts.conflict_since, added by 0066; plpgsql resolves the column at call time). A cohort with fewer
-- than cohort_min_tenants tenants is returned with suppressed = true and every figure NULL (C-136). In a shown cohort
-- (C-137): a figure below op_min_count is NULL (small-count floor), and the on-chain figures are NULL unless at least
-- cohort_min_tenants of its tenants have on-chain data (tenants_with_onchain), so one project's figure never shows.
CREATE FUNCTION scf.op_cohorts(p_start timestamptz, p_end timestamptz, p_by text, p_min_level smallint DEFAULT 1)
  RETURNS TABLE (cohort text, tenant_count integer, pageviews_verified bigint, pageviews_raw bigint,
                 visitors_sum_verified bigint, tenants_with_onchain integer, onchain_invocations bigint,
                 onchain_successful_invocations bigint, suppressed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_t uuid[]; d0 date; d1 date; v_min integer; v_k integer;
  BEGIN
    PERFORM scf.op_authorize('web:read');                     -- C-114: first. On-chain cohort sums are public ledger
                                                              -- data aggregated over >= cohort_min_tenants projects
                                                              -- that have on-chain data (C-137)
    IF p_by IS NULL OR p_by NOT IN ('round', 'category', 'award_stage') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end, 400) r;
    v_t := scf.op_begin('operator.read.op_cohorts', 'web:read', NULL,
             jsonb_build_object('start', p_start, 'end', p_end, 'by', p_by, 'min_level', p_min_level));
    v_min := GREATEST(COALESCE(scf.setting_int('cohort_min_tenants'), 5), 2);
    v_k := GREATEST(COALESCE(scf.setting_int('op_min_count'), 10), 1);
    RETURN QUERY
      WITH m AS (
        SELECT DISTINCT e.tenant_id AS m_tenant,
               CASE p_by WHEN 'round' THEN p.award_round::text
                         WHEN 'award_stage' THEN p.award_stage
                         ELSE c.cat END AS m_cohort
          FROM scf.op_eligible_tenants(p_min_level, v_t) e
          JOIN scf.tenant_registry_links l ON l.tenant_id = e.tenant_id AND l.status = 'confirmed'
          JOIN scf.registry_projects p ON p.registry_project_id = l.registry_project_id
          LEFT JOIN LATERAL unnest(CASE WHEN p_by = 'category' THEN p.scf_categories END) AS c(cat) ON true),
      w AS (
        SELECT x.tenant_id AS w_tenant, sum(x.pageviews_verified)::bigint AS pv_v, sum(x.pageviews_raw)::bigint AS pv_r,
               sum(x.visitors_verified)::bigint AS vis_v
          FROM scf.web_daily_totals x
         WHERE x.day >= d0 AND x.day < d1 AND x.tenant_id IN (SELECT m.m_tenant FROM m)
         GROUP BY x.tenant_id),
      o AS (
        SELECT x.tenant_id AS o_tenant, sum(x.invocations)::bigint AS inv, sum(x.successful_invocations)::bigint AS ok
          FROM scf.onchain_daily x
          JOIN scf.declared_contracts dc ON dc.tenant_id = x.tenant_id AND dc.contract_ref = x.contract_ref
                                        AND dc.status = 'verified' AND dc.removed_at IS NULL
                                        AND dc.conflict_since IS NULL
         WHERE x.day >= d0 AND x.day < d1 AND x.tenant_id IN (SELECT m.m_tenant FROM m)
         GROUP BY x.tenant_id),
      agg AS (
        SELECT m.m_cohort AS a_cohort, count(*)::integer AS n,
               COALESCE(sum(w.pv_v), 0)::bigint AS a_pv_v, COALESCE(sum(w.pv_r), 0)::bigint AS a_pv_r,
               COALESCE(sum(w.vis_v), 0)::bigint AS a_vis, count(o.o_tenant)::integer AS a_n_on,
               COALESCE(sum(o.inv), 0)::bigint AS a_inv, COALESCE(sum(o.ok), 0)::bigint AS a_ok
          FROM m LEFT JOIN w ON w.w_tenant = m.m_tenant LEFT JOIN o ON o.o_tenant = m.m_tenant
         WHERE m.m_cohort IS NOT NULL
         GROUP BY m.m_cohort)
      SELECT a.a_cohort,
             CASE WHEN a.n >= v_min THEN a.n END,
             CASE WHEN a.n >= v_min AND a.a_pv_v >= v_k THEN a.a_pv_v END,
             CASE WHEN a.n >= v_min AND a.a_pv_r >= v_k THEN a.a_pv_r END,
             CASE WHEN a.n >= v_min AND a.a_vis >= v_k THEN a.a_vis END,
             CASE WHEN a.n >= v_min THEN a.a_n_on END,
             CASE WHEN a.n >= v_min AND a.a_n_on >= v_min AND a.a_inv >= v_k THEN a.a_inv END,
             CASE WHEN a.n >= v_min AND a.a_n_on >= v_min AND a.a_ok >= v_k THEN a.a_ok END,
             a.n < v_min
        FROM agg a
       ORDER BY a.a_cohort;
  END $$;
REVOKE ALL ON FUNCTION scf.op_cohorts(timestamptz, timestamptz, text, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_cohorts(timestamptz, timestamptz, text, smallint) TO scf_app, scf_metrics_ro;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_cohorts(timestamptz, timestamptz, text, smallint) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
