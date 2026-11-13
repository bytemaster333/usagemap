-- SPDX-License-Identifier: Apache-2.0
-- S-11 side experiment: would one extra covering index (not part of Umami's schema) make the stats query
-- index-only for large tenants? Runs Umami's unfiltered getWebsiteStats SQL (src/queries/sql/getWebsiteStats.ts,
-- relational branch) before and after the index. The index is dropped at the end. psql variable: t0.
\set ON_ERROR_STOP on
SELECT website_id AS big FROM s11.sites WHERE idx = 1 \gset
SELECT website_id AS mid FROM s11.sites WHERE idx = 10 \gset

PREPARE stats(uuid, timestamptz, interval) AS
select cast(coalesce(sum(t.c), 0) as bigint) pageviews, count(distinct t.session_id) visitors,
       count(distinct t.visit_id) visits,
       coalesce(sum(case when t.c = 1 and t.has_custom_event = 0 then 1 else 0 end), 0) bounces
from (select session_id, visit_id,
             sum(case when event_type not in (2, 5) then 1 else 0 end) c,
             min(case when event_type not in (2, 5) then created_at end) min_time,
             max(case when event_type not in (2, 5) then created_at end) max_time,
             max(case when event_type = 2 then 1 else 0 end) has_custom_event
      from website_event
      where website_id = $1 and created_at between $2 - $3 and $2 and event_type != 5
      group by 1, 2
      having sum(case when event_type not in (2, 5) then 1 else 0 end) > 0) t;

\timing on
\echo '== before: largest site 7 d, 30 d; medium site 30 d (each twice; second run = warm) =='
EXECUTE stats(:'big', :'t0', '7 days'); EXECUTE stats(:'big', :'t0', '7 days');
EXECUTE stats(:'big', :'t0', '30 days'); EXECUTE stats(:'big', :'t0', '30 days');
EXECUTE stats(:'mid', :'t0', '30 days'); EXECUTE stats(:'mid', :'t0', '30 days');

\echo '== building covering index =='
CREATE INDEX s11_cover ON website_event (website_id, created_at) INCLUDE (session_id, visit_id, event_type, tag);
VACUUM website_event;
\timing off
SELECT pg_size_pretty(pg_relation_size('s11_cover')) AS covering_index_size;
\timing on

\echo '== after: largest site 7 d, 30 d, 90 d; medium site 30 d, 90 d (each twice) =='
EXECUTE stats(:'big', :'t0', '7 days'); EXECUTE stats(:'big', :'t0', '7 days');
EXECUTE stats(:'big', :'t0', '30 days'); EXECUTE stats(:'big', :'t0', '30 days');
EXECUTE stats(:'big', :'t0', '90 days'); EXECUTE stats(:'big', :'t0', '90 days');
EXECUTE stats(:'mid', :'t0', '30 days'); EXECUTE stats(:'mid', :'t0', '30 days');
EXECUTE stats(:'mid', :'t0', '90 days'); EXECUTE stats(:'mid', :'t0', '90 days');
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) EXECUTE stats(:'big', :'t0', '30 days');

DROP INDEX s11_cover;
