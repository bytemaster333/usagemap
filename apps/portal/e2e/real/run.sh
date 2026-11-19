#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Portal end to end against the real stack: builds and starts PostgreSQL → … → control plane → portal (Compose
# project scf-wsh, ports 56220/56221), runs e2e/real with Playwright, then removes the project (`KEEP=1` keeps it).
# PORTAL_REAL_PROJECT names another project (the ports stay), e.g. beside another stack on the same host.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/../../../.." && pwd)"
project="${PORTAL_REAL_PROJECT:-scf-wsh}"
export SCF_WSH_POSTGRES_CONTAINER="${SCF_WSH_POSTGRES_CONTAINER:-${project}-postgres-1}" # the specs grant operator roles through psql in it
compose=(docker compose -p "${project}" --profile web -f "${root}/infra/compose/compose.yaml" -f "${root}/infra/compose/compose.dev.yaml" -f "${here}/compose.override.yaml")
cleanup() { if [ "${KEEP:-0}" != "1" ]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
"${root}/infra/compose/scripts/init.sh" >/dev/null
(cd "${root}" && pnpm --filter @usagemap/tracker build >/dev/null)
"${compose[@]}" up -d --build --wait --wait-timeout 600 control-plane portal
cd "${here}/../.."
SCF_PORTAL_REAL_URL=http://localhost:56220 node_modules/.bin/playwright test -c playwright.real.config.ts
