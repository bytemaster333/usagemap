#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Prints the environment of the engine-ceiling stack (rvt) for tests/lib/env.ts: `eval "$(tests/load/stack/env.sh)"`.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cat <<ENV
export SCF_TEST_PROJECT=${PROJECT:-rvt}
export SCF_TEST_COMPOSE_FILES=$ROOT/infra/compose/compose.yaml,$ROOT/infra/compose/compose.dev.yaml,$HERE/compose.override.yaml
export SCF_GATEWAY_URL=https://127.0.0.1:56540
export SCF_OTLP_URL=https://127.0.0.1:56540
export SCF_GATEWAY_METRICS_URL=http://127.0.0.1:56541
export SCF_CONTROL_PLANE_URL=http://127.0.0.1:56542
export SCF_PORTAL_URL=http://localhost:56543
export SCF_INGEST_PORT=56540 SCF_GATEWAY_METRICS_PORT=56541 SCF_CONTROL_PLANE_PORT=56542 SCF_PORTAL_PORT=56543
ENV
