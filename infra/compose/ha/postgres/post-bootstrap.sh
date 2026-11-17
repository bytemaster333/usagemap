#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Patroni post_bootstrap (first start of a new cluster only, on the node that ran initdb). Called with a connection
# string as $1. Creates Umami's role and database (C-12, C-113, data-model §16.1) — in the single-node stack this is
# infra/compose/postgres/initdb/10-umami-database.sh; production does the same through the Ansible `postgres` role.
# The password is sent as a SCRAM-SHA-256 verifier computed here, never as clear text (C-114).
# The `scf` database and its roles are created afterwards by db-migrate (db/migrate.sh, idempotent).
set -euo pipefail
conn=$1
pw=$(tr -d '\n' </run/secrets/umami_db_password)
verifier=$(printf '%s' "$pw" | scf-scram-verifier)
psql -X -q -v ON_ERROR_STOP=1 -v verifier="$verifier" "$conn" <<'SQL'
SET log_statement = 'none';
SELECT format('CREATE ROLE umami_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'verifier')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'umami_app') \gexec
SELECT 'CREATE DATABASE umami OWNER umami_app'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'umami') \gexec
REVOKE ALL ON DATABASE umami FROM PUBLIC;
SQL
echo "scf-post-bootstrap: role umami_app and database umami ready" >&2
# The backup stanza in both repositories right away, so the first WAL segments archive at once instead of failing
# until the scheduler's first tick (idempotent; the scheduler repeats it).
pgbackrest --stanza=scf stanza-create >/dev/null 2>&1 && echo "scf-post-bootstrap: pgBackRest stanza ready" >&2 \
  || echo "scf-post-bootstrap: stanza-create failed; the backup scheduler retries" >&2
