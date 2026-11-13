-- Source: docs/data-model.md, block '-- migration: 0001_schemas' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0001_schemas
CREATE SCHEMA scf       AUTHORIZATION scf_migrator;
CREATE SCHEMA scf_part  AUTHORIZATION scf_migrator;
CREATE SCHEMA scf_admin AUTHORIZATION scf_migrator;
GRANT USAGE ON SCHEMA scf TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer, scf_audit_definer;
ALTER DEFAULT PRIVILEGES FOR ROLE scf_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE scf_migrator REVOKE ALL ON TABLES FROM PUBLIC;
