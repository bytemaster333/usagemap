#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Builds the UsageMap Scaffold Stellar template locally: the official React template (stellar-scaffold/ui) at the
# pinned commit plus UsageMap's overlay. Needs git and network access to github.com. Nothing is installed or run.
#   ./assemble.sh <empty output dir> [tracker.tgz]
# Until @usagemap/tracker is on npm, pass a tracker tarball (`npm pack` in tracker/ after a build for your
# ingest hosts), or `npm install` in the result fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${1:?usage: assemble.sh <empty output dir> [tracker.tgz]}"
commit=2a5c5f8ae5ce7fa7931387e97158362caf597b30 # templates/scaffold-stellar/UPSTREAM.json
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone -q https://github.com/stellar-scaffold/ui "$tmp/ui"
git -C "$tmp/ui" checkout -q "$commit"
node "$root/templates/scaffold-stellar/assemble.mjs" --upstream "$tmp/ui" --out "$out" \
  ${2:+--tracker-tarball "$2"}
echo "assembled into $out: set PUBLIC_USAGEMAP_SITE in app/.env (see usagemap.env.example), then npm install && npm start"
