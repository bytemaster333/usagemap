-- Source: docs/data-model.md, block '-- migration: 0087_operator_console' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0087_operator_console
-- Operator console redesign (wave J, task K1; lead approval 2026-11-19): additive database support for the new SCF
-- operator console. Nothing applied earlier is edited.
-- (1) Removal reason code: a fixed reason next to the free-text one when an operator_admin removes a tenant. Stored on
--     the tenant (the removed project's members read it with status_reason on their next sign-in; there is no e-mail,
--     ADR-0014) and audited in tenant.removed. Cleared when the tenant is restored.
ALTER TABLE scf.tenants
  ADD COLUMN removal_reason_code text CHECK (removal_reason_code IN ('not_ecosystem', 'duplicate', 'spam', 'other')),
  ADD CONSTRAINT tenants_removal_reason_code_removed CHECK (removal_reason_code IS NULL OR status = 'removed');
GRANT UPDATE (removal_reason_code) ON scf.tenants TO scf_op_definer;

-- op_tenant_transition gains p_reason_code (only with p_action = 'remove'; NULL allowed). Three-argument calls keep
-- working through the default. The signature changes, so the function is dropped by its owner and created again
-- (grants, owner as in 0040).
SET LOCAL ROLE scf_op_definer;
DROP FUNCTION scf.op_tenant_transition(uuid, text, text);
DROP FUNCTION scf.op_web_breakdown(timestamptz, timestamptz, scf.web_dimension, scf.web_variant, uuid[], smallint, integer, text);
RESET ROLE;

CREATE FUNCTION scf.op_tenant_transition(p_tenant uuid, p_action text, p_reason text, p_reason_code text DEFAULT NULL)
  RETURNS scf.tenant_status
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_old scf.tenant_status; v_new scf.tenant_status; v_purged timestamptz;
  BEGIN
    PERFORM scf.op_authorize(NULL, true, p_action IN ('restore', 'purge_now', 'remove', 'require_reapproval'));   -- C-114
    IF p_reason_code IS NOT NULL
       AND (p_action <> 'remove' OR p_reason_code NOT IN ('not_ecosystem', 'duplicate', 'spam', 'other')) THEN
      RAISE EXCEPTION 'reason code only with remove, one of not_ecosystem, duplicate, spam, other' USING ERRCODE = '22023';
    END IF;
    SELECT t.status, t.purged_at INTO v_old, v_purged FROM scf.tenants t WHERE t.tenant_id = p_tenant FOR UPDATE;
    IF NOT FOUND OR v_purged IS NOT NULL THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
    v_new := CASE
      WHEN p_action = 'approve'   AND v_old = 'pending'                   THEN 'active'
      WHEN p_action = 'suspend'   AND v_old IN ('active', 'pending')      THEN 'suspended'
      WHEN p_action = 'reinstate' AND v_old = 'suspended'                 THEN 'active'
      WHEN p_action = 'remove'    AND v_old IN ('active', 'pending', 'suspended') THEN 'removed'
      WHEN p_action = 'restore'   AND v_old = 'removed'                   THEN 'suspended'   -- C-94
      WHEN p_action = 'purge_now' AND v_old = 'removed'                   THEN 'removed'
      WHEN p_action = 'require_reapproval' AND v_old = 'active'           THEN 'pending' END;   -- C-91, C-94
    IF v_new IS NULL THEN RAISE EXCEPTION 'invalid transition % from %', p_action, v_old USING ERRCODE = '22023'; END IF;
    PERFORM scf.op_begin('tenant.' || CASE p_action WHEN 'approve' THEN 'approved' WHEN 'suspend' THEN 'suspended'
                           WHEN 'reinstate' THEN 'reinstated' WHEN 'remove' THEN 'removed' WHEN 'restore' THEN 'restored'
                           WHEN 'require_reapproval' THEN 'reapproval_required' ELSE 'purge_requested' END,
                         NULL, ARRAY[p_tenant],
                         jsonb_build_object('from', v_old, 'to', v_new, 'reason', p_reason)
                           || CASE WHEN p_action = 'remove' THEN jsonb_build_object('reason_code', p_reason_code)
                                   ELSE '{}'::jsonb END,
                         true, p_action IN ('restore', 'purge_now', 'remove', 'require_reapproval'));
    UPDATE scf.tenants SET status = v_new, status_reason = p_reason, status_changed_by = scf.current_actor_user(),
           removed_at  = CASE WHEN v_new = 'removed' THEN COALESCE(removed_at, now()) END,
           purge_after = CASE WHEN p_action = 'purge_now' THEN now()
                              WHEN v_new = 'removed' THEN COALESCE(purge_after, now() + interval '30 days') END,
           removal_reason_code = CASE WHEN p_action = 'remove' THEN p_reason_code
                                      WHEN v_new = 'removed' THEN removal_reason_code END
     WHERE tenant_id = p_tenant;
    IF p_action = 'remove' THEN     -- C-64 tombstones: verified hosts, owners' GitHub ids, verified Stellar accounts
      INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id, reason)
        SELECT 'host', d.host, p_tenant, p_reason FROM scf.site_domains d WHERE d.tenant_id = p_tenant AND d.state = 'verified'
        UNION SELECT 'github_user', x.subject, p_tenant, p_reason FROM scf.memberships m
                JOIN scf.external_identities x ON x.user_id = m.user_id AND x.provider = 'github'
               WHERE m.tenant_id = p_tenant AND m.role = 'owner'
        UNION SELECT 'stellar_account', v.subject, p_tenant, p_reason FROM scf.verification_evidence v
               WHERE v.tenant_id = p_tenant AND v.kind = 'stellar_account' AND v.status = 'valid'
      ON CONFLICT DO NOTHING;
    END IF;
    PERFORM pg_notify('scf_edge', p_tenant::text);       -- edge snapshot rebuild (≤ 60 s to every node)
    RETURN v_new;
  END $$;

-- (2) Hidden breakdown values (C-95, C-136, C-137). op_web_breakdown appends hidden_rows and returns, per group
--     (tenant, or all), one summary row — value NULL, every figure NULL, suppressed = true, hidden_rows = the number of
--     values withheld by the per-day floor (0070) — but only when at least cohort_min_tenants (≥ 2) values were
--     withheld. Fewer withheld values (including none) give no summary row, so 0 and 1 cannot be told apart and a known
--     total minus the shown rows never isolates a single withheld value: the rule of the suppressed cohort (C-136).
--     The withheld values and their sum are never returned. Values cut by p_limit are not withheld and not counted.
--     Callers that list values skip rows with value NULL. Same arguments, audit row, owner and grants.
CREATE FUNCTION scf.op_web_breakdown(p_start timestamptz, p_end timestamptz, p_dimension scf.web_dimension,
                                     p_variant scf.web_variant DEFAULT 'verified', p_tenants uuid[] DEFAULT NULL,
                                     p_min_level smallint DEFAULT 1, p_limit int DEFAULT 50, p_group text DEFAULT 'tenant')
  RETURNS TABLE (tenant_id uuid, value text, visitors_sum bigint, pageviews bigint, events bigint, suppressed boolean,
                 slug text, hidden_rows integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; k int := scf.setting_int('op_min_count'); v_min int; d0 date; d1 date;
  BEGIN
    IF p_limit NOT BETWEEN 1 AND 200 OR p_group NOT IN ('tenant', 'all') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end) r;
    v_t := scf.op_begin('operator.read.op_web_breakdown', 'web:read', p_tenants,
             jsonb_build_object('start', p_start, 'end', p_end, 'dimension', p_dimension, 'variant', p_variant,
                                'group', p_group, 'tenants', p_tenants));
    v_min := GREATEST(COALESCE(scf.setting_int('cohort_min_tenants'), 5), 2);
    RETURN QUERY
      WITH dd AS (
        SELECT CASE WHEN p_group = 'tenant' THEN x.tenant_id END AS dd_tenant, x.value AS dd_value, x.day AS dd_day,
               sum(x.visitors)::bigint AS vis, sum(x.pageviews)::bigint AS pv, sum(x.events)::bigint AS ev
          FROM scf.web_daily_breakdowns x
          JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = x.tenant_id
         WHERE x.variant = p_variant AND x.dimension = p_dimension AND x.day >= d0 AND x.day < d1
         GROUP BY 1, 2, 3),
      b AS (
        SELECT dd.dd_tenant AS b_tenant, dd.dd_value AS b_value, sum(dd.vis)::bigint AS vis, sum(dd.pv)::bigint AS pv,
               sum(dd.ev)::bigint AS ev
          FROM dd WHERE COALESCE(dd.vis, dd.ev) >= k
         GROUP BY 1, 2),
      r AS (
        SELECT b.*, row_number() OVER (PARTITION BY b.b_tenant
                                       ORDER BY COALESCE(b.vis, b.ev) DESC NULLS LAST, b.b_value) AS rn
          FROM b),
      h AS (
        SELECT w.w_tenant AS h_tenant, count(*)::integer AS n
          FROM (SELECT DISTINCT dd.dd_tenant AS w_tenant, dd.dd_value AS w_value FROM dd) w
         WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.b_tenant IS NOT DISTINCT FROM w.w_tenant AND b.b_value = w.w_value)
         GROUP BY 1),
      u AS (
        SELECT r.b_tenant AS u_tenant, r.b_value AS u_value, scf.op_count(r.vis) AS u_vis, scf.op_count(r.pv) AS u_pv,
               scf.op_count(r.ev) AS u_ev, false AS u_sup, NULL::integer AS u_hidden, r.rn AS u_ord
          FROM r WHERE r.rn <= p_limit AND COALESCE(r.vis, r.ev) >= k
        UNION ALL
        SELECT h.h_tenant, NULL::text, NULL::bigint, NULL::bigint, NULL::bigint, true, h.n, NULL::bigint
          FROM h WHERE h.n >= v_min)
      SELECT u.u_tenant, u.u_value, u.u_vis, u.u_pv, u.u_ev, u.u_sup,
             (SELECT t.slug FROM scf.tenants t WHERE t.tenant_id = u.u_tenant), u.u_hidden
        FROM u ORDER BY u.u_tenant, u.u_ord NULLS LAST;
  END $$;

-- (3) Enrolment summary of the operator overview. Console only (no machine key: scope NULL), audited
--     operator.read.op_enrolment_summary. Canary tenants never count. Month = UTC calendar month of now().
--     enrolled / pending_approval: tenants now active or suspended / pending (not purged), and the same counts at the
--     start of the month: a tenant created before then and not purged before then, in the status it had then — today's
--     status when it has not changed since, otherwise the `from` of its first status-change audit row in the month
--     (op_tenant_transition and owner removals record it; an older owner removal without `from` counts as active).
--     new: tenants created in this month / the previous month. removed: distinct tenants with a tenant.removed audit
--     row in this month / the previous month (a removal later restored still counts).
CREATE FUNCTION scf.op_enrolment_summary()
  RETURNS TABLE (month_start date, enrolled integer, enrolled_at_month_start integer, pending_approval integer,
                 pending_at_month_start integer, new_this_month integer, new_previous_month integer,
                 removed_this_month integer, removed_previous_month integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE m timestamptz; pm timestamptz; nm timestamptz;
  BEGIN
    PERFORM scf.op_authorize(NULL);                           -- C-114: first; console only
    m  := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    pm := (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC';
    nm := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
    PERFORM scf.op_begin('operator.read.op_enrolment_summary', NULL, NULL, jsonb_build_object('month_start', m));
    RETURN QUERY
      WITH t AS (
        SELECT x.tenant_id AS t_id, x.status::text AS t_status, x.created_at AS t_created, x.purged_at AS t_purged,
               x.status_changed_at AS t_changed
          FROM scf.tenants x WHERE NOT x.is_canary),
      s AS (
        SELECT CASE WHEN t.t_changed < m THEN t.t_status
                    ELSE COALESCE((SELECT a.details ->> 'from' FROM scf.audit_log a
                                    WHERE a.tenant_id = t.t_id AND a.occurred_at >= m
                                      AND a.action IN ('tenant.approved', 'tenant.suspended', 'tenant.reinstated',
                                                       'tenant.removed', 'tenant.restored', 'tenant.reapproval_required')
                                    ORDER BY a.occurred_at, a.seq LIMIT 1), 'active') END AS s_status
          FROM t WHERE t.t_created < m AND (t.t_purged IS NULL OR t.t_purged >= m)),
      rm AS (
        SELECT a.tenant_id AS rm_tenant, min(a.occurred_at) FILTER (WHERE a.occurred_at >= m) AS rm_this,
               min(a.occurred_at) FILTER (WHERE a.occurred_at < m) AS rm_prev
          FROM scf.audit_log a JOIN t ON t.t_id = a.tenant_id
         WHERE a.action = 'tenant.removed' AND a.occurred_at >= pm AND a.occurred_at < nm
         GROUP BY a.tenant_id)
      SELECT (m AT TIME ZONE 'UTC')::date,
             (SELECT count(*) FROM t WHERE t.t_status IN ('active', 'suspended') AND t.t_purged IS NULL)::integer,
             (SELECT count(*) FROM s WHERE s.s_status IN ('active', 'suspended'))::integer,
             (SELECT count(*) FROM t WHERE t.t_status = 'pending' AND t.t_purged IS NULL)::integer,
             (SELECT count(*) FROM s WHERE s.s_status = 'pending')::integer,
             (SELECT count(*) FROM t WHERE t.t_created >= m AND t.t_created < nm)::integer,
             (SELECT count(*) FROM t WHERE t.t_created >= pm AND t.t_created < m)::integer,
             (SELECT count(*) FROM rm WHERE rm.rm_this IS NOT NULL)::integer,
             (SELECT count(*) FROM rm WHERE rm.rm_prev IS NOT NULL)::integer;
  END $$;

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('operator.read.op_enrolment_summary', 'op_* read', '{scf_op_definer}');

-- C-114: grants first, then the owner (the migrator cannot grant on a function it no longer owns).
GRANT EXECUTE ON FUNCTION
  scf.op_web_breakdown(timestamptz,timestamptz,scf.web_dimension,scf.web_variant,uuid[],smallint,integer,text)
  TO scf_app, scf_metrics_ro;
GRANT EXECUTE ON FUNCTION scf.op_tenant_transition(uuid,text,text,text), scf.op_enrolment_summary() TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'scf.op_tenant_transition(uuid,text,text,text)',
    'scf.op_web_breakdown(timestamptz,timestamptz,scf.web_dimension,scf.web_variant,uuid[],smallint,integer,text)',
    'scf.op_enrolment_summary()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO scf_op_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
