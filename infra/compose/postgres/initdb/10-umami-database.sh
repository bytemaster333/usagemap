#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# First start of the cluster only (docker-entrypoint-initdb.d): Umami's own role and database (C-12, data-model §16.1).
# umami_app owns database umami; Umami's migrations run as it from the umami-migrate image (C-104). The `scf` database
# and its roles are created by db-migrate (db/bootstrap/roles.sql, idempotent, every start); the roles of ours in the
# umami database (scf_umami_ro, scf_umami_maint) by the umami-views step (db/umami/scf_ro.sql).
set -eu
pw=$(cat /run/secrets/umami_db_password)
psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v pw="$pw" <<'SQL'
CREATE ROLE umami_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'pw';
CREATE DATABASE umami OWNER umami_app;
REVOKE ALL ON DATABASE umami FROM PUBLIC;
SQL
