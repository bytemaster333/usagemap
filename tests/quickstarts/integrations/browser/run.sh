#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Browser integration examples: builds the tracker, installs examples/ from its frozen lockfile, builds each app with
# Vite and drives it in Chromium against the protocol-v1 mock gateway and local stand-ins (wallet extension, Stellar
# RPC, WebAuthn authenticator, Telegram WebApp, app-events edge). No Docker, nothing leaves the machine.
# QS_BROWSER_INTEGRATIONS=freighter,passkey limits the run; extra arguments go to `playwright test`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
cd "$ROOT/tests"
exec pnpm exec playwright test -c quickstarts/integrations/browser/playwright.config.ts "$@"
