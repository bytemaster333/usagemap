-- Source: docs/data-model.md, block '-- migration: 0012_tenants' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0012_tenants
CREATE TABLE scf.tenants (
  tenant_id                    uuid PRIMARY KEY,         -- uuidv7 chosen by the control plane before INSERT
  slug                         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description                  text CHECK (char_length(description) <= 1000),
  status                       scf.tenant_status NOT NULL,
  status_reason                text CHECK (char_length(status_reason) <= 1000),
  status_changed_at            timestamptz NOT NULL DEFAULT now(),
  status_changed_by            uuid,
  created_by                   uuid NOT NULL REFERENCES scf.users,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  removed_at                   timestamptz,
  purge_after                  timestamptz,
  purged_at                    timestamptz,
  onchain_correlation_enabled  boolean NOT NULL DEFAULT false,
  public_stats_enabled         boolean NOT NULL DEFAULT false,      -- metrics_endpoint readable without a key (C-14)
  is_canary                    boolean NOT NULL DEFAULT false,      -- synthetic probe/isolation tenant (C-78)
  CHECK ((status = 'removed') = (purge_after IS NOT NULL)),
  CHECK (purged_at IS NULL OR status = 'removed')
);
CREATE INDEX tenants_status ON scf.tenants (status, created_at);

CREATE TABLE scf.memberships (
  tenant_id  uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES scf.users  ON DELETE CASCADE,
  role       scf.tenant_role NOT NULL,
  added_by   uuid REFERENCES scf.users,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE UNIQUE INDEX memberships_one_owner ON scf.memberships (tenant_id) WHERE role = 'owner';
CREATE INDEX memberships_user ON scf.memberships (user_id, tenant_id);

CREATE TABLE scf.tenant_invitations (           -- no e-mail: one-time 128-bit code shown once
  tenant_id     uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  invitation_id uuid NOT NULL DEFAULT uuidv7(),
  role          scf.tenant_role NOT NULL CHECK (role <> 'owner'),
  code_hash     bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  note          text CHECK (char_length(note) <= 200),
  created_by    uuid NOT NULL REFERENCES scf.users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  accepted_by   uuid REFERENCES scf.users,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  PRIMARY KEY (tenant_id, invitation_id),
  CHECK (expires_at <= created_at + interval '7 days')
);

-- Status guard: tenant members cannot change status except the owner's own removal (fresh sign-in, C-87); the
-- INSERT status must match enrollment_mode; SCF-operator transitions run inside scf.op_tenant_transition (owner
-- scf_op_definer); is_canary is set only by the bootstrap playbook (superuser / migrator).
CREATE FUNCTION scf.tenants_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_mode jsonb := (SELECT s.value FROM scf.settings s WHERE s.key = 'enrollment_mode');
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> (CASE WHEN v_mode = '"open"'::jsonb THEN 'active' ELSE 'pending' END)::scf.tenant_status THEN
        RAISE EXCEPTION 'initial status must follow enrollment_mode' USING ERRCODE = '23514';
      END IF;
      IF NEW.is_canary AND current_user IN ('scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro') THEN
        RAISE EXCEPTION 'canary tenants are created by the bootstrap playbook' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'tenant purged' USING ERRCODE = '42501';
    END IF;
    IF NEW.is_canary IS DISTINCT FROM OLD.is_canary AND current_user IN ('scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro') THEN
      RAISE EXCEPTION 'is_canary is read-only' USING ERRCODE = '42501';
    END IF;
    -- tenant_purge marks a tenant purged only once its purge_after has passed (C-114; the column grants allow it
    -- nothing else).
    IF NEW.purged_at IS DISTINCT FROM OLD.purged_at AND current_user IN ('scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro')
       AND (OLD.purge_after IS NULL OR OLD.purge_after > now()) THEN
      RAISE EXCEPTION 'tenant not due for purge' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF current_user = 'scf_op_definer' THEN
        NULL;                                             -- validated inside op_tenant_transition
      ELSIF current_user = 'scf_app' AND OLD.status IN ('active', 'pending', 'suspended') AND NEW.status = 'removed'
            AND EXISTS (SELECT 1 FROM scf.memberships m WHERE m.tenant_id = NEW.tenant_id
                         AND m.user_id = scf.current_actor_user() AND m.role = 'owner') THEN
        IF NOT scf.reauth_fresh() THEN                    -- owner self-removal needs a fresh sign-in (C-87)
          RAISE EXCEPTION 'fresh sign-in required' USING ERRCODE = '42501';
        END IF;
      ELSE
        RAISE EXCEPTION 'tenant status change not permitted' USING ERRCODE = '42501';
      END IF;
      NEW.status_changed_at := now();
      NEW.removed_at  := CASE WHEN NEW.status = 'removed' THEN COALESCE(OLD.removed_at, now()) END;
      NEW.purge_after := CASE WHEN NEW.status = 'removed' THEN COALESCE(OLD.purge_after, now() + interval '30 days') END;
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER tenants_guard BEFORE INSERT OR UPDATE ON scf.tenants FOR EACH ROW EXECUTE FUNCTION scf.tenants_guard();
-- Ownership transfer = an UPDATE that gives or takes the owner role; needs a fresh sign-in (C-87).
CREATE TRIGGER memberships_owner_reauth BEFORE UPDATE ON scf.memberships FOR EACH ROW
  WHEN ((OLD.role = 'owner') IS DISTINCT FROM (NEW.role = 'owner')) EXECUTE FUNCTION scf.require_reauth();

-- tenants / memberships: users also read the tenants and memberships they belong to without a tenant context.
ALTER TABLE scf.tenants ENABLE ROW LEVEL SECURITY;      ALTER TABLE scf.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.memberships ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.memberships FORCE ROW LEVEL SECURITY;
-- C-114: column-level INSERT/UPDATE — the lifecycle columns (removed_at, purge_after, purged_at, status_changed_*,
-- created_*, is_canary, tenant_id, slug) are not writable by runtime roles; status itself is guarded by tenants_guard.
GRANT SELECT ON scf.tenants TO scf_app, scf_jobs, scf_op_definer, scf_definer;
GRANT INSERT (tenant_id, slug, name, description, status, created_by, onchain_correlation_enabled, public_stats_enabled)
  ON scf.tenants TO scf_app;
GRANT UPDATE (name, description, status, status_reason, onchain_correlation_enabled, public_stats_enabled)
  ON scf.tenants TO scf_app;
GRANT UPDATE (purged_at) ON scf.tenants TO scf_jobs;                                  -- job tenant_purge (§6.3)
GRANT UPDATE (status, status_reason, status_changed_by, removed_at, purge_after) ON scf.tenants TO scf_op_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON scf.memberships TO scf_app;
GRANT SELECT, DELETE ON scf.memberships TO scf_jobs;
GRANT SELECT, INSERT ON scf.memberships TO scf_definer;
GRANT SELECT ON scf.memberships TO scf_op_definer;

CREATE POLICY tenant_backstop ON scf.tenants AS RESTRICTIVE FOR ALL TO scf_app, scf_writer, scf_jobs, scf_metrics_ro
  USING ((tenant_id = (SELECT scf.current_tenant()) AND (SELECT scf.tenant_ctx_ok()))
         OR (SELECT scf.cross_tenant_read_ok())
         OR ((SELECT scf.tenant_ctx_ok()) AND EXISTS (SELECT 1 FROM scf.memberships m
              WHERE m.tenant_id = tenants.tenant_id AND m.user_id = (SELECT scf.current_actor_user()))))
  WITH CHECK (tenant_id = (SELECT scf.current_tenant()) AND (SELECT scf.tenant_ctx_ok()));
-- F1 (C-103): every tenant-owned table carries the restrictive DELETE backstop, also those not secured by apply_tenant_rls
-- (no role has DELETE on tenants today; the policy keeps it that way under G2).
CREATE POLICY tenant_backstop_delete ON scf.tenants AS RESTRICTIVE FOR DELETE TO scf_app, scf_writer, scf_jobs, scf_metrics_ro
  USING (tenant_id = (SELECT scf.current_tenant()) AND (SELECT scf.tenant_ctx_ok()));
CREATE POLICY app_select ON scf.tenants FOR SELECT TO scf_app
  USING (tenant_id = (SELECT scf.current_tenant())
         OR EXISTS (SELECT 1 FROM scf.memberships m
                     WHERE m.tenant_id = tenants.tenant_id AND m.user_id = (SELECT scf.current_actor_user())));
CREATE POLICY app_insert ON scf.tenants FOR INSERT TO scf_app WITH CHECK (tenant_id = (SELECT scf.current_tenant()));
CREATE POLICY app_update ON scf.tenants FOR UPDATE TO scf_app
  USING (tenant_id = (SELECT scf.current_tenant())) WITH CHECK (tenant_id = (SELECT scf.current_tenant()));
CREATE POLICY jobs_select ON scf.tenants FOR SELECT TO scf_jobs USING ((SELECT scf.current_job()) IS NOT NULL);
-- (tenant_purge reaches its tenant row only under that tenant's context: the backstop excludes it from cross-tenant reads.)
CREATE POLICY jobs_update ON scf.tenants FOR UPDATE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'tenant_purge') WITH CHECK ((SELECT scf.current_job()) = 'tenant_purge');
CREATE POLICY op_definer_select ON scf.tenants FOR SELECT TO scf_op_definer USING (true);
CREATE POLICY op_definer_update ON scf.tenants FOR UPDATE TO scf_op_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_select ON scf.tenants FOR SELECT TO scf_definer USING (true);

CREATE POLICY tenant_backstop ON scf.memberships AS RESTRICTIVE FOR ALL TO scf_app, scf_writer, scf_jobs, scf_metrics_ro
  USING ((tenant_id = (SELECT scf.current_tenant()) AND (SELECT scf.tenant_ctx_ok()))
         OR (SELECT scf.cross_tenant_read_ok())
         OR ((SELECT scf.tenant_ctx_ok()) AND user_id = (SELECT scf.current_actor_user())))
  WITH CHECK (tenant_id = (SELECT scf.current_tenant()) AND (SELECT scf.tenant_ctx_ok()));
CREATE POLICY tenant_backstop_delete ON scf.memberships AS RESTRICTIVE FOR DELETE   -- F1 (C-103)
  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro
  USING (tenant_id = (SELECT scf.current_tenant()) AND (SELECT scf.tenant_ctx_ok()));
CREATE POLICY app_select ON scf.memberships FOR SELECT TO scf_app
  USING (tenant_id = (SELECT scf.current_tenant()) OR user_id = (SELECT scf.current_actor_user()));
CREATE POLICY app_insert ON scf.memberships FOR INSERT TO scf_app WITH CHECK (tenant_id = (SELECT scf.current_tenant()));
CREATE POLICY app_update ON scf.memberships FOR UPDATE TO scf_app
  USING (tenant_id = (SELECT scf.current_tenant())) WITH CHECK (tenant_id = (SELECT scf.current_tenant()));
CREATE POLICY app_delete ON scf.memberships FOR DELETE TO scf_app USING (tenant_id = (SELECT scf.current_tenant()));
CREATE POLICY jobs_select ON scf.memberships FOR SELECT TO scf_jobs USING ((SELECT scf.current_job()) = 'tenant_purge');
CREATE POLICY jobs_delete ON scf.memberships FOR DELETE TO scf_jobs USING ((SELECT scf.current_job()) = 'tenant_purge');
CREATE POLICY definer_accept ON scf.memberships FOR ALL TO scf_definer USING (true) WITH CHECK (true);
CREATE POLICY op_definer_select ON scf.memberships FOR SELECT TO scf_op_definer USING (true);

CALL scf_admin.apply_tenant_rls('scf.tenant_invitations', '{SELECT,INSERT,UPDATE}', '{}', '{}',
  '{"SELECT":["retention","tenant_purge"],"DELETE":["retention","tenant_purge"]}');
GRANT SELECT, UPDATE ON scf.tenant_invitations TO scf_definer;
CREATE POLICY definer_accept ON scf.tenant_invitations FOR ALL TO scf_definer USING (true) WITH CHECK (true);
