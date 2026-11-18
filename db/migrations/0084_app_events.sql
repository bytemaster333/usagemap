-- Source: docs/data-model.md, block '-- migration: 0084_app_events' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0084_app_events
-- Self-attested app events (integration wave I1, agent M; wire-formats §a.9, §d.3 `app`): daily counts of named
-- events that native apps (React Native, Expo, Flutter, Swift, Kotlin) and Telegram Mini Apps send to the edge's
-- `POST /v1/app-events` with the site's public key. An app cannot run the browser proof of work, so NOTHING here is
-- verified: every row is `self_attested` by construction, and these rows are never read by the web metrics, the
-- verified-event quota, trust scoring, public metrics, traction snapshots or the Usage Map. No session id, device id,
-- install id, IP address, User-Agent or timestamp finer than the UTC day is stored.
--
-- Cells (wire-formats §a.9): per accepted event `<name>/_total/all` and one `<name>/<key>/<value>` per property;
-- per distinct session of the day on an edge node `_session/_total/all`, `_session/app_version/<x.y.z>`,
-- `_session/sdk_version/<sdk>/<x.y.z>` and, for a Mini App, `_session/tma_platform/<class>`; per dropped event
-- `_dropped/reason/<unsafe|value_shape|stale|cardinality>`. Filled by the internal counter endpoint from the `app`
-- array of counter records as INSERT … ON CONFLICT DO UPDATE SET count = count + EXCLUDED.count. A tenant purge
-- removes the rows through the cascade from scf.sites (deleted by tenant_purge under the tenant's context). Kept
-- for the site's life, like web_event_property_daily (no retention rule).
CREATE TABLE scf.app_event_daily (
  tenant_id    uuid   NOT NULL,
  site_id      uuid   NOT NULL,
  day          date   NOT NULL,
  platform     text   NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  event_name   text   NOT NULL CHECK (event_name IN ('_session', '_dropped')
                                       OR event_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$'),
  prop_key     text   NOT NULL,
  prop_value   text   NOT NULL,
  attestation  text   NOT NULL DEFAULT 'self_attested' CHECK (attestation = 'self_attested'),
  count        bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (tenant_id, site_id, day, platform, event_name, prop_key, prop_value),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE,
  CONSTRAINT app_event_daily_cell CHECK (CASE
    WHEN event_name = '_session' THEN CASE prop_key
      WHEN '_total'       THEN prop_value = 'all'
      WHEN 'app_version'  THEN prop_value ~ '^[0-9]{1,6}(\.[0-9]{1,6}){0,3}$'
      WHEN 'sdk_version'  THEN prop_value ~ '^[a-z][a-z0-9-]{0,23}/[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'
      WHEN 'tma_platform' THEN prop_value IN ('android', 'ios', 'macos', 'desktop', 'web', 'other')
      ELSE false END
    WHEN event_name = '_dropped' THEN prop_key = 'reason'
      AND prop_value IN ('unsafe', 'value_shape', 'stale', 'cardinality')
    WHEN prop_key = '_total' THEN prop_value = 'all'
    ELSE prop_key ~ '^[a-z][a-z0-9_]{0,31}$' AND prop_value ~ '^[a-z][a-z0-9_]{0,31}$' END)
);
CREATE INDEX app_event_daily_day ON scf.app_event_daily (day);   -- maintenance index
-- The tenant reads its own rows and the internal counter endpoint (scf_app, actor_kind system) adds them.
CALL scf_admin.apply_tenant_rls('scf.app_event_daily', '{SELECT,INSERT,UPDATE}', '{}', '{}', '{}');

-- The optional counter-record part `app` is accepted once every control plane runs this release; the operator then
-- adds "app" to edge_counter_features (C-137 upgrade rule, wire-formats §d.3).
ALTER TABLE scf.settings DROP CONSTRAINT settings_edge_counter_features;
ALTER TABLE scf.settings ADD CONSTRAINT settings_edge_counter_features
  CHECK (key <> 'edge_counter_features' OR (jsonb_typeof(value) = 'array' AND value <@ '["props", "dev", "app"]'::jsonb));
