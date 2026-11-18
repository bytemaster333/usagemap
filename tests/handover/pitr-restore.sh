#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Path (b) of the handover drill: the new operator restores the old operator's pgBackRest repository 2 (read+list SAS
# and repository 2's cipher pass, handed over — handover plan I-11, I-12, §4.5) into an empty data directory, starts
# it with archiving off (it must never push WAL into the old repository), waits for the end of recovery, prints the
# data fingerprint (fingerprint.sh) and runs pg_amcheck. Runs in the source project's `pg-drill` service
# definition (repository 2 only, `rl` SAS, its own volume), entrypoint replaced.
set -euo pipefail
export PGBACKREST_REPO2_AZURE_KEY PGBACKREST_REPO2_CIPHER_PASS
PGBACKREST_REPO2_AZURE_KEY=$(cat /run/secrets/pgbackrest_repo2_drill_sas)
PGBACKREST_REPO2_CIPHER_PASS=$(cat /run/secrets/pgbackrest_repo2_cipher_pass)
: "${PGDATA:?}"
[ -s "$PGDATA/PG_VERSION" ] && { echo "pitr-restore: PGDATA not empty" >&2; exit 1; }
mkdir -p "$PGDATA" && chmod 0700 "$PGDATA"
t0=$(date +%s)
pgbackrest --stanza=scf --repo=2 restore >&2
t1=$(date +%s)
printf 'local all all trust\n' >/tmp/hba.conf
pg_ctl -D "$PGDATA" -l /tmp/pg.log -w -t 900 -o "-c listen_addresses='' -c unix_socket_directories=/var/run/postgresql -c hba_file=/tmp/hba.conf -c archive_mode=off -c synchronous_standby_names='' -c primary_conninfo='' -c primary_slot_name=''" start >&2
export PGHOST=/var/run/postgresql PGUSER=postgres
for _ in $(seq 900); do [ "$(psql -X -At -d postgres -c 'select pg_is_in_recovery()')" = f ] && break; sleep 1; done
[ "$(psql -X -At -d postgres -c 'select pg_is_in_recovery()')" = f ] || { tail -n5 /tmp/pg.log >&2; exit 1; }
t2=$(date +%s)
# Fingerprint first: pg_amcheck --install-missing adds the amcheck extension, which the schema part would see.
bash /handover/fingerprint.sh scf umami
pg_amcheck --all --install-missing --heapallindexed >&2
t3=$(date +%s)
echo "PITR-RESTORE restore=$((t1 - t0))s recovery=$((t2 - t1))s amcheck=$((t3 - t2))s" >&2
pg_ctl -D "$PGDATA" -m fast stop >/dev/null
