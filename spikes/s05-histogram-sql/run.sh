#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-05 — reproduce everything with one command:  ./run.sh
# Uses the S-03 stack (project scf-s03: postgres:18-alpine + PgBouncer 1.26.1 + runner), migrated with the S-03 fixes.
#   1. histogram accuracy (hist_accuracy.py)          → out/accuracy.json, out/accuracy.log
#   2. writer throughput (throughput.py) at the 10× target and unthrottled, with/without composite FKs, CPU sampled
#      from `docker stats` on the host                → out/throughput-*.json, out/cpu-*.log
#   3. partition creation + RLS for a new day, idle and under load (partition_bench.py) → out/partitions-*.json
#   4. read path and on-disk sizes                    → out/readbench.json, out/sizes.json
# DURATION=120 (target phase seconds), MAXDUR=60. KEEP=1 leaves the stack running.
set -uo pipefail
cd "$(dirname "$0")"
S03=../s03-rls-real-postgres
P="docker compose -p scf-s03 -f $S03/compose.yml"
X="$P exec -T runner"
W="$P exec -T -w /repo/spikes/s05-histogram-sql runner"
DURATION=${DURATION:-120}; MAXDUR=${MAXDUR:-60}
mkdir -p out
$P up -d --build --wait pg bouncer runner >/dev/null 2>&1 || { $P up -d --build; sleep 5; }
$X sh /repo/spikes/s03-rls-real-postgres/tools/migrate.sh fixed >/dev/null || { echo migrate failed; exit 1; }
$X sh -c 'cd /repo/spikes/s03-rls-real-postgres/tests && python3 seed.py'

echo "=== 1. accuracy"; $W python3 hist_accuracy.py | tee out/accuracy.log | grep -E '^(---|    (exact|explicit15_with|exp3_with|exp3→|coarse|downscale|merge|mixed))|CHECKS'

cpu() {  # cpu <label> <seconds>: sample the pg and runner containers' CPU% once per ~second
  local end=$(( $(date +%s) + $2 )); : > out/cpu-$1.log
  while [ "$(date +%s)" -lt "$end" ]; do
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' scf-s03-pg-1 scf-s03-runner-1 >> out/cpu-$1.log 2>/dev/null
  done
}
cpusum() { awk -v n="$1" '{gsub("%","",$2); v=$2+0; s[$1]+=v; c[$1]++; if(v>m[$1])m[$1]=v} END{for(k in s) printf "  cpu %s %s: avg %.0f%% max %.0f%% (100%% = 1 core, host has %d cores)\n", n, k, s[k]/c[k], m[k], '"$(nproc)"'}' out/cpu-$1.log; }

echo "=== 2. throughput"
$W python3 throughput.py setup 300 50
# 10× target: 300 tenants × 50 series / 10 s = 1,500 points/s, one txn per tenant per 10 s; partitions created under load
cpu target "$DURATION" & CP=$!
( sleep 30; $W python3 partition_bench.py under_load 5 >/dev/null ) &
$W python3 throughput.py run target target "$DURATION" 8 300 50 10
wait; cpusum target
for w in 8 16; do
  cpu max$w "$MAXDUR" & $W python3 throughput.py run max$w max "$MAXDUR" $w 300 50; wait; cpusum max$w
done
$W python3 throughput.py fk drop
cpu max16_nofk "$MAXDUR" & $W python3 throughput.py run max16_nofk max "$MAXDUR" 16 300 50; wait; cpusum max16_nofk
$W python3 throughput.py fk restore
echo "=== 3. partitions (idle)"; $W python3 partition_bench.py idle 5
echo "=== 4. reads and sizes"; $W python3 throughput.py readbench; $W python3 throughput.py sizes
[ "${KEEP:-0}" = 1 ] || $P down -v >/dev/null 2>&1
