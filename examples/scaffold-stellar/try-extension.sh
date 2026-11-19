#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Calls the post-deploy extension exactly as Scaffold does after `stellar scaffold build`/deploy: `manifest`, then
# `post-deploy` with the deployment as JSON on stdin (deploy.json, a testnet deploy of guess_the_number). Without
# USAGEMAP_REGISTER=1 (or `register: true`) plus SCF_FOOTPRINT_KEY and USAGEMAP_TENANT_ID it is a dry run.
#   ./try-extension.sh [project dir]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ext="$here/../../templates/scaffold-stellar/extension/bin/stellar-scaffold-usagemap"
project="${1:-$(mktemp -d)}"
node "$ext" manifest
sed "s#__PROJECT_ROOT__#$project#" "$here/deploy.json" | node "$ext" post-deploy
cat "$project/.usagemap/contracts.json"
