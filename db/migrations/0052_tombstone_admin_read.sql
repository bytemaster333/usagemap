-- Source: docs/data-model.md, block '-- migration: 0052_tombstone_admin_read' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0052_tombstone_admin_read
-- C-117: the operator console lists tombstones (`GET /v1/operator/tombstones`, C-64, C-70) as scf_app; only an
-- operator_admin may read them (the same role that lifts them through op_lift_tombstone).
GRANT SELECT ON scf.enrollment_tombstones TO scf_app;
CREATE POLICY app_admin_read ON scf.enrollment_tombstones FOR SELECT TO scf_app
  USING ((SELECT scf.platform_role()) = 'operator_admin');
