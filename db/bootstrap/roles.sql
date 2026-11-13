-- SPDX-License-Identifier: Apache-2.0
-- Bootstrap of the cluster for database `scf` — docs/data-model.md §3 ("bootstrap (superuser, once, by Ansible;
-- not a migration)"), made idempotent so it can run on every deploy and on every `docker compose up`.
--
-- Run by db/migrate.sh (mode `bootstrap`) as a superuser, connected to the maintenance database (postgres):
--   psql -X -v ON_ERROR_STOP=1 -d postgres -f roles.sql
-- Passwords are NOT set here (C-114): db/migrate.sh sets them afterwards with psql's \password, so libpq computes the
-- SCRAM-SHA-256 verifier client-side and clear text never reaches the server, its logs or pg_stat_statements.
-- psql variable `scf_db` (default scf) names the database.
\set ON_ERROR_STOP on
SET client_min_messages = warning;
\if :{?scf_db}
\else
\set scf_db scf
\endif

-- 1. Roles (attributes re-asserted on every run, so a drifted role is corrected).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('scf_migrator',      'LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER INHERIT'),
      ('scf_definer',       'NOLOGIN NOBYPASSRLS NOSUPERUSER'),
      ('scf_op_definer',    'NOLOGIN NOBYPASSRLS NOSUPERUSER'),
      ('scf_audit_definer', 'NOLOGIN NOBYPASSRLS NOSUPERUSER'),               -- C-103: owns audit_chain_append() only
      ('scf_app',           'LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE'),
      ('scf_writer',        'LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE'),
      ('scf_jobs',          'LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE'),
      ('scf_metrics_ro',    'LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE'),
      ('scf_maintenance',   'NOLOGIN BYPASSRLS NOSUPERUSER'),
      ('scf_dump_login',    'LOGIN NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE'),
      ('scf_monitor',       'LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE')) AS t(name, attrs)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I %s', r.name, r.attrs);
    ELSE
      EXECUTE format('ALTER ROLE %I %s', r.name, r.attrs);
    END IF;
  END LOOP;
END $$;

GRANT scf_maintenance TO scf_dump_login;
GRANT pg_read_all_data TO scf_maintenance;
ALTER ROLE scf_metrics_ro SET statement_timeout = '30s';   -- cross-tenant op_* reads are budgeted (S-05, C-103)
-- C-114: SET (ALTER FUNCTION … OWNER TO … needs it) but no INHERIT — the migrator never uses the definer roles'
-- unconditional policies to read or write tenant data. Re-granting updates the options of an existing membership.
GRANT scf_definer, scf_op_definer, scf_audit_definer TO scf_migrator WITH INHERIT FALSE, SET TRUE;
GRANT pg_read_all_stats TO scf_migrator;   -- the runtime half of gate G8 reads every role's pg_stat_statements rows
-- The PostgreSQL exporter (monitoring overlay): server statistics and settings through the predefined pg_monitor role;
-- it connects to the maintenance database `postgres` only (no CONNECT on scf, no table privilege anywhere, so it can
-- read no tenant data — gate G3 checks every role).
GRANT pg_monitor TO scf_monitor;
ALTER ROLE scf_monitor SET statement_timeout = '10s';

-- 2. Passwords: set by db/migrate.sh after this file (see the header).

-- 3. Database, owned by the migrator.
SELECT format('CREATE DATABASE %I OWNER scf_migrator', :'scf_db')
 WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = :'scf_db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO scf_migrator', :'scf_db') \gexec

\c :scf_db
SET client_min_messages = warning;
REVOKE ALL ON DATABASE :"scf_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"scf_db" TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_dump_login;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- 4. pg_stat_statements for the runtime half of gate G8 (§15), when the server preloads it. The extension's view lands
--    in schema public, where no runtime role has USAGE (G3/G4 account for that).
SELECT 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'
 WHERE pg_catalog.current_setting('shared_preload_libraries') ~ 'pg_stat_statements' \gexec
