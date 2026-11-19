#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# api.dual-export, api.drop-traces backend examples: runs every examples/api-* service in its UsageMap-only and dual-export mode against a
# local OTLP receiver (no UsageMap stack). Node and Go run on the host; Python, Java, Rust and the Anchor Platform in pinned
# images on the host network. QS_BACKENDS=node-express,go-nethttp limits the run; caches go to $QS_BACKENDS_CACHE
# (default: the system temp directory). Extra arguments go to vitest.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
if [ ! -d "$ROOT/examples/api-node-express/node_modules" ]; then
  (cd "$ROOT/examples" && pnpm install --frozen-lockfile)
fi
cd "$ROOT/tests"
exec pnpm exec vitest run -c quickstarts/backends/vitest.config.ts "$@"
