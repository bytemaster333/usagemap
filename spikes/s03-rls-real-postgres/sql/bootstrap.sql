-- SPDX-License-Identifier: Apache-2.0
-- docs/data-model.md §3 bootstrap, verbatim, run by the superuser. Only additions: throwaway PASSWORDs (spike) and
-- CREATE EXTENSION pg_stat_statements (G8). Run with psql -v ON_ERROR_STOP=1 against database postgres.
CREATE ROLE scf_migrator   LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE scf_definer    NOLOGIN NOBYPASSRLS;
CREATE ROLE scf_op_definer NOLOGIN NOBYPASSRLS;
CREATE ROLE scf_app        LOGIN NOBYPASSRLS;
CREATE ROLE scf_writer     LOGIN NOBYPASSRLS;
CREATE ROLE scf_jobs       LOGIN NOBYPASSRLS;
CREATE ROLE scf_metrics_ro LOGIN NOBYPASSRLS;
CREATE ROLE scf_maintenance NOLOGIN BYPASSRLS;
CREATE ROLE scf_dump_login LOGIN NOBYPASSRLS NOINHERIT IN ROLE scf_maintenance;
GRANT pg_read_all_data TO scf_maintenance;
GRANT scf_definer, scf_op_definer TO scf_migrator;   -- lets the migrator ALTER FUNCTION … OWNER TO …
CREATE DATABASE scf OWNER scf_migrator;
\c scf
REVOKE ALL ON DATABASE scf FROM PUBLIC;
GRANT CONNECT ON DATABASE scf TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_dump_login;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- spike-only additions
ALTER ROLE scf_migrator   PASSWORD 'spike';
ALTER ROLE scf_app        PASSWORD 'spike';
ALTER ROLE scf_writer     PASSWORD 'spike';
ALTER ROLE scf_jobs       PASSWORD 'spike';
ALTER ROLE scf_metrics_ro PASSWORD 'spike';
CREATE EXTENSION pg_stat_statements;
GRANT pg_read_all_stats TO scf_migrator;  -- G8 reads pg_stat_statements of all roles
