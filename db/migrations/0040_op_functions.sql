-- Source: docs/data-model.md, block '-- migration: 0040_op_functions' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0040_op_functions
-- C-114: the authorisation half of op_begin(), callable first — before an op_* function reads or locks anything, so
-- an unauthorised caller learns nothing (not even whether a tenant exists) and holds no lock.
CREATE FUNCTION scf.op_authorize(p_scope text, p_write boolean DEFAULT false, p_admin boolean DEFAULT false)
  RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_kind text := scf.actor_kind();
  BEGIN
    IF v_kind = 'operator' AND scf.platform_role() IS NOT NULL THEN
      IF p_admin AND scf.platform_role() <> 'operator_admin' THEN
        RAISE EXCEPTION 'operator_admin required' USING ERRCODE = '42501';
      END IF;
      IF p_write AND (NULLIF(current_setting('app.step_up_at', true), '') IS NULL
                      OR current_setting('app.step_up_at', true)::timestamptz < now() - interval '10 minutes') THEN
        RAISE EXCEPTION 'step-up required' USING ERRCODE = '42501';
      END IF;
    ELSIF v_kind = 'op_key' AND NOT p_write AND p_scope IS NOT NULL THEN
      -- p_scope lists one or more scopes separated by commas; the key must hold all of them.
      IF NOT (string_to_array(p_scope, ',')
              <@ string_to_array(COALESCE(current_setting('app.key_scopes', true), ''), ',')) THEN
        RAISE EXCEPTION 'scope % required', p_scope USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'SCF operator context required' USING ERRCODE = '42501';
    END IF;
  END $$;

CREATE FUNCTION scf.op_begin(p_action text, p_scope text, p_tenants uuid[], p_details jsonb,
                             p_write boolean DEFAULT false, p_admin boolean DEFAULT false,
                             p_outcome text DEFAULT 'success') RETURNS uuid[]
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_kind text := scf.actor_kind(); v_allowed uuid[]; v_eff uuid[];
  BEGIN
    PERFORM scf.op_authorize(p_scope, p_write, p_admin);
    IF v_kind = 'op_key' THEN
      v_allowed := NULLIF(current_setting('app.key_tenants', true), '')::uuid[];
      v_eff := CASE WHEN v_allowed IS NULL THEN p_tenants
                    WHEN p_tenants IS NULL THEN v_allowed
                    ELSE ARRAY(SELECT unnest(p_tenants) INTERSECT SELECT unnest(v_allowed)) END;
    ELSE
      v_eff := p_tenants;
    END IF;
    INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action, subject_tenant_ids, outcome, details, request_id)
    VALUES (CASE WHEN cardinality(v_eff) = 1 THEN v_eff[1] END, v_kind, scf.current_actor(), p_action, v_eff,
            p_outcome, p_details, NULLIF(current_setting('app.request_id', true), ''));
    RETURN v_eff;
  END $$;

-- p_named: the tenants the call names (NULL = all). Canary tenants only when named (§8.3).
CREATE FUNCTION scf.op_eligible_tenants(p_min_level smallint, p_named uuid[] DEFAULT NULL,
                                        p_statuses scf.tenant_status[] DEFAULT '{active,suspended}')
  RETURNS TABLE (tenant_id uuid, verification_level smallint) LANGUAGE sql STABLE
  AS $$ SELECT t.tenant_id, scf.verification_level(t.tenant_id) FROM scf.tenants t
         WHERE t.status = ANY (p_statuses) AND t.purged_at IS NULL
           AND (p_named IS NULL OR t.tenant_id = ANY (p_named))
           AND (NOT t.is_canary OR t.tenant_id = ANY (COALESCE(p_named, '{}'::uuid[])))
           AND scf.verification_level(t.tenant_id) >= p_min_level $$;

CREATE FUNCTION scf.op_projects(p_min_level smallint DEFAULT 1,
                                p_statuses scf.tenant_status[] DEFAULT '{active,suspended}', p_q text DEFAULT NULL)
  RETURNS TABLE (tenant_id uuid, slug text, name text, status scf.tenant_status, created_at timestamptz,
                 verification_level smallint, scf_awarded boolean, registry_project_ids uuid[],
                 site_count bigint, service_count bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[];
  BEGIN
    -- machine keys see active/suspended only; the console may list pending/removed tenants
    IF scf.actor_kind() = 'op_key' AND NOT (p_statuses <@ ARRAY['active','suspended']::scf.tenant_status[]) THEN
      RAISE EXCEPTION 'status filter not allowed' USING ERRCODE = '42501';
    END IF;
    v_t := scf.op_begin('operator.read.op_projects', 'registry:read', NULL,
                         jsonb_build_object('min_level', p_min_level, 'statuses', p_statuses, 'q', p_q));
    RETURN QUERY
      SELECT t.tenant_id, t.slug, t.name, t.status, t.created_at, e.verification_level,
             (SELECT bool_or(p.scf_awarded) FROM scf.tenant_registry_links r
                JOIN scf.registry_projects p ON p.registry_project_id = r.registry_project_id
               WHERE r.tenant_id = t.tenant_id AND r.status = 'confirmed'),
             (SELECT array_agg(r.registry_project_id ORDER BY r.registry_project_id) FROM scf.tenant_registry_links r
               WHERE r.tenant_id = t.tenant_id AND r.status = 'confirmed'),
             (SELECT count(*) FROM scf.sites s WHERE s.tenant_id = t.tenant_id AND s.status = 'active'),
             (SELECT count(*) FROM scf.api_services a WHERE a.tenant_id = t.tenant_id AND a.status = 'active')
        FROM scf.tenants t
        JOIN scf.op_eligible_tenants(p_min_level, v_t, p_statuses) e ON e.tenant_id = t.tenant_id
       WHERE p_q IS NULL OR t.slug ILIKE '%' || p_q || '%' OR t.name ILIKE '%' || p_q || '%';
  END $$;

CREATE FUNCTION scf.op_web_metrics(p_start timestamptz, p_end timestamptz, p_bucket text DEFAULT 'day',
                                   p_group text DEFAULT 'tenant', p_variant scf.web_variant DEFAULT 'verified',
                                   p_tenants uuid[] DEFAULT NULL, p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, site_id uuid, day date, verification_level smallint,
                 pageviews bigint, pageviews_unidentified bigint, visitors_sum bigint, visits bigint, bounces bigint,
                 bounce_rate_pct numeric, avg_visit_duration_s numeric, suspect_pageview_share numeric,
                 all_final boolean, suppressed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; d0 date; d1 date;
  BEGIN
    IF p_bucket NOT IN ('day', 'range') OR p_group NOT IN ('tenant', 'site', 'all') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end) r;
    v_t := scf.op_begin('operator.read.op_web_metrics', 'web:read', p_tenants,
             jsonb_build_object('start', p_start, 'end', p_end, 'bucket', p_bucket, 'group', p_group,
                                'variant', p_variant, 'tenants', p_tenants, 'min_level', p_min_level));
    RETURN QUERY
      WITH b AS (
        SELECT CASE WHEN p_group <> 'all' THEN w.tenant_id END AS tenant_id,
               CASE WHEN p_group = 'site' THEN w.site_id END AS site_id,
               CASE WHEN p_bucket = 'day' THEN w.day END AS day,
               CASE WHEN p_group <> 'all' THEN e.verification_level END AS verification_level,
               sum(CASE WHEN p_variant = 'verified' THEN w.pageviews_verified ELSE w.pageviews_raw END)::bigint AS pv,
               sum(CASE WHEN p_variant = 'verified' THEN w.pageviews_unidentified_verified
                        ELSE w.pageviews_unidentified_raw END)::bigint AS pvu,
               sum(CASE WHEN p_variant = 'verified' THEN w.visitors_verified ELSE w.visitors_raw END)::bigint AS vis,
               sum(w.pageviews_verified)::bigint AS pv_v, sum(w.pageviews_raw)::bigint AS pv_r,
               sum(w.visits)::bigint AS vs, sum(w.bounces)::bigint AS bo,
               sum(w.total_duration_s)::bigint AS d, bool_and(w.is_final) AS f
          FROM scf.web_daily_totals w
          JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = w.tenant_id
         WHERE w.day >= d0 AND w.day < d1
         GROUP BY 1, 2, 3, 4)
      -- C-91, C-95: web totals are returned exactly (no minimum count, no rounding); suppressed is always false.
      SELECT b.tenant_id, b.site_id, b.day, b.verification_level,
             b.pv, b.pvu, b.vis, b.vs, b.bo,
             CASE WHEN b.vs > 0 THEN round(100.0 * b.bo / b.vs, 1) END,
             CASE WHEN b.vs > 0 THEN round(b.d::numeric / b.vs, 1) END,
             CASE WHEN b.pv_r > 0 THEN round((b.pv_r - b.pv_v)::numeric / b.pv_r, 4) END,
             b.f, false
        FROM b;
  END $$;

CREATE FUNCTION scf.op_web_breakdown(p_start timestamptz, p_end timestamptz, p_dimension scf.web_dimension,
                                     p_variant scf.web_variant DEFAULT 'verified', p_tenants uuid[] DEFAULT NULL,
                                     p_min_level smallint DEFAULT 1, p_limit int DEFAULT 50, p_group text DEFAULT 'tenant')
  RETURNS TABLE (tenant_id uuid, value text, visitors_sum bigint, pageviews bigint, events bigint, suppressed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; k int := scf.setting_int('op_min_count'); d0 date; d1 date;
  BEGIN
    IF p_limit NOT BETWEEN 1 AND 200 OR p_group NOT IN ('tenant', 'all') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end) r;
    v_t := scf.op_begin('operator.read.op_web_breakdown', 'web:read', p_tenants,
             jsonb_build_object('start', p_start, 'end', p_end, 'dimension', p_dimension, 'variant', p_variant,
                                'group', p_group, 'tenants', p_tenants));
    RETURN QUERY
      WITH b AS (
        SELECT CASE WHEN p_group = 'tenant' THEN x.tenant_id END AS tenant_id, x.value AS value,
               sum(x.visitors)::bigint AS vis, sum(x.pageviews)::bigint AS pv, sum(x.events)::bigint AS ev
          FROM scf.web_daily_breakdowns x
          JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = x.tenant_id
         WHERE x.variant = p_variant AND x.dimension = p_dimension AND x.day >= d0 AND x.day < d1
         GROUP BY 1, 2),
      r AS (
        SELECT b.*, row_number() OVER (PARTITION BY b.tenant_id
                                       ORDER BY COALESCE(b.vis, b.ev) DESC NULLS LAST, b.value) AS rn
          FROM b)
      SELECT r.tenant_id, r.value, scf.op_count(r.vis), scf.op_count(r.pv), scf.op_count(r.ev), false
        FROM r WHERE r.rn <= p_limit AND COALESCE(r.vis, r.ev) >= k
       ORDER BY r.tenant_id, r.rn;
  END $$;

CREATE FUNCTION scf.op_web_verdicts(p_start timestamptz, p_end timestamptz, p_tenants uuid[] DEFAULT NULL,
                                    p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, site_id uuid, day date, counter text, label text, count bigint, suppressed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; d0 date; d1 date;     -- C-95: counters returned exactly
  BEGIN
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end) r;
    v_t := scf.op_begin('operator.read.op_web_verdicts', 'web:read', p_tenants,
                        jsonb_build_object('start', p_start, 'end', p_end, 'tenants', p_tenants));
    RETURN QUERY
      SELECT c.tenant_id, c.site_id, c.day, c.counter, c.label, c.count, false
        FROM scf.web_edge_counters c JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = c.tenant_id
       WHERE c.counter IN ('verdict', 'reason') AND c.day >= d0 AND c.day < d1;
  END $$;

CREATE FUNCTION scf.op_api_metrics(p_start timestamptz, p_end timestamptz, p_bucket text DEFAULT 'day',
                                   p_group text DEFAULT 'service', p_tenants uuid[] DEFAULT NULL,
                                   p_services uuid[] DEFAULT NULL, p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, service_id uuid, route text, rpc_method text, bucket_start timestamptz,
                 verification_level smallint, requests bigint, status_2xx bigint, status_3xx bigint, status_4xx bigint,
                 status_5xx bigint, status_unknown bigint, error_rate_5xx numeric, mean_s float8,
                 p50_s float8, p95_s float8, p99_s float8, accuracy_class text, suppressed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; v_hourly boolean;   -- C-95: API metrics are returned exactly (no minimum count, no rounding)
  BEGIN
    IF p_bucket NOT IN ('hour', 'day', 'range') OR p_group NOT IN ('all', 'tenant', 'service', 'route')
       OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '3660 days'
       OR date_trunc('hour', p_start) <> p_start OR date_trunc('hour', p_end) <> p_end
       OR (p_bucket = 'hour' AND p_end - p_start > interval '31 days')
       OR ((p_bucket = 'day' OR p_end - p_start > interval '31 days')
           AND (date_trunc('day', p_start, 'UTC') <> p_start OR date_trunc('day', p_end, 'UTC') <> p_end)) THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    v_t := scf.op_begin('operator.read.op_api_metrics', 'api:read', p_tenants,
             jsonb_build_object('start', p_start, 'end', p_end, 'bucket', p_bucket, 'group', p_group,
                                'tenants', p_tenants, 'services', p_services));
    v_hourly := p_bucket = 'hour' OR p_end - p_start <= interval '31 days';
    RETURN QUERY
      WITH m AS (
        SELECT * FROM scf.api_metrics_1h_pref h WHERE v_hourly AND h.bucket_start >= p_start AND h.bucket_start < p_end
        UNION ALL
        SELECT * FROM scf.api_metrics_1d_pref d WHERE NOT v_hourly AND d.bucket_start >= p_start AND d.bucket_start < p_end),
      g AS (
        SELECT CASE WHEN p_group <> 'all' THEN m.tenant_id END AS tenant_id,
               CASE WHEN p_group IN ('service', 'route') THEN m.service_id END AS service_id,
               CASE WHEN p_group = 'route' THEN m.route_id END AS route_id,
               CASE p_bucket WHEN 'hour' THEN m.bucket_start
                             WHEN 'day' THEN date_trunc('day', m.bucket_start, 'UTC') END AS bucket_start,
               CASE WHEN p_group <> 'all' THEN e.verification_level END AS verification_level,
               sum(m.request_count)::bigint AS n,
               (sum(m.request_count) FILTER (WHERE m.status_code BETWEEN 200 AND 299))::bigint AS n2,
               (sum(m.request_count) FILTER (WHERE m.status_code BETWEEN 300 AND 399))::bigint AS n3,
               (sum(m.request_count) FILTER (WHERE m.status_code BETWEEN 400 AND 499))::bigint AS n4,
               (sum(m.request_count) FILTER (WHERE m.status_code BETWEEN 500 AND 599))::bigint AS n5,
               (sum(m.request_count) FILTER (WHERE m.status_code = 0))::bigint AS n0,
               sum(m.duration_sum) AS dsum,
               bool_and(m.hist_kind = 'exp3') AS all_exp3, bool_and(m.hist_kind = 'explicit15') AS all_exp15,
               max(m.hist_quality)::smallint AS q,
               -- C-103: merge each kind first, convert the summed exp3 histogram once per group (S-05)
               CASE WHEN bool_and(m.hist_kind = 'exp3') THEN scf.hist_sum(m.hist)
                    ELSE scf.hist_add8(scf.hist_sum(m.hist) FILTER (WHERE m.hist_kind = 'explicit15'),
                                       scf.hist_exp3_to_explicit15(scf.hist_sum(m.hist) FILTER (WHERE m.hist_kind = 'exp3'))) END AS h,
               CASE WHEN bool_and(m.duration_min IS NOT NULL) THEN min(m.duration_min) END AS vmin,
               CASE WHEN bool_and(m.duration_max IS NOT NULL) THEN max(m.duration_max) END AS vmax
          FROM m JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = m.tenant_id
         WHERE p_services IS NULL OR m.service_id = ANY (p_services)
         GROUP BY 1, 2, 3, 4, 5)
      SELECT g.tenant_id, g.service_id, r.route, r.rpc_method, g.bucket_start, g.verification_level,
             g.n, g.n2, g.n3, g.n4, g.n5, g.n0,
             CASE WHEN g.n > 0 THEN round(COALESCE(g.n5, 0)::numeric / g.n, 4) END,
             CASE WHEN g.n > 0 THEN g.dsum / g.n END,
             CASE WHEN g.n > 0 THEN scf.hist_quantile(CASE WHEN g.all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, g.h, 0.50, g.vmin, g.vmax) END,
             CASE WHEN g.n > 0 THEN scf.hist_quantile(CASE WHEN g.all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, g.h, 0.95, g.vmin, g.vmax) END,
             CASE WHEN g.n > 0 THEN scf.hist_quantile(CASE WHEN g.all_exp3 THEN 'exp3'::scf.hist_kind ELSE 'explicit15' END, g.h, 0.99, g.vmin, g.vmax) END,
             scf.accuracy_class(g.all_exp3, g.all_exp15, g.q),
             false
        FROM g LEFT JOIN scf.api_routes r ON r.tenant_id = g.tenant_id AND r.route_id = g.route_id;
  END $$;

CREATE FUNCTION scf.op_trust(p_start timestamptz, p_end timestamptz, p_tenants uuid[] DEFAULT NULL,
                             p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, site_id uuid, day date, window_days smallint, score smallint, components jsonb,
                 reason_codes text[], decision_rate numeric, algorithm_version text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; d0 date; d1 date;
  BEGIN
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end) r;
    v_t := scf.op_begin('operator.read.op_trust', 'web:read', p_tenants,
                        jsonb_build_object('start', p_start, 'end', p_end, 'tenants', p_tenants));
    RETURN QUERY
      SELECT s.tenant_id, s.site_id, s.day, s.window_days, s.score,
             CASE WHEN s.score IS NULL THEN NULL ELSE s.components END,        -- CR-35: nothing below k
             s.reason_codes,
             CASE WHEN s.score IS NULL THEN NULL ELSE s.decision_rate END,
             s.algorithm_version
        FROM scf.web_trust_scores s JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = s.tenant_id
       WHERE s.day >= d0 AND s.day < d1;
  END $$;

CREATE FUNCTION scf.op_api_assurance(p_start timestamptz, p_end timestamptz, p_tenants uuid[] DEFAULT NULL,
                                     p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, service_id uuid, day date, level smallint, onchain_badge text, checks jsonb, reason_codes text[])
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; d0 date; d1 date;
  BEGIN
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end) r;
    v_t := scf.op_begin('operator.read.op_api_assurance', 'api:read', p_tenants,
                        jsonb_build_object('start', p_start, 'end', p_end, 'tenants', p_tenants));
    RETURN QUERY
      SELECT a.tenant_id, a.service_id, a.day, a.level, a.onchain_badge, a.checks, a.reason_codes
        FROM scf.api_service_assurance a JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = a.tenant_id
       WHERE a.day >= d0 AND a.day < d1;
  END $$;

CREATE FUNCTION scf.op_onchain(p_start timestamptz, p_end timestamptz, p_tenants uuid[] DEFAULT NULL,
                               p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, contract_id text, network text, contract_status text, day date,
                 invocations bigint, successful_invocations bigint, distinct_invokers bigint, suppressed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE v_t uuid[]; d0 date; d1 date;     -- C-95: public ledger counts returned exactly
  BEGIN
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end) r;
    v_t := scf.op_begin('operator.read.op_onchain', 'api:read', p_tenants,
                        jsonb_build_object('start', p_start, 'end', p_end, 'tenants', p_tenants));
    RETURN QUERY
      SELECT o.tenant_id, c.contract_id, c.network, c.status, o.day, o.invocations,
             o.successful_invocations, o.distinct_invokers, false
        FROM scf.onchain_daily o
        JOIN scf.declared_contracts c ON c.tenant_id = o.tenant_id AND c.contract_ref = o.contract_ref
        JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = o.tenant_id
       WHERE o.day >= d0 AND o.day < d1;
  END $$;

CREATE FUNCTION scf.op_metrics_document(p_slug text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_tenant uuid; v_allowed boolean;
  BEGIN
    PERFORM scf.op_authorize('web:read,api:read');         -- C-114: authorise before the lookup
    SELECT t.tenant_id INTO v_tenant FROM scf.tenants t
     WHERE t.slug = p_slug AND t.status = 'active' AND t.purged_at IS NULL;        -- C-94: 404 otherwise
    -- CR-22: apply the key's tenant restriction first, then audit what happened.
    v_allowed := v_tenant IS NOT NULL
                 AND (scf.actor_kind() <> 'op_key' OR NULLIF(current_setting('app.key_tenants', true), '') IS NULL
                      OR v_tenant = ANY (current_setting('app.key_tenants', true)::uuid[]));
    PERFORM scf.op_begin('operator.read.op_metrics_document', 'web:read,api:read',      -- CR-21: both scopes
                         CASE WHEN v_allowed THEN ARRAY[v_tenant] ELSE '{}'::uuid[] END,
                         jsonb_build_object('slug', p_slug),
                         p_outcome => CASE WHEN v_allowed THEN 'success' ELSE 'denied' END);
    IF NOT v_allowed THEN RETURN NULL; END IF;
    RETURN (SELECT d.document FROM scf.public_metrics_documents d WHERE d.tenant_id = v_tenant);
  END $$;

CREATE FUNCTION scf.op_tenant_detail(p_tenant uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF scf.actor_kind() <> 'operator' THEN RAISE EXCEPTION 'SCF operator required' USING ERRCODE = '42501'; END IF;
    PERFORM scf.op_begin('operator.read.op_tenant_detail', NULL, ARRAY[p_tenant], '{}'::jsonb);
    RETURN (
      SELECT jsonb_build_object(
        'tenant', to_jsonb(t) - 'status_changed_by',
        'verification_level', scf.verification_level(t.tenant_id),
        'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role,
                      'display_name', u.display_name, 'added_at', m.added_at) ORDER BY m.added_at), '[]')
                      FROM scf.memberships m JOIN scf.users u ON u.user_id = m.user_id WHERE m.tenant_id = t.tenant_id),
        'sites', (SELECT COALESCE(jsonb_agg((to_jsonb(s) - 'umami_website_id' - 'umami_twin_website_id')
                      || jsonb_build_object('effective_event_retention_days',
                           LEAST(COALESCE(s.event_retention_days, 395), scf.setting_int('web_event_retention_days')))
                    ORDER BY s.created_at), '[]')
                    FROM scf.sites s WHERE s.tenant_id = t.tenant_id),
        'domains', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.created_at), '[]')
                      FROM scf.site_domains d WHERE d.tenant_id = t.tenant_id),
        'services', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.registered_at), '[]')
                       FROM scf.api_services a WHERE a.tenant_id = t.tenant_id),
        'evidence', (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.verified_at), '[]')
                       FROM scf.verification_evidence v WHERE v.tenant_id = t.tenant_id),
        'registry_links', (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]')
                             FROM scf.tenant_registry_links r WHERE r.tenant_id = t.tenant_id),
        'ingest_tokens', (SELECT COALESCE(jsonb_agg(to_jsonb(i) - 'secret_hash' ORDER BY i.created_at), '[]')
                            FROM scf.ingest_tokens i WHERE i.tenant_id = t.tenant_id),
        'erasure_requests', (SELECT COALESCE(jsonb_agg(jsonb_build_object('request_id', x.request_id,
                                'scope', x.scope, 'status', x.status, 'created_at', x.created_at) ORDER BY x.created_at), '[]')
                               FROM scf.erasure_requests x
                              WHERE x.tenant_id = t.tenant_id AND x.status IN ('previewing', 'previewed', 'confirmed', 'running')),
        'annotations', (SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.created_at), '[]')
                          FROM scf.trust_annotations n WHERE n.tenant_id = t.tenant_id))
        FROM scf.tenants t WHERE t.tenant_id = p_tenant);
  END $$;

CREATE FUNCTION scf.op_audit_list(p_start timestamptz, p_end timestamptz, p_tenant uuid DEFAULT NULL,
                                  p_action_prefix text DEFAULT NULL, p_limit int DEFAULT 100,
                                  p_after_time timestamptz DEFAULT NULL, p_after_chain uuid DEFAULT NULL,
                                  p_after_seq bigint DEFAULT NULL)
  RETURNS SETOF scf.audit_log
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF scf.actor_kind() <> 'operator' OR p_limit NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start
       OR NOT ((p_after_time IS NULL AND p_after_chain IS NULL AND p_after_seq IS NULL)
               OR (p_after_time IS NOT NULL AND p_after_chain IS NOT NULL AND p_after_seq IS NOT NULL)) THEN
      RAISE EXCEPTION 'invalid range or cursor (after_time, after_chain, after_seq: all or none)' USING ERRCODE = '22023';
    END IF;
    PERFORM scf.op_begin('operator.read.op_audit_list', NULL, CASE WHEN p_tenant IS NOT NULL THEN ARRAY[p_tenant] END,
                         jsonb_build_object('start', p_start, 'end', p_end, 'action_prefix', p_action_prefix));
    RETURN QUERY
      SELECT a.* FROM scf.audit_log a
       WHERE a.occurred_at >= p_start AND a.occurred_at < p_end
         AND (p_tenant IS NULL OR a.tenant_id = p_tenant)
         AND (p_action_prefix IS NULL OR a.action LIKE p_action_prefix || '%')
         AND (p_after_time IS NULL OR (a.occurred_at, a.chain_id, a.seq) > (p_after_time, p_after_chain, p_after_seq))
       ORDER BY a.occurred_at, a.chain_id, a.seq
       LIMIT p_limit;
  END $$;

CREATE FUNCTION scf.op_tenant_transition(p_tenant uuid, p_action text, p_reason text) RETURNS scf.tenant_status
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_old scf.tenant_status; v_new scf.tenant_status; v_purged timestamptz;
  BEGIN
    PERFORM scf.op_authorize(NULL, true, p_action IN ('restore', 'purge_now', 'remove', 'require_reapproval'));   -- C-114
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
                         NULL, ARRAY[p_tenant], jsonb_build_object('from', v_old, 'to', v_new, 'reason', p_reason),
                         true, p_action IN ('restore', 'purge_now', 'remove', 'require_reapproval'));
    UPDATE scf.tenants SET status = v_new, status_reason = p_reason, status_changed_by = scf.current_actor_user(),
           removed_at  = CASE WHEN v_new = 'removed' THEN COALESCE(removed_at, now()) END,
           purge_after = CASE WHEN p_action = 'purge_now' THEN now()
                              WHEN v_new = 'removed' THEN COALESCE(purge_after, now() + interval '30 days') END
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

CREATE FUNCTION scf.op_add_annotation(p_tenant uuid, p_site uuid, p_service uuid, p_start timestamptz,
                                      p_end timestamptz, p_body text, p_codes text[] DEFAULT '{}',
                                      p_marks_explained boolean DEFAULT false) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_id uuid;
  BEGIN
    PERFORM scf.op_authorize(NULL, true);                   -- C-114: before the existence checks below
    -- C-87: a site or service named in the request must belong to p_tenant (the composite keys enforce it as well).
    IF (p_site IS NOT NULL AND NOT EXISTS (SELECT 1 FROM scf.sites s WHERE s.tenant_id = p_tenant AND s.site_id = p_site))
       OR (p_service IS NOT NULL AND NOT EXISTS (SELECT 1 FROM scf.api_services a
                                                  WHERE a.tenant_id = p_tenant AND a.service_id = p_service)) THEN
      RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
    END IF;
    PERFORM scf.op_begin('trust.annotation.created', NULL, ARRAY[p_tenant],
                         jsonb_build_object('site', p_site, 'service', p_service, 'marks_explained', p_marks_explained), true);
    INSERT INTO scf.trust_annotations (tenant_id, site_id, service_id, range_start, range_end, author_kind, author_user_id,
                                       body, explains_reason_codes, marks_explained)
    VALUES (p_tenant, p_site, p_service, p_start, p_end, 'scf_operator', scf.current_actor_user(), p_body, p_codes,
            p_marks_explained)
    RETURNING annotation_id INTO v_id;
    RETURN v_id;
  END $$;

CREATE FUNCTION scf.op_registry_link_decide(p_tenant uuid, p_registry_project uuid, p_decision text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    PERFORM scf.op_authorize(NULL, true);                   -- C-114
    IF p_decision NOT IN ('confirm', 'reject') THEN RAISE EXCEPTION 'invalid decision' USING ERRCODE = '22023'; END IF;
    PERFORM scf.op_begin('registry.link_' || p_decision || 'ed', NULL, ARRAY[p_tenant],
                         jsonb_build_object('registry_project_id', p_registry_project), true);
    INSERT INTO scf.tenant_registry_links (tenant_id, registry_project_id, match_basis, status, decided_by, decided_at)
    VALUES (p_tenant, p_registry_project, ARRAY['operator'],
            CASE p_decision WHEN 'confirm' THEN 'confirmed' ELSE 'rejected' END, scf.current_actor_user(), now())
    ON CONFLICT (tenant_id, registry_project_id) DO UPDATE
      SET status = EXCLUDED.status, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at;
    IF p_decision = 'confirm' AND EXISTS (SELECT 1 FROM scf.registry_projects p WHERE p.registry_project_id = p_registry_project
                                           AND p.scf_awarded AND p.source IN ('stellarlight', 'pg_atlas')) THEN
      INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, created_by)
      VALUES (p_tenant, 'registry_match', p_registry_project::text, jsonb_build_object('basis', ARRAY['operator']),
              scf.current_actor_user())
      ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET status = 'valid', lapsed_at = NULL;
    ELSIF p_decision = 'reject' THEN
      UPDATE scf.verification_evidence SET status = 'revoked', revoked_at = now(), revoked_by = scf.current_actor_user()
       WHERE tenant_id = p_tenant AND kind = 'registry_match' AND subject = p_registry_project::text;
    END IF;
  END $$;

CREATE FUNCTION scf.op_resolve_domain_dispute(p_tenant uuid, p_domain uuid, p_decision text) RETURNS void
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
  END $$;

CREATE FUNCTION scf.op_approve_tenant_evidence(p_tenant uuid, p_note text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_id uuid;
  BEGIN
    PERFORM scf.op_begin('verification.operator_approved', NULL, ARRAY[p_tenant], jsonb_build_object('note', p_note), true);
    INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, created_by)
    VALUES (p_tenant, 'operator_approval', 'operator',
            jsonb_build_object('note', p_note, 'operator_user_id', scf.current_actor_user()), scf.current_actor_user())
    ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET status = 'valid', revoked_at = NULL, details = EXCLUDED.details
    RETURNING evidence_id INTO v_id;
    RETURN v_id;
  END $$;

CREATE FUNCTION scf.op_lift_tombstone(p_tombstone uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    PERFORM scf.op_begin('operator.tombstone_lifted', NULL, NULL, jsonb_build_object('tombstone_id', p_tombstone), true, true);
    UPDATE scf.enrollment_tombstones SET lifted_at = now(), lifted_by = scf.current_actor_user()
     WHERE tombstone_id = p_tombstone AND lifted_at IS NULL;
  END $$;

-- C-114: grants first — once a function belongs to scf_op_definer, the migrator (no INHERIT) can no longer grant on it.
GRANT EXECUTE ON FUNCTION scf.op_projects(smallint,scf.tenant_status[],text),
  scf.op_web_metrics(timestamptz,timestamptz,text,text,scf.web_variant,uuid[],smallint),
  scf.op_web_breakdown(timestamptz,timestamptz,scf.web_dimension,scf.web_variant,uuid[],smallint,integer,text),
  scf.op_web_verdicts(timestamptz,timestamptz,uuid[],smallint),
  scf.op_api_metrics(timestamptz,timestamptz,text,text,uuid[],uuid[],smallint),
  scf.op_trust(timestamptz,timestamptz,uuid[],smallint), scf.op_api_assurance(timestamptz,timestamptz,uuid[],smallint),
  scf.op_onchain(timestamptz,timestamptz,uuid[],smallint)
  TO scf_app, scf_metrics_ro;
GRANT EXECUTE ON FUNCTION scf.op_metrics_document(text) TO scf_metrics_ro;
GRANT EXECUTE ON FUNCTION scf.op_tenant_detail(uuid),
  scf.op_audit_list(timestamptz,timestamptz,uuid,text,integer,timestamptz,uuid,bigint),
  scf.op_tenant_transition(uuid,text,text),
  scf.op_add_annotation(uuid,uuid,uuid,timestamptz,timestamptz,text,text[],boolean),
  scf.op_registry_link_decide(uuid,uuid,text), scf.op_resolve_domain_dispute(uuid,uuid,text),
  scf.op_approve_tenant_evidence(uuid,text), scf.op_lift_tombstone(uuid)
  TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'scf.op_authorize(text,boolean,boolean)', 'scf.op_begin(text,text,uuid[],jsonb,boolean,boolean,text)',
    'scf.op_eligible_tenants(smallint,uuid[],scf.tenant_status[])',
    'scf.op_projects(smallint,scf.tenant_status[],text)',
    'scf.op_web_metrics(timestamptz,timestamptz,text,text,scf.web_variant,uuid[],smallint)',
    'scf.op_web_breakdown(timestamptz,timestamptz,scf.web_dimension,scf.web_variant,uuid[],smallint,integer,text)',
    'scf.op_web_verdicts(timestamptz,timestamptz,uuid[],smallint)',
    'scf.op_api_metrics(timestamptz,timestamptz,text,text,uuid[],uuid[],smallint)',
    'scf.op_trust(timestamptz,timestamptz,uuid[],smallint)', 'scf.op_api_assurance(timestamptz,timestamptz,uuid[],smallint)',
    'scf.op_onchain(timestamptz,timestamptz,uuid[],smallint)', 'scf.op_metrics_document(text)', 'scf.op_tenant_detail(uuid)',
    'scf.op_audit_list(timestamptz,timestamptz,uuid,text,integer,timestamptz,uuid,bigint)',
    'scf.op_tenant_transition(uuid,text,text)',
    'scf.op_add_annotation(uuid,uuid,uuid,timestamptz,timestamptz,text,text[],boolean)',
    'scf.op_registry_link_decide(uuid,uuid,text)', 'scf.op_resolve_domain_dispute(uuid,uuid,text)',
    'scf.op_approve_tenant_evidence(uuid,text)', 'scf.op_lift_tombstone(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO scf_op_definer', f);
  END LOOP;
END $$;
-- op_authorize, op_begin and op_eligible_tenants are called only from inside op_* functions (as scf_op_definer); no grants.
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
