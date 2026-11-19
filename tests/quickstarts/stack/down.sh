#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Removes the quickstart-fixture stack with its volumes (images are kept).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export SCF_INGEST_PORT=56460 SCF_CONTROL_PLANE_PORT=56462 SCF_PORTAL_PORT=56463
docker compose -p "${PROJECT:-scf-tgq}" -f "$ROOT/infra/compose/compose.yaml" -f "$ROOT/infra/compose/compose.dev.yaml" \
  -f "$HERE/compose.override.yaml" \
  down -v --remove-orphans
