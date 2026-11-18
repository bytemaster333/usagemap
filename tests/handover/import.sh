#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Import of a weekly logical dump (the format of `scf-backup dump`: dump.tar.age + SHA256SUMS; inside globals.sql,
# <db>.dump per database, databases.txt, manifest.tsv) into the NEW operator's PostgreSQL — handover plan §4.2 steps
# 2–3, §4.3 "file integrity" (handover.independent-operator, handover.data-migration, handover.ready). Runs in the usagemap/postgres-ha image (age, pg_restore 18).
#
#   import.sh --dir DIR --expect-sha256 HEX --identity FILE [--scratch | --into-fresh] [--no-create]
#
#   --expect-sha256  the SHA-256 of dump.tar.age as the old operator computed it, received over a SEPARATE channel
#                    (signed handover record, call, second transfer). The SHA256SUMS file next to the dump travels with
#                    it, so whoever can replace the dump can replace that file too: it is checked, but never trusted
#                    on its own. Required.
#   --identity       the age identity that decrypts the dump (handed over securely, handover plan I-12)
#   --scratch        initdb a throwaway server in $PGDATA (socket only) and import there (tests, rehearsal)
#   --into-fresh     import into the server at PGHOST/PGUSER/PGPASSWORD, which must be FRESH: no `scf` database, and
#                    `umami` absent or without a single table. Both are then dropped and recreated from the dump.
#   --no-create      restore each database into a plain CREATE DATABASE, as `scf-backup dump-restore` did before 2026-11-18 (only to
#                    show what that loses: database owner, ACL and settings)
#
# Refuses, before touching any database, when: the archive's SHA-256 differs from --expect-sha256; SHA256SUMS
# disagrees; age cannot decrypt or authenticate it (age's MAC); the archive holds anything but the expected regular
# files; databases.txt names a database other than scf and umami. After the restore, refuses (exit 1) when the
# row-count/checksum manifest recomputed on the target differs from manifest.tsv in the archive. Prints one
# `IMPORT PASS|FAIL stage=… reason=…` line.
set -uo pipefail
DIR="" EXPECT="" IDENTITY="" MODE="" CREATE=1
while [ $# -gt 0 ]; do
  case $1 in
    --dir) DIR=$2; shift 2 ;;
    --expect-sha256) EXPECT=$2; shift 2 ;;
    --identity) IDENTITY=$2; shift 2 ;;
    --scratch) MODE=scratch; shift ;;
    --into-fresh) MODE=fresh; shift ;;
    --no-create) CREATE=0; shift ;;
    *) echo "IMPORT FAIL stage=usage reason=\"unknown argument $1\""; exit 2 ;;
  esac
done
T0=$(date +%s)
STAGE=args
fail() { echo "IMPORT FAIL stage=$STAGE reason=\"$(printf '%s' "$1" | tr '\n"' "  " | cut -c1-300)\" total=$(($(date +%s) - T0))s"; [ "$MODE" = scratch ] && pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1; exit 1; }
[ -n "$DIR" ] && [ -n "$IDENTITY" ] && [ -n "$MODE" ] || fail "--dir, --identity and --scratch|--into-fresh are required"
[[ $EXPECT =~ ^[0-9a-f]{64}$ ]] || fail "--expect-sha256 must be the 64-hex SHA-256 received out of band"

STAGE=integrity
[ -f "$DIR/dump.tar.age" ] && [ -f "$DIR/SHA256SUMS" ] || fail "dump.tar.age or SHA256SUMS missing"
got=$(sha256sum "$DIR/dump.tar.age" | cut -d' ' -f1)
[ "$got" = "$EXPECT" ] || fail "sha256 $got differs from the out-of-band value $EXPECT"
(cd "$DIR" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1) || fail "SHA256SUMS does not match the archive"

STAGE=decrypt
WORK=$(mktemp -d "${TMPDIR:-/tmp}/scf-import.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
age -d -i "$IDENTITY" -o "$WORK/dump.tar" "$DIR/dump.tar.age" 2>"$WORK/age.err" || fail "age: $(tail -n1 "$WORK/age.err")"
# Only plain files at the top level, with the names `scf-backup dump` writes: no paths, links or devices.
bad=$(tar -tvf "$WORK/dump.tar" | awk '$1 !~ /^[-d]/ {print $NF}' | head -n1)
[ -z "$bad" ] || fail "archive member $bad is not a regular file"
while IFS= read -r m; do
  case $m in ./ | ./globals.sql | ./databases.txt | ./manifest.tsv | ./dbacl.tsv | ./scf.dump | ./umami.dump) ;;
    *) fail "unexpected archive member $m" ;;
  esac
done < <(tar -tf "$WORK/dump.tar")
mkdir "$WORK/d" && tar -C "$WORK/d" --no-same-owner -xf "$WORK/dump.tar" || fail "tar"
dbs=$(cat "$WORK/d/databases.txt")
for db in $dbs; do
  case $db in scf | umami) [ -f "$WORK/d/$db.dump" ] || fail "$db.dump missing" ;; *) fail "unexpected database $db in databases.txt" ;; esac
done

STAGE=target
if [ "$MODE" = scratch ]; then
  : "${PGDATA:?}"
  [ -s "$PGDATA/PG_VERSION" ] && fail "PGDATA is not empty"
  initdb -D "$PGDATA" -U postgres --auth-local=trust --auth-host=reject -E UTF8 --locale=C.UTF-8 >"$WORK/initdb.log" 2>&1 || fail "initdb: $(tail -n1 "$WORK/initdb.log")"
  pg_ctl -D "$PGDATA" -l "$WORK/pg.log" -w -o "-c listen_addresses='' -c unix_socket_directories=/var/run/postgresql" start >/dev/null || fail "start: $(tail -n1 "$WORK/pg.log")"
  export PGHOST=/var/run/postgresql PGUSER=postgres PGPASSWORD=""
fi
q() { psql -X -At -v ON_ERROR_STOP=1 -d "${2:-postgres}" -c "$1"; }
q "select 1" >/dev/null 2>&1 || fail "cannot connect to the target server"
if [ "$(q "select count(*) from pg_database where datname = 'scf'")" != 0 ]; then
  fail "target is not fresh: database scf exists"
fi
if [ "$(q "select count(*) from pg_database where datname = 'umami'")" = 1 ] &&
   [ "$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema')" umami)" != 0 ]; then
  fail "target is not fresh: database umami holds tables"
fi

STAGE=restore
# Roles first: the old operator's role set without passwords (pg_dumpall --no-role-passwords). A role the new
# server already has (postgres, umami_app from its first start) keeps its own password; every other password is set
# afterwards from the new operator's secrets (db-migrate and umami-views set them on every start).
psql -X -q -d postgres -f "$WORK/d/globals.sql" >"$WORK/globals.out" 2>&1 || true
grep -E 'ERROR' "$WORK/globals.out" | grep -vE 'role "[^"]+" already exists|current user cannot be dropped' | head -n3 >"$WORK/globals.err"
[ -s "$WORK/globals.err" ] && fail "globals: $(head -n1 "$WORK/globals.err")"
q "drop database if exists umami with (force)" >/dev/null || fail "drop the fresh umami database"
for db in $dbs; do
  if [ "$CREATE" = 1 ]; then
    # --create restores the database itself with its owner, ACL (e.g. REVOKE CONNECT FROM PUBLIC) and settings.
    pg_restore --create --exit-on-error -d postgres "$WORK/d/$db.dump" 2>"$WORK/restore-$db.err" || fail "pg_restore $db: $(tail -n1 "$WORK/restore-$db.err")"
  else
    q "create database \"$db\"" >/dev/null || fail "create database $db"
    pg_restore --exit-on-error -d "$db" "$WORK/d/$db.dump" 2>"$WORK/restore-$db.err" || fail "pg_restore $db: $(tail -n1 "$WORK/restore-$db.err")"
  fi
done

STAGE=compare
# The manifest of `scf-backup dump` (same SQL as infra/compose/ha/bin/scf-backup `manifest`; manifest.sh).
. "$(dirname "$0")/manifest.sh"
for db in $dbs; do manifest "$db"; done >"$WORK/manifest.after"
if ! diff -q "$WORK/d/manifest.tsv" "$WORK/manifest.after" >/dev/null; then
  n=$(diff "$WORK/d/manifest.tsv" "$WORK/manifest.after" | grep -c '^[<>]' || true)
  first=$(diff "$WORK/d/manifest.tsv" "$WORK/manifest.after" | grep -m1 '^[<>]' | cut -f2)
  fail "manifest differs in $n lines (first: $first)"
fi
[ "$MODE" = scratch ] && [ -n "${SCF_IMPORT_FINGERPRINT:-}" ] && bash "$SCF_IMPORT_FINGERPRINT" $dbs >"${SCF_IMPORT_FINGERPRINT_OUT:-/dev/stdout}"
[ "$MODE" = scratch ] && pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1
echo "IMPORT PASS databases=$(echo $dbs | wc -w) tables=$(wc -l <"$WORK/d/manifest.tsv") sha256=$got total=$(($(date +%s) - T0))s"
