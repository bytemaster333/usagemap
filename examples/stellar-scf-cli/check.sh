#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# What UsageMap would keep, redact and drop from one OTLP/JSON export of your service, offline, with the production
# sanitise step. Exit 3 when anything would be dropped: use it as a CI gate.
#   ./check.sh [payload.json]          (STELLAR_SCF=<path> to use a binary that is not on PATH)
set -euo pipefail
scf="${STELLAR_SCF:-stellar-scf}" # the same binary is `stellar scf` when the Stellar CLI is installed
"$scf" check -f "${1:-payload.json}" --services my-api --fail-on-drop
