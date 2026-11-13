#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Database migration runner for `scf` (and the scf_ro step for `umami`). POSIX sh + psql (PostgreSQL 18 client).
# Used locally and as the entrypoint of the one-shot image built from db/Dockerfile (Compose service `db-migrate`).
#
#   migrate.sh [migrate]        bootstrap (if SCF_DB_BOOTSTRAP=1), apply pending migrations, ensure partitions,
#                               then run the gates (if SCF_DB_RUN_GATES=1)
#   migrate.sh bootstrap        roles, passwords, database (superuser; idempotent) — db/bootstrap/roles.sql
#   migrate.sh gates            run the gate queries G1–G12 (db/gates); exit 1 if any returns a row
#   migrate.sh status           list applied migrations and pending ones
#   migrate.sh umami-views      create/refresh schema scf_ro and roles in the umami database (db/umami/scf_ro.sql),
#                               then gate G12 there (no superuser/BYPASSRLS-owned definer function or view)
#   migrate.sh umami-gates      gate G12 in the umami database only
#   migrate.sh umami-views-drop drop schema scf_ro before an Umami migration (db/umami/drop_scf_ro.sql)
#
# Environment (every *_PASSWORD may instead be given as *_PASSWORD_FILE, e.g. a Docker secret):
#   PGHOST (localhost) PGPORT (5432)          server — a DIRECT connection, never PgBouncer (session advisory lock)
#   SCF_DB_NAME (scf)                         the platform database
#   SCF_MIGRATOR_USER (scf_migrator)          owner of every object; migrations run as this role
#   SCF_MIGRATOR_PASSWORD
#   SCF_DB_SUPERUSER (postgres)               only for bootstrap / umami-views / umami-views-drop
#   SCF_DB_SUPERUSER_PASSWORD
#   SCF_DB_BOOTSTRAP (0)                      1 = run the bootstrap before migrating
#   SCF_APP_PASSWORD SCF_WRITER_PASSWORD SCF_JOBS_PASSWORD SCF_METRICS_RO_PASSWORD SCF_DUMP_LOGIN_PASSWORD
#   SCF_MONITOR_PASSWORD
#                                             login passwords set by the bootstrap (unset = unchanged)
#   SCF_DB_RUN_GATES (0)                      1 = run the gates after migrating (fails the run on a finding)
#   SCF_DB_WAIT_SECONDS (60)                  how long to wait for the server to accept connections
#   UMAMI_DB_NAME (umami)                     database of the umami-views steps
#   SCF_UMAMI_RO_PASSWORD SCF_UMAMI_MAINT_PASSWORD   passwords set by umami-views (unset = unchanged)
#   SCF_DB_DIR (directory of this script)     where migrations/, bootstrap/, gates/, umami/ live
set -eu

DIR=${SCF_DB_DIR:-$(cd "$(dirname "$0")" && pwd)}
: "${PGHOST:=localhost}" "${PGPORT:=5432}"
export PGHOST PGPORT
DB=${SCF_DB_NAME:-scf}
MIGRATOR=${SCF_MIGRATOR_USER:-scf_migrator}
SUPERUSER=${SCF_DB_SUPERUSER:-postgres}
UMAMI_DB=${UMAMI_DB_NAME:-umami}
LOCK_KEY=7426010411          # pg_advisory_lock key of the migration runner (any constant; documented in db/README.md)
export PGAPPNAME=scf-db-migrate PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10}

log() { printf '%s db-migrate: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# load_secret NAME: if NAME is unset and NAME_FILE names a readable file, export NAME from it.
load_secret() {
  eval "v=\${$1:-}"; eval "f=\${$1_FILE:-}"
  if [ -z "$v" ] && [ -n "$f" ]; then
    [ -r "$f" ] || die "$1_FILE=$f is not readable"
    v=$(cat "$f"); eval "export $1=\$v"
  fi
}
for s in SCF_MIGRATOR_PASSWORD SCF_DB_SUPERUSER_PASSWORD SCF_APP_PASSWORD SCF_WRITER_PASSWORD SCF_JOBS_PASSWORD \
         SCF_METRICS_RO_PASSWORD SCF_DUMP_LOGIN_PASSWORD SCF_MONITOR_PASSWORD SCF_UMAMI_RO_PASSWORD SCF_UMAMI_MAINT_PASSWORD; do
  load_secret "$s"
done

# psql_as USER DB [psql args…]: never reads ~/.psqlrc, stops on the first error.
psql_as() {
  u=$1; d=$2; shift 2
  if [ "$u" = "$SUPERUSER" ]; then pw=${SCF_DB_SUPERUSER_PASSWORD:-}; else pw=${SCF_MIGRATOR_PASSWORD:-}; fi
  PGPASSWORD=$pw psql -X -q -v ON_ERROR_STOP=1 -U "$u" -d "$d" "$@"
}

wait_for_server() {
  n=${SCF_DB_WAIT_SECONDS:-60}
  while ! pg_isready -q -h "$PGHOST" -p "$PGPORT" -t 2; do
    n=$((n - 2)); [ "$n" -gt 0 ] || die "server $PGHOST:$PGPORT not ready"
    sleep 2
  done
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# psql_quote S: S as a single-quoted psql backslash-command argument ('' for a quote, \\ for a backslash).
psql_quote() { printf "'%s'" "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g")"; }

NL='
'
# set_password DB ROLE PASSWORD (C-114): psql's \password lets libpq compute the SCRAM-SHA-256 verifier client-side, so
# only the verifier is sent; the session also switches off pg_stat_statements utility tracking and statement logging.
# setsid detaches psql from any terminal, so \password reads the password (twice) from stdin instead of prompting;
# printf is a shell builtin, so the password never appears in a process's arguments.
set_password() {
  d=$1; role=$2; pw=$3
  case $pw in *"$NL"*) die "the password of $role contains a newline" ;; esac
  err=$(printf '%s\n%s\n' "$pw" "$pw" | PGPASSWORD=${SCF_DB_SUPERUSER_PASSWORD:-} setsid psql -X -q -v ON_ERROR_STOP=1 \
          -U "$SUPERUSER" -d "$d" -c "SET pg_stat_statements.track_utility = off" -c "SET log_statement = 'none'" \
          -c "SET log_min_duration_statement = -1" -c "SET log_min_error_statement = panic" \
          -c "SET password_encryption = 'scram-sha-256'" -c "\\password $role" 2>&1 >/dev/null) \
    || die "setting the password of $role failed: $(printf '%s' "$err" | sed 's/Enter [^:]*: //g')"
}

# set_passwords DB ROLE VAR [ROLE VAR …]: sets each role's password from VAR when VAR is non-empty (unset = unchanged).
set_passwords() {
  d=$1; shift
  while [ $# -ge 2 ]; do
    eval "v=\${$2:-}"
    if [ -n "$v" ]; then set_password "$d" "$1" "$v"; log "password set: $1 (SCRAM verifier computed client-side)"; fi
    shift 2
  done
}

bootstrap() {
  log "bootstrap: roles and database '$DB' as $SUPERUSER"
  psql_as "$SUPERUSER" postgres -v scf_db="$DB" -f "$DIR/bootstrap/roles.sql"
  set_passwords postgres scf_migrator SCF_MIGRATOR_PASSWORD scf_app SCF_APP_PASSWORD scf_writer SCF_WRITER_PASSWORD \
    scf_jobs SCF_JOBS_PASSWORD scf_metrics_ro SCF_METRICS_RO_PASSWORD scf_dump_login SCF_DUMP_LOGIN_PASSWORD \
    scf_monitor SCF_MONITOR_PASSWORD
}

# Ledger and lock live in schema scf_migrations (owned by the migrator, no grants; not scanned by the gates).
LEDGER_DDL="CREATE SCHEMA IF NOT EXISTS scf_migrations;
CREATE TABLE IF NOT EXISTS scf_migrations.applied (
  version    text PRIMARY KEY CHECK (version ~ '^[0-9]{4}_[a-z0-9_]+\$'),
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}\$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user);
REVOKE ALL ON SCHEMA scf_migrations FROM PUBLIC;"

migrate() {
  [ -d "$DIR/migrations" ] || die "no migrations directory in $DIR"
  ls "$DIR/migrations" | grep -Eq '^[0-9]{4}_[a-z0-9_]+\.sql$' || die "no migration files in $DIR/migrations"
  bad=$(ls "$DIR/migrations" | grep -Ev '^[0-9]{4}_[a-z0-9_]+\.sql$' || true)
  [ -z "$bad" ] || die "unexpected file(s) in migrations/: $bad"
  dups=$(ls "$DIR/migrations" | cut -c1-4 | uniq -d)
  [ -z "$dups" ] || die "duplicate migration number(s): $dups"

  # One psql session holds the session advisory lock for the whole run (two runners never interleave), then each
  # pending migration runs in ONE transaction together with its ledger row; the ledger is re-checked under the lock,
  # so a second runner that waited simply finds nothing to do.
  script=$(mktemp); trap 'rm -f "$script"' EXIT
  {
    echo "SET statement_timeout = 0; SET lock_timeout = '60s'; SET client_min_messages = warning;"
    echo "SELECT pg_advisory_lock($LOCK_KEY) AS locked \\gset"
    echo "$LEDGER_DDL"
    for f in $(ls "$DIR/migrations" | sort); do
      v=${f%.sql}; h=$(sha256_of "$DIR/migrations/$f")
      cat <<EOF
SELECT COALESCE(max(sha256), '') AS have FROM scf_migrations.applied WHERE version = '$v' \\gset
SELECT :'have' = '' AS todo, :'have' = '$h' AS same \\gset
\\if :todo
\\echo 'applying $v'
BEGIN;
\\i $(psql_quote "$DIR/migrations/$f")
INSERT INTO scf_migrations.applied (version, sha256) VALUES ('$v', '$h');
COMMIT;
\\elif :same
\\else
\\echo 'migration $v was changed after it was applied (ledger sha256 differs); write a new migration instead'
\\q
\\endif
EOF
    done
    echo "SELECT scf.ensure_partitions() AS partitions_created \\gset"
    echo "\\echo 'partitions created:' :partitions_created"
    echo "SELECT pg_advisory_unlock($LOCK_KEY) AS unlocked \\gset"
  } >"$script"
  log "migrate: database '$DB' as $MIGRATOR"
  psql_as "$MIGRATOR" "$DB" -f "$script" 2>&1 | while IFS= read -r line; do log "$line"; done
  # psql's exit code is lost in the pipe: verify the ledger instead.
  check_complete
}

# Fails unless every migration file is in the ledger with its current checksum.
check_complete() {
  want=$(for f in $(ls "$DIR/migrations" | sort); do printf '%s %s\n' "${f%.sql}" "$(sha256_of "$DIR/migrations/$f")"; done)
  have=$(psql_as "$MIGRATOR" "$DB" -At -F' ' -c "SELECT version, sha256 FROM scf_migrations.applied ORDER BY version" 2>/dev/null) \
    || die "cannot read the ledger"
  missing=$(printf '%s\n' "$want" | while read -r v h; do
    printf '%s\n' "$have" | grep -qx "$v $h" || printf '%s ' "$v"
  done)
  [ -z "$missing" ] || die "not applied or changed after applying: $missing"
  log "migrate: $(printf '%s\n' "$want" | wc -l | tr -d ' ') migrations applied, ledger matches"
}

status() {
  psql_as "$MIGRATOR" "$DB" -c "SELECT version, applied_at, applied_by, left(sha256, 12) AS sha256 FROM scf_migrations.applied ORDER BY version" \
    || die "ledger not readable (database not migrated yet?)"
  for f in $(ls "$DIR/migrations" | sort); do
    v=${f%.sql}
    n=$(psql_as "$MIGRATOR" "$DB" -At -c "SELECT count(*) FROM scf_migrations.applied WHERE version = '$v'")
    [ "$n" = 1 ] || echo "pending: $v"
  done
}

# An allow-list file as a PostgreSQL text[] literal (one entry per line; # comments allowed).
allowlist_literal() {
  grep -v '^[[:space:]]*#' "$1" | grep -v '^[[:space:]]*$' \
    | sed 's/"/\\"/g; s/^/"/; s/$/"/' | paste -sd, - | sed 's/^/{/; s/$/}/'
}

gates() {
  log "gates: database '$DB'"
  al=$(allowlist_literal "$DIR/definer-allowlist.txt")
  rl=$(allowlist_literal "$DIR/rls-allowlist.txt")
  fail=0
  for g in $(ls "$DIR/gates" | grep -E '^g[0-9]+_.*\.sql$' | sort); do
    out=$(psql_as "$MIGRATOR" "$DB" -At -v definer_allowlist="$al" -v rls_allowlist="$rl" -f "$DIR/gates/$g") || { log "$g: ERROR"; fail=1; continue; }
    if [ -n "$out" ]; then log "$g: FAIL"; printf '%s\n' "$out" | sed 's/^/    /' >&2; fail=1; else log "$g: ok"; fi
  done
  # G8 runtime half only where pg_stat_statements is installed and readable (nightly on staging/production).
  if [ "$(psql_as "$MIGRATOR" "$DB" -At -c "SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'")" = 1 ]; then
    out=$(psql_as "$MIGRATOR" "$DB" -At -f "$DIR/gates/g08r_runtime_set_config.sql") || { log "g08r: ERROR"; fail=1; }
    if [ -n "${out:-}" ]; then log "g08r_runtime_set_config.sql: FAIL"; printf '%s\n' "$out" | sed 's/^/    /' >&2; fail=1
    else log "g08r_runtime_set_config.sql: ok"; fi
  fi
  [ "$fail" = 0 ] || die "gate findings"
}

umami_views() {
  log "umami-views: database '$UMAMI_DB' as $SUPERUSER"
  psql_as "$SUPERUSER" "$UMAMI_DB" -f "$DIR/umami/scf_ro.sql"
  set_passwords "$UMAMI_DB" scf_umami_ro SCF_UMAMI_RO_PASSWORD scf_umami_maint SCF_UMAMI_MAINT_PASSWORD
  umami_gates
}

# G12 in the umami database: the scf_ro views (owner-semantics, C-109) and any definer function there are owned by
# neither a superuser nor a BYPASSRLS role.
umami_gates() {
  out=$(psql_as "$SUPERUSER" "$UMAMI_DB" -At -f "$DIR/gates/g12_definer_owners.sql") || die "umami G12: ERROR"
  if [ -n "$out" ]; then
    log "g12_definer_owners.sql (database '$UMAMI_DB'): FAIL"; printf '%s\n' "$out" | sed 's/^/    /' >&2
    die "gate findings in database '$UMAMI_DB'"
  fi
  log "g12_definer_owners.sql (database '$UMAMI_DB'): ok"
}

umami_views_drop() {
  log "umami-views-drop: database '$UMAMI_DB' as $SUPERUSER"
  psql_as "$SUPERUSER" "$UMAMI_DB" -f "$DIR/umami/drop_scf_ro.sql"
}

cmd=${1:-migrate}
wait_for_server
case $cmd in
  migrate)
    if [ "${SCF_DB_BOOTSTRAP:-0}" = 1 ]; then bootstrap; fi
    migrate
    if [ "${SCF_DB_RUN_GATES:-0}" = 1 ]; then gates; fi
    ;;
  bootstrap) bootstrap ;;
  gates) gates ;;
  status) status ;;
  umami-views) umami_views ;;
  umami-gates) umami_gates ;;
  umami-views-drop) umami_views_drop ;;
  *) die "unknown command '$cmd' (migrate | bootstrap | gates | status | umami-views | umami-gates | umami-views-drop)" ;;
esac
log "$cmd: done"
