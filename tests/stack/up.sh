#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Starts the tests/ stack: the real infra/compose stack + tests/stack/compose.override.yaml (test needs only),
# project scf-wsl, host ports 56300–56319. Prepares tests/.work/rangelists (the `botnet` subnet as datacenter).
# Images are built from source (`--build`).
#   tests/stack/up.sh            # PROJECT, SCF_TEST_WORK may be overridden
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PROJECT="${PROJECT:-scf-wsl}"
export SCF_WSL_WORK="${SCF_TEST_WORK:-$ROOT/tests/.work}"
dc() { docker compose -p "$PROJECT" -f "$ROOT/infra/compose/compose.yaml" -f "$ROOT/infra/compose/compose.dev.yaml" -f "$HERE/compose.override.yaml" "$@"; }

"$ROOT/infra/compose/scripts/init.sh" >/dev/null
mkdir -p "$SCF_WSL_WORK/rangelists"
echo "10.213.47.0/24" > "$SCF_WSL_WORK/rangelists/datacenter.txt"
chmod 0755 "$SCF_WSL_WORK" "$SCF_WSL_WORK/rangelists"; chmod 0644 "$SCF_WSL_WORK"/rangelists/*
export SCF_INGEST_PORT=56300 SCF_CONTROL_PLANE_PORT=56302 SCF_PORTAL_PORT=56303

t0=$(date +%s)
if ! dc up -d --build --wait --wait-timeout 900; then
  dc ps -a
  dc logs --no-color --tail 60 gateway control-plane jobs portal engine-proxy || true
  exit 1
fi
echo "stack $PROJECT up in $(( $(date +%s) - t0 )) s"
dc ps --format '{{.Service}} {{.Status}}'
