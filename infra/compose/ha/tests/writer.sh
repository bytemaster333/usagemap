#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Write load for the failover test: WORKERS parallel loops, each committing one INSERT per transaction through
# PgBouncer (transaction mode) → HAProxy → current primary, exactly the path of the runtime services. An id is
# appended to $OUT/acked-<w> only after psql reports the COMMIT; a failed attempt goes to $OUT/failed-<w> (outcome
# unknown — it may or may not have committed). Stops when $OUT/stop exists.
set -uo pipefail
OUT=/var/lib/scf-metrics
WORKERS=${WORKERS:-4}
ID_BASE=${ID_BASE:-0}
export PGHOST=pgbouncer PGPORT=6432 PGDATABASE=hatest PGUSER=scf_hatest PGCONNECT_TIMEOUT=2
PGPASSWORD=$(tr -d '\n' </run/secrets/scf_hatest_password); export PGPASSWORD
work() {
  local w=$1 i=0 id
  while [ ! -e $OUT/stop ]; do
    id=$((ID_BASE + i * WORKERS + w)); i=$((i + 1))
    if err=$(psql -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO t(id, worker) VALUES ($id, $w)" 2>&1 >/dev/null); then
      echo "$id $(date +%s.%N)" >>"$OUT/acked-$w"
    else
      echo "$id $(date +%s.%N) ${err%%$'\n'*}" >>"$OUT/failed-$w"
      sleep 0.2
    fi
  done
}
for w in $(seq 0 $((WORKERS - 1))); do work "$w" & done
wait
