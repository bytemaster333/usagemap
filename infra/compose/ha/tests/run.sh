#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Integration suite of the HA profile against real containers (PostgreSQL 18.6 + Patroni 4.1.5 + etcd 3.6 +
# pgBackRest 2.60.0 + two Azurite accounts + HAProxy + PgBouncer + the platform's own db-migrate):
#
#   T01 cluster up: leader + synchronous standby; db-migrate ran through the primary-following proxy
#   T02 umami_app / umami created at bootstrap, password stored as a SCRAM verifier (C-113, C-114)
#   T03 CHECKPOINT after start (C-108) logged by the callback on the primary
#   T04 full backups in both repositories, WAL archived to both, metrics file written
#   T05 differential backups to both repositories
#   T06 restore drill PASS (latest) with expectations, amcheck and every RLS gate of db/gates (C-56)
#   T07 point-in-time restore drill to a time between two batches restores exactly the first batch
#   T08 failover under write load (kill -9 of the primary): standby promoted, no acknowledged write lost,
#       writes resume through PgBouncer → HAProxy, CHECKPOINT after promotion, WAL of the new timeline archived
#   T09 old primary fenced and rejoined: restarted as a standby (pg_rewind when needed), read-only, data identical
#   T10 isolation (fencing): a primary cut off from etcd and its standby demotes itself before the standby is
#       promoted; no acknowledged write lost; it rejoins after the partition heals
#   T11 PgBouncer follows the failover for a runtime role (scf_app)
#   T12 corrupted backup → the drill FAILs; a new full backup → PASS again
#   T13 weekly logical dump → migration check PASS (handover.data-migration)
#   T14 no secret value appears in any container log
#   T15 DCS TLS (F15): etcd refuses plaintext and clients without a DCS certificate, accepts Patroni's; peers talk
#       TLS; Patroni's REST API answers HTTPS only (verified against the DCS CA) and refuses plain HTTP
#
#   infra/compose/ha/tests/run.sh            # KEEP=1 leaves the stack up; EVIDENCE_DIR=docs/evidence writes evidence
#
# Docker project scf-wsj2 (no host ports). Exit 0 only if every test passed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)" # infra/compose
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
P=${SCF_HA_TEST_PROJECT:-scf-wsj2}
DC=(docker compose -p "$P" -f "$HERE/compose.yaml" -f "$HERE/compose.dev.yaml" -f "$HERE/compose.ha.yaml" -f "$HERE/ha/tests/compose.test.yaml")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/scf-ha-test.XXXXXX")
LOG="$WORK/run.log"
EVIDENCE_DIR=${EVIDENCE_DIR:-}
export SCF_BACKUP_TICK=5 # the scheduler's loop; the production intervals (7 d full, 1 d diff) stay
PASS=0 FAIL=0
declare -A M=() # measurements for the evidence

say() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG"; }
ok() { PASS=$((PASS + 1)); say "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); say "FAIL $1: $2"; }
now() { date +%s.%N; }
dur() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b-a}'; }
dc() { "${DC[@]}" "$@"; }
# sql NODE DB SQL → psql on the node's local socket as the superuser
sql() { dc exec -T "$1" bash -c 'PGPASSWORD=$(cat /run/secrets/pg_superuser_password) psql -X -At -v ON_ERROR_STOP=1 -h /var/run/postgresql -U postgres -d "$1" -c "$2"' _ "$2" "$3" 2>>"$LOG"; }
# members [VIA] → lines "name role state timeline" from patronictl (read from etcd through node VIA)
members() {
  dc exec -T "${1:-pg-a}" patronictl -c /etc/scf/patroni.yml list -f json 2>/dev/null \
    | python3 -I -c 'import json,sys; [print(m["Member"], m["Role"].replace(" ","_"), m["State"], m.get("TL","-")) for m in json.load(sys.stdin)]'
}
leader() { members "${1:-pg-a}" | awk '$2=="Leader"{print $1}'; }
other() { [ "$1" = pg-a ] && echo pg-b || echo pg-a; }
wait_until() { # wait_until SECONDS CMD… → 0 when CMD succeeded within SECONDS
  local deadline=$(($(date +%s) + $1)); shift
  until "$@" >/dev/null 2>&1; do [ "$(date +%s)" -lt "$deadline" ] || return 1; sleep 1; done
}
is_sync_pair() { local m; m=$(members "${1:-pg-a}"); grep -q ' Leader running' <<<"$m" && grep -q ' Sync_Standby streaming' <<<"$m"; }
metric() { dc exec -T "$1" sh -c "grep -E '^$2 ' /var/lib/scf-metrics/scf_backup.prom | awk '{print \$2}'" 2>/dev/null; }
drill() { "$HERE/ha/scripts/restore-drill.sh" -p "$P" --db-dir "$DBDIR" "$@" 2>>"$LOG"; }
writer_has() { [ "$(docker run --rm -v "${P}_hatest-out:/out:ro" --entrypoint sh "$PG_IMAGE" -c 'cat /out/acked-* 2>/dev/null | wc -l')" -ge "$1" ]; }
WRITER_RUN=0
writer_start() { # each run writes its own id range
  WRITER_RUN=$((WRITER_RUN + 1))
  dc --profile hatest run -d --rm --name "$P-writer" --no-deps -e ID_BASE=$((WRITER_RUN * 100000000)) hatest-writer >/dev/null 2>>"$LOG"
}
writer_stop() {
  docker exec "$P-writer" touch /var/lib/scf-metrics/stop 2>/dev/null
  wait_until 30 bash -c "! docker ps -q --filter name=^/$P-writer\$ | grep -q ."
  docker rm -f "$P-writer" >/dev/null 2>&1
  docker run --rm -v "${P}_hatest-out:/out:ro" --entrypoint sh "$PG_IMAGE" -c 'cat /out/acked-* 2>/dev/null' >"$WORK/acked.$1"
  docker run --rm -v "${P}_hatest-out:/out:ro" --entrypoint sh "$PG_IMAGE" -c 'cat /out/failed-* 2>/dev/null' >"$WORK/failed.$1"
  docker run --rm -v "${P}_hatest-out:/out" --entrypoint sh "$PG_IMAGE" -c 'rm -f /out/*' >/dev/null 2>&1
}
# lost_acked LABEL NODE → number of acknowledged ids missing on NODE
lost_acked() {
  sql "$2" hatest "select id from t" | sort >"$WORK/present.$1"
  cut -d' ' -f1 "$WORK/acked.$1" | sort >"$WORK/acked-ids.$1"
  comm -23 "$WORK/acked-ids.$1" "$WORK/present.$1" | wc -l
}
cleanup() {
  docker rm -f "$P-writer" >/dev/null 2>&1
  if [ "${KEEP:-0}" != 1 ]; then dc --profile drill --profile migration --profile hatest down -v >/dev/null 2>&1; fi
}
trap cleanup EXIT

PG_IMAGE=usagemap/postgres-ha:18.7-pgbr2.60.0-patroni4.1.5
# The RLS gates run on every restored copy. G6 forbids REPLICATION on any non-superuser role, which a streaming
# standby needs (role `replicator`); until db/gates/g06_bypassrls.sql carries that exemption, the
# suite applies exactly that exemption to a copy of db/ (no other change). Once db/ has it, the copy is identical.
DBDIR="$WORK/db"
cp -r "$REPO_ROOT/db" "$DBDIR"
if ! grep -q "rolname = 'replicator'" "$DBDIR/gates/g06_bypassrls.sql"; then
  python3 -I - "$DBDIR/gates/g06_bypassrls.sql" <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  FROM pg_roles WHERE NOT rolsuper AND rolname !~ '^pg_' AND (rolcreaterole OR rolcreatedb OR rolreplication);"
new = ("  FROM pg_roles WHERE NOT rolsuper AND rolname !~ '^pg_' AND (rolcreaterole OR rolcreatedb OR rolreplication)\n"
       "   -- the streaming-replication role of an HA cluster (Patroni, ADR-0020): REPLICATION and nothing else\n"
       "   AND NOT (rolname = 'replicator' AND rolreplication AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls);")
assert old in s, "g06 changed; update the suite"
open(p, "w").write(s.replace(old, new))
EOF
  say "note: G6 replication-role exemption applied to the gate copy (pending contract change)"
fi

say "preflight: secrets, image, clean project $P (work dir $WORK)"
"$HERE/ha/scripts/ha-init.sh" >>"$LOG" 2>&1 || { bad preflight "ha-init failed"; exit 1; }
dc --profile drill --profile migration --profile hatest down -v >/dev/null 2>&1
dc build pg-a >>"$LOG" 2>&1 || { bad preflight "image build failed"; exit 1; }

# ---------------------------------------------------------------- T01
t=$(now)
if dc up -d --wait pgbouncer >>"$LOG" 2>&1 && wait_until 60 is_sync_pair; then
  M[startup]=$(dur "$t" "$(now)")
  [ "$(leader)" = pg-a ] || say "note: initial leader is $(leader)"
  if [ "$(dc ps -a --format '{{.Service}} {{.ExitCode}}' db-migrate | awk '{print $2}')" = 0 ] \
    && [ "$(sql "$(leader)" scf 'select count(*) > 0 from scf_migrations.applied')" = t ]; then
    ok "T01 cluster up in ${M[startup]} s: $(members | tr '\n' ';')"
  else bad T01 "db-migrate did not complete through the proxy"; fi
else
  bad T01 "stack or synchronous pair not up"; dc ps -a >>"$LOG"; exit 1
fi
L=$(leader); S=$(other "$L")

# ---------------------------------------------------------------- T02
r=$(sql "$L" postgres "select r.rolname, d.datname, left(a.rolpassword, 14), r.rolsuper, r.rolcreatedb from pg_roles r join pg_authid a on a.oid = r.oid join pg_database d on d.datdba = r.oid where r.rolname = 'umami_app'")
[ "$r" = "umami_app|umami|SCRAM-SHA-256\$|f|f" ] && ok "T02 umami_app owns umami, SCRAM verifier, no superuser/createdb" || bad T02 "got '$r'"

# ---------------------------------------------------------------- T03
dc logs "$L" 2>&1 | grep -c 'on_start as primary: CHECKPOINT done' >/dev/null && ok "T03 CHECKPOINT after start on $L" || bad T03 "no CHECKPOINT log line on $L"

# ---------------------------------------------------------------- T04
full_both() { [ "$(metric "$L" 'scf_backup_last_success_timestamp_seconds\{repo="1",type="full"\}')" != 0 ] && [ "$(metric "$L" 'scf_backup_last_success_timestamp_seconds\{repo="2",type="full"\}')" != 0 ]; }
if wait_until 120 full_both && dc exec -T "$L" scf-backup check >>"$LOG" 2>&1; then
  info=$(dc exec -T "$L" bash -c 'for r in 1 2; do scf-backup pgbackrest --repo=$r info | grep -E "status|full backup" | tr -s " " | tr "\n" " "; echo; done')
  ok "T04 full backups + WAL archive in both repositories: $(echo "$info" | tr '\n' '|')"
else bad T04 "no full backup in both repositories / check failed"; fi

# ---------------------------------------------------------------- data for the drills
sql "$L" postgres "select 1 from pg_roles where rolname='scf_hatest'" | grep -q 1 || {
  v=$(dc exec -T "$L" bash -c 'tr -d "\n" </dev/stdin | scf-scram-verifier' <"$HERE/.secrets/ha/scf_hatest_password")
  sql "$L" postgres "create role scf_hatest login password '$v'" >/dev/null
  sql "$L" postgres "create database hatest owner scf_hatest" >/dev/null
  sql "$L" hatest "set role scf_hatest; create table t (id bigint primary key, worker int not null, at timestamptz not null default clock_timestamp())" >/dev/null
}
sql "$L" hatest "insert into t(id, worker) select g, -1 from generate_series(-1000, -1) g" >/dev/null
sleep 2
T_PITR=$(sql "$L" postgres "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 2
sql "$L" hatest "insert into t(id, worker) select g, -2 from generate_series(-2000, -1001) g" >/dev/null

# ---------------------------------------------------------------- T05
if dc exec -T "$L" scf-backup backup diff 1 >>"$LOG" 2>&1 && dc exec -T "$L" scf-backup backup diff 2 >>"$LOG" 2>&1 \
  && [ "$(metric "$L" 'scf_backup_last_success_timestamp_seconds\{repo="2",type="diff"\}')" != 0 ]; then
  ok "T05 differential backups to both repositories"
else bad T05 "differential backup failed"; fi
# Make sure the newest WAL (both batches) is in the archive before the drill restores "latest".
sql "$L" postgres "select pg_switch_wal()" >/dev/null
archived() { [ "$(sql "$L" postgres "select last_archived_wal >= pg_walfile_name(pg_current_wal_lsn() - 1) from pg_stat_archiver")" = t ]; }
wait_until 90 archived || say "note: archive not caught up after 90 s"

# ---------------------------------------------------------------- T06
EXP="$WORK/expect.tsv"
{
  printf 'hatest\tselect count(*)||%s||sum(id) from t\t%s\n' "':'" "$(sql "$L" hatest "select count(*)||':'||sum(id) from t")"
  printf 'scf\tselect count(*) from scf_migrations.applied\t%s\n' "$(sql "$L" scf 'select count(*) from scf_migrations.applied')"
  printf 'umami\tselect count(*) from information_schema.tables where table_schema = %s\t%s\n' "'public'" "$(sql "$L" umami "select count(*) from information_schema.tables where table_schema = 'public'")"
} >"$EXP"
line=$(drill --expect "$EXP" --report-dir "$WORK/drill-reports"); rc=$?
M[drill_latest]=$line
[ $rc = 0 ] && grep -Eq 'gates=[1-9][0-9]*ok' <<<"$line" && grep -q 'counts=3ok' <<<"$line" && ok "T06 $line" || bad T06 "$line"

# ---------------------------------------------------------------- T07
EXP2="$WORK/expect-pitr.tsv"
printf 'hatest\tselect count(*)||%s||sum(id) from t\t1000:-500500\n' "':'" >"$EXP2"
line=$(drill --target "$T_PITR" --expect "$EXP2"); rc=$?
M[drill_pitr]=$line
[ $rc = 0 ] && ok "T07 PITR to $T_PITR: $line" || bad T07 "$line"

# ---------------------------------------------------------------- T08 failover under write load
L=$(leader); S=$(other "$L")
writer_start
wait_until 30 writer_has 100
say "T08: killing primary $L under write load (standby $S)"
T_KILL=$(now)
docker kill -s KILL "$P-$L-1" >/dev/null
promoted() { [ "$(sql "$S" postgres 'select pg_is_in_recovery()')" = f ]; }
wait_until 120 promoted; T_PROMOTED=$(now)
is_leader() { [ "$(leader "$S")" = "$S" ]; }
wait_until 60 is_leader
sleep 20 # keep writing on the new primary
writer_stop failover
first_after=$(awk -v k="$T_KILL" '$2 > k {print $2}' "$WORK/acked.failover" | sort -n | head -n1)
M[fo_detect_promote]=$(dur "$T_KILL" "$T_PROMOTED")
# Write outage = the longest gap between consecutive acknowledged commits from 2 s before the kill onwards (commits
# in flight at the kill can still be acknowledged a few milliseconds after it).
M[fo_write_gap]=$(awk -v k="$T_KILL" '$2 > k - 2 {print $2}' "$WORK/acked.failover" | sort -n | awk 'NR>1 && $1-p > g {g=$1-p} {p=$1} END{printf "%.2f", g}')
first_after=$(awk -v k="$T_PROMOTED" '$2 > k - 30 {print $2}' "$WORK/acked.failover" | sort -n | awk -v k="$T_KILL" '$1 > k + 1' | head -n1)
M[fo_kill_to_first_write]=$( [ -n "$first_after" ] && dur "$T_KILL" "$first_after" || echo "none")
M[fo_acked]=$(wc -l <"$WORK/acked.failover")
M[fo_failed]=$(wc -l <"$WORK/failed.failover")
M[fo_lost]=$(lost_acked failover "$S")
M[fo_unknown_committed]=$(cut -d' ' -f1 "$WORK/failed.failover" | sort | comm -12 - "$WORK/present.failover" | wc -l)
M[fo_timeline]=$(sql "$S" postgres "select timeline_id from pg_control_checkpoint()")
cp_logged=no; dc logs "$S" 2>&1 | grep -c 'on_role_change as primary: CHECKPOINT done' >/dev/null && cp_logged=yes
M[fo_checkpoint]=$cp_logged
# WAL of the new timeline reaches both repositories (pgbackrest check switches a segment and waits for it).
t=$(now)
if dc exec -T "$S" scf-backup check >>"$LOG" 2>&1; then M[fo_archive_tl]="ok in $(dur "$t" "$(now)") s"; else M[fo_archive_tl]=failed; fi
M[fo_archived_wal]=$(sql "$S" postgres "select last_archived_wal from pg_stat_archiver")
say "T08 measures: promote=${M[fo_detect_promote]}s write-gap=${M[fo_write_gap]}s kill→first write=${M[fo_kill_to_first_write]}s acked=${M[fo_acked]} failed=${M[fo_failed]} lost=${M[fo_lost]} TL=${M[fo_timeline]} checkpoint=$cp_logged archive=${M[fo_archive_tl]} wal=${M[fo_archived_wal]}"
if [ "${M[fo_lost]}" = 0 ] && [ "${M[fo_acked]}" -gt 100 ] && [ -n "$first_after" ] && [ "$cp_logged" = yes ] \
  && [ "${M[fo_archive_tl]}" != failed ] && [ "${M[fo_timeline]}" -ge 2 ]; then
  ok "T08 failover: $S promoted ${M[fo_detect_promote]} s after the kill, longest write gap ${M[fo_write_gap]} s, 0 of ${M[fo_acked]} acknowledged writes lost"
else bad T08 "lost=${M[fo_lost]} acked=${M[fo_acked]} first_after=${first_after:-none} checkpoint=$cp_logged archive=${M[fo_archive_tl]} tl=${M[fo_timeline]}"; fi

# ---------------------------------------------------------------- T09 fence + rejoin of the old primary
OLD=$L
t=$(now)
dc start "$OLD" >>"$LOG" 2>&1
rejoined() { members "$S" | grep -q "^$OLD Sync_Standby streaming"; }
if wait_until 180 rejoined; then
  M[fo_rejoin]=$(dur "$t" "$(now)")
  rewind=$(dc logs "$OLD" 2>&1 | grep -ciE 'pg_rewind|rewind' || true)
  M[fo_rewind_lines]=$rewind
  ro=$(sql "$OLD" postgres "select pg_is_in_recovery()")
  same=no
  same_data() { local q="select count(*)::text || ':' || coalesce(sum(id), 0)::text from t" a; a=$(sql "$OLD" hatest "$q"); [ -n "$a" ] && [ "$a" = "$(sql "$S" hatest "$q")" ]; }
  wait_until 30 same_data && same=yes
  if [ "$ro" = t ] && [ "$same" = yes ]; then
    ok "T09 old primary $OLD rejoined as synchronous standby in ${M[fo_rejoin]} s (rewind log lines: $rewind), read-only, data identical"
  else bad T09 "recovery=$ro same=$same"; fi
else bad T09 "$OLD did not rejoin: $(members "$S" | tr '\n' ';')"; fi

# ---------------------------------------------------------------- T10 isolation: self-fencing before promotion
L=$(leader "$S"); S=$(other "$L")
writer_start
wait_until 30 writer_has 100
say "T10: isolating primary $L from etcd, its standby and the proxy"
T_ISO=$(now)
for n in dcs db backup; do docker network disconnect "${P}_$n" "$P-$L-1" 2>>"$LOG"; done
T_DEMOTE="" T_PROMOTE=""
for _ in $(seq 240); do
  # fenced = the isolated node no longer accepts writes: in recovery, or not accepting connections at all
  [ -z "$T_DEMOTE" ] && [ "$(sql "$L" postgres 'select pg_is_in_recovery()')" != f ] && T_DEMOTE=$(now)
  [ -z "$T_PROMOTE" ] && [ "$(sql "$S" postgres 'select pg_is_in_recovery()')" = f ] && T_PROMOTE=$(now)
  [ -n "$T_DEMOTE" ] && [ -n "$T_PROMOTE" ] && break
  sleep 0.5
done
M[iso_demote]=$( [ -n "$T_DEMOTE" ] && dur "$T_ISO" "$T_DEMOTE" || echo never)
M[iso_promote]=$( [ -n "$T_PROMOTE" ] && dur "$T_ISO" "$T_PROMOTE" || echo never)
iso_write=$(dc exec -T "$L" bash -c 'PGPASSWORD=$(cat /run/secrets/pg_superuser_password) psql -X -At -h /var/run/postgresql -U postgres -d hatest -c "insert into t(id, worker) values (888888888, 8)"' 2>&1 | head -n1)
M[iso_write]=$iso_write
dc logs --since "$(date -u -d @"${T_ISO%.*}" +%Y-%m-%dT%H:%M:%SZ)" "$L" "$S" >"$WORK/isolation-patroni.log" 2>&1
sleep 10
for n in dcs db backup; do docker network connect "${P}_$n" "$P-$L-1" 2>>"$LOG"; done
writer_stop iso
M[iso_acked]=$(wc -l <"$WORK/acked.iso")
M[iso_lost]=$(lost_acked iso "$S")
t=$(now)
rejoined_iso() { members "$S" | grep -q "^$L Sync_Standby streaming"; }
wait_until 180 rejoined_iso && M[iso_rejoin]=$(dur "$t" "$(now)") || M[iso_rejoin]=no
say "T10 measures: demote=${M[iso_demote]}s promote=${M[iso_promote]}s write-on-isolated='${M[iso_write]}' acked=${M[iso_acked]} lost=${M[iso_lost]} rejoin=${M[iso_rejoin]}"
if [ -n "$T_DEMOTE" ] && [ -n "$T_PROMOTE" ] && awk -v d="$T_DEMOTE" -v p="$T_PROMOTE" 'BEGIN{exit !(d < p)}' \
  && ! grep -q 'INSERT 0 1' <<<"$iso_write" && [ "${M[iso_acked]}" -gt 100 ] && [ "${M[iso_lost]}" = 0 ] && [ "${M[iso_rejoin]}" != no ]; then
  ok "T10 isolated primary $L demoted at ${M[iso_demote]} s, before $S was promoted at ${M[iso_promote]} s; 0 of ${M[iso_acked]} acknowledged writes lost; rejoined in ${M[iso_rejoin]} s"
else bad T10 "demote=${M[iso_demote]} promote=${M[iso_promote]} write='${M[iso_write]}' lost=${M[iso_lost]} rejoin=${M[iso_rejoin]}"; fi

# ---------------------------------------------------------------- T11 PgBouncer for a runtime role
L=$(leader "$S")
r=$(dc --profile hatest run --rm --no-deps -T --entrypoint bash -v "$HERE/.secrets/scf_app_password:/run/secrets/app:ro" hatest-writer \
  -c 'PGPASSWORD=$(cat /run/secrets/app) psql -X -At -h pgbouncer -p 6432 -U scf_app -d scf -c "select pg_is_in_recovery(), inet_server_addr() is not null"' 2>>"$LOG")
[ "$r" = "f|t" ] && ok "T11 scf_app through PgBouncer reaches a writable primary ($L) after two failovers" || bad T11 "got '$r'"

# ---------------------------------------------------------------- T12 corrupted backup
L=$(leader)
labels=$(dc exec -T "$L" scf-backup pgbackrest --repo=2 info --output=json | python3 -I -c 'import json,sys; b=json.load(sys.stdin)[0]["backup"]; print(" ".join(x["label"] for x in b))')
sasf="$HERE/.secrets/ha/pgbackrest_repo2_key"
n_corrupt=$(dc run --rm --no-deps -T --entrypoint bash -v "$sasf:/run/secrets/sas:ro" -e SCF_AZ_CA=/run/secrets/azurite_ca azurite-init -c '
  set -e; sas=$(cat /run/secrets/sas); n=0; head -c 4096 /dev/urandom >/dev/shm/junk
  for label in '"$labels"'; do
    for b in $(scf-azblob list https://azurite-b:10000/scfbackupb pgbackrest "$sas" "scf/backup/scf/$label/"); do
      case $b in */bundle/*|*.pgbi) scf-azblob put https://azurite-b:10000/scfbackupb pgbackrest "$sas" "$b" /dev/shm/junk; n=$((n+1));; esac
    done
  done; echo $n' 2>>"$LOG" | tail -n1)
line=$(drill); rc=$?
M[drill_corrupt]=$line
M[corrupt_blobs]=$n_corrupt
if [ $rc != 0 ] && grep -q '^RESTORE-DRILL FAIL' <<<"$line" && [ "${n_corrupt:-0}" -gt 0 ]; then
  ok "T12a corrupted backup ($n_corrupt bundle blobs overwritten in repo2) → $line"
else bad T12a "drill did not fail on a corrupted backup (corrupted=$n_corrupt): $line"; fi
dm=$(docker run --rm -v "${P}_drill-metrics:/m:ro" --entrypoint sh "$PG_IMAGE" -c 'grep -E "^scf_restore_drill_success" /m/scf_restore_drill.prom')
[ "$dm" = 'scf_restore_drill_success{repo="2"} 0' ] && ok "T12b drill metric reports the failure ($dm)" || bad T12b "metric '$dm'"
if dc exec -T "$L" scf-backup backup full 2 >>"$LOG" 2>&1; then
  line=$(drill); rc=$?
  [ $rc = 0 ] && ok "T12c after a new full backup: $line" || bad T12c "$line"
else bad T12c "new full backup failed"; fi

# ---------------------------------------------------------------- T13 logical dump → migration check
# The import checks the dump against the hash from the dump's own log line (out of band), never only against the
# SHA256SUMS stored next to it; it restores each database with --create, so owners and ACLs (umami: no PUBLIC
# CONNECT) survive, and compares them.
verify_dump() { local l; l=$(dc --profile migration run --rm --no-deps -T dump-verify "$@" 2>>"$LOG" | grep -E '^DUMP-RESTORE' | tail -n1)
  docker volume rm -f "${P}_dump-verify" >/dev/null 2>&1; echo "$l"; }
if dump_out=$(dc exec -T "$L" scf-backup dump 2>&1); then
  echo "$dump_out" >>"$LOG"
  dsha=$(sed -n 's/^.* scf-backup: dump [^ ]* sha256 \([0-9a-f]\{64\}\)$/\1/p' <<<"$dump_out" | tail -n1)
  line=$(verify_dump --expect-sha256 "$dsha")
  M[dump]=$line
  grep -q '^DUMP-RESTORE PASS.* checksum=out-of-band' <<<"$line" && ok "T13 $line" || bad T13 "sha=${dsha:-none}: $line"
  line=$(verify_dump --expect-sha256 "$(printf '%064d' 0)")
  grep -q '^DUMP-RESTORE FAIL .*stage=verify' <<<"$line" && ok "T13b a wrong out-of-band hash is refused: $line" || bad T13b "$line"
  line=$(verify_dump)
  grep -q '^DUMP-RESTORE FAIL .*stage=args.*no out-of-band checksum' <<<"$line" && ok "T13c no out-of-band hash → refused: $line" || bad T13c "$line"
else echo "$dump_out" >>"$LOG"; bad T13 "dump failed"; fi

# ---------------------------------------------------------------- T14 no secret in any log
dc logs --no-color >"$WORK/all.log" 2>&1
leaks=0
for f in "$HERE"/.secrets/ha/{pg_replication_password,pg_rewind_password,patroni_restapi_password,pgbackrest_repo1_cipher_pass,pgbackrest_repo2_cipher_pass,scf_hatest_password,azurite_a_key,azurite_b_key} "$HERE/.secrets/pg_superuser_password" "$HERE/.secrets/umami_db_password"; do
  v=$(tr -d '\n' <"$f"); [ -n "$v" ] && grep -qF "$v" "$WORK/all.log" && { leaks=$((leaks + 1)); say "leak: $(basename "$f")"; }
done
for f in pgbackrest_repo1_key pgbackrest_repo2_key pgbackrest_repo2_drill_sas; do
  sig=$(sed -n 's/.*sig=\([^&]*\).*/\1/p' "$HERE/.secrets/ha/$f"); [ -n "$sig" ] && grep -qF "$sig" "$WORK/all.log" && { leaks=$((leaks + 1)); say "leak: $f"; }
done
[ $leaks = 0 ] && ok "T14 no secret value in $(wc -l <"$WORK/all.log") log lines" || bad T14 "$leaks secret(s) in logs"

# ---------------------------------------------------------------- T15 DCS TLS (F15)
D="$HERE/.secrets/ha/dcs"
t15=$(docker run --rm --network "${P}_dcs" -v "$D/ca.pem:/c/ca.pem:ro" -v "$D/patroni-etcd-client.pem:/c/cl.pem:ro" \
  -v "$D/patroni-etcd-client-key.pem:/c/cl-key.pem:ro" -v "$HERE/.secrets/pki/ca.pem:/c/other-ca.pem:ro" \
  --entrypoint bash "$PG_IMAGE" -c '
r=""
curl -s -m 5 -o /dev/null http://etcd-a:2379/health && r+=" plaintext-accepted"
curl -s -m 5 -o /dev/null --cacert /c/ca.pem https://etcd-a:2379/health && r+=" no-client-cert-accepted"
curl -fs -m 5 -o /dev/null --cacert /c/ca.pem --cert /c/cl.pem --key /c/cl-key.pem https://etcd-a:2379/health || r+=" client-cert-refused"
curl -s -m 5 -o /dev/null --cacert /c/other-ca.pem https://etcd-b:2380/members && r+=" peer-port-wrong-ca-accepted"
echo "${r:-ok}"' 2>>"$LOG")
t15b=$(docker run --rm --network "${P}_db" -v "$D/ca.pem:/c/ca.pem:ro" --entrypoint bash "$PG_IMAGE" -c '
r=""
curl -fs -m 5 -o /dev/null --cacert /c/ca.pem https://pg-a:8008/health || r+=" rest-https-failed"
curl -s -m 5 -o /dev/null http://pg-a:8008/health && r+=" rest-plain-http-accepted"
echo "${r:-ok}"' 2>>"$LOG")
peers=$(dc logs --no-color etcd-a etcd-b etcd-c 2>/dev/null | grep -ci 'peer.*http://' || true)
if [ "$t15" = ok ] && [ "$t15b" = ok ] && [ "${peers:-0}" = 0 ]; then
  ok "T15 etcd: TLS + client certificates on client and peer ports; Patroni REST API HTTPS only"
else bad T15 "etcd:$t15 rest:$t15b plaintext-peer-log-lines:$peers"; fi

say "RESULT: $PASS passed, $FAIL failed (log: $LOG)"
for k in "${!M[@]}"; do echo "$k=${M[$k]}"; done | sort >"$WORK/measures.txt"
cat "$WORK/measures.txt" >>"$LOG"
if [ -n "$EVIDENCE_DIR" ]; then
  mkdir -p "$EVIDENCE_DIR"
  cp "$LOG" "$EVIDENCE_DIR/ha-suite-$(date -u +%Y%m%dT%H%M%SZ).log"
  cp "$WORK"/drill-reports/*.json "$EVIDENCE_DIR/" 2>/dev/null
  cp "$WORK/measures.txt" "$EVIDENCE_DIR/ha-suite-measures-$(date -u +%Y%m%dT%H%M%SZ).txt"
fi
[ $FAIL = 0 ]
