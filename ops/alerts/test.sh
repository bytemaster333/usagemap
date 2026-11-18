#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Checks and unit-tests the alert and recording rules with promtool from the pinned Prometheus image (the same image
# the monitoring overlay runs). Usage: ops/alerts/test.sh [test-file …]
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=prom/prometheus:v3.16.0@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06
run() { local wd=$1; shift; docker run --rm --network none --user 65534 -v "$PWD:/alerts:ro" -w "$wd" --entrypoint promtool "$IMAGE" "$@"; }
run /alerts check rules *.rules.yaml
if [ $# -eq 0 ]; then cd tests && set -- *.test.yaml && cd ..; fi
run /alerts/tests test rules "$@"
