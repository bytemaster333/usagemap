-- Source: docs/data-model.md, block '-- migration: 0088_operator_read_speed' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0088_operator_read_speed
-- Operator console read speed (2026-11-20): on the demo stack (20 tenants, ~86 000 hourly API rows) one
-- op_api_metrics call over 30 days took 3–5 s, so the console's API pages ran into the control plane's 5 s pool wait.
-- Two per-row costs, no change in results, rights or audit:
-- (1) The preferred-group views (0020) called scf.is_preferred_group() once per metric row (a correlated lookup the
--     planner cannot inline). They now join one row per (tenant, service, UTC day): the best-ranked stream group
--     present, chosen exactly as is_preferred_group chooses it (ORDER BY rank_key, group_id; no group row = no metric
--     row). Same columns, still security_invoker, so RLS of the caller applies to every table read. The new view
--     api_service_preferred_groups carries the same grants as the *_pref views. is_preferred_group stays.
CREATE VIEW scf.api_service_preferred_groups WITH (security_invoker = true) AS
  SELECT DISTINCT ON (d.tenant_id, d.service_id, d.day) d.tenant_id, d.service_id, d.day, d.stream_group_id
    FROM scf.api_service_day_groups d
    JOIN scf.api_stream_groups g ON g.tenant_id = d.tenant_id AND g.group_id = d.stream_group_id
   ORDER BY d.tenant_id, d.service_id, d.day, g.rank_key, g.group_id;
GRANT SELECT ON scf.api_service_preferred_groups TO scf_app, scf_op_definer, scf_jobs;

CREATE OR REPLACE VIEW scf.api_metrics_1m_pref WITH (security_invoker = true) AS
  SELECT m.* FROM scf.api_metrics_1m m
    JOIN scf.api_service_preferred_groups p
      ON p.tenant_id = m.tenant_id AND p.service_id = m.service_id
     AND p.day = (m.bucket_start AT TIME ZONE 'UTC')::date AND p.stream_group_id = m.stream_group_id;
CREATE OR REPLACE VIEW scf.api_metrics_1h_pref WITH (security_invoker = true) AS
  SELECT m.* FROM scf.api_metrics_1h m
    JOIN scf.api_service_preferred_groups p
      ON p.tenant_id = m.tenant_id AND p.service_id = m.service_id
     AND p.day = (m.bucket_start AT TIME ZONE 'UTC')::date AND p.stream_group_id = m.stream_group_id;
CREATE OR REPLACE VIEW scf.api_metrics_1d_pref WITH (security_invoker = true) AS
  SELECT m.* FROM scf.api_metrics_1d m
    JOIN scf.api_service_preferred_groups p
      ON p.tenant_id = m.tenant_id AND p.service_id = m.service_id
     AND p.day = (m.bucket_start AT TIME ZONE 'UTC')::date AND p.stream_group_id = m.stream_group_id;

-- (2) scf.op_eligible_tenants (0040) was inlined into each op_* query, and the planner then evaluated
--     scf.verification_level() once per joined metric row instead of once per tenant. A SET clause makes the function
--     non-inlinable: it runs once per call (one row per eligible tenant). Same body, owner, rights and results.
SET LOCAL ROLE scf_op_definer;
ALTER FUNCTION scf.op_eligible_tenants(smallint, uuid[], scf.tenant_status[]) SET search_path = pg_catalog, pg_temp;
RESET ROLE;

-- (3) scf.hist_add8 (0020), the step of every histogram sum (scf.hist_sum), summed element by element in an SQL
--     ARRAY(... ORDER BY i) subquery: a sort per added row. A plpgsql loop gives the same array (same length as a,
--     NULL where b has no element, NULL a or b returns the other) about three times faster. Same name, signature,
--     owner, volatility and grants.
CREATE OR REPLACE FUNCTION scf.hist_add8(a bigint[], b bigint[]) RETURNS bigint[]
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$
  DECLARE i int;
  BEGIN
    IF a IS NULL THEN RETURN b; END IF;
    IF b IS NULL THEN RETURN a; END IF;
    IF cardinality(a) = 0 THEN RETURN '{}'; END IF;
    FOR i IN array_lower(a, 1) .. array_upper(a, 1) LOOP
      a[i] := a[i] + b[i];
    END LOOP;
    RETURN a;
  END $$;
