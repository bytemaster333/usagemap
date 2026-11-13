-- SPDX-License-Identifier: Apache-2.0
-- S-11 fallback test: our own daily aggregates (ADR-0011 / C-54 shape) built from Umami's tables, and the cost of
-- serving a 90-day dashboard from them. Run as the Umami DB owner in a throwaway schema s11.
\set ON_ERROR_STOP on
\timing on
DROP TABLE IF EXISTS s11.daily_totals, s11.daily_top;

-- totals per site, UTC day and tag (verified = 'v'; raw = all tags summed)
CREATE TABLE s11.daily_totals (
  website_id uuid, day date, tag text,
  pageviews bigint, visitors bigint, visits bigint, bounces bigint, totaltime bigint,
  PRIMARY KEY (website_id, day, tag));
-- top-100 values per site, day, tag and dimension (visitors = distinct sessions, as Umami's breakdowns count)
CREATE TABLE s11.daily_top (
  website_id uuid, day date, tag text, dim text, value text, pageviews bigint, visitors bigint);

\echo '== one-day incremental job (the most recent full day, all 300 sites) =='
SELECT (date_trunc('day', max(created_at)) - interval '1 day')::date AS d FROM website_event \gset
INSERT INTO s11.daily_totals
SELECT website_id, :'d'::date, tag, sum(c), count(DISTINCT session_id), count(*),
       sum(CASE WHEN c = 1 AND hc = 0 THEN 1 ELSE 0 END), sum(extract(epoch FROM max_t - min_t))::bigint
FROM (SELECT website_id, tag, session_id, visit_id,
             sum(CASE WHEN event_type NOT IN (2, 5) THEN 1 ELSE 0 END) c,
             max(CASE WHEN event_type = 2 THEN 1 ELSE 0 END) hc,
             min(created_at) min_t, max(created_at) max_t
      FROM website_event
      WHERE created_at >= :'d'::date AND created_at < :'d'::date + 1
      GROUP BY 1, 2, 3, 4) v
GROUP BY 1, 3;

INSERT INTO s11.daily_top
SELECT website_id, :'d'::date, tag, dim, value, pv, vis FROM (
  SELECT e.website_id, e.tag, d.dim, d.value, count(*) pv, count(DISTINCT e.session_id) vis,
         row_number() OVER (PARTITION BY e.website_id, e.tag, d.dim ORDER BY count(DISTINCT e.session_id) DESC) rn
  FROM website_event e JOIN session s ON s.session_id = e.session_id
  CROSS JOIN LATERAL (VALUES ('path', e.url_path), ('referrer', e.referrer_domain), ('country', s.country::text),
                             ('device', s.device), ('browser', s.browser), ('os', s.os),
                             ('event', CASE WHEN e.event_type = 2 THEN e.event_name END)) d(dim, value)
  WHERE e.created_at >= :'d'::date AND e.created_at < :'d'::date + 1 AND d.value IS NOT NULL AND d.value <> ''
  GROUP BY 1, 2, 3, 4) t
WHERE rn <= 100;

\echo '== backfill the other 89 days (totals only; top-N backfilled by copying the one-day shape is not needed for timing) =='
INSERT INTO s11.daily_totals
SELECT website_id, day, tag, sum(c), count(DISTINCT session_id), count(*),
       sum(CASE WHEN c = 1 AND hc = 0 THEN 1 ELSE 0 END), sum(extract(epoch FROM max_t - min_t))::bigint
FROM (SELECT website_id, created_at::date AS day, tag, session_id, visit_id,
             sum(CASE WHEN event_type NOT IN (2, 5) THEN 1 ELSE 0 END) c,
             max(CASE WHEN event_type = 2 THEN 1 ELSE 0 END) hc,
             min(created_at) min_t, max(created_at) max_t
      FROM website_event
      WHERE created_at < :'d'::date
      GROUP BY 1, 2, 3, 4, 5) v
GROUP BY 1, 2, 3;
-- replicate the one-day top-N rows to every other day so the read test scans a realistic 90-day volume
INSERT INTO s11.daily_top
SELECT t.website_id, g.day::date, t.tag, t.dim, t.value, t.pageviews, t.visitors
FROM s11.daily_top t
CROSS JOIN generate_series(:'d'::date - 89, :'d'::date - 1, interval '1 day') g(day);
CREATE INDEX ON s11.daily_top (website_id, dim, day);
ANALYZE s11.daily_totals; ANALYZE s11.daily_top;

SELECT pg_size_pretty(pg_total_relation_size('s11.daily_totals')) totals_size,
       pg_size_pretty(pg_total_relation_size('s11.daily_top')) top_size,
       (SELECT count(*) FROM s11.daily_top) top_rows;

\echo '== 90-day dashboard reads from the aggregates, largest site (verified = tag v) =='
SELECT website_id AS big FROM s11.sites WHERE idx = 1 \gset
SELECT sum(pageviews) pv, sum(visitors) visitor_days, sum(visits) visits, sum(bounces) bounces
FROM s11.daily_totals WHERE website_id = :'big' AND day >= :'d'::date - 89 AND tag = 'v';
SELECT day, sum(pageviews) FROM s11.daily_totals
WHERE website_id = :'big' AND day >= :'d'::date - 89 GROUP BY 1 ORDER BY 1 LIMIT 3;
SELECT value, sum(visitors) FROM s11.daily_top
WHERE website_id = :'big' AND dim = 'path' AND tag = 'v' AND day >= :'d'::date - 89
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
SELECT value, sum(visitors) FROM s11.daily_top
WHERE website_id = :'big' AND dim = 'country' AND day >= :'d'::date - 89
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
