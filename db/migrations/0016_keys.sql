-- Source: docs/data-model.md, block '-- migration: 0016_keys' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0016_keys
CREATE TABLE scf.ingest_tokens (
  tenant_id             uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  token_id              text NOT NULL UNIQUE CHECK (token_id ~ '^[0-9A-Za-z]{12}$'),
  secret_hash           bytea NOT NULL CHECK (octet_length(secret_hash) = 32),     -- HMAC(pepper_ing[v], secret)
  pepper_version        smallint NOT NULL DEFAULT 1 CHECK (pepper_version >= 1),  -- C-81
  last4                 text NOT NULL CHECK (last4 ~ '^[0-9A-Za-z]{4}$'),
  label                 text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  allowed_service_names text[],                       -- NULL = any service.name (auto-registration applies)
  created_by            uuid NOT NULL REFERENCES scf.users,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  last_used_at          timestamptz,                  -- from edge counter records, ≤ 1/min
  revoked_at            timestamptz,
  revoked_by            uuid,
  revoke_reason         text CHECK (char_length(revoke_reason) <= 200),
  PRIMARY KEY (tenant_id, token_id),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE scf.share_keys (
  tenant_id     uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  key_id        text NOT NULL UNIQUE CHECK (key_id ~ '^[0-9A-Za-z]{12}$'),
  secret_hash   bytea NOT NULL CHECK (octet_length(secret_hash) = 32),             -- HMAC(pepper_pub[v], secret)
  pepper_version smallint NOT NULL DEFAULT 1 CHECK (pepper_version >= 1),          -- C-81
  last4         text NOT NULL CHECK (last4 ~ '^[0-9A-Za-z]{4}$'),
  label         text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  created_by    uuid NOT NULL REFERENCES scf.users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  PRIMARY KEY (tenant_id, key_id)
);

CREATE FUNCTION scf.key_limits() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    PERFORM 1 FROM scf.tenants t WHERE t.tenant_id = NEW.tenant_id FOR UPDATE;   -- serialise per tenant
    IF (SELECT count(*) FROM scf.ingest_tokens i WHERE i.tenant_id = NEW.tenant_id AND i.revoked_at IS NULL
          AND (i.expires_at IS NULL OR i.expires_at > now())) >= scf.setting_int('max_active_ingest_tokens') THEN
      RAISE EXCEPTION 'too many active ingest tokens' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER ingest_tokens_limit BEFORE INSERT ON scf.ingest_tokens FOR EACH ROW EXECUTE FUNCTION scf.key_limits();

CREATE TABLE scf.operator_api_keys (
  key_id               text PRIMARY KEY CHECK (key_id ~ '^[0-9A-Za-z]{12}$'),
  secret_hash          bytea NOT NULL CHECK (octet_length(secret_hash) = 32),      -- HMAC(pepper_op[v], secret)
  pepper_version       smallint NOT NULL DEFAULT 1 CHECK (pepper_version >= 1),   -- C-81
  last4                text NOT NULL CHECK (last4 ~ '^[0-9A-Za-z]{4}$'),
  label                text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  scopes               text[] NOT NULL CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['web:read', 'api:read', 'registry:read']),
  tenant_restriction   uuid[],
  rate_limit_per_min   integer NOT NULL DEFAULT 600 CHECK (rate_limit_per_min BETWEEN 1 AND 6000),
  created_by           uuid NOT NULL REFERENCES scf.users,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  last_used_at         timestamptz,
  revoked_at           timestamptz,
  revoked_by           uuid REFERENCES scf.users,
  revoke_reason        text CHECK (char_length(revoke_reason) <= 200),
  flagged_for_review_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '365 days')
);

-- One Umami team + one view-only user (global role `view-only`, team role `team-view-only`; role `user` could create
-- websites and teams, S-01, C-99) + one API key per tenant (ADR-0003). The API key AND the user's password are
-- kept (C-85: minting a key needs the user's own login), both AES-256-GCM under K_umami_creds[key_version], held
-- outside the database (C-40): nonce(12) ‖ ciphertext ‖ tag(16); AAD = tenant_id bytes ‖ ASCII field name
-- ("api_key" | "password"), so the two ciphertexts cannot be swapped. Only the control plane's adapter decrypts the key;
-- only the provisioning worker (job umami_reconcile) decrypts the password, to rotate the key (wire-formats §j.2).
CREATE TABLE scf.umami_credentials (
  tenant_id            uuid PRIMARY KEY REFERENCES scf.tenants ON DELETE CASCADE,
  umami_team_id        uuid NOT NULL UNIQUE,
  umami_user_id        uuid NOT NULL UNIQUE,
  umami_username       text NOT NULL UNIQUE CHECK (umami_username ~ '^scf-t-[0-9a-f]{32}$'),
  umami_api_key_id     uuid NOT NULL,                  -- needed to delete the old key at rotation (P10)
  api_key_ciphertext   bytea NOT NULL,
  password_ciphertext  bytea NOT NULL,                 -- C-85
  key_version          smallint NOT NULL,
  provisioned_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at           timestamptz
);

CALL scf_admin.apply_tenant_rls('scf.ingest_tokens', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT}',
  '{"SELECT":["edge_snapshot","tenant_purge"],"DELETE":["tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.share_keys', '{SELECT,INSERT,UPDATE}', '{}', '{}',
  '{"SELECT":["tenant_purge"],"DELETE":["tenant_purge"]}');
GRANT SELECT, UPDATE ON scf.share_keys TO scf_definer;
CREATE POLICY definer_lookup ON scf.share_keys FOR ALL TO scf_definer USING (true) WITH CHECK (true);
CALL scf_admin.apply_tenant_rls('scf.umami_credentials', '{SELECT}', '{}', '{}',
  '{"SELECT":["umami_reconcile","erasure","tenant_purge","durability_reconcile"],"INSERT":["umami_reconcile"],
    "UPDATE":["umami_reconcile"],"DELETE":["tenant_purge"]}');   -- web_rollup reads the scf_ro view, not the API (C-109)

ALTER TABLE scf.operator_api_keys ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.operator_api_keys FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON scf.operator_api_keys TO scf_app;
GRANT SELECT ON scf.operator_api_keys TO scf_metrics_ro;
GRANT UPDATE (last_used_at) ON scf.operator_api_keys TO scf_metrics_ro;
CREATE POLICY app_read ON scf.operator_api_keys FOR SELECT TO scf_app USING ((SELECT scf.platform_role()) IS NOT NULL);
CREATE POLICY app_admin_insert ON scf.operator_api_keys FOR INSERT TO scf_app
  WITH CHECK ((SELECT scf.platform_role()) = 'operator_admin' AND (SELECT scf.audited_in_tx()));
CREATE POLICY app_admin_update ON scf.operator_api_keys FOR UPDATE TO scf_app
  USING ((SELECT scf.platform_role()) = 'operator_admin' AND (SELECT scf.audited_in_tx()))
  WITH CHECK ((SELECT scf.platform_role()) = 'operator_admin' AND (SELECT scf.audited_in_tx()));
CREATE POLICY metrics_ro_verify ON scf.operator_api_keys FOR SELECT TO scf_metrics_ro USING (true);
CREATE POLICY metrics_ro_touch ON scf.operator_api_keys FOR UPDATE TO scf_metrics_ro USING (true) WITH CHECK (true);
