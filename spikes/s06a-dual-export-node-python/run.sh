#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# S-06a — reproduce every dual-export scenario and write out/summary.md.
# Usage: ./run.sh            (needs docker compose v5, mise toolchain in the repo root, python3.13)
# Host ports used: 18510/18511 (UsageMap stand-in), 18520/18521 (APM stand-in), 18530/18531 (tenant Collector),
#                  18540-18543 (sample apps). Containers are removed at the end; images are kept.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
REPO=$(cd ../.. && pwd)
eval "$(cd "$REPO" && mise env -s bash)"

export COMPOSE_PROJECT_NAME=scf-s06a HOST_UID=$(id -u) HOST_GID=$(id -g)
export SCF_OTLP_TOKEN=scfa_ing_s06a_fake_token APM_API_KEY=apm-fake-key   # throwaway test values
export NEXT_TELEMETRY_DISABLED=1
LOGS=$HERE/out/logs
SCF=http://127.0.0.1:18510 APM=http://127.0.0.1:18520 TENANT=http://127.0.0.1:18530
# The hazard under test: a vendor header left in the OTLP env (as many APM setups do).
VENDOR_ENV=(OTEL_EXPORTER_OTLP_HEADERS=x-vendor-key=SECRET)

log() { printf '\n== %s\n' "$*"; }

# ---------- build ----------
log "install / build sample apps"
for d in express nextjs node-semconv-0.220.0 node-semconv-0.221.0; do
  (cd "apps/$d" && pnpm install --frozen-lockfile >/dev/null)
done
(cd apps/nextjs && pnpm build >/dev/null)
if [ ! -x apps/fastapi/.venv/bin/pip ]; then
  rm -rf apps/fastapi/.venv
  if ! python3.13 -m venv apps/fastapi/.venv 2>/dev/null; then
    # Debian without python3-venv: create without pip and bootstrap pip from its wheel.
    python3.13 -m venv --without-pip apps/fastapi/.venv
    W=${TMPDIR:-/tmp}/s06a-pip; mkdir -p "$W"
    curl -sSL -o "$W/pip-26.3-py3-none-any.whl" \
      "$(curl -s https://pypi.org/pypi/pip/26.3/json | python3 -c 'import json,sys;print([u["url"] for u in json.load(sys.stdin)["urls"] if u["filename"].endswith(".whl")][0])')"
    apps/fastapi/.venv/bin/python "$W/pip-26.3-py3-none-any.whl/pip" install -q "$W/pip-26.3-py3-none-any.whl"
  fi
fi
apps/fastapi/.venv/bin/pip install -q -r apps/fastapi/requirements.txt

# ---------- collectors ----------
log "start collectors"
docker compose -p scf-s06a down -v >/dev/null 2>&1 || true
rm -rf "$HERE/out" && mkdir -p "$HERE/out/scf" "$HERE/out/apm" "$LOGS"
docker compose -p scf-s06a up -d >/dev/null
for p in 18510 18520 18530; do
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$p/" && break; sleep 0.5; done
done
sleep 1
curl -s -o /dev/null -w 'SCF stand-in without token -> HTTP %{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' $SCF/v1/metrics

# run_app NAME PORT DIR -- ENV... -- CMD...
run_app() {
  local name=$1 port=$2 dir=$3; shift 3; [ "$1" = -- ] && shift
  local envs=(); while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  log "scenario $name"
  if ss -ltnH "sport = :$port" | grep -q .; then echo "port $port is still busy" >&2; exit 1; fi
  (cd "$dir" && exec env OTEL_SERVICE_NAME="$name" PORT="$port" "${envs[@]}" "$@") >"$LOGS/$name.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$port/health" && break; sleep 0.5; done
  python3 tools/load.py "http://127.0.0.1:$port" | tee -a "$LOGS/load.jsonl"
  sleep 1
  kill -TERM "$pid"; wait "$pid" || true
}

# 1. Node.js + Express, in-SDK dual export (recipe B.1, corrected)
run_app s06a-express-sdk 18540 apps/express -- "${VENDOR_ENV[@]}" APM_OTLP_URL=$APM SCF_OTLP_URL=$SCF \
  OTEL_SEMCONV_STABILITY_OPT_IN=http/dup OTEL_METRIC_EXPORT_INTERVAL=5000 OTEL_LOGS_EXPORTER=none \
  -- node --import ./otel.mjs app.mjs
# 1b. same, without the ESM loader hook (what the recipe as written does for an ESM app)
run_app s06a-express-sdk-nohook 18540 apps/express -- "${VENDOR_ENV[@]}" APM_OTLP_URL=$APM SCF_OTLP_URL=$SCF \
  S06A_NO_ESM_HOOK=1 OTEL_METRIC_EXPORT_INTERVAL=5000 OTEL_LOGS_EXPORTER=none \
  -- node --import ./otel.mjs app.mjs
# 1d. vendor credential in the *Authorization* header via env (e.g. Basic auth): does it replace our bearer?
run_app s06a-express-sdk-envauth 18540 apps/express -- "OTEL_EXPORTER_OTLP_HEADERS=authorization=Basic%20dmVuZG9yOmtleQ==" \
  APM_OTLP_URL=$APM SCF_OTLP_URL=$SCF OTEL_METRIC_EXPORT_INTERVAL=5000 OTEL_LOGS_EXPORTER=none \
  -- node --import ./otel.mjs app.mjs
# 1c. semconv boundary: instrumentation-http 0.220.0 vs 0.221.0 (single env-configured exporter -> APM stand-in)
for v in 0.220.0 0.221.0; do
  run_app "s06a-node-$v" 18543 "apps/node-semconv-$v" -- OTEL_EXPORTER_OTLP_ENDPOINT=$APM \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_METRIC_EXPORT_INTERVAL=5000 OTEL_LOGS_EXPORTER=none \
    -- node --import ./otel.mjs app.mjs
done

# 2. Next.js + @vercel/otel: 'auto' -> APM via env, UsageMap processor in code (SERVER spans only)
# (node_modules/.bin/next is a shell shim that does not forward SIGTERM; start node directly.)
NEXT_ENV=("${VENDOR_ENV[@]}" OTEL_EXPORTER_OTLP_ENDPOINT=$APM SCF_OTLP_URL=$SCF NEXT_MANUAL_SIG_HANDLE=true)
run_app s06a-next-sdk 18541 apps/nextjs -- "${NEXT_ENV[@]}" -- node node_modules/next/dist/bin/next start -p 18541 -H 127.0.0.1
# 2b. recipe as written (no SERVER-only wrapper): every span goes to UsageMap
run_app s06a-next-sdk-allspans 18541 apps/nextjs -- "${NEXT_ENV[@]}" S06A_NEXT_ALL_SPANS=1 \
  -- node node_modules/next/dist/bin/next start -p 18541 -H 127.0.0.1

# 3. Python + FastAPI, in-SDK dual export (recipe B.2, corrected)
PY_ENV=("${VENDOR_ENV[@]}" APM_OTLP_URL=$APM SCF_OTLP_URL=$SCF OTEL_METRIC_EXPORT_INTERVAL=5000)
run_app s06a-fastapi-default 18542 apps/fastapi -- "${PY_ENV[@]}" -- .venv/bin/python main.py
run_app s06a-fastapi-stable 18542 apps/fastapi -- "${PY_ENV[@]}" OTEL_SEMCONV_STABILITY_OPT_IN=http \
  -- .venv/bin/python main.py
# 3c. vendor credential in the Authorization header via env (Python)
run_app s06a-fastapi-envauth 18542 apps/fastapi -- "OTEL_EXPORTER_OTLP_HEADERS=authorization=Basic%20dmVuZG9yOmtleQ==" \
  APM_OTLP_URL=$APM SCF_OTLP_URL=$SCF OTEL_METRIC_EXPORT_INTERVAL=5000 OTEL_SEMCONV_STABILITY_OPT_IN=http \
  -- .venv/bin/python main.py
# 3b. recipe's filter as written (stable name only) with the default (old) conventions
run_app s06a-fastapi-default-recipefilter 18542 apps/fastapi -- "${PY_ENV[@]}" \
  SCF_METRIC_NAMES=http.server.request.duration -- .venv/bin/python main.py

# 4. Tenant-side Collector fan-out (recipe A): zero-code SDKs -> tenant Collector -> APM + UsageMap
TEN_ENV=("${VENDOR_ENV[@]}" OTEL_EXPORTER_OTLP_ENDPOINT=$TENANT OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
         OTEL_METRIC_EXPORT_INTERVAL=5000)
run_app s06a-express-tenant 18540 apps/express -- "${TEN_ENV[@]}" OTEL_LOGS_EXPORTER=none \
  -- node --experimental-loader=@opentelemetry/instrumentation/hook.mjs \
     --import @opentelemetry/auto-instrumentations-node/register app.mjs
run_app s06a-fastapi-tenant 18542 apps/fastapi -- "${TEN_ENV[@]}" OTEL_LOGS_EXPORTER=none \
  -- .venv/bin/opentelemetry-instrument .venv/bin/uvicorn app:app --host 127.0.0.1 --port 18542 --log-level warning
run_app s06a-next-tenant 18541 apps/nextjs -- "${TEN_ENV[@]}" S06A_NEXT_NO_SCF=1 NEXT_MANUAL_SIG_HANDLE=true \
  -- node node_modules/next/dist/bin/next start -p 18541 -H 127.0.0.1

sleep 5   # tenant Collector batch + queue drain
docker compose -p scf-s06a logs --no-color > "$LOGS/collectors.log" 2>&1
python3 tools/analyze.py out > out/summary.md
log "summary written to out/summary.md"
grep -E '^### ' out/summary.md

# ---------- cleanup ----------
docker compose -p scf-s06a down -v >/dev/null 2>&1
