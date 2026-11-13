#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Entrypoint for scratch/restore/standby containers: if PGDATA is empty, run
# `pgbackrest restore $RESTORE_ARGS` first (timed), then hand over to the official entrypoint.
set -euo pipefail
: "${PGDATA:?}"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  install -d -o postgres -g postgres -m 0700 "$PGDATA"
  t0=$(date +%s.%N)
  # shellcheck disable=SC2086
  # RESTORE_TARGET is kept separate because a timestamp contains a space.
  gosu postgres pgbackrest --stanza="${STANZA:-scf}" ${RESTORE_ARGS:-} \
    ${RESTORE_TARGET:+"--target=$RESTORE_TARGET"} restore
  t1=$(date +%s.%N)
  awk -v a="$t0" -v b="$t1" 'BEGIN{printf "restore_seconds=%.2f\n", b-a}' > /var/lib/postgresql/restore-timing
  # Extra lines (e.g. primary_conninfo for a standby) appended verbatim.
  if [ -n "${EXTRA_AUTO_CONF:-}" ]; then printf '%s\n' "$EXTRA_AUTO_CONF" >> "$PGDATA/postgresql.auto.conf"; fi
fi
exec docker-entrypoint.sh "$@"
