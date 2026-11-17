#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Removes the tests/ stack with its volumes (images are kept).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export SCF_INGEST_PORT=56300 SCF_CONTROL_PLANE_PORT=56302 SCF_PORTAL_PORT=56303
export SCF_WSL_WORK="${SCF_TEST_WORK:-$ROOT/tests/.work}"
docker compose -p "${PROJECT:-scf-wsl}" -f "$ROOT/infra/compose/compose.yaml" -f "$ROOT/infra/compose/compose.dev.yaml" \
  -f "$HERE/compose.override.yaml" \
  down -v --remove-orphans
