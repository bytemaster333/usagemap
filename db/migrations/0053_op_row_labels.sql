-- Source: docs/data-model.md, block '-- migration: 0053_op_row_labels' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0053_op_row_labels
-- C-119: op_web_metrics, op_web_breakdown, op_trust and op_api_metrics return the tenant's `slug` (and op_api_metrics
-- the `service_name`) in every row, as the last columns, so the console and the operator metrics API label rows
-- without a second audited read (op_projects needs registry:read, op_tenant_detail is console-only). A slug or
-- service name is a label of a row the caller may already read; the audit row (one per call) is unchanged. With
-- p_group = 'all' the labels are NULL; op_api_metrics' service_name is NULL unless grouped by service or route.
-- The return type changes, so each function is dropped by its owner and created again (grants, owner as in 0040).
SET LOCAL ROLE scf_op_definer;
DROP FUNCTION scf.op_web_metrics(timestamptz, timestamptz, text, text, scf.web_variant, uuid[], smallint);
DROP FUNCTION scf.op_web_breakdown(timestamptz, timestamptz, scf.web_dimension, scf.web_variant, uuid[], smallint, integer, text);
DROP FUNCTION scf.op_trust(timestamptz, timestamptz, uuid[], smallint);
DROP FUNCTION scf.op_api_metrics(timestamptz, timestamptz, text, text, uuid[], uuid[], smallint);
RESET ROLE;

CREATE FUNCTION scf.op_web_metrics(p_start timestamptz, p_end timestamptz, p_bucket text DEFAULT 'day',
                                   p_group text DEFAULT 'tenant', p_variant scf.web_variant DEFAULT 'verified',
                                   p_tenants uuid[] DEFAULT NULL, p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, site_id uuid, day date, verification_level smallint,
                 pageviews bigint, pageviews_unidentified bigint, visitors_sum bigint, visits bigint, bounces bigint,
                 bounce_rate_pct numeric, avg_visit_duration_s numeric, suspect_pageview_share numeric,
                 all_final boolean, suppressed boolean, slug text)
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
             b.f, false,
             (SELECT t.slug FROM scf.tenants t WHERE t.tenant_id = b.tenant_id)
        FROM b;
  END $$;

CREATE FUNCTION scf.op_web_breakdown(p_start timestamptz, p_end timestamptz, p_dimension scf.web_dimension,
                                     p_variant scf.web_variant DEFAULT 'verified', p_tenants uuid[] DEFAULT NULL,
                                     p_min_level smallint DEFAULT 1, p_limit int DEFAULT 50, p_group text DEFAULT 'tenant')
  RETURNS TABLE (tenant_id uuid, value text, visitors_sum bigint, pageviews bigint, events bigint, suppressed boolean,
                 slug text)
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
      SELECT r.tenant_id, r.value, scf.op_count(r.vis), scf.op_count(r.pv), scf.op_count(r.ev), false,
             (SELECT t.slug FROM scf.tenants t WHERE t.tenant_id = r.tenant_id)
        FROM r WHERE r.rn <= p_limit AND COALESCE(r.vis, r.ev) >= k
       ORDER BY r.tenant_id, r.rn;
  END $$;

CREATE FUNCTION scf.op_api_metrics(p_start timestamptz, p_end timestamptz, p_bucket text DEFAULT 'day',
                                   p_group text DEFAULT 'service', p_tenants uuid[] DEFAULT NULL,
                                   p_services uuid[] DEFAULT NULL, p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, service_id uuid, route text, rpc_method text, bucket_start timestamptz,
                 verification_level smallint, requests bigint, status_2xx bigint, status_3xx bigint, status_4xx bigint,
                 status_5xx bigint, status_unknown bigint, error_rate_5xx numeric, mean_s float8,
                 p50_s float8, p95_s float8, p99_s float8, accuracy_class text, suppressed boolean,
                 slug text, service_name text)
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
             false,
             (SELECT t.slug FROM scf.tenants t WHERE t.tenant_id = g.tenant_id),
             (SELECT a.service_name FROM scf.api_services a WHERE a.tenant_id = g.tenant_id AND a.service_id = g.service_id)
        FROM g LEFT JOIN scf.api_routes r ON r.tenant_id = g.tenant_id AND r.route_id = g.route_id;
  END $$;

CREATE FUNCTION scf.op_trust(p_start timestamptz, p_end timestamptz, p_tenants uuid[] DEFAULT NULL,
                             p_min_level smallint DEFAULT 1)
  RETURNS TABLE (tenant_id uuid, site_id uuid, day date, window_days smallint, score smallint, components jsonb,
                 reason_codes text[], decision_rate numeric, algorithm_version text, slug text)
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
             s.algorithm_version,
             t.slug
        FROM scf.web_trust_scores s JOIN scf.op_eligible_tenants(p_min_level, v_t) e ON e.tenant_id = s.tenant_id
        JOIN scf.tenants t ON t.tenant_id = s.tenant_id
       WHERE s.day >= d0 AND s.day < d1;
  END $$;

-- C-114: grants first, then the owner (the migrator cannot grant on a function it no longer owns).
GRANT EXECUTE ON FUNCTION
  scf.op_web_metrics(timestamptz,timestamptz,text,text,scf.web_variant,uuid[],smallint),
  scf.op_web_breakdown(timestamptz,timestamptz,scf.web_dimension,scf.web_variant,uuid[],smallint,integer,text),
  scf.op_api_metrics(timestamptz,timestamptz,text,text,uuid[],uuid[],smallint),
  scf.op_trust(timestamptz,timestamptz,uuid[],smallint)
  TO scf_app, scf_metrics_ro;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'scf.op_web_metrics(timestamptz,timestamptz,text,text,scf.web_variant,uuid[],smallint)',
    'scf.op_web_breakdown(timestamptz,timestamptz,scf.web_dimension,scf.web_variant,uuid[],smallint,integer,text)',
    'scf.op_api_metrics(timestamptz,timestamptz,text,text,uuid[],uuid[],smallint)',
    'scf.op_trust(timestamptz,timestamptz,uuid[],smallint)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO scf_op_definer', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
