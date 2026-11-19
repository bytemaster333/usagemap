#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Integration examples (examples/<integration>, not the browser ones) against local stand-ins of UsageMap and of the
# third-party service each one calls. Node examples run on the host; Deno, Bun, Python and Dart in pinned images
# (Docker). QS_INTEGRATIONS=edge-deno,payments-mpp limits the run; QS_INTEGRATIONS_ALLOW_SKIP=1 turns a missing
# toolchain into a skip. Extra arguments go to vitest. The browser examples: browser/run.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# the examples link the repository's packages: build the ones they use
for p in stellar-otel edge-otel anchor-otel partner-otel payments-otel mobile-rn; do
  pnpm --dir "$ROOT" --filter "@usagemap/$p" run --silent build
done
(cd "$ROOT/examples" && pnpm install --frozen-lockfile --reporter=append-only)
cd "$ROOT/tests"
exec pnpm exec vitest run -c quickstarts/integrations/vitest.config.ts "$@"
