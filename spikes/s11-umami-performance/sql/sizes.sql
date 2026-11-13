-- SPDX-License-Identifier: Apache-2.0
-- S-11 storage: table and index sizes for the 90-day window, and per-day growth.
\set ON_ERROR_STOP on
SELECT c.relname AS table, c.reltuples::bigint AS rows_est,
       pg_size_pretty(pg_table_size(c.oid)) AS heap_toast,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       round(pg_total_relation_size(c.oid)::numeric / greatest(c.reltuples, 1)) AS bytes_per_row_total
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('website_event', 'session')
ORDER BY pg_total_relation_size(c.oid) DESC;

SELECT indexrelid::regclass AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_index WHERE indrelid IN ('website_event'::regclass, 'session'::regclass)
ORDER BY pg_relation_size(indexrelid) DESC;

WITH d AS (SELECT count(DISTINCT created_at::date) - 1 AS days FROM website_event)  -- first/last day partial
SELECT pg_size_pretty(sum(pg_total_relation_size(r))) AS window_total,
       (SELECT days FROM d) + 1 AS calendar_days_touched,
       pg_size_pretty(sum(pg_total_relation_size(r)) / 90) AS per_day_growth_90d_window,
       pg_size_pretty(sum(pg_total_relation_size(r)) / 90 * 365) AS per_year_if_kept
FROM unnest(ARRAY['website_event'::regclass, 'session'::regclass]) r;

SELECT pg_size_pretty(pg_database_size('umami')) AS database_size;
