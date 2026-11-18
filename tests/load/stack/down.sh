#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Removes the engine-ceiling stack (rvt) with its volumes; images are kept.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export SCF_INGEST_PORT=56540 SCF_GATEWAY_METRICS_PORT=56541 SCF_CONTROL_PLANE_PORT=56542 SCF_PORTAL_PORT=56543
docker compose -p "${PROJECT:-rvt}" -f "$ROOT/infra/compose/compose.yaml" -f "$ROOT/infra/compose/compose.dev.yaml" \
  -f "$HERE/compose.override.yaml" down -v --remove-orphans
