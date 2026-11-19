#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# scripts/test.sh in the pinned Python 3.13 image (the version the README states as tested; the same image as
# infra/ansible/tools/Dockerfile). The repository is mounted read-only (the suite reads the JavaScript
# package's closed sets and the Collector fixture); the virtualenv lives in the container's /tmp, so nothing is written
# to the checkout. Needs network for pip (exact pins of requirements-test.txt). PYTHON_IMAGE overrides the image.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
image="${PYTHON_IMAGE:-python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90}"
exec docker run --rm --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e VENV=/tmp/venv -e PYTHON=python3 -e PYTHONDONTWRITEBYTECODE=1 -e PIP_NO_CACHE_DIR=1 \
  -v "$repo:/repo:ro" -w /repo/packages/stellar-otel-py \
  "$image" scripts/test.sh "$@"
