#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-08 — reproduces every observation in README.md. One command: ./run.sh   (KEEP=1 leaves the stack up)
# Docker project scf-s08, no published host ports. Output is also written to evidence/run.log.
# Not -e: several steps are expected to fail and the failure is the evidence.
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p evidence .work/certs
exec > >(tee evidence/run.log) 2>&1

P=scf-s08
DC=(docker compose -p "$P" --env-file .work/secrets.env)
now() { date +%s.%N; }
dur() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.2f", b-a}'; }
step() { printf '\n===== %s  [%s]\n' "$*" "$(date -u +%H:%M:%S)"; }
# pgBackRest prints every option on "command begin"; drop that line for readability.
pb() { local svc=$1; shift; "${DC[@]}" exec -T -u postgres "$svc" pgbackrest "$@" 2>&1 | grep -v 'command begin'; return "${PIPESTATUS[0]}"; }
sqlc() { local svc=$1 db=$2; shift 2; "${DC[@]}" exec -T -u postgres "$svc" psql -X -v ON_ERROR_STOP=1 -At -h 127.0.0.1 -d "$db" -c "$*"; }
tools() { "${DC[@]}" run --rm -q tools "$@" 2>&1 | grep -v 'level=warn'; }
setenv() { sed -i "/^$1=/d" .work/secrets.env; printf '%s=%s\n' "$1" "$2" >> .work/secrets.env; }
wait_state() { # svc want(t|f) timeout -> prints seconds waited
  local svc=$1 want=$2 max=${3:-300} t0; t0=$(now)
  for _ in $(seq "$((max * 2))"); do
    [ "$(sqlc "$svc" postgres 'select pg_is_in_recovery()' 2>/dev/null)" = "$want" ] && { dur "$t0" "$(now)"; return 0; }
    sleep 0.5
  done
  echo "TIMEOUT waiting for $svc"; "${DC[@]}" logs --tail 30 "$svc"; return 1
}

step "0. reset + secrets + certificates + images"
[ -f .work/secrets.env ] && docker compose -p "$P" --env-file .work/secrets.env --profile '*' down -v --remove-orphans >/dev/null 2>&1 || true
C=.work/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=scf-s08 test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout $C/ca.key -out $C/ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=azurite" -keyout $C/azurite.key -out $C/azurite.csr 2>/dev/null
printf '%s\n' "basicConstraints=CA:FALSE" "keyUsage=critical,digitalSignature,keyEncipherment" \
  "subjectAltName=DNS:azurite-a,DNS:azurite-b,DNS:scfbackupa.blob.azurite-a" "extendedKeyUsage=serverAuth" \
  "authorityKeyIdentifier=keyid" "subjectKeyIdentifier=hash" > $C/ext.cnf
openssl x509 -req -in $C/azurite.csr -CA $C/ca.crt -CAkey $C/ca.key -CAcreateserial -days 7 \
  -extfile $C/ext.cnf -out $C/azurite.crt 2>/dev/null
chmod 644 $C/ca.crt $C/azurite.crt $C/azurite.key
umask 077
{
  echo "AZ_A_KEY=$(openssl rand -base64 64 | tr -d '\n')"
  echo "AZ_B_KEY=$(openssl rand -base64 64 | tr -d '\n')"
  echo "CIPHER_A=$(openssl rand -base64 48 | tr -d '\n')"
  echo "CIPHER_B=$(openssl rand -base64 48 | tr -d '\n')"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
  echo "REPLICATOR_PASSWORD=$(openssl rand -hex 16)"
  echo "WALG_LIBSODIUM_KEY=$(openssl rand -hex 32)"
  echo "SAS_ND=" ; echo "SAS_B_READONLY="
} > .work/secrets.env
umask 022
docker build -q -t scf-s08-pg:latest . && docker build -q -t scf-s08-tools:latest tools
docker run --rm scf-s08-pg:latest bash -c 'pgbackrest version; wal-g --version; dpkg-query -W pgbackrest postgresql-18'
docker image inspect postgres:18 --format 'postgres:18 digest {{index .RepoDigests 0}}'

step "1. Azurite x2 (two storage accounts = two 'providers'), containers, immutability probe"
"${DC[@]}" up -d azurite-a azurite-b 2>&1 | grep -v level=warn | tail -2
sleep 3
"${DC[@]}" exec -T azurite-a sh -c 'node -e "console.log(\"azurite \"+require(\"/opt/azurite/package.json\").version)"'
tools A mk pgbr; tools B mk pgbr; tools A mk pgbr-nd; tools A mk walg
tools A probe-immutability pgbr-nd
setenv SAS_ND "$(tools A sas pgbr-nd racwl)"        # everything except delete
setenv SAS_B_READONLY "$(tools B sas pgbr rl)"      # restore drill: read + list only

step "2. primary PG18 + stanza on repo1+repo2 (TLS against Azurite with a private CA)"
"${DC[@]}" up -d pg-primary 2>&1 | grep -v level=warn | tail -1
wait_state pg-primary f 120 >/dev/null
sqlc pg-primary postgres "create database scf" >/dev/null
sqlc pg-primary scf "create table pitr_test(id bigserial primary key, batch int not null, created timestamptz not null default clock_timestamp(), payload text not null)" >/dev/null
sqlc pg-primary postgres "select version()"
sqlc pg-primary postgres "select name||'='||setting from pg_settings where name in ('archive_mode','archive_command','archive_timeout','wal_level','data_checksums') order by 1"
pb pg-primary --stanza=scf stanza-create
pb pg-primary --stanza=scf check

step "2b. TLS variants against Azurite (repo-ls on repo1)"
echo "-- with repo1-storage-ca-file=/certs/ca.crt:"; pb pg-primary --repo=1 repo-ls; echo "exit=$?"
echo "-- without the CA file (system trust store):"; pb pg-primary --repo=1 --reset-repo1-storage-ca-file repo-ls; echo "exit=$?"
echo "-- without the CA file, repo1-storage-verify-tls=n:"; pb pg-primary --repo=1 --reset-repo1-storage-ca-file --repo1-storage-verify-tls=n repo-ls; echo "exit=$?"

step "3. archive_timeout=60: time from an idle write to the segment being archived"
for sample in 1 2 3; do
  sleep $((sample * 7))   # vary the phase of the write relative to the checkpointer's 60 s tick
  seg=$(sqlc pg-primary scf "insert into pitr_test(batch,payload) values (0,'archive-timeout probe') returning pg_walfile_name(pg_current_wal_lsn())" | head -1)
  t0=$(now); sw=""
  while :; do
    cur=$(sqlc pg-primary postgres "select pg_walfile_name(pg_current_wal_lsn())")
    [ -z "$sw" ] && [ "$cur" != "$seg" ] && sw=$(dur "$t0" "$(now)")
    [ "$(sqlc pg-primary postgres "select coalesce(last_archived_wal,'') >= '$seg' from pg_stat_archiver")" = t ] && break
    [ "$(dur "$t0" "$(now)" | cut -d. -f1)" -gt 330 ] && { echo "sample $sample: NOT archived within 330 s"; break; }
    sleep 0.5
  done
  echo "sample $sample: write in $seg -> segment switched after ${sw:-?} s, archived to both repos after $(dur "$t0" "$(now)") s"
done
docker logs "${P}-pg-primary-1" 2>&1 | grep -E 'checkpoint starting' | tail -3 | sed 's/^/  /'
sqlc pg-primary scf "delete from pitr_test" >/dev/null

step "4. full (repo1, repo2) -> batch1 -> diff (repo1, repo2) -> batch2 -> T -> batch3"
load() { sqlc pg-primary scf "insert into pitr_test(batch,payload) select $1, md5(g::text) from generate_series(1,100000) g" >/dev/null; }
for r in 1 2; do t0=$(now); pb pg-primary --stanza=scf --repo=$r --type=full backup | grep -E 'new backup label|backup size|completed'; echo "FULL repo$r: $(dur "$t0" "$(now)") s"; done
load 1
for r in 1 2; do t0=$(now); pb pg-primary --stanza=scf --repo=$r --type=diff backup | grep -E 'new backup label|backup size|completed'; echo "DIFF repo$r: $(dur "$t0" "$(now)") s"; done
load 2
sleep 1
T=$(sqlc pg-primary postgres "select to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00'")
sleep 1
load 3
echo "PITR target T = $T"
sqlc pg-primary scf "select 'primary batch '||batch||': '||count(*) from pitr_test group by batch order by batch"
echo "rows committed before T: $(sqlc pg-primary scf "select count(*) from pitr_test where created < '$T'")"
pb pg-primary --stanza=scf check | grep -E 'archived|completed'
pb pg-primary --stanza=scf info

step "5. both repositories hold the backups and the WAL"
for s in A B; do echo "-- account $s"; tools $s ls pgbr | grep -E '\.info$|backup\.manifest$|^#' ; tools $s count pgbr scf/archive/; done

step "6. PITR to T from repo1 into a fresh container"
export PITR_ARGS="--repo=1 --type=time --target-action=promote" PITR_TARGET="$T"
t0=$(now)
"${DC[@]}" --profile restore up -d --no-deps pg-pitr 2>&1 | grep -v level=warn | tail -1
wait_state pg-pitr f 600 >/dev/null
t1=$(now)
"${DC[@]}" exec -T pg-pitr cat /var/lib/postgresql/restore-timing
echo "PITR container up -> promoted and writable: $(dur "$t0" "$t1") s"
"${DC[@]}" logs pg-pitr 2>&1 | grep -E 'starting point-in-time|recovery stopping|redo done|selected new timeline|archive recovery complete' | sed 's/^/  /'
sqlc pg-pitr scf "select 'restored batch '||batch||': '||count(*) from pitr_test group by batch order by batch"
got=$(sqlc pg-pitr scf "select count(*) filter (where batch=1)||'/'||count(*) filter (where batch=2)||'/'||count(*) filter (where batch=3) from pitr_test")
[ "$got" = "100000/100000/0" ] && echo "PITR VERIFY PASS (batch1/2/3 = $got)" || echo "PITR VERIFY FAIL (batch1/2/3 = $got, want 100000/100000/0)"
"${DC[@]}" rm -sf pg-pitr >/dev/null 2>&1; docker volume rm -f ${P}_pitr >/dev/null

step "7. restore drill (repo2, read+list SAS only, latest)"
printf 'scf pitr_test %s\n' "$(sqlc pg-primary scf "select count(*)||' '||sum(id) from pitr_test")" > .work/expected.txt
cat .work/expected.txt
./restore-drill.sh --expect .work/expected.txt
echo "-- negative control: corrupted expectation must FAIL"
printf 'scf pitr_test 1 1\n' > .work/expected-bad.txt
./restore-drill.sh --expect .work/expected-bad.txt || true
echo "-- drill to time T (PITR from repo2)"
printf 'scf pitr_test %s\n' "$(sqlc pg-primary scf "select count(*)||' '||sum(id) from pitr_test where batch<3")" > .work/expected-T.txt
./restore-drill.sh --target "$T" --expect .work/expected-T.txt

step "8. C-66: database node holding a SAS WITHOUT delete (perms racwl) on its own stanza"
"${DC[@]}" --profile nodelete up -d pg-nodelete 2>&1 | grep -v level=warn | tail -1
wait_state pg-nodelete f 120 >/dev/null
pb pg-nodelete --stanza=nd stanza-create | grep -E 'stanza-create|ERROR'
echo "-- archive-push / check with the no-delete SAS:"
pb pg-nodelete --stanza=nd check | grep -E 'archived|ERROR|completed'
echo "-- full backup with --no-expire-auto (debug: every remove pgBackRest issues):"
pb pg-nodelete --stanza=nd --type=full --no-expire-auto --log-level-console=debug backup \
  | grep -E 'storageRemove: \(|storagePathRemove: \(|ERROR: \[|command end|new backup label' \
  | grep -oE '(new backup label.*|ERROR: .*|command end.*|storage(Path)?Remove: .*(file|path)Exp: \{[^}]*\})'
echo "-- second full: first cleans up the aborted one (storagePathRemove) -> 403 again:"
pb pg-nodelete --stanza=nd --type=full --no-expire-auto --log-level-console=debug backup \
  | grep -E 'storagePathRemove: \(|ERROR: \[|command end' | grep -oE '(ERROR: .*|command end.*|pathExp: \{[^}]*\})'
echo "-- info: no backup ever completed:"; pb pg-nodelete --stanza=nd info | grep -E 'status|full backup|wal archive'
echo "-- expire with the no-delete SAS:"; pb pg-nodelete --stanza=nd expire | grep -E 'ERROR|command end'

step "8b. SAS with create but WITHOUT write/delete (perms rcl)"
setenv SAS_ND "$(tools A sas pgbr-nd rcl)"
"${DC[@]}" --profile nodelete up -d pg-nodelete 2>&1 | grep -v level=warn | tail -1
wait_state pg-nodelete f 120 >/dev/null
echo "-- check (archive-push of a new segment is a create):"; pb pg-nodelete --stanza=nd check | grep -E 'archived|ERROR|command end'
echo "-- full backup:"; pb pg-nodelete --stanza=nd --type=full --no-expire-auto backup | grep -E 'ERROR|command end'
step "9. streaming standby (restored from repo1) + synchronous replication"
"${DC[@]}" --profile standby up -d --no-deps pg-standby 2>&1 | grep -v level=warn | tail -1
wait_state pg-standby t 600 >/dev/null
"${DC[@]}" exec -T pg-standby cat /var/lib/postgresql/restore-timing
sqlc pg-primary postgres "alter system set synchronous_standby_names = 'standby1'" >/dev/null
sqlc pg-primary postgres "select pg_reload_conf()" >/dev/null
for _ in $(seq 60); do s=$(sqlc pg-primary postgres "select sync_state from pg_stat_replication where application_name='standby1'"); [ "$s" = sync ] && break; sleep 1; done
sqlc pg-primary postgres "select 'replication: '||application_name||' state='||state||' sync='||sync_state from pg_stat_replication"
sqlc pg-primary scf "insert into pitr_test(batch,payload) values (9,'before failover')" >/dev/null
echo "standby sees batch 9: $(sqlc pg-standby scf "select count(*) from pitr_test where batch=9")"

step "10. promotion while the old primary is still alive (what happens without fencing)"
t0=$(now)
"${DC[@]}" exec -T -u postgres pg-standby pg_ctl promote -w -D /var/lib/postgresql/18/docker
t1=$(now)
sqlc pg-standby scf "insert into pitr_test(batch,payload) values (10,'first write on new primary')" >/dev/null
t2=$(now)
echo "pg_ctl promote -w: $(dur "$t0" "$t1") s; promote + first committed write: $(dur "$t0" "$t2") s"
sqlc pg-standby postgres "select 'new primary: in_recovery='||pg_is_in_recovery()||' current WAL file='||pg_walfile_name(pg_current_wal_lsn())"
echo "-- old primary, default synchronous_commit, statement_timeout=5s: the commit blocks on the gone sync standby"
( "${DC[@]}" exec -T -u postgres pg-primary psql -X -At -h 127.0.0.1 -d scf -c "set statement_timeout='5s'" \
    -c "insert into pitr_test(batch,payload) values (11,'split brain, sync')" 2>&1 | sed 's/^/  [blocked client] /' ) &
bgp=$!
sleep 15
sqlc pg-primary postgres "select '  after 15 s: state='||state||' wait_event='||coalesce(wait_event,'-')||' (statement_timeout does not cover the SyncRep wait)' from pg_stat_activity where wait_event='SyncRep'"
sqlc pg-primary postgres "select '  pg_cancel_backend -> '||pg_cancel_backend(pid) from pg_stat_activity where wait_event='SyncRep'"
wait $bgp
echo "-- old primary, synchronous_commit=local (what non-strict sync / an app with local commit does):"
"${DC[@]}" exec -T -u postgres pg-primary psql -X -At -h 127.0.0.1 -d scf -c "set synchronous_commit=local" \
  -c "insert into pitr_test(batch,payload) values (12,'split brain, local')" 2>&1 | sed 's/^/  /'
echo "old primary rows in batches 11/12 (diverged history): $(sqlc pg-primary scf "select count(*) from pitr_test where batch in (11,12)")"

step "11. fencing the old primary"
t0=$(now); "${DC[@]}" kill -s SIGKILL pg-primary 2>&1 | grep -v level=warn | tail -1; echo "fenced (SIGKILL = power-off via provider API) in $(dur "$t0" "$(now)") s"
"${DC[@]}" run --rm --no-deps -q -u postgres --entrypoint psql pg-primary -X -h pg-primary -d scf -c "select 1" 2>&1 | grep -v level=warn | sed 's/^/  connect to old primary: /' || true
echo "-- restart the old primary DEMOTED (standby.signal) pointing at the new primary:"
"${DC[@]}" run --rm --no-deps -q -u postgres --entrypoint bash pg-primary -c \
  "touch /var/lib/postgresql/18/docker/standby.signal && echo \"primary_conninfo = 'host=pg-standby user=replicator password=\$REPLICATOR_PASSWORD application_name=oldprimary'\" >> /var/lib/postgresql/18/docker/postgresql.auto.conf" 2>&1 | grep -v level=warn || true
"${DC[@]}" start pg-primary 2>&1 | grep -v level=warn | tail -1
wait_state pg-primary t 120 >/dev/null
"${DC[@]}" exec -T -u postgres pg-primary psql -X -At -h 127.0.0.1 -d scf -c "insert into pitr_test(batch,payload) values (13,'after fencing')" 2>&1 | sed 's/^/  write on demoted old primary: /'
sleep 3
"${DC[@]}" logs --tail 40 pg-primary 2>&1 | grep -iE 'timeline|fork|diverg|requested' | tail -3 | sed 's/^/  /'
echo "-- pg_rewind the old primary onto the new timeline (Patroni does this with use_pg_rewind):"
"${DC[@]}" stop pg-primary 2>&1 | grep -v level=warn | tail -1
"${DC[@]}" run --rm --no-deps -q -u postgres --entrypoint bash pg-primary -c \
  "PGPASSWORD=\$POSTGRES_PASSWORD pg_rewind -D /var/lib/postgresql/18/docker --source-server='host=pg-standby user=postgres dbname=postgres' --progress 2>&1 | tail -4; touch /var/lib/postgresql/18/docker/standby.signal; echo \"primary_conninfo = 'host=pg-standby user=replicator password=\$REPLICATOR_PASSWORD application_name=oldprimary'\" >> /var/lib/postgresql/18/docker/postgresql.auto.conf" 2>&1 | grep -v level=warn | sed 's/^/  /' || true
"${DC[@]}" start pg-primary 2>&1 | grep -v level=warn | tail -1
wait_state pg-primary t 120 >/dev/null && sleep 3
sqlc pg-standby postgres "select 'new primary replication: '||application_name||' state='||state from pg_stat_replication"
echo "old primary after rewind: batch 11/12 rows=$(sqlc pg-primary scf "select count(*) from pitr_test where batch in (11,12)") batch 10 rows=$(sqlc pg-primary scf "select count(*) from pitr_test where batch=10")"
echo "-- archive on the new timeline (new primary pushes to both repos):"
pb pg-standby --stanza=scf check | grep -E 'archived|ERROR|completed'

step "12. WAL-G 3.0.9 fallback against Azurite (host-style URL, libsodium encryption)"
"${DC[@]}" --profile walg up -d pg-walg 2>&1 | grep -v level=warn | tail -1
wait_state pg-walg f 120 >/dev/null
echo "-- archive_timeout mitigation check: CHECKPOINT right after start, then one small write"
sqlc pg-walg postgres "checkpoint" >/dev/null; sleep 1
seg=$(sqlc pg-walg postgres "create table at_probe(x int); insert into at_probe values (1); select pg_walfile_name(pg_current_wal_lsn())" | tail -1)
t0=$(now)
for _ in $(seq 400); do [ "$(sqlc pg-walg postgres "select coalesce(last_archived_wal,'') >= '$seg' from pg_stat_archiver")" = t ] && break; sleep 0.5; done
echo "fresh instance + CHECKPOINT: write in $seg archived after $(dur "$t0" "$(now)") s"
sqlc pg-walg postgres "create table w(id bigserial primary key, payload text); insert into w(payload) select md5(g::text) from generate_series(1,100000) g" >/dev/null
t0=$(now); "${DC[@]}" exec -T -u postgres pg-walg wal-g backup-push /var/lib/postgresql/18/docker 2>&1 | grep -E 'Wrote backup|ERROR|error|Selecting|backup-push' | tail -3; echo "WAL-G backup-push: $(dur "$t0" "$(now)") s"
sqlc pg-walg postgres "insert into w(payload) select md5(g::text) from generate_series(1,100000) g" >/dev/null
want=$(sqlc pg-walg postgres "select count(*)||' '||sum(id) from w")
seg=$(sqlc pg-walg postgres "select pg_walfile_name(pg_switch_wal())")
for _ in $(seq 60); do [ "$(sqlc pg-walg postgres "select coalesce(last_archived_wal,'') >= '$seg' from pg_stat_archiver")" = t ] && break; sleep 1; done
echo "last WAL needed $seg archived: $(sqlc pg-walg postgres 'select last_archived_wal from pg_stat_archiver')"
"${DC[@]}" exec -T -u postgres pg-walg wal-g backup-list 2>&1 | tail -2
tools A count walg
t0=$(now)
"${DC[@]}" --profile walg up -d --no-deps pg-walg-restore 2>&1 | grep -v level=warn | tail -1
wait_state pg-walg-restore f 600 >/dev/null
"${DC[@]}" exec -T pg-walg-restore cat /var/lib/postgresql/restore-timing
got=$(sqlc pg-walg-restore postgres "select count(*)||' '||sum(id) from w")
echo "WAL-G restore up->writable $(dur "$t0" "$(now)") s; rows want '$want' got '$got' -> $([ "$want" = "$got" ] && echo PASS || echo FAIL)"
echo "WAL-G binary LZO symbols: $(docker run --rm scf-s08-pg:latest bash -c "grep -a -o -E 'lzo1x_[a-z0-9_]+' /usr/local/bin/wal-g | sort -u | head -5 | tr '\n' ' '")"

step "12b. lifecycle drift: a rule deletes the repo1 full backup behind pgBackRest's back"
echo "-- blob layout of repo1 (what an Azure lifecycle prefixMatch has to target):"
tools A ls pgbr | awk '{print $2}' | sed -E 's#/[0-9A-F]{24}(-[0-9a-f]+)?(\.zst)?$#/<WAL segment>#; s#/[0-9A-F]{24}\.[0-9A-F]{8}\.backup$#/<backup label file>#; s#(/[0-9]{8}-[0-9]{6}F(_[0-9]{8}-[0-9]{6}[DI])?)/.*#\1/<backup files>#; s#[0-9]{8}-[0-9]{6}F(_[0-9]{8}-[0-9]{6}[DI])?#<label>#g' | grep -v '^#' | sort | uniq -c
full=$(pb pg-standby --stanza=scf --repo=1 --log-level-console=warn info --output=json | python3 -c 'import json,sys; print([b["label"] for b in json.load(sys.stdin)[0]["backup"] if b["type"]=="full"][0])')
diff=$(pb pg-standby --stanza=scf --repo=1 --log-level-console=warn info --output=json | python3 -c 'import json,sys; print([b["label"] for b in json.load(sys.stdin)[0]["backup"] if b["type"]=="diff"][0])')
echo "repo1 full=$full diff=$diff; deleting scf/backup/scf/$full/ only"
tools A rm pgbr "scf/backup/scf/$full/"
echo "-- info after deletion:"; pb pg-standby --stanza=scf --repo=1 info | grep -E 'full backup|diff backup|status'
echo "-- verify after deletion:"; vout=$(pb pg-standby --stanza=scf --repo=1 verify); echo "verify exit=$?"
printf '%s\n' "$vout" | grep -E 'WARN|ERROR|command end' | head -4; echo "  ... 'file missing' lines: $(printf '%s\n' "$vout" | grep -c 'file missing')"
echo "-- restore of the diff (depends on the deleted full) into a scratch dir:"
"${DC[@]}" --profile restore run --rm --no-deps -q -u postgres --entrypoint pgbackrest pg-pitr \
  --stanza=scf --repo=1 --set="$diff" --pg1-path=/var/lib/postgresql/scratch restore 2>&1 | grep -E 'ERROR|HINT|command end' | head -3

step "13. cleanup"
if [ "${KEEP:-0}" = 1 ]; then echo "KEEP=1: stack left running"; else
  docker compose -p "$P" --env-file .work/secrets.env --profile '*' down -v --remove-orphans 2>&1 | grep -v level=warn | tail -1
fi
echo "done"
