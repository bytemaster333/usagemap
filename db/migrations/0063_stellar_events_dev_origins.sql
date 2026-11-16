-- Source: docs/data-model.md, block '-- migration: 0063_stellar_events_dev_origins' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0063_stellar_events_dev_origins
-- C-136 (plan B1, E2, D-6; decision D8 amends ADR-0008): dev/preview origins and a time-boxed debug mode per site
-- (wire-formats §a.8, §e.3), the capped buffer of `dev` events for the first-event panel, and the daily rollup of
-- Stellar event schema v1 properties (wire-formats §a.3.1, §d.3) that feeds the wallet funnel.

-- (1) Dev/preview origins: events whose Origin matches one of them get the class `dev` — accepted, shown in the
--     first-event panel, never forwarded to Umami and never counted in any metric, rollup, snapshot or trust score.
--     Grammar (wire-formats §a.8): `localhost`, `127.0.0.1` (any port, http or https), an exact host, or a host whose
--     leftmost label holds one `*`; the control plane also enforces >= 3 literal characters in a wildcard label and
--     refuses a wildcard directly above a public suffix (`*.vercel.app`). At most 10 per site.
--     debug_until: while in the future, /v1/e and /v1/c answers for the site carry the full X-Scf-Debug header (§a.8;
--     outside it a dev request learns only `class=dev`, C-137); set by the tenant for at most 24 hours (setSiteDebugMode).
ALTER TABLE scf.sites
  ADD COLUMN dev_origins text[] NOT NULL DEFAULT '{}',
  ADD COLUMN debug_until timestamptz,
  ADD CONSTRAINT sites_dev_origins_check CHECK (
    cardinality(dev_origins) <= 10
    AND array_position(dev_origins, NULL) IS NULL                 -- no NULL element (array_to_string skips them)
    AND '' <> ALL (dev_origins)                                   -- no empty element
    AND array_to_string(dev_origins, ',')                         -- ',' never occurs in an element; a space fails
        ~ '^((localhost|127\.0\.0\.1|([a-z0-9-]*\*[a-z0-9-]*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(,|$))*$');
GRANT UPDATE (dev_origins, debug_until) ON scf.sites TO scf_app;

INSERT INTO scf.settings (key, value, public, description) VALUES
 ('dev_events_per_min_site', '120', true,
  'dev-class events accepted per site and minute on each edge node; beyond that they are dropped uncounted (C-136, wire-formats §a.8)'),
 ('dev_event_buffer_size',   '100', true,
  'dev events kept per site in web_dev_events (newest first, at most 24 hours) for the first-event panel (C-136)'),
 ('edge_counter_features',   '[]',  false,
  'optional counter-record parts the core accepts (wire-formats §d.3, §e.3): ["props","dev"] once every control plane runs C-136; [] before a rollback (C-137)');
ALTER TABLE scf.settings ADD CONSTRAINT settings_edge_counter_features
  CHECK (key <> 'edge_counter_features' OR (jsonb_typeof(value) = 'array' AND value <@ '["props", "dev"]'::jsonb));

-- (2) The dev-event buffer: newest dev_event_buffer_size events per site, at most 24 hours old (§14). Written by the
--     internal counter endpoint (scf_app, actor_kind system) from the `dev` array of counter records (wire-formats
--     §d.3), which also trims the site to the buffer size in the same transaction; read by the first-event panel.
--     Only event kind, name, normalised path, receipt time and the verdict the event would have had — no visitor id,
--     surrogate, IP, User-Agent, referrer, country or property value.
CREATE TABLE scf.web_dev_events (
  tenant_id         uuid        NOT NULL,
  site_id           uuid        NOT NULL,
  event_id          uuid        NOT NULL DEFAULT uuidv7(),
  received_at       timestamptz NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('pageview', 'custom', 'stellar')),
  event_name        text        NOT NULL CHECK (event_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$'),
  path_class        text        NOT NULL CHECK (char_length(path_class) BETWEEN 1 AND 200 AND path_class ~ '^/[^?#[:space:]]*$'),
  would_be_verdict  text        NOT NULL CHECK (would_be_verdict IN ('verified', 'suspect', 'rejected')),
  reason            text        CHECK (reason ~ '^[a-z0-9_]{1,40}$'),
  PRIMARY KEY (tenant_id, site_id, event_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE
);
CREATE INDEX web_dev_events_received ON scf.web_dev_events (received_at);     -- retention (maintenance index)
CALL scf_admin.apply_tenant_rls('scf.web_dev_events', '{SELECT,INSERT,DELETE}', '{}', '{}',
  '{"SELECT":["retention","tenant_purge"],"DELETE":["retention","tenant_purge"]}');

-- (3) Stellar event schema v1 property rollup (wire-formats §a.3.1): per site, UTC day of receipt, event name,
--     network and property value, the count of accepted `wl` events by verdict (verified | suspect; rejected and dev
--     events never). Every event adds one `_total`/`all` row plus one row per present property (network is its own
--     column). Filled by the internal counter endpoint from the `props` array of counter records (wire-formats §d.3)
--     as INSERT … ON CONFLICT DO UPDATE SET count = count + EXCLUDED.count. Values are closed lists only. It is the
--     source of truth of the wallet funnel (C-137). The tenant's own reads are exact; every output of these rows that
--     leaves the tenant (operator, public, cohort, snapshot) omits a per-day per-value cell below op_min_count (C-137).
CREATE TABLE scf.web_event_property_daily (
  tenant_id   uuid   NOT NULL,
  site_id     uuid   NOT NULL,
  day         date   NOT NULL,
  event_name  text   NOT NULL CHECK (event_name IN ('wallet_modal_opened', 'wallet_modal_closed', 'wallet_selected',
                'wallet_connect', 'wallet_disconnect', 'sign_requested', 'sign_approved', 'sign_rejected',
                'tx_submitted', 'smart_wallet_created', 'passkey_used')),
  network     text   NOT NULL CHECK (network IN ('mainnet', 'testnet', 'futurenet', 'local', 'unknown')),
  prop_key    text   NOT NULL,
  prop_value  text   NOT NULL,
  verdict     text   NOT NULL CHECK (verdict IN ('verified', 'suspect')),
  count       bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (tenant_id, site_id, day, event_name, network, prop_key, prop_value, verdict),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE,
  CONSTRAINT web_event_property_daily_value CHECK (CASE prop_key
    WHEN '_total'       THEN prop_value = 'all'
    WHEN 'wallet'       THEN prop_value IN ('freighter', 'albedo', 'xbull', 'lobstr', 'hana', 'hot', 'rabet',
                               'walletconnect', 'ledger', 'trezor', 'fordefi', 'klever', 'onekey', 'bitget',
                               'cactuslink', 'dcent', 'scopuly', 'metamask', 'ghostsig', 'passkey', 'injected_other',
                               'unknown')
    WHEN 'connect_kind' THEN prop_value IN ('new', 'restored')
    WHEN 'sign_kind'    THEN prop_value IN ('tx', 'auth_entry', 'message', 'tx_submit')
    WHEN 'error_class'  THEN prop_value IN ('user_rejected', 'invalid_request', 'external_service', 'internal',
                               'timeout', 'unsupported', 'unknown')
    WHEN 'result_class' THEN prop_value IN ('success', 'failed', 'pending', 'try_again_later', 'error')
    WHEN 'duration'     THEN prop_value IN ('lt5s', '5_30s', 'gt30s')
    WHEN 'outcome'      THEN prop_value IN ('connected', 'dismissed', 'error')
    WHEN 'passkey_op'   THEN prop_value IN ('register', 'authenticate', 'sign')
    ELSE false END)
);
CREATE INDEX web_event_property_daily_day ON scf.web_event_property_daily (day);   -- maintenance index
CALL scf_admin.apply_tenant_rls('scf.web_event_property_daily', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT}',
  '{"SELECT":["trust_scoring","public_metrics","tenant_purge"],"DELETE":["tenant_purge"]}');

-- (4) Retention of web_dev_events (24 hours, §14): the rule is added to scf.retention_rules() by 0066.

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('site.debug_mode_set', 'tenant switched a site''s debug mode on (with its end) or off (C-136)', '{scf_app}');
