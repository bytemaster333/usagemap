-- Source: docs/data-model.md, block '-- migration: 0011_platform' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0011_platform
CREATE TABLE scf.platform_operators (
  user_id     uuid PRIMARY KEY REFERENCES scf.users,
  role        scf.platform_role NOT NULL,
  granted_by  uuid REFERENCES scf.users,      -- NULL only for bootstrap seeds
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  uuid REFERENCES scf.users,
  revoked_at  timestamptz,
  note        text CHECK (char_length(note) <= 500)
);

-- C-64: removal leaves tombstones for domains, GitHub identities and Stellar accounts that block re-enrollment
-- until an operator_admin lifts them.
CREATE TABLE scf.enrollment_tombstones (
  tombstone_id  uuid PRIMARY KEY DEFAULT uuidv7(),
  kind          text NOT NULL CHECK (kind IN ('host', 'github_user', 'stellar_account')),
  subject       text NOT NULL,                -- host (A-label) | GitHub numeric id | G-account
  tenant_id     uuid NOT NULL,                -- the removed tenant
  reason        text CHECK (char_length(reason) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  lifted_at     timestamptz,
  lifted_by     uuid REFERENCES scf.users
);
CREATE UNIQUE INDEX enrollment_tombstones_active ON scf.enrollment_tombstones (kind, subject) WHERE lifted_at IS NULL;

ALTER TABLE scf.platform_operators ENABLE ROW LEVEL SECURITY;    ALTER TABLE scf.platform_operators FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.enrollment_tombstones ENABLE ROW LEVEL SECURITY; ALTER TABLE scf.enrollment_tombstones FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON scf.platform_operators TO scf_app;
CREATE POLICY app_read ON scf.platform_operators FOR SELECT TO scf_app USING (true);   -- read at sign-in
CREATE POLICY app_admin_insert ON scf.platform_operators FOR INSERT TO scf_app
  WITH CHECK ((SELECT scf.platform_role()) = 'operator_admin' AND (SELECT scf.audited_in_tx()));
CREATE POLICY app_admin_update ON scf.platform_operators FOR UPDATE TO scf_app
  USING ((SELECT scf.platform_role()) = 'operator_admin' AND (SELECT scf.audited_in_tx()))
  WITH CHECK ((SELECT scf.platform_role()) = 'operator_admin' AND (SELECT scf.audited_in_tx()));
-- Tombstones: checked at sign-up / domain claim through scf.is_tombstoned() (§12); written by tenant_purge
-- and op_tenant_transition('remove'); lifted by op_lift_tombstone().
GRANT SELECT, INSERT, UPDATE ON scf.enrollment_tombstones TO scf_definer, scf_op_definer;
GRANT SELECT, INSERT ON scf.enrollment_tombstones TO scf_jobs;
CREATE POLICY definer_all ON scf.enrollment_tombstones FOR ALL TO scf_definer, scf_op_definer USING (true) WITH CHECK (true);
CREATE POLICY jobs_purge ON scf.enrollment_tombstones FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'tenant_purge') WITH CHECK ((SELECT scf.current_job()) = 'tenant_purge');
