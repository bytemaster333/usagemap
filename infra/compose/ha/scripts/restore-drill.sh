#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Weekly restore drill of the Compose HA stack (ADR-0021, C-56, C-108; runbook ops/runbooks/restore-drill.md).
# Starts the scratch service `pg-drill` (repository 2 only, read+list SAS only), which restores, checks and prints one
# RESTORE-DRILL PASS|FAIL line (infra/compose/ha/bin/scf-restore-drill), then destroys the scratch instance and its
# volume whatever the result. Exit 0 on PASS, 1 on FAIL, 2 on usage errors.
#
#   restore-drill.sh [-p PROJECT] [--target 'YYYY-MM-DD HH:MM:SS+00'] [--expect FILE] [--report-dir DIR]
#
#   -p PROJECT      Compose project of the running HA stack (default: scf-ha)
#   --target        point in time to restore to (default: the end of the archive)
#   --expect FILE   expectations "<db>\t<sql returning one value>\t<expected>" (e.g. the nightly checksum manifest)
#   --report-dir    also write the JSON report there (only pass/fail, timings and checksums — never rows, C-56)
#   --db-dir DIR    the db/ tree whose migrate.sh and gates run on the restored copy (default: the repository's db/)
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)" # infra/compose
PROJECT=scf-ha TARGET="" EXPECT="" REPORT=""
while [ $# -gt 0 ]; do
  case $1 in
    -p) PROJECT=$2; shift 2 ;;
    --target) TARGET=$2; shift 2 ;;
    --expect) EXPECT=$(realpath "$2"); shift 2 ;;
    --report-dir) REPORT=$(realpath -m "$2"); shift 2 ;;
    --db-dir) export SCF_DRILL_DB_SRC; SCF_DRILL_DB_SRC=$(realpath "$2"); shift 2 ;;
    *) echo "usage: $0 [-p PROJECT] [--target TIME] [--expect FILE] [--report-dir DIR] [--db-dir DIR]" >&2; exit 2 ;;
  esac
done
DC=(docker compose -p "$PROJECT" -f "$HERE/compose.yaml" -f "$HERE/compose.dev.yaml" -f "$HERE/compose.ha.yaml" --profile drill)

cleanup() {
  "${DC[@]}" rm -sf pg-drill >/dev/null 2>&1
  docker volume rm -f "${PROJECT}_drill" >/dev/null 2>&1
}
cleanup

run=(run --rm --no-deps -T)
args=()
[ -n "$TARGET" ] && args+=(--target "$TARGET")
if [ -n "$EXPECT" ]; then
  run+=(-v "$EXPECT:/drill/expect.tsv:ro"); args+=(--expect /drill/expect.tsv)
fi
if [ -n "$REPORT" ]; then
  mkdir -p "$REPORT"
  stage=$(mktemp -d); chmod 0777 "$stage" # the container user (uid 999) writes the report here
  run+=(-v "$stage:/drill/report" -e SCF_DRILL_REPORT_DIR=/drill/report)
fi

out=$("${DC[@]}" "${run[@]}" pg-drill "${args[@]}" 2>/dev/null)
rc=$?
line=$(printf '%s\n' "$out" | grep -E '^RESTORE-DRILL (PASS|FAIL)' | tail -n1)
[ -n "$line" ] || line="RESTORE-DRILL FAIL repo=2 stage=start reason=\"no result line (exit $rc)\""
echo "$line"
if [ -n "$REPORT" ]; then cp "$stage"/*.json "$REPORT"/ 2>/dev/null; rm -rf "$stage"; fi
cleanup
case $line in "RESTORE-DRILL PASS"*) exit 0 ;; *) exit 1 ;; esac
