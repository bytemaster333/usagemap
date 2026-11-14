#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# C-12: the engine's own role umami_app owns the umami database and its schema.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v pw="$UMAMI_DB_PASSWORD" <<'SQL'
CREATE ROLE umami_app LOGIN PASSWORD :'pw';
CREATE DATABASE umami OWNER umami_app;
REVOKE ALL ON DATABASE umami FROM PUBLIC;
SQL
