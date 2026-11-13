#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Runs inside the runner container. Recreates database scf from zero, runs the §3 bootstrap as superuser, then every
# migration block (each in ONE transaction, like dbmate) as scf_migrator over a direct connection.
#   migrate.sh verbatim|fixed  -> log in /out/migrate-<mode>.log; exit 1 if any block failed
set -u
MODE=${1:-fixed}
LOG=/out/migrate-$MODE.log
DIR=/tmp/migrations-$MODE
: > "$LOG"
psql -q -h pg -U postgres -d postgres -c 'DROP DATABASE IF EXISTS scf WITH (FORCE)' >/dev/null
for r in scf_dump_login scf_maintenance scf_metrics_ro scf_jobs scf_writer scf_app scf_op_definer scf_definer scf_migrator; do
  psql -q -h pg -U postgres -d postgres -c "DROP ROLE IF EXISTS $r" >/dev/null 2>&1
done
psql -q -h pg -U postgres -d postgres -v ON_ERROR_STOP=1 -f /repo/spikes/s03-rls-real-postgres/sql/bootstrap.sql >>"$LOG" 2>&1 \
  || { echo "bootstrap FAILED" | tee -a "$LOG"; exit 1; }
FLAG=""; [ "$MODE" = fixed ] && FLAG=--fixed
python3 /repo/spikes/s03-rls-real-postgres/tools/extract_migrations.py /repo/docs/data-model.md "$DIR" $FLAG >/dev/null || exit 1
FAIL=0
for f in $(ls "$DIR" | sort); do
  out=$(PGPASSWORD=spike psql -X -q -h pg -U scf_migrator -d scf -1 -v ON_ERROR_STOP=1 -f "$DIR/$f" 2>&1)
  rc=$?
  if [ $rc -ne 0 ]; then FAIL=1; echo "== $f: FAILED" >>"$LOG"; else echo "== $f: ok" >>"$LOG"; fi
  [ -n "$out" ] && echo "$out" | grep -v '^ *ensure_partitions *$' | sed 's/^/   /' >>"$LOG"
done
grep '^==' "$LOG"
exit $FAIL
