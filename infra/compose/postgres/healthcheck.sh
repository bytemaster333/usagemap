#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# PostgreSQL container health check, plus the C-108 rule "a CHECKPOINT follows every start" (so WAL archiving starts
# at once). The postmaster's start time (line 3 of postmaster.pid) identifies a start; the CHECKPOINT runs once per
# start and is remembered in a marker under /tmp (lost with the container, i.e. at the latest on the next start).
set -eu
pg_isready -q -h /var/run/postgresql -U postgres -d postgres || exit 1
start=$(sed -n 3p "$PGDATA/postmaster.pid" 2>/dev/null || true)
[ -n "$start" ] || exit 1
marker="/tmp/scf-checkpoint-$start"
[ -e "$marker" ] && exit 0
# Local connections need the password too (SCRAM; no trust authentication anywhere).
PGPASSWORD=$(cat /run/secrets/pg_superuser_password) psql -X -q -h /var/run/postgresql -U postgres -d postgres \
  -c CHECKPOINT >/dev/null
: > "$marker"
