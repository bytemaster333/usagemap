-- SPDX-License-Identifier: Apache-2.0
-- Generates one 24-hour slice [t0 - (k+1) days, t0 - k days) of synthetic Umami data for all sites in s11.sites.
-- psql variables: k (0..89), t0 (timestamptz, end of the window, hour-aligned).
-- Columns and value conventions follow what Umami 3.5.0 itself writes through /api/send (probed in run.sh setup):
--   url_query '' when absent; direct visit -> referrer_* NULL; external referrer -> referrer_path '/', referrer_query '',
--   referrer_domain host without www; internal navigation -> referrer_path set, referrer_domain NULL.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL synchronous_commit = off;
SET LOCAL work_mem = '256MB';

SELECT (:'t0'::timestamptz - (:k + 1) * interval '1 day') AS slice_start \gset

CREATE TEMP TABLE sess ON COMMIT DROP AS
SELECT x.*,
       CASE WHEN x.ts0 < :'slice_start'::timestamptz THEN x.ts0 + interval '1 day'
            WHEN x.ts0 >= :'slice_start'::timestamptz + interval '1 day' THEN x.ts0 - interval '1 day'
            ELSE x.ts0 END AS start_ts
FROM (
  SELECT st.website_id, st.domain, st.npaths,
         gen_random_uuid() AS session_id,
         -- diurnal profile: time of day ~ N(14:00 UTC, 5 h), wrapped into the slice
         date_trunc('day', :'slice_start'::timestamptz)
           + make_interval(secs => mod(abs(random_normal(50400, 18000))::numeric, 86400)::double precision) AS ts0,
         -- events per session: geometric, P(1)=0.4, mean 2.5, capped at 50
         least(50, 1 + floor(ln(1 - random()) / ln(0.6)))::int AS nev,
         CASE WHEN random() < 0.15 THEN 's' ELSE 'v' END AS tag,
         CASE WHEN random() < 0.45 THEN NULL
              WHEN random() < 0.7 THEN (ARRAY['google.com','bing.com','duckduckgo.com','github.com','t.co','reddit.com',
                                              'news.ycombinator.com','linkedin.com','facebook.com','stellar.org'])
                                         [1 + floor(random() ^ 2 * 10)::int]
              ELSE 'blog' || (1 + floor(random() ^ 2 * 500)::int) || '.example' END AS ref_domain,
         CASE WHEN random() < 0.05 THEN (ARRAY['newsletter','twitter','partner','reddit'])[1 + floor(random() * 4)::int] END AS utm,
         (ARRAY['chrome','safari','ios','firefox','edge-chromium','samsung','opera','chromium-webview','android','crios'])
           [1 + floor(random() ^ 2 * 10)::int] AS browser,
         (ARRAY['Windows 10','Mac OS','iOS','Android OS','Linux','Chrome OS'])[1 + floor(random() ^ 1.5 * 6)::int] AS os,
         (ARRAY['desktop','laptop','mobile','tablet'])[1 + floor(random() ^ 1.3 * 4)::int] AS device,
         (ARRAY['1920x1080','1536x864','390x844','1440x900','2560x1440','412x915','1366x768','768x1024'])
           [1 + floor(random() ^ 2 * 8)::int] AS screen,
         (ARRAY['en-US','de-DE','fr-FR','es-ES','pt-BR','en-GB','nl-NL','ja-JP','it-IT','pl-PL'])
           [1 + floor(random() ^ 2 * 10)::int] AS language,
         c.country,
         c.country || '-' || (1 + floor(random() ^ 2 * 12)::int) AS region,
         'City ' || (1 + floor(random() ^ 2 * 300)::int) AS city
  FROM s11.sites st
  CROSS JOIN LATERAL generate_series(
      1,
      greatest(1, round(st.pv_day
                        * CASE WHEN extract(isodow FROM :'slice_start'::timestamptz + interval '12 hours') >= 6
                               THEN 0.8 ELSE 1.08 END
                        / 2.375))::int) AS j
  CROSS JOIN LATERAL (
      SELECT (ARRAY['US','DE','GB','FR','IN','BR','NL','CA','ES','IT','PL','JP','NG','AR','TR','SE','AU','MX','KR','ID'])
               [1 + floor(random() ^ 2 * 20)::int] AS country, j AS _j   -- reference j so it is evaluated per row
  ) c
) x;

INSERT INTO session (session_id, website_id, browser, os, device, screen, language, country, region, city,
                     distinct_id, created_at)
SELECT session_id, website_id, browser, os, device, screen, language, country, region, city, NULL, start_ts
FROM sess
WHERE start_ts < :'t0'::timestamptz
ORDER BY start_ts;

INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, url_query,
                           utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                           referrer_path, referrer_query, referrer_domain, page_title,
                           event_type, event_name, tag, hostname)
SELECT gen_random_uuid(), e.website_id, e.session_id,
       md5(e.session_id::text || date_trunc('hour', e.ets)::text)::uuid,
       e.ets,
       e.path,
       CASE WHEN e.n = 1 AND e.utm IS NOT NULL THEN 'utm_source=' || e.utm ELSE '' END,
       CASE WHEN e.n = 1 THEN e.utm END,
       CASE WHEN e.n = 1 AND e.utm IS NOT NULL THEN 'social' END,
       CASE WHEN e.n = 1 AND e.utm IS NOT NULL THEN 'launch' END,
       NULL, NULL,
       CASE WHEN e.n = 1 AND e.ref_domain IS NULL THEN NULL WHEN e.n = 1 THEN '/' ELSE e.prev_path END,
       CASE WHEN e.n = 1 AND e.ref_domain IS NULL THEN NULL ELSE '' END,
       CASE WHEN e.n = 1 THEN e.ref_domain END,
       CASE WHEN e.path = '/' THEN 'Home' ELSE 'Page ' || substr(e.path, 7) END,
       e.etype,
       CASE WHEN e.etype = 2 THEN (ARRAY['signup','cta-click','download','wallet-connect','outbound-link'])
                                     [1 + floor(random() ^ 1.5 * 5)::int] END,
       e.tag,
       e.domain
FROM (
  SELECT s.website_id, s.session_id, s.tag, s.ref_domain, s.utm, s.domain, g.n,
         s.start_ts + make_interval(secs => (g.n - 1) * 40 + random() * 30) AS ets,
         CASE WHEN p.pi = 0 THEN '/' ELSE '/page-' || p.pi END AS path,
         CASE WHEN p.pp = 0 THEN '/' ELSE '/page-' || p.pp END AS prev_path,
         CASE WHEN random() < 0.05 THEN 2 ELSE 1 END AS etype
  FROM sess s
  CROSS JOIN LATERAL generate_series(1, s.nev) AS g(n)
  CROSS JOIN LATERAL (
      SELECT floor(random() ^ 3 * s.npaths)::int AS pi, floor(random() ^ 3 * s.npaths)::int AS pp, g.n AS _n
  ) p
) e
WHERE e.ets < :'t0'::timestamptz
ORDER BY e.ets;

COMMIT;
