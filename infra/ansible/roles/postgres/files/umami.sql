-- SPDX-License-Identifier: Apache-2.0
-- Idempotent: prints "changed" only when something was created or the password differed.
SET log_statement = 'none';
SELECT 'changed' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'umami_app')
                    OR NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'umami');
SELECT format('CREATE ROLE umami_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'verifier')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'umami_app') \gexec
SELECT 'CREATE DATABASE umami OWNER umami_app'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'umami') \gexec
REVOKE ALL ON DATABASE umami FROM PUBLIC;
