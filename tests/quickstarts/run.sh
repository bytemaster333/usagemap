#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The quickstart fixtures end to end (docs.quickstarts-run; `make quickstarts`): starts the scf-tgq
# stack (stack/up.sh), runs the suite with the environment it prints, and always removes the stack (stack/down.sh).
# Set SCF_REQUIRE_FULL_STACK=1 to make a missing dependency fail instead of being reported as not run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
trap '"$HERE/stack/down.sh" >/dev/null 2>&1' EXIT
out="$("$HERE/stack/up.sh")" || { echo "$out"; exit 1; }
echo "$out" | grep -v '^export '
eval "$(echo "$out" | grep '^export ')"
cd "$ROOT" && pnpm --filter tests run quickstarts
