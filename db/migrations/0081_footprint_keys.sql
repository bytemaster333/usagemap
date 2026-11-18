-- Source: docs/data-model.md, block '-- migration: 0081_footprint_keys' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0081_footprint_keys
-- Footprint registration keys `scfa_reg_…` (integration wave I1, lead decision 2026-11-19 (4); wire-formats §k): a
-- tenant API key with the single scope `footprint:register`, bound to one tenant and optionally one network. It lets a
-- build tool (the Scaffold Stellar post-deploy extension) add the project's freshly deployed contract as a `claimed`
-- footprint item, and nothing else: it never verifies, removes or reads anything. Created and revoked by a tenant
-- `admin` or `owner` (recent sign-in), shown once, stored as id + last4 + HMAC-SHA-256(pepper_reg[version], secret).
-- A key acts for the member who created it (declared_contracts.created_by); the control plane refuses it once that
-- member is no longer an admin or owner of the tenant.

CREATE TABLE scf.footprint_keys (
  tenant_id      uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  key_id         text NOT NULL UNIQUE CHECK (key_id ~ '^[0-9A-Za-z]{12}$'),
  secret_hash    bytea NOT NULL CHECK (octet_length(secret_hash) = 32),             -- HMAC(pepper_reg[v], secret)
  pepper_version smallint NOT NULL DEFAULT 1 CHECK (pepper_version >= 1),
  last4          text NOT NULL CHECK (last4 ~ '^[0-9A-Za-z]{4}$'),
  label          text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  network        text CHECK (network IN ('mainnet', 'testnet')),                    -- NULL = either network
  created_by     uuid NOT NULL REFERENCES scf.users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid,
  PRIMARY KEY (tenant_id, key_id)
);

-- At most 5 usable keys per tenant (like ingest tokens, C-21); serialised per tenant.
CREATE FUNCTION scf.footprint_key_limits() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    PERFORM 1 FROM scf.tenants t WHERE t.tenant_id = NEW.tenant_id FOR UPDATE;
    IF (SELECT count(*) FROM scf.footprint_keys k WHERE k.tenant_id = NEW.tenant_id AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > now())) >= 5 THEN
      RAISE EXCEPTION 'too many active footprint keys' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER footprint_keys_limit BEFORE INSERT ON scf.footprint_keys
  FOR EACH ROW EXECUTE FUNCTION scf.footprint_key_limits();

-- Tenant members manage keys under the tenant context; the key's own requests run under the key's tenant (actor
-- kind `system`, actor id `footprint_key:<id>`) and only touch last_used_at. Purged with the tenant.
CALL scf_admin.apply_tenant_rls('scf.footprint_keys', '{SELECT,INSERT,UPDATE}', '{}', '{}',
  '{"SELECT":["tenant_purge"],"DELETE":["tenant_purge"]}');
-- Column guards (as sites, C-114 finding 3): a new key starts unused and unrevoked; afterwards only its use and its
-- revocation change. Label, hash, network, creator and expiry are fixed at creation.
REVOKE INSERT, UPDATE ON scf.footprint_keys FROM scf_app;
GRANT INSERT (tenant_id, key_id, secret_hash, pepper_version, last4, label, network, created_by, expires_at)
  ON scf.footprint_keys TO scf_app;
GRANT UPDATE (last_used_at, revoked_at, revoked_by) ON scf.footprint_keys TO scf_app;
GRANT SELECT ON scf.footprint_keys TO scf_definer;
CREATE POLICY definer_lookup ON scf.footprint_keys FOR SELECT TO scf_definer USING (true);

-- Lookup by the public key id before any tenant is known (as lookup_share_key): the caller verifies the HMAC and then
-- continues under the returned tenant.
CREATE FUNCTION scf.lookup_footprint_key(p_key_id text)
  RETURNS TABLE (tenant_id uuid, secret_hash bytea, pepper_version smallint, network text, created_by uuid,
                 usable boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT k.tenant_id, k.secret_hash, k.pepper_version, k.network, k.created_by,
               (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()))
          FROM scf.footprint_keys k WHERE k.key_id = p_key_id $$;
REVOKE ALL ON FUNCTION scf.lookup_footprint_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.lookup_footprint_key(text) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_definer;       -- ALTER … OWNER needs it; revoked below (as 0041)
ALTER FUNCTION scf.lookup_footprint_key(text) OWNER TO scf_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('footprint_key.created', 'footprint registration key created (scope footprint:register; network, expiry)', '{scf_app}'),
 ('footprint_key.revoked', 'footprint registration key revoked', '{scf_app}');
