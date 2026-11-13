#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-11 — Umami 3.5.0 on PostgreSQL 18: dashboard latency and ingest at the design web load.
# Usage: ./run.sh            # everything: up, seed, load 90 days, benchmarks, sizes, teardown
#        ./run.sh <phase>... # phases: up setup load_drop load_slices measure_mode sizes warm conc cold cover rollup ingest down
# Env: DAYS (default 90), JOBS (parallel generator sessions, default 8), KEEP=1 (skip teardown in "all").
set -euo pipefail
cd "$(dirname "$0")"
DIR=$PWD
ST=$DIR/.state
RES=$DIR/results
mkdir -p "$ST" "$RES"
DAYS=${DAYS:-90}
JOBS=${JOBS:-8}
P=scf-s11
API=http://127.0.0.1:18700

# toolchain (node 24) from the repo's mise config
eval "$(cd "$DIR/../.." && mise env -s bash)"

if [[ ! -f $ST/secrets ]]; then
  { echo "PG_PASSWORD=$(openssl rand -hex 16)"; echo "APP_SECRET=$(openssl rand -hex 32)"; } >"$ST/secrets"
  chmod 600 "$ST/secrets"
fi
set -a; . "$ST/secrets"; set +a

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$RES/run.log" >&2; }
psqlc() { docker compose -p $P exec -T db psql -U umami -d umami -X -v ON_ERROR_STOP=1 "$@"; }
wait_umami() { for _ in $(seq 120); do curl -sf $API/api/heartbeat >/dev/null && return 0; sleep 1; done; return 1; }

# compose up with a given DB resource profile: $1=cpus $2=mem $3=debug_io_direct
compose_up() {
  PG_CPUS=$1 PG_MEM=$2 PG_IO_DIRECT=${3:-} docker compose -p $P up -d --wait db >/dev/null
  PG_CPUS=$1 PG_MEM=$2 PG_IO_DIRECT=${3:-} docker compose -p $P up -d umami >/dev/null
  wait_umami
}

token() {
  curl -sf -XPOST $API/api/auth/login -H 'content-type: application/json' \
    -d '{"username":"admin","password":"umami"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'
}

phase_up() {
  log "up: load profile (8 vCPU, 24 GB) for seeding"
  compose_up 8 24g
  docker compose -p $P exec -T db postgres --version | tee -a "$RES/run.log"
}

phase_setup() {
  local tok; tok=$(token)
  log "setup: creating 300 websites through the API"
  : >"$ST/sites.csv"
  python3 "$DIR/bench/sites.py" | while IFS=, read -r idx pv npaths; do
    dom=$(printf 'site-%03d.example' "$idx")
    id=$(curl -sf -XPOST $API/api/websites -H "authorization: Bearer $tok" -H 'content-type: application/json' \
      -d "{\"name\":\"site-$idx\",\"domain\":\"$dom\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
    echo "$id,$idx,$pv,$dom,$npaths" >>"$ST/sites.csv"
  done
  psqlc -q -c "create schema if not exists s11" \
    -c "create table s11.sites(website_id uuid primary key, idx int, pv_day int, domain text, npaths int)"
  psqlc -q -c "\copy s11.sites from stdin with csv" <"$ST/sites.csv"
  # t0 = end of the synthetic window (hour-aligned); all benchmark ranges end at t0
  psqlc -At -c "select date_trunc('hour', now())" >"$ST/t0"
  psqlc -c "select count(*) sites, sum(pv_day) pv_per_day, max(pv_day) largest, min(pv_day) smallest from s11.sites" | tee -a "$RES/run.log"
}

phase_load_slices() {
  local t0; t0=$(cat "$ST/t0")
  docker compose -p $P cp "$DIR/sql/gen_slice.sql" db:/tmp/gen_slice.sql
  local s=$SECONDS
  seq 0 $((DAYS - 1)) | xargs -P "$JOBS" -I{} docker compose -p $P exec -T db \
    psql -U umami -d umami -X -q -v k={} -v t0="$t0" -f /tmp/gen_slice.sql
  log "load: $DAYS slices generated in $((SECONDS - s)) s"
  s=$SECONDS
  log "load: rebuilding primary keys and the 25 Umami indexes (3 at a time)"
  psqlc -q -c "alter table website_event add constraint website_event_pkey primary key (event_id)" &
  psqlc -q -c "alter table session add constraint session_pkey primary key (session_id)" &
  wait
  xargs -P 3 -d '\n' -I{} docker compose -p $P exec -T db psql -U umami -d umami -X -q -c "{}" <"$ST/indexes.sql"
  log "load: indexes built in $((SECONDS - s)) s"
  s=$SECONDS
  psqlc -q -c "vacuum (analyze) website_event" -c "vacuum (analyze) session" -c "checkpoint"
  log "load: vacuum analyze in $((SECONDS - s)) s"
  psqlc -c "select count(*) events, count(*) filter (where event_type=1) pageviews, round(100.0*count(*) filter (where tag='s')/count(*),1) pct_tag_s, min(created_at), max(created_at) from website_event" | tee -a "$RES/run.log"
  psqlc -c "select count(*) sessions, count(distinct website_id) sites from session" | tee -a "$RES/run.log"
}

phase_measure_mode() {
  log "measure_mode: restarting with the measurement profile (4 vCPU, 16 GB, shared_buffers 4 GB)"
  docker compose -p $P stop umami db >/dev/null
  compose_up 4 16g ""
}

bench_sites() {
  # large = site 1 (largest), medium = site 10, small = site 150 (median of the tail)
  awk -F, '$2==1{l=$1} $2==10{m=$1} $2==150{s=$1} END{printf "large=%s,medium=%s,small=%s", l, m, s}' "$ST/sites.csv"
}

site_arg() { bench_sites | tr , '\n' | grep "^$1="; }

phase_warm() {
  log "warm: c=1, warm cache, 10 reps (3 if the warm-up pass > 20 s, 1 if > 60 s)"
  node "$DIR/bench/latency.mjs" --mode warm --sites "$(bench_sites)" --ranges 24h,7d,14d,30d,90d --t0 "$(date -d "$(cat "$ST/t0")" +%s)000" \
    --out "$RES/latency.csv" 2>&1 | tee -a "$RES/run.log"
}

phase_conc() {
  log "conc: 10 concurrent dashboard loads per combination (combinations that already fail at c=1 are skipped)"
  local t0ms; t0ms="$(date -d "$(cat "$ST/t0")" +%s)000"
  for spec in ${CONC_SPEC:-large:24h medium:24h,7d,14d small:24h,7d,30d,90d}; do
    node "$DIR/bench/latency.mjs" --mode conc --conc 10 --sites "$(site_arg "${spec%%:*}")" --ranges "${spec#*:}" \
      --t0 "$t0ms" --out "$RES/latency.csv" 2>&1 | tee -a "$RES/run.log"
  done
}

phase_cold() {
  log "cold: PostgreSQL restarted with debug_io_direct=data (no OS page cache) before every dashboard load"
  for spec in ${COLD_SPEC:-large:24h,7d medium:24h,7d,14d small:24h,7d,30d,90d}; do
    local site; site=$(site_arg "${spec%%:*}")
    local ranges=${spec#*:}
    for range in ${ranges//,/ }; do
      for filter in none tag; do
        docker compose -p $P stop umami db >/dev/null
        compose_up 4 16g data
        node "$DIR/bench/latency.mjs" --mode cold --sites "$site" --ranges $range --filters $filter \
          --t0 "$(date -d "$(cat "$ST/t0")" +%s)000" --out "$RES/latency.csv" 2>&1 | tee -a "$RES/run.log"
      done
    done
  done
  docker compose -p $P stop umami db >/dev/null
  compose_up 4 16g ""
}

phase_rollup() {
  log "rollup: building a daily aggregate table and timing the 90-day read from it"
  psqlc -f - <"$DIR/sql/rollup.sql" 2>&1 | tee "$RES/rollup.txt"
}

phase_cover() {
  log "cover: side experiment with one covering index on website_event (dropped afterwards)"
  psqlc -v t0="$(cat "$ST/t0")" -f - <"$DIR/sql/covering_index.sql" 2>&1 | tee "$RES/covering-index.txt"
}

phase_ingest() {
  awk -F, '{print $1","$3","$4}' "$ST/sites.csv" >"$ST/ingest-sites.csv"
  log "ingest: closed-loop concurrency sweep, 120 s each"
  for c in 1 5 10 25 50; do
    node "$DIR/bench/ingest.mjs" --sites "$ST/ingest-sites.csv" --secs 120 --conc $c --label "conc$c" | tee -a "$RES/ingest.jsonl"
  done
  log "ingest: open-loop at design average (12/s) and 10x burst (120/s), 120 s each"
  for r in 12 120; do
    node "$DIR/bench/ingest.mjs" --sites "$ST/ingest-sites.csv" --secs 120 --rate $r --label "rate$r" | tee -a "$RES/ingest.jsonl"
  done
}

phase_sizes() {
  psqlc -f - <"$DIR/sql/sizes.sql" 2>&1 | tee "$RES/sizes.txt"
}

phase_down() {
  log "down: removing containers and volumes of project $P (images kept)"
  docker compose -p $P down -v
}

phase_all() {
  phase_up; phase_setup; phase_load_drop; phase_load_slices; phase_measure_mode
  psqlc -q -c "create extension if not exists pg_stat_statements"
  phase_sizes; phase_warm; phase_conc; phase_cold; phase_cover; phase_rollup; phase_ingest
  [[ ${KEEP:-0} == 1 ]] || phase_down
  python3 "$DIR/bench/summarize.py" "$RES/latency.csv" >"$RES/latency-summary.md"
}

phase_load_drop() {
  log "load: saving and dropping secondary indexes and primary keys of website_event and session"
  psqlc -At -c "select indexdef || ';' from pg_indexes where schemaname='public' and tablename in ('website_event','session') and indexname not like '%_pkey' order by 1" >"$ST/indexes.sql"
  psqlc -At -c "select format('drop index %I;', indexname) from pg_indexes where schemaname='public' and tablename in ('website_event','session') and indexname not like '%_pkey'" \
    | psqlc -q
  psqlc -q -c "alter table website_event drop constraint website_event_pkey" -c "alter table session drop constraint session_pkey"
}

[[ $# -eq 0 ]] && set -- all
for ph in "$@"; do "phase_$ph"; done
