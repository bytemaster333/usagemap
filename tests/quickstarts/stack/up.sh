#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Starts the quickstart-fixture stack (docs.quickstarts-run): the real infra/compose stack + tests/quickstarts/stack/compose.override.yaml,
# project scf-tgq, host ports 56460–56469. Images are built from source (`--build`). Prints the environment the
# suite needs (eval-able):   eval "$(tests/quickstarts/stack/up.sh | grep '^export ')"
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PROJECT="${PROJECT:-scf-tgq}"
export SCF_INGEST_PORT=56460 SCF_CONTROL_PLANE_PORT=56462 SCF_PORTAL_PORT=56463
dc() { docker compose -p "$PROJECT" -f "$ROOT/infra/compose/compose.yaml" -f "$ROOT/infra/compose/compose.dev.yaml" -f "$HERE/compose.override.yaml" "$@"; }

"$ROOT/infra/compose/scripts/init.sh" >/dev/null
t0=$(date +%s)
if ! dc up -d --build --wait --wait-timeout 900; then
  dc ps -a
  dc logs --no-color --tail 60 gateway control-plane jobs collector metrics-writer || true
  exit 1
fi
echo "stack $PROJECT up in $(( $(date +%s) - t0 )) s"
dc ps --format '{{.Service}} {{.Status}}'
cat <<ENV
export SCF_TEST_PROJECT=$PROJECT
export SCF_TEST_COMPOSE_FILES=$ROOT/infra/compose/compose.yaml,$ROOT/infra/compose/compose.dev.yaml,$HERE/compose.override.yaml
export SCF_GATEWAY_URL=https://127.0.0.1:56460
export SCF_OTLP_URL=https://127.0.0.1:56460
export SCF_GATEWAY_METRICS_URL=http://127.0.0.1:56461
export SCF_CONTROL_PLANE_URL=http://127.0.0.1:56462
export SCF_PORTAL_URL=http://localhost:56463
export SCF_INGEST_PORT=56460 SCF_CONTROL_PLANE_PORT=56462 SCF_PORTAL_PORT=56463
ENV
