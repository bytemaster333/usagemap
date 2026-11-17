-- SPDX-License-Identifier: Apache-2.0
-- Umami's own role and database, as infra/compose/postgres/initdb does (C-12, data-model §16.1). Test password only.
CREATE ROLE umami_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'wsg-test-umami';
CREATE DATABASE umami OWNER umami_app;
REVOKE ALL ON DATABASE umami FROM PUBLIC;
