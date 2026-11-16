// SPDX-License-Identifier: Apache-2.0
// The rollup SQL over Umami's data — the ONLY SQL read of Umami data by our code (wire-formats §j.5, data-model §16.3).
// It reads the two read-only views `scf_ro.website_event` and `scf_ro.session` as role scf_umami_ro, always bounded by
// `website_id = ANY(main, twin)` and a half-open UTC `created_at` range, so the planner uses Umami's
// (website_id, created_at) indexes.
//
// Semantics reproduce Umami 3.5.0's own queries (S-01 §4; src/queries/sql/getWebsiteStats.ts,
// pageviews/getPageviewExpandedMetrics.ts, sessions/getSessionExpandedMetrics.ts, events/getEventMetrics.ts at commit
// d3c62a8) under the reporting rules of C-73 (data-model §8.9):
// - a page view is an event with event_type = 1, a custom or wallet event has event_type = 2 (the gateway sends nothing
//   else; other types are counted as an anomaly and otherwise ignored);
// - visits are groups (session_id, visit_id) of the MAIN website with at least one page view; a bounce is a visit
//   with exactly one page view and no custom event; duration = Σ per visit of floor(last − first page view) seconds;
//   computed once over all identified, non-rejected events (tags v and s) — never per tag (C-73);
// - visitors = distinct sessions of the main website with at least one page view (verified: one tagged `v`);
// - page views and events add the main and the twin website; the twin never contributes visitors or visits.

/** Daily totals of one site: $1 main id, $2 [main, twin] ids, $3 start, $4 end. */
export const TOTALS_SQL = `
WITH e AS MATERIALIZED (
  SELECT x.website_id = $1::uuid AS main, x.session_id, x.visit_id, x.created_at, x.event_type,
         x.tag IS NOT DISTINCT FROM 'v' AS v
    FROM scf_ro.website_event x
   WHERE x.website_id = ANY ($2::uuid[]) AND x.created_at >= $3 AND x.created_at < $4),
visit AS (
  SELECT e.session_id, e.visit_id,
         count(*) FILTER (WHERE e.event_type = 1) AS pv,
         bool_or(e.event_type = 2) AS has_custom,
         min(e.created_at) FILTER (WHERE e.event_type = 1) AS t0,
         max(e.created_at) FILTER (WHERE e.event_type = 1) AS t1
    FROM e WHERE e.main
   GROUP BY e.session_id, e.visit_id)
SELECT
  (SELECT count(*) FILTER (WHERE event_type = 1 AND v) FROM e)                AS pageviews_verified,
  (SELECT count(*) FILTER (WHERE event_type = 1) FROM e)                      AS pageviews_raw,
  (SELECT count(*) FILTER (WHERE event_type = 1 AND v AND NOT main) FROM e)   AS pageviews_unidentified_verified,
  (SELECT count(*) FILTER (WHERE event_type = 1 AND NOT main) FROM e)         AS pageviews_unidentified_raw,
  (SELECT count(DISTINCT session_id) FILTER (WHERE main AND event_type = 1 AND v) FROM e) AS visitors_verified,
  (SELECT count(DISTINCT session_id) FILTER (WHERE main AND event_type = 1) FROM e)       AS visitors_raw,
  (SELECT count(DISTINCT visit_id) FROM visit WHERE pv > 0)                               AS visits,
  (SELECT count(*) FROM visit WHERE pv = 1 AND NOT has_custom)                            AS bounces,
  (SELECT COALESCE(sum(floor(extract(epoch FROM t1 - t0))), 0) FROM visit WHERE pv > 0)   AS total_duration_s,
  (SELECT count(*) FROM e)                                                                AS events_raw,
  (SELECT count(*) FILTER (WHERE event_type NOT IN (1, 2)) FROM e)                        AS unexpected_types`;

/** Hourly page views and visitors of one site and day: parameters as TOTALS_SQL. Only hours with events. */
export const HOURLY_SQL = `
SELECT date_trunc('hour', x.created_at, 'UTC') AS hour_start,
       count(*) FILTER (WHERE x.event_type = 1 AND x.tag = 'v')                              AS pageviews_verified,
       count(*) FILTER (WHERE x.event_type = 1)                                              AS pageviews_raw,
       count(*) FILTER (WHERE x.event_type = 1 AND x.tag = 'v' AND x.website_id <> $1::uuid) AS pageviews_unidentified_verified,
       count(*) FILTER (WHERE x.event_type = 1 AND x.website_id <> $1::uuid)                 AS pageviews_unidentified_raw,
       count(DISTINCT x.session_id) FILTER (WHERE x.website_id = $1::uuid AND x.event_type = 1 AND x.tag = 'v') AS visitors_verified,
       count(DISTINCT x.session_id) FILTER (WHERE x.website_id = $1::uuid AND x.event_type = 1)                 AS visitors_raw,
       count(*)                                                                              AS events_raw
  FROM scf_ro.website_event x
 WHERE x.website_id = ANY ($2::uuid[]) AND x.created_at >= $3 AND x.created_at < $4
 GROUP BY 1
 ORDER BY 1`;

/**
 * Per-value counts of every breakdown dimension for one site and day (parameters as TOTALS_SQL). Page-view
 * dimensions (referrer host, country, device, browser, OS, normalised path) count page views; `event` counts
 * custom/wallet events by name. Empty and NULL values make no row (Umami: `name != ''`); direct visits have no
 * referrer. Session attributes come from the event's own session row (same website, Umami's join).
 */
export const BREAKDOWN_SQL = `
WITH e AS (
  SELECT x.website_id = $1::uuid AS main, x.session_id, x.visit_id, x.event_type,
         x.tag IS NOT DISTINCT FROM 'v' AS v,
         x.url_path, x.referrer_domain, x.event_name, s.country, s.device, s.browser, s.os
    FROM scf_ro.website_event x
    LEFT JOIN scf_ro.session s ON s.session_id = x.session_id AND s.website_id = x.website_id
   WHERE x.website_id = ANY ($2::uuid[]) AND x.created_at >= $3 AND x.created_at < $4
     AND x.event_type IN (1, 2))
SELECT d.dimension, d.value,
       count(*) FILTER (WHERE e.event_type = 1)                                    AS pageviews_raw,
       count(*) FILTER (WHERE e.event_type = 1 AND e.v)                            AS pageviews_verified,
       count(DISTINCT e.session_id) FILTER (WHERE e.main AND e.event_type = 1)     AS visitors_raw,
       count(DISTINCT e.session_id) FILTER (WHERE e.main AND e.event_type = 1 AND e.v) AS visitors_verified,
       count(DISTINCT e.visit_id) FILTER (WHERE e.main AND e.event_type = 1)       AS visits_raw,
       count(*) FILTER (WHERE e.event_type = 2)                                    AS events_raw,
       count(*) FILTER (WHERE e.event_type = 2 AND e.v)                            AS events_verified,
       count(DISTINCT e.session_id) FILTER (WHERE e.main AND e.event_type = 2)     AS event_visitors_raw,
       count(DISTINCT e.session_id) FILTER (WHERE e.main AND e.event_type = 2 AND e.v) AS event_visitors_verified
  FROM e
 CROSS JOIN LATERAL (VALUES
   ('referrer', CASE WHEN e.event_type = 1 THEN e.referrer_domain END),
   ('country',  CASE WHEN e.event_type = 1 THEN e.country::text END),
   ('device',   CASE WHEN e.event_type = 1 THEN e.device END),
   ('browser',  CASE WHEN e.event_type = 1 THEN e.browser END),
   ('os',       CASE WHEN e.event_type = 1 THEN e.os END),
   ('path',     CASE WHEN e.event_type = 1 THEN e.url_path END),
   ('event',    CASE WHEN e.event_type = 2 THEN e.event_name END)) AS d (dimension, value)
 WHERE d.value IS NOT NULL AND d.value <> '' AND char_length(d.value) <= 500
 GROUP BY d.dimension, d.value`;
