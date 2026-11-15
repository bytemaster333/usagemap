#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Integration test of the engine proxy against a real Umami 3.5.0 (our image by default).
#   services/engine-proxy/integration/run.sh            (KEEP=1 leaves the stack up)
#   UMAMI_IMAGE=ghcr.io/umami-software/umami:3.5.0 UMAMI_MIGRATE_IMAGE=... run.sh
# Needs: docker compose, Go (mise). Uses Compose project scf-wsi-it and host port 127.0.0.1:${IT_UMAMI_PORT:-56123}.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IT_PG_PASSWORD="$(openssl rand -hex 16)"
IT_APP_SECRET="$(openssl rand -hex 32)"
export IT_PG_PASSWORD IT_APP_SECRET IT_UMAMI_PORT="${IT_UMAMI_PORT:-56123}"
dc() { docker compose -p scf-wsi-it -f "$HERE/compose.yaml" "$@"; }
cleanup() { [[ "${KEEP:-0}" == 1 ]] || dc down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --wait --wait-timeout 180 umami
command -v go >/dev/null || eval "$(cd "$ROOT" && mise env -s bash)"
cd "$HERE/.."
EP_IT_UMAMI_URL="http://127.0.0.1:$IT_UMAMI_PORT" go test -tags integration -count=1 -v ./integration/ "$@"
