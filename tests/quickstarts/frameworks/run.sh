#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# tracker.ssr-frameworks framework quickstarts: installs the example apps (examples/, own frozen lockfile), builds each in production
# mode, serves it with its own production server and drives it in Chromium against the protocol-v1 mock gateway.
# No Docker, no stack. QS_FRAMEWORKS=nextjs,nuxt limits the run; extra arguments go to `playwright test`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT/tests"
exec pnpm exec playwright test -c quickstarts/frameworks/playwright.config.ts "$@"
