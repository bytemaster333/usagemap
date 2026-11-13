-- Source: docs/data-model.md, block '-- migration: 0010_identity' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0010_identity
CREATE TABLE scf.users (
  user_id         uuid PRIMARY KEY DEFAULT uuidv7(),
  display_name    text CHECK (char_length(display_name) BETWEEN 1 AND 80),
  contact_email   text CHECK (char_length(contact_email) <= 254 AND contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,
  disabled_reason text CHECK (char_length(disabled_reason) <= 500),
  deleted_at      timestamptz,                     -- C-57 tombstone: profile fields cleared, user_id kept
  CHECK (deleted_at IS NOT NULL OR display_name IS NOT NULL),
  CHECK (deleted_at IS NULL OR (display_name IS NULL AND contact_email IS NULL))
);

CREATE TABLE scf.external_identities (
  identity_id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id             uuid NOT NULL REFERENCES scf.users ON DELETE CASCADE,
  provider            scf.identity_provider NOT NULL,
  subject             text NOT NULL,       -- github: numeric user id; stellar: the member's own G-account
  display_handle      text CHECK (char_length(display_handle) <= 39),     -- github login; NULL for stellar
  provider_created_at timestamptz,         -- GitHub account creation time (abuse scoring)
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  UNIQUE (provider, subject),
  CHECK ((provider = 'github'  AND subject ~ '^[1-9][0-9]{0,19}$')
      OR (provider = 'stellar' AND subject ~ '^G[A-Z2-7]{55}$' AND display_handle IS NULL))
);
CREATE INDEX external_identities_user ON scf.external_identities (user_id);

CREATE TABLE scf.passkey_credentials (
  credential_id   bytea PRIMARY KEY CHECK (octet_length(credential_id) BETWEEN 16 AND 1023),
  user_id         uuid  NOT NULL REFERENCES scf.users ON DELETE CASCADE,
  public_key      bytea NOT NULL,                     -- COSE_Key
  sign_count      bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  aaguid          uuid,
  transports      text[] NOT NULL DEFAULT '{}',
  backup_eligible boolean NOT NULL,
  backup_state    boolean NOT NULL,
  label           text CHECK (char_length(label) <= 64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX passkey_credentials_user ON scf.passkey_credentials (user_id);

-- Opaque server-side sessions: cookie value 256-bit CSPRNG (base64url), only SHA-256(value) stored.
-- No IP and no User-Agent are stored.
CREATE TABLE scf.auth_sessions (
  session_hash        bytea PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  user_id             uuid  NOT NULL REFERENCES scf.users ON DELETE CASCADE,
  kind                text  NOT NULL CHECK (kind IN ('tenant_user', 'operator')),
  first_factor        text  NOT NULL CHECK (first_factor IN ('github', 'stellar_sep53', 'stellar_sep10')),
  passkey_verified_at timestamptz,
  step_up_at          timestamptz,                    -- last passkey assertion; SCF-operator step-up valid 10 min (C-09)
  reauthenticated_at  timestamptz NOT NULL DEFAULT now(),  -- last fresh sign-in by the member's own method (C-87)
  reauth_method       text NOT NULL CHECK (reauth_method IN ('passkey', 'github', 'stellar_sep53', 'stellar_sep10')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text CHECK (revoke_reason IN ('logout', 'rotated', 'user_disabled', 'operator_revoked', 'expired', 'account_deleted'))
);
CREATE INDEX auth_sessions_user ON scf.auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry ON scf.auth_sessions (absolute_expires_at);

-- Single-use challenges (OAuth state + PKCE, SEP-53 nonce, SEP-10 tx, WebAuthn, project-account proofs).
CREATE TABLE scf.auth_challenges (
  challenge_id  uuid PRIMARY KEY DEFAULT uuidv7(),
  kind          text NOT NULL CHECK (kind IN ('github_oauth', 'stellar_sep53', 'stellar_sep10',
                     'webauthn_registration', 'webauthn_assertion', 'stellar_link_sep53', 'stellar_link_sep10')),
  secret_hash   bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  user_id       uuid REFERENCES scf.users ON DELETE CASCADE,
  tenant_id     uuid,                                -- only for stellar_link_*
  subject       text CHECK (subject ~ '^G[A-Z2-7]{55}$'),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- PKCE verifier, return_to, SEP-10 tx hash …
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  CHECK (expires_at <= created_at + interval '15 minutes'),
  CHECK ((kind LIKE 'stellar_link%') = (tenant_id IS NOT NULL))
);
CREATE UNIQUE INDEX auth_challenges_secret ON scf.auth_challenges (secret_hash);
CREATE INDEX auth_challenges_expiry ON scf.auth_challenges (expires_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scf.users', 'scf.external_identities', 'scf.passkey_credentials',
                           'scf.auth_sessions', 'scf.auth_challenges'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO scf_app', t);
    EXECUTE format('CREATE POLICY app_global ON %s FOR ALL TO scf_app USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, DELETE ON %s TO scf_jobs', t);
    EXECUTE format('CREATE POLICY jobs_retention ON %s FOR ALL TO scf_jobs USING ((SELECT scf.current_job()) = ''retention'')', t);
    EXECUTE format('GRANT SELECT ON %s TO scf_op_definer', t);
    EXECUTE format('CREATE POLICY op_definer_select ON %s FOR SELECT TO scf_op_definer USING (true)', t);
  END LOOP;
END $$;
GRANT DELETE ON scf.external_identities, scf.passkey_credentials, scf.auth_sessions TO scf_app;

-- C-87: database backstop for sensitive tenant actions. Applies to the control plane acting for a member
-- (current_user scf_app, actor_kind user); jobs and definer functions are not members and are not affected.
CREATE FUNCTION scf.require_reauth() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF current_user = 'scf_app' AND scf.actor_kind() = 'user' AND NOT scf.reauth_fresh() THEN
      RAISE EXCEPTION 'fresh sign-in required (%.%)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER users_delete_reauth BEFORE UPDATE ON scf.users FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION scf.require_reauth();
