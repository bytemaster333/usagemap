#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Patroni callback (on_start, on_role_change): C-108 "a CHECKPOINT follows every start and promotion". After a server
# start the checkpointer sleeps a full checkpoint_timeout before archive_timeout bites (S-08 O4), so without this the
# WAL recovery point can lag up to 5 minutes after every restart. Called as: scf-pg-callback ACTION ROLE SCOPE.
# Patroni does not wait for callbacks; this one waits (≤ 120 s) until the server accepts writes, then checkpoints.
set -uo pipefail
action=${1:-} role=${2:-}
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) scf-pg-callback: $*" >&2; }

case $role in
  primary | master) ;;
  *) exit 0 ;; # a standby has no archive_timeout to honour
esac

export PGPASSWORD=${PATRONI_SUPERUSER_PASSWORD:-$({ tr -d '\n' </run/secrets/pg_superuser_password; } 2>/dev/null)}
for _ in $(seq 120); do
  if [ "$(psql -X -At -h /var/run/postgresql -U postgres -d postgres -c 'select pg_is_in_recovery()' 2>/dev/null)" = f ]; then
    if psql -X -q -h /var/run/postgresql -U postgres -d postgres -c CHECKPOINT >/dev/null 2>&1; then
      log "$action as $role: CHECKPOINT done"
      # Make sure a fresh segment reaches both repositories now (start of the archive_timeout clock).
      psql -X -q -h /var/run/postgresql -U postgres -d postgres -c 'select pg_switch_wal()' >/dev/null 2>&1 || true
      exit 0
    fi
  fi
  sleep 1
done
log "$action as $role: server not writable within 120 s, CHECKPOINT skipped"
exit 1
