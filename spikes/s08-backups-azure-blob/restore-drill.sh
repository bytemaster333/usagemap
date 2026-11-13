#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-08 weekly restore drill (prototype of `make restore-drill`).
# Restores the latest backup (or --target time) from repo2 into a scratch container that holds ONLY a
# read+list SAS for repo2, waits for recovery to finish, runs pg_amcheck --heapallindexed on every
# database, compares row counts/sums with an expected manifest, prints ONE line, destroys the scratch.
#
# usage: restore-drill.sh [--target 'YYYY-MM-DD HH:MM:SS+00'] [--expect FILE]
#   FILE lines: <db> <table> <count> <sum(id)>   (written by the nightly job; here by run.sh)
# Exit 0 on PASS, 1 on FAIL. Requires the stack from run.sh (Azurite + .work/secrets.env).
set -uo pipefail
cd "$(dirname "$0")"
DC=(docker compose -p scf-s08 --env-file .work/secrets.env)
TARGET="" EXPECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --expect) EXPECT="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
now() { date +%s.%N; }
dur() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }
fail() { echo "RESTORE-DRILL FAIL repo=2 stage=$1 reason=\"$2\" total=$(dur "$T0" "$(now)")s"; cleanup; exit 1; }
cleanup() {
  "${DC[@]}" rm -sf pg-drill >/dev/null 2>&1
  docker volume rm -f scf-s08_drill >/dev/null 2>&1
}
q() { "${DC[@]}" exec -T -u postgres pg-drill psql -X -At -h 127.0.0.1 -d "${2:-postgres}" -c "$1" 2>/dev/null; }

T0=$(now)
cleanup
if [ -n "$TARGET" ]; then
  export DRILL_ARGS="--repo=2 --type=time --target-action=promote" DRILL_TARGET="$TARGET"
else
  export DRILL_ARGS="--repo=2" DRILL_TARGET=""
fi
"${DC[@]}" --profile drill up -d --no-deps pg-drill >/dev/null 2>&1 || fail start "compose up failed"

# Wait for restore + WAL replay + promotion (pg_is_in_recovery() = f), max 15 min.
ready=""
for _ in $(seq 900); do
  [ "$(q 'select pg_is_in_recovery()')" = "f" ] && { ready=1; break; }
  if [ "$("${DC[@]}" ps -a --format '{{.State}}' pg-drill 2>/dev/null)" = "exited" ]; then break; fi
  sleep 1
done
T1=$(now)
[ -n "$ready" ] || fail recovery "instance not promoted: $("${DC[@]}" logs --tail 3 pg-drill 2>&1 | tr '\n"' ' ' | cut -c1-300)"
RESTORE_S=$("${DC[@]}" exec -T pg-drill sed -n 's/restore_seconds=//p' /var/lib/postgresql/restore-timing 2>/dev/null)

# Integrity: amcheck on all databases (heap + all indexes).
amout=$("${DC[@]}" exec -T -u postgres pg-drill pg_amcheck -h 127.0.0.1 --all --install-missing \
  --heapallindexed 2>&1) || fail amcheck "$(printf '%s' "$amout" | tr '\n"' ' ' | cut -c1-300)"
T2=$(now)

# Row counts / sums against the expected manifest.
checked=0
if [ -n "$EXPECT" ]; then
  while read -r db tbl cnt sum; do
    [ -z "$db" ] && continue
    got=$(q "select count(*)||' '||coalesce(sum(id),0) from $tbl" "$db")
    [ "$got" = "$cnt $sum" ] || fail counts "$db.$tbl expected '$cnt $sum' got '$got'"
    checked=$((checked + 1))
  done <"$EXPECT"
fi
T3=$(now)
LSN=$(q 'select pg_current_wal_lsn()')
cleanup
echo "RESTORE-DRILL PASS repo=2 target=${TARGET:-latest} restore=${RESTORE_S:-?}s ready=$(dur "$T0" "$T1")s amcheck=$(dur "$T1" "$T2")s counts=${checked}ok($(dur "$T2" "$T3")s) end_lsn=$LSN total=$(dur "$T0" "$(now)")s"
