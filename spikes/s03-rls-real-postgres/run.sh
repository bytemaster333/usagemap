#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-03 — reproduce everything with one command:  ./run.sh   (from any directory)
# Starts postgres:18-alpine + PgBouncer 1.26.1 + a runner (project scf-s03, host ports 18301/18302 on loopback),
# then twice (A: docs/data-model.md verbatim, B: with the minimal fixes of tools/fixes.py):
#   migrate from zero as scf_migrator → research tests T0–T21 (+COPY, X1, X2) → seed A/B/C → CI gates G1–G10
#   → cross-tenant matrix → op_* functions.  Results: out/<verbatim|fixed>/*.json and *.log.
# KEEP=1 ./run.sh leaves the stack running (S-05's run.sh uses the same stack).
set -uo pipefail
cd "$(dirname "$0")"
P="docker compose -p scf-s03"
X="$P exec -T runner"
$P up -d --build --wait pg bouncer runner >/dev/null 2>&1 || { $P up -d --build; sleep 5; }
$X psql -h pg -U postgres -Atc 'select version()' | tee out/server-version.txt
$P exec -T bouncer pgbouncer --version | head -1 | tee -a out/server-version.txt
rc=0
for mode in verbatim fixed; do
  echo "=================== mode: $mode"
  mkdir -p out/$mode
  $X sh /repo/spikes/s03-rls-real-postgres/tools/migrate.sh $mode | tee out/$mode/migrate-summary.txt; cp out/migrate-$mode.log out/$mode/
  for t in t_research seed t_gates t_matrix t_ops; do
    echo "--- $t"
    $X sh -c "cd /repo/spikes/s03-rls-real-postgres/tests && python3 $t.py" >out/$mode/$t.log 2>&1 || rc=1
    grep -E '^(== |seeded)' out/$mode/$t.log; grep -E '^\[FAIL\]' out/$mode/$t.log | cut -c1-160
  done
  mv out/t-*.json out/$mode/ 2>/dev/null
done
[ "${KEEP:-0}" = 1 ] || $P down -v >/dev/null 2>&1
echo "done (verbatim mode is expected to FAIL M13.*; fixed mode should pass everything)"
exit 0
