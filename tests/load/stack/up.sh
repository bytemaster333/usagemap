#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Starts the engine-ceiling stack (project rvt, host ports 56540–56549; compose.override.yaml) from the images
# already built (`--no-build`; build them first with `make build-images` or tests/stack/up.sh when they are missing),
# then prints the environment the suites read (tests/lib/env.ts). Wrap it in the machine's Docker slot script when
# other Docker work runs on the host.
#   tests/load/stack/up.sh [--build]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PROJECT="${PROJECT:-rvt}"
export SCF_INGEST_PORT=56540 SCF_GATEWAY_METRICS_PORT=56541 SCF_CONTROL_PLANE_PORT=56542 SCF_PORTAL_PORT=56543
dc() { docker compose -p "$PROJECT" -f "$ROOT/infra/compose/compose.yaml" -f "$ROOT/infra/compose/compose.dev.yaml" -f "$HERE/compose.override.yaml" "$@"; }
"$ROOT/infra/compose/scripts/init.sh" >/dev/null
build="--no-build"; [ "${1:-}" = "--build" ] && build="--build"
t0=$(date +%s)
if ! dc up -d "$build" --wait --wait-timeout 900; then
  dc ps -a
  dc logs --no-color --tail 60 gateway control-plane jobs engine-proxy || true
  exit 1
fi
echo "stack $PROJECT up in $(( $(date +%s) - t0 )) s"
"$HERE/env.sh"
