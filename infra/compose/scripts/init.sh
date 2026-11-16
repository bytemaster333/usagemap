#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Prepare the local stack: development secrets and PKI (both idempotent), and the tracker build the control plane
# serves (tracker/dist/<semver>/manifest.json, mounted read-only; C-100). `make up` and smoke.sh run this first.
# Local-stack platform settings (edge_counter_features = ["props","dev"], C-137) live in ../postgres/dev-settings.sql:
# this script runs before the database exists, so Compose applies that file after the migrations on every start
# (one-shot service dev-settings); the on-chain fixture mirror is generated the same way by the one-shot
# onchain-fixture of compose.dev.yaml (development and tests only; no deployment loads that file).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

# Docker preflight: the images need Docker's own Engine with BuildKit and the Compose plugin. Distribution packages
# lag behind (clean-clone rebuild drill 2026-11-18: Debian 13's docker.io 26.1 cannot build the Umami image; Docker
# 29.9.3 from download.docker.com — the version the lean profile pins — works). Minimum = the tested major.
min=${SCF_DOCKER_MIN:-29.0}
ver=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || { echo "init: cannot reach the Docker daemon" >&2; exit 1; }
if [[ $(printf '%s\n%s\n' "$min" "${ver%%[-+~]*}" | sort -V | head -n1) != "$min" ]]; then
  echo "init: Docker Engine $ver is older than $min: install Docker's own packages (https://docs.docker.com/engine/install/)" >&2
  echo "      — distribution packages such as Debian's docker.io 26.1 cannot build these images" >&2
  exit 1
fi
docker compose version >/dev/null 2>&1 || { echo "init: the Docker Compose plugin (docker compose) is missing" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "init: the Docker buildx plugin is missing" >&2; exit 1; }

"$HERE/dev-secrets.sh"
"$HERE/dev-pki.sh"
[[ -s "$HERE/../postgres/dev-settings.sql" ]] || { echo "init: infra/compose/postgres/dev-settings.sql is missing" >&2; exit 1; }

# Every release listed in tracker-releases.json must have its manifest, or the snippet has no SRI value.
missing=0
for v in $(grep -o '"version": *"[0-9.]*"' "$HERE/../tracker-releases.json" | grep -o '[0-9][0-9.]*'); do
  [[ -s "$ROOT/tracker/dist/$v/manifest.json" ]] || missing=1
done
if [[ $missing == 1 ]]; then
  command -v pnpm >/dev/null || { echo "init: tracker/dist is missing and pnpm is not available (run: mise install)" >&2; exit 1; }
  echo "init: building the tracker (tracker/dist)"
  # umask 022: tracker/dist is public and bind-mounted read-only into the control plane and gateway, which run as
  # other uids. A caller's restrictive umask (ha-init.sh sets 077 for its secrets) once left 0700 directories that the
  # control plane could not read ("tracker release 1.0.0 has no manifest" in the handover drill's clone).
  (cd "$ROOT" && umask 022 && pnpm --filter @usagemap/tracker build >/dev/null)
fi
