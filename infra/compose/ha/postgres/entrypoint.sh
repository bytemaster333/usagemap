#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Entrypoint of a database node (HA profile): load credentials from Docker secrets into the environment Patroni and
# pgBackRest read, start the backup scheduler next to Patroni, then exec Patroni. Runs under `init: true` (docker-init
# as PID 1): pgBackRest's asynchronous archiver double-forks, and without an init process the postmaster reaps the
# orphan and treats it as a crashed backend (S-08 O3, C-108).
#
# Secrets (files, mode 0400/0440): pg_superuser_password, pg_replication_password, pg_rewind_password,
# patroni_restapi_password, pgbackrest_repo{1,2}_key (SAS token or account key), pgbackrest_repo{1,2}_cipher_pass.
# Environment from Compose/Ansible: PATRONI_NAME, PATRONI_RESTAPI_CONNECT_ADDRESS, PATRONI_POSTGRESQL_CONNECT_ADDRESS,
# PATRONI_ETCD3_HOSTS, SCF_BACKUP_SCHEDULER (1 = run it; default 1).
set -euo pipefail

secret() { # secret NAME → contents of /run/secrets/NAME (no trailing newline), or empty if absent
  local f=/run/secrets/$1
  [ -r "$f" ] && tr -d '\n' <"$f" || true
}
require() { [ -n "${!1:-}" ] || { echo "scf-pg-entrypoint: $1 is not set" >&2; exit 1; }; }

export PATRONI_SUPERUSER_USERNAME=postgres
PATRONI_SUPERUSER_PASSWORD=$(secret pg_superuser_password)
export PATRONI_SUPERUSER_PASSWORD
export PATRONI_REPLICATION_USERNAME=replicator
PATRONI_REPLICATION_PASSWORD=$(secret pg_replication_password)
export PATRONI_REPLICATION_PASSWORD
export PATRONI_REWIND_USERNAME=rewinder
PATRONI_REWIND_PASSWORD=$(secret pg_rewind_password)
export PATRONI_REWIND_PASSWORD
export PATRONI_RESTAPI_USERNAME=patroni
PATRONI_RESTAPI_PASSWORD=$(secret patroni_restapi_password)
export PATRONI_RESTAPI_PASSWORD
export PATRONI_POSTGRESQL_DATA_DIR=${PGDATA:-/var/lib/postgresql/18/main}

for n in 1 2; do
  k=$(secret "pgbackrest_repo${n}_key"); c=$(secret "pgbackrest_repo${n}_cipher_pass")
  [ -n "$k" ] && export "PGBACKREST_REPO${n}_AZURE_KEY=$k"
  [ -n "$c" ] && export "PGBACKREST_REPO${n}_CIPHER_PASS=$c"
done

for v in PATRONI_NAME PATRONI_RESTAPI_CONNECT_ADDRESS PATRONI_POSTGRESQL_CONNECT_ADDRESS PATRONI_ETCD3_HOSTS \
         PATRONI_SUPERUSER_PASSWORD PATRONI_REPLICATION_PASSWORD PATRONI_REWIND_PASSWORD PATRONI_RESTAPI_PASSWORD \
         PGBACKREST_REPO1_AZURE_KEY PGBACKREST_REPO1_CIPHER_PASS PGBACKREST_REPO2_AZURE_KEY PGBACKREST_REPO2_CIPHER_PASS; do
  require "$v"
done

# The backup scheduler acts only while this node is the primary (it asks Patroni each tick), so it runs on every node
# and follows a failover without reconfiguration (ADR-0021: timers run only on the current primary).
if [ "${SCF_BACKUP_SCHEDULER:-1}" = 1 ]; then
  /usr/local/bin/scf-backup daemon &
fi

exec patroni /etc/scf/patroni.yml
