-- Source: docs/data-model.md, block '-- migration: 0018_web' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0018_web
CREATE TABLE scf.web_edge_counters (
  tenant_id  uuid   NOT NULL,
  site_id    uuid   NOT NULL,
  day        date   NOT NULL,
  counter    text   NOT NULL CHECK (counter IN ('verdict','reason','asn_class','client_signal','pow_latency','multiplicity','identifier','kit_present_pageviews','drop')),
  label      text   NOT NULL CHECK (label ~ '^[a-z0-9_]{1,40}$'),
  count      bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (tenant_id, site_id, day, counter, label),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE
);

-- One row per site and UTC day (C-73): verified and raw page views and visitors side by side; visit metrics once.
-- Source: the scf_ro view over Umami's tables (C-109, §16.3); semantics of the reporting-rules table above.
CREATE TABLE scf.web_daily_totals (
  tenant_id                        uuid   NOT NULL,
  site_id                          uuid   NOT NULL,
  day                              date   NOT NULL,
  pageviews_verified               bigint NOT NULL CHECK (pageviews_verified >= 0),   -- v on main + v on twin
  pageviews_raw                    bigint NOT NULL CHECK (pageviews_raw >= 0),        -- all on main + all on twin
  pageviews_unidentified_verified  bigint NOT NULL CHECK (pageviews_unidentified_verified >= 0),  -- v on twin
  pageviews_unidentified_raw       bigint NOT NULL CHECK (pageviews_unidentified_raw >= 0),       -- all on twin
  visitors_verified                bigint NOT NULL CHECK (visitors_verified >= 0),    -- main, tag=v
  visitors_raw                     bigint NOT NULL CHECK (visitors_raw >= 0),         -- main, unfiltered
  visits                           bigint NOT NULL CHECK (visits >= 0),               -- main, unfiltered (only figure)
  bounces                          bigint NOT NULL CHECK (bounces >= 0),              -- main, unfiltered
  total_duration_s                 bigint NOT NULL CHECK (total_duration_s >= 0),     -- main, unfiltered; avg = total / visits
  events_raw                       bigint NOT NULL CHECK (events_raw >= 0),           -- C-109: all engine events (page views + custom/wallet) of main + twin; live-window input
  is_final                         boolean NOT NULL,
  engine_version                   text NOT NULL,                                     -- e.g. 'umami/3.5.0'
  computed_at                      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, day),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE,
  CHECK (pageviews_verified <= pageviews_raw),
  CHECK (pageviews_unidentified_verified <= pageviews_unidentified_raw),
  CHECK (pageviews_unidentified_verified <= pageviews_verified AND pageviews_unidentified_raw <= pageviews_raw),
  CHECK (visitors_verified <= visitors_raw),
  CHECK (bounces <= visits),
  CHECK (events_raw >= pageviews_raw)
);
CREATE INDEX web_daily_totals_day ON scf.web_daily_totals (day);

-- C-109: hourly page views and visitors per site (the 7-day hourly chart and the previous day before it is final).
-- Visitors per hour = distinct sessions of the main website with ≥ 1 page view in that hour (verified: tagged v) —
-- what Umami's /pageviews returns as `sessions` per hour bucket. Visit metrics are daily only (C-73, C-109): time
-- series of visits, bounces, bounce rate and duration exist for unit=day|month only (C-112(4)).
-- Monthly partitions, kept 25 months like api_metrics_1h (§10, §14).
CREATE TABLE scf.web_hourly_totals (
  tenant_id                        uuid        NOT NULL,
  site_id                          uuid        NOT NULL,
  hour_start                       timestamptz NOT NULL,
  pageviews_verified               bigint      NOT NULL CHECK (pageviews_verified >= 0),
  pageviews_raw                    bigint      NOT NULL CHECK (pageviews_raw >= 0),
  pageviews_unidentified_verified  bigint      NOT NULL CHECK (pageviews_unidentified_verified >= 0),
  pageviews_unidentified_raw       bigint      NOT NULL CHECK (pageviews_unidentified_raw >= 0),
  visitors_verified                bigint      NOT NULL CHECK (visitors_verified >= 0),
  visitors_raw                     bigint      NOT NULL CHECK (visitors_raw >= 0),
  events_raw                       bigint      NOT NULL CHECK (events_raw >= 0),
  computed_at                      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, hour_start),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE,
  CHECK (hour_start = date_trunc('hour', hour_start, 'UTC')),
  CHECK (pageviews_verified <= pageviews_raw AND pageviews_unidentified_verified <= pageviews_unidentified_raw),
  CHECK (pageviews_unidentified_raw <= pageviews_raw AND visitors_verified <= visitors_raw),
  CHECK (events_raw >= pageviews_raw)
) PARTITION BY RANGE (hour_start);
CREATE INDEX web_hourly_totals_time ON scf.web_hourly_totals (hour_start);

-- Top-N per dimension and variant (web_breakdown_top_n rows, ranked by visitors — events for 'event' — then value).
-- Values reduced at ingest: referrer host (Umami referrer_domain; direct visits have none and make no row); ISO
-- country or 'XX'; engine device/browser/os labels (session attributes); normalised path (pathnorm, C-52); event
-- name (custom and wallet events, event_type = 2).
-- verified rows: pageviews/events tag=v (main + twin), visitors tag=v (main); visits NULL (no verified variant, C-73).
-- raw rows: pageviews/events unfiltered (main + twin), visitors and visits unfiltered (main only).
-- visitors per value = distinct sessions with ≥ 1 matching page view (Umami's breakdown `y`, S-01); visits per value
-- = (session_id, visit_id) groups with ≥ 1 matching page view.
CREATE TABLE scf.web_daily_breakdowns (
  tenant_id   uuid   NOT NULL,
  site_id     uuid   NOT NULL,
  day         date   NOT NULL,
  variant     scf.web_variant NOT NULL,
  dimension   scf.web_dimension NOT NULL,
  value       text   NOT NULL CHECK (char_length(value) BETWEEN 1 AND 500),
  rank        smallint NOT NULL CHECK (rank >= 1),
  visitors    bigint CHECK (visitors >= 0),
  pageviews   bigint CHECK (pageviews >= 0),
  visits      bigint CHECK (visits >= 0),
  events      bigint CHECK (events >= 0),
  PRIMARY KEY (tenant_id, site_id, day, variant, dimension, value),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE,
  CHECK ((dimension = 'event') = (events IS NOT NULL)),
  CHECK (variant = 'raw' OR visits IS NULL)
);
CREATE INDEX web_daily_breakdowns_day ON scf.web_daily_breakdowns (day, dimension);

CALL scf_admin.apply_tenant_rls('scf.web_edge_counters', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT}',
  '{"SELECT":["trust_scoring","edge_snapshot","retention","tenant_purge"],"DELETE":["retention","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.web_daily_totals', '{SELECT}', '{}', '{SELECT}',
  '{"SELECT":["web_rollup","trust_scoring","erasure","public_metrics","tenant_purge"],"INSERT":["web_rollup","erasure"],
    "UPDATE":["web_rollup","erasure"],"DELETE":["web_rollup","erasure","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.web_daily_breakdowns', '{SELECT}', '{}', '{SELECT}',
  '{"SELECT":["web_rollup","trust_scoring","erasure","tenant_purge"],"INSERT":["web_rollup","erasure"],
    "UPDATE":["web_rollup","erasure"],"DELETE":["web_rollup","erasure","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.web_hourly_totals', '{SELECT}', '{}', '{}',
  '{"SELECT":["web_rollup","tenant_purge"],"INSERT":["web_rollup"],"UPDATE":["web_rollup"],"DELETE":["web_rollup","tenant_purge"]}');

-- C-109: the site's live window in UTC days (≥ 1, ≤ LEAST(web_live_window_max_days, effective event retention)).
-- Invoker function: called by the control plane under the tenant's context, so RLS applies.
CREATE FUNCTION scf.web_live_window_days(p_tenant uuid, p_site uuid) RETURNS integer LANGUAGE sql STABLE
  AS $$
  WITH h AS (
    SELECT count(*) AS n, avg(d.events_raw) AS avg_events
      FROM (SELECT x.events_raw FROM scf.web_daily_totals x
             WHERE x.tenant_id = p_tenant AND x.site_id = p_site
               AND x.day < (pg_catalog.now() AT TIME ZONE 'UTC')::date
             ORDER BY x.day DESC LIMIT 28) d),
  -- C-112(6): today's events so far, projected to a full day (elapsed time at least one hour)
  t AS (
    SELECT count(*) AS n, COALESCE(sum(y.events_raw), 0) * 86400.0
             / GREATEST(extract(epoch FROM pg_catalog.now() - date_trunc('day', pg_catalog.now(), 'UTC')), 3600) AS projected
      FROM scf.web_hourly_totals y
     WHERE y.tenant_id = p_tenant AND y.site_id = p_site
       AND y.hour_start >= date_trunc('day', pg_catalog.now(), 'UTC')),
  r AS (
    SELECT h.n + t.n AS n, GREATEST(COALESCE(h.avg_events, 0), t.projected) AS rate FROM h, t),
  cap AS (
    SELECT LEAST(scf.setting_int('web_live_window_max_days'),
                 LEAST(COALESCE(s.event_retention_days, 395), scf.setting_int('web_event_retention_days'))) AS max_days
      FROM scf.sites s WHERE s.tenant_id = p_tenant AND s.site_id = p_site)
  SELECT GREATEST(1, LEAST(cap.max_days,
           CASE WHEN r.n = 0 THEN 1
                WHEN r.rate = 0 THEN cap.max_days
                ELSE floor(scf.setting_int('web_live_events_budget') / r.rate)::integer END))
    FROM r, cap
  $$;
GRANT EXECUTE ON FUNCTION scf.web_live_window_days(uuid, uuid) TO scf_app, scf_jobs;
