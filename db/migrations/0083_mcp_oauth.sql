-- Source: docs/data-model.md, block '-- migration: 0083_mcp_oauth' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0083_mcp_oauth
-- OAuth 2.1 authorization server for the hosted MCP server (integration wave I1, agent O, 2026-11-19; MCP
-- authorization spec 2026-07-28; services/control-plane/src/oauth): registered clients (Dynamic Client Registration,
-- RFC 7591, and Client ID Metadata Documents), pending authorization requests (consent not yet given, ≤ 10 minutes),
-- grants (one user, ONE tenant read-only — or an SCF operator's read-only operator view — for one client and one
-- resource), single-use authorization codes (PKCE S256 challenge kept, ≤ 2 minutes) and tokens (access, refresh —
-- rotated on use —, and delegated: the control-plane-audience token the MCP server obtains by token exchange,
-- RFC 8693, so it never passes the client's token on). Every code and token is 256 random bits; only SHA-256 is
-- stored. No IP address, no User-Agent, nothing about the client's network is stored.
-- Global identity-like tables (no tenant_id column; the granted tenant is a reference, `granted_tenant_id`), same
-- policy shape as scf.auth_sessions (0010): scf_app reads and writes, the retention job may delete. Expired rows are
-- also swept by the control plane itself (src/oauth/store.ts).

CREATE TABLE scf.oauth_clients (
  client_id           text PRIMARY KEY CHECK (char_length(client_id) BETWEEN 16 AND 512),
  kind                text NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  client_name         text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  client_uri          text CHECK (char_length(client_uri) <= 512),
  redirect_uris       text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  created_at          timestamptz NOT NULL DEFAULT now(),
  metadata_fetched_at timestamptz,                     -- cimd: when the metadata document was last read
  last_used_at        timestamptz,
  disabled_at         timestamptz,
  CHECK ((kind = 'cimd') = (client_id LIKE 'https://%'))
);
CREATE INDEX oauth_clients_created ON scf.oauth_clients (created_at);

CREATE TABLE scf.oauth_requests (
  request_id     uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id      text NOT NULL REFERENCES scf.oauth_clients ON DELETE CASCADE,
  redirect_uri   text NOT NULL CHECK (char_length(redirect_uri) <= 2048),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),   -- S256 only
  state          text CHECK (char_length(state) <= 1024),
  scope          text NOT NULL CHECK (char_length(scope) <= 256),
  resource       text NOT NULL CHECK (char_length(resource) <= 512),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  decided_at     timestamptz,
  CHECK (expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX oauth_requests_expiry ON scf.oauth_requests (expires_at);

CREATE TABLE scf.oauth_grants (
  grant_id          uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id         text NOT NULL REFERENCES scf.oauth_clients ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES scf.users ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('tenant', 'operator')),
  granted_tenant_id uuid REFERENCES scf.tenants (tenant_id) ON DELETE CASCADE,
  scope             text NOT NULL CHECK (char_length(scope) <= 256),
  resource          text NOT NULL CHECK (char_length(resource) <= 512),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  revoke_reason     text CHECK (revoke_reason IN ('user', 'refresh_reuse', 'code_reuse', 'access_lost')),
  CHECK ((kind = 'tenant') = (granted_tenant_id IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  -- operator grants live at most as long as an operator session (C-20: 12 hours); tenant grants 90 days
  CHECK (expires_at <= created_at + CASE kind WHEN 'operator' THEN interval '12 hours' ELSE interval '90 days' END)
);
CREATE INDEX oauth_grants_user ON scf.oauth_grants (user_id);
CREATE INDEX oauth_grants_tenant ON scf.oauth_grants (granted_tenant_id) WHERE granted_tenant_id IS NOT NULL;
CREATE INDEX oauth_grants_client ON scf.oauth_grants (client_id);
CREATE INDEX oauth_grants_expiry ON scf.oauth_grants (expires_at);

CREATE TABLE scf.oauth_codes (
  code_hash      bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
  grant_id       uuid NOT NULL REFERENCES scf.oauth_grants ON DELETE CASCADE,
  redirect_uri   text NOT NULL CHECK (char_length(redirect_uri) <= 2048),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  CHECK (expires_at <= created_at + interval '2 minutes')
);
CREATE INDEX oauth_codes_grant ON scf.oauth_codes (grant_id);
CREATE INDEX oauth_codes_expiry ON scf.oauth_codes (expires_at);

CREATE TABLE scf.oauth_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  grant_id   uuid NOT NULL REFERENCES scf.oauth_grants ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('access', 'refresh', 'delegated')),
  audience   text NOT NULL CHECK (char_length(audience) <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,                               -- refresh: rotated (a second use revokes the grant)
  revoked_at timestamptz,
  CHECK (expires_at <= created_at + CASE kind WHEN 'refresh' THEN interval '30 days' ELSE interval '1 hour' END)
);
CREATE INDEX oauth_tokens_grant ON scf.oauth_tokens (grant_id);
CREATE INDEX oauth_tokens_expiry ON scf.oauth_tokens (expires_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scf.oauth_clients', 'scf.oauth_requests', 'scf.oauth_grants', 'scf.oauth_codes',
                           'scf.oauth_tokens'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO scf_app', t);
    EXECUTE format('CREATE POLICY app_global ON %s FOR ALL TO scf_app USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, DELETE ON %s TO scf_jobs', t);
    EXECUTE format('CREATE POLICY jobs_retention ON %s FOR ALL TO scf_jobs USING ((SELECT scf.current_job()) = ''retention'')', t);
  END LOOP;
END $$;

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('oauth.client_registered', 'MCP OAuth client registered (dynamic registration or client metadata document)', '{scf_app}'),
 ('oauth.grant_created',     'member or SCF operator allowed an MCP client read-only access (consent)', '{scf_app}'),
 ('oauth.grant_revoked',     'MCP OAuth grant revoked (by the user, on token reuse, or access lost)', '{scf_app}');
